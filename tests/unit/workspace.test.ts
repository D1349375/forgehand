import { describe, expect, it } from 'vitest';
import { objectBox } from '../../shared/bounds';
import { demoModel } from '../../shared/demo';
import { validateModel, type ModelSpec } from '../../shared/model';
import {
  MAX_OBJECTS, WORKSPACE_VERSION, WorkspaceError, ZERO_TRANSFORM, activeObject, assertWorkspace, createObject,
  emptyWorkspace, findObject, placeBeside, validateWorkspace,
  type ObjectTransform, type SceneObject, type Workspace, type WorkspaceErrorCode,
} from '../../shared/workspace';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const CREATED_AT = '2026-11-20T08:00:00.000Z';

function boxModel(partIds: string[] = ['body'], dimensions = vec(2, 1, 4), name = 'Slab'): ModelSpec {
  return validateModel({
    schemaVersion: '1.0', name, summary: 'Boxes.', units: 'm', assumptions: [],
    parts: partIds.map((id, index) => ({
      id, name: id, parentId: null, primitive: 'box', dimensions, position: vec(index * 0.01, 0, 0), rotation: vec(0, 0, 0),
      color: '#336699', role: 'exterior', tubeRatio: 0.3,
    })),
  });
}
const transform = (x = 0, ry = 0): ObjectTransform => ({ position: vec(x, 0, 0), rotation: vec(0, ry, 0) });
function object(id: string, model = boxModel(), at = transform()): SceneObject {
  return { id, model, transform: at, source: 'test', providerModel: 'fake', edited: false, createdAt: CREATED_AT };
}
function workspace(objects: SceneObject[], patch: Partial<Workspace> = {}): Workspace {
  return {
    ...emptyWorkspace(), objects, activeObjectId: objects.length ? objects[objects.length - 1]!.id : null, ...patch,
  };
}
const codeOf = (action: () => unknown): WorkspaceErrorCode | 'no error' => {
  try { action(); } catch (error) {
    if (error instanceof WorkspaceError) return error.code;
    throw error;
  }
  return 'no error';
};

