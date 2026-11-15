import { z } from 'zod';
import type { ExplodeViewDetail, StateChange } from '../../shared/agent';
import { checkedChange, isToolResult, ok, OptionalObjectIdSchema, resolveTarget, switchTo } from './helpers';
import { defineTool } from './registry';

export const explodeView = defineTool({
  name: 'explode_view',
  label: '爆炸圖',
  category: 'view',
  description: 'sets the explode amount (0–1) of an object (objectId, default: the active object) and makes it active. Display state only; the browser computes layout. Returns UNKNOWN_OBJECT for an unknown objectId and NO_MODEL if the workspace is empty.',
  args: z.strictObject({ amount: z.number().min(0).max(1), objectId: OptionalObjectIdSchema }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ amount, objectId }, { state }) {
    const target = resolveTarget(state, 'explode_view', objectId);
    if (isToolResult(target)) return target;
    const change: StateChange = {
      activeObjectId: switchTo(state, target), object: null, selection: null, explode: amount, tryOn: null,
    };
    const rejected = checkedChange(state, 'explode_view', change);
    if (rejected) return rejected;
    const detail: ExplodeViewDetail = { objectId: target.id, amount };
    return ok(
      'explode_view',
      amount > 0 ? `爆炸圖程度設為 ${Math.round(amount * 100)}%。` : '已收回爆炸圖。',
      detail,
      change,
    );
  },
});
