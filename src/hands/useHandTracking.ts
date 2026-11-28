import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ArmWorkerFrame, ArmWorkerResult, LandmarkFrame, SegmentCrop, SegmenterState, SegmentMask, TrackingDelegate } from '../try-on/arm-pose';
import { frameClockStep, RateWindow, trackingPlan, VIDEO_FRAME_STALL_MS, type FrameClock } from './tracking-plan';

export type TrackerStatus = 'off' | 'loading' | 'ready' | 'load-error' | 'track-error';

export interface TrackedFrame extends LandmarkFrame {
  /** The video-frame callback time the frame was requested at. */
  requestedAt: number;
  /** performance.now() when the frame was copied from the video. */
  capturedAt: number;
  receivedAt: number;
  inferenceMs: number;
  /** Pose was requested for this frame. */
  pose: boolean;
  /** Body fit: the wrist mask, present only when the frame asked for `segment` and the segmenter was ready. */
  mask?: SegmentMask;
  /** Body fit: mean luma (0..1) of the requested crop. */
  luma?: number;
}

export interface HandSource {
  latest(): TrackedFrame | null;
  /** Listeners run synchronously when the worker answers a frame. */
  subscribe(listener: (frame: TrackedFrame) => void): () => void;
  /** Called on every video frame while the worker is ready, with or without a result; drives time-outs. */
  onTick(listener: (now: number) => void): () => void;
  /** Frames returned per second over the last full second; updated once a second without a React render. */
  rate(): number | null;
  delegate(): TrackingDelegate | null;
}

/** One frame is in flight at a time, so this only caps the rate on fast machines. */
const FRAME_INTERVAL_MS = 30;
const MAX_FRAME_EDGE = 640;
const LOAD_TIMEOUT_MS = 75_000;
const FRAME_WATCHDOG_MS = 10_000;

/** The mutable store behind a HandSource. Nothing in it triggers a React render. */
function createSourceStore() {
  const frameListeners = new Set<(frame: TrackedFrame) => void>();
  const tickListeners = new Set<(now: number) => void>();
  let latest: TrackedFrame | null = null;
  let rate: number | null = null;
  let delegate: TrackingDelegate | null = null;
  const source: HandSource = {
    latest: () => latest,
    subscribe(listener) { frameListeners.add(listener); return () => { frameListeners.delete(listener); }; },
    onTick(listener) { tickListeners.add(listener); return () => { tickListeners.delete(listener); }; },
    rate: () => rate,
    delegate: () => delegate,
  };
  return {
    source,
    publish(frame: TrackedFrame) {
      latest = frame;
      for (const listener of [...frameListeners]) listener(frame);
    },
    tick(now: number) { for (const listener of [...tickListeners]) listener(now); },
    setRate(value: number | null) { rate = value; },
    setDelegate(value: TrackingDelegate | null) { delegate = value; },
    clear() { latest = null; rate = null; delegate = null; },
  };
}

/**
 * One tracking worker per camera session. `needed` decides whether frames are
 * sent; the worker itself stays alive while the camera is on, so turning hand
 * control off and on again never reloads the models.
 * `mirrored` must match how the video is displayed. Frames are flipped before
 * tracking so landmarks are in display space.
 */
