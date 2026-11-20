import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { assemblyOf, moveRigid, objectMatrix } from '../../shared/assembly';
import { touching, worldFace } from '../../shared/contact';
import { CONTACT_ANGLE_DEG, CONTACT_GAP_MM } from '../../shared/joint-constants';
import { ObjectIdSchema as IdsObjectIdSchema } from '../../shared/ids';
import {
  CONTACT_FACES, FACE_LABELS, FaceIdSchema, JointSchema, MAX_JOINTS, faceAllows, faceShape,
  type FaceId, type FaceShape, type Joint, type JointMethod,
} from '../../shared/joint';
import { MATERIALS, MaterialIdSchema, type MaterialId } from '../../shared/materials';
import { PartSchema, type Part } from '../../shared/model';
import { DEFAULT_PRINTER_PROFILE, PrinterProfileSchema, printedDepth, printedDiameter, type PrinterProfile } from '../../shared/printer';
import {
  GLUES, INSERTS, MAGNETS, PINS, SCREWS, GlueIdSchema, MagnetIdSchema, PinIdSchema, ThreadSchema,
} from '../../shared/standard-parts';
import {
  JointChangeSchema, ObjectChangeSchema, ObjectIdSchema, SceneObjectSchema, WORKSPACE_VERSION, WorkspaceChangeSchema, WorkspaceError,
  addJoint, addObject, applyWorkspaceChange, assertWorkspace, emptyWorkspace, findObject, joinObjects, jointsRemovedBy, migrateWorkspace,
  removeJoint, removeObject, replaceModel, setMaterial, setTransform, updateJoint, validateWorkspace,
  type ObjectTransform, type Workspace, type WorkspaceChange, type WorkspaceErrorCode,
} from '../../shared/workspace';
import {
  BOX, CREATED_AT, boxModel, boxOnCylinder, demoPair, fixtureJoint, fixtureModel, fixtureObject, fixturePart, rotatedPair, side, twoBoxes,
} from '../fixtures/joint-workspace';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const noChange: WorkspaceChange = { activeObjectId: null, object: null, selection: null, explode: null };
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
const clone = <T>(value: T): T => structuredClone(value);
const transformOf = (ws: Workspace, id: string): ObjectTransform => findObject(ws, id)!.transform;

const GLUE: JointMethod = { kind: 'glue', glue: 'epoxy' };
const SCREW: JointMethod = { kind: 'screw-insert', size: 'M3', count: 2, insertSide: 'a' };
const MAGNET: JointMethod = { kind: 'magnet', magnet: 'd6x3', count: 2 };
const PIN: JointMethod = { kind: 'pin', pin: 'd3', count: 2, fit: 'press-slide' };
const METHODS: JointMethod[] = [SCREW, MAGNET, PIN, GLUE];

/** Workspace with one object per id, each with one box part `body`, in a row along X; no joints. */
function row(...ids: string[]): Workspace {
  return ids.reduce((ws, id, index) => addObject(ws, fixtureObject(id, boxModel(`Block ${id}`), {
    position: vec(index * BOX.x, 0, 0), rotation: vec(0, 0, 0),
  })), emptyWorkspace());
}
const link = (id: string, from: string, to: string, faces: [FaceId, FaceId] = ['+x', '-x']): Joint =>
  fixtureJoint(side(from, 'body', faces[0]), side(to, 'body', faces[1]), { id });

describe('standard parts (every number pinned, sources in shared/standard-parts.ts)', () => {
  it('inserts', () => {
    expect(INSERTS.M2).toEqual({ lengthMm: 3.0, outerMm: 3.6, holeMm: 3.2, vendor: 'CNC Kitchen', label: 'M2×3 熱壓螺母' });
    expect(INSERTS.M3).toEqual({ lengthMm: 5.7, outerMm: 4.6, holeMm: 4.0, vendor: 'CNC Kitchen', label: 'M3×5.7 熱壓螺母' });
  });
  it('screws, clearance holes and tap drills', () => {
    expect(SCREWS.M2).toEqual({ headMm: 3.8, headHeightMm: 2.0, lengthsMm: [4, 5, 6, 8, 10, 12, 16, 20], clearanceMm: 2.4, tapDrillMm: 1.6 });
    expect(SCREWS.M3).toEqual({
      headMm: 5.5, headHeightMm: 3.0, lengthsMm: [5, 6, 8, 10, 12, 16, 20, 25, 30], clearanceMm: 3.4, tapDrillMm: 2.5,
    });
  });
  it('magnets', () => {
    expect(MAGNETS).toEqual({
      d6x2: { diameterMm: 6, thicknessMm: 2 },
      d6x3: { diameterMm: 6, thicknessMm: 3 },
      d8x3: { diameterMm: 8, thicknessMm: 3 },
      d10x2: { diameterMm: 10, thicknessMm: 2 },
      d10x3: { diameterMm: 10, thicknessMm: 3 },
    });
  });
  it('pins', () => {
    expect(PINS).toEqual({
      d2: { diameterMm: 2, lengthsMm: [6, 8, 10, 12, 16, 20] },
      d3: { diameterMm: 3, lengthsMm: [8, 10, 12, 16, 20] },
      d4: { diameterMm: 4, lengthsMm: [10, 12, 16, 20] },
    });
  });
  it('glues', () => {
    expect(GLUES).toEqual({ ca: { label: '瞬間膠' }, epoxy: { label: 'AB 膠' }, solvent: { label: '溶劑黏合' } });
  });
  it('has one table entry per id', () => {
    expect(Object.keys(INSERTS)).toEqual(ThreadSchema.options);
    expect(Object.keys(SCREWS)).toEqual(ThreadSchema.options);
    expect(Object.keys(MAGNETS)).toEqual(MagnetIdSchema.options);
    expect(Object.keys(PINS)).toEqual(PinIdSchema.options);
    expect(Object.keys(GLUES)).toEqual(GlueIdSchema.options);
  });
  it('lists every length in ascending order', () => {
    for (const lengths of [...Object.values(SCREWS), ...Object.values(PINS)].map(entry => entry.lengthsMm)) {
      expect([...lengths].sort((a, b) => a - b)).toEqual([...lengths]);
    }
  });
});

describe('materials', () => {
  it('has the eight ids with their labels, process and flags', () => {
    expect(MaterialIdSchema.options).toEqual(['pla', 'petg', 'abs', 'tpu', 'nylon', 'resin', 'aluminium', 'steel']);
    const summary = Object.fromEntries(Object.entries(MATERIALS).map(([id, m]) => [id, [m.label, m.process, m.flexible, m.inserts, m.solvent]]));
    expect(summary).toEqual({
      pla: ['PLA', 'fdm', false, true, null],
      petg: ['PETG', 'fdm', false, true, null],
      abs: ['ABS', 'fdm', false, true, 'abs'],
      tpu: ['TPU', 'fdm', true, false, null],
      nylon: ['尼龍', 'fdm', false, true, null],
      resin: ['樹脂', 'resin', false, false, null],
      aluminium: ['鋁', 'metal', false, false, null],
      steel: ['鋼', 'metal', false, false, null],
    });
  });
  it('has the glue and snap-fit ratings of the design table', () => {
    const ratings = Object.fromEntries(Object.entries(MATERIALS).map(([id, m]) => [id, [m.glue.ca, m.glue.epoxy, m.glue.solvent, m.snapFit]]));
    expect(ratings).toEqual({
      pla: ['good', 'good', 'poor', 'poor'],
      petg: ['fair', 'good', 'poor', 'fair'],
      abs: ['good', 'good', 'good', 'fair'],
      tpu: ['fair', 'poor', 'poor', 'good'],
      nylon: ['poor', 'fair', 'poor', 'good'],
      resin: ['good', 'good', 'poor', 'poor'],
      aluminium: ['fair', 'good', 'poor', 'poor'],
      steel: ['fair', 'good', 'poor', 'poor'],
    });
  });
  it('rates solvent welding good for ABS only', () => {
    for (const [id, material] of Object.entries(MATERIALS)) expect(material.glue.solvent === 'good').toBe(id === 'abs');
    expect(Object.values(MATERIALS).filter(m => m.solvent === 'abs')).toHaveLength(1);
  });
});

