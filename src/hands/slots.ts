import { DUPLICATE_HAND_PX } from './constants';
import type { HandSample } from './types';

/**
 * Keeps the first of two samples whose palm centres are closer than `minPx`.
 * MediaPipe sometimes reports one hand twice when more than one hand is allowed.
 */
export function dedupeHands(samples: readonly HandSample[], minPx = DUPLICATE_HAND_PX): HandSample[] {
  const kept: HandSample[] = [];
  for (const sample of samples) {
    const duplicate = kept.some(other => Math.hypot(other.palm.x - sample.palm.x, other.palm.y - sample.palm.y) < minPx);
    if (!duplicate) kept.push(sample);
  }
  return kept;
}