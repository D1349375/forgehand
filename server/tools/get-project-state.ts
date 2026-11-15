import { z } from 'zod';
import type { GetProjectStateDetail } from '../../shared/agent';
import { isToolResult, ok, OptionalObjectIdSchema, resolveTarget } from './helpers';
import { defineTool } from './registry';

export const getProjectState = defineTool({
  name: 'get_project_state',
  label: '檢視目前狀態',
  category: 'inspect',
  description: 'returns a summary of the workspace (every object with id, name, part count and placement) and the parts, selection and explode amount of one object (objectId, default: the active object), plus tryOn. Only reads: it never changes the active object. Works on an empty workspace; returns UNKNOWN_OBJECT for an unknown objectId.',
  args: z.strictObject({ objectId: OptionalObjectIdSchema }),
  side: 'server',
  scope: 'project',
  effects: 'read-only',
  async run({ objectId }, { state }) {
    const { workspace } = state;
    // An empty workspace is a valid read, unless the caller named an object in it.
    const named = objectId !== null && objectId !== undefined;
    const target = workspace.objects.length === 0 && !named ? null : resolveTarget(state, 'get_project_state', objectId);
    if (target !== null && isToolResult(target)) return target;
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
      : `工作區有 ${workspace.objects.length} 個物件。${target.id === workspace.activeObjectId ? '目前物件' : '物件'}「${target.model.name}」有 ${detail.target.parts.length} 個零件，已選取 ${detail.target.selection.length} 個。`;
    return ok('get_project_state', summary, detail, null);
  },
});
