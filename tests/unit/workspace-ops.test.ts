import { describe, expect, it } from 'vitest';
import { validateModel, type ModelSpec } from '../../shared/model';
import {
  MAX_OBJECTS, WorkspaceChangeSchema, WorkspaceError, activeObject, addObject, applyWorkspaceChange, createObject,
  emptyWorkspace, findObject, removeObject, replaceModel, selectParts, setActiveObject, setExplode, setTransform,
  type ObjectTransform, type SceneObject, type Workspace, type WorkspaceChange, type WorkspaceErrorCode,
} from '../../shared/workspace';

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
const transform = (x = 0, ry = 0): ObjectTransform => ({ position: vec(x, 0, 0), rotation: vec(0, ry, 0) });
function object(id: string, model = boxModel(), at = transform()): SceneObject {
  return { id, model, transform: at, source: 'test', providerModel: 'fake', edited: false, createdAt: CREATED_AT };
}
/** Builds a workspace through `addObject`, so the last object is active. */
function build(...objects: SceneObject[]): Workspace {
  return objects.reduce((ws, next) => addObject(ws, next), emptyWorkspace());
}
const codeOf = (action: () => unknown): WorkspaceErrorCode | 'no error' => {
  try { action(); } catch (error) {
    if (error instanceof WorkspaceError) return error.code;
    throw error;
  }
  return 'no error';
};
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};
const noChange: WorkspaceChange = { activeObjectId: null, object: null, selection: null, explode: null };

describe('addObject', () => {
  it('makes the object active, clears the selection and resets explode', () => {
    const base = selectParts(build(object('a', boxModel(['body', 'lid']))), 'a', ['lid']);
    const exploded = setExplode(base, 0.6);
    expect(exploded.selection.partIds).toEqual(['lid']);
    const next = addObject(exploded, object('b'));
    expect(next.objects.map(o => o.id)).toEqual(['a', 'b']);
    expect(next.activeObjectId).toBe('b');
    expect(next.selection).toEqual({ objectId: null, partIds: [] });
    expect(next.display.explode).toBe(0);
  });
  it('adds to an empty workspace', () => {
    const ws = addObject(emptyWorkspace(), object('a'));
    expect(ws.objects).toHaveLength(1);
    expect(activeObject(ws)?.id).toBe('a');
  });
  it('accepts an object made by createObject', () => {
    const first = build(object('a'));
    const made = createObject(first, { id: 'b', model: boxModel(), source: 'demo', providerModel: 'demo', createdAt: CREATED_AT });
    const ws = addObject(first, made);
    expect(findObject(ws, 'b')?.transform.position.x).toBeGreaterThan(0);
  });
  it('rejects the ninth object with OBJECT_LIMIT', () => {
    let ws = emptyWorkspace();
    for (let index = 0; index < MAX_OBJECTS; index++) ws = addObject(ws, object(`o${index}`));
    expect(ws.objects).toHaveLength(MAX_OBJECTS);
    expect(codeOf(() => addObject(ws, object('extra')))).toBe('OBJECT_LIMIT');
  });
  it('rejects a duplicate id with DUPLICATE_OBJECT', () => {
    expect(codeOf(() => addObject(build(object('a')), object('a')))).toBe('DUPLICATE_OBJECT');
  });
  it.each(['', 'has space', 'a/b', 'é', 'x'.repeat(65)])('rejects the object id %j with INVALID_WORKSPACE', id => {
    expect(codeOf(() => addObject(emptyWorkspace(), object(id)))).toBe('INVALID_WORKSPACE');
  });
  it('accepts a 64-character id', () => {
    expect(addObject(emptyWorkspace(), object('x'.repeat(64))).activeObjectId).toBe('x'.repeat(64));
  });
  it.each(['yesterday', '2026-11-20', '2026-11-20T08:00:00', '2026-11-20T08:00:00+08:00', ''])(
    'rejects createdAt %j with INVALID_WORKSPACE', createdAt => {
      expect(codeOf(() => addObject(emptyWorkspace(), { ...object('a'), createdAt }))).toBe('INVALID_WORKSPACE');
    });
  it('rejects an invalid model with INVALID_WORKSPACE', () => {
    const broken = { ...object('a'), model: { ...boxModel(), parts: [] } };
    expect(codeOf(() => addObject(emptyWorkspace(), broken))).toBe('INVALID_WORKSPACE');
    const cyclic = { ...boxModel(['p', 'q']) };
    cyclic.parts = [{ ...cyclic.parts[0]!, parentId: 'q' }, { ...cyclic.parts[1]!, parentId: 'p' }];
    expect(codeOf(() => addObject(emptyWorkspace(), { ...object('a'), model: cyclic }))).toBe('INVALID_WORKSPACE');
  });
  it('rejects a transform outside the limits', () => {
    expect(codeOf(() => addObject(emptyWorkspace(), object('a', boxModel(), transform(101))))).toBe('INVALID_WORKSPACE');
  });
  it('keeps the other objects by reference', () => {
    const first = build(object('a'), object('b'));
    const next = addObject(first, object('c'));
    expect(next.objects[0]).toBe(first.objects[0]);
    expect(next.objects[1]).toBe(first.objects[1]);
  });
});

