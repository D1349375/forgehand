import type { AgentTurn } from '../../shared/agent';
import type { DisplayModel } from './types';

/** The workbench state a run starts from. */
export interface RunSnapshot {
  display: DisplayModel | null;
  selectedPartIds: string[];
  explode: number;
  tryOn: boolean;
  cameraOn: boolean;
}

/** Most previous turns sent for context (matches the server's `history` limit). */
export const HISTORY_TURN_LIMIT = 10;

/**
 * The `/api/agent` request body. The model is `null` for an empty scene, the
 * selection is limited to parts that exist in the model, and only the latest
 * turns are sent.
 */
export function buildAgentRequest(instruction: string, snapshot: RunSnapshot, turns: AgentTurn[], requestId: string) {
  const model = snapshot.display?.model ?? null;
  const partIds = new Set(model?.parts.map(part => part.id));
  return {
    instruction: instruction.trim(),
    requestId,
    model,
    selectedPartIds: model ? snapshot.selectedPartIds.filter(id => partIds.has(id)) : [],
    explode: snapshot.explode,
    tryOn: snapshot.tryOn,
    cameraOn: snapshot.cameraOn,
    history: turns.slice(-HISTORY_TURN_LIMIT),
  };
}

/**
 * The message for a response that is not an event stream (a 400 or 429 JSON
 * body from the server). Only a string `error.message` is shown; anything else
 * becomes a fixed Traditional Chinese message.
 */
export function errorMessageFromBody(body: unknown, status: number): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof message === 'string' && message.trim()) return message;
  return status === 429 ? '目前已有多個請求，請稍後重試。' : '代理服務未完成，請重試。';
}
