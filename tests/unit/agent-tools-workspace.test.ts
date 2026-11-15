import { describe, expect, it } from 'vitest';
import { ObjectToolDetailSchema, ToolResultSchema, type StateChange, type ToolResult } from '../../shared/agent';
import { demoModel } from '../../shared/demo';
import type { EditPlan } from '../../shared/edit';
import type { Part } from '../../shared/model';
import { applyWorkspaceChange, type Workspace } from '../../shared/workspace';
import { runTool, type AgentWorkingState } from '../../server/agent-tools';
import type { ModelProvider, ModelTask } from '../../server/provider';
import { noModel, sceneObject, stateOver, withModel, workspaceOf, type StateOptions } from './agent-fixtures';

/**
 * Task 7: the `objectId` argument of the four object-aware tools and the three
 * object tools (`set_active_object`, `set_transform`, `remove_object`).
 */
const call = (tool: string, args: Record<string, unknown> = {}) => ({ tool, argsJson: JSON.stringify(args), reason: null });
const signal = new AbortController().signal;
const idleProvider = { name: 'openai', configured: true, model: 'm' } as unknown as ModelProvider;

/** Three objects: `obj-1` is active, `obj-2` and `obj-3` sit beside it. */
const threeObjects = (options: StateOptions = {}): AgentWorkingState => stateOver(workspaceOf(
  sceneObject('obj-1'),
  sceneObject('obj-2', { ...demoModel, name: '手環' }, 1),
  sceneObject('obj-3', { ...demoModel, name: '耳機' }, 2),
), options);

const apply = (state: AgentWorkingState, change: StateChange | null | undefined): Workspace => {
  if (!change) throw new Error('expected a state change');
  const { tryOn: _tryOn, ...workspaceChange } = change;
  return applyWorkspaceChange(state.workspace, workspaceChange).after;
};

/** Every result must be a valid `ToolResult`, and a change must apply to the workspace. */
function expectConsistent(state: AgentWorkingState, result: ToolResult): void {
  expect(ToolResultSchema.safeParse(result).success).toBe(true);
  if (result.stateChange) expect(() => apply(state, result.stateChange)).not.toThrow();
}

const expectFailure = (state: AgentWorkingState, result: ToolResult, code: string): void => {
  expect(result.ok).toBe(false);
  expect(result.detail).toMatchObject({ code });
  expect(result.stateChange).toBeNull();
  expectConsistent(state, result);
};

const unknownMessage = (id: string) => `工作區沒有 id 為「${id}」的物件。`;

