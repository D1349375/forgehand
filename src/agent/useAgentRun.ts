import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AgentTurn } from '../../shared/agent';
import type { ExportScope } from '../../shared/export-plan';
import type { Lang } from '../../shared/i18n/lang';
import { apiHeaders } from '../i18n/api';
import { applyStateEvent, type StateEffects } from './apply-state';
import { parseAgentEvent } from './events';
import { buildAgentRequest, errorMessageFromBody, type RunSnapshot } from './request';
import { agentRunReducer, initialAgentRunState } from './run-reducer';
import type { SseFrame } from './sse';
import { readAgentStream } from './stream';

/** How the hook reads from and writes to the workbench. Held in a ref, so these can change every render. */
export interface AgentRunOptions {
  /** The language of this run: sent as `Accept-Language` so the agent answers in it (english-ui R19). */
  lang: Lang;
  /** Applies one state event's workspace change: an undo step when `recordUndo`, else a plain replace. */
  applyWorkspace(effects: StateEffects): void;
  setTryingOn(on: boolean): void;
  /** Hides (true) or shows (false) the camera image the agent asked for. The caller decides whether it applies. */
  setCameraHidden?(hidden: boolean): void;
  /** Opens the export dialog with the scope the agent chose. The agent never downloads; the user does. */
  openExport?(scope: ExportScope): void;
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
  /** The instruction of the latest run, whoever started it (the agent panel's form or another control such as 請代理建議). */
  const [lastInstruction, setLastInstruction] = useState('');
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const controllerRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(async (instruction: string) => {
    const text = instruction.trim();
    if (!text || runningRef.current) return;
    runningRef.current = true;
    setLastInstruction(text);
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    const requestId = crypto.randomUUID();
    const snapshot = optionsRef.current.getSnapshot();
    // Manual editing is disabled during a run, so the workspace only changes through this
    // run's own events. Track it here so a second `state` event in the same chunk builds on
    // the first instead of on a React state that has not rendered yet.
    let workspace = snapshot.workspace;
    dispatch({ type: 'start' });

    const handleFrame = (frame: SseFrame) => {
      const event = parseAgentEvent(frame);
      if (!event) return;
      if (event.type === 'state') {
        // An event the workspace rejects is dropped; the run goes on.
        const effects = applyStateEvent(event.payload, workspace);
        if (!effects) return;
        workspace = effects.after;
        optionsRef.current.applyWorkspace(effects);
        if (effects.tryOn !== undefined) optionsRef.current.setTryingOn(effects.tryOn);
        if (effects.cameraHidden !== undefined) optionsRef.current.setCameraHidden?.(effects.cameraHidden);
        if (effects.exportDialog !== undefined) optionsRef.current.openExport?.(effects.exportDialog);
        return;
      }
      if (event.type === 'final') optionsRef.current.pushTurn({ instruction: text, reply: event.reply });
      dispatch({ type: 'event', event });
    };

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders(optionsRef.current.lang) },
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
    instruction: lastInstruction,
    status: state.status,
    log: state.log,
    reply: state.reply,
    error: state.error,
  };
}

export type AgentRun = ReturnType<typeof useAgentRun>;
