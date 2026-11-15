import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import type { EditPlan } from '../../shared/edit';
import type { Part } from '../../shared/model';
import { applyWorkspaceChange, MAX_OBJECTS, placeBeside } from '../../shared/workspace';
import { GenerationError, type ModelProvider, type ModelTask } from '../../server/provider';
import { runTool } from '../../server/agent-tools';
import { getTool } from '../../server/tools';
import { CREATED_AT, idCounter, noModel, sceneObject, stateOver, withModel, workspaceOf } from './agent-fixtures';

const call = (tool: string, args: Record<string, unknown> = {}) => ({ tool, argsJson: JSON.stringify(args), reason: null });
const demoPart = (id: string) => structuredClone(demoModel.parts.find(part => part.id === id)!);

const editPlan = (over: Partial<EditPlan>): EditPlan => ({
  status: 'applied', explanation: '測試修改。', operations: [], name: null, summary: null, assumptions: null, ...over,
});

/** Builds a fake provider whose `run` delegates to `impl`. */
function fakeProvider(impl: (task: ModelTask<unknown>, signal: AbortSignal) => Promise<unknown>): ModelProvider {
  const run = async <T>(task: ModelTask<T>, signal: AbortSignal): Promise<T> => impl(task as ModelTask<unknown>, signal) as T;
  return { name: 'openai', configured: true, model: 'test-model', run } as unknown as ModelProvider;
}

const readyDesign = () => ({ status: 'ready' as const, explanation: '測試模型。', model: structuredClone(demoModel) });

/** The injected id and time source `runTool` passes to `generate_design`. */
const env = () => ({ newObjectId: idCounter(), now: () => CREATED_AT });