describe('objectId on edit_design, select_parts, explode_view and get_project_state', () => {
  describe('select_parts', () => {
    it.each([['absent', {}], ['null', { objectId: null }]])('%s objectId means the active object', async (_name, extra) => {
      const state = threeObjects();
      const result = await runTool(call('select_parts', { partIds: ['housing'], ...extra }), state, idleProvider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange).toMatchObject({ activeObjectId: null, selection: { objectId: 'obj-1', partIds: ['housing'] } });
      expect(result.detail).toEqual({ objectId: 'obj-1', selection: ['housing'] });
      expectConsistent(state, result);
    });

    it('activates a non-active target and selects its parts', async () => {
      const state = threeObjects();
      const result = await runTool(call('select_parts', { partIds: ['housing'], objectId: 'obj-2' }), state, idleProvider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange).toMatchObject({ activeObjectId: 'obj-2', selection: { objectId: 'obj-2', partIds: ['housing'] } });
      expect(result.detail).toEqual({ objectId: 'obj-2', selection: ['housing'] });
      const after = apply(state, result.stateChange);
      expect(after.activeObjectId).toBe('obj-2');
      expect(after.selection).toEqual({ objectId: 'obj-2', partIds: ['housing'] });
      expect(state.workspace.activeObjectId).toBe('obj-1'); // runTool never mutates the working copy
    });

    it('does not activate an object that is already active when it is named', async () => {
      const result = await runTool(call('select_parts', { partIds: [], objectId: 'obj-1' }), threeObjects(), idleProvider, signal);
      expect(result.stateChange?.activeObjectId).toBeNull();
    });

    it('checks part ids against the target, not the active object', async () => {
      const state = stateOver(workspaceOf(
        sceneObject('obj-1'),
        sceneObject('obj-2', { ...demoModel, parts: demoModel.parts.filter(part => part.id === 'housing') }, 1),
      ));
      const result = await runTool(call('select_parts', { partIds: ['battery'], objectId: 'obj-2' }), state, idleProvider, signal);
      expectFailure(state, result, 'INVALID_ARGS');
    });

    it('returns UNKNOWN_OBJECT for an unknown id and leaves the state alone', async () => {
      const state = threeObjects();
      const result = await runTool(call('select_parts', { partIds: [], objectId: 'nope' }), state, idleProvider, signal);
      expectFailure(state, result, 'UNKNOWN_OBJECT');
      expect(result.summary).toBe(unknownMessage('nope'));
    });

    it('returns NO_MODEL on an empty workspace, with or without objectId', async () => {
      for (const extra of [{}, { objectId: 'obj-1' }]) {
        const state = noModel();
        expectFailure(state, await runTool(call('select_parts', { partIds: [], ...extra }), state, idleProvider, signal), 'NO_MODEL');
      }
    });

    it('rejects an objectId that is not a valid id', async () => {
      const state = threeObjects();
      const result = await runTool(call('select_parts', { partIds: [], objectId: 'bad id!' }), state, idleProvider, signal);
      expectFailure(state, result, 'INVALID_ARGS');
    });
  });

  describe('explode_view', () => {
    it.each([['absent', {}], ['null', { objectId: null }]])('%s objectId means the active object', async (_name, extra) => {
      const state = threeObjects();
      const result = await runTool(call('explode_view', { amount: 0.5, ...extra }), state, idleProvider, signal);
      expect(result.stateChange).toMatchObject({ activeObjectId: null, explode: 0.5 });
      expect(result.detail).toEqual({ objectId: 'obj-1', amount: 0.5 });
      expectConsistent(state, result);
    });

    it('activates a non-active target', async () => {
      const state = threeObjects();
      const result = await runTool(call('explode_view', { amount: 1, objectId: 'obj-3' }), state, idleProvider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange).toMatchObject({ activeObjectId: 'obj-3', explode: 1 });
      expect(result.detail).toEqual({ objectId: 'obj-3', amount: 1 });
      const after = apply(state, result.stateChange);
      expect(after.activeObjectId).toBe('obj-3');
      expect(after.display.explode).toBe(1);
    });

    it('returns UNKNOWN_OBJECT and NO_MODEL without a state change', async () => {
      const state = threeObjects();
      expectFailure(state, await runTool(call('explode_view', { amount: 1, objectId: 'nope' }), state, idleProvider, signal), 'UNKNOWN_OBJECT');
      const empty = noModel();
      expectFailure(empty, await runTool(call('explode_view', { amount: 1, objectId: 'obj-1' }), empty, idleProvider, signal), 'NO_MODEL');
    });
  });

  describe('get_project_state', () => {
    it.each([['absent', {}], ['null', { objectId: null }]])('%s objectId describes the active object', async (_name, extra) => {
      const state = threeObjects({ selection: ['housing'] });
      const result = await runTool(call('get_project_state', extra), state, idleProvider, signal);
      expect(result.ok).toBe(true);
      expect(result.detail).toMatchObject({ activeObjectId: 'obj-1', target: { objectId: 'obj-1', selection: ['housing'] } });
      expect(result.stateChange).toBeNull();
    });

    it('reads another object without activating it', async () => {
      const state = threeObjects({ selection: ['housing'], explode: 0.5 });
      const result = await runTool(call('get_project_state', { objectId: 'obj-2' }), state, idleProvider, signal);
      expect(result.ok).toBe(true);
      const detail = result.detail as { objects: { id: string; active: boolean }[]; activeObjectId: string; target: { objectId: string; selection: string[]; parts: unknown[] } };
      expect(detail.activeObjectId).toBe('obj-1');
      expect(detail.objects.map(object => [object.id, object.active])).toEqual([['obj-1', true], ['obj-2', false], ['obj-3', false]]);
      expect(detail.target.objectId).toBe('obj-2');
      expect(detail.target.parts).toHaveLength(demoModel.parts.length);
      expect(detail.target.selection).toEqual([]); // the selection belongs to obj-1
      expect(result.summary).toContain('物件「手環」');
      expect(result.stateChange).toBeNull();
      expectConsistent(state, result);
    });

    it('returns UNKNOWN_OBJECT for an unknown id', async () => {
      const state = threeObjects();
      expectFailure(state, await runTool(call('get_project_state', { objectId: 'nope' }), state, idleProvider, signal), 'UNKNOWN_OBJECT');
    });

    it('still works on an empty workspace without objectId, and gives NO_MODEL with one', async () => {
      const state = noModel();
      const result = await runTool(call('get_project_state', { objectId: null }), state, idleProvider, signal);
      expect(result.ok).toBe(true);
      expect(result.detail).toMatchObject({ objects: [], activeObjectId: null, target: null });
      expectFailure(state, await runTool(call('get_project_state', { objectId: 'obj-1' }), state, idleProvider, signal), 'NO_MODEL');
    });
  });

  describe('edit_design', () => {
    const blue: Part = { ...structuredClone(demoModel.parts.find(part => part.id === 'battery')!), color: '#2563eb' };
    const plan: EditPlan = {
      status: 'applied', explanation: '把電池改成藍色。', name: null, summary: null, assumptions: null,
      operations: [{ op: 'upsert', partId: 'battery', part: blue }],
    };
    /** A provider that records every task it receives and answers with `plan`. */
    function capturing(answer: unknown = plan) {
      const tasks: ModelTask<unknown>[] = [];
      const run = async <T>(task: ModelTask<T>): Promise<T> => {
        tasks.push(task as ModelTask<unknown>);
        return answer as T;
      };
      return { provider: { name: 'openai', configured: true, model: 'test-model', run } as unknown as ModelProvider, tasks };
    }

    it.each([['absent', {}], ['null', { objectId: null }]])('%s objectId edits the active object with its selection', async (_name, extra) => {
      const { provider, tasks } = capturing();
      const state = threeObjects({ selection: ['housing'] });
      const result = await runTool(call('edit_design', { instruction: '電池改藍色', ...extra }), state, provider, signal);
      expect(result.ok).toBe(true);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.input).toContain(`"name":${JSON.stringify(demoModel.name)}`);
      expect(tasks[0]!.input).toContain('SELECTED_PART_IDS: ["housing"]');
      expect(result.stateChange).toMatchObject({
        activeObjectId: null,
        object: { op: 'model', objectId: 'obj-1' },
        selection: { objectId: 'obj-1', partIds: ['battery'] },
      });
      expect(result.detail).toMatchObject({ objectId: 'obj-1' });
      expectConsistent(state, result);
    });

    it('sends the target model and an empty selection for a non-active target, and activates it', async () => {
      const { provider, tasks } = capturing();
      const state = threeObjects({ selection: ['housing'] }); // the selection belongs to obj-1
      const result = await runTool(call('edit_design', { instruction: '電池改藍色', objectId: 'obj-2' }), state, provider, signal);
      expect(result.ok).toBe(true);
      expect(tasks[0]!.input).toContain('"name":"手環"');
      expect(tasks[0]!.input).toContain('SELECTED_PART_IDS: []');
      expect(result.stateChange).toMatchObject({
        activeObjectId: 'obj-2',
        object: { op: 'model', objectId: 'obj-2' },
        selection: { objectId: 'obj-2', partIds: ['battery'] },
      });
      expect(result.detail).toMatchObject({ objectId: 'obj-2' });
      const after = apply(state, result.stateChange);
      expect(after.activeObjectId).toBe('obj-2');
      expect(after.objects.find(object => object.id === 'obj-2')!.edited).toBe(true);
      expect(after.objects.find(object => object.id === 'obj-1')!.edited).toBe(false);
    });

    it('returns UNKNOWN_OBJECT and NO_MODEL before it calls the model', async () => {
      const { provider, tasks } = capturing();
      const state = threeObjects();
      expectFailure(state, await runTool(call('edit_design', { instruction: 'x', objectId: 'nope' }), state, provider, signal), 'UNKNOWN_OBJECT');
      const empty = noModel();
      expectFailure(empty, await runTool(call('edit_design', { instruction: 'x', objectId: 'obj-1' }), empty, provider, signal), 'NO_MODEL');
      expect(tasks).toHaveLength(0);
    });
  });
});

