import { z } from 'zod';
import { PartIdSchema, type SelectPartsDetail, type StateChange } from '../../shared/agent';
import { checkedChange, fail, isToolResult, ok, resolveTarget, switchTo } from './helpers';
import { defineTool } from './registry';

export const selectParts = defineTool({
  name: 'select_parts',
  label: '選取零件',
  category: 'design',
  description: 'sets the part selection on the active object. Returns NO_MODEL if the workspace is empty.',
  args: z.strictObject({ partIds: z.array(PartIdSchema).max(64) }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ partIds }, { state }) {
    const target = resolveTarget(state, 'select_parts');
    if (isToolResult(target)) return target;
    const ids = new Set(target.model.parts.map(part => part.id));
    for (const id of partIds) {
      if (!ids.has(id)) return fail('select_parts', 'INVALID_ARGS', `選取的零件不在模型中：${id}`);
    }
    const selection = [...new Set(partIds)];
    const change: StateChange = {
      activeObjectId: switchTo(state, target), object: null,
      selection: { objectId: target.id, partIds: selection }, explode: null, tryOn: null,
    };
    const rejected = checkedChange(state, 'select_parts', change);
    if (rejected) return rejected;
    const detail: SelectPartsDetail = { objectId: target.id, selection };
    return ok('select_parts', selection.length ? `已選取 ${selection.length} 個零件。` : '已取消選取。', detail, change);
  },
});
