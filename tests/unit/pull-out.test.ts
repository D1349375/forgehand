import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { assemblyOf, objectMatrix } from '../../shared/assembly';
import { objectBox, partBoxes, worldMatrices } from '../../shared/bounds';
import { demoModel } from '../../shared/demo';
import { touching, worldFace } from '../../shared/contact';
import type { Joint, JointSide } from '../../shared/joint';
import { newJoint } from '../../shared/joint-rules';
import type { ModelSpec, Part } from '../../shared/model';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import {
  placeNextTo, pullOutCheck, pullOutPart, pulledObject, splitForJoin, subtreeIds, type PullOutInput,
} from '../../shared/pull-out';
import {
  MAX_OBJECTS, ObjectChangeSchema, WorkspaceChangeSchema, WorkspaceError, addJoint, addObject, applyWorkspaceChange, emptyWorkspace,
  selectParts, setActiveObject, setExplode, type ObjectTransform, type SceneObject, type Workspace, type WorkspaceChange,
} from '../../shared/workspace';
import { initialWorkspaceState, workspaceReducer } from '../../src/workspace/store';
import { CREATED_AT, fixtureJoint, fixtureModel, fixtureObject, fixturePart, side } from '../fixtures/joint-workspace';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const at = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): ObjectTransform => ({ position: vec(x, y, z), rotation: vec(rx, ry, rz) });
const pull = (objectId: string, partId: string, newObjectId = 'new', extra: Partial<PullOutInput> = {}): PullOutInput =>
  ({ objectId, partId, newObjectId, createdAt: CREATED_AT, ...extra });

/** A box part; sizes and positions in metres. */
function box(id: string, size: [number, number, number], position: [number, number, number] = [0, 0, 0], extra: Partial<Part> = {}): Part {
  return { ...fixturePart(id, 'box', vec(...size), vec(...position)), ...extra };
}
const objectOf = (id: string, name: string, parts: Part[], transform: ObjectTransform = at()): SceneObject =>
  fixtureObject(id, fixtureModel(name, parts), transform);
/** Adds the objects in order, then makes `active` (default: the first) the active object. */
function workspaceOf(objects: SceneObject[], active = objects[0]?.id): Workspace {
  const ws = objects.reduce(addObject, emptyWorkspace());
  return active === undefined ? ws : setActiveObject(ws, active);
}
const joint = (id: string, a: JointSide, b: JointSide, extra: Partial<Joint> = {}): Joint => fixtureJoint(a, b, { id, ...extra });

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The eight world corners of a part's box, with the object transform applied. */
function corners(object: SceneObject, partId: string): THREE.Vector3[] {
  const part = object.model.parts.find(candidate => candidate.id === partId)!;
  const matrix = objectMatrix(object.transform).multiply(worldMatrices(object.model).get(partId)!);
  const half = new THREE.Vector3(part.dimensions.x, part.dimensions.y, part.dimensions.z).multiplyScalar(0.5);
  return [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => new THREE.Vector3(x * half.x, y * half.y, z * half.z).applyMatrix4(matrix))));
}

/** Largest distance between matching corners after removing `shift`, over the given parts. */
function cornerError(before: SceneObject, after: SceneObject, partIds: readonly string[], shift = new THREE.Vector3()): number {
  let worst = 0;
  for (const id of partIds) {
    const a = corners(before, id);
    const b = corners(after, id);
    a.forEach((corner, index) => { worst = Math.max(worst, corner.clone().add(shift).distanceTo(b[index]!)); });
  }
  return worst;
}

const objectById = (ws: Workspace, id: string): SceneObject => ws.objects.find(object => object.id === id)!;

/** Whether the two faces of a joint touch (AJ R22), the rule that decides whether it can be built. */
function jointTouches(ws: Workspace, id: string): { ok: boolean; gapMm: number; angleDeg: number } {
  const found = ws.joints.find(candidate => candidate.id === id)!;
  const faces = [found.a, found.b].map(end => {
    const object = objectById(ws, end.objectId);
    return worldFace(object, object.model.parts.find(part => part.id === end.partId)!, end.face)!;
  });
  const { ok, gapMm, angleDeg } = touching(faces[0]!, faces[1]!);
  return { ok, gapMm, angleDeg };
}

/**
 * Body with a lid on top, a knob on the lid and a foot that is a root of its own:
 * `body` > `lid` > `knob`, and `foot`. Every part touches its parent.
 */
function stackParts(): Part[] {
  return [
    box('body', [0.04, 0.02, 0.03]),
    box('lid', [0.03, 0.01, 0.02], [0, 0.015, 0], { parentId: 'body' }),
    box('knob', [0.01, 0.01, 0.01], [0, 0.01, 0], { parentId: 'lid' }),
    box('foot', [0.02, 0.01, 0.02], [0, -0.02, 0]),
  ];
}

