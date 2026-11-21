import type { Gate } from './gate';
import type { Target } from './types';

/** The one-hand gestures whose owner a second hand may join. */
export type OwnerGesture = 'press' | 'grab' | 'orbit' | 'hold';

/** What the second hand did: a pinch or (Task 7) a fist, and what is under it. */
export interface JoinInput { kind: 'pinch' | 'fist'; target: Target }

export type TwoHandGesture = 'zoom' | 'rotate' | 'explode';

/** Which two-hand gesture, if any, a second hand starts while `owner` runs. `null` makes the second hand inert. */
export type JoinRule = (owner: OwnerGesture, joiner: JoinInput, gate: Gate) => TwoHandGesture | null;

/**
 * The real rule (design §5.4, requirement 82). Each P1 task adds a row; a row whose task is not built
 * is absent, so the second hand is inert there. Rows so far:
 *   orbit + pinch -> zoom, while hand control is not off (Task 6).
 * Explode (Task 7) and rotate (Task 8) follow. The joining hand's own target is not read.
 */
export const joinGesture: JoinRule = (owner, joiner, gate) => {
  if (owner === 'orbit' && joiner.kind === 'pinch' && gate.level !== 'off') return 'zoom';
  return null;
};
