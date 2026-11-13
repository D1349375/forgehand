import { z } from 'zod';
import { PartIdSchema } from '../../shared/agent';
import { fail, noModel, ok } from './helpers';
import { defineTool } from './registry';

export const selectParts = defineTool({
  name: 'select_parts',
  category: 'design',
  description: 'sets the current part selection. Returns NO_MODEL if no model exists.',
  args: z.strictObject({ partIds: z.array(PartIdSchema).max(64) }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ partIds }, { state }) {
    if (state.model === null) return noModel('select_parts');
    const ids = new Set(state.model.parts.map(part => part.id));
    for (const id of partIds) {
      if (!ids.has(id)) return fail('select_parts', 'INVALID_ARGS', `選取的零件不在模型中：${id}`);
    }
    return ok(
      'select_parts',
      partIds.length ? `已選取 ${partIds.length} 個零件。` : '已取消選取。',
      { selection: partIds },
      { model: null, selection: partIds, explode: null, tryOn: null },
    );
  },
});
