import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import type { EditPlan } from '../../shared/edit';
import type { ModelSpec, Part } from '../../shared/model';
import { GenerationError, type ModelProvider, type ModelTask } from '../../server/provider';
import { runTool, type AgentWorkingState } from '../../server/agent-tools';
import type { ToolCallArgs, ToolName } from '../../shared/agent';

const args = (partial: Partial<ToolCallArgs>): ToolCallArgs => ({
  prompt: null, instruction: null, partIds: null, amount: null, enabled: null, densityKgPerM3: null, material: null, ...partial,
});
const call = (tool: ToolName, a: Partial<ToolCallArgs>) => ({ tool, args: args(a), reason: null });
const demoPart = (id: string) => structuredClone(demoModel.parts.find(part => part.id === id)!);

const editPlan = (over: Partial<EditPlan>): EditPlan => ({
  status: 'applied', explanation: '測試修改。', operations: [], name: null, summary: null, assumptions: null, ...over,
});

/** Builds a fake provider whose `run` delegates to `impl`. */
function fakeProvider(impl: (task: ModelTask<unknown>, signal: AbortSignal) => Promise<unknown>): ModelProvider {
  const run = async <T>(task: ModelTask<T>, signal: AbortSignal): Promise<T> => impl(task as ModelTask<unknown>, signal) as T;
  return { name: 'openai', configured: true, model: 'test-model', run } as unknown as ModelProvider;
}

const withModel = (over: Partial<AgentWorkingState> = {}): AgentWorkingState => ({
  model: structuredClone(demoModel), selection: [], explode: 0, tryOn: false, cameraOn: false, ...over,
});
const noModel = (): AgentWorkingState => ({ model: null, selection: [], explode: 0, tryOn: false, cameraOn: false });

const readyDesign = () => ({ status: 'ready' as const, explanation: '測試模型。', model: structuredClone(demoModel) });

describe('generate_design', () => {
  it('returns a generated model state change with no model in the detail', async () => {
    const provider = fakeProvider(async () => readyDesign());
    const result = await runTool(call('generate_design', { prompt: '一張紅桌子' }), withModel(), provider, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange?.model?.kind).toBe('generated');
    expect(result.stateChange?.model?.model).toEqual(demoModel);
    expect(result.stateChange?.model?.source).toBe('openai');
    expect(result.stateChange?.model?.providerModel).toBe('test-model');
    expect(result.detail).toMatchObject({ source: 'openai', providerModel: 'test-model', status: 'ready' });
    expect(result.detail).not.toHaveProperty('model');
  });

  it('works on an empty scene (no existing model)', async () => {
    const provider = fakeProvider(async () => readyDesign());
    const result = await runTool(call('generate_design', { prompt: '第一個想法' }), noModel(), provider, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange?.model?.kind).toBe('generated');
  });

  it('surfaces approximation/unsupported as ok:false with no state change', async () => {
    const provider = fakeProvider(async () => ({ status: 'approximation' as const, explanation: '需近似處理。', model: structuredClone(demoModel) }));
    const result = await runTool(call('generate_design', { prompt: '需要挖孔' }), withModel(), provider, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.stateChange).toBeNull();
    expect(result.detail).toMatchObject({ status: 'approximation' });
    expect(result.summary).toBe('需近似處理。');
  });

  it('passes the run signal through to provider.run', async () => {
    let received: AbortSignal | undefined;
    const provider = fakeProvider(async (_task, sig) => { received = sig; return readyDesign(); });
    const signal = new AbortController().signal;
    await runTool(call('generate_design', { prompt: 'x' }), withModel(), provider, signal);
    expect(received).toBe(signal);
  });

  it('propagates a GenerationError (does not return a ToolResult)', async () => {
    const provider = fakeProvider(async () => { throw new GenerationError('SERVICE_ERROR', '模型失敗。'); });
    await expect(runTool(call('generate_design', { prompt: 'x' }), withModel(), provider, new AbortController().signal))
      .rejects.toBeInstanceOf(GenerationError);
  });

  it('propagates an abort', async () => {
    const ac = new AbortController();
    const provider = fakeProvider(async (_task, sig) => { expect(sig.aborted).toBe(true); throw new Error('aborted'); });
    ac.abort();
    await expect(runTool(call('generate_design', { prompt: 'x' }), withModel(), provider, ac.signal)).rejects.toThrow('aborted');
  });
});

describe('edit_design', () => {
  it('applies a plan and returns an edited model state change', async () => {
    const blue: Part = { ...demoPart('battery'), color: '#2563eb' };
    const provider = fakeProvider(async () => editPlan({
      explanation: '把側邊電池改成藍色。',
      operations: [{ op: 'upsert', partId: 'battery', part: blue }],
    }));
    const result = await runTool(call('edit_design', { instruction: '把這個改成藍色' }), withModel({ selection: ['battery'] }), provider, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange?.model?.kind).toBe('edited');
    expect((result.stateChange?.model?.model as ModelSpec).parts.find(part => part.id === 'battery')?.color).toBe('#2563eb');
    expect(result.detail).toMatchObject({ changes: { added: [], updated: ['battery'], removed: [] }, explanation: '把側邊電池改成藍色。' });
  });

  it('returns ok:false with no state change for clarify/unsupported', async () => {
    const provider = fakeProvider(async () => editPlan({ status: 'clarify', explanation: '要放大哪一個零件？' }));
    const result = await runTool(call('edit_design', { instruction: '放大' }), withModel(), provider, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.stateChange).toBeNull();
    expect(result.summary).toBe('要放大哪一個零件？');
  });

  it('returns a ToolError when applyEditPlan fails (local EditError)', async () => {
    const provider = fakeProvider(async () => editPlan({
      explanation: '刪掉外殼。',
      operations: [{ op: 'remove', partId: 'housing', part: null }],
    }));
    const result = await runTool(call('edit_design', { instruction: '刪掉外殼' }), withModel(), provider, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatchObject({ code: 'INVALID_EDIT' });
    expect(result.stateChange).toBeNull();
  });

  it('returns NO_MODEL on an empty scene without calling the provider', async () => {
    let called = false;
    const provider = fakeProvider(async () => { called = true; return editPlan({}); });
    const result = await runTool(call('edit_design', { instruction: 'x' }), noModel(), provider, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatchObject({ code: 'NO_MODEL' });
    expect(called).toBe(false);
  });

  it('passes model, instruction and selection into editTask', async () => {
    const inputs: string[] = [];
    const provider = fakeProvider(async (task) => { inputs.push(task.input); return editPlan({ explanation: 'x', operations: [{ op: 'upsert', partId: 'battery', part: { ...demoPart('battery'), color: '#000000' } }] }); });
    await runTool(call('edit_design', { instruction: '把電池改黑' }), withModel({ selection: ['battery'] }), provider, new AbortController().signal);
    expect(inputs[0]).toContain('把電池改黑');
    expect(inputs[0]).toContain('["battery"]');
    expect(inputs[0]).toContain('CURRENT_MODEL');
  });

  it('propagates a GenerationError (does not return a ToolResult)', async () => {
    const provider = fakeProvider(async () => { throw new GenerationError('SERVICE_ERROR', '模型失敗。'); });
    await expect(runTool(call('edit_design', { instruction: 'x' }), withModel(), provider, new AbortController().signal))
      .rejects.toBeInstanceOf(GenerationError);
  });
});