describe('set_active_object', () => {
  it('switches to another object', async () => {
    const state = threeObjects({ selection: ['housing'], explode: 0.5 });
    const result = await runTool(call('set_active_object', { objectId: 'obj-3' }), state, idleProvider, signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange).toEqual({ activeObjectId: 'obj-3', object: null, selection: null, explode: null, tryOn: null });
    expect(result.summary).toBe('已切換到「耳機」。');
    expect(ObjectToolDetailSchema.parse(result.detail)).toEqual({ objectId: 'obj-3', activeObjectId: 'obj-3', transform: null });
    expect(apply(state, result.stateChange).activeObjectId).toBe('obj-3');
    expectConsistent(state, result);
  });

  it('succeeds without a change when the object is already active', async () => {
    const state = threeObjects();
    const result = await runTool(call('set_active_object', { objectId: 'obj-1' }), state, idleProvider, signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange).toBeNull();
    expect(result.summary).toContain('已經是目前物件');
    expect(ObjectToolDetailSchema.parse(result.detail)).toMatchObject({ objectId: 'obj-1', activeObjectId: 'obj-1' });
  });

  it('returns UNKNOWN_OBJECT for an unknown id and NO_MODEL for an empty workspace', async () => {
    const state = threeObjects();
    const result = await runTool(call('set_active_object', { objectId: 'nope' }), state, idleProvider, signal);
    expectFailure(state, result, 'UNKNOWN_OBJECT');
    expect(result.summary).toBe(unknownMessage('nope'));
    const empty = noModel();
    expectFailure(empty, await runTool(call('set_active_object', { objectId: 'obj-1' }), empty, idleProvider, signal), 'NO_MODEL');
  });

  it('requires objectId', async () => {
    const state = threeObjects();
    for (const args of [{}, { objectId: null }]) {
      expectFailure(state, await runTool(call('set_active_object', args), state, idleProvider, signal), 'INVALID_ARGS');
    }
  });
});

