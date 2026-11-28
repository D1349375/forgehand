import { describe, expect, it } from 'vitest';
import { runTool, type AgentWorkingState } from '../../server/agent-tools';
import { PULL_OUT_TEXT } from '../../server/i18n/pull-out';
import type { ModelProvider } from '../../server/provider';
import { PullOutDetailSchema, StateChangeSchema, ToolResultSchema, type StateChange, type ToolResult } from '../../shared/agent';
import {
  MAX_OBJECTS, WorkspaceError, addJoint, addObject, applyWorkspaceChange, emptyWorkspace, findObject, setActiveObject,
  type Workspace, type WorkspaceErrorCode,
} from '../../shared/workspace';
import { applyStateEvent } from '../../src/agent/apply-state';
import { BOX, boxModel, fixtureJoint, fixtureModel, fixtureObject, fixturePart, side } from '../fixtures/joint-workspace';
import { idCounter, noModel, sceneObject, stateOver, workspaceOf } from './agent-fixtures';

/**
 * Workbench-ui Task 2: the `pull_out_part` tool and `create_joint` on two parts of one object. A fake provider
 * never runs: neither tool calls a model.
 */

const call = (tool: string, args: Record<string, unknown> = {}) => ({ tool, argsJson: JSON.stringify(args), reason: null });
const signal = new AbortController().signal;
const idleProvider = { name: 'openai', configured: true, model: 'm' } as unknown as ModelProvider;
const NOW = '2026-11-28T10:00:00.000Z';
const vec = (x: number, y: number, z: number) => ({ x, y, z });
const flat = { position: vec(0, 0, 0), rotation: vec(0, 0, 0) };

const run = (state: AgentWorkingState, tool: string, args: Record<string, unknown> = {}) =>
  runTool(call(tool, args), state, idleProvider, signal, { newObjectId: idCounter('new'), now: () => NOW });

const apply = (state: AgentWorkingState, change: StateChange | null | undefined): Workspace => {
  if (!change) throw new Error('expected a state change');
  const { tryOn: _tryOn, ...workspaceChange } = change;
  return applyWorkspaceChange(state.workspace, workspaceChange).after;
};

function expectConsistent(state: AgentWorkingState, result: ToolResult): void {
  expect(ToolResultSchema.safeParse(result).success).toBe(true);
  if (result.stateChange) {
    expect(StateChangeSchema.safeParse(result.stateChange).success).toBe(true);
    expect(() => apply(state, result.stateChange)).not.toThrow();
  }
}

function expectFailure(state: AgentWorkingState, result: ToolResult, code: string, message?: string): void {
  expect(result.ok).toBe(false);
  expect(result.detail).toMatchObject({ code });
  expect(result.stateChange).toBeNull();
  if (message !== undefined) expect(result.summary).toBe(message);
  expectConsistent(state, result);
}

/** The Traditional Chinese refusal text of a workspace error code. */
const refusal = (code: WorkspaceErrorCode) => new WorkspaceError(code).message;

/** An object `one` with the roots `left` and `right` side by side and touching. */
const twoParts = () => fixtureObject('one', fixtureModel('Two parts', [
  fixturePart('left', 'box', BOX, vec(-BOX.x / 2, 0, 0)),
  fixturePart('right', 'box', BOX, vec(BOX.x / 2, 0, 0)),
]), flat);