describe('workspace data and validation', () => {
  it('starts empty', () => {
    const ws = emptyWorkspace();
    expect(ws).toEqual({
      version: WORKSPACE_VERSION, objects: [], activeObjectId: null, selection: { objectId: null, partIds: [] }, display: { explode: 0 },
    });
    expect(activeObject(ws)).toBeNull();
    expect(findObject(ws, 'a')).toBeNull();
    expect(() => assertWorkspace(ws)).not.toThrow();
  });

  it('keeps the zero transform frozen and zero', () => {
    expect(ZERO_TRANSFORM).toEqual({ position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
    expect(Object.isFrozen(ZERO_TRANSFORM)).toBe(true);
    expect(Object.isFrozen(ZERO_TRANSFORM.position)).toBe(true);
  });

  it.each([0, 1, 3])('accepts a workspace with %i objects and survives JSON', count => {
    const objects = Array.from({ length: count }, (_, index) => object(`obj-${index}`, boxModel(['body', 'lid']), transform(index * 3)));
    const ws = workspace(objects, count ? { selection: { objectId: `obj-${count - 1}`, partIds: ['lid'] }, display: { explode: 0.5 } } : {});
    const checked = validateWorkspace(ws);
    expect(checked).toEqual(ws);
    expect(validateWorkspace(JSON.parse(JSON.stringify(checked)))).toEqual(ws);
  });

  it('finds objects and the active object', () => {
    const a = object('a'), b = object('b');
    const ws = workspace([a, b], { activeObjectId: 'a' });
    expect(findObject(ws, 'b')).toBe(b);
    expect(activeObject(ws)).toBe(a);
  });

  describe('assertWorkspace rejects', () => {
    const a = object('a'), b = object('b', boxModel(['body', 'lid']), transform(3));
    const cases: Array<[string, WorkspaceErrorCode, () => Workspace]> = [
      ['a duplicate object id', 'DUPLICATE_OBJECT', () => workspace([a, { ...b, id: 'a' }])],
      ['nine objects', 'OBJECT_LIMIT', () => workspace(Array.from({ length: MAX_OBJECTS + 1 }, (_, index) => object(`o${index}`)))],
      ['no active object while objects exist', 'INVALID_WORKSPACE', () => workspace([a, b], { activeObjectId: null })],
      ['an active object that does not exist', 'UNKNOWN_OBJECT', () => workspace([a, b], { activeObjectId: 'zzz' })],
      ['an active object in an empty workspace', 'INVALID_WORKSPACE', () => workspace([], { activeObjectId: 'a' })],
      ['a selection on a non-active object', 'INVALID_SELECTION', () => workspace([a, b], { activeObjectId: 'a', selection: { objectId: 'b', partIds: ['body'] } })],
      ['a selection on a missing object', 'INVALID_SELECTION', () => workspace([], { selection: { objectId: 'a', partIds: [] } })],
      ['an unknown part id', 'INVALID_SELECTION', () => workspace([a, b], { selection: { objectId: 'b', partIds: ['nope'] } })],
      ['a duplicate part id', 'INVALID_SELECTION', () => workspace([a, b], { selection: { objectId: 'b', partIds: ['lid', 'lid'] } })],
      ['part ids with a null objectId', 'INVALID_SELECTION', () => workspace([a, b], { selection: { objectId: null, partIds: ['body'] } })],
      ['an explode amount above 1', 'INVALID_WORKSPACE', () => workspace([a], { display: { explode: 1.5 } })],
      ['a negative explode amount', 'INVALID_WORKSPACE', () => workspace([a], { display: { explode: -0.1 } })],
      ['a non-zero explode amount with no objects', 'INVALID_WORKSPACE', () => workspace([], { display: { explode: 0.5 } })],
      ['a position out of range', 'INVALID_WORKSPACE', () => workspace([object('a', boxModel(), { position: vec(100.5, 0, 0), rotation: vec(0, 0, 0) })])],
      ['a rotation out of range', 'INVALID_WORKSPACE', () => workspace([object('a', boxModel(), { position: vec(0, 0, 0), rotation: vec(0, 361, 0) })])],
      ['a non-finite transform', 'INVALID_WORKSPACE', () => workspace([object('a', boxModel(), { position: vec(Number.NaN, 0, 0), rotation: vec(0, 0, 0) })])],
      ['another version', 'INVALID_WORKSPACE', () => ({ ...workspace([a]), version: 2 }) as unknown as Workspace],
    ];
    it.each(cases)('%s', (_name, code, build) => {
      expect(codeOf(() => assertWorkspace(build()))).toBe(code);
    });

    it('accepts the limits themselves', () => {
      const full = Array.from({ length: MAX_OBJECTS }, (_, index) => object(`o${index}`));
      const edge = object('edge', boxModel(), { position: vec(-100, 100, 100), rotation: vec(-360, 360, 0) });
      expect(() => assertWorkspace(workspace(full, { display: { explode: 1 } }))).not.toThrow();
      expect(() => assertWorkspace(workspace([edge]))).not.toThrow();
    });
  });

  it('returns without copying or changing the workspace', () => {
    const ws = workspace([object('a'), object('b')]);
    const before = JSON.stringify(ws);
    const objects = [...ws.objects];
    expect(assertWorkspace(ws)).toBeUndefined();
    expect(JSON.stringify(ws)).toBe(before);
    ws.objects.forEach((entry, index) => expect(entry).toBe(objects[index]));
  });

  it('validateWorkspace returns a copy', () => {
    const ws = workspace([object('a')]);
    const copy = validateWorkspace(ws);
    expect(copy).toEqual(ws);
    expect(copy).not.toBe(ws);
    expect(copy.objects[0]!.model).not.toBe(ws.objects[0]!.model);
  });

  describe('validateWorkspace failures use fixed messages', () => {
    const cyclic = { ...boxModel(['a', 'b']), parts: boxModel(['a', 'b']).parts.map(part => ({ ...part, parentId: part.id === 'a' ? 'b' : 'a' })) };
    const fixed = new WorkspaceError('INVALID_WORKSPACE').message;
    it.each([
      ['a model with a parent cycle', () => workspace([object('a', cyclic)])],
      ['a missing field', () => ({ ...workspace([object('a')]), display: undefined })],
      ['an extra field', () => ({ ...workspace([object('a')]), extra: true })],
      ['a bad timestamp', () => workspace([{ ...object('a'), createdAt: 'yesterday' }])],
      ['an object id with a space', () => workspace([object('a b')], { activeObjectId: 'a b' })],
      ['nine objects', () => workspace(Array.from({ length: 9 }, (_, index) => object(`o${index}`)))],
      ['not an object', () => 'workspace'],
    ])('%s', (_name, build) => {
      let thrown: unknown;
      try { validateWorkspace(build()); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(WorkspaceError);
      const error = thrown as WorkspaceError;
      expect(error.code).toBe('INVALID_WORKSPACE');
      expect(error.message).toBe(fixed);
      expect(error.message).not.toMatch(/Invalid|expected|received|path|zod|[a-z]{4,}/i);
    });

    it('passes the specific code of a broken rule', () => {
      const a = object('a');
      expect(codeOf(() => validateWorkspace(workspace([a], { activeObjectId: 'other' })))).toBe('UNKNOWN_OBJECT');
      expect(codeOf(() => validateWorkspace(workspace([a, { ...a }])))).toBe('DUPLICATE_OBJECT');
      expect(codeOf(() => validateWorkspace(workspace([a], { selection: { objectId: 'a', partIds: ['x'] } })))).toBe('INVALID_SELECTION');
    });
  });

  it('has fixed Traditional Chinese messages without ids, and the limit message uses MAX_OBJECTS', () => {
    expect(new WorkspaceError('OBJECT_LIMIT').message).toBe('工作區最多 8 個物件，請先刪除一個物件。');
    expect(new WorkspaceError('OBJECT_LIMIT').message).toContain(String(MAX_OBJECTS));
    for (const code of ['INVALID_WORKSPACE', 'OBJECT_LIMIT', 'UNKNOWN_OBJECT', 'DUPLICATE_OBJECT', 'INVALID_SELECTION'] as const) {
      const error = new WorkspaceError(code);
      expect(error.code).toBe(code);
      expect(error.message).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

describe('placement', () => {
  it('puts the first object at the origin', () => {
    expect(placeBeside([], boxModel())).toEqual({ position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
    expect(placeBeside([], boxModel())).not.toBe(ZERO_TRANSFORM);
  });

  it('puts the second object one gap past the first', () => {
    // First box spans x -1..1. New width 2, so gap 0.2 and the new box starts at 1.2, centre at 2.2.
    expect(placeBeside([object('a')], boxModel()).position).toEqual(vec(2.2, 0, 0));
  });

  it('puts the fourth object past the three before it', () => {
    const objects: SceneObject[] = [];
    for (const id of ['a', 'b', 'c']) objects.push(object(id, boxModel(), placeBeside(objects, boxModel())));
    expect(objects.map(entry => entry.transform.position.x)).toEqual([0, 2.2, 4.4]);
    expect(placeBeside(objects, boxModel()).position.x).toBe(6.6);
  });

  it('goes past the right edge of a rotated neighbour', () => {
    // A 2 x 4 footprint turned 90 degrees about Y spans x -2..2.
    const turned = object('a', boxModel(), transform(0, 90));
    expect(placeBeside([turned], boxModel()).position.x).toBeCloseTo(3.2, 4);
  });

  it('uses the rightmost box, not the last one in the list', () => {
    const far = object('far', boxModel(), transform(10)), near = object('near', boxModel(), transform(0));
    expect(placeBeside([far, near], boxModel()).position.x).toBe(12.2);
  });

  it('uses at least 2 cm of gap for narrow objects', () => {
    const narrow = boxModel(['body'], vec(0.01, 1, 1));
    // Width 0.01 gives 0.1 x 0.01 = 0.001, below 2 cm. Box ends at 0.005, so x = 0.005 + 0.02 + 0.005.
    expect(placeBeside([object('a', narrow)], narrow).position.x).toBe(0.03);
  });

  it('accounts for where the new model sits inside its own frame', () => {
    const offset = validateModel({ ...boxModel(), parts: boxModel().parts.map(part => ({ ...part, position: vec(5, 0, 0) })) });
    // Model box spans x 4..6, so the object origin must land at 1.2 - 4 = -2.8 for its box to start at 1.2.
    const placed = placeBeside([object('a')], offset);
    expect(placed.position.x).toBe(-2.8);
    const box = objectBox(offset, placed);
    expect(box.min.x).toBeCloseTo(1.2, 6);
  });

  it('rounds x to five decimals', () => {
    const third = boxModel(['body'], vec(1 / 3, 1, 1));
    const x = placeBeside([object('a', third)], third).position.x;
    expect(x).toBe(Math.round(x * 1e5) / 1e5);
    expect(String(x).split('.')[1]!.length).toBeLessThanOrEqual(5);
  });

  it('clamps x to 100 metres', () => {
    const placed = placeBeside([object('a', boxModel(), transform(100))], boxModel());
    expect(placed.position.x).toBe(100);
    expect(() => assertWorkspace(workspace([object('a', boxModel(), transform(100)), object('b', boxModel(), placed)]))).not.toThrow();
  });

  it('never overlaps earlier boxes', () => {
    const sizes = [vec(2, 1, 4), vec(0.01, 3, 0.5), vec(5, 5, 5), vec(0.3, 0.2, 0.1), vec(1, 1, 1), vec(7, 0.5, 2), vec(0.5, 0.5, 0.5), vec(3, 3, 3)];
    const objects: SceneObject[] = [];
    sizes.forEach((dimensions, index) => {
      const model = boxModel(['body'], dimensions);
      const placed = object(`o${index}`, model, placeBeside(objects, model));
      const box = objectBox(model, placed.transform);
      for (const other of objects) expect(box.intersectsBox(objectBox(other.model, other.transform))).toBe(false);
      objects.push(placed);
    });
    expect(objects).toHaveLength(MAX_OBJECTS);
  });

  it('places the demo model beside itself without overlap', () => {
    const first = object('a', demoModel, placeBeside([], demoModel));
    const second = placeBeside([first], demoModel);
    expect(objectBox(demoModel, second).intersectsBox(objectBox(demoModel, first.transform))).toBe(false);
  });

  it('does not change its inputs', () => {
    const objects = [object('a')];
    const before = JSON.stringify(objects);
    placeBeside(objects, boxModel());
    expect(JSON.stringify(objects)).toBe(before);
  });
});

describe('createObject', () => {
  it('uses the given id and time, places the object and marks it unedited', () => {
    const ws = workspace([object('a')]);
    const model = boxModel(['body', 'lid'], vec(1, 1, 1), 'Lamp');
    const created = createObject(ws, { id: 'lamp-1', model, source: 'demo', providerModel: 'none', createdAt: CREATED_AT });
    expect(created.id).toBe('lamp-1');
    expect(created.createdAt).toBe(CREATED_AT);
    expect(created.edited).toBe(false);
    expect(created.source).toBe('demo');
    expect(created.providerModel).toBe('none');
    expect(created.model).toEqual(model);
    expect(created.transform).toEqual(placeBeside(ws.objects, model));
    expect(ws.objects).toHaveLength(1);
  });

  it('places the first object at the origin', () => {
    const created = createObject(emptyWorkspace(), { id: 'a', model: demoModel, source: 'demo', providerModel: 'none', createdAt: CREATED_AT });
    expect(created.transform).toEqual({ position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
  });

  it('produces an object that fits the schema', () => {
    const ws = emptyWorkspace();
    const created = createObject(ws, { id: 'a', model: demoModel, source: 'demo', providerModel: 'none', createdAt: CREATED_AT });
    expect(() => validateWorkspace({ ...ws, objects: [created], activeObjectId: 'a' })).not.toThrow();
  });

  it('validates the model', () => {
    const bad = { ...boxModel(), parts: [{ ...boxModel().parts[0]!, parentId: 'missing' }] };
    expect(() => createObject(emptyWorkspace(), { id: 'a', model: bad, source: 'x', providerModel: 'y', createdAt: CREATED_AT })).toThrow();
    expect(() => createObject(emptyWorkspace(), { id: 'a', model: { nope: true }, source: 'x', providerModel: 'y', createdAt: CREATED_AT })).toThrow();
  });

  it('does not check the object limit', () => {
    const full = workspace(Array.from({ length: MAX_OBJECTS }, (_, index) => object(`o${index}`)));
    expect(() => createObject(full, { id: 'extra', model: boxModel(), source: 'x', providerModel: 'y', createdAt: CREATED_AT })).not.toThrow();
  });
});
