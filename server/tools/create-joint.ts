import { z } from 'zod';
import type { StateChange } from '../../shared/agent';
import { planJoin } from '../../shared/contact';
import { FaceIdSchema } from '../../shared/joint';
import { newJoint } from '../../shared/joint-rules';
import { PartIdSchema } from '../../shared/model';
import { addJoint, ObjectIdSchema, setTransform, WorkspaceError } from '../../shared/workspace';
import { checkedChange, fail, isToolResult, ok, resolveTarget } from './helpers';
import { jointDetail, methodText, printerOf, sideText } from './joint-helpers';
import { defineTool } from './registry';

// ---------------------------------------------------------------------------
// create_joint
// ---------------------------------------------------------------------------

const SideArgSchema = z.strictObject({
  objectId: ObjectIdSchema,
  partId: PartIdSchema.nullable().optional(),
  face: FaceIdSchema.nullable().optional(),
});

export const createJoint = defineTool({
  name: 'create_joint',
  label: '建立接合',
  category: 'assembly',
  description: 'joins two objects (or two parts of one object) on flat faces. Each side is { objectId, partId?, face? } with face one of +x, -x, +y, -y, +z, -z (part-local axes); leave partId and face out (or null) to let the tool pick the best facing pair of faces between the two sides. When the faces do not touch yet, the object of side b is moved with its assembly onto side a (faces whose normals differ by more than 15 degrees cannot be aligned: rotate an object first). Parts that are already in one assembly must already touch. The new joint gets the top recommended fixing method, is not confirmed, and its load and disassembly needs are unknown. Returns the joint id, the recommendation with reasons and the findings. Does not change the active object. Errors: UNKNOWN_OBJECT, UNKNOWN_PART, NO_CONTACT_FACE, CANNOT_ALIGN, NOT_TOUCHING, JOINT_LIMIT.',
  args: z.strictObject({ a: SideArgSchema, b: SideArgSchema }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ a, b }, { state, newObjectId, now }) {
    const ws = state.workspace;
    for (const side of [a, b]) {
      const object = resolveTarget(state, 'create_joint', side.objectId);
      if (isToolResult(object)) return object;
      if (side.partId != null && !object.model.parts.some(part => part.id === side.partId)) {
        return fail('create_joint', 'UNKNOWN_PART', `工作區的「${object.model.name}」沒有 id 為「${side.partId}」的零件。`);
      }
    }
    const given = (side: typeof a) => ({ objectId: side.objectId, partId: side.partId ?? undefined, face: side.face ?? undefined });
    try {
      const plan = planJoin(ws, given(a), given(b));
      if (!plan.ok) return fail('create_joint', plan.code, plan.message);
      // The joint is planned on the workspace after the move, as the mouse join does.
      const moved = plan.move ? setTransform(ws, plan.move.objectId, plan.move.transform) : ws;
      const joint = newJoint(moved, { id: newObjectId(), createdAt: now(), a: plan.a, b: plan.b }, printerOf(state));
      const change: StateChange = {
        activeObjectId: null,
        object: plan.move ? { op: 'transform', objectId: plan.move.objectId, transform: plan.move.transform } : null,
        joint: { op: 'add', joint },
        selection: null, explode: null, tryOn: null,
      };
      const rejected = checkedChange(state, 'create_joint', change);
      if (rejected) return rejected;
      const after = addJoint(moved, joint);
      const movedText = plan.move ? `，已將「${ws.objects.find(object => object.id === plan.move!.objectId)?.model.name}」連同接合的物件移到貼合位置` : '';
      return ok('create_joint', `已建立接合：${sideText(after, joint.a)} ↔ ${sideText(after, joint.b)}，建議方式：${methodText(joint.method)}${movedText}。尚未確認，請詢問使用者負重與拆裝需求。`,
        jointDetail(after, joint, printerOf(state)), change);
    } catch (error) {
      if (error instanceof WorkspaceError) return fail('create_joint', error.code, error.message);
      throw error;
    }
  },
});
