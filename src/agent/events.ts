import {
  ErrorEventSchema, FinalEventSchema, StatusEventSchema, LegacyToolEventSchema, LegacyToolResultSchema,
  type LegacyToolResult,
} from '../../shared/agent';
import type { SseFrame } from './sse';

/**
 * A parsed `/api/agent` event. `tool` keeps only the tool name: the raw
 * `argsJson` is model-facing and is deliberately dropped before the UI sees it.
 * `state` keeps its payload unvalidated; `applyStateEvent` validates it.
 */
export type AgentEvent =
  | { type: 'status'; note: string | null }
  | { type: 'tool'; tool: string }
  | { type: 'result'; result: LegacyToolResult }
  | { type: 'state'; payload: unknown }
  | { type: 'final'; reply: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Returns null for an unknown event name, unreadable JSON, or a payload that fails its schema. */
export function parseAgentEvent(frame: SseFrame): AgentEvent | null {
  let payload: unknown;
  try { payload = JSON.parse(frame.data); }
  catch { return null; }

  switch (frame.event) {
    case 'status': {
      const parsed = StatusEventSchema.safeParse(payload);
      return parsed.success ? { type: 'status', note: parsed.data.note } : null;
    }
    case 'tool': {
      const parsed = LegacyToolEventSchema.safeParse(payload);
      return parsed.success ? { type: 'tool', tool: parsed.data.tool } : null;
    }
    case 'result': {
      const parsed = LegacyToolResultSchema.safeParse(payload);
      return parsed.success ? { type: 'result', result: parsed.data } : null;
    }
    case 'state':
      return { type: 'state', payload };
    case 'final': {
      const parsed = FinalEventSchema.safeParse(payload);
      return parsed.success ? { type: 'final', reply: parsed.data.reply } : null;
    }
    case 'error': {
      const parsed = ErrorEventSchema.safeParse(payload);
      return parsed.success ? { type: 'error', message: parsed.data.message } : null;
    }
    case 'done':
      return { type: 'done' };
    default:
      return null;
  }
}