describe('replaceModel', () => {
  it('sets edited and keeps source and providerModel when meta is omitted', () => {
    const ws = build(object('a'));
    const next = replaceModel(ws, 'a', boxModel(['body', 'lid']));
    const replaced = findObject(next, 'a')!;
    expect(replaced.edited).toBe(true);
    expect(replaced.source).toBe('test');
    expect(replaced.providerModel).toBe('fake');
    expect(replaced.model.parts).toHaveLength(2);
    expect(findObject(ws, 'a')!.edited).toBe(false);
  });
  it('replaces source and providerModel when meta gives them', () => {
    const next = replaceModel(build(object('a')), 'a', boxModel(['body', 'lid']), { source: 'codex', providerModel: 'gpt-x' });
    expect(findObject(next, 'a')).toMatchObject({ source: 'codex', providerModel: 'gpt-x', edited: true });
  });
  it('replaces only the given meta field', () => {
    const next = replaceModel(build(object('a')), 'a', boxModel(['body', 'lid']), { source: 'claude' });
    expect(findObject(next, 'a')).toMatchObject({ source: 'claude', providerModel: 'fake' });
  });
  it('keeps the id, transform and createdAt', () => {
    const ws = build(object('a', boxModel(), transform(3, 40)));
    const replaced = findObject(replaceModel(ws, 'a', boxModel(['body', 'lid'])), 'a')!;
    expect(replaced.transform).toBe(findObject(ws, 'a')!.transform);
    expect(replaced.createdAt).toBe(CREATED_AT);
  });
  it('drops selected ids that no longer exist in the active object', () => {
    const ws = selectParts(build(object('a', boxModel(['body', 'lid', 'knob']))), 'a', ['body', 'lid']);
    const next = replaceModel(ws, 'a', boxModel(['body', 'knob']));
    expect(next.selection).toEqual({ objectId: 'a', partIds: ['body'] });
  });
  it('clears the selection when every selected part is gone', () => {
    const ws = selectParts(build(object('a', boxModel(['body', 'lid']))), 'a', ['lid']);
    expect(replaceModel(ws, 'a', boxModel(['body'])).selection).toEqual({ objectId: null, partIds: [] });
  });
  it('keeps the selection reference when every selected part remains', () => {
    const ws = selectParts(build(object('a', boxModel(['body', 'lid']))), 'a', ['body']);
    expect(replaceModel(ws, 'a', boxModel(['body', 'lid', 'knob'])).selection).toBe(ws.selection);
  });
  it('leaves the selection and active object alone when another object changes', () => {
    const ws = selectParts(build(object('a', boxModel(['body', 'lid'])), object('b')), 'a', ['lid']);
    const next = replaceModel(ws, 'b', boxModel(['other']));
    expect(next.activeObjectId).toBe('a');
    expect(next.selection).toBe(ws.selection);
    expect(next.objects[0]).toBe(ws.objects[0]);
  });
  it('throws UNKNOWN_OBJECT for an unknown id', () => {
    expect(codeOf(() => replaceModel(build(object('a')), 'zz', boxModel()))).toBe('UNKNOWN_OBJECT');
  });
  it('rejects an invalid model', () => {
    expect(codeOf(() => replaceModel(build(object('a')), 'a', { ...boxModel(), parts: [] }))).toBe('INVALID_WORKSPACE');
  });
  it('returns the same reference when nothing changes', () => {
    const edited = replaceModel(build(object('a')), 'a', boxModel(['body', 'lid']));
    const model = findObject(edited, 'a')!.model;
    expect(replaceModel(edited, 'a', model)).toBe(edited);
    expect(replaceModel(edited, 'a', model, { source: 'test', providerModel: 'fake' })).toBe(edited);
  });
});