describe('printer profile and printed sizes', () => {
  const profile = DEFAULT_PRINTER_PROFILE;
  it('has the default values and they pass the schema', () => {
    expect(profile).toEqual({ slidingFit: 0.25, pressFit: 0.10, holeCompensation: 0.20, depthAllowance: 0.20, petgExtra: 0.05 });
    expect(PrinterProfileSchema.parse(profile)).toEqual(profile);
  });
  it.each([
    ['slidingFit', 1], ['pressFit', 0.5], ['holeCompensation', 1], ['depthAllowance', 1], ['petgExtra', 0.5],
  ] as const)('limits %s to 0..%s', (key, max) => {
    expect(PrinterProfileSchema.safeParse({ ...profile, [key]: max }).success).toBe(true);
    expect(PrinterProfileSchema.safeParse({ ...profile, [key]: 0 }).success).toBe(true);
    expect(PrinterProfileSchema.safeParse({ ...profile, [key]: max + 0.01 }).success).toBe(false);
    expect(PrinterProfileSchema.safeParse({ ...profile, [key]: -0.01 }).success).toBe(false);
  });
  it('rejects unknown keys and missing keys', () => {
    expect(PrinterProfileSchema.safeParse({ ...profile, extra: 1 }).success).toBe(false);
    const { petgExtra: _petgExtra, ...missing } = profile;
    expect(PrinterProfileSchema.safeParse(missing).success).toBe(false);
  });
  it('adds only the hole compensation to a hole with no fit class', () => {
    expect(printedDiameter(4.0, 'none', profile, null)).toBe(4.2);
    expect(printedDiameter(3.4, 'none', profile, 'pla')).toBe(3.6);
  });
  it('adds a press fit per side', () => {
    expect(printedDiameter(6, 'press', profile, 'pla')).toBe(6.4); // 6 + 0.2 + 2 x 0.1
    expect(printedDiameter(6, 'press', profile, null)).toBe(6.4);
  });
  it('adds a sliding fit per side', () => {
    expect(printedDiameter(3, 'sliding', profile, 'abs')).toBe(3.7); // 3 + 0.2 + 2 x 0.25
  });
  it('adds the PETG extra per side to fits, never to a hole with no fit class', () => {
    expect(printedDiameter(6, 'press', profile, 'petg')).toBe(6.5); // 6 + 0.2 + 2 x (0.1 + 0.05)
    expect(printedDiameter(3, 'sliding', profile, 'petg')).toBe(3.8); // 3 + 0.2 + 2 x (0.25 + 0.05)
    expect(printedDiameter(4.0, 'none', profile, 'petg')).toBe(4.2);
  });
  it('follows a custom profile', () => {
    const custom: PrinterProfile = { slidingFit: 0.3, pressFit: 0.15, holeCompensation: 0.1, depthAllowance: 0.5, petgExtra: 0 };
    expect(printedDiameter(8, 'sliding', custom, 'petg')).toBe(8.7);
    expect(printedDiameter(8, 'press', custom, null)).toBe(8.4);
    expect(printedDepth(5.7, custom)).toBe(6.2);
  });
  it('rounds to 0.01 mm and returns clean numbers', () => {
    const odd: PrinterProfile = { ...profile, holeCompensation: 0.123, pressFit: 0.0333 };
    expect(printedDiameter(6, 'press', odd, null)).toBe(6.19); // 6 + 0.123 + 0.0666 = 6.1896
    expect(printedDiameter(3.2, 'none', profile, null)).toBe(3.4); // not 3.4000000000000004
  });
  it('adds the depth allowance to a depth', () => {
    expect(printedDepth(5.7, profile)).toBe(5.9); // not 5.8999999999999995
    expect(printedDepth(3, profile)).toBe(3.2);
    expect(printedDepth(2, { ...profile, depthAllowance: 0 })).toBe(2);
  });
});

describe('contact faces', () => {
  const FACES = FaceIdSchema.options;
  const EXPECTED: Record<Part['primitive'], Partial<Record<FaceId, FaceShape>>> = {
    box: { '+x': 'rect', '-x': 'rect', '+y': 'rect', '-y': 'rect', '+z': 'rect', '-z': 'rect' },
    cylinder: { '+y': 'disc', '-y': 'disc' },
    cone: { '-y': 'disc' },
    tube: { '+y': 'ring', '-y': 'ring' },
    sphere: {},
    torus: {},
  };
  const primitives = PartSchema.shape.primitive.options;
  it('covers every primitive of the part schema', () => {
    expect(Object.keys(CONTACT_FACES).sort()).toEqual([...primitives].sort());
  });
  it.each(primitives)('gives the faces of %s', primitive => {
    for (const face of FACES) expect(faceShape(primitive, face)).toBe(EXPECTED[primitive][face] ?? null);
  });
  it('has no contact face on a sphere or a torus', () => {
    for (const primitive of ['sphere', 'torus'] as const) for (const face of FACES) expect(faceShape(primitive, face)).toBeNull();
  });
  it.each(['rect', 'disc'] as const)('lets a %s face carry every method', shape => {
    for (const method of METHODS) expect(faceAllows(shape, method)).toBe(true);
  });
  it('lets a ring (tube cap) carry glue only', () => {
    expect(faceAllows('ring', GLUE)).toBe(true);
    expect(faceAllows('ring', { kind: 'glue', glue: 'ca' })).toBe(true);
    for (const method of [SCREW, MAGNET, PIN]) expect(faceAllows('ring', method)).toBe(false);
  });
  it('labels every face in Traditional Chinese', () => {
    expect(FACE_LABELS).toEqual({ '+x': '右面', '-x': '左面', '+y': '頂面', '-y': '底面', '+z': '前面', '-z': '後面' });
    expect(Object.keys(FACE_LABELS)).toEqual([...FACES]);
  });
});

describe('joint schema', () => {
  const joint = fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'));
  it.each(METHODS.map(method => [method.kind, method] as const))('round trips a %s joint through JSON', (_kind, method) => {
    const full: Joint = { ...joint, method, needs: { load: 'medium', disassembly: 'sometimes' }, confirmed: true };
    expect(JointSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });
  it('rejects extra keys, unknown kinds and unknown standard parts', () => {
    expect(JointSchema.safeParse({ ...joint, extra: 1 }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, method: { kind: 'weld' } }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, method: { ...MAGNET, magnet: 'd20x20' } }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, method: { ...PIN, pin: 'd9' } }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, method: { ...SCREW, size: 'M5' } }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, method: { kind: 'glue', glue: 'tape' } }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, method: { ...GLUE, extra: true } }).success).toBe(false);
  });
  it.each([0, 5, 1.5])('rejects a count of %s', count => {
    expect(JointSchema.safeParse({ ...joint, method: { ...MAGNET, count } }).success).toBe(false);
  });
  it.each([1, 4])('accepts a count of %s', count => {
    expect(JointSchema.safeParse({ ...joint, method: { ...MAGNET, count } }).success).toBe(true);
  });
  it('rejects bad faces, ids, needs and timestamps', () => {
    expect(JointSchema.safeParse({ ...joint, a: { ...joint.a, face: '+w' } }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, a: { ...joint.a, partId: '1bad' } }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, id: 'has space' }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, needs: { load: 'huge', disassembly: null } }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, needs: { load: null } }).success).toBe(false);
    expect(JointSchema.safeParse({ ...joint, createdAt: 'yesterday' }).success).toBe(false);
  });
  it('limits a joint list to MAX_JOINTS and keeps it at 32', () => {
    expect(MAX_JOINTS).toBe(32);
  });
  it('keeps one ObjectIdSchema for ids and workspace', () => {
    expect(ObjectIdSchema).toBe(IdsObjectIdSchema);
  });
});