export function useHandTracking(videoRef: RefObject<HTMLVideoElement | null>, options: {
  running: boolean;
  needed: boolean;
  wantPose: boolean;
  mirrored: boolean;
  onRate?: (fps: number, now: number) => void;
  /** Body fit: a ref read on every captured frame. A crop in it asks the worker to segment that crop of the frame; null or absent asks for nothing. */
  segment?: RefObject<SegmentCrop | null>;
  /** Body fit: called when the worker reports that its segmenter is loading, ready or could not load. Never called without a `segment` request. */
  onSegmenter?: (state: SegmenterState) => void;
}): { source: HandSource; status: TrackerStatus } {
  const { running, needed, wantPose, mirrored } = options;
  const store = useMemo(createSourceStore, []);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<TrackerStatus>('off');
  const plan = trackingPlan({ running, needed, started });
  if (plan.worker === 'start') setStarted(true);
  else if (plan.worker === 'stop') setStarted(false);

  const sendFrames = useRef(plan.sendFrames);
  const pose = useRef(wantPose);
  const mirror = useRef(mirrored);
  const onRate = useRef(options.onRate);
  const segment = useRef(options.segment);
  const onSegmenter = useRef(options.onSegmenter);
  sendFrames.current = plan.sendFrames;
  pose.current = wantPose;
  mirror.current = mirrored;
  onRate.current = options.onRate;
  segment.current = options.segment;
  onSegmenter.current = options.onSegmenter;

  useEffect(() => {
    const video = videoRef.current;
    if (!started) { setStatus('off'); return; }
    if (!video) { setStatus('load-error'); return; }
    const buffer = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1);
    const context = buffer?.getContext('2d', { alpha: false });
    if (!buffer || !context) { setStatus('load-error'); return; }
    const frameBuffer = buffer;
    const drawing = context;
    let worker: Worker;
    setStatus('loading');
    try {
      worker = new Worker(new URL('../try-on/arm.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      setStatus('load-error');
      return;
    }
    let currentStatus: TrackerStatus = 'loading';
    let stopped = false;
    let pending = false;
    let frameHandle = 0;
    let lastFrameAt = -Infinity;
    let lastVideoTime = -1;
    let lastCaptureAt = 0;
    let lastPose = false;
    const rateWindow = new RateWindow();
    // Video-frame callbacks while the browser keeps calling them; animation frames after a stall (hidden camera image) or without support.
    let clock: FrameClock = typeof video.requestVideoFrameCallback === 'function' ? 'video-frame' : 'animation-frame';
    let lastCallbackAt: number | null = null;
    let stallTimer = 0;
    const loadTimeout = window.setTimeout(() => fail('load-error'), LOAD_TIMEOUT_MS);

    function setTrackerStatus(next: TrackerStatus) {
      if (next !== currentStatus) {
        currentStatus = next;
        setStatus(next);
      }
    }
    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(loadTimeout);
      clearInterval(stallTimer);
      cancelFrame();
      worker.terminate();
      store.clear();
    }
    function fail(next: 'load-error' | 'track-error') {
      if (stopped) return;
      stop();
      setTrackerStatus(next);
    }
    function cancelFrame() {
      if (clock === 'video-frame') video!.cancelVideoFrameCallback(frameHandle);
      else cancelAnimationFrame(frameHandle);
    }
    function scheduleFrame() {
      frameHandle = clock === 'video-frame' ? video!.requestVideoFrameCallback(captureFrame) : requestAnimationFrame(captureFrame);
    }
    /** Moves the loop to animation frames when the browser stops calling video-frame callbacks. */
    function checkClock() {
      if (stopped) return;
      const next = frameClockStep({ clock, lastCallbackAt, now: performance.now(), playing: !video!.paused && video!.readyState >= 2 });
      if (next === clock) return;
      cancelFrame();
      clock = next;
      scheduleFrame();
    }
    function captureFrame(now: number) {
      if (stopped) return;
      if (clock === 'video-frame') lastCallbackAt = now;
      scheduleFrame();
      store.tick(now);
      if (pending && now - lastFrameAt > FRAME_WATCHDOG_MS) {
        console.error('Hand tracking worker did not return the frame');
        fail('track-error');
        return;
      }
      // While nothing needs frames the rate is not measured; a window that spans the pause would report a false low rate.
      if (!sendFrames.current && !pending) rateWindow.reset();
      if (!sendFrames.current || pending || now - lastFrameAt < FRAME_INTERVAL_MS || video!.readyState < 2 || video!.currentTime === lastVideoTime) return;
      const { videoWidth: width, videoHeight: height } = video!;
      if (!width || !height) return;
      pending = true;
      lastFrameAt = now;
      lastVideoTime = video!.currentTime;
      lastCaptureAt = performance.now();
      lastPose = pose.current;
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
        drawing.drawImage(video!, 0, 0, frameWidth, frameHeight);
        bitmap = frameBuffer.transferToImageBitmap();
        const crop = segment.current?.current;
        const message: ArmWorkerFrame = { bitmap, width, height, timestamp: now, pose: lastPose, ...(crop ? { segment: crop } : {}) };
        worker.postMessage(message, [bitmap]);
      } catch (error) {
        bitmap?.close();
        console.error('Could not capture a hand tracking frame', error);
        fail('track-error');
      }
    }

    worker.onmessage = (event: MessageEvent<ArmWorkerResult>) => {
      if (stopped) return;
      const message = event.data;
      if (message.type === 'error') { fail(message.stage === 'load' ? 'load-error' : 'track-error'); return; }
      // Not an answer to a frame: the pending frame stays pending.
      if (message.type === 'segmenter') { onSegmenter.current?.(message.state); return; }
      if (message.type === 'ready') {
        clearTimeout(loadTimeout);
        store.setDelegate(message.delegate);
        setTrackerStatus('ready');
        lastCallbackAt = performance.now();
        scheduleFrame();
        stallTimer = window.setInterval(checkClock, VIDEO_FRAME_STALL_MS);
        return;
      }
      pending = false;
      const now = performance.now();
      const fps = rateWindow.add(now);
      if (fps !== null) { store.setRate(fps); onRate.current?.(fps, now); }
      store.publish({
        width: message.width, height: message.height, hands: message.hands, body: message.body,
        requestedAt: lastFrameAt, capturedAt: lastCaptureAt, receivedAt: now, inferenceMs: message.inferenceMs, pose: lastPose,
        ...(message.mask ? { mask: message.mask } : {}), ...(message.luma === undefined ? {} : { luma: message.luma }),
      });
    };
    worker.onerror = event => {
      console.error('Hand tracking worker failed', event.message);
      fail(currentStatus === 'loading' ? 'load-error' : 'track-error');
    };
    worker.onmessageerror = () => fail('track-error');
    return () => { stop(); setStatus('off'); };
  }, [started, videoRef, store]);

  return { source: store.source, status };
}
