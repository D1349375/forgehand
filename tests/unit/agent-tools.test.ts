import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import { runTool, type AgentWorkingState } from '../../server/agent-tools';
import type { ModelProvider } from '../../server/provider';

const call = (tool: string, args: Record<string, unknown> = {}) => ({ tool, argsJson: JSON.stringify(args), reason: null });
const rawCall = (tool: string, argsJson: string) => ({ tool, argsJson, reason: null });

const withModel = (over: Partial<AgentWorkingState> = {}): AgentWorkingState => ({
  model: structuredClone(demoModel), selection: [], explode: 0, tryOn: false, cameraOn: false, ...over,
});
const noModel = (over: Partial<AgentWorkingState> = {}): AgentWorkingState => ({
  model: null, selection: [], explode: 0, tryOn: false, cameraOn: false, ...over,
});

const provider = { name: 'openai', configured: true, model: 'm' } as unknown as ModelProvider;
const signal = new AbortController().signal;

describe('agent local tools', () => {
  describe('select_parts', () => {
    it('returns the new selection as a stateChange and does not mutate the working copy', async () => {
      const state = withModel({ selection: ['battery'] });
      const result = await runTool(call('select_parts', { partIds: ['housing', 'battery'] }), state, provider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange?.selection).toEqual(['housing', 'battery']);
      expect(result.stateChange?.model).toBeNull();
      expect(result.stateChange?.explode).toBeNull();
      expect(result.stateChange?.tryOn).toBeNull();
      expect(state.selection).toEqual(['battery']); // runTool is pure; the loop applies stateChange
    });
    it('rejects partIds not in the model (INVALID_ARGS)', async () => {
      const result = await runTool(call('select_parts', { partIds: ['missing'] }), withModel(), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'INVALID_ARGS' });
      expect(result.stateChange).toBeNull();
    });
    it('returns NO_MODEL when the scene is empty, with a tool-name-free message', async () => {
      const result = await runTool(call('select_parts', { partIds: ['housing'] }), noModel(), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'NO_MODEL' });
      expect(result.summary).toBe('目前沒有模型，請先生成設計。');
      expect(result.summary).not.toContain('generate_design');
      expect(result.stateChange).toBeNull();
    });
  });

  describe('get_project_state', () => {
    it('returns a snapshot with no state change', async () => {
      const state = withModel({ selection: ['housing'], explode: 0.5, tryOn: true });
      const result = await runTool(call('get_project_state', {}), state, provider, signal);
      expect(result.ok).toBe(true);
      expect(result.detail).toMatchObject({ selection: ['housing'], explode: 0.5, tryOn: true });
      expect((result.detail as { parts: unknown[] }).parts).toHaveLength(demoModel.parts.length);
      expect(result.stateChange).toBeNull();
    });
    it('works with no model (empty parts)', async () => {
      const result = await runTool(call('get_project_state', {}), noModel(), provider, signal);
      expect(result.ok).toBe(true);
      expect((result.detail as { parts: unknown[] }).parts).toEqual([]);
      expect(result.stateChange).toBeNull();
    });
  });

  describe('explode_view', () => {
    it.each([[0], [0.5], [1]])('sets explode for a valid amount (%s)', async (amount) => {
      const result = await runTool(call('explode_view', { amount }), withModel(), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange?.explode).toBe(amount);
      expect(result.detail).toMatchObject({ amount });
    });
    it.each([[1.5], [-0.1]])('rejects out-of-range amount (%s) as INVALID_ARGS', async (amount) => {
      const result = await runTool(call('explode_view', { amount }), withModel(), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'INVALID_ARGS' });
      expect(result.stateChange).toBeNull();
    });
    it('returns NO_MODEL when the scene is empty', async () => {
      const result = await runTool(call('explode_view', { amount: 1 }), noModel(), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'NO_MODEL' });
      expect(result.stateChange).toBeNull();
    });
  });

  describe('wear_on_arm', () => {
    it('asks the user to turn the camera on when it is off (ok:false, no tryOn change)', async () => {
      const result = await runTool(call('wear_on_arm', { enabled: true }), withModel({ cameraOn: false }), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.summary).toBe('請先開啟攝影機再試戴。');
      expect(result.stateChange).toBeNull();
      expect(result.detail).toMatchObject({ cameraOn: false, message: '請先開啟攝影機再試戴。' });
    });
    it('turns tryOn on when the camera is on and enabled, with an honest stand-in message', async () => {
      const result = await runTool(call('wear_on_arm', { enabled: true }), withModel({ cameraOn: true }), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange?.tryOn).toBe(true);
      const honest = '已開啟護臂試戴（目前顯示預設護臂，尚未套用你的設計）。';
      expect(result.summary).toBe(honest);
      expect((result.detail as { message: string }).message).toBe(honest);
    });
    it('turns tryOn off when disabled', async () => {
      const result = await runTool(call('wear_on_arm', { enabled: false }), withModel({ cameraOn: true, tryOn: true }), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange?.tryOn).toBe(false);
      expect(result.summary).toBe('已關閉護臂試戴。');
    });
    it('returns NO_MODEL when the scene is empty', async () => {
      const result = await runTool(call('wear_on_arm', { enabled: true }), noModel({ cameraOn: true }), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'NO_MODEL' });
      expect(result.stateChange).toBeNull();
    });
  });

  describe('argsJson validation', () => {
    // A provider that fails the test if a tool reaches it: bad args must be rejected before `run`.
    const untouchedProvider = {
      name: 'openai', configured: true, model: 'm',
      run: async () => { throw new Error('provider must not be called for invalid args'); },
    } as unknown as ModelProvider;

    // One row per tool and failure mode: not JSON, a required arg missing, a wrong type.
    // get_project_state takes no arguments, so its failure modes are a non-object and a stray key.
    it.each([
      ['generate_design: bad JSON', rawCall('generate_design', '{prompt:')],
      ['generate_design: missing prompt', call('generate_design', {})],
      ['generate_design: wrong type', call('generate_design', { prompt: 42 })],
      ['edit_design: bad JSON', rawCall('edit_design', 'not json')],
      ['edit_design: missing instruction', call('edit_design', {})],
      ['edit_design: wrong type', call('edit_design', { instruction: ['a'] })],
      ['select_parts: bad JSON', rawCall('select_parts', '')],
      ['select_parts: missing partIds', call('select_parts', {})],
      ['select_parts: wrong type', call('select_parts', { partIds: 'housing' })],
      ['get_project_state: bad JSON', rawCall('get_project_state', '{')],
      ['get_project_state: not an object', rawCall('get_project_state', '[]')],
      ['get_project_state: stray key', call('get_project_state', { prompt: 'x' })],
      ['explode_view: bad JSON', rawCall('explode_view', '{"amount":')],
      ['explode_view: missing amount', call('explode_view', {})],
      ['explode_view: wrong type', call('explode_view', { amount: '0.5' })],
      ['explode_view: out of range', call('explode_view', { amount: 2 })],
      ['wear_on_arm: not an object', rawCall('wear_on_arm', 'true')],
      ['wear_on_arm: missing enabled', call('wear_on_arm', {})],
      ['wear_on_arm: wrong type', call('wear_on_arm', { enabled: 'yes' })],
    ])('%s returns INVALID_ARGS without touching state or the provider', async (_label, badCall) => {
      const state = withModel();
      const before = structuredClone(state);
      const result = await runTool(badCall, state, untouchedProvider, signal);
      expect(result.tool).toBe(badCall.tool);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'INVALID_ARGS' });
      expect(result.stateChange).toBeNull();
      expect(state).toEqual(before);
    });

    it('rejects a stray key on a tool that takes arguments', async () => {
      const result = await runTool(call('explode_view', { amount: 0.5, extra: true }), withModel(), provider, signal);
      expect(result.detail).toMatchObject({ code: 'INVALID_ARGS' });
    });

    it('explains the failure in Traditional Chinese with the expected shape, never a Zod dump', async () => {
      const missing = await runTool(call('explode_view', {}), withModel(), provider, signal);
      expect(missing.summary).toContain('缺少參數 amount');
      expect(missing.summary).toContain('explode_view(amount: number)');

      const wrongType = await runTool(call('explode_view', { amount: 'lots' }), withModel(), provider, signal);
      expect(wrongType.summary).toContain('參數 amount 的值不正確');
      expect(wrongType.summary).not.toContain('lots');
      expect(wrongType.summary).not.toMatch(/expected|invalid_type|received/i);

      const badJson = await runTool(rawCall('select_parts', '{oops'), withModel(), provider, signal);
      expect(badJson.summary).toContain('不是有效的 JSON');
      expect(badJson.summary).toContain('select_parts(partIds: string[])');
    });
  });

  describe('unknown tools', () => {
    it.each(['estimate_weight_cost', 'check_feasibility', 'no_such_tool'])('returns UNKNOWN_TOOL for %s', async (name) => {
      const state = withModel();
      const result = await runTool(call(name, {}), state, provider, signal);
      expect(result.tool).toBe(name);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'UNKNOWN_TOOL' });
      expect(result.stateChange).toBeNull();
      // The message lists the real tools so the model can correct itself.
      expect(result.summary).toContain('generate_design');
      expect(result.summary).toContain('wear_on_arm');
    });
  });
});
