import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { HAND_LOST_MS } from './constants';
import type { Gate } from './gate';
import type { HandOverlayHandle } from './HandOverlay';
import { handSample } from './mapping';
import { dedupeHands } from './slots';
import { handStatus, type HandStatusState } from './text';
import type { HandSlot, HandSample, HandView, OverlayFrame } from './types';
import type { HandSource, TrackerStatus } from './useHandTracking';

/** The tracking numbers the `?hands=debug` panel reads without a React render. */
export interface HandDebugNumbers {
  /** Hands in the latest frame, after removing duplicates. */
  hands: number;
  /** Thumb-index distance in millimetres per hand, null without world landmarks. */
  pinchMm: (number | null)[];
}

/**
 * Turns tracking frames into the hand overlay. Part 1 (Task 3): every hand of the
 * frame is drawn as `tracked`, or `locked` while the gate is not `full`; no
 * gesture acts yet. Everything runs inside the tracking callbacks, so a frame
 * causes no React render; React state holds only the status line.
 */
export function useHandControl(input: {
  source: HandSource;
  tracker: TrackerStatus;
  /** The camera is on and 手勢 is on. */
  enabled: boolean;
  gate: Gate;
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HandOverlayHandle | null>;
}): { status: { state: HandStatusState; text: string }; debug: RefObject<HandDebugNumbers> } {
  const { source, tracker, enabled, gate, videoRef, overlayRef } = input;
  const [handSeen, setHandSeen] = useState(false);
  const debug = useRef<HandDebugNumbers>({ hands: 0, pinchMm: [] });
  const level = useRef(gate.level);
  level.current = gate.level;

  useEffect(() => {
    if (!enabled) return;
    let handSeenAt: number | null = null;
    let seen = false;
    const unsubscribeFrames = source.subscribe(frame => {
      const video = videoRef.current;
      if (!video) return;
      const rect = video.getBoundingClientRect();
      const size = { width: frame.width, height: frame.height };
      const samples: HandSample[] = [];
      for (const hand of frame.hands) {
        const sample = handSample(hand, rect, size);
        if (sample) samples.push(sample);
      }
      const hands = dedupeHands(samples);
      debug.current = { hands: hands.length, pinchMm: hands.map(sample => (sample.pinchM === null ? null : sample.pinchM * 1000)) };
      // With no hand in the frame the skeletons stay until HAND_LOST_MS has passed (see the tick below).
      if (hands.length === 0) return;
      handSeenAt = frame.receivedAt;
      if (!seen) { seen = true; setHandSeen(true); }
      const state = level.current === 'full' ? 'tracked' : 'locked';
      const views: HandView[] = hands.map((sample, index) => ({
        slot: index as HandSlot, state, targetKey: '', points: sample.points, cursor: sample.cursor, palm: sample.palm, badge: null,
      }));
      const overlay: OverlayFrame = { hands: views, gesture: 'none', link: null, arc: null };
      overlayRef.current?.draw(overlay);
    });
    const unsubscribeTicks = source.onTick(now => {
      if (handSeenAt === null || now - handSeenAt < HAND_LOST_MS) return;
      handSeenAt = null;
      debug.current = { hands: 0, pinchMm: [] };
      overlayRef.current?.clear();
    });
    return () => {
      unsubscribeFrames();
      unsubscribeTicks();
      debug.current = { hands: 0, pinchMm: [] };
      overlayRef.current?.clear();
      setHandSeen(false);
    };
  }, [source, enabled, videoRef, overlayRef]);

  const status = useMemo(
    () => (enabled ? handStatus({ tracker, gate: { level: gate.level, reason: gate.reason }, cancelledAt: null, now: 0, handSeen }) : { state: 'hidden' as const, text: '' }),
    [enabled, tracker, gate.level, gate.reason, handSeen],
  );
  return { status, debug };
}