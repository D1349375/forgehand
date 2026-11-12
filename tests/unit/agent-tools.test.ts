import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import { runTool, type AgentWorkingState } from '../../server/agent-tools';
import type { ToolCallArgs, ToolName } from '../../shared/agent';
import type { ModelProvider } from '../../server/provider';

const args = (partial: Partial<ToolCallArgs>): ToolCallArgs => ({
  prompt: null, instruction: null, partIds: null, amount: null, enabled: null, densityKgPerM3: null, material: null, ...partial,
});
const call = (tool: ToolName, a: Partial<ToolCallArgs>) => ({ tool, args: args(a), reason: null });

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
    it('returns NO_MODEL when the scene is empty', async () => {
      const result = await runTool(call('select_parts', { partIds: ['housing'] }), noModel(), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'NO_MODEL' });
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
    it('turns tryOn on when the camera is on and enabled', async () => {
      const result = await runTool(call('wear_on_arm', { enabled: true }), withModel({ cameraOn: true }), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange?.tryOn).toBe(true);
    });
    it('turns tryOn off when disabled', async () => {
      const result = await runTool(call('wear_on_arm', { enabled: false }), withModel({ cameraOn: true, tryOn: true }), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange?.tryOn).toBe(false);
    });
    it('returns NO_MODEL when the scene is empty', async () => {
      const result = await runTool(call('wear_on_arm', { enabled: true }), noModel({ cameraOn: true }), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'NO_MODEL' });
      expect(result.stateChange).toBeNull();
    });
  });

  describe('bad args', () => {
    it.each([
      ['select_parts without partIds', call('select_parts', { partIds: null })],
      ['explode_view without amount', call('explode_view', { amount: null })],
      ['wear_on_arm without enabled', call('wear_on_arm', { enabled: null })],
      ['get_project_state with a foreign arg', call('get_project_state', { prompt: 'x' })],
    ])('returns INVALID_ARGS for %s', async (_label, badCall) => {
      const result = await runTool(badCall, withModel(), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'INVALID_ARGS' });
      expect(result.stateChange).toBeNull();
    });
  });

  describe('unimplemented tools', () => {
    it.each([
      ['generate_design', call('generate_design', { prompt: '桌子' })],
      ['edit_design', call('edit_design', { instruction: '加長' })],
      ['estimate_weight_cost', call('estimate_weight_cost', { densityKgPerM3: 1200 })],
      ['check_feasibility', call('check_feasibility', {})],
    ])('returns NOT_IMPLEMENTED for %s (until Tasks 3/9)', async (_label, toolCall) => {
      const result = await runTool(toolCall, withModel(), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatchObject({ code: 'NOT_IMPLEMENTED' });
    });
  });
});
