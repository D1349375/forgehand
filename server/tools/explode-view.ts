import { z } from 'zod';
import type { ExplodeViewDetail, StateChange } from '../../shared/agent';
import { checkedChange, isToolResult, ok, resolveTarget, switchTo } from './helpers';
import { defineTool } from './registry';

export const explodeView = defineTool({
  name: 'explode_view',
  label: '爆炸圖',
  category: 'view',
  description: 'sets the explode amount (0–1) of the active object. Display state only; the browser computes layout. Returns NO_MODEL if the workspace is empty.',
  args: z.strictObject({ amount: z.number().min(0).max(1) }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ amount }, { state }) {
    const target = resolveTarget(state, 'explode_view');
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