describe('set_transform', () => {
  const vec = (x: number, y: number, z: number) => ({ x, y, z });

  it('moves the active object and keeps its rotation', async () => {
    const state = withModel();
    const result = await runTool(call('set_transform', { objectId: 'obj-1', position: vec(0.5, 0, -1) }), state, idleProvider, signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange).toEqual({
      activeObjectId: null, selection: null, explode: null, tryOn: null,
      object: { op: 'transform', objectId: 'obj-1', transform: { position: vec(0.5, 0, -1), rotation: vec(0, 0, 0) } },
    });
    expect(ObjectToolDetailSchema.parse(result.detail)).toEqual({
      objectId: 'obj-1', activeObjectId: 'obj-1', transform: { position: vec(0.5, 0, -1), rotation: vec(0, 0, 0) },
    });
    expect(apply(state, result.stateChange).objects[0]!.transform.position).toEqual(vec(0.5, 0, -1));
    expectConsistent(state, result);
  });

  it('rotates an object and keeps its position', async () => {
    const state = threeObjects();
    const result = await runTool(call('set_transform', { objectId: 'obj-2', rotation: vec(0, 90, 0) }), state, idleProvider, signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange?.object).toEqual({
      op: 'transform', objectId: 'obj-2', transform: { position: vec(1, 0, 0), rotation: vec(0, 90, 0) },
    });
    expectConsistent(state, result);
  });

  it('sets position and rotation together; null counts as not given', async () => {
    const state = threeObjects();
    const result = await runTool(
      call('set_transform', { objectId: 'obj-1', position: vec(1, 2, 3), rotation: vec(10, 20, 30) }), state, idleProvider, signal,
    );
    expect(result.stateChange?.object).toMatchObject({ transform: { position: vec(1, 2, 3), rotation: vec(10, 20, 30) } });
    const half = await runTool(call('set_transform', { objectId: 'obj-1', position: vec(1, 2, 3), rotation: null }), state, idleProvider, signal);
    expect(half.ok).toBe(true);
    expect(half.stateChange?.object).toMatchObject({ transform: { position: vec(1, 2, 3), rotation: vec(0, 0, 0) } });
  });

  it('activates a non-active target and does not touch the other objects', async () => {
    const state = threeObjects({ selection: ['housing'] });
    const result = await runTool(call('set_transform', { objectId: 'obj-3', position: vec(0, 0, 2) }), state, idleProvider, signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange).toMatchObject({ activeObjectId: 'obj-3', object: { op: 'transform', objectId: 'obj-3' } });
    expect(ObjectToolDetailSchema.parse(result.detail)).toMatchObject({ objectId: 'obj-3', activeObjectId: 'obj-3' });
    const after = apply(state, result.stateChange);
    expect(after.activeObjectId).toBe('obj-3');
    expect(after.objects.map(object => object.transform.position.x)).toEqual([0, 1, 0]);
    expect(after.objects[2]!.transform.position.z).toBe(2);
    expect(state.workspace.objects[2]!.transform.position.z).toBe(0);
  });

  it('with neither position nor rotation returns INVALID_ARGS and the fixed message', async () => {
    const state = threeObjects();
    for (const args of [{ objectId: 'obj-1' }, { objectId: 'obj-1', position: null, rotation: null }]) {
      const result = await runTool(call('set_transform', args), state, idleProvider, signal);
      expectFailure(state, result, 'INVALID_ARGS');
      expect(result.summary).toBe('請至少提供 position 或 rotation。');
    }
  });

  it.each([
    ['a position over 100 m', { position: { x: 101, y: 0, z: 0 } }],
    ['a rotation over 360 degrees', { rotation: { x: 0, y: 361, z: 0 } }],
    ['a partial position', { position: { x: 1 } }],
    ['an unknown key', { scale: 2 }],
  ])('rejects %s as INVALID_ARGS', async (_name, extra) => {
    const state = threeObjects();
    expectFailure(state, await runTool(call('set_transform', { objectId: 'obj-1', ...extra }), state, idleProvider, signal), 'INVALID_ARGS');
  });

  it('returns UNKNOWN_OBJECT and NO_MODEL without a state change', async () => {
    const state = threeObjects();
    const unknown = await runTool(call('set_transform', { objectId: 'nope', position: vec(0, 0, 0) }), state, idleProvider, signal);
    expectFailure(state, unknown, 'UNKNOWN_OBJECT');
    expect(unknown.summary).toBe(unknownMessage('nope'));
    const empty = noModel();
    expectFailure(empty, await runTool(call('set_transform', { objectId: 'obj-1', position: vec(0, 0, 0) }), empty, idleProvider, signal), 'NO_MODEL');
  });

  it('requires objectId', async () => {
    const state = threeObjects();
    expectFailure(state, await runTool(call('set_transform', { position: vec(0, 0, 0) }), state, idleProvider, signal), 'INVALID_ARGS');
  });
});

