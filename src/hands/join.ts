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
 * The real rule. It has no rows yet: the P1 tasks add zoom (Task 6), explode (Task 7)
 * and rotate (Task 8), so until then a second hand is always inert.
 */
export const joinGesture: JoinRule = () => null;
