import type { ToolErrorDetail, ToolResult } from '../../shared/agent';
import { GenerationError, type ModelProvider } from '../provider';

/** Result helpers shared by every tool. `server/agent-tools.ts` re-exports them. */

export const NO_MODEL_MESSAGE = '目前沒有模型，請先生成設計。';

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

/** The agent loop requires `run`; surface a missing one as a provider error that ends the run. */
export function requireRun(provider: ModelProvider) {
  if (!provider.run) throw new GenerationError('SERVICE_ERROR', '模型服務暫時無法完成，請稍後重試。');
  return provider.run;
}
