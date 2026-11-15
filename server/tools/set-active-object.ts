import { z } from 'zod';
import type { ObjectToolDetail, StateChange } from '../../shared/agent';
import { ObjectIdSchema } from '../../shared/workspace';
import { checkedChange, isToolResult, ok, resolveTarget, switchTo } from './helpers';
import { defineTool } from './registry';

export const setActiveObject = defineTool({
  name: 'set_active_object',
  label: '切換物件',
  category: 'design',
  description: 'makes an object (objectId) the active one, which the other tools act on by default. Already active is fine. Returns UNKNOWN_OBJECT for an unknown objectId and NO_MODEL if the workspace is empty.',
  args: z.strictObject({ objectId: ObjectIdSchema }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ objectId }, { state }) {
    const target = resolveTarget(state, 'set_active_object', objectId);
    if (isToolResult(target)) return target;
    const detail: ObjectToolDetail = { objectId: target.id, activeObjectId: target.id, transform: null };
    const activeObjectId = switchTo(state, target);
    if (activeObjectId === null) {
      return ok('set_active_object', `「${target.model.name}」已經是目前物件。`, detail, null);
    }
    const change: StateChange = { activeObjectId, object: null, selection: null, explode: null, tryOn: null };
    const rejected = checkedChange(state, 'set_active_object', change);
    if (rejected) return rejected;
    return ok('set_active_object', `已切換到「${target.model.name}」。`, detail, change);
  },
});
