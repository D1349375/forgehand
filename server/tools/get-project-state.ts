import { z } from 'zod';
import type { GetProjectStateDetail } from '../../shared/agent';
import { activeObject } from '../../shared/workspace';
import { ok } from './helpers';
import { defineTool } from './registry';

export const getProjectState = defineTool({
  name: 'get_project_state',
  label: '檢視目前狀態',
  category: 'inspect',
  description: 'returns a summary of the workspace (every object with id, name, part count and placement) and the parts, selection and explode amount of the active object, plus tryOn. Works on an empty workspace.',
  args: z.strictObject({}),
  side: 'server',
  scope: 'project',
  effects: 'read-only',
  async run(_args, { state }) {
    const { workspace } = state;
    const target = activeObject(workspace);
    const detail: GetProjectStateDetail = {
      objects: workspace.objects.map(object => ({
        id: object.id,
        name: object.model.name,
        partCount: object.model.parts.length,
        position: object.transform.position,
        rotation: object.transform.rotation,
        active: object.id === workspace.activeObjectId,
      })),
      activeObjectId: workspace.activeObjectId,
      target: target === null ? null : {
        objectId: target.id,
        parts: target.model.parts.map(part => ({
          id: part.id, name: part.name, primitive: part.primitive, color: part.color, parentId: part.parentId,
        })),
        selection: workspace.selection.objectId === target.id ? workspace.selection.partIds : [],
        explode: workspace.display.explode,
      },
      tryOn: state.tryOn,
    };
    const summary = detail.target === null || target === null
      ? '目前沒有模型。'
      : `工作區有 ${workspace.objects.length} 個物件。目前物件「${target.model.name}」有 ${detail.target.parts.length} 個零件，已選取 ${detail.target.selection.length} 個。`;
    return ok('get_project_state', summary, detail, null);
  },
});