describe('subtreeIds', () => {
  it('lists the part and every descendant in model order, also when a child comes before its parent', () => {
    const model: ModelSpec = fixtureModel('Order', [
      box('leaf', [0.01, 0.01, 0.01], [0, 0, 0], { parentId: 'mid' }),
      box('other', [0.01, 0.01, 0.01]),
      box('mid', [0.01, 0.01, 0.01], [0, 0, 0], { parentId: 'top' }),
      box('top', [0.01, 0.01, 0.01]),
      box('side', [0.01, 0.01, 0.01], [0, 0, 0], { parentId: 'top' }),
    ]);
    expect(subtreeIds(model, 'top')).toEqual(['leaf', 'mid', 'top', 'side']);
    expect(subtreeIds(model, 'mid')).toEqual(['leaf', 'mid']);
    expect(subtreeIds(model, 'leaf')).toEqual(['leaf']);
    expect(subtreeIds(model, 'other')).toEqual(['other']);
  });

  it('is empty for an unknown part', () => {
    expect(subtreeIds(fixtureModel('One', stackParts()), 'nope')).toEqual([]);
  });
});

describe('pullOutCheck', () => {
  const ws = workspaceOf([objectOf('o', 'Rig', stackParts())]);

  it('reports each refusal with its code', () => {
    expect(pullOutCheck(ws, 'nope', 'lid')).toEqual({ ok: false, code: 'UNKNOWN_OBJECT' });
    expect(pullOutCheck(ws, 'o', 'nope')).toEqual({ ok: false, code: 'UNKNOWN_PART' });
    expect(pullOutCheck(workspaceOf([objectOf('s', 'Single', [box('only', [0.01, 0.01, 0.01])])]), 's', 'only')).toEqual({ ok: false, code: 'WHOLE_OBJECT' });
    const chain = workspaceOf([objectOf('c', 'Chain', [box('a', [0.01, 0.01, 0.01]), box('b', [0.01, 0.01, 0.01], [0, 0, 0], { parentId: 'a' })])]);
    expect(pullOutCheck(chain, 'c', 'a')).toEqual({ ok: false, code: 'WHOLE_OBJECT' });
    expect(pullOutCheck(chain, 'c', 'b')).toMatchObject({ ok: true });
  });

  it('refuses at MAX_OBJECTS', () => {
    const objects = Array.from({ length: MAX_OBJECTS }, (_, index) => objectOf(`o${index}`, `Rig ${index}`, stackParts(), at(index, 0, 0)));
    expect(pullOutCheck(workspaceOf(objects), 'o0', 'lid')).toEqual({ ok: false, code: 'OBJECT_LIMIT' });
  });

  it('gives the first failing reason in the order object, part, whole object, limit', () => {
    const full = workspaceOf(Array.from({ length: MAX_OBJECTS }, (_, index) => objectOf(`o${index}`, `Rig ${index}`,
      index === 0 ? [box('a', [0.01, 0.01, 0.01]), box('b', [0.01, 0.01, 0.01], [0, 0, 0], { parentId: 'a' })] : stackParts(), at(index, 0, 0))));
    expect(pullOutCheck(full, 'nope', 'nope')).toEqual({ ok: false, code: 'UNKNOWN_OBJECT' });
    expect(pullOutCheck(full, 'o0', 'nope')).toEqual({ ok: false, code: 'UNKNOWN_PART' });
    expect(pullOutCheck(full, 'o0', 'a')).toEqual({ ok: false, code: 'WHOLE_OBJECT' });
    expect(pullOutCheck(full, 'o0', 'b')).toEqual({ ok: false, code: 'OBJECT_LIMIT' });
  });

  it('lists the subtree and says in place only when a joint has exactly one side in it', () => {
    expect(pullOutCheck(ws, 'o', 'lid')).toEqual({ ok: true, partIds: ['lid', 'knob'], inPlace: false });

    const inside = addJoint(ws, joint('j1', side('o', 'lid', '+y'), side('o', 'knob', '-y')));
    expect(pullOutCheck(inside, 'o', 'lid')).toMatchObject({ ok: true, inPlace: false });

    const outside = addJoint(ws, joint('j1', side('o', 'body', '+x'), side('o', 'foot', '-x')));
    expect(pullOutCheck(outside, 'o', 'lid')).toMatchObject({ ok: true, inPlace: false });

    const across = addJoint(ws, joint('j1', side('o', 'body', '+y'), side('o', 'lid', '-y')));
    expect(pullOutCheck(across, 'o', 'lid')).toMatchObject({ ok: true, inPlace: true });
    expect(pullOutCheck(across, 'o', 'knob')).toMatchObject({ ok: true, inPlace: false });

    const other = workspaceOf([objectOf('o', 'Rig', stackParts()), objectOf('p', 'Plate', [box('plate', [0.03, 0.01, 0.02])], at(0, 0.05, 0))]);
    const toOther = addJoint(other, joint('j1', side('o', 'knob', '+y'), side('p', 'plate', '-y')));
    expect(pullOutCheck(toOther, 'o', 'lid')).toMatchObject({ ok: true, inPlace: true });
    expect(pullOutCheck(toOther, 'o', 'foot')).toMatchObject({ ok: true, inPlace: false });
  });
});

