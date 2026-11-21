import { z } from 'zod';
import type { GetProjectStateDetail } from '../../shared/agent';
import type { JointSummary } from '../../shared/agent';
import type { JointSide } from '../../shared/joint';
import { checkJoints } from '../../shared/joint-rules';
import type { AgentWorkingState } from '../agent-tools';
import { printerOf } from './joint-helpers';
import { isToolResult, ok, OptionalObjectIdSchema, resolveTarget } from './helpers';
import { defineTool } from './registry';

/** The joints in the short form of the state read: both sides with names, method, needs, confirmed flag and finding codes. */
function jointSummaries(state: AgentWorkingState): JointSummary[] {
  const { workspace } = state;
  if (workspace.joints.length === 0) return [];
  const findings = checkJoints(workspace, printerOf(state));
  const side = (joint: JointSide) => {
    const object = workspace.objects.find(candidate => candidate.id === joint.objectId);
    const part = object?.model.parts.find(candidate => candidate.id === joint.partId);
    return { objectId: joint.objectId, objectName: object?.model.name ?? joint.objectId, partId: joint.partId, partName: part?.name ?? joint.partId, face: joint.face };
  };
  return workspace.joints.map(joint => ({
    id: joint.id, a: side(joint.a), b: side(joint.b), method: joint.method, needs: joint.needs, confirmed: joint.confirmed,
    findings: (findings.get(joint.id) ?? []).slice(0, 20).map(finding => finding.code),
  }));
}

export const getProjectState = defineTool({
  name: 'get_project_state',
  label: '檢視目前狀態',
  category: 'inspect',
  description: 'returns a summary of the workspace (every object with id, name, part count, placement and material, and every joint with its id, both sides, method, needs, confirmed flag and finding codes) and the parts, selection and explode amount of one object (objectId, default: the active object), plus tryOn. Only reads: it never changes the active object. Works on an empty workspace; returns UNKNOWN_OBJECT for an unknown objectId.',
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
        material: object.material ?? null,
      })),
      joints: jointSummaries(state),
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