describe('removeObject', () => {
  const three = () => build(object('a'), object('b'), object('c'));
  it('activates the previous object when the active object is removed', () => {
    const ws = setActiveObject(three(), 'b');
    const next = removeObject(ws, 'b');
    expect(next.objects.map(o => o.id)).toEqual(['a', 'c']);
    expect(next.activeObjectId).toBe('a');
  });
  it('activates the new first object when the first is removed', () => {
    const next = removeObject(setActiveObject(three(), 'a'), 'a');
    expect(next.objects.map(o => o.id)).toEqual(['b', 'c']);
    expect(next.activeObjectId).toBe('b');
  });
  it('clears the selection and resets explode when the active object is removed', () => {
    const ws = setExplode(selectParts(build(object('a'), object('b', boxModel(['body', 'lid']))), 'b', ['lid']), 0.5);
    const next = removeObject(ws, 'b');
    expect(next.selection).toEqual({ objectId: null, partIds: [] });
    expect(next.display.explode).toBe(0);
    expect(next.activeObjectId).toBe('a');
  });
  it('keeps the active object, selection and explode when another object is removed', () => {
    const ws = setExplode(selectParts(three(), 'c', ['body']), 0.5);
    const next = removeObject(ws, 'a');
    expect(next.activeObjectId).toBe('c');
    expect(next.selection).toBe(ws.selection);
    expect(next.display.explode).toBe(0.5);
    expect(next.objects).toEqual([ws.objects[1], ws.objects[2]]);
  });
  it('gives an empty workspace when the last object is removed', () => {
    const ws = setExplode(selectParts(build(object('a')), 'a', ['body']), 0.3);
    expect(removeObject(ws, 'a')).toEqual(emptyWorkspace());
  });
  it('throws UNKNOWN_OBJECT for an unknown id', () => {
    expect(codeOf(() => removeObject(three(), 'zz'))).toBe('UNKNOWN_OBJECT');
  });
});

describe('setActiveObject', () => {
  it('resets the selection and explode', () => {
    const ws = setExplode(selectParts(build(object('a'), object('b')), 'b', ['body']), 0.7);
    const next = setActiveObject(ws, 'a');
    expect(next.activeObjectId).toBe('a');
    expect(next.selection).toEqual({ objectId: null, partIds: [] });
    expect(next.display.explode).toBe(0);
  });
  it('returns the same reference for the active id', () => {
    const ws = setExplode(selectParts(build(object('a'), object('b')), 'b', ['body']), 0.7);
    expect(setActiveObject(ws, 'b')).toBe(ws);
  });
  it('throws UNKNOWN_OBJECT for an unknown id', () => {
    expect(codeOf(() => setActiveObject(build(object('a')), 'zz'))).toBe('UNKNOWN_OBJECT');
    expect(codeOf(() => setActiveObject(emptyWorkspace(), 'a'))).toBe('UNKNOWN_OBJECT');
  });
});

describe('selectParts', () => {
  it('selects parts of the active object', () => {
    const ws = build(object('a', boxModel(['body', 'lid'])));
    expect(selectParts(ws, 'a', ['lid', 'body']).selection).toEqual({ objectId: 'a', partIds: ['lid', 'body'] });
  });
  it('activates another object first and resets explode', () => {
    const ws = setExplode(build(object('a'), object('b', boxModel(['body', 'lid']))), 0.4);
    const next = selectParts(ws, 'a', ['body']);
    expect(next.activeObjectId).toBe('a');
    expect(next.selection).toEqual({ objectId: 'a', partIds: ['body'] });
    expect(next.display.explode).toBe(0);
  });
  it('gives { objectId: null, partIds: [] } for an empty list', () => {
    const ws = selectParts(build(object('a')), 'a', ['body']);
    expect(selectParts(ws, 'a', []).selection).toEqual({ objectId: null, partIds: [] });
  });
  it('returns the same reference when the selection does not change', () => {
    const ws = selectParts(build(object('a', boxModel(['body', 'lid']))), 'a', ['body', 'lid']);
    expect(selectParts(ws, 'a', ['body', 'lid'])).toBe(ws);
    const none = build(object('a'));
    expect(selectParts(none, 'a', [])).toBe(none);
  });
  it('treats a different order as a change', () => {
    const ws = selectParts(build(object('a', boxModel(['body', 'lid']))), 'a', ['body', 'lid']);
    expect(selectParts(ws, 'a', ['lid', 'body']).selection.partIds).toEqual(['lid', 'body']);
  });
  it('throws INVALID_SELECTION for unknown or duplicate parts', () => {
    const ws = build(object('a', boxModel(['body', 'lid'])));
    expect(codeOf(() => selectParts(ws, 'a', ['nope']))).toBe('INVALID_SELECTION');
    expect(codeOf(() => selectParts(ws, 'a', ['body', 'body']))).toBe('INVALID_SELECTION');
  });
  it('does not accept a part of a different object', () => {
    const ws = build(object('a', boxModel(['only-a'])), object('b'));
    expect(codeOf(() => selectParts(ws, 'b', ['only-a']))).toBe('INVALID_SELECTION');
  });
  it('throws UNKNOWN_OBJECT for an unknown object', () => {
    expect(codeOf(() => selectParts(build(object('a')), 'zz', []))).toBe('UNKNOWN_OBJECT');
  });
});

