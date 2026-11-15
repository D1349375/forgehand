import type { AgentEvent } from './events';
import { UNKNOWN_TOOL_LABEL } from '../../shared/agent';
import { resultText } from './labels';

/** One line of the progress log. `label` is a friendly tool name; `text` is user-facing. */
export interface LogEntry {
  id: number;
  kind: 'status' | 'tool' | 'result';
  label: string | null;
  text: string;
  /** Only for `result`. */
  ok: boolean | null;
}

export type AgentRunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface AgentRunState {
  status: AgentRunStatus;
  log: LogEntry[];
  reply: string | null;
  error: string | null;
}

export type AgentRunAction =
  | { type: 'start' }
  | { type: 'event'; event: AgentEvent }
  /** The run failed outside the event stream: HTTP error, lost connection, stream ended without `done`. */
  | { type: 'fail'; message: string }
  | { type: 'cancel' };

export const initialAgentRunState: AgentRunState = { status: 'idle', log: [], reply: null, error: null };

const append = (state: AgentRunState, entry: Omit<LogEntry, 'id'>): AgentRunState =>
  ({ ...state, log: [...state.log, { ...entry, id: state.log.length }] });

/**
 * All run logic as a pure function. Anything that arrives after the run has
 * ended (done, error, cancelled) is ignored, so a late frame cannot change what
 * the user already sees. `state` events change no UI state here: the hook
 * applies them to the workbench through `applyStateEvent`.
 */
export function agentRunReducer(state: AgentRunState, action: AgentRunAction): AgentRunState {
  if (action.type === 'start') return { status: 'running', log: [], reply: null, error: null };
  if (state.status !== 'running') return state;

  switch (action.type) {
    case 'cancel':
      return { ...state, status: 'cancelled' };
    case 'fail':
      return { ...state, status: 'error', error: action.message };
    case 'event':
      return reduceEvent(state, action.event);
  }
}

const labelOfLatestTool = (state: AgentRunState): string =>
  [...state.log].reverse().find(entry => entry.kind === 'tool')?.label ?? UNKNOWN_TOOL_LABEL;

function reduceEvent(state: AgentRunState, event: AgentEvent): AgentRunState {
  switch (event.type) {
    case 'status':
      return event.note === null ? state : append(state, { kind: 'status', label: null, text: event.note, ok: null });
    case 'tool':
      return append(state, { kind: 'tool', label: event.label, text: '進行中', ok: null });
    case 'result':
      // The loop emits a tool's `result` right after its `tool` event, so the latest tool entry is its own.
      return append(state, { kind: 'result', label: labelOfLatestTool(state), text: resultText(event.result), ok: event.result.ok });
    case 'state':
      return state;
    case 'final':
      return { ...state, reply: event.reply };
    case 'error':
      return { ...state, status: 'error', error: event.message };
    case 'done':
      return { ...state, status: 'done' };
  }
}
