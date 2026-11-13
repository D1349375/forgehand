import type { Response } from 'express';
import type http from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../../server/app';
import { createEmitter } from '../../server/agent-events';
import { GenerationError, type ModelProvider, type ModelTask } from '../../server/provider';
import { demoModel } from '../../shared/demo';

/**
 * Task 5: POST /api/agent over HTTP with a fake provider. The fake's `run` calls
 * `task.parse` like the real adapters, and no test reaches a real back end.
 */

type Behaviour = (task: ModelTask<unknown>, signal: AbortSignal) => Promise<unknown>;

function agentProvider(behaviour: Behaviour): ModelProvider {
  return {
    name: 'openai', configured: true, model: 'test-double',
    generate: async () => { throw new Error('the agent must use run(), not generate()'); },
    run: async (task: ModelTask<unknown>, signal: AbortSignal) => {
      const raw = await behaviour(task, signal);
      try { return task.parse(raw); }
      catch { throw new GenerationError('INVALID_MODEL', '模型資料未通過驗證。'); }
    },
  } as unknown as ModelProvider;
}

const finalStep = (reply: string) => ({ type: 'final', note: null, reply, calls: null });
const callStep = (tool: string, args: Record<string, unknown>) =>
  ({ type: 'tool_calls', note: '處理中', reply: null, calls: [{ tool, argsJson: JSON.stringify(args), reason: null }] });

const blueBattery = () => ({ ...structuredClone(demoModel.parts.find(part => part.id === 'battery')!), color: '#2563eb' });
const editPlan = () => ({
  status: 'applied', explanation: '把側邊電池改成藍色。', name: null, summary: null, assumptions: null,
  operations: [{ op: 'upsert', partId: 'battery', part: blueBattery() }],
});
const newDesign = () => ({ status: 'ready', explanation: '測試模型。', model: { ...structuredClone(demoModel), name: '全新的測試模型' } });

/** Answers agent rounds from a queue and the design/edit sub-tasks with fixed data. */
function scripted(steps: unknown[]): Behaviour {
  const queue = [...steps];
  return async (task) => {
    if (task.kind === 'design') return newDesign();
    if (task.kind === 'edit') return editPlan();
    if (!queue.length) throw new Error('script exhausted');
    return queue.shift();
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  instruction: '請處理', requestId: 'run-1', model: structuredClone(demoModel), selectedPartIds: [],
  explode: 0, tryOn: false, cameraOn: false, history: [], ...over,
});

interface Frame { event: string; data: any }
function frames(text: string): Frame[] {
  return text.split('\n\n').filter(Boolean).map(block => {
    const event = /^event: (.*)$/m.exec(block)![1]!;
    const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]!);
    return { event, data };
  });
}
const names = (list: Frame[]) => list.map(frame => frame.event);

const servers: http.Server[] = [];
function serve(provider: ModelProvider, options: AppOptions = {}) {
  const server = createApp({ provider, ...options }).listen(0, '127.0.0.1');
  servers.push(server);
  return server;
}
afterEach(() => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); }
});

const noop = () => {};
/** A model call that never answers and rejects when aborted, like a stopped CLI process. */
const hangUntilAborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});
const isHold = (task: ModelTask<unknown>) => task.input.includes('使用者指示：hold');