describe('pullOutPart on the demo model', () => {
  // The relations below hold for any version of the demo: they compare the model with itself, not with fixed numbers.
  const demo = () => workspaceOf([fixtureObject('demo', demoModel, at())]);

  it('puts the battery beside the original, same size and height, shifted along X only', () => {
    const ws = demo();
    const before = partBoxes(demoModel).get('battery')!;
    const next = pullOutPart(ws, pull('demo', 'battery'));
    expect(next.objects.map(object => object.id)).toEqual(['demo', 'new']);
    const original = objectById(next, 'demo');
    const pulled = objectById(next, 'new');
    expect(original.model.parts.map(part => part.id)).not.toContain('battery');
    expect(original.model.parts).toHaveLength(demoModel.parts.length - 1);
    expect(pulled.model.parts.map(part => part.id)).toEqual(['battery']);

    const after = objectBox(pulled.model, pulled.transform);
    const sizeBefore = before.getSize(new THREE.Vector3());
    const sizeAfter = after.getSize(new THREE.Vector3());
    expect(sizeAfter.distanceTo(sizeBefore)).toBeLessThan(1e-9);
    expect(after.min.y).toBeCloseTo(before.min.y, 4);
    expect(after.min.z).toBeCloseTo(before.min.z, 4);
    expect(after.min.x).toBeGreaterThan(before.min.x);

    // Requirement 42: the box starts max(0.02 m, 10 % of its width) past the right edge of what stays.
    const rest = objectBox(original.model, original.transform);
    expect(after.min.x - rest.max.x).toBeCloseTo(Math.max(0.02, 0.1 * sizeBefore.x), 4);
  });

  it('takes the housing with its children and leaves the roots beside it', () => {
    const ws = demo();
    const expected = demoModel.parts.filter(part => part.id === 'housing' || part.parentId === 'housing').map(part => part.id);
    expect(expected.length).toBeGreaterThan(1);
    const next = pullOutPart(ws, pull('demo', 'housing'));
    expect(objectById(next, 'new').model.parts.map(part => part.id)).toEqual(expected);
    expect(objectById(next, 'demo').model.parts.map(part => part.id)).toEqual(['support', 'base']);
    const root = objectById(next, 'new').model.parts[0]!;
    expect(root).toMatchObject({ id: 'housing', parentId: null, position: vec(0, 0, 0) });
    // Parts below the root are unchanged (their numbers are relative to their parent).
    for (const part of objectById(next, 'new').model.parts.slice(1)) expect(part).toEqual(demoModel.parts.find(candidate => candidate.id === part.id));

    // Before placement, every corner is where it was; after placement all of them moved by one shift along X (and Z).
    const inPlace = pullOutPart(ws, pull('demo', 'housing', 'new', { inPlace: true }));
    expect(cornerError(objectById(ws, 'demo'), objectById(inPlace, 'new'), expected)).toBeLessThan(1e-5);
    const shift = corners(objectById(next, 'new'), 'housing')[0]!.clone().sub(corners(objectById(ws, 'demo'), 'housing')[0]!);
    expect(Math.abs(shift.y)).toBeLessThan(1e-9);
    expect(cornerError(objectById(ws, 'demo'), objectById(next, 'new'), expected, shift)).toBeLessThan(1e-5);
  });

  it('refuses the whole object with a fixed message', () => {
    const ws = workspaceOf([objectOf('o', 'One', [box('only', [0.01, 0.01, 0.01])])]);
    expect(() => pullOutPart(ws, pull('o', 'only'))).toThrow(new WorkspaceError('WHOLE_OBJECT'));
    expect(new WorkspaceError('WHOLE_OBJECT').message).toBe('這個零件連同子零件就是整個物件，不需要拉出。');
    expect(new WorkspaceError('UNKNOWN_PART').message).toBe('找不到指定的零件。');
  });
});

