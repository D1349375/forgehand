import { z } from 'zod';
import { noModel, ok } from './helpers';
import { defineTool } from './registry';

export const explodeView = defineTool({
  name: 'explode_view',
  category: 'view',
  description: 'sets the explode amount (0–1). Display state only; the browser computes layout. Returns NO_MODEL if no model exists.',
  args: z.strictObject({ amount: z.number().min(0).max(1) }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ amount }, { state }) {
    if (state.model === null) return noModel('explode_view');
    return ok(
      'explode_view',
      amount > 0 ? `爆炸圖程度設為 ${Math.round(amount * 100)}%。` : '已收回爆炸圖。',
      { amount },
      { model: null, selection: null, explode: amount, tryOn: null },
    );
  },
});
