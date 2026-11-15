import { z } from 'zod';
import type { ObjectToolDetail, StateChange } from '../../shared/agent';
import { ObjectIdSchema, ObjectTransformSchema, type ObjectTransform } from '../../shared/workspace';
import { checkedChange, fail, isToolResult, ok, resolveTarget, switchTo } from './helpers';
import { defineTool } from './registry';

export const setTransform = defineTool({
  name: 'set_transform',
  label: '移動物件',
  category: 'design',
  description: 'moves and/or rotates a whole object (objectId) and makes it active. position is in metres and rotation in degrees (XYZ Euler), each a full { x, y, z }; give at least one. A value left out keeps its current value. It never changes the size of the object; use edit_design for that. Returns UNKNOWN_OBJECT for an unknown objectId and NO_MODEL if the workspace is empty.',
  args: z.strictObject({
    objectId: ObjectIdSchema,
    position: ObjectTransformSchema.shape.position.nullable().optional(),
    rotation: ObjectTransformSchema.shape.rotation.nullable().optional(),
  }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ objectId, position, rotation }, { state }) {
    const target = resolveTarget(state, 'set_transform', objectId);
    if (isToolResult(target)) return target;
    if (!position && !rotation) return fail('set_transform', 'INVALID_ARGS', '請至少提供 position 或 rotation。');
    const transform: ObjectTransform = {
      position: position ?? target.transform.position,
      rotation: rotation ?? target.transform.rotation,
    };
    const change: StateChange = {
      activeObjectId: switchTo(state, target),
      object: { op: 'transform', objectId: target.id, transform },
      selection: null, explode: null, tryOn: null,
    };
    const rejected = checkedChange(state, 'set_transform', change);
    if (rejected) return rejected;
    const detail: ObjectToolDetail = {
      objectId: target.id, activeObjectId: change.activeObjectId ?? state.workspace.activeObjectId, transform,
    };
    return ok('set_transform', `已移動「${target.model.name}」。`, detail, change);
  },
});
