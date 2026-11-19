import { describe, expect, it } from 'vitest';
import { validateModel, type ModelSpec } from '../../shared/model';
import {
  addJoint, addObject, emptyWorkspace, findObject, joinObjects, removeJoint, removeObject, replaceModel, selectParts, setActiveObject,
  setExplode, setMaterial, setTransform, updateJoint,
  type SceneObject, type Workspace,
} from '../../shared/workspace';
import { fixtureJoint, side, twoBoxes } from '../fixtures/joint-workspace';
import {
  HISTORY_LIMIT, canRedo, canUndo, initialWorkspaceState, restoreSnapshot, workspaceReducer,
  type WorkspaceAction, type WorkspaceState,
} from '../../src/workspace/store';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const CREATED_AT = '2026-11-20T08:00:00.000Z';
function boxModel(partIds: string[] = ['body'], name = 'Slab'): ModelSpec {
  return validateModel({
    schemaVersion: '1.0', name, summary: 'Boxes.', units: 'm', assumptions: [],
    parts: partIds.map((id, index) => ({
      id, name: id, parentId: null, primitive: 'box', dimensions: vec(2, 1, 4), position: vec(index * 0.01, 0, 0),
      rotation: vec(0, 0, 0), color: '#336699', role: 'exterior', tubeRatio: 0.3,
    })),
  });
}
function object(id: string, model = boxModel()): SceneObject {
  return { id, model, transform: { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }, source: 'test', providerModel: 'fake', edited: false, material: null, createdAt: CREATED_AT };
}
const run = (state: WorkspaceState, ...actions: WorkspaceAction[]) => actions.reduce(workspaceReducer, state);
const commit = (next: Workspace, before?: Workspace): WorkspaceAction => ({ type: 'commit', next, ...(before ? { before } : {}) });
/** A state with the given objects, built by commits (the first add records nothing). */
function stateWith(...objects: SceneObject[]): WorkspaceState {
  let state = initialWorkspaceState;
  for (const next of objects) state = run(state, commit(addObject(state.workspace, next)));
  return state;
}

describe('workspaceReducer commit', () => {
  it('starts empty with no history', () => {
    expect(initialWorkspaceState.workspace).toEqual(emptyWorkspace());
    expect(canUndo(initialWorkspaceState)).toBe(false);
    expect(canRedo(initialWorkspaceState)).toBe(false);
  });
  it('records the previous snapshot and clears future', () => {
    const one = stateWith(object('a'));
    const two = run(one, commit(addObject(one.workspace, object('b'))));
    expect(two.workspace.objects.map(o => o.id)).toEqual(['a', 'b']);
    expect(two.past).toEqual([{ objects: one.workspace.objects, activeObjectId: 'a', joints: [] }]);
    const undone = run(two, { type: 'undo' });
    expect(undone.future).toHaveLength(1);
    const again = run(undone, commit(addObject(undone.workspace, object('c'))));
    expect(again.future).toEqual([]);
    expect(canRedo(again)).toBe(false);
  });
  it('records nothing for the first object while history is empty', () => {
    const state = run(initialWorkspaceState, commit(addObject(initialWorkspaceState.workspace, object('a'))));
    expect(state.workspace.objects).toHaveLength(1);
    expect(state.past).toEqual([]);
    expect(canUndo(state)).toBe(false);
  });
  it('records a later add to an emptied workspace', () => {
    let state = stateWith(object('a'));
    state = run(state, commit(replaceModel(state.workspace, 'a', boxModel(['body', 'lid']))));
    state = run(state, commit(removeObject(state.workspace, 'a')));
    expect(state.workspace.objects).toEqual([]);
    expect(state.past).toHaveLength(2);
    state = run(state, commit(addObject(state.workspace, object('b'))));
    expect(state.past).toHaveLength(3);
    expect(state.past[2]).toEqual({ objects: [], activeObjectId: null, joints: [] });
  });
  it('records an add to an emptied workspace even when it is the only history entry', () => {
    let state = stateWith(object('a'));
    state = run(state, commit(removeObject(state.workspace, 'a')));
    expect(state.past).toHaveLength(1);
    state = run(state, commit(addObject(state.workspace, object('b'))));
    expect(state.past).toHaveLength(2);
  });
  it('is a no-op for the unchanged workspace', () => {
    const state = stateWith(object('a'));
    expect(run(state, commit(state.workspace))).toBe(state);
    const undoable = run(state, commit(replaceModel(state.workspace, 'a', boxModel(['x']))));
    expect(run(undoable, commit(undoable.workspace))).toBe(undoable);
  });
  it('uses `before` as the undo snapshot when given', () => {
    const both = stateWith(object('a'), object('b'));
    const state = run(both, { type: 'replace', next: setActiveObject(both.workspace, 'a') });
    const current = state.workspace;
    const before = setActiveObject(current, 'b');
    const next = replaceModel(before, 'b', boxModel(['x']));
    const after = run(state, commit(next, before));
    expect(after.past.at(-1)).toEqual({ objects: before.objects, activeObjectId: 'b', joints: [] });
    const undone = run(after, { type: 'undo' });
    expect(undone.workspace.activeObjectId).toBe('b');
    expect(findObject(undone.workspace, 'b')!.model.parts[0]!.id).toBe('body');
  });
  it('keeps at most HISTORY_LIMIT steps and drops the oldest', () => {
    expect(HISTORY_LIMIT).toBe(50);
    let state = stateWith(object('a'));
    for (let step = 1; step <= 60; step++) state = run(state, commit(setTransform(state.workspace, 'a', { position: vec(step, 0, 0) })));
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    expect(state.past[0]!.objects[0]!.transform.position.x).toBe(10);
    expect(state.past.at(-1)!.objects[0]!.transform.position.x).toBe(59);
    for (let step = 0; step < 100; step++) state = run(state, { type: 'undo' });
    expect(state.past).toEqual([]);
    expect(state.future).toHaveLength(HISTORY_LIMIT);
    expect(state.workspace.objects[0]!.transform.position.x).toBe(10);
  });
  it('caps future at HISTORY_LIMIT on undo', () => {
    let state = stateWith(object('a'));
    for (let step = 1; step <= 50; step++) state = run(state, commit(setTransform(state.workspace, 'a', { position: vec(step, 0, 0) })));
    for (let step = 0; step < 50; step++) state = run(state, { type: 'undo' });
    for (let step = 0; step < 50; step++) state = run(state, { type: 'redo' });
    expect(state.past).toHaveLength(50);
    expect(state.future).toEqual([]);
  });
});