describe('setTransform', () => {
  it('merges position and rotation', () => {
    const ws = build(object('a', boxModel(), { position: vec(1, 2, 3), rotation: vec(10, 20, 30) }));
    const moved = setTransform(ws, 'a', { position: vec(4, 5, 6) });
    expect(findObject(moved, 'a')!.transform).toEqual({ position: vec(4, 5, 6), rotation: vec(10, 20, 30) });
    const turned = setTransform(moved, 'a', { rotation: vec(0, 90, 0) });
    expect(findObject(turned, 'a')!.transform).toEqual({ position: vec(4, 5, 6), rotation: vec(0, 90, 0) });
    const both = setTransform(turned, 'a', { position: vec(0, 0, 0), rotation: vec(1, 1, 1) });
    expect(findObject(both, 'a')!.transform).toEqual({ position: vec(0, 0, 0), rotation: vec(1, 1, 1) });
  });
  it('keeps the unchanged vector by reference', () => {
    const ws = build(object('a', boxModel(), { position: vec(1, 2, 3), rotation: vec(10, 20, 30) }));
    const before = findObject(ws, 'a')!.transform;
    const after = findObject(setTransform(ws, 'a', { position: vec(4, 5, 6), rotation: vec(10, 20, 30) }), 'a')!.transform;
    expect(after.rotation).toBe(before.rotation);
  });
  it('does not touch edited, the model, selection or active object', () => {
    const ws = selectParts(build(object('a'), object('b')), 'a', ['body']);
    const next = setTransform(ws, 'b', { position: vec(1, 0, 0) });
    expect(findObject(next, 'b')!.edited).toBe(false);
    expect(findObject(next, 'b')!.model).toBe(findObject(ws, 'b')!.model);
    expect(next.activeObjectId).toBe('a');
    expect(next.selection).toBe(ws.selection);
  });
  it('returns the same reference when nothing changes', () => {
    const ws = build(object('a', boxModel(), transform(1, 30)));
    expect(setTransform(ws, 'a', {})).toBe(ws);
    expect(setTransform(ws, 'a', { position: vec(1, 0, 0), rotation: vec(0, 30, 0) })).toBe(ws);
  });
  it('accepts the limits themselves', () => {
    const next = setTransform(build(object('a')), 'a', { position: vec(100, -100, 100), rotation: vec(360, -360, 0) });
    expect(findObject(next, 'a')!.transform.position.x).toBe(100);
  });
  it.each([
    ['position above 100', { position: vec(100.001, 0, 0) }],
    ['position below -100', { position: vec(0, -101, 0) }],
    ['rotation above 360', { rotation: vec(0, 0, 361) }],
    ['rotation below -360', { rotation: vec(-361, 0, 0) }],
    ['NaN', { position: vec(Number.NaN, 0, 0) }],
    ['Infinity', { rotation: vec(0, Number.POSITIVE_INFINITY, 0) }],
  ])('rejects %s with INVALID_WORKSPACE', (_name, patch) => {
    expect(codeOf(() => setTransform(build(object('a')), 'a', patch))).toBe('INVALID_WORKSPACE');
  });
  it('throws UNKNOWN_OBJECT for an unknown id', () => {
    expect(codeOf(() => setTransform(build(object('a')), 'zz', {}))).toBe('UNKNOWN_OBJECT');
  });
});