describe('workspace version 2 and migration', () => {
  const v1 = () => {
    const { joints: _joints, ...rest } = clone(twoBoxes());
    return { ...rest, version: 1, objects: rest.objects.map(({ material: _material, ...object }) => object) };
  };
  it('is version 2 and starts without joints', () => {
    expect(WORKSPACE_VERSION).toBe(2);
    expect(emptyWorkspace().version).toBe(2);
    expect(emptyWorkspace().joints).toEqual([]);
  });
  it('migrates version 1 to version 2 with joints [] and material null', () => {
    const migrated = migrateWorkspace(v1()) as Record<string, unknown> & { objects: Array<Record<string, unknown>> };
    expect(migrated.version).toBe(2);
    expect(migrated.joints).toEqual([]);
    for (const object of migrated.objects) expect(object.material).toBeNull();
  });
  it('does not mutate its input and keeps every other field', () => {
    const input = deepFreeze(v1());
    const migrated = migrateWorkspace(input) as typeof input;
    expect(input.version).toBe(1);
    expect(migrated.activeObjectId).toBe(input.activeObjectId);
    expect(migrated.objects[0]!.model).toBe(input.objects[0]!.model);
  });
  it('keeps a material that a version-1 object somehow has', () => {
    const input = v1();
    (input.objects[0] as Record<string, unknown>).material = 'pla';
    expect((migrateWorkspace(input) as { objects: Array<{ material: unknown }> }).objects[0]!.material).toBe('pla');
  });
  it('returns version-2 and unrecognised input unchanged', () => {
    const ws = twoBoxes();
    expect(migrateWorkspace(ws)).toBe(ws);
    for (const value of [null, undefined, 7, 'x', [], { version: 3 }, { version: '1' }, { objects: [] }]) expect(migrateWorkspace(value)).toBe(value);
  });
  it('lets validateWorkspace accept a version-1 workspace and return version 2', () => {
    const checked = validateWorkspace(v1());
    expect(checked.version).toBe(2);
    expect(checked.joints).toEqual([]);
    expect(checked.objects.map(object => object.material)).toEqual([null, null]);
    expect(checked.objects.map(object => object.id)).toEqual(['a', 'b']);
  });
  it('accepts version 2 and rejects version 3, version 0 and a missing version', () => {
    expect(validateWorkspace(twoBoxes({ joint: true })).joints).toHaveLength(1);
    for (const version of [3, 0, '2', undefined]) expect(codeOf(() => validateWorkspace({ ...twoBoxes(), version }))).toBe('INVALID_WORKSPACE');
  });
  it('rejects a version-2 workspace without joints and a version-1 one with a bad object', () => {
    const { joints: _joints, ...noJoints } = twoBoxes();
    expect(codeOf(() => validateWorkspace(noJoints))).toBe('INVALID_WORKSPACE');
    expect(codeOf(() => validateWorkspace({ ...v1(), objects: [7] }))).toBe('INVALID_WORKSPACE');
  });
  it('rejects more than MAX_JOINTS joints at the trust boundary', () => {
    const ws = twoBoxes();
    const many = Array.from({ length: MAX_JOINTS + 1 }, (_, index) => link(`j${index}`, 'a', 'b'));
    expect(codeOf(() => validateWorkspace({ ...ws, joints: many }))).toBe('INVALID_WORKSPACE');
  });
  it('survives JSON with joints and materials (requirement 8)', () => {
    let ws = twoBoxes({ joint: true });
    ws = setMaterial(ws, 'a', 'petg');
    expect(validateWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
  });
  it('reads an object without a material as null', () => {
    const { material: _material, ...old } = fixtureObject('a', boxModel(), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
    expect(SceneObjectSchema.parse(old).material).toBeNull();
    const change = ObjectChangeSchema.parse({ op: 'add', object: old });
    expect(change.op === 'add' && change.object.material).toBeNull();
  });
  it('accepts every material id and null, and rejects others', () => {
    const base = fixtureObject('a', boxModel(), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
    for (const material of [...MaterialIdSchema.options, null]) expect(SceneObjectSchema.parse({ ...base, material }).material).toBe(material);
    expect(SceneObjectSchema.safeParse({ ...base, material: 'wood' }).success).toBe(false);
  });
  it('lets createObject-made objects start without a material', () => {
    expect(findObject(demoPair(), 'demo-b')!.material).toBeNull();
  });
});

describe('assertWorkspace joint rules', () => {
  const ok = twoBoxes({ joint: true });
  const joint = ok.joints[0]!;
  const withJoints = (...joints: Joint[]): Workspace => ({ ...ok, joints });
  const withObjects = (...parts: Part[]): Workspace => {
    let ws = addObject(emptyWorkspace(), fixtureObject('a', boxModel('Block A'), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }));
    ws = addObject(ws, fixtureObject('b', fixtureModel('Other', parts), { position: vec(1, 0, 0), rotation: vec(0, 0, 0) }));
    return ws;
  };

  it('accepts a valid joint, also when the faces do not touch (requirement 88)', () => {
    expect(() => assertWorkspace(ok)).not.toThrow();
    expect(() => assertWorkspace(demoPair({ joint: true }))).not.toThrow();
  });
  it('accepts exactly MAX_JOINTS joints and rejects one more with JOINT_LIMIT', () => {
    const faces: FaceId[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
    const joints: Joint[] = [];
    for (const fa of faces) for (const fb of faces) joints.push(link(`j${joints.length}`, 'a', 'b', [fa, fb]));
    expect(joints.length).toBeGreaterThan(MAX_JOINTS);
    expect(() => assertWorkspace(withJoints(...joints.slice(0, MAX_JOINTS)))).not.toThrow();
    expect(codeOf(() => assertWorkspace(withJoints(...joints.slice(0, MAX_JOINTS + 1))))).toBe('JOINT_LIMIT');
  });
  it('rejects duplicate joint ids', () => {
    expect(codeOf(() => assertWorkspace(withJoints(joint, link(joint.id, 'a', 'b', ['+y', '-y']))))).toBe('INVALID_JOINT');
  });
  it('rejects an unknown object', () => {
    expect(codeOf(() => assertWorkspace(withJoints({ ...joint, b: side('ghost', 'body', '-x') })))).toBe('INVALID_JOINT');
    expect(codeOf(() => assertWorkspace(withJoints({ ...joint, a: side('ghost', 'body', '+x') })))).toBe('INVALID_JOINT');
  });
  it('rejects an unknown part', () => {
    expect(codeOf(() => assertWorkspace(withJoints({ ...joint, a: side('a', 'ghost', '+x') })))).toBe('INVALID_JOINT');
    expect(codeOf(() => assertWorkspace(withJoints({ ...joint, b: side('b', 'ghost', '-x') })))).toBe('INVALID_JOINT');
  });
  it('rejects a face that is not a contact face (sphere, torus, cylinder side, cone top)', () => {
    const ws = withObjects(
      fixturePart('ball', 'sphere', vec(0.02, 0.02, 0.02)), fixturePart('ring', 'torus', vec(0.02, 0.02, 0.02)),
      fixturePart('can', 'cylinder', vec(0.02, 0.02, 0.02)), fixturePart('hat', 'cone', vec(0.02, 0.02, 0.02)),
    );
    const bad = (partId: string, face: FaceId) => ({ ...ws, joints: [fixtureJoint(side('a', 'body', '+x'), side('b', partId, face))] });
    expect(codeOf(() => assertWorkspace(bad('ball', '+y')))).toBe('INVALID_JOINT');
    expect(codeOf(() => assertWorkspace(bad('ring', '+y')))).toBe('INVALID_JOINT');
    expect(codeOf(() => assertWorkspace(bad('can', '+x')))).toBe('INVALID_JOINT');
    expect(codeOf(() => assertWorkspace(bad('hat', '+y')))).toBe('INVALID_JOINT');
    expect(() => assertWorkspace(bad('can', '+y'))).not.toThrow();
    expect(() => assertWorkspace(bad('hat', '-y'))).not.toThrow();
  });
  it('allows glue only on a tube cap', () => {
    const ws = withObjects(fixturePart('pipe', 'tube', vec(0.03, 0.03, 0.03)));
    const on = (method: JointMethod) => ({ ...ws, joints: [fixtureJoint(side('a', 'body', '+x'), side('b', 'pipe', '+y'), { method })] });
    expect(() => assertWorkspace(on(GLUE))).not.toThrow();
    for (const method of [SCREW, MAGNET, PIN]) expect(codeOf(() => assertWorkspace(on(method)))).toBe('INVALID_JOINT');
    const asSideA = { ...ws, joints: [fixtureJoint(side('b', 'pipe', '-y'), side('a', 'body', '+x'), { method: SCREW })] };
    expect(codeOf(() => assertWorkspace(asSideA))).toBe('INVALID_JOINT');
  });
  it('rejects the same part on both sides, even with different faces', () => {
    expect(codeOf(() => assertWorkspace(withJoints({ ...joint, b: side('a', 'body', '-x') })))).toBe('INVALID_JOINT');
    expect(codeOf(() => assertWorkspace(withJoints({ ...joint, b: side('a', 'body', '+y') })))).toBe('INVALID_JOINT');
  });
  it('allows two parts of one object', () => {
    const model = fixtureModel('Two', [fixturePart('base', 'box', BOX), fixturePart('lid', 'box', BOX, vec(0, BOX.y, 0))]);
    const ws = addObject(emptyWorkspace(), fixtureObject('o', model, { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }));
    expect(() => assertWorkspace({ ...ws, joints: [fixtureJoint(side('o', 'base', '+y'), side('o', 'lid', '-y'))] })).not.toThrow();
  });
  it('rejects two joints between the same two sides, in either order', () => {
    expect(codeOf(() => assertWorkspace(withJoints(joint, { ...joint, id: 'second' })))).toBe('INVALID_JOINT');
    expect(codeOf(() => assertWorkspace(withJoints(joint, { ...joint, id: 'second', a: joint.b, b: joint.a })))).toBe('INVALID_JOINT');
  });
  it('allows several joints that differ in a face or a part', () => {
    const more = [joint, link('j2', 'a', 'b', ['+y', '-y']), link('j3', 'a', 'b', ['+x', '+y'])];
    expect(() => assertWorkspace(withJoints(...more))).not.toThrow();
  });
});

describe('material and joint operations', () => {
  describe('setMaterial', () => {
    it('sets the material, keeps edited and the other objects', () => {
      const ws = twoBoxes();
      const next = setMaterial(ws, 'a', 'petg');
      expect(findObject(next, 'a')!.material).toBe('petg');
      expect(findObject(next, 'a')!.edited).toBe(false);
      expect(next.objects[1]).toBe(ws.objects[1]);
      expect(findObject(ws, 'a')!.material).toBeNull();
    });
    it('clears the material with null and returns the same workspace when nothing changes', () => {
      const ws = setMaterial(twoBoxes(), 'a', 'abs');
      expect(setMaterial(ws, 'a', 'abs')).toBe(ws);
      expect(findObject(setMaterial(ws, 'a', null), 'a')!.material).toBeNull();
      const none = twoBoxes();
      expect(setMaterial(none, 'a', null)).toBe(none);
    });
    it('rejects an unknown object and an unknown material', () => {
      expect(codeOf(() => setMaterial(twoBoxes(), 'ghost', 'pla'))).toBe('UNKNOWN_OBJECT');
      expect(codeOf(() => setMaterial(twoBoxes(), 'a', 'wood' as MaterialId))).toBe('INVALID_WORKSPACE');
    });
    it('does not mutate a frozen workspace', () => {
      const ws = deepFreeze(twoBoxes());
      expect(findObject(setMaterial(ws, 'b', 'tpu'), 'b')!.material).toBe('tpu');
    });
  });

  describe('addJoint', () => {
    const joint = link('j1', 'a', 'b');
    it('adds a joint and keeps objects by reference', () => {
      const ws = twoBoxes();
      const next = addJoint(ws, joint);
      expect(next.joints).toEqual([joint]);
      expect(next.objects).toBe(ws.objects);
      expect(ws.joints).toEqual([]);
      expect(next.activeObjectId).toBe(ws.activeObjectId);
    });
    it('does not mutate a frozen workspace', () => {
      const ws = deepFreeze(twoBoxes());
      expect(addJoint(ws, deepFreeze({ ...joint })).joints).toHaveLength(1);
    });
    it('does not move anything and does not check touching', () => {
      const far = setTransform(twoBoxes(), 'b', { position: vec(5, 0, 0) });
      const next = addJoint(far, joint);
      expect(next.objects).toBe(far.objects);
    });
    it('rejects JOINT_LIMIT at 32', () => {
      const faces: FaceId[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
      let ws = twoBoxes();
      for (const fa of faces) for (const fb of faces) if (ws.joints.length < MAX_JOINTS) ws = addJoint(ws, link(`j${ws.joints.length}`, 'a', 'b', [fa, fb]));
      expect(ws.joints).toHaveLength(MAX_JOINTS);
      expect(codeOf(() => addJoint(ws, link('one-more', 'b', 'a', ['+z', '-z'])))).toBe('JOINT_LIMIT');
      expect(ws.joints).toHaveLength(MAX_JOINTS);
    });
    it('rejects an unknown object with UNKNOWN_OBJECT', () => {
      expect(codeOf(() => addJoint(twoBoxes(), link('j1', 'a', 'ghost')))).toBe('UNKNOWN_OBJECT');
      expect(codeOf(() => addJoint(twoBoxes(), link('j1', 'ghost', 'b')))).toBe('UNKNOWN_OBJECT');
    });
    it('rejects invalid data with INVALID_JOINT', () => {
      const ws = twoBoxes();
      expect(codeOf(() => addJoint(ws, { ...joint, method: { kind: 'weld' } as unknown as JointMethod }))).toBe('INVALID_JOINT');
      expect(codeOf(() => addJoint(ws, { ...joint, id: 'bad id' }))).toBe('INVALID_JOINT');
      expect(codeOf(() => addJoint(ws, { ...joint, createdAt: 'x' }))).toBe('INVALID_JOINT');
      expect(codeOf(() => addJoint(ws, link('j1', 'a', 'b', ['+x', '+w' as FaceId])))).toBe('INVALID_JOINT');
      expect(codeOf(() => addJoint(ws, { ...joint, b: side('a', 'body', '-x') }))).toBe('INVALID_JOINT');
      expect(codeOf(() => addJoint(ws, { ...joint, a: side('a', 'ghost', '+x') }))).toBe('INVALID_JOINT');
    });
    it('rejects a duplicate id and a duplicate side pair', () => {
      const ws = twoBoxes({ joint: true });
      expect(codeOf(() => addJoint(ws, link('joint-1', 'a', 'b', ['+y', '-y'])))).toBe('INVALID_JOINT');
      expect(codeOf(() => addJoint(ws, link('other', 'b', 'a', ['-x', '+x'])))).toBe('INVALID_JOINT');
    });
    it('rejects a screw on a tube cap', () => {
      const pipe = fixtureModel('Pipe', [fixturePart('pipe', 'tube', vec(0.03, 0.03, 0.03))]);
      const ws = addObject(twoBoxes(), fixtureObject('t', pipe, { position: vec(0, 1, 0), rotation: vec(0, 0, 0) }));
      const onPipe = (method: JointMethod) => fixtureJoint(side('a', 'body', '+y'), side('t', 'pipe', '-y'), { method });
      expect(codeOf(() => addJoint(ws, onPipe(SCREW)))).toBe('INVALID_JOINT');
      expect(addJoint(ws, onPipe(GLUE)).joints).toHaveLength(1);
    });
  });

  describe('updateJoint', () => {
    const base = twoBoxes({ joint: true });
    it('changes the method, the needs and confirmed, and keeps the sides, id and createdAt', () => {
      const next = updateJoint(base, 'joint-1', { method: SCREW, needs: { load: 'heavy' }, confirmed: true });
      expect(next.joints[0]).toEqual({ ...base.joints[0], method: SCREW, needs: { load: 'heavy', disassembly: null }, confirmed: true });
      expect(next.joints[0]!.a).toEqual(base.joints[0]!.a);
      expect(next.objects).toBe(base.objects);
      expect(base.joints[0]!.method).toEqual({ kind: 'glue', glue: 'ca' });
    });
    it('merges needs and leaves the other need alone', () => {
      const once = updateJoint(base, 'joint-1', { needs: { load: 'light' } });
      const twice = updateJoint(once, 'joint-1', { needs: { disassembly: 'often' } });
      expect(twice.joints[0]!.needs).toEqual({ load: 'light', disassembly: 'often' });
      expect(updateJoint(twice, 'joint-1', { needs: { load: null } }).joints[0]!.needs).toEqual({ load: null, disassembly: 'often' });
      expect(updateJoint(twice, 'joint-1', { needs: { load: undefined } })).toBe(twice);
    });
    it('returns the same workspace when nothing changes', () => {
      expect(updateJoint(base, 'joint-1', {})).toBe(base);
      expect(updateJoint(base, 'joint-1', { confirmed: false })).toBe(base);
      expect(updateJoint(base, 'joint-1', { method: { kind: 'glue', glue: 'ca' } })).toBe(base);
      expect(updateJoint(base, 'joint-1', { needs: { load: null, disassembly: null } })).toBe(base);
    });
    it('rejects an unknown joint', () => {
      expect(codeOf(() => updateJoint(base, 'ghost', { confirmed: true }))).toBe('UNKNOWN_JOINT');
    });
    it('rejects an invalid method with INVALID_JOINT', () => {
      expect(codeOf(() => updateJoint(base, 'joint-1', { method: { kind: 'magnet', magnet: 'nope', count: 1 } as unknown as JointMethod }))).toBe('INVALID_JOINT');
      expect(codeOf(() => updateJoint(base, 'joint-1', { needs: { load: 'huge' as 'light' } }))).toBe('INVALID_JOINT');
    });
    it('rejects a method that the faces do not allow', () => {
      const pipe = fixtureModel('Pipe', [fixturePart('pipe', 'tube', vec(0.03, 0.03, 0.03))]);
      let ws = addObject(twoBoxes(), fixtureObject('t', pipe, { position: vec(0, 1, 0), rotation: vec(0, 0, 0) }));
      ws = addJoint(ws, fixtureJoint(side('a', 'body', '+y'), side('t', 'pipe', '-y')));
      expect(codeOf(() => updateJoint(ws, 'joint-1', { method: MAGNET }))).toBe('INVALID_JOINT');
      expect(updateJoint(ws, 'joint-1', { method: { kind: 'glue', glue: 'solvent' } }).joints[0]!.method).toEqual({ kind: 'glue', glue: 'solvent' });
    });
    it('does not mutate a frozen workspace', () => {
      const frozen = deepFreeze(twoBoxes({ joint: true }));
      expect(updateJoint(frozen, 'joint-1', { method: PIN }).joints[0]!.method).toEqual(PIN);
    });
  });

  describe('removeJoint', () => {
    it('removes the joint and leaves the objects where they are', () => {
      const ws = twoBoxes({ joint: true });
      const next = removeJoint(ws, 'joint-1');
      expect(next.joints).toEqual([]);
      expect(next.objects).toBe(ws.objects);
      expect(ws.joints).toHaveLength(1);
    });
    it('rejects an unknown joint', () => {
      expect(codeOf(() => removeJoint(twoBoxes(), 'ghost'))).toBe('UNKNOWN_JOINT');
    });
    it('keeps the other joints', () => {
      const ws = addJoint(twoBoxes({ joint: true }), link('j2', 'a', 'b', ['+y', '-y']));
      expect(removeJoint(ws, 'joint-1').joints.map(joint => joint.id)).toEqual(['j2']);
    });
  });

  describe('jointsRemovedBy', () => {
    it('counts the joints that disappeared', () => {
      const ws = addJoint(twoBoxes({ joint: true }), link('j2', 'a', 'b', ['+y', '-y']));
      expect(jointsRemovedBy(ws, ws)).toBe(0);
      expect(jointsRemovedBy(ws, removeJoint(ws, 'j2'))).toBe(1);
      expect(jointsRemovedBy(ws, removeObject(ws, 'b'))).toBe(2);
      expect(jointsRemovedBy(removeObject(ws, 'b'), ws)).toBe(0);
    });
  });
});

describe('cascades', () => {
  it('removeObject removes every joint that names the object, from either side', () => {
    let ws = row('a', 'b', 'c');
    ws = addJoint(ws, link('ab', 'a', 'b'));
    ws = addJoint(ws, link('bc', 'b', 'c'));
    const withoutB = removeObject(ws, 'b');
    expect(withoutB.joints).toEqual([]);
    expect(withoutB.objects.map(object => object.id)).toEqual(['a', 'c']);
    const withoutA = removeObject(ws, 'a');
    expect(withoutA.joints.map(joint => joint.id)).toEqual(['bc']);
    const withoutC = removeObject(ws, 'c');
    expect(withoutC.joints.map(joint => joint.id)).toEqual(['ab']);
    expect(ws.joints).toHaveLength(2);
  });
  it('removeObject keeps the joints array when no joint names the object', () => {
    const ws = addJoint(row('a', 'b', 'c'), link('ab', 'a', 'b'));
    expect(removeObject(ws, 'c').joints).toBe(ws.joints);
    expect(removeObject(ws, 'c').activeObjectId).toBe('b');
  });
  it('removeObject also cascades for the active object', () => {
    const ws = twoBoxes({ joint: true });
    expect(ws.activeObjectId).toBe('b');
    const next = removeObject(ws, 'b');
    expect(next.joints).toEqual([]);
    expect(next.activeObjectId).toBe('a');
  });
  it('removeObject removes the joint inside one object', () => {
    const model = fixtureModel('Two', [fixturePart('base', 'box', BOX), fixturePart('lid', 'box', BOX, vec(0, BOX.y, 0))]);
    let ws = addObject(emptyWorkspace(), fixtureObject('o', model, { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }));
    ws = addJoint(ws, fixtureJoint(side('o', 'base', '+y'), side('o', 'lid', '-y')));
    expect(removeObject(ws, 'o').joints).toEqual([]);
  });

  const twoPartModel = (lidPrimitive: Part['primitive'] = 'box', lidSize: { x: number; y: number; z: number } = BOX) =>
    fixtureModel('Two', [fixturePart('base', 'box', BOX), fixturePart('lid', lidPrimitive, lidSize, vec(0, BOX.y, 0))]);
  const insideOne = (): Workspace => {
    const ws = addObject(emptyWorkspace(), fixtureObject('o', twoPartModel(), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }));
    return addJoint(ws, fixtureJoint(side('o', 'base', '+y'), side('o', 'lid', '-y')));
  };
  it('replaceModel removes a joint whose part is gone', () => {
    const ws = insideOne();
    const next = replaceModel(ws, 'o', fixtureModel('One', [fixturePart('base', 'box', BOX)]));
    expect(next.joints).toEqual([]);
    expect(jointsRemovedBy(ws, next)).toBe(1);
  });
  it('replaceModel removes a joint whose face is no longer a contact face (box to sphere)', () => {
    const ws = insideOne();
    const next = replaceModel(ws, 'o', twoPartModel('sphere', { x: 0.02, y: 0.02, z: 0.02 }));
    expect(next.joints).toEqual([]);
    expect(findObject(next, 'o')!.edited).toBe(true);
  });
  it('replaceModel removes a joint when the face of another object changes shape, and keeps the rest', () => {
    let ws = addJoint(twoBoxes(), fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'), { id: 'ab' }));
    ws = addJoint(ws, link('ab2', 'a', 'b', ['+y', '-y']));
    const cone = fixtureModel('Cone', [fixturePart('body', 'cone', { x: 0.04, y: 0.02, z: 0.04 })]);
    const next = replaceModel(ws, 'a', cone);
    expect(next.joints).toEqual([]);
    const cylinderModel = fixtureModel('Cylinder', [fixturePart('body', 'cylinder', { x: 0.04, y: 0.02, z: 0.04 })]);
    const afterCylinder = replaceModel(ws, 'a', cylinderModel);
    expect(afterCylinder.joints.map(joint => joint.id)).toEqual(['ab2']);
    expect(afterCylinder.joints[0]!.a.face).toBe('+y');
  });
  it('replaceModel removes a non-glue joint when the face becomes a tube cap, keeps a glue joint', () => {
    const pipe = fixtureModel('Pipe', [fixturePart('body', 'tube', { x: 0.04, y: 0.02, z: 0.04 })]);
    let ws = addJoint(twoBoxes(), link('screwed', 'a', 'b', ['+y', '-y']));
    ws = updateJoint(ws, 'screwed', { method: SCREW });
    ws = addJoint(ws, link('glued', 'a', 'b', ['-y', '+y']));
    const next = replaceModel(ws, 'a', pipe);
    expect(next.joints.map(joint => joint.id)).toEqual(['glued']);
    expect(jointsRemovedBy(ws, next)).toBe(1);
  });
  it('replaceModel keeps the joint when a dimension, position or rotation changes', () => {
    const ws = twoBoxes({ joint: true });
    const resized = fixtureModel('Resized', [fixturePart('body', 'box', { x: 0.08, y: 0.05, z: 0.02 }, vec(0.01, 0, 0))]);
    const next = replaceModel(ws, 'a', resized);
    expect(next.joints).toBe(ws.joints);
    expect(findObject(next, 'a')!.model.parts[0]!.dimensions.x).toBe(0.08);
    const rotated = fixtureModel('Rotated', [{ ...fixturePart('body', 'box', BOX), rotation: vec(0, 45, 0) }]);
    expect(replaceModel(ws, 'a', rotated).joints).toBe(ws.joints);
  });
  it('replaceModel keeps a joint of another object when this object changes', () => {
    const ws = addJoint(row('a', 'b', 'c'), link('bc', 'b', 'c'));
    const next = replaceModel(ws, 'a', fixtureModel('Other', [fixturePart('x', 'box', BOX)]));
    expect(next.joints).toBe(ws.joints);
  });
});

describe('assemblyOf', () => {
  it('returns only the object when it has no joints', () => {
    const ws = row('a', 'b', 'c');
    expect(assemblyOf(ws, 'b')).toEqual(['b']);
  });
  it('follows a chain in both directions and returns ids in workspace order', () => {
    let ws = row('a', 'b', 'c', 'd');
    ws = addJoint(ws, link('ab', 'a', 'b'));
    ws = addJoint(ws, link('cb', 'c', 'b', ['-x', '+x']));
    expect(assemblyOf(ws, 'a')).toEqual(['a', 'b', 'c']);
    expect(assemblyOf(ws, 'c')).toEqual(['a', 'b', 'c']);
    expect(assemblyOf(ws, 'b')).toEqual(['a', 'b', 'c']);
    expect(assemblyOf(ws, 'd')).toEqual(['d']);
  });
  it('terminates on a cycle', () => {
    let ws = row('a', 'b', 'c');
    ws = addJoint(ws, link('ab', 'a', 'b'));
    ws = addJoint(ws, link('bc', 'b', 'c'));
    ws = addJoint(ws, link('ca', 'c', 'a', ['+y', '-y']));
    expect(assemblyOf(ws, 'a')).toEqual(['a', 'b', 'c']);
    expect(assemblyOf(ws, 'c')).toEqual(['a', 'b', 'c']);
  });
  it('lets a joint between two parts of one object link nothing', () => {
    const model = fixtureModel('Two', [fixturePart('base', 'box', BOX), fixturePart('lid', 'box', BOX, vec(0, BOX.y, 0))]);
    let ws = addObject(row('a'), fixtureObject('o', model, { position: vec(1, 0, 0), rotation: vec(0, 0, 0) }));
    ws = addJoint(ws, fixtureJoint(side('o', 'base', '+y'), side('o', 'lid', '-y')));
    expect(assemblyOf(ws, 'o')).toEqual(['o']);
    expect(assemblyOf(ws, 'a')).toEqual(['a']);
  });
  it('leaves one joint out with skipJointId', () => {
    let ws = row('a', 'b', 'c');
    ws = addJoint(ws, link('ab', 'a', 'b'));
    ws = addJoint(ws, link('bc', 'b', 'c'));
    expect(assemblyOf(ws, 'a', 'bc')).toEqual(['a', 'b']);
    expect(assemblyOf(ws, 'c', 'bc')).toEqual(['c']);
    expect(assemblyOf(ws, 'a', 'ghost')).toEqual(['a', 'b', 'c']);
  });
  it('keeps an object connected through a second joint when one joint is skipped', () => {
    let ws = row('a', 'b');
    ws = addJoint(ws, link('one', 'a', 'b'));
    ws = addJoint(ws, link('two', 'a', 'b', ['+y', '-y']));
    expect(assemblyOf(ws, 'a', 'one')).toEqual(['a', 'b']);
  });
  it('always contains the object, also when it is not in the workspace', () => {
    expect(assemblyOf(row('a'), 'ghost')).toEqual(['ghost']);
    expect(assemblyOf(emptyWorkspace(), 'ghost')).toEqual(['ghost']);
  });
  it('ignores a joint that names an object that is not in the workspace', () => {
    const ws = { ...row('a', 'b'), joints: [link('x', 'a', 'ghost')] };
    expect(assemblyOf(ws, 'a')).toEqual(['a']);
  });
});

describe('setTransform on an assembly', () => {
  it('moves a lone object as before and keeps the other objects by reference', () => {
    const ws = row('a', 'b', 'c');
    const next = setTransform(ws, 'b', { position: vec(1, 2, 3) });
    expect(transformOf(next, 'b').position).toEqual(vec(1, 2, 3));
    expect(next.objects[0]).toBe(ws.objects[0]);
    expect(next.objects[2]).toBe(ws.objects[2]);
    expect(transformOf(next, 'b').rotation).toBe(transformOf(ws, 'b').rotation);
  });
  it('returns the same workspace for an unchanged transform, also with joints', () => {
    const ws = twoBoxes({ joint: true });
    expect(setTransform(ws, 'a', {})).toBe(ws);
    expect(setTransform(ws, 'a', { position: { ...transformOf(ws, 'a').position } })).toBe(ws);
  });
  it('moves every member by the same offset and keeps their rotation objects by reference', () => {
    let ws = rotatedPair({ joint: true });
    ws = addObject(ws, fixtureObject('c', boxModel('Free'), { position: vec(5, 5, 5), rotation: vec(10, 20, 30) }));
    const before = ws;
    const next = setTransform(ws, 'a', { position: vec(1, 2, 3) });
    const offset = { x: 1 - 0.1, y: 2 - 0.05, z: 3 - 0.2 };
    for (const id of ['a', 'b']) {
      const was = transformOf(before, id).position;
      const now = transformOf(next, id).position;
      expect(now.x).toBeCloseTo(was.x + offset.x, 9);
      expect(now.y).toBeCloseTo(was.y + offset.y, 9);
      expect(now.z).toBeCloseTo(was.z + offset.z, 9);
      expect(transformOf(next, id).rotation).toBe(transformOf(before, id).rotation);
    }
    expect(next.objects[2]).toBe(before.objects[2]);
    expect(next.joints).toBe(before.joints);
  });
  it('moves the assembly when the other member is moved', () => {
    const ws = twoBoxes({ joint: true });
    const next = setTransform(ws, 'b', { position: vec(2, 0, 0) });
    expect(transformOf(next, 'a').position).toEqual(vec(2 - BOX.x, 0, 0));
    expect(transformOf(next, 'b').position).toEqual(vec(2, 0, 0));
  });
  it('moves a chain of three and leaves an unconnected object alone', () => {
    let ws = row('a', 'b', 'c', 'd');
    ws = addJoint(ws, link('ab', 'a', 'b'));
    ws = addJoint(ws, link('bc', 'b', 'c'));
    const next = setTransform(ws, 'c', { position: vec(BOX.x * 2, 1, 0) });
    expect(next.objects.map(object => object.transform.position.y)).toEqual([1, 1, 1, 0]);
    expect(next.objects.map(object => object.transform.position.x)).toEqual([0, BOX.x, BOX.x * 2, BOX.x * 3]);
    expect(next.objects[3]).toBe(ws.objects[3]);
  });
  it('rotates every member about the moved object', () => {
    const ws = twoBoxes({ joint: true });
    const next = setTransform(ws, 'a', { rotation: vec(0, 90, 0) });
    expect(transformOf(next, 'a').rotation).toEqual(vec(0, 90, 0));
    const b = transformOf(next, 'b');
    expect(b.position.x).toBeCloseTo(0, 5);
    expect(b.position.y).toBeCloseTo(0, 5);
    expect(b.position.z).toBeCloseTo(-BOX.x, 5);
    expect(b.rotation.x).toBeCloseTo(0, 2);
    expect(b.rotation.y).toBeCloseTo(90, 2);
    expect(b.rotation.z).toBeCloseTo(0, 2);
  });
  it('rotates about the moved object when it is not at the origin', () => {
    let ws = rotatedPair({ joint: true });
    const a0 = transformOf(ws, 'a');
    ws = setTransform(ws, 'a', { rotation: vec(0, 120, 0) });
    expect(transformOf(ws, 'a').position).toEqual(a0.position);
    const matrixA = objectMatrix(transformOf(ws, 'a'));
    const matrixB = objectMatrix(transformOf(ws, 'b'));
    const relative = matrixA.clone().invert().multiply(matrixB);
    expect(relative.elements[12]).toBeCloseTo(BOX.x, 4);
    expect(relative.elements[13]).toBeCloseTo(0, 4);
    expect(relative.elements[14]).toBeCloseTo(0, 4);
  });
  it('rotates and moves in one patch', () => {
    const ws = twoBoxes({ joint: true });
    const next = setTransform(ws, 'a', { position: vec(1, 0, 0), rotation: vec(0, 90, 0) });
    const b = transformOf(next, 'b');
    expect(b.position.x).toBeCloseTo(1, 5);
    expect(b.position.z).toBeCloseTo(-BOX.x, 5);
    expect(b.rotation.y).toBeCloseTo(90, 2);
  });
  it('moves a chain when its middle object rotates', () => {
    let ws = row('a', 'b', 'c');
    ws = addJoint(ws, link('ab', 'a', 'b'));
    ws = addJoint(ws, link('bc', 'b', 'c'));
    const next = setTransform(ws, 'b', { rotation: vec(0, 0, 90) });
    expect(transformOf(next, 'a').position.x).toBeCloseTo(BOX.x, 5);
    expect(transformOf(next, 'a').position.y).toBeCloseTo(-BOX.x, 5);
    expect(transformOf(next, 'c').position.y).toBeCloseTo(BOX.x, 5);
    expect(transformOf(next, 'c').rotation.z).toBeCloseTo(90, 2);
  });
  it('rounds moved members to 5 decimals and 2 decimals', () => {
    const ws = twoBoxes({ joint: true });
    const next = setTransform(ws, 'a', { rotation: vec(0, 33.33, 11.11) });
    const b = transformOf(next, 'b');
    for (const value of [b.position.x, b.position.y, b.position.z]) expect(Math.abs(value * 1e5 - Math.round(value * 1e5))).toBeLessThan(1e-6);
    for (const value of [b.rotation.x, b.rotation.y, b.rotation.z]) expect(Math.abs(value * 1e2 - Math.round(value * 1e2))).toBeLessThan(1e-9);
  });
  it('rejects a move that would take a member out of the limits, and nothing moves', () => {
    const ws = twoBoxes({ joint: true });
    const copy = clone(ws);
    expect(codeOf(() => setTransform(ws, 'a', { position: vec(100, 0, 0) }))).toBe('INVALID_WORKSPACE'); // b would reach 100.04
    expect(ws).toEqual(copy);
    expect(codeOf(() => setTransform(ws, 'b', { position: vec(-99.99, 0, 0) }))).toBe('INVALID_WORKSPACE'); // a would reach -100.03
    expect(codeOf(() => setTransform(ws, 'a', { position: vec(99.9, 0, 0) }))).toBe('no error');
  });
  it('rejects a rotation that would put a member beyond the position limit', () => {
    let ws = twoBoxes({ joint: true });
    ws = setTransform(ws, 'a', { position: vec(0, 0, 99.99), rotation: vec(0, 0, 0) });
    expect(codeOf(() => setTransform(ws, 'a', { rotation: vec(0, -90, 0) }))).toBe('INVALID_WORKSPACE'); // b would move to z = 100.03
    expect(codeOf(() => setTransform(ws, 'a', { rotation: vec(0, 90, 0) }))).toBe('no error');
  });
  it('still rejects an object transform outside the limits for a lone object', () => {
    expect(codeOf(() => setTransform(row('a'), 'a', { position: vec(101, 0, 0) }))).toBe('INVALID_WORKSPACE');
    expect(codeOf(() => setTransform(row('a'), 'a', { rotation: vec(0, 361, 0) }))).toBe('INVALID_WORKSPACE');
    expect(codeOf(() => setTransform(row('a'), 'ghost', { rotation: vec(0, 1, 0) }))).toBe('UNKNOWN_OBJECT');
  });
  it('leaves the assembly when its joint is removed', () => {
    const ws = removeJoint(twoBoxes({ joint: true }), 'joint-1');
    const next = setTransform(ws, 'a', { position: vec(3, 0, 0) });
    expect(next.objects[1]).toBe(ws.objects[1]);
  });
  it('moves an assembly in a frozen workspace without mutating it', () => {
    const ws = deepFreeze(twoBoxes({ joint: true }));
    const next = setTransform(ws, 'a', { position: vec(1, 1, 1), rotation: vec(0, 10, 0) });
    expect(transformOf(next, 'b')).not.toEqual(transformOf(ws, 'b'));
  });
  it('lets a joint inside one assembly of a cycle move once', () => {
    let ws = row('a', 'b', 'c');
    ws = addJoint(ws, link('ab', 'a', 'b'));
    ws = addJoint(ws, link('bc', 'b', 'c'));
    ws = addJoint(ws, link('ca', 'c', 'a', ['+y', '-y']));
    const next = setTransform(ws, 'a', { position: vec(0, 0, 7) });
    expect(next.objects.map(object => object.transform.position.z)).toEqual([7, 7, 7]);
  });

  describe('moveRigid', () => {
    it('returns only the anchor for a single member', () => {
      const ws = row('a', 'b');
      const anchor = { position: vec(1, 1, 1), rotation: vec(0, 0, 0) };
      const result = moveRigid(ws, ['a'], 'a', anchor)!;
      expect([...result.keys()]).toEqual(['a']);
      expect(result.get('a')).toBe(anchor);
    });
    it('returns null for an unknown anchor', () => {
      expect(moveRigid(row('a'), ['a'], 'ghost', { position: vec(0, 0, 0), rotation: vec(0, 0, 0) })).toBeNull();
    });
  });

  describe('drift (requirement 85)', () => {
    /** Mulberry32: a small seeded random generator, so the test is repeatable. */
    function random(seed: number) {
      let state = seed;
      return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    /** `touching` (design 4.2) for a's `+x` face and b's `-x` face, with the gap and the angle in the failure message. */
    const expectTouching = (ws: Workspace, step: string) => {
      const [fa, fb] = [['a', '+x'], ['b', '-x']].map(([id, face]) => {
        const object = findObject(ws, id!)!;
        return worldFace(object, object.model.parts[0]!, face as FaceId)!;
      });
      const result = touching(fa!, fb!);
      expect(Math.abs(result.gapMm), `gap after ${step}`).toBeLessThanOrEqual(CONTACT_GAP_MM);
      expect(result.angleDeg, `angle after ${step}`).toBeLessThanOrEqual(CONTACT_ANGLE_DEG);
      expect(result.ok, `touching after ${step}`).toBe(true);
    };

    it('starts touching', () => {
      expectTouching(rotatedPair({ joint: true }), 'the start');
      expectTouching(twoBoxes({ joint: true }), 'the start');
    });

    it('keeps a rotated, jointed pair touching through 200 position moves and 20 rotations', () => {
      const next = random(20261120);
      let ws = rotatedPair({ joint: true });
      for (let step = 1; step <= 200; step++) {
        const id = next() < 0.5 ? 'a' : 'b';
        const position = vec(...([0, 0, 0].map(() => Math.round((next() * 20 - 10) * 1e5) / 1e5) as [number, number, number]));
        ws = setTransform(ws, id, { position });
        expectTouching(ws, `position move ${step}`);
      }
      for (let step = 1; step <= 20; step++) {
        const id = next() < 0.5 ? 'a' : 'b';
        const rotation = vec(...([0, 0, 0].map(() => Math.round((next() * 360 - 180) * 100) / 100) as [number, number, number]));
        ws = setTransform(ws, id, { rotation });
        expectTouching(ws, `rotation ${step}`);
      }
    });

    it('keeps the pair touching when positions are not rounded to 5 decimals', () => {
      const next = random(7);
      let ws = rotatedPair({ joint: true });
      for (let step = 1; step <= 200; step++) {
        const id = next() < 0.5 ? 'a' : 'b';
        ws = setTransform(ws, id, { position: vec(next() * 20 - 10, next() * 20 - 10, next() * 20 - 10) });
        expectTouching(ws, `unrounded move ${step}`);
      }
    });

    it('keeps the pair touching through mixed moves and rotations', () => {
      const next = random(99);
      let ws = twoBoxes({ joint: true });
      for (let step = 1; step <= 120; step++) {
        const id = next() < 0.5 ? 'a' : 'b';
        const patch = next() < 0.8
          ? { position: vec(Math.round((next() * 6 - 3) * 1e5) / 1e5, Math.round((next() * 6 - 3) * 1e5) / 1e5, Math.round((next() * 6 - 3) * 1e5) / 1e5) }
          : { rotation: vec(Math.round((next() * 360 - 180) * 100) / 100, Math.round((next() * 180 - 90) * 100) / 100, Math.round((next() * 360 - 180) * 100) / 100) };
        ws = setTransform(ws, id, patch);
        expectTouching(ws, `mixed step ${step}`);
      }
    });
  });
});

describe('joinObjects', () => {
  const apart = (): Workspace => setTransform(twoBoxes(), 'b', { position: vec(BOX.x + 0.007, 0.003, 0) });
  const joint = fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'));
  it('moves side b and adds the joint in one result', () => {
    const ws = apart();
    const next = joinObjects(ws, { moves: [{ objectId: 'b', transform: { position: vec(BOX.x, 0, 0), rotation: vec(0, 0, 0) } }], joint });
    expect(transformOf(next, 'b').position).toEqual(vec(BOX.x, 0, 0));
    expect(next.joints).toEqual([joint]);
    expect(next.objects[0]).toBe(ws.objects[0]);
    expect(ws.joints).toEqual([]);
    expect(transformOf(ws, 'b').position.x).toBe(BOX.x + 0.007);
  });
  it('adds a joint with no moves', () => {
    const ws = twoBoxes();
    const next = joinObjects(ws, { moves: [], joint });
    expect(next.objects).toBe(ws.objects);
    expect(next.joints).toHaveLength(1);
  });
  it('moves the assembly of each moved object, before the new joint exists', () => {
    let ws = row('a', 'b', 'c');
    ws = addJoint(ws, link('bc', 'b', 'c'));
    const next = joinObjects(ws, {
      moves: [{ objectId: 'c', transform: { position: vec(0, 5, 0), rotation: vec(0, 0, 0) } }],
      joint: link('ab', 'a', 'b'),
    });
    expect(next.objects.map(object => object.transform.position.y)).toEqual([0, 5, 5]);
    expect(next.joints.map(item => item.id)).toEqual(['bc', 'ab']);
  });
  it('applies two moves in order', () => {
    const next = joinObjects(twoBoxes(), {
      moves: [
        { objectId: 'a', transform: { position: vec(0, 1, 0), rotation: vec(0, 0, 0) } },
        { objectId: 'b', transform: { position: vec(0, 2, 0), rotation: vec(0, 0, 0) } },
      ],
      joint,
    });
    expect(transformOf(next, 'a').position.y).toBe(1);
    expect(transformOf(next, 'b').position.y).toBe(2);
  });
  it('rejects more than two moves, an invalid joint and a full workspace', () => {
    const move = { objectId: 'b', transform: { position: vec(0, 0, 0), rotation: vec(0, 0, 0) } };
    expect(codeOf(() => joinObjects(twoBoxes(), { moves: [move, move, move], joint }))).toBe('INVALID_JOINT');
    expect(codeOf(() => joinObjects(twoBoxes(), { moves: [move], joint: { ...joint, a: side('a', 'ghost', '+x') } }))).toBe('INVALID_JOINT');
    expect(codeOf(() => joinObjects(twoBoxes(), { moves: [{ ...move, objectId: 'ghost' }], joint }))).toBe('UNKNOWN_OBJECT');
    const faces: FaceId[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
    let full = twoBoxes();
    for (const fa of faces) for (const fb of faces) if (full.joints.length < MAX_JOINTS) full = addJoint(full, link(`j${full.joints.length}`, 'a', 'b', [fa, fb]));
    expect(codeOf(() => joinObjects(full, { moves: [], joint: link('extra', 'b', 'a', ['+z', '-z']) }))).toBe('JOINT_LIMIT');
  });
  it('rejects a move outside the limits and leaves the workspace alone', () => {
    const ws = apart();
    const copy = clone(ws);
    expect(codeOf(() => joinObjects(ws, { moves: [{ objectId: 'b', transform: { position: vec(101, 0, 0), rotation: vec(0, 0, 0) } }], joint }))).toBe('INVALID_WORKSPACE');
    expect(ws).toEqual(copy);
  });
  it('does not mutate a frozen workspace', () => {
    const ws = deepFreeze(apart());
    const next = joinObjects(ws, { moves: [{ objectId: 'b', transform: { position: vec(BOX.x, 0, 0), rotation: vec(0, 0, 0) } }], joint: deepFreeze({ ...joint }) });
    expect(next.joints).toHaveLength(1);
  });
});

describe('applyWorkspaceChange with materials and joints', () => {
  const change = (patch: Partial<WorkspaceChange>): WorkspaceChange => ({ ...noChange, ...patch });
  it('accepts changes without a joint key and with a null joint', () => {
    expect(WorkspaceChangeSchema.safeParse(noChange).success).toBe(true);
    expect(WorkspaceChangeSchema.safeParse({ ...noChange, joint: null }).success).toBe(true);
  });
  it('returns the same workspace for a change with nothing in it', () => {
    const ws = twoBoxes({ joint: true });
    expect(applyWorkspaceChange(ws, noChange).after).toBe(ws);
    expect(applyWorkspaceChange(ws, { ...noChange, joint: null }).after).toBe(ws);
  });
  it('applies a material op', () => {
    const ws = twoBoxes();
    const { after } = applyWorkspaceChange(ws, change({ object: { op: 'material', objectId: 'a', material: 'nylon' } }));
    expect(findObject(after, 'a')!.material).toBe('nylon');
    const cleared = applyWorkspaceChange(after, change({ object: { op: 'material', objectId: 'a', material: null } })).after;
    expect(findObject(cleared, 'a')!.material).toBeNull();
    expect(ObjectChangeSchema.safeParse({ op: 'material', objectId: 'a', material: 'wood' }).success).toBe(false);
    expect(ObjectChangeSchema.safeParse({ op: 'material', objectId: 'a' }).success).toBe(false);
  });
  it('applies a joint add, update and remove', () => {
    const ws = twoBoxes();
    const joint = link('j1', 'a', 'b');
    const added = applyWorkspaceChange(ws, change({ joint: { op: 'add', joint } })).after;
    expect(added.joints).toEqual([joint]);
    const updated = applyWorkspaceChange(added, change({
      joint: { op: 'update', joint: { ...joint, method: SCREW, needs: { load: 'heavy', disassembly: 'often' }, confirmed: true } },
    })).after;
    expect(updated.joints[0]).toEqual({ ...joint, method: SCREW, needs: { load: 'heavy', disassembly: 'often' }, confirmed: true });
    const removed = applyWorkspaceChange(updated, change({ joint: { op: 'remove', jointId: 'j1' } })).after;
    expect(removed.joints).toEqual([]);
    expect(JointChangeSchema.safeParse({ op: 'remove', jointId: 'bad id' }).success).toBe(false);
    expect(JointChangeSchema.safeParse({ op: 'add', joint: { ...joint, extra: 1 } }).success).toBe(false);
  });
  it('rejects an update of an unknown joint and an update that changes the sides', () => {
    const ws = twoBoxes({ joint: true });
    expect(codeOf(() => applyWorkspaceChange(ws, change({ joint: { op: 'update', joint: link('ghost', 'a', 'b') } })))).toBe('UNKNOWN_JOINT');
    expect(codeOf(() => applyWorkspaceChange(ws, change({ joint: { op: 'update', joint: link('joint-1', 'a', 'b', ['+y', '-y']) } })))).toBe('INVALID_JOINT');
    expect(codeOf(() => applyWorkspaceChange(ws, change({ joint: { op: 'remove', jointId: 'ghost' } })))).toBe('UNKNOWN_JOINT');
  });
  it('applies the object change before the joint change', () => {
    const ws = row('a', 'b');
    const cb = codeOf(() => applyWorkspaceChange(ws, change({
      object: { op: 'remove', objectId: 'b' }, joint: { op: 'add', joint: link('j1', 'a', 'b') },
    })));
    expect(cb).toBe('UNKNOWN_OBJECT');
    const { after } = applyWorkspaceChange(ws, change({
      object: { op: 'transform', objectId: 'b', transform: { position: vec(BOX.x, 0, 0), rotation: vec(0, 0, 0) } },
      joint: { op: 'add', joint: link('j1', 'a', 'b') },
    }));
    expect(after.joints).toHaveLength(1);
  });
  it('lets a transform op move the assembly', () => {
    const ws = twoBoxes({ joint: true });
    const { after } = applyWorkspaceChange(ws, change({
      object: { op: 'transform', objectId: 'a', transform: { position: vec(0, 3, 0), rotation: vec(0, 0, 0) } },
    }));
    expect(transformOf(after, 'a').position.y).toBe(3);
    expect(transformOf(after, 'b').position).toEqual(vec(BOX.x, 3, 0));
  });
  it('applies activation first and the explode last, around joint changes', () => {
    const ws = twoBoxes();
    const { before, after } = applyWorkspaceChange(ws, change({
      activeObjectId: 'a', joint: { op: 'add', joint: link('j1', 'a', 'b') }, explode: 0.5,
    }));
    expect(before.activeObjectId).toBe('a');
    expect(before.joints).toEqual([]);
    expect(after.joints).toHaveLength(1);
    expect(after.display.explode).toBe(0.5);
  });
  it('removes the joints of a removed object', () => {
    const ws = twoBoxes({ joint: true });
    const { after } = applyWorkspaceChange(ws, change({ object: { op: 'remove', objectId: 'a' } }));
    expect(after.joints).toEqual([]);
  });
});

describe('fixtures', () => {
  it('builds every fixture with and without a joint', () => {
    for (const build of [twoBoxes, rotatedPair, boxOnCylinder, demoPair]) {
      const bare = build();
      const joined = build({ joint: true });
      expect(bare.joints).toEqual([]);
      expect(joined.joints).toHaveLength(1);
      expect(bare.objects).toHaveLength(2);
      expect(() => assertWorkspace(joined)).not.toThrow();
      expect(validateWorkspace(JSON.parse(JSON.stringify(joined)))).toEqual(joined);
    }
  });
  it('places the demo pair apart with placeBeside', () => {
    const ws = demoPair({ joint: true });
    expect(transformOf(ws, 'demo-a').position.x).toBe(0);
    expect(transformOf(ws, 'demo-b').position.x).toBeGreaterThan(0.16);
    expect(ws.joints[0]!.a).toEqual(side('demo-a', 'housing', '+x'));
  });
  it('puts the box on the cylinder cap', () => {
    const ws = boxOnCylinder({ joint: true });
    expect(ws.joints[0]).toMatchObject({ a: { objectId: 'post', face: '+y' }, b: { objectId: 'cap', face: '-y' } });
    expect(transformOf(ws, 'cap').position.y).toBeCloseTo(0.05 + BOX.y / 2, 5);
  });
  it('lets a joint override replace any field', () => {
    const ws = twoBoxes({ joint: true, jointOverrides: { method: SCREW, confirmed: true } });
    expect(ws.joints[0]).toMatchObject({ method: SCREW, confirmed: true, createdAt: CREATED_AT });
  });
});