describe('POST /api/agent', () => {
  it('streams status, tool, result, state, final and done in order', async () => {
    const server = serve(agentProvider(scripted([callStep('edit_design', { instruction: '電池改藍色' }), finalStep('已改成藍色。')])));
    const response = await request(server).post('/api/agent').send(body({ selectedPartIds: ['battery'] }));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');

    const list = frames(response.text);
    expect(names(list)).toEqual(['status', 'tool', 'result', 'state', 'final', 'done']);
    expect(list[0]!.data).toEqual({ note: '處理中' });
    expect(list[1]!.data).toEqual({ tool: 'edit_design', argsJson: '{"instruction":"電池改藍色"}' });
    // The result frame is compact: no model payload.
    expect(list[2]!.data).toMatchObject({ tool: 'edit_design', ok: true });
    expect(list[2]!.data.stateChange.model).toBeNull();
    expect(list[2]!.data.stateChange.selection).toEqual(['battery']);
    // The state frame carries the model change.
    expect(list[3]!.data.model.kind).toBe('edited');
    expect(list[3]!.data.model.source).toBe('openai');
    expect(list[3]!.data.model.model.parts.find((part: { id: string }) => part.id === 'battery').color).toBe('#2563eb');
    expect(list[4]!.data).toEqual({ reply: '已改成藍色。' });
    expect(list[5]).toEqual({ event: 'done', data: {} });
    // The full model is sent exactly once.
    expect(response.text.split('"schemaVersion"')).toHaveLength(2);
  });

  it('accepts model: null and produces a generated state event from generate_design', async () => {
    const server = serve(agentProvider(scripted([callStep('generate_design', { prompt: '一個新裝置' }), finalStep('完成。')])));
    const response = await request(server).post('/api/agent').send(body({ model: null }));

    expect(response.status).toBe(200);
    const list = frames(response.text);
    expect(names(list)).toEqual(['status', 'tool', 'result', 'state', 'final', 'done']);
    expect(list[3]!.data.model.kind).toBe('generated');
    expect(list[3]!.data.model.model.name).toBe('全新的測試模型');
    expect(list[2]!.data.stateChange.model).toBeNull();
  });

  it('does not apply MODEL_TIMEOUT_MS (timeoutMs) to the whole run', async () => {
    const server = serve(agentProvider(async (task) => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return task.kind === 'agent' ? finalStep('慢但完成。') : null;
    }), { timeoutMs: 20 });
    const response = await request(server).post('/api/agent').send(body());
    expect(names(frames(response.text))).toEqual(['final', 'done']);
  });

  describe('request checks happen before any event-stream header', () => {
    const cases: Array<[string, Record<string, unknown>, number, string]> = [
      ['an empty body', {}, 400, 'INVALID_REQUEST'],
      ['an unknown field', { ...body(), extra: true }, 400, 'INVALID_REQUEST'],
      ['a missing instruction', { ...body(), instruction: '  ' }, 400, 'INVALID_REQUEST'],
      ['a bad request id', body({ requestId: 'bad id' }), 400, 'INVALID_REQUEST'],
    ];
    it.each(cases)('rejects %s with %i %s', async (_label, payload, status, code) => {
      let called = 0;
      const server = serve(agentProvider(async () => { called++; return finalStep('x'); }));
      const response = await request(server).post('/api/agent').send(payload);
      expect(response.status).toBe(status);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body.error.code).toBe(code);
      expect(called).toBe(0);
    });

    it('rejects a body without the model key as INVALID_REQUEST', async () => {
      const { model: _omitted, ...withoutModel } = body();
      const response = await request(serve(agentProvider(scripted([])))).post('/api/agent').send(withoutModel);
      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body.error.code).toBe('INVALID_REQUEST');
    });

    it('rejects an invalid model as INVALID_MODEL with the request id and a fixed message', async () => {
      const response = await request(serve(agentProvider(scripted([])))).post('/api/agent').send(body({ model: { bad: true } }));
      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body).toEqual({ error: { code: 'INVALID_MODEL', message: '目前模型資料無效，無法處理這次請求。' }, requestId: 'run-1' });
    });

    it.each([
      ['a part that is not in the model', { selectedPartIds: ['missing-part'] }],
      ['a selection with no model', { model: null, selectedPartIds: ['housing'] }],
    ])('rejects %s as INVALID_SELECTION without echoing the id', async (_label, over) => {
      const response = await request(serve(agentProvider(scripted([])))).post('/api/agent').send(body(over));
      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body.error.code).toBe('INVALID_SELECTION');
      expect(response.body.requestId).toBe('run-1');
      expect(JSON.stringify(response.body)).not.toContain('missing-part');
    });

    it('rejects a non-loopback origin with 403 JSON', async () => {
      const response = await request(serve(agentProvider(scripted([])))).post('/api/agent')
        .set('Origin', 'https://evil.example').send(body());
      expect(response.status).toBe(403);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body.error.code).toBe('ORIGIN_REJECTED');
    });

    it('rejects a body over 128 kB with 413 JSON', async () => {
      const response = await request(serve(agentProvider(scripted([])))).post('/api/agent')
        .send(body({ instruction: 'x'.repeat(200_000) }));
      expect(response.status).toBe(413);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body.error.code).toBe('REQUEST_TOO_LARGE');
    });
  });

  describe('concurrency and cancellation', () => {
    /** A provider that holds any run whose instruction is "hold" until it is aborted. */
    function holdingProvider() {
      const state = { entered: 0, signals: [] as AbortSignal[] };
      const provider = agentProvider(async (task, signal) => {
        if (!isHold(task)) return finalStep('完成。');
        state.entered++;
        state.signals.push(signal);
        return hangUntilAborted(signal);
      });
      return { provider, state };
    }
    const startHeld = (server: http.Server, id: string) => {
      const held = request(server).post('/api/agent').send(body({ instruction: 'hold', requestId: id }));
      held.then(noop, noop); // sends the request
      return held;
    };

    it('answers 429 BUSY as plain JSON when three runs are active', async () => {
      const { provider, state } = holdingProvider();
      const server = serve(provider);
      ['a', 'b', 'c'].forEach(id => startHeld(server, id));
      await vi.waitFor(() => expect(state.entered).toBe(3));

      const busy = await request(server).post('/api/agent').send(body({ requestId: 'fourth' }));
      expect(busy.status).toBe(429);
      expect(busy.headers['content-type']).toMatch(/^application\/json/);
      expect(busy.body).toMatchObject({ error: { code: 'BUSY' }, requestId: 'fourth' });
    });

    it('aborts the provider when the client disconnects and releases the active slot', async () => {
      const { provider, state } = holdingProvider();
      const server = serve(provider);
      const held = ['a', 'b', 'c'].map(id => startHeld(server, id));
      await vi.waitFor(() => expect(state.entered).toBe(3));
      expect((await request(server).post('/api/agent').send(body({ requestId: 'fourth' }))).status).toBe(429);

      held[0]!.abort();
      await vi.waitFor(() => expect(state.signals[0]!.aborted).toBe(true));
      expect(state.signals[1]!.aborted).toBe(false);

      // A new run is accepted once the aborted run has settled.
      await vi.waitFor(async () => {
        const next = await request(server).post('/api/agent').send(body({ requestId: 'after-abort' }));
        expect(next.status).toBe(200);
        expect(names(frames(next.text))).toEqual(['final', 'done']);
      }, { timeout: 5000, interval: 50 });
    });
  });

  describe('failures after streaming has started', () => {
    it('turns a provider GenerationError into a sanitized error event, then done', async () => {
      let round = 0;
      const server = serve(agentProvider(async () => {
        if (round++ === 0) return callStep('get_project_state', {});
        throw new GenerationError('SERVICE_ERROR', '模型服務暫時無法完成，請稍後重試。');
      }));
      const response = await request(server).post('/api/agent').send(body());

      expect(response.status).toBe(200);
      const list = frames(response.text);
      expect(names(list)).toEqual(['status', 'tool', 'result', 'error', 'done']);
      expect(list[3]!.data).toEqual({ message: '模型服務暫時無法完成，請稍後重試。' });
    });

    it('does not leak text from an unexpected provider error', async () => {
      const server = serve(agentProvider(async () => { throw new Error('sk-secret-do-not-leak: upstream said no'); }));
      const response = await request(server).post('/api/agent').send(body());

      const list = frames(response.text);
      expect(names(list)).toEqual(['error', 'done']);
      expect(response.text).not.toContain('sk-secret');
      expect(response.text).not.toContain('upstream');
      // runAgent retries a non-GenerationError once, then reports a fixed message.
      expect(list[0]!.data.message).toBe('模型回應格式無效，請稍後重試。');
    });

    it('ends with a timeout error then done when the total-run time limit passes', async () => {
      const server = serve(agentProvider((_task, signal) => hangUntilAborted(signal)), { agentTotalTimeoutMs: 50 });
      const response = await request(server).post('/api/agent').send(body());

      const list = frames(response.text);
      expect(names(list)).toEqual(['error', 'done']);
      expect(list[0]!.data.message).toContain('逾時');
    });

    it('holds the active slot until a provider that was told to stop has actually stopped', async () => {
      const releases: Array<() => void> = [];
      const server = serve(agentProvider((_task, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { releases.push(() => reject(new GenerationError('CANCELLED', '已取消', 499))); });
      })), { agentTotalTimeoutMs: 50, terminationGraceMs: 10_000 });
      const runs = ['a', 'b', 'c'].map(id => request(server).post('/api/agent').send(body({ requestId: id })).then(response => response));
      await vi.waitFor(() => expect(releases).toHaveLength(3));

      const busy = await request(server).post('/api/agent').send(body({ requestId: 'fourth' }));
      expect(busy.status).toBe(429);

      releases.forEach(release => release());
      for (const response of await Promise.all(runs)) {
        expect(names(frames(response.text))).toEqual(['error', 'done']);
        expect(frames(response.text)[0]!.data.message).toContain('逾時');
      }
    });

    it('ends the stream and releases the slot when a provider ignores cancellation', async () => {
      const server = serve(agentProvider(async (task) => {
        if (isHold(task)) return new Promise(() => {}); // never settles, ignores the signal
        return finalStep('完成。');
      }), { agentTotalTimeoutMs: 30, terminationGraceMs: 50 });
      const runs = ['a', 'b', 'c'].map(id => request(server).post('/api/agent').send(body({ instruction: 'hold', requestId: id })).then(response => response));
      for (const response of await Promise.all(runs)) {
        const list = frames(response.text);
        expect(names(list)).toEqual(['error', 'done']);
        expect(list[0]!.data.message).toContain('逾時');
      }
      const next = await request(server).post('/api/agent').send(body({ requestId: 'after' }));
      expect(next.status).toBe(200);
      expect(names(frames(next.text))).toEqual(['final', 'done']);
    });
  });
});

