import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import { applyWorkspaceChange } from '../../shared/workspace';
import { SetCameraImageDetailSchema, StateChangeSchema } from '../../shared/agent';
import { runTool } from '../../server/agent-tools';
import { checkedChange } from '../../server/tools/helpers';
import type { ModelProvider } from '../../server/provider';
import { noModel, sceneObject, stateOver, withModel, workspaceOf } from './agent-fixtures';

const call = (tool: string, args: Record<string, unknown> = {}) => ({ tool, argsJson: JSON.stringify(args), reason: null });
const rawCall = (tool: string, argsJson: string) => ({ tool, argsJson, reason: null });

const provider = { name: 'openai', configured: true, model: 'm' } as unknown as ModelProvider;
const signal = new AbortController().signal;

/** Two objects: `obj-1` is active, `obj-2` is beside it. The tools act on the active one. */
const twoObjects = (options: Parameters<typeof stateOver>[1] = {}) =>
  stateOver(workspaceOf(sceneObject('obj-1'), sceneObject('obj-2', demoModel, 1)), options);

describe('agent local tools', () => {
  describe('select_parts', () => {
    it('returns the new selection as a stateChange and does not mutate the working copy', async () => {
      const state = withModel({ selection: ['battery'] });
      const result = await runTool(call('select_parts', { partIds: ['housing', 'battery'] }), state, provider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange?.selection).toEqual({ objectId: 'obj-1', partIds: ['housing', 'battery'] });
      expect(result.stateChange?.activeObjectId).toBeNull(); // obj-1 is already active
      expect(result.stateChange?.object).toBeNull();
      expect(result.stateChange?.explode).toBeNull();
      expect(result.stateChange?.tryOn).toBeNull();
      expect(result.detail).toEqual({ objectId: 'obj-1', selection: ['housing', 'battery'] });
      expect(state.workspace.selection.partIds).toEqual(['battery']); // runTool is pure; the loop applies stateChange
    });
    it('acts on the active object when the workspace has several', async () => {
      const result = await runTool(call('select_parts', { partIds: ['housing'] }), twoObjects(), provider, signal);
      expect(result.stateChange?.selection).toEqual({ objectId: 'obj-1', partIds: ['housing'] });
    });
    it('clears the selection with an empty list', async () => {
      const result = await runTool(call('select_parts', { partIds: [] }), withModel({ selection: ['battery'] }), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.summary).toBe('已取消選取。');
      expect(result.stateChange?.selection).toEqual({ objectId: 'obj-1', partIds: [] });
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
      expect(result.detail).toMatchObject({
        activeObjectId: 'obj-1', tryOn: true,
        target: { objectId: 'obj-1', selection: ['housing'], explode: 0.5 },
      });
      const detail = result.detail as { target: { parts: unknown[] }; objects: unknown[] };
      expect(detail.target.parts).toHaveLength(demoModel.parts.length);
      expect(detail.objects).toEqual([{
        id: 'obj-1', name: demoModel.name, partCount: demoModel.parts.length,
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, active: true, material: null,
      }]);
      expect(result.stateChange).toBeNull();
    });
    it('lists every object and describes the active one as the target', async () => {
      const result = await runTool(call('get_project_state', {}), twoObjects(), provider, signal);
      const detail = result.detail as { objects: { id: string; active: boolean; position: { x: number } }[]; target: { objectId: string } };
      expect(detail.objects.map(object => [object.id, object.active, object.position.x])).toEqual([['obj-1', true, 0], ['obj-2', false, 1]]);
      expect(detail.target.objectId).toBe('obj-1');
    });
    it('works on an empty workspace (no objects, no target)', async () => {
      const result = await runTool(call('get_project_state', {}), noModel(), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.detail).toMatchObject({ objects: [], activeObjectId: null, target: null, tryOn: false });
      expect(result.stateChange).toBeNull();
    });
  });

  describe('explode_view', () => {
    it.each([[0], [0.5], [1]])('sets explode for a valid amount (%s)', async (amount) => {
      const result = await runTool(call('explode_view', { amount }), withModel(), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange?.explode).toBe(amount);
      expect(result.stateChange).toMatchObject({ activeObjectId: null, object: null, selection: null, tryOn: null });
      expect(result.detail).toEqual({ objectId: 'obj-1', amount });
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

  describe('set_camera_image', () => {
    it('hides the image when visible is false and the camera is on', async () => {
      const result = await runTool(call('set_camera_image', { visible: false }), withModel({ cameraOn: true }), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.summary).toBe('已隱藏鏡頭畫面（手部追蹤持續進行）。');
      expect(result.stateChange).toEqual({ activeObjectId: null, object: null, selection: null, explode: null, tryOn: null, cameraHidden: true });
      expect(SetCameraImageDetailSchema.parse(result.detail)).toEqual({ visible: false, cameraOn: true, message: result.summary });
    });
    it('shows the image when visible is true and the camera is on', async () => {
      const result = await runTool(call('set_camera_image', { visible: true }), withModel({ cameraOn: true }), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.summary).toBe('已顯示鏡頭畫面。');
      expect(result.stateChange).toEqual({ activeObjectId: null, object: null, selection: null, explode: null, tryOn: null, cameraHidden: false });
      expect(SetCameraImageDetailSchema.parse(result.detail)).toEqual({ visible: true, cameraOn: true, message: '已顯示鏡頭畫面。' });
    });
    it.each([[true], [false]])('asks the user to turn the camera on when it is off (visible %s): ok:false and no state change', async (visible) => {
      const result = await runTool(call('set_camera_image', { visible }), withModel({ cameraOn: false }), provider, signal);
      expect(result.ok).toBe(false);
      expect(result.summary).toBe('請先開啟攝影機。');
      expect(result.stateChange).toBeNull();
      expect(SetCameraImageDetailSchema.parse(result.detail)).toMatchObject({ visible, cameraOn: false, message: '請先開啟攝影機。' });
    });
    it('needs no model: it works on an empty workspace', async () => {
      const result = await runTool(call('set_camera_image', { visible: false }), noModel({ cameraOn: true }), provider, signal);
      expect(result.ok).toBe(true);
      expect(result.stateChange?.cameraHidden).toBe(true);
    });
    it('carries a state change the schema accepts, and checkedChange accepts it like tryOn', async () => {
      const state = twoObjects({ cameraOn: true });
      const result = await runTool(call('set_camera_image', { visible: false }), state, provider, signal);
      expect(StateChangeSchema.safeParse(result.stateChange).success).toBe(true);
      expect(checkedChange(state, 'set_camera_image', result.stateChange!)).toBeNull();
      // The workspace itself does not change.
      const { tryOn: _tryOn, cameraHidden: _cameraHidden, ...change } = result.stateChange!;
      expect(applyWorkspaceChange(state.workspace, change).after).toEqual(state.workspace);
    });
  });

  describe('workspace changes', () => {
    it.each([
      ['select_parts', { partIds: ['housing'] }],
      ['explode_view', { amount: 0.5 }],
      ['wear_on_arm', { enabled: true }],
    ])('%s returns a change that applies to the working workspace', async (tool, args) => {
      const state = twoObjects({ cameraOn: true });
      const result = await runTool(call(tool, args), state, provider, signal);
      expect(result.ok).toBe(true);
      const { tryOn: _tryOn, ...change } = result.stateChange!;
      const { after } = applyWorkspaceChange(state.workspace, change);
      expect(after.activeObjectId).toBe('obj-1');
      if (tool === 'select_parts') expect(after.selection).toEqual({ objectId: 'obj-1', partIds: ['housing'] });
      if (tool === 'explode_view') expect(after.display.explode).toBe(0.5);
    });
    it('wear_on_arm changes only tryOn', async () => {
      const result = await runTool(call('wear_on_arm', { enabled: true }), withModel({ cameraOn: true }), provider, signal);
      expect(result.stateChange).toEqual({ activeObjectId: null, object: null, selection: null, explode: null, tryOn: true });
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
      ['set_camera_image: not an object', rawCall('set_camera_image', 'false')],
      ['set_camera_image: bad JSON', rawCall('set_camera_image', '{visible:')],
      ['set_camera_image: missing visible', call('set_camera_image', {})],
      ['set_camera_image: wrong type', call('set_camera_image', { visible: 'no' })],
      ['set_camera_image: stray key', call('set_camera_image', { visible: true, extra: 1 })],
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
      expect(missing.summary).toContain('explode_view(amount: number, objectId?: string | null)');

      const wrongType = await runTool(call('explode_view', { amount: 'lots' }), withModel(), provider, signal);
      expect(wrongType.summary).toContain('參數 amount 的值不正確');
      expect(wrongType.summary).not.toContain('lots');
      expect(wrongType.summary).not.toMatch(/expected|invalid_type|received/i);

      const badJson = await runTool(rawCall('select_parts', '{oops'), withModel(), provider, signal);
      expect(badJson.summary).toContain('不是有效的 JSON');
      expect(badJson.summary).toContain('select_parts(partIds: string[], objectId?: string | null)');
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