describe('workspaceReducer undo and redo', () => {
  it('undoes and redoes a model change', () => {
    const start = stateWith(object('a'));
    const edited = run(start, commit(replaceModel(start.workspace, 'a', boxModel(['body', 'lid']))));
    const undone = run(edited, { type: 'undo' });
    expect(undone.workspace.objects).toBe(start.workspace.objects);
    expect(canUndo(undone)).toBe(false);
    expect(canRedo(undone)).toBe(true);
    const redone = run(undone, { type: 'redo' });
    expect(redone.workspace.objects).toBe(edited.workspace.objects);
    expect(canUndo(redone)).toBe(true);
    expect(canRedo(redone)).toBe(false);
  });
  it('does nothing without history', () => {
    const state = stateWith(object('a'));
    expect(run(state, { type: 'undo' })).toBe(state);
    expect(run(state, { type: 'redo' })).toBe(state);
    expect(run(initialWorkspaceState, { type: 'undo' })).toBe(initialWorkspaceState);
  });
  it('restores the active object as it was when the step was recorded', () => {
    let state = stateWith(object('a'), object('b'));
    state = run(state, commit(removeObject(state.workspace, 'b')));
    expect(state.workspace.activeObjectId).toBe('a');
    state = run(state, { type: 'undo' });
    expect(state.workspace.objects.map(o => o.id)).toEqual(['a', 'b']);
    expect(state.workspace.activeObjectId).toBe('b');
    state = run(state, { type: 'redo' });
    expect(state.workspace.objects.map(o => o.id)).toEqual(['a']);
    expect(state.workspace.activeObjectId).toBe('a');
  });
  it('undoes the add of an object back to an empty workspace after earlier history', () => {
    let state = stateWith(object('a'));
    state = run(state, commit(removeObject(state.workspace, 'a')));
    state = run(state, commit(addObject(state.workspace, object('b'))));
    state = run(state, { type: 'undo' });
    expect(state.workspace).toEqual(emptyWorkspace());
  });
  it('does not undo selection, explode or activation, which are `replace` actions', () => {
    let state = stateWith(object('a', boxModel(['body', 'lid'])), object('b'));
    const steps = state.past.length;
    state = run(state, { type: 'replace', next: setActiveObject(state.workspace, 'a') });
    state = run(state, { type: 'replace', next: selectParts(state.workspace, 'a', ['lid']) });
    state = run(state, { type: 'replace', next: setExplode(state.workspace, 0.5) });
    expect(state.past).toHaveLength(steps);
  });
  it('keeps the selection and explode on undo when the active object is the same', () => {
    let state = stateWith(object('a', boxModel(['body', 'lid'])));
    state = run(state, commit(replaceModel(state.workspace, 'a', boxModel(['body', 'lid', 'knob']))));
    state = run(state, { type: 'replace', next: setExplode(selectParts(state.workspace, 'a', ['lid', 'knob']), 0.5) });
    const undone = run(state, { type: 'undo' });
    expect(undone.workspace.selection).toEqual({ objectId: 'a', partIds: ['lid'] });
    expect(undone.workspace.display.explode).toBe(0.5);
  });
  it('resets the selection and explode on undo when the active object differs', () => {
    let state = stateWith(object('a'));
    state = run(state, commit(addObject(state.workspace, object('b', boxModel(['body', 'lid'])))));
    state = run(state, { type: 'replace', next: setExplode(selectParts(state.workspace, 'b', ['lid']), 0.5) });
    const undone = run(state, { type: 'undo' });
    expect(undone.workspace.activeObjectId).toBe('a');
    expect(undone.workspace.selection).toEqual({ objectId: null, partIds: [] });
    expect(undone.workspace.display.explode).toBe(0);
  });
  it('shares unchanged objects between snapshots', () => {
    let state = stateWith(object('a'), object('b'), object('c'));
    const a = state.workspace.objects[0]!;
    const c = state.workspace.objects[2]!;
    state = run(state, commit(replaceModel(state.workspace, 'b', boxModel(['x']))));
    const snapshot = state.past.at(-1)!;
    expect(snapshot.objects[0]).toBe(a);
    expect(snapshot.objects[2]).toBe(c);
    expect(snapshot.objects[1]).not.toBe(state.workspace.objects[1]);
    expect(state.workspace.objects[0]).toBe(a);
    const undone = run(state, { type: 'undo' });
    expect(undone.workspace.objects[0]).toBe(a);
    expect(undone.workspace.objects[2]).toBe(c);
  });
});

