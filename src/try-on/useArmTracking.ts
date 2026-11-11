import { useEffect, useRef, useState, type RefObject } from 'react';
import { ARM_HOLD_MS, ArmTracker, type ArmSample, type ArmWorkerFrame, type ArmWorkerResult, type TrackingDelegate } from './arm-pose';

export type ArmTrackingStatus = 'off' | 'loading' | 'searching' | 'tracking' | 'load-error' | 'track-error';

/** Live tracking speed, refreshed about once a second. */
export interface ArmTrackingStats {
  delegate: TrackingDelegate; fps: number; inferenceMs: number;
  /** Frames per second in which the model found a hand, and in which a cuff pose could be placed. */
  handFps: number; armFps: number;
  /** How the latest placed cuff got its forearm direction. */
  source: 'elbow' | 'hand' | null;
}

/** One frame is in flight at a time, so this only caps the rate on fast machines. */
const FRAME_INTERVAL_MS = 30;
const MAX_FRAME_EDGE = 640;

/**
 * `mirrored` must match how the video is displayed. Frames are flipped before
 * tracking so landmarks, and the cuff drawn from them, are in display space.
 */
export function useArmTracking(videoRef: RefObject<HTMLVideoElement | null>, enabled: boolean, mirrored = false) {
  const sample = useRef<ArmSample | null>(null);
  const mirror = useRef(mirrored);
  mirror.current = mirrored;
  const [status, setStatus] = useState<ArmTrackingStatus>('off');
  const [stats, setStats] = useState<ArmTrackingStats | null>(null);

  useEffect(() => {
    const source = videoRef.current;
    sample.current = null;
    setStats(null);
    if (!source || !enabled) {
      setStatus('off');
      return;
    }
    const video = source;
    const buffer = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1);
    const context = buffer?.getContext('2d', { alpha: false });
    if (!buffer || !context) {
      setStatus('load-error');
      return;
    }
    const frameBuffer = buffer;
    const drawing = context;

    let worker: Worker;
    setStatus('loading');
    try {
      worker = new Worker(new URL('./arm.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      setStatus('load-error');
      return;
    }

    let currentStatus: ArmTrackingStatus = 'loading';
    let stopped = false;
    let pending = false;
    let frameHandle = 0;
    let lastFrameAt = -Infinity;
    let lastVideoTime = -1;
    let lastValid: ArmSample | null = null;
    const tracker = new ArmTracker();
    let lastCaptureAt = 0;
    let delegate: TrackingDelegate = 'CPU';
    let window_ = { start: performance.now(), frames: 0, inference: 0, hands: 0, arms: 0 };
    let lastSource: ArmTrackingStats['source'] = null;
    const usesVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    const loadTimeout = window.setTimeout(() => fail('load-error'), 75_000);

    function setTrackingStatus(next: ArmTrackingStatus) {
      if (next !== currentStatus) {
        currentStatus = next;
        setStatus(next);
      }
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(loadTimeout);
      if (usesVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
      else cancelAnimationFrame(frameHandle);
      worker.terminate();
      sample.current = null;
    }

    function fail(next: 'load-error' | 'track-error') {
      if (stopped) return;
      stop();
      setTrackingStatus(next);
    }

    function scheduleFrame() {
      frameHandle = usesVideoFrameCallback ? video.requestVideoFrameCallback(captureFrame) : requestAnimationFrame(captureFrame);
    }

    function captureFrame(now: number) {
      if (stopped) return;
      scheduleFrame();
      if (sample.current && now > sample.current.validUntil) setTrackingStatus('searching');
      if (pending && now - lastFrameAt > 10_000) {
        console.error('Arm tracking worker did not return the frame');
        fail('track-error');
        return;
      }
      if (pending || now - lastFrameAt < FRAME_INTERVAL_MS || video.readyState < 2 || video.currentTime === lastVideoTime) return;
      const { videoWidth: width, videoHeight: height } = video;
      if (!width || !height) return;

      pending = true;
      lastFrameAt = now;
      lastVideoTime = video.currentTime;
      lastCaptureAt = performance.now();
      const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(width, height));
      const frameWidth = Math.max(1, Math.round(width * scale));
      const frameHeight = Math.max(1, Math.round(height * scale));
      let bitmap: ImageBitmap | undefined;
      try {
        if (frameBuffer.width !== frameWidth || frameBuffer.height !== frameHeight) {
          frameBuffer.width = frameWidth;
          frameBuffer.height = frameHeight;
        }
        // Copy the live video before transferring it. This also works with
        // canvas-backed MediaStreams for deterministic browser tests.
        drawing.setTransform(mirror.current ? -1 : 1, 0, 0, 1, mirror.current ? frameWidth : 0, 0);
        drawing.drawImage(video, 0, 0, frameWidth, frameHeight);
        bitmap = frameBuffer.transferToImageBitmap();
        const message: ArmWorkerFrame = { bitmap, width, height, timestamp: now };
        worker.postMessage(message, [bitmap]);
      } catch (error) {
        bitmap?.close();
        console.error('Could not capture an arm tracking frame', error);
        fail('track-error');
      }
    }

    worker.onmessage = (event: MessageEvent<ArmWorkerResult>) => {
      if (stopped) return;
      const message = event.data;
      if (message.type === 'error') { fail(message.stage === 'load' ? 'load-error' : 'track-error'); return; }
      if (message.type === 'ready') {
        clearTimeout(loadTimeout);
        delegate = message.delegate;
        setTrackingStatus('searching');
        scheduleFrame();
        return;
      }
      pending = false;
      const now = performance.now();
      const arm = tracker.update(message, lastCaptureAt);
      window_.frames++;
      window_.inference += message.inferenceMs;
      if (message.hands.length) window_.hands++;
      if (arm) { window_.arms++; lastSource = arm.source; }
      if (now - window_.start >= 1000) {
        const perSecond = 1000 / (now - window_.start);
        setStats({ delegate, fps: window_.frames * perSecond, inferenceMs: window_.inference / window_.frames,
          handFps: window_.hands * perSecond, armFps: window_.arms * perSecond, source: lastSource });
        window_ = { start: now, frames: 0, inference: 0, hands: 0, arms: 0 };
      }
      if (arm) {
        // Slow machines can legitimately take longer than the tracking-loss
        // grace period to return the next frame. Keep a bounded stale deadline
        // based on inference time, and fade sooner on an explicit miss.
        const validFor = Math.min(3500, Math.max(ARM_HOLD_MS, (now - lastFrameAt) * 2 + 100));
        lastValid = { ...arm, seenAt: now, capturedAt: lastCaptureAt, validUntil: now + validFor };
        sample.current = lastValid;
        setTrackingStatus('tracking');
      } else {
        sample.current = null;
        setTrackingStatus('searching');
      }
    };
    worker.onerror = event => {
      console.error('Arm tracking worker failed', event.message);
      fail(currentStatus === 'loading' ? 'load-error' : 'track-error');
    };
    worker.onmessageerror = () => fail('track-error');
    return stop;
  }, [enabled, videoRef]);

  return { sample, status, stats };
}
