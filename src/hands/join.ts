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
 *   grab + pinch on a part of another object, not in the grabbed object's assembly -> assemble, at full control only
 *     (hand-manipulation Task 11: the two-pinch join; the part grab is cancelled and both hands hold whole objects);
 *   grab + pinch on anything else -> rotate by circling, grab + fist (anywhere) -> rotate by the twist of the fist, the knob (Task 11).
 * The joining hand's own target is read by the two assemble rows only.
 */
export const joinGesture: JoinRule = (owner, joiner, gate, context) => {
  if (owner === 'orbit' && joiner.kind === 'pinch' && gate.level !== 'off') return 'zoom';
  if (owner === 'hold' && joiner.kind === 'pinch' && fistAllowed(gate)) return 'explode';
  if ((owner === 'hold' && joiner.kind === 'fist') || (owner === 'grab' && joiner.kind === 'pinch')) {
    if (joinsAnotherObject(joiner, gate, context)) return 'assemble';
  }
  if (owner === 'grab' && gate.level === 'full') return 'rotate';
  return null;
};

/** The joining hand is over a part of an object that is not the owner's object and not in its assembly, at full control, with a context to say so. */
function joinsAnotherObject(joiner: JoinInput, gate: Gate, context: JoinContext | undefined): boolean {
  if (joiner.target.kind !== 'part' || gate.level !== 'full' || !context || context.ownerObjectId === null) return false;
  const held = context.ownerObjectId;
  const other = joiner.target.objectId;
  return other !== held && !context.sameAssembly(held, other);
}