describe('workspaceReducer replace', () => {
  it('sets the workspace and leaves history alone', () => {
    const state = run(stateWith(object('a'), object('b')), { type: 'undo' });
    const next = setExplode(state.workspace, 0.4);
    const replaced = run(state, { type: 'replace', next });
    expect(replaced.workspace).toBe(next);
    expect(replaced.past).toBe(state.past);
    expect(replaced.future).toBe(state.future);
  });
  it('is a no-op for the same workspace', () => {
    const state = stateWith(object('a'));
    expect(run(state, { type: 'replace', next: state.workspace })).toBe(state);
  });
});

describe('restoreSnapshot', () => {
  const selected = () => {
    const ws = setExplode(selectParts(addObject(addObject(emptyWorkspace(), object('a', boxModel(['body', 'lid']))), object('b')), 'a', ['body', 'lid']), 0.5);
    return ws;
  };
  it('keeps the selection and explode when the active object is the same', () => {
    const current = selected();
    const restored = restoreSnapshot(current, { objects: current.objects, activeObjectId: 'a', joints: current.joints });
    expect(restored.selection).toBe(current.selection);
    expect(restored.display).toBe(current.display);
  });
  it('keeps only part ids that still exist', () => {
    const current = selected();
    const older = { objects: [object('a', boxModel(['body'])), current.objects[1]!], activeObjectId: 'a', joints: [] };
    const restored = restoreSnapshot(current, older);
    expect(restored.selection).toEqual({ objectId: 'a', partIds: ['body'] });
    expect(restored.display.explode).toBe(0.5);
  });
  it('clears the selection when none of its parts exist any more', () => {
    const current = selected();
    const older = { objects: [object('a', boxModel(['other'])), current.objects[1]!], activeObjectId: 'a', joints: [] };
    expect(restoreSnapshot(current, older).selection).toEqual({ objectId: null, partIds: [] });
  });
  it('clears the selection and explode when the active object differs', () => {
    const current = selected();
    const restored = restoreSnapshot(current, { objects: current.objects, activeObjectId: 'b', joints: current.joints });
    expect(restored.activeObjectId).toBe('b');
    expect(restored.selection).toEqual({ objectId: null, partIds: [] });
    expect(restored.display.explode).toBe(0);
  });
  it('gives an empty, valid workspace for an empty snapshot', () => {
    expect(restoreSnapshot(selected(), { objects: [], activeObjectId: null, joints: [] })).toEqual(emptyWorkspace());
  });
  it('does not mutate the current workspace', () => {
    const current = selected();
    const copy = structuredClone(current);
    restoreSnapshot(current, { objects: [], activeObjectId: null, joints: [] });
    expect(current).toEqual(copy);
  });
});

