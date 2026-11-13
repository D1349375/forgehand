import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { AgentTurn } from '../../shared/agent';
import { applyStateEvent } from './apply-state';
import { parseAgentEvent } from './events';
import { buildAgentRequest, errorMessageFromBody, type RunSnapshot } from './request';
import { agentRunReducer, initialAgentRunState } from './run-reducer';
import type { SseFrame } from './sse';
import { readAgentStream } from './stream';
import type { DisplayModel } from './types';

/** How the hook reads from and writes to the workbench. Held in a ref, so these can change every render. */
export interface AgentRunOptions {
  commit(next: DisplayModel): void;
  setSelected(ids: string[]): void;
  setExplode(amount: number): void;
  setTryingOn(on: boolean): void;
  /** The workbench state to start a run from. */
  getSnapshot(): RunSnapshot;
  getTurns(): AgentTurn[];
  pushTurn(turn: AgentTurn): void;
}

const CONNECTION_LOST = '連線在代理完成前中斷。已套用的變更會保留，可用「復原」還原。';

/**
 * Runs one agent request at a time. All run logic is in `agentRunReducer`; this
 * hook only does I/O: POST `/api/agent`, read the event stream, and hand `state`
 * events to the workbench callbacks.
 */
export function useAgentRun(options: AgentRunOptions) {
  const [state, dispatch] = useReducer(agentRunReducer, initialAgentRunState);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const controllerRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(async (instruction: string) => {
    const text = instruction.trim();
    if (!text || runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    const requestId = crypto.randomUUID();
    const snapshot = optionsRef.current.getSnapshot();
    // Manual editing is disabled during a run, so the display only changes through this
    // run's own commits. Track it here so a second `state` event in the same chunk
    // builds on the first instead of on a React state that has not rendered yet.
    let display = snapshot.display;
    dispatch({ type: 'start' });

    const handleFrame = (frame: SseFrame) => {
      const event = parseAgentEvent(frame);
      if (!event) return;
      if (event.type === 'state') {
        const effects = applyStateEvent(event.payload, display, { requestId, now: performance.now(), newLineage: crypto.randomUUID() });
        const { commit, setSelected, setExplode, setTryingOn } = optionsRef.current;
        // Commit first: a new lineage resets selection and explode, which the event may then set.
        if (effects.commitArg) { commit(effects.commitArg); display = effects.commitArg; }
        if (effects.selection) setSelected(effects.selection);
        if (effects.explode !== undefined) setExplode(effects.explode);
        if (effects.tryOn !== undefined) setTryingOn(effects.tryOn);
        return;
      }
      if (event.type === 'final') optionsRef.current.pushTurn({ instruction: text, reply: event.reply });
      dispatch({ type: 'event', event });
    };

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAgentRequest(text, snapshot, optionsRef.current.getTurns(), requestId)),
        signal,
      });
      if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith('text/event-stream') || !response.body) {
        // 400 and 429 arrive as JSON before any stream starts.
        const body: unknown = await response.json().catch(() => null);
        if (signal.aborted) return;
        dispatch({ type: 'fail', message: errorMessageFromBody(body, response.status) });
        return;
      }

      const { sawDone } = await readAgentStream(response.body, signal, handleFrame);
      if (signal.aborted) return; // cancelled while reading: the reducer already says so
      if (!sawDone) dispatch({ type: 'fail', message: CONNECTION_LOST });
    } catch (cause) {
      if (signal.aborted) return; // cancel() already moved the reducer to 'cancelled'
      dispatch({
        type: 'fail',
        message: cause instanceof TypeError
          ? '無法連線到本機模型服務，請確認工作台仍在執行後重試。'
          : '代理執行失敗，請重試。',
      });
    } finally {
      // After cancel() a newer run may own these; only the current run releases them.
      if (controllerRef.current === controller) { controllerRef.current = null; runningRef.current = false; }
    }
  }, []);

  const cancel = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controllerRef.current = null;
    runningRef.current = false; // a new run may start right away
    controller.abort();
    dispatch({ type: 'cancel' });
  }, []);

  return {
    run,
    cancel,
    active: state.status === 'running',
    status: state.status,
    log: state.log,
    reply: state.reply,
    error: state.error,
  };
}

export type AgentRun = ReturnType<typeof useAgentRun>;
