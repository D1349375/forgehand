import type { StateChange, ToolErrorDetail, ToolResult } from '../../shared/agent';
import {
  activeObject, applyWorkspaceChange, findObject, ObjectIdSchema, WorkspaceError, type SceneObject,
} from '../../shared/workspace';
import type { AgentWorkingState } from '../agent-tools';
import { GenerationError, type ModelProvider } from '../provider';

/** Result helpers shared by every tool. `server/agent-tools.ts` re-exports them. */

export const NO_MODEL_MESSAGE = '目前沒有模型，請先生成設計。';

/**
 * The optional `objectId` argument of the tools that act on one object. Models
 * often send `null` for "not given", so null and absent both mean the active object.
 */
export const OptionalObjectIdSchema = ObjectIdSchema.nullable().optional();

export function ok(tool: string, summary: string, detail: unknown, stateChange: ToolResult['stateChange'] = null): ToolResult {
  return { tool, ok: true, summary, detail, stateChange };
}

export function fail(tool: string, code: string, message: string): ToolResult {
  const detail: ToolErrorDetail = { code, message };
  return { tool, ok: false, summary: message, detail, stateChange: null };
}

export function noModel(tool: string): ToolResult {
  return fail(tool, 'NO_MODEL', NO_MODEL_MESSAGE);
}

export function isToolResult(value: SceneObject | ToolResult): value is ToolResult {
  return 'ok' in value;
}

/**
 * The object a tool acts on: the object named by `objectId`, or the active one
 * when `objectId` is null or absent. Failures are results the tool returns as is:
 * `NO_MODEL` for an empty workspace, `UNKNOWN_OBJECT` for an id that is not there.
 */
export function resolveTarget(state: AgentWorkingState, tool: string, objectId?: string | null): SceneObject | ToolResult {
  const { workspace } = state;
  if (workspace.objects.length === 0) return noModel(tool);
  if (objectId === null || objectId === undefined) {
    return activeObject(workspace) ?? noModel(tool);
  }
  return findObject(workspace, objectId)
    ?? fail(tool, 'UNKNOWN_OBJECT', `工作區沒有 id 為「${objectId}」的物件。`);
}

/**
 * The `activeObjectId` of a change that writes to `target`: its id when it is
 * not the active object yet, else `null` (no change). For writing tools only.
 */
export function switchTo(state: AgentWorkingState, target: SceneObject): string | null {
  return target.id === state.workspace.activeObjectId ? null : target.id;
}

/**
 * Dry-runs `change` on the working workspace. Returns a failure result when the
 * change does not apply (`WorkspaceError` code and message), else `null`. Every
 * writing tool calls this before it returns the change, so the loop's own
 * `applyWorkspaceChange` never sees an invalid one.
 */
export function checkedChange(state: AgentWorkingState, tool: string, change: StateChange): ToolResult | null {
  const { tryOn: _tryOn, exportDialog: _exportDialog, cameraHidden: _cameraHidden, ...workspaceChange } = change;
  try {
    applyWorkspaceChange(state.workspace, workspaceChange);
    return null;
  } catch (error) {
    if (error instanceof WorkspaceError) return fail(tool, error.code, error.message);
    throw error;
  }
}

/** The agent loop requires `run`; surface a missing one as a provider error that ends the run. */
export function requireRun(provider: ModelProvider) {
  if (!provider.run) throw new GenerationError('SERVICE_ERROR', '模型服務暫時無法完成，請稍後重試。');
  return provider.run;
}