describe('remove_object', () => {
  it('removes the active object; the neighbour becomes active', async () => {
    const state = threeObjects({ selection: ['housing'] });
    const result = await runTool(call('remove_object', { objectId: 'obj-1' }), state, idleProvider, signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange).toEqual({
      activeObjectId: null, object: { op: 'remove', objectId: 'obj-1' }, selection: null, explode: null, tryOn: null,
    });
    expect(result.summary).toBe(`已移除「${demoModel.name}」，工作區剩 2 個物件。`);
    expect(ObjectToolDetailSchema.parse(result.detail)).toEqual({ objectId: 'obj-1', activeObjectId: 'obj-2', transform: null });
    const after = apply(state, result.stateChange);
    expect(after.objects.map(object => object.id)).toEqual(['obj-2', 'obj-3']);
    expect(after.activeObjectId).toBe('obj-2');
    expect(after.selection.partIds).toEqual([]);
    expect(state.workspace.objects).toHaveLength(3);
    expectConsistent(state, result);
  });

  it('removes another object and keeps the active one, its selection and the explode amount', async () => {
    const state = threeObjects({ selection: ['housing'], explode: 0.5 });
    const result = await runTool(call('remove_object', { objectId: 'obj-3' }), state, idleProvider, signal);
    expect(result.ok).toBe(true);
    expect(result.stateChange?.activeObjectId).toBeNull();
    expect(ObjectToolDetailSchema.parse(result.detail)).toMatchObject({ objectId: 'obj-3', activeObjectId: 'obj-1' });
    const after = apply(state, result.stateChange);
    expect(after.objects.map(object => object.id)).toEqual(['obj-1', 'obj-2']);
    expect(after.activeObjectId).toBe('obj-1');
    expect(after.selection).toEqual({ objectId: 'obj-1', partIds: ['housing'] });
    expect(after.display.explode).toBe(0.5);
  });

  it('removes the last object and leaves an empty workspace', async () => {
    const state = withModel();
    const result = await runTool(call('remove_object', { objectId: 'obj-1' }), state, idleProvider, signal);
    expect(result.ok).toBe(true);
    expect(ObjectToolDetailSchema.parse(result.detail)).toMatchObject({ objectId: 'obj-1', activeObjectId: null });
    const after = apply(state, result.stateChange);
    expect(after.objects).toEqual([]);
    expect(after.activeObjectId).toBeNull();
    expect(result.summary).toContain('剩 0 個物件');
  });

  it('returns UNKNOWN_OBJECT for an unknown id and NO_MODEL for an empty workspace', async () => {
    const state = threeObjects();
    const result = await runTool(call('remove_object', { objectId: 'nope' }), state, idleProvider, signal);
    expectFailure(state, result, 'UNKNOWN_OBJECT');
    expect(result.summary).toBe(unknownMessage('nope'));
    const empty = noModel();
    expectFailure(empty, await runTool(call('remove_object', { objectId: 'obj-1' }), empty, idleProvider, signal), 'NO_MODEL');
  });

  it('requires objectId: it never falls back to the active object', async () => {
    const state = threeObjects();
    for (const args of [{}, { objectId: null }]) {
      expectFailure(state, await runTool(call('remove_object', args), state, idleProvider, signal), 'INVALID_ARGS');
    }
  });
});
