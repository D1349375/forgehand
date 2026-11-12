import {
  validateToolCallArgs,
  type GetProjectStateDetail,
  type ToolCall,
  type ToolErrorDetail,
  type ToolName,
  type ToolResult,
  type WearOnArmDetail,
} from '../shared/agent';
import type { ModelSpec } from '../shared/model';
import type { ModelProvider } from './provider';

/**
 * Server-side working copy for the duration of one agent run. `runTool` reads
 * this but does NOT mutate it — the loop applies each result's `stateChange`
 * between tool calls, so a multi-call round sees earlier calls' effects.
 */
export interface AgentWorkingState {
  model: ModelSpec | null;
  selection: string[];
  explode: number;
  tryOn: boolean;
  cameraOn: boolean;
}

const NO_MODEL_MESSAGE = '目前沒有模型，請先 generate_design。';

function ok(tool: ToolName, summary: string, detail: unknown, stateChange: ToolResult['stateChange'] = null): ToolResult {
  return { tool, ok: true, summary, detail, stateChange };
}
function fail(tool: ToolName, code: string, message: string): ToolResult {
  const detail: ToolErrorDetail = { code, message };
  return { tool, ok: false, summary: message, detail, stateChange: null };
}
function noModel(tool: ToolName): ToolResult {
  return fail(tool, 'NO_MODEL', NO_MODEL_MESSAGE);
}

/**
 * Runs one tool call against the working copy. Local tools never call the
 * model; `generate_design`/`edit_design` (Task 3) use `provider`/`signal`. A
 * bad-args call returns a structured `ToolError` rather than throwing (req 15);
 * a `GenerationError`/abort from a model-calling tool propagates and ends the
 * run (handled by the loop, not here).
 */
export async function runTool(
  call: ToolCall,
  state: AgentWorkingState,
  _provider: ModelProvider,
  _signal: AbortSignal,
): Promise<ToolResult> {
  // Defensive: the loop already validated args via validateAgentStep, but a
  // directly-constructed call could still be bad. Surface it as a ToolError.
  try {
    validateToolCallArgs(call);
  } catch (error) {
    return fail(call.tool, 'INVALID_ARGS', error instanceof Error ? error.message : '工具參數無效。');
  }
  switch (call.tool) {
    case 'select_parts':
      return selectParts(call, state);
    case 'get_project_state':
      return getProjectState(call, state);
    case 'explode_view':
      return explodeView(call, state);
    case 'wear_on_arm':
      return wearOnArm(call, state);
    default:
      // generate_design / edit_design arrive in Task 3; estimate_weight_cost /
      // check_feasibility are deferred to Task 9.
      return fail(call.tool, 'NOT_IMPLEMENTED', '此工具尚未實作。');
  }
}

function selectParts(call: ToolCall, state: AgentWorkingState): ToolResult {
  if (state.model === null) return noModel(call.tool);
  const partIds = call.args.partIds!;
  const ids = new Set(state.model.parts.map(part => part.id));
  for (const id of partIds) {
    if (!ids.has(id)) return fail(call.tool, 'INVALID_ARGS', `選取的零件不在模型中：${id}`);
  }
  return ok(
    call.tool,
    partIds.length ? `已選取 ${partIds.length} 個零件。` : '已取消選取。',
    { selection: partIds },
    { model: null, selection: partIds, explode: null, tryOn: null },
  );
}

function getProjectState(call: ToolCall, state: AgentWorkingState): ToolResult {
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
  return ok(call.tool, summary, detail, null);
}

function explodeView(call: ToolCall, state: AgentWorkingState): ToolResult {
  if (state.model === null) return noModel(call.tool);
  const amount = call.args.amount!;
  if (amount < 0 || amount > 1) return fail(call.tool, 'INVALID_ARGS', 'amount 必須介於 0 與 1 之間。');
  return ok(
    call.tool,
    amount > 0 ? `爆炸圖程度設為 ${Math.round(amount * 100)}%。` : '已收回爆炸圖。',
    { amount },
    { model: null, selection: null, explode: amount, tryOn: null },
  );
}

function wearOnArm(call: ToolCall, state: AgentWorkingState): ToolResult {
  if (state.model === null) return noModel(call.tool);
  const enabled = call.args.enabled!;
  // The tool never starts the camera (req 13); if it is off, ask the user.
  if (enabled && !state.cameraOn) {
    const detail: WearOnArmDetail = { tryOn: state.tryOn, cameraOn: false, message: '請先開啟攝影機再試戴。' };
    return { tool: call.tool, ok: false, summary: '請先開啟攝影機再試戴。', detail, stateChange: null };
  }
  const detail: WearOnArmDetail = { tryOn: enabled, cameraOn: state.cameraOn, message: enabled ? '已開啟護臂試戴。' : '已關閉護臂試戴。' };
  return ok(call.tool, detail.message, detail, { model: null, selection: null, explode: null, tryOn: enabled });
}
