import { z } from 'zod';
import type { ObjectToolDetail, StateChange } from '../../shared/agent';
import { applyWorkspaceChange, ObjectIdSchema } from '../../shared/workspace';
import { checkedChange, isToolResult, ok, resolveTarget } from './helpers';
import { defineTool } from './registry';

export const removeObject = defineTool({
  name: 'remove_object',
  label: '移除物件',
  category: 'design',
  description: 'removes an object (objectId) from the workspace. Call it only when the user asks to remove an object. The user can undo it. Returns UNKNOWN_OBJECT for an unknown objectId and NO_MODEL if the workspace is empty.',
  args: z.strictObject({ objectId: ObjectIdSchema }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ objectId }, { state }) {
    const target = resolveTarget(state, 'remove_object', objectId);
    if (isToolResult(target)) return target;
    const change: StateChange = {
      activeObjectId: null, object: { op: 'remove', objectId: target.id }, selection: null, explode: null, tryOn: null,
    };
    const rejected = checkedChange(state, 'remove_object', change);
    if (rejected) return rejected;
    // The workspace picks the next active object (or none); report it to the model.
    const { tryOn: _tryOn, ...workspaceChange } = change;
    const { after } = applyWorkspaceChange(state.workspace, workspaceChange);
    const detail: ObjectToolDetail = { objectId: target.id, activeObjectId: after.activeObjectId, transform: null };
    return ok('remove_object', `已移除「${target.model.name}」，工作區剩 ${after.objects.length} 個物件。`, detail, change);
  },
});
