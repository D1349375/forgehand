import type { AgentTurn } from '../../shared/agent';
import type { PrinterProfile } from '../../shared/printer';
import type { Workspace } from '../../shared/workspace';

/** The workbench state a run starts from. */
export interface RunSnapshot {
  workspace: Workspace;
  tryOn: boolean;
  cameraOn: boolean;
  /** The user's printer tolerances, so the server's joint checks match the browser's. */
  printer?: PrinterProfile;
}

/** Most previous turns sent for context (matches the server's `history` limit). */
export const HISTORY_TURN_LIMIT = 10;

/**
 * The `/api/agent` request body: the whole workspace (objects, active object,
 * selection, explode) plus the try-on flags, the printer profile when given and only the latest turns.
 */
export function buildAgentRequest(instruction: string, snapshot: RunSnapshot, turns: AgentTurn[], requestId: string) {
  return {
    instruction: instruction.trim(),
    requestId,
    workspace: snapshot.workspace,
    tryOn: snapshot.tryOn,
    cameraOn: snapshot.cameraOn,
    history: turns.slice(-HISTORY_TURN_LIMIT),
    ...(snapshot.printer ? { printer: snapshot.printer } : {}),
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
