import { z } from 'zod';
import type { GetProjectStateDetail } from '../../shared/agent';
import { ok } from './helpers';
import { defineTool } from './registry';

export const getProjectState = defineTool({
  name: 'get_project_state',
  category: 'inspect',
  description: 'returns a summary of the current model (parts, selection, explode, tryOn). Works with or without a model.',
  args: z.strictObject({}),
  side: 'server',
  scope: 'project',
  effects: 'read-only',
  async run(_args, { state }) {
    const detail: GetProjectStateDetail = {
      parts: state.model === null ? [] : state.model.parts.map(part => ({
        id: part.id, name: part.name, primitive: part.primitive, color: part.color, parentId: part.parentId,
      })),
      selection: state.selection,
      explode: state.explode,
      tryOn: state.tryOn,
    };
    const summary = state.model === null
      ? '目前沒有模型。'
      : `目前有 ${detail.parts.length} 個零件，已選取 ${state.selection.length} 個。`;
    return ok('get_project_state', summary, detail, null);
  },
});
