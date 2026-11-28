import { z } from 'zod';
import type { PullOutDetail, StateChange } from '../../shared/agent';
import { PartIdSchema } from '../../shared/model';
import { pullOutCheck } from '../../shared/pull-out';
import { MAX_OBJECTS } from '../../shared/workspace';
import { PULL_OUT_TEXT } from '../i18n/pull-out';
import { checkedChange, fail, isToolResult, langOf, ok, OptionalObjectIdSchema, resolveTarget } from './helpers';
import { defineTool } from './registry';

// ---------------------------------------------------------------------------
// pull_out_part
// ---------------------------------------------------------------------------

export const pullOutPartTool = defineTool({
  name: 'pull_out_part',
  // The registry wants one label; the table holds both languages and the label is shown in Traditional Chinese.
  label: PULL_OUT_TEXT['zh-TW'].label,
  category: 'assembly',
  description: 'takes a part (partId) with its child parts out of its object (objectId, default: the active object) and makes it a new object. A part joined to anything outside it stays where it is, and its joints then connect the two objects; otherwise the new object is placed next to the original. The original stays active. Use it to separate a part, print it separately, give it another material, or join it to another part of the same design. The user can undo it. Errors: NO_MODEL, UNKNOWN_OBJECT, UNKNOWN_PART, WHOLE_OBJECT, OBJECT_LIMIT.',
  args: z.strictObject({ partId: PartIdSchema, objectId: OptionalObjectIdSchema }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ partId, objectId }, { state, newObjectId, now }) {
    const target = resolveTarget(state, 'pull_out_part', objectId);
    if (isToolResult(target)) return target;
    const text = PULL_OUT_TEXT[langOf(state)];

    const check = pullOutCheck(state.workspace, target.id, partId);
    if (!check.ok) {
      const message = check.code === 'UNKNOWN_OBJECT' ? text.errors.unknownObject
        : check.code === 'UNKNOWN_PART' ? text.errors.unknownPart
          : check.code === 'WHOLE_OBJECT' ? text.errors.wholeObject
            : text.errors.objectLimit({ max: MAX_OBJECTS });
      return fail('pull_out_part', check.code, message);
    }

    const newId = newObjectId();
    const change: StateChange = {
      activeObjectId: null,
      object: { op: 'pull-out', objectId: target.id, partId, newObjectId: newId, createdAt: now() },
      selection: null, explode: null, tryOn: null,
    };
    const rejected = checkedChange(state, 'pull_out_part', change);
    if (rejected) return rejected;

    const inside = new Set(check.partIds);
    const jointsMoved = state.workspace.joints.filter(joint =>
      [joint.a, joint.b].some(side => side.objectId === target.id && inside.has(side.partId))).length;
    const detail: PullOutDetail = {
      objectId: target.id, partId, newObjectId: newId, partIds: check.partIds, inPlace: check.inPlace, jointsMoved,
    };
    // The new object is named after the part it starts from.
    const part = target.model.parts.find(candidate => candidate.id === partId)!;
    const count = check.partIds.length - 1;
    const summary = check.inPlace
      ? text.inPlace({ part: part.name, count, name: part.name })
      : text.beside({ part: part.name, count, name: part.name, original: target.model.name });
    return ok('pull_out_part', summary, detail, change);
  },
});