describe('generate_design', () => {
  it('returns an add change with the new SceneObject, built from the injected id and time', async () => {
    const provider = fakeProvider(async () => readyDesign());
    const state = withModel();
    const result = await runTool(call('generate_design', { prompt: '一張紅桌子' }), state, provider, new AbortController().signal, env());
    expect(result.ok).toBe(true);
    const op = result.stateChange?.object;
    if (op?.op !== 'add') throw new Error('expected an add change');
    expect(op.object).toMatchObject({
      id: 'new-1', source: 'openai', providerModel: 'test-model', edited: false, createdAt: CREATED_AT,
    });
    expect(op.object.model).toEqual(demoModel);
    expect(result.stateChange).toMatchObject({ activeObjectId: null, selection: null, explode: null, tryOn: null });
    expect(result.summary).toBe(`已產生「${demoModel.name}」（物件 id：new-1）。`);
    expect(result.detail).toEqual({ source: 'openai', providerModel: 'test-model', status: 'ready', objectId: 'new-1' });
    expect(result.detail).not.toHaveProperty('model');
  });

  it('places the new object beside the existing ones', async () => {
    const provider = fakeProvider(async () => readyDesign());
    const state = withModel();
    const result = await runTool(call('generate_design', { prompt: 'x' }), state, provider, new AbortController().signal, env());
    const op = result.stateChange?.object;
    if (op?.op !== 'add') throw new Error('expected an add change');
    expect(op.object.transform).toEqual(placeBeside(state.workspace.objects, demoModel));
    expect(op.object.transform.position.x).toBeGreaterThan(0);
  });

  it('works on an empty workspace: the first object sits at the origin', async () => {
    const provider = fakeProvider(async () => readyDesign());
    const state = noModel();
    const result = await runTool(call('generate_design', { prompt: '第一個想法' }), state, provider, new AbortController().signal, env());
    expect(result.ok).toBe(true);
    const op = result.stateChange?.object;
    if (op?.op !== 'add') throw new Error('expected an add change');
    expect(op.object.transform.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('uses a random id and the current time when no env is given', async () => {
    const provider = fakeProvider(async () => readyDesign());
    const result = await runTool(call('generate_design', { prompt: 'x' }), noModel(), provider, new AbortController().signal);
    const op = result.stateChange?.object;
    if (op?.op !== 'add') throw new Error('expected an add change');
    expect(op.object.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(op.object.createdAt))).toBe(false);
  });

  it('the change applies: the object is added and becomes active', async () => {
    const provider = fakeProvider(async () => readyDesign());
    const state = withModel({ selection: ['battery'], explode: 0.5 });
    const result = await runTool(call('generate_design', { prompt: 'x' }), state, provider, new AbortController().signal, env());
    const { tryOn: _tryOn, ...change } = result.stateChange!;
    const { after } = applyWorkspaceChange(state.workspace, change);
    expect(after.objects.map(object => object.id)).toEqual(['obj-1', 'new-1']);
    expect(after.activeObjectId).toBe('new-1');
    expect(after.selection.partIds).toEqual([]);
    expect(after.display.explode).toBe(0);
  });

  it('returns OBJECT_LIMIT at the limit without calling the provider', async () => {
    let called = false;
    const provider = fakeProvider(async () => { called = true; return readyDesign(); });
    const ids = Array.from({ length: MAX_OBJECTS }, (_, at) => `full-${at}`);
    const state = stateOver(workspaceOf(...ids.map((id, at) => sceneObject(id, demoModel, at))));
    const result = await runTool(call('generate_design', { prompt: 'x' }), state, provider, new AbortController().signal, env());
    expect(result.ok).toBe(false);
    expect(result.detail).toMatchObject({ code: 'OBJECT_LIMIT' });
    expect(result.stateChange).toBeNull();
    expect(called).toBe(false);
  });

  it('describes itself as adding a new object', () => {
    expect(getTool('generate_design')?.description).toContain('adds it to the workspace as a new object');
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
  it('applies a plan and returns a model change for the active object', async () => {
    const blue: Part = { ...demoPart('battery'), color: '#2563eb' };
    const provider = fakeProvider(async () => editPlan({
      explanation: '把側邊電池改成藍色。',
      operations: [{ op: 'upsert', partId: 'battery', part: blue }],
    }));
    const result = await runTool(call('edit_design', { instruction: '把這個改成藍色' }), withModel({ selection: ['battery'] }), provider, new AbortController().signal);
    expect(result.ok).toBe(true);
    const op = result.stateChange?.object;
    if (op?.op !== 'model') throw new Error('expected a model change');
    expect(op).toMatchObject({ objectId: 'obj-1', source: 'openai', providerModel: 'test-model' });
    expect(op.model.parts.find(part => part.id === 'battery')?.color).toBe('#2563eb');
    expect(result.detail).toMatchObject({ objectId: 'obj-1', changes: { added: [], updated: ['battery'], removed: [] }, explanation: '把側邊電池改成藍色。' });
    expect(result.stateChange?.activeObjectId).toBeNull();
    expect(result.stateChange?.selection).toEqual({ objectId: 'obj-1', partIds: ['battery'] });
  });

  it('drops a removed part from the selection (sets selection to added+updated)', async () => {
    const provider = fakeProvider(async () => editPlan({
      explanation: '刪除側邊電池。',
      operations: [{ op: 'remove', partId: 'battery', part: null }],
    }));
    const state = withModel({ selection: ['battery', 'housing'] });
    const result = await runTool(call('edit_design', { instruction: '刪除電池' }), state, provider, new AbortController().signal);
    expect(result.ok).toBe(true);
    const op = result.stateChange?.object;
    if (op?.op !== 'model') throw new Error('expected a model change');
    expect(result.stateChange?.selection).toEqual({ objectId: 'obj-1', partIds: [] });
    expect(op.model.parts.find(part => part.id === 'battery')).toBeUndefined();
    // The change applies: the removed part is gone and nothing stays selected.
    const { tryOn: _tryOn, ...change } = result.stateChange!;
    const { after } = applyWorkspaceChange(state.workspace, change);
    expect(after.selection).toEqual({ objectId: null, partIds: [] });
    expect(after.objects[0]!.edited).toBe(true);
  });

  it('acts on the active object and leaves the others as they are', async () => {
    const blue: Part = { ...demoPart('battery'), color: '#2563eb' };
    const provider = fakeProvider(async () => editPlan({ explanation: '改色。', operations: [{ op: 'upsert', partId: 'battery', part: blue }] }));
    const state = stateOver(workspaceOf(sceneObject('obj-1'), sceneObject('obj-2', demoModel, 1)));
    const result = await runTool(call('edit_design', { instruction: '改色' }), state, provider, new AbortController().signal);
    const { tryOn: _tryOn, ...change } = result.stateChange!;
    const { after } = applyWorkspaceChange(state.workspace, change);
    expect(after.objects[0]!.model.parts.find(part => part.id === 'battery')?.color).toBe('#2563eb');
    expect(after.objects[1]).toBe(state.workspace.objects[1]);
  });

  it('returns ok:false with no state change for clarify/unsupported', async () => {
    const provider = fakeProvider(async () => editPlan({ status: 'clarify', explanation: '要放大哪一個零件？' }));
    const result = await runTool(call('edit_design', { instruction: '放大' }), withModel(), provider, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.stateChange).toBeNull();
    expect(result.summary).toBe('要放大哪一個零件？');
    expect(result.detail).toMatchObject({ objectId: 'obj-1', changes: { added: [], updated: [], removed: [] } });
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

  it('passes model, instruction and selection of the active object into editTask', async () => {
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
