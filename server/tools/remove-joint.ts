import { z } from 'zod';
import type { StateChange } from '../../shared/agent';
import { ObjectIdSchema, WorkspaceError } from '../../shared/workspace';
import { sideText } from './joint-helpers';
import { checkedChange, fail, ok } from './helpers';
import { defineTool } from './registry';

export const removeJoint = defineTool({
  name: 'remove_joint',
  label: '移除接合',
  category: 'assembly',
  description: 'removes one joint (jointId). The objects stay where they are, but the two objects are no longer one assembly unless another joint still links them. Call it only when the user asks. Returns UNKNOWN_JOINT for an unknown jointId.',
  args: z.strictObject({ jointId: ObjectIdSchema }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ jointId }, { state }) {
    const joint = state.workspace.joints.find(candidate => candidate.id === jointId);
    if (!joint) return fail('remove_joint', 'UNKNOWN_JOINT', new WorkspaceError('UNKNOWN_JOINT').message);
    const change: StateChange = {
      activeObjectId: null, object: null, joint: { op: 'remove', jointId }, selection: null, explode: null, tryOn: null,
    };
    const rejected = checkedChange(state, 'remove_joint', change);
    if (rejected) return rejected;
    return ok('remove_joint', `已移除接合：${sideText(state.workspace, joint.a)} ↔ ${sideText(state.workspace, joint.b)}。`, null, change);
  },
});