describe('setExplode', () => {
  it('sets the amount and returns the same reference for the same amount', () => {
    const ws = build(object('a'));
    const next = setExplode(ws, 0.5);
    expect(next.display.explode).toBe(0.5);
    expect(setExplode(next, 0.5)).toBe(next);
    expect(setExplode(ws, 0)).toBe(ws);
  });
  it('rejects amounts outside 0 to 1', () => {
    const ws = build(object('a'));
    for (const amount of [-0.1, 1.1, Number.NaN]) expect(codeOf(() => setExplode(ws, amount))).toBe('INVALID_WORKSPACE');
  });
  it('only accepts 0 in an empty workspace', () => {
    expect(setExplode(emptyWorkspace(), 0)).toEqual(emptyWorkspace());
    expect(codeOf(() => setExplode(emptyWorkspace(), 0.5))).toBe('INVALID_WORKSPACE');
  });
});

describe('operations in general', () => {
  it('does not mutate their input', () => {
    const ws = deepFreeze(selectParts(build(object('a', boxModel(['body', 'lid'])), object('b')), 'a', ['body']));
    const model = deepFreeze(boxModel(['body', 'knob']));
    const incoming = deepFreeze(object('c'));
    const copy = structuredClone(ws);
    addObject(ws, incoming);
    replaceModel(ws, 'a', model);
    removeObject(ws, 'a');
    setTransform(ws, 'b', { position: vec(2, 0, 0) });
    setActiveObject(ws, 'b');
    selectParts(ws, 'a', ['lid']);
    setExplode(ws, 0.5);
    applyWorkspaceChange(ws, { ...noChange, object: { op: 'remove', objectId: 'b' }, explode: 0.2 });
    expect(ws).toEqual(copy);
  });
  it('keeps unchanged objects by reference', () => {
    const ws = build(object('a', boxModel(['body', 'lid'])), object('b'), object('c'));
    const results = [
      replaceModel(ws, 'b', boxModel(['x'])),
      setTransform(ws, 'b', { position: vec(5, 0, 0) }),
      removeObject(ws, 'b'),
      setActiveObject(ws, 'a'),
      selectParts(ws, 'a', ['lid']),
      setExplode(ws, 0.5),
    ];
    for (const next of results) {
      for (const kept of next.objects.filter(o => o.id !== 'b')) expect(kept).toBe(findObject(ws, kept.id));
    }
  });
});

