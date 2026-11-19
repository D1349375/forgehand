import { useEffect, type RefObject } from 'react';
import { HAND_LOST_MS } from './constants';
import { handSample } from './mapping';
import { OneEuroFilter2D } from './one-euro';
import type { HandOverlayHandle } from './HandOverlay';
import type { HandSource } from './useHandTracking';

/**
 * Turns tracking frames into the hand overlay. Part 1: the skeleton is drawn
 * as `tracked`; no gesture acts yet. Everything runs inside the tracking
 * callbacks, so a frame causes no React render.
 */
export function useHandControl(input: {
  source: HandSource;
  /** The camera is on and 手勢 is on. */
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HandOverlayHandle | null>;
}): void {
  const { source, enabled, videoRef, overlayRef } = input;
  useEffect(() => {
    if (!enabled) return;
    const filter = new OneEuroFilter2D();
    let handSeenAt: number | null = null;

    const unsubscribeFrames = source.subscribe(frame => {
      const video = videoRef.current;
      const hand = frame.hands[0];
      if (!video || !hand) return;
      const rect = video.getBoundingClientRect();
      const sample = handSample(hand, rect, { width: frame.width, height: frame.height });
      if (!sample) return;
      // Nothing acts on the cursor yet; filtering keeps it settled for the gesture tasks.
      filter.filter(sample.cursor, frame.capturedAt);
      handSeenAt = frame.receivedAt;
      overlayRef.current?.draw({ state: 'tracked', mode: 'translate', targetKey: '', points: sample.points });
    });

    const unsubscribeTicks = source.onTick(now => {
      if (handSeenAt === null || now - handSeenAt < HAND_LOST_MS) return;
      handSeenAt = null;
      filter.reset();
      overlayRef.current?.clear();
    });

    return () => {
      unsubscribeFrames();
      unsubscribeTicks();
      overlayRef.current?.clear();
    };
  }, [source, enabled, videoRef, overlayRef]);
}
