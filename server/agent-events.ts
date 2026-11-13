import type { Response } from 'express';
import { serializeSseEvent, type AgentEventName } from '../shared/agent';

/**
 * Server-Sent Events writer for `/api/agent`. Kept separate from `app.ts` so the
 * later realtime-voice feature can reuse it.
 */

/** Starts the event stream. Call only after every request check has passed. */
export function setSseHeaders(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

export interface SseEmitter {
  /** Writes one frame. After the stream is closed, or the client is gone, it does nothing. */
  emit(name: AgentEventName, data: unknown): void;
  /** Ends the response. Safe to call more than once. */
  close(): void;
  readonly closed: boolean;
}

/** Writes `serializeSseEvent` frames to `res` and ends the response after `done`. */
export function createEmitter(res: Response): SseEmitter {
  let closed = false;
  const writable = () => !closed && !res.writableEnded && !res.destroyed && !res.socket?.destroyed;
  const close = () => {
    if (closed) return;
    closed = true;
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  return {
    emit(name, data) {
      if (!writable()) return;
      try { res.write(serializeSseEvent(name, data)); }
      catch { close(); return; }
      if (name === 'done') close();
    },
    close,
    get closed() { return closed || res.writableEnded || res.destroyed; },
  };
}
