import type { ToolCall, ToolResult } from '../shared/agent';
import type { ModelSpec } from '../shared/model';
import type { ModelProvider } from './provider';
import { fail } from './tools/helpers';
import { argKeys, argsShapeText, getTool, listTools } from './tools';

export { fail, noModel, ok } from './tools/helpers';

/**
 * Single entry point for tool execution. Tools are defined in `server/tools/`
 * (one file each) and registered by importing `./tools`; this module holds the
 * working-copy type, re-exports the result helpers, and dispatches.
 */

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

/**
 * Runs one tool call against the working copy. Looks the tool up in the
 * registry, parses `argsJson` with the tool's own schema, then calls the tool.
 * An unknown tool or bad arguments return a structured `ToolError` rather than
 * throwing (req 16). An abort or `GenerationError` from `provider.run` inside a
 * tool is NOT caught here — it propagates and ends the run.
 */
export async function runTool(
  call: ToolCall,
  state: AgentWorkingState,
  provider: ModelProvider,
  signal: AbortSignal,
): Promise<ToolResult> {
  const tool = getTool(call.tool);
  if (!tool) {
    const names = listTools({ scope: 'project', side: 'server' }).map(entry => entry.name).join('、');
    return fail(call.tool, 'UNKNOWN_TOOL', `沒有名為「${call.tool}」的工具。可用工具：${names}。`);
  }

  const signature = `${tool.name}(${argsShapeText(tool.args)})`;
  const invalid = (reason: string) =>
    fail(call.tool, 'INVALID_ARGS', `工具「${tool.name}」的參數無效：${reason}格式：${signature}。`);

  let raw: unknown;
  try {
    raw = JSON.parse(call.argsJson);
  } catch {
    return invalid('argsJson 不是有效的 JSON。');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('argsJson 必須是 JSON 物件。');
  }

  const parsed = tool.args.safeParse(raw);
  if (!parsed.success) {
    // Never forward Zod's message text (it can echo model-supplied values); name
    // only keys the tool's own schema declares.
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    const declared = typeof key === 'string' && argKeys(tool.args).includes(key);
    if (issue?.code === 'unrecognized_keys') return invalid('包含此工具不接受的參數。');
    if (declared && !Object.hasOwn(raw, key)) return invalid(`缺少參數 ${key}。`);
    if (declared) return invalid(`參數 ${key} 的值不正確。`);
    return invalid('參數格式不符。');
  }
  return tool.run(parsed.data, { state, provider }, signal);
}