describe('re-rooting in place', () => {
  it('keeps every corner within 1e-5 m for a rotated object and a rotated, nested child', () => {
    const parts = [
      box('base', [0.05, 0.03, 0.04], [0.02, 0.01, 0], { rotation: vec(0, 20, 0) }),
      box('arm', [0.06, 0.02, 0.02], [0.05, 0, 0.01], { parentId: 'base', rotation: vec(0, 35, 0) }),
      box('tip', [0.02, 0.03, 0.02], [0.03, 0.02, 0], { parentId: 'arm', rotation: vec(0, 15, 0) }),
      box('other', [0.02, 0.02, 0.02], [0.1, 0, 0]),
    ];
    const ws = workspaceOf([objectOf('o', 'Arm', parts, at(0.3, 0.1, -0.2, 0, 40, 0))]);
    const next = pullOutPart(ws, pull('o', 'arm', 'new', { inPlace: true }));
    const before = objectById(ws, 'o');
    const pulled = objectById(next, 'new');
    expect(pulled.model.parts.map(part => part.id)).toEqual(['arm', 'tip']);
    expect(cornerError(before, pulled, ['arm', 'tip'])).toBeLessThan(1e-5);
    expect(pulled.transform.rotation).toBe(before.transform.rotation);
    expect(pulled.model.parts[0]).toMatchObject({ parentId: null, position: vec(0, 0, 0) });
    expect(pulled.model.parts[1]).toEqual(parts[2]);
    // The original lost the subtree and nothing else.
    expect(objectById(next, 'o').model.parts.map(part => part.id)).toEqual(['base', 'other']);
    expect(cornerError(before, objectById(next, 'o'), ['base', 'other'])).toBe(0);
  });

  it('stays within the 0.01 mm and 0.01 degree rounding for angles on all three axes', () => {
    const parts = [
      box('base', [0.05, 0.03, 0.04], [0.02, 0.01, 0], { rotation: vec(12.345, 20.678, -7.9) }),
      box('arm', [0.06, 0.02, 0.02], [0.05, 0, 0.01], { parentId: 'base', rotation: vec(33.33, -41.17, 5.55) }),
      box('tip', [0.02, 0.03, 0.02], [0.03, 0.02, 0], { parentId: 'arm', rotation: vec(15.15, 15.5, 80.01) }),
      box('other', [0.02, 0.02, 0.02], [0.1, 0, 0]),
    ];
    const ws = workspaceOf([objectOf('o', 'Arm', parts, at(0.3, 0.1, -0.2, 12.34, 56.78, -9.01))]);
    const next = pullOutPart(ws, pull('o', 'arm', 'new', { inPlace: true }));
    expect(cornerError(objectById(ws, 'o'), objectById(next, 'new'), ['arm', 'tip'])).toBeLessThan(3e-5);
    const root = objectById(next, 'new').model.parts[0]!;
    for (const value of [root.rotation.x, root.rotation.y, root.rotation.z]) expect(Math.round(value * 100) / 100).toBe(value);
    for (const value of Object.values(objectById(next, 'new').transform.position)) expect(Math.round(value * 1e5) / 1e5).toBe(value);
  });

  it('copies source, provider, material and sets edited, name, summary and no assumptions', () => {
    const object: SceneObject = { ...objectOf('o', 'Rig', stackParts()), source: 'codex', providerModel: 'gpt-x', material: 'aluminium', edited: false };
    const ws = workspaceOf([object]);
    const { original, pulled } = pulledObject(ws, pull('o', 'lid'));
    expect(pulled).toMatchObject({
      id: 'new', source: 'codex', providerModel: 'gpt-x', material: 'aluminium', edited: true, createdAt: CREATED_AT,
      model: { name: 'lid', summary: '從「Rig」拉出的零件。', assumptions: [], schemaVersion: '1.0', units: 'm' },
    });
    expect(original.edited).toBe(true);
    expect(original.material).toBe('aluminium');
    expect(original.model.parts.map(part => part.id)).toEqual(['body', 'foot']);
  });

  it('keeps a part that is already a root exactly as it was', () => {
    const ws = workspaceOf([objectOf('o', 'Rig', stackParts().map(part => (part.id === 'foot' ? { ...part, rotation: vec(200, 10, -30) } : part)), at(0, 0, 0, 5, 10, 15))]);
    const next = pullOutPart(ws, pull('o', 'foot', 'new', { inPlace: true }));
    expect(objectById(next, 'new').model.parts[0]!.rotation).toEqual(vec(200, 10, -30));
    expect(cornerError(objectById(ws, 'o'), objectById(next, 'new'), ['foot'])).toBeLessThan(1e-5);
  });

  it('rejects ids and times the schemas reject, and a position outside the limits', () => {
    const ws = workspaceOf([objectOf('o', 'Rig', stackParts())]);
    expect(() => pullOutPart(ws, pull('o', 'lid', 'bad id!'))).toThrow(new WorkspaceError('INVALID_WORKSPACE'));
    expect(() => pullOutPart(ws, { ...pull('o', 'lid'), createdAt: 'yesterday' })).toThrow(new WorkspaceError('INVALID_WORKSPACE'));
    expect(() => pullOutPart(ws, pull('o', 'lid', 'o'))).toThrow(new WorkspaceError('DUPLICATE_OBJECT'));
    const edge = workspaceOf([objectOf('o', 'Edge', [box('body', [0.04, 0.02, 0.03]), box('far', [0.02, 0.02, 0.02], [0.05, 0, 0], { parentId: 'body' })], at(99.99, 0, 0))]);
    expect(() => pullOutPart(edge, pull('o', 'far', 'new', { inPlace: true }))).toThrow(new WorkspaceError('INVALID_WORKSPACE'));
    // Without `inPlace` the part is placed back inside the limits (to the left).
    expect(Math.abs(objectById(pullOutPart(edge, pull('o', 'far')), 'new').transform.position.x)).toBeLessThanOrEqual(100);
  });
});

