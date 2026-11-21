import type { Landmark } from '../try-on/arm-pose';
import {
  DRAG_DEAD_ZONE_PX, FIST_ENGAGE_FRAMES, FIST_ENGAGE_RATIO, FIST_RELEASE_FRAMES, FIST_RELEASE_RATIO, HAND_LOST_MS, TRACKING_LOSS_MS,
} from './constants';
import type { Point } from './types';

const WRIST = 0;
/** [knuckle, fingertip] of the index, middle, ring and little finger. */
const FINGERS: ReadonlyArray<readonly [number, number]> = [[5, 8], [9, 12], [13, 16], [17, 20]];

function finite(point: Landmark | undefined): point is Landmark {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
}

/**
 * How closed the hand is (requirement 89): for each of the index, middle, ring and little finger, the distance from the fingertip
 * to the wrist divided by the distance from that finger's knuckle to the wrist, on the metric world landmarks. The result is the
 * largest of the four, so one extended finger means "not a fist". About 1.8 for an open hand, 1.3 to 1.5 for a pinch with the other
 * fingers curled (the index stays the largest), below 1 for a closed fist. Null without 21 finite world landmarks or with a
 * degenerate knuckle distance.
 */
export function curlRatio(world: readonly Landmark[] | undefined): number | null {
  if (!world || world.length < 21) return null;
  const wrist = world[WRIST];
  if (!finite(wrist)) return null;
  let largest = 0;
  for (const [knuckleIndex, tipIndex] of FINGERS) {
    const knuckle = world[knuckleIndex];
    const tip = world[tipIndex];
    if (!finite(knuckle) || !finite(tip)) return null;
    const base = Math.hypot(knuckle.x - wrist.x, knuckle.y - wrist.y, knuckle.z - wrist.z);
    if (!(base > 1e-6)) return null;
    largest = Math.max(largest, Math.hypot(tip.x - wrist.x, tip.y - wrist.y, tip.z - wrist.z) / base);
  }
  return largest;
}

export interface FistState {
  engaged: boolean;
  /** Consecutive tracking frames beyond the threshold that would change `engaged`. */
  streak: number;
  /** When a hand was last seen; null before the first hand and after the hand was lost. */
  handSeenAt: number | null;
  /** The palm centre when the fist engaged. */
  engagePalm: Point | null;
  /** The palm has left the dead zone since the fist engaged. */
  moved: boolean;
}

export type FistEvent =
  | { type: 'fist-engage'; palm: Point }
  | { type: 'fist-move-start' }
  | { type: 'fist-release'; moved: boolean }
  /** The hand of an engaged fist was missing for longer than the time-out. */
  | { type: 'fist-lost' };

/** One tracking frame with a hand (palm centre, curl ratio, and whether the same hand's pinch has left its dead zone), one without, or just time. */
export type FistInput = { kind: 'hand'; palm: Point; curl: number | null; pinchMoved: boolean } | { kind: 'none' } | { kind: 'tick' };

export function initialFistState(): FistState {
  return { engaged: false, streak: 0, handSeenAt: null, engagePalm: null, moved: false };
}

/**
 * The fist state machine, in the pattern of `pinchStep`. Below FIST_ENGAGE_RATIO for FIST_ENGAGE_FRAMES consecutive tracking
 * frames engages, above FIST_RELEASE_RATIO for FIST_RELEASE_FRAMES releases, nothing changes in between, and a frame without a curl
 * ratio resets the streak and never engages. A hand whose pinch has left its dead zone cannot engage (requirement 90). Only
 * tracking frames count; `tick` only advances time. `palm` should be the filtered palm centre. A hand missing for the time-out
 * (`lossMs` when given, else TRACKING_LOSS_MS while engaged and HAND_LOST_MS otherwise) resets the state; `fist-lost` is
 * reported only when the fist was engaged.
 */
export function fistStep(state: FistState, input: FistInput, now: number, lossMs?: number): { state: FistState; events: FistEvent[] } {
  const events: FistEvent[] = [];
  let next: FistState = { ...state };
  if (next.handSeenAt !== null && now - next.handSeenAt >= (lossMs ?? (next.engaged ? TRACKING_LOSS_MS : HAND_LOST_MS))) {
    if (next.engaged) events.push({ type: 'fist-lost' });
    next = initialFistState();
  }
  if (input.kind === 'tick') return { state: next, events };
  if (input.kind === 'none') {
    next.streak = 0;
    return { state: next, events };
  }
  next.handSeenAt = now;
  const { palm, curl } = input;
  if (curl === null) {
    next.streak = 0;
  } else if (!next.engaged) {
    next.streak = curl < FIST_ENGAGE_RATIO && !input.pinchMoved ? next.streak + 1 : 0;
    if (next.streak >= FIST_ENGAGE_FRAMES) {
      next = { ...next, engaged: true, streak: 0, engagePalm: palm, moved: false };
      events.push({ type: 'fist-engage', palm });
    }
  } else {
    next.streak = curl > FIST_RELEASE_RATIO ? next.streak + 1 : 0;
    if (next.streak >= FIST_RELEASE_FRAMES) {
      events.push({ type: 'fist-release', moved: next.moved });
      next = { ...next, engaged: false, streak: 0, engagePalm: null, moved: false };
    }
  }
  // The frame that releases cannot also start a move: the fingers opening shifts the palm.
  if (next.engaged && !next.moved && next.engagePalm
    && Math.hypot(palm.x - next.engagePalm.x, palm.y - next.engagePalm.y) > DRAG_DEAD_ZONE_PX) {
    next.moved = true;
    events.push({ type: 'fist-move-start' });
  }
  return { state: next, events };
}
