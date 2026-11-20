import {
  DRAG_DEAD_ZONE_PX, HAND_LOST_MS, PINCH_ENGAGE_FRAMES, PINCH_ENGAGE_M, PINCH_RELEASE_FRAMES, PINCH_RELEASE_M, TRACKING_LOSS_MS,
} from './constants';
import type { Point } from './types';

export interface PinchState {
  engaged: boolean;
  /** Consecutive tracking frames beyond the threshold that would change `engaged`. */
  streak: number;
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
  return { engaged: false, streak: 0, handSeenAt: null, missing: true, engagePoint: null, moved: false };
}

/**
 * The pinch state machine. `cursor` should be the filtered cursor. Only
 * tracking frames (`hand`, `none`) count toward streaks; `tick` only advances
 * time. Between the two thresholds nothing changes, a frame without a pinch
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
    return { state: next, events };
  }

  if (next.handSeenAt === null) events.push({ type: 'found' });
  next.handSeenAt = now;
  next.missing = false;

  const { cursor, pinchM } = input;
  if (pinchM === null) {
    next.streak = 0;
  } else if (!next.engaged) {
    next.streak = pinchM < PINCH_ENGAGE_M ? next.streak + 1 : 0;
    if (next.streak >= PINCH_ENGAGE_FRAMES) {
      next = { ...next, engaged: true, streak: 0, engagePoint: cursor, moved: false };
      events.push({ type: 'engage', point: cursor });
    }
  } else {
    next.streak = pinchM > PINCH_RELEASE_M ? next.streak + 1 : 0;
    if (next.streak >= PINCH_RELEASE_FRAMES) {
      events.push({ type: 'release', tap: !next.moved, point: cursor });
      next = { ...next, engaged: false, streak: 0, engagePoint: null, moved: false };
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