describe('createEmitter', () => {
  function stubResponse() {
    const writes: string[] = [];
    const res = {
      writableEnded: false, destroyed: false, socket: { destroyed: false },
      write: vi.fn((chunk: string) => { writes.push(chunk); return true; }),
      end: vi.fn(() => { res.writableEnded = true; }),
    };
    return { res, writes, response: res as unknown as Response };
  }

  it('writes SSE frames and ends the response after done', () => {
    const { res, writes, response } = stubResponse();
    const stream = createEmitter(response);
    stream.emit('status', { note: '處理中' });
    stream.emit('done', {});
    expect(writes).toEqual(['event: status\ndata: {"note":"處理中"}\n\n', 'event: done\ndata: {}\n\n']);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(stream.closed).toBe(true);
  });

  it('writes nothing after done, after close, or once the response has ended', () => {
    const { res, writes, response } = stubResponse();
    const stream = createEmitter(response);
    stream.emit('done', {});
    stream.emit('status', { note: '太晚了' });
    stream.close();
    expect(writes).toHaveLength(1);
    expect(res.end).toHaveBeenCalledTimes(1);

    const ended = stubResponse();
    ended.res.writableEnded = true;
    createEmitter(ended.response).emit('status', { note: 'x' });
    expect(ended.writes).toHaveLength(0);
  });

  it('writes nothing and does not end the response when the client is gone', () => {
    const gone = stubResponse();
    gone.res.socket.destroyed = true;
    const stream = createEmitter(gone.response);
    stream.emit('final', { reply: 'x' });
    expect(gone.writes).toHaveLength(0);

    const destroyed = stubResponse();
    destroyed.res.destroyed = true;
    const second = createEmitter(destroyed.response);
    second.emit('final', { reply: 'x' });
    second.close();
    expect(destroyed.writes).toHaveLength(0);
    expect(destroyed.res.end).not.toHaveBeenCalled();
  });

  it('stops writing if a write throws', () => {
    const { res, response } = stubResponse();
    res.write.mockImplementationOnce(() => { throw new Error('socket closed'); });
    const stream = createEmitter(response);
    expect(() => stream.emit('status', { note: 'x' })).not.toThrow();
    stream.emit('status', { note: 'y' });
    expect(res.write).toHaveBeenCalledTimes(1);
  });
});
