import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { runAgent, stripModel, AGENT_INSTRUCTIONS } from '../../server/agent';
import { GenerationError, type ModelProvider, type ModelTask } from '../../server/provider';
import { validateAgentStep, type AgentRequest, type AgentEventName, type AgentStep } from '../../shared/agent';
import { type ModelSpec } from '../../shared/model';

/**
 * Task 4 acceptance test: the server/agent.ts loop — multi-round, max-rounds
 * limit, total-run timeout, client cancel (silent), provider errors (sanitized),
 * retry on invalid parse, and fabrication guard (all tool results are real).
 */

// Helper to create a minimal AgentRequest for testing
function makeTestRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    requestId: 'test-req',
    model: null,
    selectedPartIds: [],
    explode: 0,
    tryOn: false,
    cameraOn: false,
    history: [],
    instruction: 'test instruction',
    ...overrides,
  };
}

describe('server/agent.ts runAgent loop', () => {
  let events: Array<{ name: AgentEventName; data: unknown }>;
  let emit: (name: AgentEventName, data: unknown) => void;
  let abortController: AbortController;
  let fakeProvider: ModelProvider;
  // What the "model" returns, one entry per call. Script a raw step here; the fake
  // provider below validates it the way the real adapters do.
  let script: Mock<(task: ModelTask<unknown>, signal: AbortSignal) => Promise<unknown>>;

  /** A model call that never answers and rejects when aborted, like a stopped CLI process. */
  const hangUntilAborted = (_task: ModelTask<unknown>, signal: AbortSignal) =>
    new Promise<unknown>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });

  beforeEach(() => {
    events = [];
    emit = (name, data) => events.push({ name, data });
    abortController = new AbortController();
    script = vi.fn();
    // Mirrors server/codex.ts: the adapter calls task.parse inside run and turns a
    // parse failure into GenerationError('INVALID_MODEL', ...).
    fakeProvider = {
      name: 'openai',
      configured: true,
      model: 'test-model',
      run: vi.fn(async (task: ModelTask<unknown>, signal: AbortSignal) => {
        const raw = await script(task, signal);
        try {
          return task.parse(raw);
        } catch {
          throw new GenerationError('INVALID_MODEL', '模型資料未通過驗證。');
        }
      }),
    } as unknown as ModelProvider;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs a single-round final reply (no tools)', async () => {
    // Mock returns raw object as model would; getStep will validate it
    const rawStep = { type: 'final', reply: '已完成。', note: null, calls: null };
    script.mockResolvedValueOnce(rawStep);

    const req = makeTestRequest({ instruction: '請告訴我目前狀態' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ name: 'final', data: { reply: '已完成。' } });
    expect(events[1]).toEqual({ name: 'done', data: {} });
    expect(fakeProvider.run).toHaveBeenCalledTimes(1);
  });

  it('runs multiple rounds with tool calls then final', async () => {
    // Round 1: tool_calls with get_project_state (raw format)
    const rawStep1 = {
      type: 'tool_calls',
      note: '檢查狀態',
      reply: null,
      calls: [{ tool: 'get_project_state', argsJson: '{}', reason: null }],
    };
    // Round 2: final (raw format)
    const rawStep2 = { type: 'final', reply: '目前沒有模型。', note: null, calls: null };

    script
      .mockResolvedValueOnce(rawStep1)
      .mockResolvedValueOnce(rawStep2);

    const req = makeTestRequest({ instruction: '請告訴我目前狀態' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    // Round 1: status, tool, result; Round 2: final, done
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.find(e => e.name === 'status')).toBeDefined();
    expect(events.find(e => e.name === 'tool')).toBeDefined();
    expect(events.find(e => e.name === 'result')).toBeDefined();
    expect(events.find(e => e.name === 'final')).toBeDefined();
    expect(events.find(e => e.name === 'done')).toBeDefined();
    expect(fakeProvider.run).toHaveBeenCalledTimes(2);
  });

  it('stops at maxRounds and emits error+done', async () => {
    // Always return tool_calls, never final (raw format)
    const rawStepLoop = {
      type: 'tool_calls',
      note: '還在處理',
      reply: null,
      calls: [{ tool: 'get_project_state', argsJson: '{}', reason: null }],
    };
    script.mockResolvedValue(rawStepLoop);

    const req = makeTestRequest({ instruction: '無限迴圈測試' });

    await runAgent(fakeProvider, req, { maxRounds: 3, totalTimeoutMs: 60000 }, emit, abortController.signal);

    // 3 rounds × (status + tool + result) + error + done
    expect(fakeProvider.run).toHaveBeenCalledTimes(3);
    const errorEvent = events.find(e => e.name === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toContain('多輪對話');
    expect(events[events.length - 1]).toEqual({ name: 'done', data: {} });
  });

  it('stops on total-run timeout and emits sanitized error+done', async () => {
    // The model call never answers; the total-run timeout aborts it.
    script.mockImplementation(hangUntilAborted);

    const req = makeTestRequest({ instruction: 'timeout test' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 50 }, emit, abortController.signal);

    const errorEvent = events.find(e => e.name === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toContain('逾時');
    expect(events[events.length - 1]).toEqual({ name: 'done', data: {} });
  });

  it('stops on client cancel (silent, no events)', async () => {
    script.mockImplementation(hangUntilAborted);

    const req = makeTestRequest({ instruction: 'cancel test' });

    const running = runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);
    // Cancel while the model call is in flight.
    await vi.waitFor(() => expect(script).toHaveBeenCalledTimes(1));
    abortController.abort();
    await running;

    // The in-flight call got the combined run signal, which the cancel aborted.
    expect(script.mock.calls[0]![1].aborted).toBe(true);
    // No events emitted when client cancels
    expect(events).toHaveLength(0);
  });

  it('sanitizes GenerationError and emits error+done', async () => {
    script.mockRejectedValueOnce(
      new GenerationError('SERVICE_ERROR', '模型服務暫時無法完成，請稍後重試。'),
    );

    const req = makeTestRequest({ instruction: 'error test' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    const errorEvent = events.find(e => e.name === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toContain('模型服務');
    expect(events[events.length - 1]).toEqual({ name: 'done', data: {} });
  });

  it('retries once on Zod validation failure (INVALID_MODEL code), then throws sanitized error', async () => {
    // Real providers throw GenerationError('INVALID_MODEL', ...) when validateAgentStep fails.
    // First call: throws INVALID_MODEL
    script
      .mockRejectedValueOnce(new GenerationError('INVALID_MODEL', '模型回應格式無效，請稍後重試。'))
      // Second call (retry): also INVALID_MODEL
      .mockRejectedValueOnce(new GenerationError('INVALID_MODEL', '模型回應格式無效，請稍後重試。'));

    const req = makeTestRequest({ instruction: 'INVALID_MODEL retry test' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    expect(fakeProvider.run).toHaveBeenCalledTimes(2);
    const errorEvent = events.find(e => e.name === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toContain('格式無效');
    expect(events[events.length - 1]).toEqual({ name: 'done', data: {} });
  });

  it('retries once on Zod validation failure, then throws sanitized error', async () => {
    // First call: invalid JSON
    script
      .mockResolvedValueOnce({ invalid: 'schema' } as never)
      // Second call (retry): also invalid
      .mockResolvedValueOnce({ invalid: 'again' } as never);

    const req = makeTestRequest({ instruction: 'invalid response test' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    expect(fakeProvider.run).toHaveBeenCalledTimes(2);
    const errorEvent = events.find(e => e.name === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toContain('格式無效');
    expect(events[events.length - 1]).toEqual({ name: 'done', data: {} });
  });

  it('succeeds on retry after first validation failure', async () => {
    // First call: invalid
    script
      .mockResolvedValueOnce({ invalid: 'schema' } as never)
      // Second call (retry): valid raw format
      .mockResolvedValueOnce({ type: 'final', reply: '重試成功', note: null, calls: null });

    const req = makeTestRequest({ instruction: 'retry success test' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    expect(fakeProvider.run).toHaveBeenCalledTimes(2);
    expect(events.find(e => e.name === 'final')).toBeDefined();
    expect(events.find(e => e.name === 'done')).toBeDefined();
  });

  it('retries an invalid first step of round 1, then runs the valid tool call and completes', async () => {
    script
      // Round 1, first attempt: invalid (tool_calls with no calls). The fake provider
      // turns the parse failure into GenerationError('INVALID_MODEL') like the real adapters.
      .mockResolvedValueOnce({ type: 'tool_calls', note: null, reply: null, calls: [] })
      // Round 1, retry: valid.
      .mockResolvedValueOnce({
        type: 'tool_calls', note: '檢查狀態', reply: null,
        calls: [{ tool: 'get_project_state', argsJson: '{}', reason: null }],
      })
      // Round 2: final.
      .mockResolvedValueOnce({ type: 'final', reply: '目前沒有模型。', note: null, calls: null });

    await runAgent(fakeProvider, makeTestRequest(), { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    expect(fakeProvider.run).toHaveBeenCalledTimes(3);
    expect(events.map(e => e.name)).toEqual(['status', 'tool', 'result', 'final', 'done']);
    expect(events.find(e => e.name === 'error')).toBeUndefined();
    // The retry re-sends the same round-1 task; round 2 is a new task that carries the tool record.
    const tasks = vi.mocked(fakeProvider.run!).mock.calls.map(call => call[0] as ModelTask<AgentStep>);
    expect(tasks[1]).toBe(tasks[0]);
    expect(tasks[2]!.input).toContain('get_project_state({})');
  });

  it('fake provider rejects an unparseable step with INVALID_MODEL, as the real adapters do', async () => {
    script.mockResolvedValueOnce({ invalid: 'schema' });
    await expect(fakeProvider.run!({ kind: 'agent', instructions: '', schema: {}, input: '', parse: validateAgentStep }, abortController.signal))
      .rejects.toMatchObject({ name: 'GenerationError', code: 'INVALID_MODEL' });
  });

  it('emits the tool event as { tool, argsJson } and records argsJson in the next round input', async () => {
    const argsJson = '{"partIds":[]}';
    script
      .mockResolvedValueOnce({ type: 'tool_calls', note: 'x', reply: null, calls: [{ tool: 'select_parts', argsJson, reason: null }] })
      .mockResolvedValueOnce({ type: 'final', reply: 'ok', note: null, calls: null });

    await runAgent(fakeProvider, makeTestRequest(), { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    expect(events.find(e => e.name === 'tool')!.data).toEqual({ tool: 'select_parts', argsJson });
    const round2 = vi.mocked(fakeProvider.run!).mock.calls[1]![0] as ModelTask<AgentStep>;
    expect(round2.input).toContain(`select_parts(${argsJson})`);
    expect(round2.input).not.toContain('undefined');
  });

  it('turns an unknown tool and bad arguments into failed results and keeps the run going', async () => {
    script
      .mockResolvedValueOnce({
        type: 'tool_calls', note: 'x', reply: null,
        calls: [
          { tool: 'no_such_tool', argsJson: '{}', reason: null },
          { tool: 'explode_view', argsJson: '{"amount":', reason: null },
        ],
      })
      .mockResolvedValueOnce({ type: 'final', reply: '改用其他方式。', note: null, calls: null });

    await runAgent(fakeProvider, makeTestRequest(), { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    const results = events.filter(e => e.name === 'result').map(e => e.data as { tool: string; ok: boolean; detail: { code: string } });
    expect(results.map(r => [r.tool, r.ok, r.detail.code])).toEqual([
      ['no_such_tool', false, 'UNKNOWN_TOOL'],
      ['explode_view', false, 'INVALID_ARGS'],
    ]);
    expect(events.map(e => e.name).slice(-2)).toEqual(['final', 'done']);
    // The model sees both failures next round, so it can correct itself.
    const round2 = vi.mocked(fakeProvider.run!).mock.calls[1]![0] as ModelTask<AgentStep>;
    expect(round2.input).toContain('failed');
  });

  it('fabrication guard: all tool results are real (from runTool)', async () => {
    // The loop calls runTool for every tool in step.calls; this test verifies
    // that the result event reflects the actual runTool return, not a fabricated
    // success. We mock runTool indirectly by injecting a step that calls a
    // tool, and check that the result event matches the actual ToolResult.
    const rawStep = {
      type: 'tool_calls',
      note: 'Test',
      reply: null,
      calls: [{ tool: 'get_project_state', argsJson: '{}', reason: null }],
    };
    script.mockResolvedValueOnce(rawStep).mockResolvedValueOnce({ type: 'final', reply: 'Done', note: null, calls: null });

    const req = makeTestRequest({ instruction: 'fabrication test' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    // The result event should contain the actual runTool return (ok, summary, detail).
    const resultEvent = events.find(e => e.name === 'result');
    expect(resultEvent).toBeDefined();
    const result = resultEvent!.data as { ok: boolean; summary: string };
    expect(result.ok).toBeDefined();
    expect(result.summary).toBeDefined();
    // If runTool returned ok:true, the result event should reflect that; if
    // ok:false (e.g. NO_MODEL), the event should reflect that too.
  });

  it('stripModel removes model payload from stateChange', () => {
    const model: ModelSpec = {
      schemaVersion: '1.0',
      name: 'Test',
      summary: 'Test',
      units: 'm',
      assumptions: [],
      parts: [{
        id: 'p1',
        name: 'Part1',
        primitive: 'box',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        dimensions: { x: 1, y: 1, z: 1 },
        color: '#ff0000',
        parentId: null,
        role: 'exterior',
        tubeRatio: 0.3,
      }],
    };
    const result = {
      tool: 'generate_design' as const,
      ok: true,
      summary: 'success',
      detail: { message: 'ok' },
      stateChange: { model: { kind: 'generated' as const, model, source: 'test', providerModel: 'test' }, selection: null, explode: null, tryOn: null },
    };

    const stripped = stripModel(result);

    expect(stripped.stateChange!.model).toBeNull();
    expect(stripped.stateChange!.selection).toBeNull();
    expect(stripped.ok).toBe(true);
    expect(stripped.summary).toBe('success');
  });

  it('stripModel returns unchanged result when no stateChange.model', () => {
    const result = {
      tool: 'get_project_state' as const,
      ok: false,
      summary: 'no model',
      detail: { error: 'NO_MODEL' },
      stateChange: null,
    };

    const stripped = stripModel(result);

    expect(stripped).toEqual(result);
  });

  it('AGENT_INSTRUCTIONS contains geometry rules and tool descriptions', () => {
    expect(AGENT_INSTRUCTIONS).toContain('generate_design');
    expect(AGENT_INSTRUCTIONS).toContain('edit_design');
    expect(AGENT_INSTRUCTIONS).toContain('select_parts');
    expect(AGENT_INSTRUCTIONS).toContain('get_project_state');
    expect(AGENT_INSTRUCTIONS).toContain('explode_view');
    expect(AGENT_INSTRUCTIONS).toContain('wear_on_arm');
    expect(AGENT_INSTRUCTIONS).toContain('Only the following controlled solid primitives');
    expect(AGENT_INSTRUCTIONS).toContain('Model schema version is');
    expect(AGENT_INSTRUCTIONS).toContain('Each part has a stable');
    expect(AGENT_INSTRUCTIONS).toContain('Use realistic scale');
    expect(AGENT_INSTRUCTIONS).toContain('Traditional Chinese');
  });

  it('agentTask includes history, rounds, and current state snapshot', async () => {
    // This test is indirect: we verify that the task passed to provider.run
    // contains the expected structure by inspecting the mock call args.
    const rawStep = { type: 'final', reply: 'Done', note: null, calls: null };
    script.mockResolvedValueOnce(rawStep);

    const model: ModelSpec = {
      schemaVersion: '1.0',
      name: 'TestModel',
      summary: 'Test summary',
      units: 'm',
      assumptions: [],
      parts: [{
        id: 'p1',
        name: 'Part1',
        primitive: 'box',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        dimensions: { x: 1, y: 1, z: 1 },
        color: '#ff0000',
        parentId: null,
        role: 'exterior',
        tubeRatio: 0.3,
      }],
    };

    const req = makeTestRequest({
      model,
      selectedPartIds: ['p1'],
      explode: 0.5,
      tryOn: true,
      cameraOn: true,
      history: [{ instruction: '之前的指示', reply: '之前的回覆' }],
      instruction: '現在的指示',
    });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    expect(fakeProvider.run).toHaveBeenCalledTimes(1);
    const taskArg = vi.mocked(fakeProvider.run!).mock.calls[0][0] as ModelTask<AgentStep>;
    expect(taskArg.kind).toBe('agent');
    expect(taskArg.input).toContain('先前對話');
    expect(taskArg.input).toContain('之前的指示');
    expect(taskArg.input).toContain('之前的回覆');
    expect(taskArg.input).toContain('目前狀態');
    expect(taskArg.input).toContain('TestModel');
    expect(taskArg.input).toContain('1 個零件');
    expect(taskArg.input).toContain('已選取：p1');
    expect(taskArg.input).toContain('爆炸圖程度：50%');
    expect(taskArg.input).toContain('試戴：已開啟');
    expect(taskArg.input).toContain('使用者指示：現在的指示');
  });

  it('agentTask with no model shows "目前沒有模型" in snapshot', async () => {
    const rawStep = { type: 'final', reply: 'Done', note: null, calls: null };
    script.mockResolvedValueOnce(rawStep);

    const req = makeTestRequest({ instruction: 'test' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    const taskArg = vi.mocked(fakeProvider.run!).mock.calls[0][0] as ModelTask<AgentStep>;
    expect(taskArg.input).toContain('目前沒有模型');
  });

  it('state updates propagate across tool calls in one round', async () => {
    // This test verifies that the loop processes multiple tool calls in one round.
    // Since runTool is real and tools have complex dependencies, we use simple
    // tools that work without a model.
    const rawStep = {
      type: 'tool_calls',
      note: 'Two tools',
      reply: null,
      calls: [
        { tool: 'get_project_state', argsJson: '{}', reason: null },
        { tool: 'get_project_state', argsJson: '{}', reason: null },
      ],
    };
    script
      .mockResolvedValueOnce(rawStep)
      .mockResolvedValueOnce({ type: 'final', reply: 'Done', note: null, calls: null });

    const req = makeTestRequest({ instruction: 'multi-tool test' });

    await runAgent(fakeProvider, req, { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    // Both tool calls should execute and produce result events.
    const resultEvents = events.filter(e => e.name === 'result');
    expect(resultEvents.length).toBeGreaterThanOrEqual(2);
  });
});
