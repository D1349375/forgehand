import {
  FIT_MIN_FPS, FIT_RECOVER_FPS, FIT_RECOVER_MS, MEASURE_BURST_MS, SEGMENT_CPU_INTERVAL_MS, SEGMENT_INTERVAL_MS, SEGMENT_MAX_INTERVAL_MS,
} from '../../shared/fit-constants';
import { SPEED_HOLD_MS } from '../hands/constants';
import type { TrackingDelegate } from '../try-on/arm-pose';

/**
 * When to ask the worker for a mask (body fit, design 4.3). Pure: the caller keeps the state between calls and
 * feeds the returned `next` back in.
 */
export interface CadenceState {
  /** The interval in force; starts at `SEGMENT_INTERVAL_MS`. */
  intervalMs: number;
  /** When the plan last said to ask (not when a mask came back), so a segmenter that is still loading is not asked on every frame. `null`: never. */
  lastAskAt: number | null;
  /** The tracking rate has been below FIT_MIN_FPS since this time. */
  lowSince: number | null;
  /** The tracking rate has been above FIT_RECOVER_FPS since this time. */
  highSince: number | null;
}
export interface CadenceInput {
  now: number;
  /** When the current measure step began asking on every frame; `null` when no step is measuring. */
  measuringSince: number | null;
  /** The tracking rate in frames per second (`HandSource.rate()`); `null` while it is unknown. */
  rateFps: number | null;
  delegate: TrackingDelegate | null;
}
export interface SegmentPlan {
  ask: boolean;
  /** The interval now in force (at least one second on the CPU delegate). */
  intervalMs: number;
  /** The state to pass in next time. */
  next: CadenceState;
}

export const initialCadence = (): CadenceState => ({ intervalMs: SEGMENT_INTERVAL_MS, lastAskAt: null, lowSince: null, highSince: null });

/**
 * - Fitting: ask when `intervalMs` has passed since the last ask.
 * - Measuring a step: ask on every frame for at most MEASURE_BURST_MS (not on the CPU delegate, which stays at one second).
 * - Back-off: the rate below FIT_MIN_FPS for SPEED_HOLD_MS doubles the interval up to SEGMENT_MAX_INTERVAL_MS, again
 *   after each further SPEED_HOLD_MS; the rate above FIT_RECOVER_FPS for FIT_RECOVER_MS halves it down to SEGMENT_INTERVAL_MS.
 *   A burst does not count: the rate may fall while a step is measuring.
 * - CPU delegate: the interval is never below SEGMENT_CPU_INTERVAL_MS.
 */
export function segmentPlan(state: CadenceState, input: CadenceInput): SegmentPlan {
  const { now, measuringSince, rateFps, delegate } = input;
  const cpu = delegate === 'CPU';
  const bursting = measuringSince !== null && now - measuringSince < MEASURE_BURST_MS && !cpu;
  let { intervalMs, lowSince, highSince } = state;
  if (bursting || rateFps === null) {
    lowSince = null;
    highSince = null;
  } else if (rateFps < FIT_MIN_FPS) {
    highSince = null;
    lowSince ??= now;
    if (now - lowSince >= SPEED_HOLD_MS) {
      intervalMs = Math.min(intervalMs * 2, SEGMENT_MAX_INTERVAL_MS);
      lowSince = now;
    }
  } else if (rateFps > FIT_RECOVER_FPS) {
    lowSince = null;
    highSince ??= now;
    if (now - highSince >= FIT_RECOVER_MS) {
      intervalMs = Math.max(intervalMs / 2, SEGMENT_INTERVAL_MS);
      highSince = now;
    }
  } else {
    lowSince = null;
    highSince = null;
  }
  const effective = cpu ? Math.max(intervalMs, SEGMENT_CPU_INTERVAL_MS) : intervalMs;
  const ask = bursting || state.lastAskAt === null || now - state.lastAskAt >= effective;
  return { ask, intervalMs: effective, next: { intervalMs, lastAskAt: ask ? now : state.lastAskAt, lowSince, highSince } };
}
