import { useEffect, useRef, useState } from 'react';
import type { HandSource, TrackerStatus } from '../hands/useHandTracking';
import { ARM_HOLD_MS, ArmTracker, type ArmSample, type TrackingDelegate } from './arm-pose';

export type ArmTrackingStatus = 'off' | 'loading' | 'searching' | 'tracking' | 'load-error' | 'track-error';

/** Live tracking speed, refreshed about once a second. */
export interface ArmTrackingStats {
  delegate: TrackingDelegate; fps: number; inferenceMs: number;
  /** Frames per second in which the model found a hand, and in which a cuff pose could be placed. */
  handFps: number; armFps: number;
  /** How the latest placed cuff got its forearm direction. */
  source: 'elbow' | 'hand' | null;
}

/**
 * Try-on as a consumer of the shared hand tracking: each frame places the cuff,
 * and a sample that outlives its `validUntil` falls back to `searching`.
 */
export function useArmTracking(source: HandSource, tracker: TrackerStatus, enabled: boolean) {
  const sample = useRef<ArmSample | null>(null);
  const [tracked, setTracked] = useState(false);
  const [stats, setStats] = useState<ArmTrackingStats | null>(null);

  useEffect(() => {
    sample.current = null;
    setStats(null);
    setTracked(false);
    if (!enabled) return;
    const arm = new ArmTracker();
    let window_ = { start: performance.now(), frames: 0, inference: 0, hands: 0, arms: 0 };
    let lastSource: ArmTrackingStats['source'] = null;
    let tracking = false;
    const setTracking = (next: boolean) => {
      if (next !== tracking) { tracking = next; setTracked(next); }
    };
    const unsubscribeFrames = source.subscribe(frame => {
      const now = performance.now();
      const placed = arm.update(frame, frame.capturedAt);
      window_.frames++;
      window_.inference += frame.inferenceMs;
      if (frame.hands.length) window_.hands++;
      if (placed) { window_.arms++; lastSource = placed.source; }
      if (now - window_.start >= 1000) {
        const perSecond = 1000 / (now - window_.start);
        setStats({ delegate: source.delegate() ?? 'CPU', fps: window_.frames * perSecond, inferenceMs: window_.inference / window_.frames,
          handFps: window_.hands * perSecond, armFps: window_.arms * perSecond, source: lastSource });
        window_ = { start: now, frames: 0, inference: 0, hands: 0, arms: 0 };
      }
      if (placed) {
        // Slow machines can legitimately take longer than the tracking-loss
        // grace period to return the next frame. Keep a bounded stale deadline
        // based on inference time, and fade sooner on an explicit miss.
        const validFor = Math.min(3500, Math.max(ARM_HOLD_MS, (frame.receivedAt - frame.requestedAt) * 2 + 100));
        sample.current = { ...placed, seenAt: frame.receivedAt, capturedAt: frame.capturedAt, validUntil: frame.receivedAt + validFor };
        setTracking(true);
      } else {
        sample.current = null;
        setTracking(false);
      }
    });
    const unsubscribeTicks = source.onTick(now => {
      if (sample.current && now > sample.current.validUntil) setTracking(false);
    });
    return () => {
      unsubscribeFrames();
      unsubscribeTicks();
      sample.current = null;
    };
  }, [source, enabled]);

  let status: ArmTrackingStatus;
  if (!enabled || tracker === 'off') status = 'off';
  else if (tracker === 'loading') status = 'loading';
  else if (tracker === 'load-error' || tracker === 'track-error') status = tracker;
  else status = tracked ? 'tracking' : 'searching';
  return { sample, status, stats };
}