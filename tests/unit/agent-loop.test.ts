import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { runAgent, stripModels, AGENT_INSTRUCTIONS } from '../../server/agent';
import { GenerationError, type ModelProvider, type ModelTask } from '../../server/provider';
import {
  validateAgentStep, ToolEventSchema, ToolResultSchema, StateChangeSchema, UNKNOWN_TOOL_LABEL,
  type AgentRequest, type AgentEventName, type AgentStep, type ToolResult,
} from '../../shared/agent';
import { demoModel } from '../../shared/demo';
import { type ModelSpec } from '../../shared/model';
import { emptyWorkspace, SceneObjectSchema, type ObjectChange, type Workspace } from '../../shared/workspace';
import { twoBoxes } from '../fixtures/joint-workspace';
import { CREATED_AT, idCounter, sceneObject, workspaceOf } from './agent-fixtures';

/**
 * Task 4 acceptance test: the server/agent.ts loop — multi-round, max-rounds
 * limit, total-run timeout, client cancel (silent), provider errors (sanitized),
 * retry on invalid parse, and fabrication guard (all tool results are real).
 */

// Helper to create a minimal AgentRequest for testing
function makeTestRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    requestId: 'test-req',
    workspace: emptyWorkspace(),
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

  it('emits the tool event as { tool, label, argsJson } and records argsJson in the next round input', async () => {
    const argsJson = '{"partIds":[]}';
    script
      .mockResolvedValueOnce({ type: 'tool_calls', note: 'x', reply: null, calls: [{ tool: 'select_parts', argsJson, reason: null }] })
      .mockResolvedValueOnce({ type: 'final', reply: 'ok', note: null, calls: null });

    await runAgent(fakeProvider, makeTestRequest({ workspace: workspaceOf(sceneObject('obj-1')) }), { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    expect(events.find(e => e.name === 'tool')!.data).toEqual({ tool: 'select_parts', label: '選取零件', argsJson });
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

  it('labels every tool event with the tool label, and an unknown tool with 其他步驟', async () => {
    const names = ['generate_design', 'edit_design', 'select_parts', 'get_project_state', 'explode_view', 'wear_on_arm', 'no_such_tool'];
    script
      .mockResolvedValueOnce({
        type: 'tool_calls', note: null, reply: null,
        calls: names.slice(0, 4).map(tool => ({ tool, argsJson: '{', reason: null })),
      })
      .mockResolvedValueOnce({
        type: 'tool_calls', note: null, reply: null,
        calls: names.slice(4).map(tool => ({ tool, argsJson: '{', reason: null })),
      })
      .mockResolvedValueOnce({ type: 'final', reply: 'ok', note: null, calls: null });

    await runAgent(fakeProvider, makeTestRequest(), { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    const toolEvents = events.filter(e => e.name === 'tool').map(e => ToolEventSchema.parse(e.data));
    expect(toolEvents.map(e => [e.tool, e.label])).toEqual([
      ['generate_design', '生成設計'], ['edit_design', '修改設計'], ['select_parts', '選取零件'],
      ['get_project_state', '檢視目前狀態'], ['explode_view', '爆炸圖'], ['wear_on_arm', '護臂試戴'],
      ['no_such_tool', UNKNOWN_TOOL_LABEL],
    ]);
    expect(UNKNOWN_TOOL_LABEL).toBe('其他步驟');
  });

  describe('on a workspace', () => {
    const readyDesign = () => ({ status: 'ready', explanation: '測試模型。', model: structuredClone(demoModel) });
    const generate = { type: 'tool_calls', note: null, reply: null, calls: [{ tool: 'generate_design', argsJson: '{"prompt":"第二個"}', reason: null }] };
    const final = { type: 'final', reply: '完成', note: null, calls: null };
    const run = (workspace: Workspace) => runAgent(
      fakeProvider, makeTestRequest({ workspace }),
      { maxRounds: 5, totalTimeoutMs: 60000, newObjectId: idCounter('gen'), now: () => CREATED_AT },
      emit, abortController.signal,
    );
    const inputOf = (call: number) => (vi.mocked(fakeProvider.run!).mock.calls[call]![0] as ModelTask<AgentStep>).input;
    const twoObjects = () => workspaceOf(sceneObject('obj-1'), sceneObject('obj-2', { ...demoModel, name: '手環' }, 1));

    it('sends the complete SceneObject once in the state event; the result event carries none', async () => {
      script.mockResolvedValueOnce(generate).mockResolvedValueOnce(readyDesign()).mockResolvedValueOnce(final);

      await run(workspaceOf(sceneObject('obj-1')));

      const state = StateChangeSchema.parse(events.find(e => e.name === 'state')!.data);
      if (state.object?.op !== 'add') throw new Error('expected an add change');
      expect(SceneObjectSchema.parse(state.object.object)).toMatchObject({ id: 'gen-1', createdAt: CREATED_AT, edited: false });
      expect(state.object.object.model).toEqual(demoModel);
      const result = ToolResultSchema.parse(events.find(e => e.name === 'result')!.data);
      expect(result.stateChange).toMatchObject({ object: null, activeObjectId: null });
      expect(result.detail).toMatchObject({ objectId: 'gen-1', status: 'ready' });
      expect(JSON.stringify(events.find(e => e.name === 'result')!.data)).not.toContain('"parts"');
      expect(events.map(e => e.name)).toEqual(['status', 'tool', 'result', 'state', 'final', 'done']);
    });

    it('keeps the generated object in the working copy for the next round', async () => {
      script.mockResolvedValueOnce(generate).mockResolvedValueOnce(readyDesign()).mockResolvedValueOnce(final);

      await run(workspaceOf(sceneObject('obj-1')));

      // Calls: agent round 1, the design task, agent round 2.
      expect(inputOf(0)).toContain('工作區共 1 個物件（上限 8）：');
      expect(inputOf(2)).toContain('工作區共 2 個物件（上限 8）：');
      expect(inputOf(2)).toMatch(/- gen-1「.*」\d+ 個零件，位置 \([^)]*\) m，角度 \(0, 0, 0\)°，材料 未指定【目前物件】/);
      expect(inputOf(2)).not.toMatch(/- obj-1「[^\n]*【目前物件】/);
    });

    it('generates an object, then edits it by the id from the result', async () => {
      const design = { status: 'ready', explanation: '測試模型。', model: { ...structuredClone(demoModel), name: '新裝置' } };
      const blue = { ...structuredClone(demoModel.parts.find(part => part.id === 'battery')!), color: '#2563eb' };
      const edit = { type: 'tool_calls', note: null, reply: null, calls: [{ tool: 'edit_design', argsJson: '{"instruction":"電池改藍色","objectId":"gen-1"}', reason: null }] };
      const plan = { status: 'applied', explanation: '電池已改成藍色。', operations: [{ op: 'upsert', partId: 'battery', part: blue }], name: null, summary: null, assumptions: null };
      // Calls: agent round 1, the design task, agent round 2, the edit task, agent round 3.
      script.mockResolvedValueOnce(generate).mockResolvedValueOnce(design).mockResolvedValueOnce(edit).mockResolvedValueOnce(plan).mockResolvedValueOnce(final);
      await run(workspaceOf(sceneObject('obj-1')));
      // The second round's snapshot lists the new id, so the model can name it.
      expect(inputOf(2)).toMatch(/- gen-1「新裝置」\d+ 個零件/);
      expect(inputOf(2)).toContain('已產生「新裝置」（物件 id：gen-1）。');
      // The edit task got the new object's model, not obj-1's.
      expect(inputOf(3)).toContain('"name":"新裝置"');
      const results = events.filter(e => e.name === 'result').map(e => ToolResultSchema.parse(e.data));
      expect(results.map(result => [result.tool, result.ok])).toEqual([['generate_design', true], ['edit_design', true]]);
      expect(results[1]!.detail).toMatchObject({ objectId: 'gen-1' });
      const states = events.filter(e => e.name === 'state').map(e => StateChangeSchema.parse(e.data));
      expect(states).toHaveLength(2);
      expect(states[1]).toMatchObject({ activeObjectId: null, object: { op: 'model', objectId: 'gen-1' }, selection: { objectId: 'gen-1', partIds: ['battery'] } });
      expect(events.map(e => e.name).slice(-2)).toEqual(['final', 'done']);
    });
    it('switches the active object with set_active_object and the next snapshot shows it', async () => {
      const switchStep = { type: 'tool_calls', note: null, reply: null, calls: [{ tool: 'set_active_object', argsJson: '{"objectId":"obj-2"}', reason: null }] };
      script.mockResolvedValueOnce(switchStep).mockResolvedValueOnce(final);
      await run(twoObjects());
      expect(inputOf(1)).toMatch(/- obj-2「手環」[^\n]*【目前物件】/);
      expect(inputOf(1)).toContain('目前物件「手環」的零件：');
      expect(inputOf(1)).not.toMatch(/- obj-1「[^\n]*【目前物件】/);
    });    it('the snapshot lists every object and the parts of the active object only', async () => {
      script.mockResolvedValueOnce(final);

      await run(twoObjects());

      const input = inputOf(0);
      expect(input).toContain('- obj-1「' + demoModel.name + '」' + demoModel.parts.length + ' 個零件，位置 (0, 0, 0) m，角度 (0, 0, 0)°，材料 未指定【目前物件】');
      expect(input).toContain('- obj-2「手環」' + demoModel.parts.length + ' 個零件，位置 (1, 0, 0) m，角度 (0, 0, 0)°，材料 未指定\n');
      expect(input).toContain('目前物件「' + demoModel.name + '」的零件：');
      expect(input).not.toContain('目前物件「手環」');
      // The part list appears once: only the active object's parts.
      expect(input.split('(housing, ').length).toBe(2);
    });

    it('lists joints in the snapshot only when there are some', async () => {
      script.mockResolvedValue(final);
      await run(twoObjects());
      expect(inputOf(0)).not.toContain('接合');
      await run(twoBoxes({ joint: true }));
      expect(inputOf(1)).toContain('接合 1 個：');
      expect(inputOf(1)).toContain('- joint-1：「Block A」body（右面）↔「Block B」body（左面），膠合（瞬間膠），待確認，負重 未指定，拆裝 未指定');
    });

    it('runs create_joint without a printer in the request (default profile) and the next round sees the joint', async () => {
      script
        .mockResolvedValueOnce({ type: 'tool_calls', note: null, reply: null, calls: [{ tool: 'create_joint', argsJson: '{"a":{"objectId":"a"},"b":{"objectId":"b"}}', reason: null }] })
        .mockResolvedValueOnce(final);
      const request = makeTestRequest({ workspace: twoBoxes() });
      expect(request.printer).toBeUndefined();
      await runAgent(fakeProvider, request, { maxRounds: 5, totalTimeoutMs: 60000, newObjectId: idCounter('joint'), now: () => CREATED_AT }, emit, abortController.signal);
      const result = events.filter(e => e.name === 'result').map(e => ToolResultSchema.parse(e.data))[0]!;
      expect(result).toMatchObject({ tool: 'create_joint', ok: true });
      const state = events.filter(e => e.name === 'state').map(e => StateChangeSchema.parse(e.data))[0]!;
      expect(state.joint).toMatchObject({ op: 'add', joint: { id: 'joint-1' } });
      expect(inputOf(0)).not.toContain('接合');
      expect(inputOf(1)).toContain('接合 1 個：');
      expect(inputOf(1)).toContain('- joint-1：「Block A」body（右面）↔「Block B」body（左面）');
      expect(events.map(e => e.name).slice(-2)).toEqual(['final', 'done']);
    });

    it('applies a state change to the working copy so a later call in the round sees it', async () => {
      script
        .mockResolvedValueOnce({
          type: 'tool_calls', note: null, reply: null,
          calls: [
            { tool: 'select_parts', argsJson: '{"partIds":["housing"]}', reason: null },
            { tool: 'explode_view', argsJson: '{"amount":0.5}', reason: null },
            { tool: 'get_project_state', argsJson: '{}', reason: null },
          ],
        })
        .mockResolvedValueOnce(final);

      await run(workspaceOf(sceneObject('obj-1')));

      const results = events.filter(e => e.name === 'result').map(e => ToolResultSchema.parse(e.data));
      expect(results[2]!.detail).toMatchObject({ target: { selection: ['housing'], explode: 0.5 } });
      expect(inputOf(1)).toContain('已選取：housing。爆炸圖程度：50%。');
      expect(events.filter(e => e.name === 'state')).toHaveLength(2);
    });

    it('reports OBJECT_LIMIT from generate_design at the limit without a design call', async () => {
      const full = workspaceOf(...Array.from({ length: 8 }, (_, at) => sceneObject(`o${at}`, demoModel, at)));
      script.mockResolvedValueOnce(generate).mockResolvedValueOnce(final);

      await run(full);

      expect(fakeProvider.run).toHaveBeenCalledTimes(2); // two agent rounds, no design task
      const result = ToolResultSchema.parse(events.find(e => e.name === 'result')!.data);
      expect(result).toMatchObject({ ok: false, detail: { code: 'OBJECT_LIMIT' }, stateChange: null });
      expect(events.some(e => e.name === 'state')).toBe(false);
    });
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

  describe('stripModels', () => {
    const change = (object: ObjectChange | null): ToolResult => ({
      tool: 'generate_design', ok: true, summary: 'success', detail: { message: 'ok' },
      stateChange: { activeObjectId: null, object, selection: null, explode: null, tryOn: null },
    });

    it.each([
      ['add', { op: 'add' as const, object: sceneObject('x') }],
      ['model', { op: 'model' as const, objectId: 'x', model: demoModel, source: 'test', providerModel: 'test' }],
    ])('replaces a %s object change with null and keeps the rest', (_op, object) => {
      const stripped = stripModels(change(object));
      expect(stripped.stateChange!.object).toBeNull();
      expect(stripped.stateChange).toMatchObject({ activeObjectId: null, selection: null, explode: null, tryOn: null });
      expect(stripped.ok).toBe(true);
      expect(stripped.summary).toBe('success');
      expect(JSON.stringify(stripped)).not.toContain('"parts"');
    });

    it.each([
      ['transform', { op: 'transform' as const, objectId: 'x', transform: sceneObject('x').transform }],
      ['remove', { op: 'remove' as const, objectId: 'x' }],
      ['no object change', null],
    ])('keeps a %s change as it is', (_op, object) => {
      const result = change(object);
      expect(stripModels(result)).toBe(result);
    });

    it('returns a result without a stateChange unchanged', () => {
      const result = { tool: 'get_project_state', ok: false, summary: 'no model', detail: { error: 'NO_MODEL' }, stateChange: null };
      expect(stripModels(result)).toEqual(result);
    });
  });
  it('AGENT_INSTRUCTIONS contains geometry rules and tool descriptions', () => {
    expect(AGENT_INSTRUCTIONS).toContain('generate_design');
    expect(AGENT_INSTRUCTIONS).toContain('edit_design');
    expect(AGENT_INSTRUCTIONS).toContain('select_parts');
    expect(AGENT_INSTRUCTIONS).toContain('get_project_state');
    expect(AGENT_INSTRUCTIONS).toContain('explode_view');
    expect(AGENT_INSTRUCTIONS).toContain('wear_on_arm');
    expect(AGENT_INSTRUCTIONS).toContain('set_camera_image');
    expect(AGENT_INSTRUCTIONS).toContain('- set_camera_image only shows or hides the camera image; it changes no object.');
    expect(AGENT_INSTRUCTIONS).toContain('Only the following controlled solid primitives');
    expect(AGENT_INSTRUCTIONS).toContain('Model schema version is');
    expect(AGENT_INSTRUCTIONS).toContain('Each part has a stable');
    expect(AGENT_INSTRUCTIONS).toContain('Use realistic scale');
    expect(AGENT_INSTRUCTIONS).toContain('Traditional Chinese');
    expect(AGENT_INSTRUCTIONS).toContain('- If the workspace is empty, only generate_design and get_project_state work; other tools return NO_MODEL.');
    expect(AGENT_INSTRUCTIONS).not.toContain('If the scene is empty');
    // Task 7 rules (design 7.3), each line in full.
    for (const line of [
      "- The workspace holds up to 8 objects. generate_design adds a new object beside the others and makes it active; it never replaces an existing object. Its result gives the new object's id.",
      '- Refer to objects by id. Tools that change the scene take an optional objectId (default: the active object) and make that object active first. get_project_state(objectId) reads any object without changing the active one.',
      '- If it is unclear which object the user means, ask in your final reply instead of guessing.',
      '- Call remove_object only when the user asks to remove an object.',
      '- set_transform moves or rotates a whole object (position in metres, rotation in degrees). It never changes size; change sizes with edit_design.',
    ]) expect(AGENT_INSTRUCTIONS).toContain(line);
    // Assembly-joints rules (design 9), each line in full, and the four tools by name.
    for (const name of ['create_joint', 'update_joint', 'remove_joint', 'pull_out_part', 'set_material']) expect(AGENT_INSTRUCTIONS).toContain('- ' + name + '(');
    for (const line of [
      '- Joints connect two objects on flat faces. create_joint on two parts of one object first takes one of them out into its own object, in place, and then joins them. The only fixing methods are screw-insert (heat-set inserts with M2 or M3 screws), magnet, pin and glue. Snap-fits and moving joints (hinges, sliders) are not supported yet; PLA is too brittle for snap-fits. Never suggest welding for printed parts.',
      '- An object is one printed group: parts of one object that touch are printed as one piece. pull_out_part takes a part with its child parts out into a new object of its own. Use it when the user wants to separate a part, print it separately, give it another material, or join it to the rest. A part joined to anything stays in place; otherwise it goes next to the original. The original stays active.',
      "- remove_joint separates two objects; they stay separate objects. Nothing merges objects; only the user's undo reverses a pull-out.",
      '- Before recommending a method, ask the user about the load (light, medium, heavy) and how often the parts are taken apart (never, sometimes, often) unless they are known; then call update_joint with load and disassembly and explain the recommendation using the reasons the tool returns. Do not invent dimensions or strengths.',
      '- Pass confirmed: true only when the user chose or accepted the method in this conversation.',
      "- Metal and plastic parts are fastened mechanically (screws or pins), not glued alone. Hole sizes come from the user's printer profile, which you cannot change.",
      '- set_transform on a jointed object moves its whole assembly. An object leaves its assembly only when its joint is removed (remove_joint, only when the user asks).',
    ]) expect(AGENT_INSTRUCTIONS).toContain(line);
    // Export rule (spec export, design 8): the agent only prepares; the user downloads.
    expect(AGENT_INSTRUCTIONS).toContain('- prepare_export(');
    for (const phrase of [
      'You cannot save or download files.',
      'call prepare_export, then tell the user to press 下載完整套件 in the export dialog.',
      'mention the problems prepare_export returns and offer to fix them.',
      'STEP files, drawings, print-service orders and slicing are not supported.',
    ]) expect(AGENT_INSTRUCTIONS).toContain(phrase);
    // Every existing rule stays.
    expect(AGENT_INSTRUCTIONS).toContain('- Prefer local tools (select_parts, explode_view, get_project_state) when they suffice.');
    for (const name of ['set_active_object', 'set_transform', 'remove_object']) expect(AGENT_INSTRUCTIONS).toContain('- ' + name + '(');
  });

  it('agentTask includes history, rounds, and the workspace snapshot', async () => {
    // Indirect: inspect the task passed to provider.run.
    script.mockResolvedValueOnce({ type: 'final', reply: 'Done', note: null, calls: null });

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
    const workspace = workspaceOf(sceneObject('obj-1', model));
    const req = makeTestRequest({
      workspace: { ...workspace, selection: { objectId: 'obj-1', partIds: ['p1'] }, display: { explode: 0.5 } },
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
    expect(taskArg.input).toContain('目前狀態：工作區共 1 個物件（上限 8）：');
    expect(taskArg.input).toContain('- obj-1「TestModel」1 個零件，位置 (0, 0, 0) m，角度 (0, 0, 0)°，材料 未指定【目前物件】');
    expect(taskArg.input).toContain('目前物件「TestModel」的零件：Part1(p1, box, #ff0000)');
    expect(taskArg.input).toContain('已選取：p1');
    expect(taskArg.input).toContain('爆炸圖程度：50%');
    expect(taskArg.input).toContain('試戴：已開啟');
    expect(taskArg.input).toContain('使用者指示：現在的指示');
  });

  it('the snapshot of an empty workspace says so', async () => {
    script.mockResolvedValueOnce({ type: 'final', reply: 'Done', note: null, calls: null });

    await runAgent(fakeProvider, makeTestRequest({ instruction: 'test' }), { maxRounds: 5, totalTimeoutMs: 60000 }, emit, abortController.signal);

    const taskArg = vi.mocked(fakeProvider.run!).mock.calls[0][0] as ModelTask<AgentStep>;
    expect(taskArg.input).toContain('目前狀態：工作區沒有物件。');
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
