import { z } from 'zod';
import type { StateChange } from '../../shared/agent';
import { JointMethodSchema, type JointNeeds } from '../../shared/joint';
import { recommendFor } from '../../shared/joint-rules';
import { ObjectIdSchema, updateJoint, WorkspaceError, type Workspace } from '../../shared/workspace';
import { DISASSEMBLY_TEXT, jointDetail, LOAD_TEXT, methodText, printerOf, sideText, UNKNOWN_NEED_TEXT } from './joint-helpers';
import { checkedChange, fail, ok } from './helpers';
import { defineTool } from './registry';

export const updateJointTool = defineTool({
  name: 'update_joint',
  label: '設定接合',
  category: 'assembly',
  description: 'sets the needs and/or the fixing method of a joint (jointId, from create_joint or get_project_state). load: light | medium | heavy; disassembly: never | sometimes | often (how often the parts are taken apart); confirmed: true only when the user chose or accepted the method in this conversation. method is a full object, one of { kind: "screw-insert", size: "M2" | "M3", count: 1-4, insertSide: "a" | "b" }, { kind: "magnet", magnet: "d6x2" | "d6x3" | "d8x3" | "d10x2" | "d10x3", count: 1-4 }, { kind: "pin", pin: "d2" | "d3" | "d4", count: 1-4, fit: "press-both" | "press-slide" } or { kind: "glue", glue: "ca" | "epoxy" | "solvent" }; a tube end accepts glue only. Changing load or disassembly of a joint that is not confirmed, without a method, also replaces its method with the new top recommendation. Give at least one field; null means not given. Returns the new recommendation with reasons and the findings. Errors: UNKNOWN_JOINT, INVALID_ARGS, INVALID_JOINT.',
  args: z.strictObject({
    jointId: ObjectIdSchema,
    load: z.enum(['light', 'medium', 'heavy']).nullable().optional(),
    disassembly: z.enum(['never', 'sometimes', 'often']).nullable().optional(),
    method: JointMethodSchema.nullable().optional(),
    confirmed: z.boolean().nullable().optional(),
  }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ jointId, load, disassembly, method, confirmed }, { state }) {
    const ws = state.workspace;
    const printer = printerOf(state);
    const current = ws.joints.find(joint => joint.id === jointId);
    if (!current) return fail('update_joint', 'UNKNOWN_JOINT', new WorkspaceError('UNKNOWN_JOINT').message);
    const needs: Partial<JointNeeds> = {};
    if (load != null) needs.load = load;
    if (disassembly != null) needs.disassembly = disassembly;
    if (Object.keys(needs).length === 0 && method == null && confirmed == null) {
      return fail('update_joint', 'INVALID_ARGS', '請至少提供一個要修改的欄位。');
    }
    let nextMethod = method ?? undefined;
    const needsChanged = (needs.load !== undefined && needs.load !== current.needs.load)
      || (needs.disassembly !== undefined && needs.disassembly !== current.needs.disassembly);
    // As the card does: new needs on a joint that stays unconfirmed re-pick its method. A call that
    // confirms the joint keeps the method the user is accepting.
    if (nextMethod === undefined && needsChanged && !current.confirmed && confirmed !== true) {
      const [top] = recommendFor(ws, { a: current.a, b: current.b }, { ...current.needs, ...needs }, printer, current.id);
      if (top) nextMethod = top.method;
    }
    let after: Workspace;
    try {
      after = updateJoint(ws, jointId, { method: nextMethod, needs, confirmed: confirmed ?? undefined });
    } catch (error) {
      if (error instanceof WorkspaceError) return fail('update_joint', error.code, error.message);
      throw error;
    }
    const joint = after.joints.find(candidate => candidate.id === jointId)!;
    const detail = jointDetail(after, joint, printer);
    const title = `${sideText(after, joint.a)} ↔ ${sideText(after, joint.b)}`;
    if (after === ws) return ok('update_joint', `接合沒有變更：${title}。`, detail, null);
    const change: StateChange = {
      activeObjectId: null, object: null, joint: { op: 'update', joint }, selection: null, explode: null, tryOn: null,
    };
    const rejected = checkedChange(state, 'update_joint', change);
    if (rejected) return rejected;
    const needsText = `負重 ${joint.needs.load ? LOAD_TEXT[joint.needs.load] : UNKNOWN_NEED_TEXT}，拆裝 ${joint.needs.disassembly ? DISASSEMBLY_TEXT[joint.needs.disassembly] : UNKNOWN_NEED_TEXT}`;
    return ok('update_joint', `已更新接合：${title}，方式：${methodText(joint.method)}，${joint.confirmed ? '已確認' : '尚未確認'}，${needsText}。`, detail, change);
  },
});