describe('pull_out_part', () => {
  it('pulls the battery out beside the original and returns the change and the detail', async () => {
    const state = stateOver(workspaceOf(sceneObject('obj-1')));
    const result = await run(state, 'pull_out_part', { partId: 'battery' });
    expect(result.ok).toBe(true);
    expectConsistent(state, result);
    expect(result.stateChange).toEqual({
      activeObjectId: null,
      object: { op: 'pull-out', objectId: 'obj-1', partId: 'battery', newObjectId: 'new-1', createdAt: NOW },
      selection: null, explode: null, tryOn: null,
    });
    expect(PullOutDetailSchema.parse(result.detail)).toEqual({
      objectId: 'obj-1', partId: 'battery', newObjectId: 'new-1', partIds: ['battery'], inPlace: false, jointsMoved: 0,
    });
    expect(result.summary).toBe('已把「側邊電池」（含 0 個子零件）拉出成新物件「側邊電池」，放在「雙鏡頭概念裝置」旁邊。');

    const after = apply(state, result.stateChange);
    expect(after.objects.map(object => object.id)).toEqual(['obj-1', 'new-1']);
    expect(after.activeObjectId).toBe('obj-1');
    expect(findObject(after, 'new-1')!.model.parts.map(part => part.id)).toEqual(['battery']);
    expect(findObject(after, 'obj-1')!.model.parts.some(part => part.id === 'battery')).toBe(false);
  });

  it('takes the child parts along and counts them in the summary', async () => {
    const state = stateOver(workspaceOf(sceneObject('obj-1')));
    const result = await run(state, 'pull_out_part', { partId: 'housing' });
    expect(result.ok).toBe(true);
    const detail = PullOutDetailSchema.parse(result.detail);
    expect(detail.partIds[0]).toBe('housing');
    expect(detail.partIds).toHaveLength(7);
    expect(result.summary).toContain('（含 6 個子零件）');
    const after = apply(state, result.stateChange);
    expect(findObject(after, 'obj-1')!.model.parts.map(part => part.id)).toEqual(['support', 'base']);
  });

  it('defaults objectId to the active object, and an explicit or null objectId picks the named one', async () => {
    const ws = setActiveObject(workspaceOf(sceneObject('first'), sceneObject('second', undefined, 2)), 'second');
    const state = stateOver(ws);
    const byDefault = await run(state, 'pull_out_part', { partId: 'battery' });
    expect(byDefault.stateChange!.object).toMatchObject({ op: 'pull-out', objectId: 'second' });
    const withNull = await run(state, 'pull_out_part', { partId: 'battery', objectId: null });
    expect(withNull.stateChange!.object).toMatchObject({ objectId: 'second' });
    const named = await run(state, 'pull_out_part', { partId: 'battery', objectId: 'first' });
    expect(named.ok).toBe(true);
    expect(named.stateChange!.object).toMatchObject({ objectId: 'first' });
    expect(apply(state, named.stateChange).activeObjectId).toBe('second');
  });

  it('keeps a part that a joint holds in place, and counts the joints that moved with it', async () => {
    let ws = addObject(emptyWorkspace(), twoParts());
    ws = addObject(ws, fixtureObject('b', boxModel('Block B'), { position: vec(BOX.x + BOX.x / 2, 0, 0), rotation: vec(0, 0, 0) }));
    ws = addJoint(ws, fixtureJoint(side('one', 'right', '+x'), side('b', 'body', '-x')));
    const state = stateOver(setActiveObject(ws, 'one'));
    const result = await run(state, 'pull_out_part', { partId: 'right' });
    expect(result.ok).toBe(true);
    expect(PullOutDetailSchema.parse(result.detail)).toMatchObject({ inPlace: true, jointsMoved: 1, partIds: ['right'] });
    expect(result.summary).toBe('已把「right」（含 0 個子零件）拉出成新物件「right」，原位保留並與原接合相連。');
    const after = apply(state, result.stateChange);
    expect(after.joints[0]!.a.objectId).toBe('new-1');
    expect(after.joints[0]!.b.objectId).toBe('b');
  });

  it('answers in English when the request language is English', async () => {
    const state: AgentWorkingState = { ...stateOver(workspaceOf(sceneObject('obj-1'))), lang: 'en' };
    const result = await run(state, 'pull_out_part', { partId: 'battery' });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(PULL_OUT_TEXT.en.beside({ part: '側邊電池', count: 0, name: '側邊電池', original: '雙鏡頭概念裝置' }));
    expect(result.summary).toContain('next to');
    const unknown = await run(state, 'pull_out_part', { partId: 'ghost' });
    expectFailure(state, unknown, 'UNKNOWN_PART', PULL_OUT_TEXT.en.errors.unknownPart);
  });

  it('returns each error with its fixed message and no state change', async () => {
    const state = stateOver(workspaceOf(sceneObject('obj-1')));
    expectFailure(noModel(), await run(noModel(), 'pull_out_part', { partId: 'battery' }), 'NO_MODEL');
    expectFailure(state, await run(state, 'pull_out_part', { partId: 'battery', objectId: 'nope' }), 'UNKNOWN_OBJECT', '工作區沒有 id 為「nope」的物件。');
    expectFailure(state, await run(state, 'pull_out_part', { partId: 'ghost' }), 'UNKNOWN_PART', refusal('UNKNOWN_PART'));

    const single = stateOver(workspaceOf(fixtureObject('solo', boxModel('Solo'), flat)));
    expectFailure(single, await run(single, 'pull_out_part', { partId: 'body' }), 'WHOLE_OBJECT', refusal('WHOLE_OBJECT'));

    const full = stateOver(workspaceOf(...Array.from({ length: MAX_OBJECTS }, (_, index) => sceneObject(`o${index}`, undefined, index))));
    expectFailure(full, await run(full, 'pull_out_part', { partId: 'battery' }), 'OBJECT_LIMIT', refusal('OBJECT_LIMIT'));
  });

  it('rejects unknown arguments and a missing partId without running', async () => {
    const state = stateOver(workspaceOf(sceneObject('obj-1')));
    expect((await run(state, 'pull_out_part', {})).ok).toBe(false);
    expect((await run(state, 'pull_out_part', { partId: 'battery', extra: 1 })).ok).toBe(false);
  });

  it('keeps the Traditional Chinese refusals identical to the workspace messages', () => {
    const { errors } = PULL_OUT_TEXT['zh-TW'];
    expect(errors.unknownObject).toBe(refusal('UNKNOWN_OBJECT'));
    expect(errors.unknownPart).toBe(refusal('UNKNOWN_PART'));
    expect(errors.wholeObject).toBe(refusal('WHOLE_OBJECT'));
    expect(errors.objectLimit({ max: MAX_OBJECTS })).toBe(refusal('OBJECT_LIMIT'));
    expect(PULL_OUT_TEXT['zh-TW'].label).toBe('拉出零件');
  });

  it('gives a change that applyStateEvent turns into one undo step with objectOp pull-out', async () => {
    const state = stateOver(workspaceOf(sceneObject('obj-1')));
    const result = await run(state, 'pull_out_part', { partId: 'battery' });
    const effects = applyStateEvent(result.stateChange, state.workspace);
    expect(effects).not.toBeNull();
    expect(effects!.objectOp).toBe('pull-out');
    expect(effects!.recordUndo).toBe(true);
    expect(effects!.after.objects).toHaveLength(2);
  });
});