describe('joints', () => {
  const ROTATED = at(0.1, 0.05, -0.2, 12.34, 56.78, 9.01);

  /** A body with a lid on top (the lid turned about its own Y axis); the joint ties the touching faces. */
  function lidWorkspace(transform: ObjectTransform, lidRotation: number, bodyRotation = 0): Workspace {
    const parts = [
      box('body', [0.04, 0.02, 0.03], [0, 0, 0], { rotation: vec(0, 0, bodyRotation) }),
      box('lid', [0.02, 0.02, 0.02], [0, 0.02, 0], { parentId: 'body', rotation: vec(0, lidRotation, 0) }),
    ];
    return addJoint(workspaceOf([objectOf('o', 'Lid', parts, transform)]),
      joint('j1', side('o', 'body', '+y'), side('o', 'lid', '-y'), { method: { kind: 'glue', glue: 'ca' }, confirmed: true }));
  }

  it('re-points a joint between the subtree and the rest, keeps the part in place and keeps the faces touching', () => {
    for (const [transform, lid, body] of [[at(), 45, 0], [ROTATED, 45, 0], [ROTATED, 33.33, 17.77]] as const) {
      const ws = lidWorkspace(transform, lid, body);
      expect(jointTouches(ws, 'j1').ok).toBe(true);
      const next = pullOutPart(ws, pull('o', 'lid'));
      const moved = next.joints[0]!;
      expect(moved).toEqual({ ...ws.joints[0]!, b: { objectId: 'new', partId: 'lid', face: '-y' } });
      expect(moved.a).toBe(ws.joints[0]!.a);
      const check = jointTouches(next, 'j1');
      expect(check.ok).toBe(true);
      expect(Math.abs(check.gapMm)).toBeLessThan(0.05);
      expect(check.angleDeg).toBeLessThan(0.05);
      expect(assemblyOf(next, 'o')).toEqual(['o', 'new']);
      // In place: the lid's world corners did not move.
      expect(cornerError(objectById(ws, 'o'), objectById(next, 'new'), ['lid'])).toBeLessThan(2e-5);
    }
  });

  it('re-points a joint to another object and lets the original leave that assembly', () => {
    const rig = objectOf('o', 'Rig', [box('body', [0.04, 0.02, 0.03]), box('arm', [0.03, 0.02, 0.02], [0.035, 0, 0], { parentId: 'body' })]);
    const plate = objectOf('p', 'Plate', [box('plate', [0.01, 0.03, 0.03])], at(0.055, 0, 0));
    const ws = addJoint(workspaceOf([rig, plate]), joint('j1', side('o', 'arm', '+x'), side('p', 'plate', '-x')));
    expect(assemblyOf(ws, 'p')).toEqual(['o', 'p']);
    expect(jointTouches(ws, 'j1').ok).toBe(true);
    const next = pullOutPart(ws, pull('o', 'arm'));
    expect(next.joints[0]).toEqual({ ...ws.joints[0]!, a: { objectId: 'new', partId: 'arm', face: '+x' } });
    expect(next.joints[0]!.b).toBe(ws.joints[0]!.b);
    expect(assemblyOf(next, 'p')).toEqual(['new', 'p']); // workspace order: the new object sits right after the original
    expect(assemblyOf(next, 'o')).toEqual(['o']);
    expect(jointTouches(next, 'j1').ok).toBe(true);
    expect(objectById(next, 'p')).toBe(objectById(ws, 'p'));
  });

  it('keeps a joint inside the subtree as a joint inside the new object, which is then placed beside', () => {
    const ws = addJoint(workspaceOf([objectOf('o', 'Rig', stackParts())]), joint('j1', side('o', 'lid', '+y'), side('o', 'knob', '-y')));
    const next = pullOutPart(ws, pull('o', 'lid'));
    expect(next.joints[0]).toEqual({ ...ws.joints[0]!, a: side('new', 'lid', '+y'), b: side('new', 'knob', '-y') });
    expect(objectById(next, 'new').transform.position.x).toBeGreaterThan(0.02);
    expect(jointTouches(next, 'j1').ok).toBe(true);
  });

  it('keeps the joints of other parts by reference, and the whole array when nothing changed', () => {
    const base = workspaceOf([objectOf('o', 'Rig', stackParts()), objectOf('p', 'Plate', [box('plate', [0.03, 0.01, 0.02])], at(0, 0.05, 0))]);
    const untouched = joint('j1', side('o', 'body', '+x'), side('p', 'plate', '-x'));
    const moving = joint('j2', side('o', 'lid', '+x'), side('p', 'plate', '+x'));
    const ws = addJoint(addJoint(base, untouched), moving);
    const next = pullOutPart(ws, pull('o', 'lid'));
    expect(next.joints[0]).toBe(ws.joints[0]);
    expect(next.joints[1]).not.toBe(ws.joints[1]);
    expect(next.joints[1]!.a.objectId).toBe('new');
    expect(next.joints[1]).toMatchObject({ id: 'j2', method: moving.method, needs: moving.needs, confirmed: moving.confirmed });

    const quiet = addJoint(base, untouched);
    expect(pullOutPart(quiet, pull('o', 'lid')).joints).toBe(quiet.joints);
  });
});

