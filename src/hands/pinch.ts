import {
  DRAG_DEAD_ZONE_PX, HAND_LOST_MS, MIN_GESTURE_FRAMES, PINCH_ENGAGE_M, PINCH_ENGAGE_MS, PINCH_RELEASE_M, PINCH_RELEASE_MS, TRACKING_LOSS_MS,
} from './constants';
import type { Point } from './types';

export interface PinchState {
  engaged: boolean;
  /** Consecutive tracking frames beyond the threshold that would change `engaged`. */
  streak: number;
  /** When the first frame of the current streak arrived; null while there is no streak. */
  streakSince: number | null;
  /** When a hand was last seen; null before the first hand and after `lost`. */
  handSeenAt: number | null;
  /** The latest tracking frame had no hand. */
  missing: boolean;
  /** The cursor when the pinch engaged. */
  engagePoint: Point | null;
  /** The cursor has left the dead zone since the pinch engaged. */
  moved: boolean;
}

/** One tracking frame with a hand, one without, or just the passing of time (a video frame). */
export type PinchInput = { kind: 'hand'; cursor: Point; pinchM: number | null } | { kind: 'none' } | { kind: 'tick' };

export type PinchEvent =
  | { type: 'found' }
  | { type: 'lost'; engaged: boolean }
  | { type: 'engage'; point: Point }
  | { type: 'drag-start' }
  | { type: 'release'; tap: boolean; point: Point };

export function initialPinchState(): PinchState {
  return { engaged: false, streak: 0, streakSince: null, handSeenAt: null, missing: true, engagePoint: null, moved: false };
}

/**
 * One step of a time-based engage or release, shared by the pinch and the fist. A frame that qualifies extends the streak; the
 * streak is `done` once it has lasted `holdMs` from its first frame and has at least MIN_GESTURE_FRAMES frames, so one noisy frame
 * never triggers, and the wall-clock time is the same at 10 and at 30 frames per second. A frame that does not qualify ends the streak.
 */
export function holdStep(streak: number, since: number | null, qualifies: boolean, now: number, holdMs: number): { streak: number; since: number | null; done: boolean } {
  if (!qualifies) return { streak: 0, since: null, done: false };
  const start = since ?? now;
  const count = streak + 1;
  return { streak: count, since: start, done: count >= MIN_GESTURE_FRAMES && now - start >= holdMs };
}

/**
 * The pinch state machine. `cursor` should be the filtered cursor. Only
 * tracking frames (`hand`, `none`) count toward streaks; `tick` only advances
 * time. Engaging and releasing take PINCH_ENGAGE_MS and PINCH_RELEASE_MS from the first qualifying frame (`holdStep`). Between the two thresholds nothing changes, a frame without a pinch
 * distance never engages, and a hand that comes back before the time-out
 * continues the same pinch. `lossMs`, when given, replaces both loss windows.
 */
export function pinchStep(state: PinchState, input: PinchInput, now: number, lossMs?: number): { state: PinchState; events: PinchEvent[] } {
  const events: PinchEvent[] = [];
  let next: PinchState = { ...state };

  // Time-outs first, so a hand frame arriving after a long gap starts afresh.
  if (next.handSeenAt !== null && now - next.handSeenAt >= (lossMs ?? (next.engaged ? TRACKING_LOSS_MS : HAND_LOST_MS))) {
    events.push({ type: 'lost', engaged: next.engaged });
    next = { ...initialPinchState(), missing: true };
  }

  if (input.kind === 'tick') return { state: next, events };

  if (input.kind === 'none') {
    next.missing = true;
    next.streak = 0;
    next.streakSince = null;
    return { state: next, events };
  }

  if (next.handSeenAt === null) events.push({ type: 'found' });
  next.handSeenAt = now;
  next.missing = false;

  const { cursor, pinchM } = input;
  if (pinchM === null) {
    next.streak = 0;
    next.streakSince = null;
  } else if (!next.engaged) {
    const hold = holdStep(next.streak, next.streakSince, pinchM < PINCH_ENGAGE_M, now, PINCH_ENGAGE_MS);
    next.streak = hold.streak;
    next.streakSince = hold.since;
    if (hold.done) {
      next = { ...next, engaged: true, streak: 0, streakSince: null, engagePoint: cursor, moved: false };
      events.push({ type: 'engage', point: cursor });
    }
  } else {
    const hold = holdStep(next.streak, next.streakSince, pinchM > PINCH_RELEASE_M, now, PINCH_RELEASE_MS);
    next.streak = hold.streak;
    next.streakSince = hold.since;
    if (hold.done) {
      events.push({ type: 'release', tap: !next.moved, point: cursor });
      next = { ...next, engaged: false, streak: 0, streakSince: null, engagePoint: null, moved: false };
    }
  }

  // The frame that releases cannot also start a drag: the fingers opening shifts the cursor.
  if (next.engaged && !next.moved && next.engagePoint
    && Math.hypot(cursor.x - next.engagePoint.x, cursor.y - next.engagePoint.y) > DRAG_DEAD_ZONE_PX) {
    next.moved = true;
    events.push({ type: 'drag-start' });
  }

  return { state: next, events };
}
