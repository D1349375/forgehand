import { planJoin, worldFace, type JoinPlan } from '../../shared/contact';
import { faceShape, type FaceId } from '../../shared/joint';
import { findObject, setTransform, type ObjectTransform, type Workspace } from '../../shared/workspace';
import { JOINT_NOTICES } from './labels';

/**
 * The mouse join as a pure state machine (assembly-joints design 8.3, requirements 52 and 53).
 * The user clicks a part of one object, then a part of another (or, with decision 1, another
 * part of the same object); the faces are the best facing pair of the two parts, so nobody has
 * to aim at a face that may point away from the camera. No React, no Three.js.
 */

export interface PartRef { objectId: string; partId: string }
export type OkPlan = Extract<JoinPlan, { ok: true }>;

export type MouseJoinState =
  | { step: 'off' }
  | { step: 'first' }
  | { step: 'second'; a: PartRef }
  | { step: 'preview'; a: PartRef; b: PartRef; pairIndex: number; plan: OkPlan };

export type MouseJoinEvent =
  | { type: 'start' }
  | { type: 'pick'; objectId: string | null; partId: string | null }
  | { type: 'next-pair' }
  | { type: 'cancel' }
  | { type: 'workspace-changed' };

export interface PreviewPose { objectId: string; transform: ObjectTransform }

/**
 * Where the objects stand in the join preview: side b's object and its whole assembly at the aligned
 * pose (the same `setTransform` the commit uses, so the preview is what the commit does), and the
 * point of the 可以接合 label (the centre of side a's face, which never moves). `null` when the
 * move would leave the transform limits.
 */
export function previewPoses(ws: Workspace, plan: OkPlan): { transforms: PreviewPose[]; label: { x: number; y: number; z: number } } | null {
  const transforms: PreviewPose[] = [];
  if (plan.move) {
    let moved: Workspace;
    try { moved = setTransform(ws, plan.move.objectId, plan.move.transform); }
    catch { return null; }
    const before = new Map(ws.objects.map(object => [object.id, object]));
    for (const object of moved.objects) if (object !== before.get(object.id)) transforms.push({ objectId: object.id, transform: object.transform });
  }
  const object = findObject(ws, plan.a.objectId);
  const part = object?.model.parts.find(candidate => candidate.id === plan.a.partId);
  const face = object && part ? worldFace(object, part, plan.a.face) : null;
  const at = face?.centre;
  return { transforms, label: at ? { x: at.x, y: at.y, z: at.z } : { x: 0, y: 0, z: 0 } };
}
const FACES: readonly FaceId[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

const findPart = (ws: Workspace, ref: PartRef) => findObject(ws, ref.objectId)?.model.parts.find(part => part.id === ref.partId) ?? null;

/** Whether the part has at least one contact face (a sphere or a torus has none). */
export function hasContactFace(ws: Workspace, ref: PartRef): boolean {
  const part = findPart(ws, ref);
  return part !== null && FACES.some(face => faceShape(part.primitive, face) !== null);
}

/** The next state and, when the click needs an explanation, a notice. The same state object is returned when nothing changes. */
export function mouseJoinStep(state: MouseJoinState, event: MouseJoinEvent, ws: Workspace): { state: MouseJoinState; notice: string | null } {
  const same = { state, notice: null };
  switch (event.type) {
    case 'start': return { state: { step: 'first' }, notice: null };
    case 'cancel':
    case 'workspace-changed': return state.step === 'off' ? same : { state: { step: 'off' }, notice: null };
    case 'next-pair': {
      if (state.step !== 'preview') return same;
      const count = state.plan.pairs.length;
      if (count <= 1) return same;
      const pairIndex = (state.pairIndex + 1) % count;
      const planned = planJoin(ws, state.a, state.b, pairIndex);
      // The ranked list cannot change between two clicks of one workspace; if it does, stay where we are.
      return planned.ok && previewPoses(ws, planned) ? { state: { ...state, pairIndex, plan: planned }, notice: null } : same;
    }
    case 'pick': {
      if (state.step === 'off') return same;
      const { objectId, partId } = event;
      if (objectId === null || partId === null) return same;
      const ref: PartRef = { objectId, partId };
      if (!findPart(ws, ref)) return same;
      if (state.step === 'first') {
        if (!hasContactFace(ws, ref)) return { state, notice: JOINT_NOTICES.noFaceOnPart };
        return { state: { step: 'second', a: ref }, notice: null };
      }
      // `second` and `preview`: the clicked part is side b; side a stays.
      const a = state.a;
      const planned = planJoin(ws, a, ref);
      if (!planned.ok) return { state: { step: 'second', a }, notice: planned.message };
      if (!previewPoses(ws, planned)) return { state: { step: 'second', a }, notice: JOINT_NOTICES.rejected };
      return { state: { step: 'preview', a, b: ref, pairIndex: 0, plan: planned }, notice: null };
    }
  }
}
