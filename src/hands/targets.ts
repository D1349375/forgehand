import { HOVER_SETTLE_MS } from './constants';
import { EMPTY_TARGET, targetKey, type Point, type ScreenTarget, type Target } from './types';

/**
 * The target under `point`. On-screen targets are checked first; when several
 * contain the point, the last one registered wins (so a later, higher target
 * wins). Otherwise `scene` casts into the scene.
 */
export function pickTarget(point: Point, screen: readonly ScreenTarget[], scene: (point: Point) => Target): Target {
  for (let index = screen.length - 1; index >= 0; index--) {
    const item = screen[index]!;
    if (point.x >= item.left && point.x <= item.right && point.y >= item.top && point.y <= item.bottom) {
      return { kind: 'screen', id: item.id, label: item.label };
    }
  }
  return scene(point);
}

export interface SettleState {
  /** What the badge, the ring and a pinch act on. */
  settled: Target;
  /** The raw target waiting to become settled. */
  candidate: Target;
  /** When `candidate` was first seen. */
  since: number;
}

export function initialSettleState(now = 0): SettleState {
  return { settled: EMPTY_TARGET, candidate: EMPTY_TARGET, since: now };
}

/**
 * Settles a raw target only after it has held for `HOVER_SETTLE_MS`, so the
 * small cursor movement while the fingers close does not change what a pinch
 * grabs. While raw and settled name the same target, the settled one takes the
 * raw one's newer `hit`.
 */
export function settleStep(state: SettleState, raw: Target, now: number): SettleState {
  const rawKey = targetKey(raw);
  if (rawKey === targetKey(state.settled)) return { settled: raw, candidate: raw, since: now };
  if (rawKey !== targetKey(state.candidate)) return { settled: state.settled, candidate: raw, since: now };
  if (now - state.since >= HOVER_SETTLE_MS) return { settled: raw, candidate: raw, since: state.since };
  return { settled: state.settled, candidate: raw, since: state.since };
}
