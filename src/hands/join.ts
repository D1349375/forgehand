import { fistAllowed, type Gate } from './gate';
import type { Target } from './types';

/** The one-hand gestures whose owner a second hand may join. */
export type OwnerGesture = 'press' | 'grab' | 'orbit' | 'hold';

/** What the second hand did: a pinch or (Task 7) a fist, and what is under it. */
export interface JoinInput { kind: 'pinch' | 'fist'; target: Target }

export type TwoHandGesture = 'zoom' | 'rotate' | 'explode' | 'assemble';

/**
 * What the rule may ask about the running gesture (assembly-joints design 10.1). `ownerObjectId` is the object the owner's fist holds;
 * `sameAssembly` says whether two objects are already connected through joints.
 */
export interface JoinContext { ownerObjectId: string | null; sameAssembly(a: string, b: string): boolean }

/**
 * Which two-hand gesture, if any, a second hand starts while `owner` runs. `null` makes the second hand inert.
 * The optional `context` is read by the assemble row only; without it that row never applies.
 */
export type JoinRule = (owner: OwnerGesture, joiner: JoinInput, gate: Gate, context?: JoinContext) => TwoHandGesture | null;

/**
 * The real rule (design §5.4, requirement 82). Each P1 task adds a row; a row whose task is not built
 * is absent, so the second hand is inert there. Rows so far:
 *   orbit + pinch -> zoom, while hand control is not off (Task 6);
 *   hold + pinch -> explode, at full control or while the exploded view is open (Task 7);
 *   hold + fist over a part of another object, not in the held object's assembly -> assemble, at full control only (assembly-joints Task 6).
 *   grab + pinch -> rotate, at full control only (Task 8).
 * The joining hand's own target is read by the assemble row only.
 */
export const joinGesture: JoinRule = (owner, joiner, gate, context) => {
  if (owner === 'orbit' && joiner.kind === 'pinch' && gate.level !== 'off') return 'zoom';
  if (owner === 'hold' && joiner.kind === 'pinch' && fistAllowed(gate)) return 'explode';
  if (owner === 'grab' && joiner.kind === 'pinch' && gate.level === 'full') return 'rotate';
  if (owner === 'hold' && joiner.kind === 'fist' && joiner.target.kind === 'part' && gate.level === 'full' && context && context.ownerObjectId !== null) {
    const held = context.ownerObjectId;
    const other = joiner.target.objectId;
    if (other !== held && !context.sameAssembly(held, other)) return 'assemble';
  }
  return null;
};