describe('applyWorkspaceChange', () => {
  it('returns the workspace itself for an empty change', () => {
    const ws = build(object('a'));
    const { before, after } = applyWorkspaceChange(ws, noChange);
    expect(before).toBe(ws);
    expect(after).toBe(ws);
  });
  it('applies activation, object, selection and explode in that order', () => {
    const ws = build(object('a', boxModel(['body', 'lid'])), object('b', boxModel(['body', 'knob'])));
    const { after } = applyWorkspaceChange(ws, {
      activeObjectId: 'a',
      object: { op: 'model', objectId: 'a', model: boxModel(['body', 'lid', 'new']), source: 'codex', providerModel: 'm1' },
      selection: { objectId: 'a', partIds: ['new'] }, // exists only after the model step
      explode: 0.5,
    });
    expect(after.activeObjectId).toBe('a');
    expect(findObject(after, 'a')).toMatchObject({ edited: true, source: 'codex', providerModel: 'm1' });
    expect(after.selection).toEqual({ objectId: 'a', partIds: ['new'] });
    expect(after.display.explode).toBe(0.5);
  });
  it('rejects a selection of a part that the same change removes', () => {
    const ws = build(object('a', boxModel(['body', 'lid'])));
    const change: WorkspaceChange = {
      ...noChange,
      object: { op: 'model', objectId: 'a', model: boxModel(['body']), source: 'test', providerModel: 'fake' },
      selection: { objectId: 'a', partIds: ['lid'] },
    };
    expect(codeOf(() => applyWorkspaceChange(ws, change))).toBe('INVALID_SELECTION');
  });
  it('makes before the workspace after activation and after the final one, for an edit of a non-active object', () => {
    const ws = build(object('a'), object('b', boxModel(['body', 'lid'])));
    const { before, after } = applyWorkspaceChange(ws, {
      activeObjectId: 'a',
      object: { op: 'model', objectId: 'a', model: boxModel(['body', 'extra']), source: 'test', providerModel: 'fake' },
      selection: null, explode: null,
    });
    expect(before.activeObjectId).toBe('a');
    expect(before.objects).toBe(ws.objects);
    expect(findObject(before, 'a')!.edited).toBe(false);
    expect(findObject(after, 'a')!.edited).toBe(true);
    expect(after.objects[1]).toBe(ws.objects[1]);
  });
  it('leaves before equal to the input when there is no activation', () => {
    const ws = build(object('a'));
    const { before, after } = applyWorkspaceChange(ws, { ...noChange, object: { op: 'transform', objectId: 'a', transform: transform(2) } });
    expect(before).toBe(ws);
    expect(findObject(after, 'a')!.transform).toEqual(transform(2));
  });
  it('rejects an activeObjectId that names an object only added in the same change', () => {
    const ws = build(object('a'));
    expect(codeOf(() => applyWorkspaceChange(ws, { ...noChange, activeObjectId: 'new', object: { op: 'add', object: object('new') } })))
      .toBe('UNKNOWN_OBJECT');
  });
  it('adds an object, which becomes active', () => {
    const ws = build(object('a'));
    const { before, after } = applyWorkspaceChange(ws, { ...noChange, object: { op: 'add', object: object('b') } });
    expect(before).toBe(ws);
    expect(after.activeObjectId).toBe('b');
    expect(after.objects).toHaveLength(2);
  });
  it('removes an object', () => {
    const { after } = applyWorkspaceChange(build(object('a'), object('b')), { ...noChange, object: { op: 'remove', objectId: 'b' } });
    expect(after.objects.map(o => o.id)).toEqual(['a']);
    expect(after.activeObjectId).toBe('a');
  });
  it('clears the selection with { objectId: null, partIds: [] }', () => {
    const ws = selectParts(build(object('a')), 'a', ['body']);
    expect(applyWorkspaceChange(ws, { ...noChange, selection: { objectId: null, partIds: [] } }).after.selection)
      .toEqual({ objectId: null, partIds: [] });
    expect(codeOf(() => applyWorkspaceChange(ws, { ...noChange, selection: { objectId: null, partIds: ['body'] } })))
      .toBe('INVALID_SELECTION');
  });
  it('selects parts of another object, activating it', () => {
    const ws = build(object('a'), object('b'));
    const { after } = applyWorkspaceChange(ws, { ...noChange, selection: { objectId: 'a', partIds: ['body'] } });
    expect(after.activeObjectId).toBe('a');
    expect(after.selection).toEqual({ objectId: 'a', partIds: ['body'] });
  });
  it('rejects an invalid model in add', () => {
    const broken = { ...object('b'), model: { ...boxModel(), parts: [] } };
    expect(codeOf(() => applyWorkspaceChange(build(object('a')), { ...noChange, object: { op: 'add', object: broken } })))
      .toBe('INVALID_WORKSPACE');
  });
  it('rejects an invalid model in model', () => {
    const change: WorkspaceChange = {
      ...noChange, object: { op: 'model', objectId: 'a', model: { ...boxModel(), parts: [] }, source: 'x', providerModel: 'y' },
    };
    expect(codeOf(() => applyWorkspaceChange(build(object('a')), change))).toBe('INVALID_WORKSPACE');
  });
  it('rejects an object change for an unknown object', () => {
    expect(codeOf(() => applyWorkspaceChange(build(object('a')), { ...noChange, object: { op: 'remove', objectId: 'zz' } })))
      .toBe('UNKNOWN_OBJECT');
  });
  it('rejects adding at the limit', () => {
    let ws = emptyWorkspace();
    for (let index = 0; index < MAX_OBJECTS; index++) ws = addObject(ws, object(`o${index}`));
    expect(codeOf(() => applyWorkspaceChange(ws, { ...noChange, object: { op: 'add', object: object('extra') } }))).toBe('OBJECT_LIMIT');
  });
  it('has a schema that accepts a change and survives JSON', () => {
    const change: WorkspaceChange = {
      activeObjectId: 'a',
      object: { op: 'add', object: object('b') },
      selection: { objectId: null, partIds: [] },
      explode: 0,
    };
    expect(WorkspaceChangeSchema.parse(JSON.parse(JSON.stringify(change)))).toEqual(change);
    expect(WorkspaceChangeSchema.safeParse({ ...change, extra: 1 }).success).toBe(false);
    expect(WorkspaceChangeSchema.safeParse({ ...change, object: { op: 'remove' } }).success).toBe(false);
  });
});
