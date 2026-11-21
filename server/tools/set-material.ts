import { z } from 'zod';
import type { ObjectToolDetail, StateChange } from '../../shared/agent';
import { MATERIALS, MaterialIdSchema } from '../../shared/materials';
import { ObjectIdSchema } from '../../shared/workspace';
import { checkedChange, isToolResult, ok, resolveTarget, switchTo } from './helpers';
import { defineTool } from './registry';

export const setMaterial = defineTool({
  name: 'set_material',
  label: '設定材料',
  category: 'assembly',
  description: 'sets the material of a whole object (objectId) and makes it active. material is one of pla, petg, abs, tpu, nylon, resin, aluminium, steel, or null for not specified. The material decides which fixing methods suit the object (for example heat-set inserts need a printable, non-flexible plastic). It does not change geometry or tolerances. Returns UNKNOWN_OBJECT for an unknown objectId.',
  args: z.strictObject({ objectId: ObjectIdSchema, material: MaterialIdSchema.nullable() }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ objectId, material }, { state }) {
    const target = resolveTarget(state, 'set_material', objectId);
    if (isToolResult(target)) return target;
    const name = target.model.name;
    const detail: ObjectToolDetail = { objectId: target.id, activeObjectId: state.workspace.activeObjectId, transform: null };
    const text = material === null ? '未指定' : MATERIALS[material].label;
    if ((target.material ?? null) === material) return ok('set_material', `「${name}」的材料已經是「${text}」。`, detail, null);
    const change: StateChange = {
      activeObjectId: switchTo(state, target),
      object: { op: 'material', objectId: target.id, material },
      selection: null, explode: null, tryOn: null,
    };
    const rejected = checkedChange(state, 'set_material', change);
    if (rejected) return rejected;
    return ok('set_material', material === null ? `已清除「${name}」的材料設定。` : `已將「${name}」的材料設為「${text}」。`,
      { ...detail, activeObjectId: change.activeObjectId ?? state.workspace.activeObjectId }, change);
  },
});