describe('create_joint on two parts of one object', () => {
  const joinOne = { a: { objectId: 'one', partId: 'left' }, b: { objectId: 'one', partId: 'right' } };

  it('pulls side b out in place and joins the two objects, as one change', async () => {
    const state = stateOver(addObject(emptyWorkspace(), twoParts()));
    const result = await run(state, 'create_joint', joinOne);
    expect(result.ok).toBe(true);
    expectConsistent(state, result);
    expect(result.stateChange!.object).toEqual({
      op: 'pull-out', objectId: 'one', partId: 'right', newObjectId: 'new-1', createdAt: NOW, inPlace: true,
    });
    expect(result.stateChange!.joint).toMatchObject({ op: 'add', joint: { id: 'new-2' } });
    const after = apply(state, result.stateChange);
    expect(after.objects.map(object => object.id)).toEqual(['one', 'new-1']);
    expect(after.joints).toHaveLength(1);
    expect(after.joints[0]).toMatchObject({ a: side('one', 'left', '+x'), b: side('new-1', 'right', '-x') });
    expect(result.summary).toContain('「right」已拉出成新物件。');
    expect(result.summary).toContain('已建立接合');
  });

  it('pulls out the descendant when one side is the ancestor of the other', async () => {
    const parent = fixturePart('parent', 'box', BOX);
    const child = { ...fixturePart('child', 'box', BOX, vec(BOX.x, 0, 0)), parentId: 'parent' };
    const state = stateOver(addObject(emptyWorkspace(), fixtureObject('one', fixtureModel('Tree', [parent, child]), flat)));
    // The ancestor is side b here, so the descendant on side a is the one that leaves.
    const result = await run(state, 'create_joint', { a: { objectId: 'one', partId: 'child' }, b: { objectId: 'one', partId: 'parent' } });
    expect(result.ok).toBe(true);
    expect(result.stateChange!.object).toMatchObject({ op: 'pull-out', partId: 'child', inPlace: true });
    const after = apply(state, result.stateChange);
    expect(after.joints[0]!.a.objectId).toBe('new-1');
    expect(after.joints[0]!.b.objectId).toBe('one');
  });

  it('says in English that the part became its own object when the request language is English', async () => {
    const state: AgentWorkingState = { ...stateOver(addObject(emptyWorkspace(), twoParts())), lang: 'en' };
    const result = await run(state, 'create_joint', joinOne);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain(PULL_OUT_TEXT.en.joinPulled({ part: 'right' }));
  });

  it('refuses with the object limit message when there is no room for the new object', async () => {
    let ws = addObject(emptyWorkspace(), twoParts());
    for (let index = 1; index < MAX_OBJECTS; index += 1) {
      ws = addObject(ws, fixtureObject(`f${index}`, boxModel(`Filler ${index}`), { position: vec(1 + index, 0, 0), rotation: vec(0, 0, 0) }));
    }
    const state = stateOver(setActiveObject(ws, 'one'));
    expect(state.workspace.objects).toHaveLength(MAX_OBJECTS);
    expectFailure(state, await run(state, 'create_joint', joinOne), 'OBJECT_LIMIT', refusal('OBJECT_LIMIT'));
  });

  it('leaves a join between two objects unchanged: no pull-out and no pulled line in the summary', async () => {
    let ws = addObject(emptyWorkspace(), fixtureObject('a', boxModel('Block A'), flat));
    ws = addObject(ws, fixtureObject('b', boxModel('Block B'), { position: vec(BOX.x, 0, 0), rotation: vec(0, 0, 0) }));
    const state = stateOver(ws);
    const result = await run(state, 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'b' } });
    expect(result.ok).toBe(true);
    expect(result.stateChange!.object).toBeNull();
    expect(result.stateChange!.joint).toMatchObject({ op: 'add', joint: { id: 'new-1' } });
    expect(result.summary).not.toContain('已拉出成新物件');
  });
});