describe('workspaceReducer with joints and materials', () => {
  const joint = fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'));
  /** Two boxes side by side, no joint, built by commits. */
  const start = (): WorkspaceState => {
    const ws = twoBoxes();
    return { workspace: ws, past: [], future: [] };
  };

  it('records the joints in the undo snapshot', () => {
    const initial = start();
    const state = run(initial, commit(addJoint(initial.workspace, joint)));
    expect(state.workspace.joints).toEqual([joint]);
    expect(state.past).toHaveLength(1);
    expect(state.past[0]!.joints).toEqual([]);
    expect(state.past[0]!.objects).toBe(state.workspace.objects);
  });
  it('undoes and redoes adding, changing and removing a joint', () => {
    let state = start();
    state = run(state, commit(addJoint(state.workspace, joint)));
    state = run(state, commit(updateJoint(state.workspace, 'joint-1', { confirmed: true })));
    state = run(state, commit(removeJoint(state.workspace, 'joint-1')));
    expect(state.workspace.joints).toEqual([]);
    state = run(state, { type: 'undo' });
    expect(state.workspace.joints.map(item => item.confirmed)).toEqual([true]);
    state = run(state, { type: 'undo' });
    expect(state.workspace.joints.map(item => item.confirmed)).toEqual([false]);
    state = run(state, { type: 'undo' });
    expect(state.workspace.joints).toEqual([]);
    expect(canUndo(state)).toBe(false);
    state = run(state, { type: 'redo' });
    expect(state.workspace.joints).toHaveLength(1);
    state = run(state, { type: 'redo' }, { type: 'redo' });
    expect(state.workspace.joints).toEqual([]);
    expect(canRedo(state)).toBe(false);
  });
  it('treats a join (the moved transform and the new joint) as one undo step', () => {
    const apart = setTransform(twoBoxes(), 'b', { position: { x: 0.05, y: 0.004, z: 0 } });
    let state: WorkspaceState = { workspace: apart, past: [], future: [] };
    const joined = joinObjects(apart, { moves: [{ objectId: 'b', transform: { position: { x: 0.04, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } }], joint });
    state = run(state, commit(joined));
    expect(state.past).toHaveLength(1);
    expect(state.workspace.joints).toHaveLength(1);
    state = run(state, { type: 'undo' });
    expect(state.workspace.joints).toEqual([]);
    expect(findObject(state.workspace, 'b')!.transform.position).toEqual({ x: 0.05, y: 0.004, z: 0 });
    expect(canUndo(state)).toBe(false);
    state = run(state, { type: 'redo' });
    expect(state.workspace.joints).toHaveLength(1);
    expect(findObject(state.workspace, 'b')!.transform.position).toEqual({ x: 0.04, y: 0, z: 0 });
  });
  it('undoes a move of an assembly as one step', () => {
    let state: WorkspaceState = { workspace: twoBoxes({ joint: true }), past: [], future: [] };
    const before = state.workspace;
    state = run(state, commit(setTransform(state.workspace, 'a', { position: { x: 1, y: 2, z: 3 } })));
    expect(state.past).toHaveLength(1);
    expect(findObject(state.workspace, 'b')!.transform.position).toEqual({ x: 1.04, y: 2, z: 3 });
    state = run(state, { type: 'undo' });
    expect(state.workspace.objects).toBe(before.objects);
    expect(state.workspace.joints).toBe(before.joints);
  });
  it('undoes a material change and keeps the joints', () => {
    let state: WorkspaceState = { workspace: twoBoxes({ joint: true }), past: [], future: [] };
    state = run(state, commit(setMaterial(state.workspace, 'a', 'petg')));
    expect(findObject(state.workspace, 'a')!.material).toBe('petg');
    state = run(state, { type: 'undo' });
    expect(findObject(state.workspace, 'a')!.material).toBeNull();
    expect(state.workspace.joints).toHaveLength(1);
  });
  it('undoes the cascade of removing an object together with its joints', () => {
    let state: WorkspaceState = { workspace: twoBoxes({ joint: true }), past: [], future: [] };
    state = run(state, commit(removeObject(state.workspace, 'a')));
    expect(state.workspace.joints).toEqual([]);
    state = run(state, { type: 'undo' });
    expect(state.workspace.objects.map(object => object.id)).toEqual(['a', 'b']);
    expect(state.workspace.joints).toHaveLength(1);
    state = run(state, { type: 'redo' });
    expect(state.workspace.joints).toEqual([]);
  });
  it('shares the joints array between snapshots like the objects', () => {
    let state: WorkspaceState = { workspace: twoBoxes({ joint: true }), past: [], future: [] };
    const joints = state.workspace.joints;
    state = run(state, commit(setTransform(state.workspace, 'a', { position: { x: 1, y: 0, z: 0 } })));
    expect(state.past[0]!.joints).toBe(joints);
    expect(state.workspace.joints).toBe(joints);
  });
  it('restores joints with restoreSnapshot and does not mutate the current workspace', () => {
    const current = twoBoxes({ joint: true });
    const copy = structuredClone(current);
    const restored = restoreSnapshot(current, { objects: current.objects, activeObjectId: 'a', joints: [] });
    expect(restored.joints).toEqual([]);
    expect(current).toEqual(copy);
  });
});