describe('workspace state', () => {
  const rig = () => workspaceOf([
    objectOf('x', 'Left', [box('x1', [0.02, 0.02, 0.02])], at(-1, 0, 0)),
    objectOf('o', 'Rig', stackParts()),
    objectOf('y', 'Right', [box('y1', [0.02, 0.02, 0.02])], at(1, 0, 0)),
  ], 'o');

  it('inserts the new object right after the original and keeps other objects by reference', () => {
    const ws = rig();
    const next = pullOutPart(ws, pull('o', 'lid'));
    expect(next.objects.map(object => object.id)).toEqual(['x', 'o', 'new', 'y']);
    expect(next.objects[0]).toBe(ws.objects[0]);
    expect(next.objects[3]).toBe(ws.objects[2]);
    expect(next.joints).toBe(ws.joints);
  });

  it('keeps the original active and the explode amount, and removes pulled parts from the selection', () => {
    const exploded = setExplode(rig(), 0.6);
    const selected = selectParts(exploded, 'o', ['lid', 'body', 'knob']);
    const next = pullOutPart(selected, pull('o', 'lid'));
    expect(next.activeObjectId).toBe('o');
    expect(next.display.explode).toBe(0.6);
    expect(next.selection).toEqual({ objectId: 'o', partIds: ['body'] });

    const onlyPulled = pullOutPart(selectParts(exploded, 'o', ['knob']), pull('o', 'lid'));
    expect(onlyPulled.selection).toEqual({ objectId: null, partIds: [] });
    expect(onlyPulled.activeObjectId).toBe('o');

    const unrelated = selectParts(exploded, 'o', ['body', 'foot']);
    expect(pullOutPart(unrelated, pull('o', 'lid')).selection).toBe(unrelated.selection);
    const none = rig();
    expect(pullOutPart(none, pull('o', 'lid')).selection).toBe(none.selection);
  });

  it('does not mutate its input and throws only WorkspaceError', () => {
    const frozen = deepFreeze(structuredClone(selectParts(rig(), 'o', ['lid'])));
    const next = pullOutPart(frozen, pull('o', 'lid'));
    expect(next).not.toBe(frozen);
    expect(frozen.objects).toHaveLength(3);
    for (const input of [pull('nope', 'lid'), pull('o', 'nope'), pull('o', 'lid', 'x'), pull('o', 'lid', '!!')]) {
      let caught: unknown;
      try { pullOutPart(frozen, input); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(WorkspaceError);
    }
  });
});

describe('placeNextTo', () => {
  const orig = () => objectOf('orig', 'Original', [box('a', [0.1, 0.1, 0.1])]);
  const pulled = () => objectOf('pulled', 'Pulled', [box('p', [0.04, 0.04, 0.04])], at(0.01, 0.02, 0.03, 5, 6, 7));
  const obstacle = (id: string, x: number, z: number) => objectOf(id, id, [box('b', [0.04, 0.04, 0.04])], at(x, 0.02, z));

  it('goes to the right of the original, keeping height, depth and rotation', () => {
    const result = placeNextTo([], orig(), pulled());
    // The pulled box is rotated 5, 6, 7 degrees, so measure the gap from its own box.
    const moved = { ...pulled(), transform: result };
    expect(objectBox(moved.model, moved.transform).min.x).toBeCloseTo(0.05 + 0.02, 4);
    expect(result.position.y).toBe(0.02);
    expect(result.position.z).toBe(0.03);
    expect(result.rotation).toEqual(vec(5, 6, 7));
  });

  it('tries the left, then the front, then the back, then goes past every box', () => {
    const right = obstacle('right', 0.1, 0);
    const left = obstacle('left', -0.09, 0);
    const front = obstacle('front', 0.01, 0.09);
    const back = obstacle('back', 0.01, -0.09);
    const flat = { ...pulled(), transform: at(0.01, 0.02, 0.03) };
    const box0 = (extra: SceneObject[]) => placeNextTo(extra, orig(), flat).position;

    expect(box0([right])).toEqual(vec(-0.09, 0.02, 0.03));
    expect(box0([right, left])).toEqual(vec(0.01, 0.02, 0.09));
    expect(box0([right, left, front])).toEqual(vec(0.01, 0.02, -0.09));
    // Everything blocked: past the right edge of the furthest box (0.12) plus the gap, measured from the pulled box.
    const past = box0([right, left, front, back]);
    expect(past.x).toBeCloseTo(0.01 + 0.12 + 0.02 + 0.01, 5);
    expect(past.y).toBe(0.02);
    expect(past.z).toBe(0.03);
  });

  it('uses 10 % of the width as the gap when that is more than 20 mm, and keeps inside the position limit', () => {
    const wide = objectOf('wide', 'Wide', [box('w', [0.5, 0.04, 0.04])], at(0, 0.02, 0));
    const result = placeNextTo([], orig(), wide);
    expect(result.position.x - 0.25 - 0.05).toBeCloseTo(0.05, 4);

    const far = objectOf('orig', 'Far', [box('a', [0.1, 0.1, 0.1])], at(99.95, 0, 0));
    const left = placeNextTo([], far, pulled());
    expect(left.position.x).toBeLessThan(99.9);
    expect(left.position.x).toBeGreaterThan(99.7);
  });
});

describe('the pull-out object change', () => {
  const ws = () => workspaceOf([
    objectOf('o', 'Rig', stackParts()),
    objectOf('p', 'Plate', [box('plate', [0.03, 0.01, 0.02])], at(0, 0.5, 0)),
  ], 'p');
  const change = (extra: Partial<WorkspaceChange> = {}, inPlace?: true): WorkspaceChange => ({
    activeObjectId: null,
    object: { op: 'pull-out', objectId: 'o', partId: 'lid', newObjectId: 'new', createdAt: CREATED_AT, ...(inPlace ? { inPlace } : {}) },
    selection: null,
    explode: null,
    ...extra,
  });

  it('applies like pullOutPart', () => {
    const start = ws();
    expect(applyWorkspaceChange(start, change()).after).toEqual(pullOutPart(start, pull('o', 'lid')));
    expect(applyWorkspaceChange(start, change({}, true)).after).toEqual(pullOutPart(start, pull('o', 'lid', 'new', { inPlace: true })));
    const activated = applyWorkspaceChange(start, change({ activeObjectId: 'o' }));
    expect(activated.before.activeObjectId).toBe('o');
    expect(activated.after).toEqual(pullOutPart(setActiveObject(start, 'o'), pull('o', 'lid')));
  });

  it('surfaces the refusals of the operation', () => {
    expect(() => applyWorkspaceChange(ws(), change({ object: { op: 'pull-out', objectId: 'o', partId: 'nope', newObjectId: 'new', createdAt: CREATED_AT } })))
      .toThrow(new WorkspaceError('UNKNOWN_PART'));
    expect(() => applyWorkspaceChange(ws(), change({ object: { op: 'pull-out', objectId: 'zz', partId: 'lid', newObjectId: 'new', createdAt: CREATED_AT } })))
      .toThrow(new WorkspaceError('UNKNOWN_OBJECT'));
  });

  it('parses the new payload, rejects bad ones and still parses every old one', () => {
    expect(ObjectChangeSchema.safeParse({ op: 'pull-out', objectId: 'o', partId: 'lid', newObjectId: 'n', createdAt: CREATED_AT }).success).toBe(true);
    expect(ObjectChangeSchema.safeParse({ op: 'pull-out', objectId: 'o', partId: 'lid', newObjectId: 'n', createdAt: CREATED_AT, inPlace: true }).success).toBe(true);
    for (const bad of [
      { op: 'pull-out', objectId: 'o', partId: 'lid', newObjectId: 'n', createdAt: CREATED_AT, inPlace: false },
      { op: 'pull-out', objectId: 'o', partId: 'lid', newObjectId: 'n' },
      { op: 'pull-out', objectId: 'o', partId: 'lid', newObjectId: 'bad id', createdAt: CREATED_AT },
      { op: 'pull-out', objectId: 'o', partId: 'lid', newObjectId: 'n', createdAt: CREATED_AT, extra: 1 },
    ]) expect(ObjectChangeSchema.safeParse(bad).success).toBe(false);

    const object = objectOf('o', 'Rig', stackParts());
    const olds = [
      { op: 'add', object }, { op: 'model', objectId: 'o', model: object.model, source: 'x', providerModel: 'y' },
      { op: 'transform', objectId: 'o', transform: at() }, { op: 'remove', objectId: 'o' }, { op: 'material', objectId: 'o', material: null },
    ];
    for (const old of olds) {
      expect(ObjectChangeSchema.safeParse(old).success).toBe(true);
      expect(WorkspaceChangeSchema.safeParse({ activeObjectId: null, object: old, selection: null, explode: null }).success).toBe(true);
    }
    expect(WorkspaceChangeSchema.safeParse(change()).success).toBe(true);
  });
});

describe('undo', () => {
  it('is one undo step: undo restores the original objects and joints by reference, redo repeats it', () => {
    const start = addJoint(workspaceOf([objectOf('o', 'Rig', stackParts())]), joint('j1', side('o', 'body', '+y'), side('o', 'lid', '-y')));
    const next = pullOutPart(start, pull('o', 'lid'));
    const committed = workspaceReducer({ ...initialWorkspaceState, workspace: start }, { type: 'commit', next });
    expect(committed.past).toHaveLength(1);
    expect(committed.workspace).toBe(next);

    const undone = workspaceReducer(committed, { type: 'undo' });
    expect(undone.workspace.objects).toBe(start.objects);
    expect(undone.workspace.joints).toBe(start.joints);
    expect(undone.workspace.activeObjectId).toBe('o');
    expect(undone.workspace.objects.map(object => object.id)).toEqual(['o']);
    expect(undone.past).toHaveLength(0);

    const redone = workspaceReducer(undone, { type: 'redo' });
    expect(redone.workspace.objects).toBe(next.objects);
    expect(redone.workspace.joints).toBe(next.joints);
    expect(redone.workspace.objects.map(object => object.id)).toEqual(['o', 'new']);
  });
});

describe('splitForJoin', () => {
  const ws = () => workspaceOf([objectOf('o', 'Rig', stackParts())]);

  it('pulls out the side that is not an ancestor of the other, in place', () => {
    const parent = splitForJoin(ws(), side('o', 'body', '+y'), side('o', 'lid', '-y'), { newObjectId: 'new', createdAt: CREATED_AT })!;
    expect(parent.pulled).toBe('b');
    expect(parent.a).toEqual(side('o', 'body', '+y'));
    expect(parent.b).toEqual(side('new', 'lid', '-y'));
    expect(parent.change).toEqual({ op: 'pull-out', objectId: 'o', partId: 'lid', newObjectId: 'new', createdAt: CREATED_AT, inPlace: true });
    expect(ObjectChangeSchema.safeParse(parent.change).success).toBe(true);
    expect(parent.ws).toEqual(pullOutPart(ws(), pull('o', 'lid', 'new', { inPlace: true })));

    const child = splitForJoin(ws(), side('o', 'lid', '-y'), side('o', 'body', '+y'), { newObjectId: 'new', createdAt: CREATED_AT })!;
    expect(child.pulled).toBe('a');
    expect(child.a).toEqual(side('new', 'lid', '-y'));
    expect(child.b).toEqual(side('o', 'body', '+y'));

    // A grandchild against its grandparent: the grandchild leaves and takes nothing else.
    const deep = splitForJoin(ws(), side('o', 'body', '+y'), side('o', 'knob', '-y'), { newObjectId: 'new', createdAt: CREATED_AT })!;
    expect(deep.pulled).toBe('b');
    expect(objectById(deep.ws, 'new').model.parts.map(part => part.id)).toEqual(['knob']);
  });

  it('pulls out side b when the parts are unrelated, and the pair still touches and joins', () => {
    const stack = objectOf('o', 'Pair', [box('low', [0.04, 0.02, 0.03]), box('high', [0.03, 0.01, 0.02], [0, 0.015, 0])], at(0.2, 0, 0, 0, 30, 0));
    const start = workspaceOf([stack]);
    const split = splitForJoin(start, side('o', 'low', '+y'), side('o', 'high', '-y'), { newObjectId: 'new', createdAt: CREATED_AT })!;
    expect(split.pulled).toBe('b');
    expect(objectById(split.ws, 'new').model.parts.map(part => part.id)).toEqual(['high']);

    const created = newJoint(split.ws, { id: 'j1', createdAt: CREATED_AT, a: split.a, b: split.b }, DEFAULT_PRINTER_PROFILE);
    const joined = addJoint(split.ws, created);
    expect(jointTouches(joined, 'j1').ok).toBe(true);
    expect(assemblyOf(joined, 'o')).toEqual(['o', 'new']);
  });

  it('returns null for two objects and throws for the cases it cannot split', () => {
    const two = workspaceOf([objectOf('o', 'Rig', stackParts()), objectOf('p', 'Plate', [box('plate', [0.03, 0.01, 0.02])], at(1, 0, 0))]);
    expect(splitForJoin(two, side('o', 'body', '+y'), side('p', 'plate', '-y'), { newObjectId: 'new', createdAt: CREATED_AT })).toBeNull();

    const ids = { newObjectId: 'new', createdAt: CREATED_AT };
    expect(() => splitForJoin(ws(), side('nope', 'body', '+y'), side('nope', 'lid', '-y'), ids)).toThrow(new WorkspaceError('UNKNOWN_OBJECT'));
    expect(() => splitForJoin(ws(), side('o', 'body', '+y'), side('o', 'nope', '-y'), ids)).toThrow(new WorkspaceError('UNKNOWN_PART'));
    expect(() => splitForJoin(ws(), side('o', 'body', '+y'), side('o', 'body', '-y'), ids)).toThrow(new WorkspaceError('INVALID_JOINT'));
    expect(() => splitForJoin(ws(), side('o', 'body', '+y'), side('o', 'lid', '-y'), { newObjectId: 'bad id', createdAt: CREATED_AT })).toThrow(WorkspaceError);
  });

  it('refuses at the object limit', () => {
    const objects = [
      objectOf('o', 'Rig', stackParts()),
      ...Array.from({ length: MAX_OBJECTS - 1 }, (_, index) => objectOf(`f${index}`, `Filler ${index}`, [box('f', [0.01, 0.01, 0.01])], at(index + 1, 0, 0))),
    ];
    const full = workspaceOf(objects);
    expect(() => splitForJoin(full, side('o', 'body', '+y'), side('o', 'lid', '-y'), { newObjectId: 'new', createdAt: CREATED_AT }))
      .toThrow(new WorkspaceError('OBJECT_LIMIT'));
  });
});

describe('time of a large workspace (printed, not asserted)', () => {
  /** `root` > `grp` > g1..g31, and r1..r31 beside `grp`: 64 parts in one object, a plate in another. */
  function large(jointTo: 'subtree' | 'rest'): Workspace {
    const parts: Part[] = [
      box('root', [0.05, 0.05, 0.05]),
      box('grp', [0.02, 0.02, 0.02], [0.05, 0, 0], { parentId: 'root' }),
      ...Array.from({ length: 31 }, (_, index) => box(`g${index + 1}`, [0.01, 0.01, 0.01], [0.01 * (index % 8), 0.01 * Math.floor(index / 8), 0.02], { parentId: 'grp', rotation: vec(0, index, 0) })),
      ...Array.from({ length: 31 }, (_, index) => box(`r${index + 1}`, [0.01, 0.01, 0.01], [-0.01 * (index % 8), 0.01 * Math.floor(index / 8), -0.03], { parentId: 'root' })),
    ];
    const plate = objectOf('p', 'Plate', [box('plate', [2, 0.01, 2])], at(0, -1, 0));
    const ids = jointTo === 'subtree' ? ['grp', ...Array.from({ length: 31 }, (_, index) => `g${index + 1}`)] : ['root', ...Array.from({ length: 31 }, (_, index) => `r${index + 1}`)];
    return ids.reduce((current, id, index) => addJoint(current, joint(`j${index + 1}`, side('o', id, '+y'), side('p', 'plate', '-y'))),
      workspaceOf([objectOf('o', 'Large', parts, at(0, 0, 0, 3, 20, 7)), plate], 'o'));
  }

  const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)]!;
  function time(ws: Workspace): number {
    const runs: number[] = [];
    for (let run = 0; run < 15; run += 1) {
      const start = performance.now();
      pullOutPart(ws, pull('o', 'grp'));
      runs.push(performance.now() - start);
    }
    return median(runs);
  }

  it('pulls a 32-part subtree out of 64 parts and 32 joints', () => {
    const inPlace = large('subtree');
    const placed = large('rest');
    expect(inPlace.objects[0]!.model.parts).toHaveLength(64);
    expect(inPlace.joints).toHaveLength(32);
    expect(placed.joints).toHaveLength(32);

    const first = pullOutPart(inPlace, pull('o', 'grp'));
    expect(objectById(first, 'new').model.parts).toHaveLength(32);
    expect(first.joints.every(candidate => candidate.a.objectId === 'new')).toBe(true);
    const second = pullOutPart(placed, pull('o', 'grp'));
    expect(second.joints).toBe(placed.joints);

    const stayMs = time(inPlace);
    const placeMs = time(placed);
    console.log(`pull-out timing, 64 parts, 32 joints (median of 15): ${stayMs.toFixed(2)} ms with 32 joints moved in place, ${placeMs.toFixed(2)} ms placed beside with 32 joints kept`);
  });
});
