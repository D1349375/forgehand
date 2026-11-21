import { unzipSync } from 'fflate';
import type { ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jointFeatures } from '../../shared/features';
import { checkJoints } from '../../shared/joint-rules';
import type { Joint } from '../../shared/joint';
import type { Part } from '../../shared/model';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import {
  addJoint, addObject, emptyWorkspace, setMaterial, type ObjectTransform, type SceneObject, type Workspace,
} from '../../shared/workspace';
import { FUSE_PARTS } from '../../src/export/constants';
import { featuresSkippedJoints } from '../../src/export/findings';
import { meshBounds, meshProblems, meshVolume, type MeshData } from '../../src/export/mesh';
import { buildPieces, type PiecesInput, type PiecesResult } from '../../src/export/pieces';
import { kitZip, prepareKit, type KitInput } from '../../src/export/prepare';
import { zipFiles } from '../../src/export/zip';
import { loadManifold } from '../../src/print/manifold';
import { printablePart } from '../../src/print/printable';
import { demoPairWithScrew } from '../fixtures/export-workspace';
import { BOX, fixtureJoint, fixtureModel, fixtureObject, fixturePart, side, twoBoxes } from '../fixtures/joint-workspace';

const PROFILE = DEFAULT_PRINTER_PROFILE;
const vec = (x: number, y: number, z: number) => ({ x, y, z });
const mm = (value: number) => value / 1000;
type Triple = readonly [number, number, number];
const AT_ORIGIN: ObjectTransform = { position: vec(0, 0, 0), rotation: vec(0, 0, 0) };

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

/** A part named after its id; sizes and positions in millimetres. */
function part(id: string, primitive: Part['primitive'], size: Triple, at: Triple = [0, 0, 0], extra: Partial<Part> = {}): Part {
  const { role, ...rest } = extra;
  return { ...fixturePart(id, primitive, vec(mm(size[0]), mm(size[1]), mm(size[2])), vec(mm(at[0]), mm(at[1]), mm(at[2])), role ?? 'exterior'), ...rest };
}
const objectOf = (id: string, name: string, parts: Part[], transform: ObjectTransform = AT_ORIGIN): SceneObject =>
  fixtureObject(id, fixtureModel(name, parts), transform);
const workspaceOf = (...objects: SceneObject[]): Workspace => objects.reduce(addObject, emptyWorkspace());
const jointOf = (a: ReturnType<typeof side>, b: ReturnType<typeof side>, overrides: Partial<Joint> = {}): Joint => fixtureJoint(a, b, overrides);

/** Runs `buildPieces` the way `prepareKit` does: features and skipped joints from the joint rules. */
function build(ws: Workspace, options: Partial<PiecesInput> = {}): Promise<PiecesResult> {
  const features = jointFeatures(ws, PROFILE);
  const skipped = featuresSkippedJoints(checkJoints(ws, PROFILE, features));
  return buildPieces(ws, PROFILE, { wasm, features, skipped, ...options });
}
const codes = (result: PiecesResult) => result.findings.map(finding => finding.code);

/** Volume centroid of a closed mesh. */
function centroid(mesh: MeshData): THREE.Vector3 {
  const p = (index: number) => new THREE.Vector3(mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]);
  const sum = new THREE.Vector3();
  let volume = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = p(mesh.indices[i]!);
    const b = p(mesh.indices[i + 1]!);
    const c = p(mesh.indices[i + 2]!);
    const v = a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
    volume += v;
    sum.add(a.add(b).add(c).multiplyScalar(v / 4));
  }
  return sum.divideScalar(volume);
}

/** Whether a point is inside a closed mesh: the parity of the crossings of one ray (Moller-Trumbore). */
function inside(mesh: MeshData, point: Triple): boolean {
  const origin = new THREE.Vector3(...point);
  const direction = new THREE.Vector3(0.2673, 0.5345, 0.8018).normalize();
  const p = (index: number) => new THREE.Vector3(mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]);
  let crossings = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = p(mesh.indices[i]!);
    const e1 = p(mesh.indices[i + 1]!).sub(a);
    const e2 = p(mesh.indices[i + 2]!).sub(a);
    const h = new THREE.Vector3().crossVectors(direction, e2);
    const det = e1.dot(h);
    if (Math.abs(det) < 1e-12) continue;
    const s = origin.clone().sub(a);
    const u = s.dot(h) / det;
    if (u < 0 || u > 1) continue;
    const q = new THREE.Vector3().crossVectors(s, e1);
    const v = direction.dot(q) / det;
    if (v < 0 || u + v > 1) continue;
    if (e2.dot(q) / det > 1e-9) crossings += 1;
  }
  return crossings % 2 === 1;
}

/**
 * Counts the Manifold and CrossSection objects that are alive by wrapping every function of the two classes
 * that can return one. `restore` puts the originals back, because the module is shared with other test files.
 */
function trackLive(module: ManifoldToplevel) {
  const seen = new Set<{ isDeleted(): boolean }>();
  const restore: Array<() => void> = [];
  const classes = [module.Manifold, module.CrossSection] as unknown as Array<Record<string, unknown> & { prototype: Record<string, unknown> }>;
  const remember = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(remember);
    else if (value && typeof value === 'object' && 'isDeleted' in value) seen.add(value as { isDeleted(): boolean });
  };
  for (const Class of classes) {
    for (const target of [Class, Class.prototype]) {
      for (const name of Object.getOwnPropertyNames(target)) {
        const descriptor = Object.getOwnPropertyDescriptor(target, name);
        if (!descriptor || typeof descriptor.value !== 'function' || name === 'constructor' || name === 'delete') continue;
        const original = descriptor.value as (...args: unknown[]) => unknown;
        target[name] = function (this: unknown, ...args: unknown[]) {
          const result = original.apply(this, args);
          remember(result);
          return result;
        };
        restore.push(() => { target[name] = original; });
      }
    }
  }
  return {
    live: () => [...seen].filter(item => !item.isDeleted()).length,
    restore: () => restore.reverse().forEach(undo => undo()),
  };
}

describe('fusion', () => {
  it('fuses a box with two tubes pushed into it into one piece and reports FUSED', async () => {
    const ws = workspaceOf(objectOf('a', 'Camera', [
      part('body', 'box', [100, 60, 60]),
      part('tube-1', 'tube', [20, 40, 20], [-20, 0, 40], { rotation: vec(90, 0, 0) }),
      part('tube-2', 'tube', [20, 40, 20], [20, 0, 40], { rotation: vec(90, 0, 0) }),
    ]));
    const result = await build(ws);
    expect(result.pieces).toHaveLength(1);
    const piece = result.pieces[0]!;
    expect(piece.info).toMatchObject({ number: 'P01', name: 'body（含 3 個零件）', count: 1, file: 'stl/P01-body.stl', partNames: ['body', 'tube-1', 'tube-2'] });
    expect(piece.mainPartId).toBe('body');
    expect(piece.partIds).toEqual(['body', 'tube-1', 'tube-2']);
    expect(result.findings.filter(finding => finding.code === 'FUSED')).toMatchObject([{ severity: 'info', piece: 'P01', message: '「body（含 3 個零件）」由 3 個相連的零件合併而成。' }]);
  });

  it('fuses two stacked boxes that only touch, and keeps them apart when a joint separates them', async () => {
    const stacked = [part('low', 'box', [40, 20, 30]), part('high', 'box', [40, 20, 30], [0, 20, 0])];
    const plain = workspaceOf(objectOf('a', 'Stack', stacked));
    expect((await build(plain)).pieces).toHaveLength(1);

    const joined = addJoint(plain, jointOf(side('a', 'low', '+y'), side('a', 'high', '-y')));
    const result = await build(joined);
    // Both boxes are 40 x 20 x 30, so they are the same piece twice.
    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]!.info.count).toBe(2);
    expect(codes(result)).not.toContain('FUSED');
    expect(codes(result)).not.toContain('JOINT_FUSED');
  });

  it('keeps a joint inside one piece uncut and reports JOINT_FUSED', async () => {
    // A and C touch and are the two sides of a joint; B overlaps both and fuses them.
    const ws = addJoint(
      workspaceOf(objectOf('a', 'Chain', [
        part('a', 'box', [20, 20, 20]), part('c', 'box', [20, 20, 20], [20, 0, 0]), part('b', 'box', [20, 10, 10], [10, 0, 0]),
      ])),
      jointOf(side('a', 'a', '+x'), side('a', 'c', '-x'), { method: { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'b' }, confirmed: true }),
    );
    const result = await build(ws);
    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]!.info.partNames).toEqual(['a', 'c', 'b']);
    expect(result.findings.filter(finding => finding.code === 'JOINT_FUSED')).toMatchObject([
      { severity: 'warning', jointId: 'joint-1', piece: 'P01', message: '接合「a」↔「c」的兩個零件會連成同一個列印件，孔位沒有加工。' },
    ]);
    // No holes were cut: the piece is the plain union of three boxes.
    expect(meshProblems(result.pieces[0]!.mesh)).toEqual([]);
    // B lies inside A and C, so the union is the two 20 mm cubes.
    expect(result.pieces[0]!.info.volumeMm3).toBeCloseTo(16000, 0);
  });

  it('reports JOINT_OVERLAP when the two sides of a joint overlap, and never links them', async () => {
    const ws = addJoint(
      workspaceOf(objectOf('a', 'Pair', [part('left', 'box', [20, 20, 20]), part('right', 'box', [20, 20, 20], [15, 0, 0])])),
      jointOf(side('a', 'left', '+x'), side('a', 'right', '-x')),
    );
    const result = await build(ws);
    expect(result.findings.filter(finding => finding.code === 'JOINT_OVERLAP')).toMatchObject([
      { severity: 'warning', jointId: 'joint-1', message: '接合「left」↔「right」的兩個零件重疊 2000 mm³，印出後無法組合。' },
    ]);
    // The two boxes are identical, so they are one unique piece with two copies, not one fused piece.
    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]!.info).toMatchObject({ count: 2, name: 'left' });
  });

  it('reports a bought part inside a solid box as COMPONENT_BLOCKED and makes no piece for it', async () => {
    const ws = workspaceOf(objectOf('a', 'Casing', [
      part('shell', 'box', [100, 60, 40]), part('cell', 'box', [40, 20, 20], [0, 0, 0], { role: 'interior', name: '電池' }),
    ]));
    const result = await build(ws);
    expect(result.pieces).toHaveLength(1);
    expect(result.findings).toMatchObject([{ code: 'COMPONENT_BLOCKED', severity: 'warning', message: '外購件「電池」和「shell」重疊，印出後放不進去。' }]);
  });

  it('does not report a bought part that sits clear of the solid', async () => {
    const ws = workspaceOf(objectOf('a', 'Casing', [
      part('shell', 'box', [100, 60, 40]), part('cell', 'box', [40, 20, 20], [0, 80, 0], { role: 'interior' }),
    ]));
    expect(codes(await build(ws))).not.toContain('COMPONENT_BLOCKED');
  });

  it('reports a floating part as LOOSE_PIECE, but not the piece that has fused parts', async () => {
    const ws = workspaceOf(objectOf('a', 'Loose', [
      part('body', 'box', [100, 60, 40]), part('knob', 'cylinder', [20, 10, 20], [0, 35, 0]),
      part('float', 'sphere', [30, 30, 30], [0, 0, 200]),
    ]));
    const result = await build(ws);
    expect(result.pieces.map(piece => piece.info.name)).toEqual(['body（含 2 個零件）', 'float']);
    expect(result.findings.filter(finding => finding.code === 'LOOSE_PIECE')).toMatchObject([
      { piece: 'P02', severity: 'warning', message: '「float」沒有和其他零件相連或接合，組裝時需要另外固定。' },
    ]);
  });

  it('does not report LOOSE_PIECE when the object is one piece or a joint names the part', async () => {
    const one = workspaceOf(objectOf('a', 'One', [part('only', 'box', [20, 20, 20])]));
    expect(codes(await build(one))).not.toContain('LOOSE_PIECE');
    const two = workspaceOf(objectOf('a', 'Two', [part('x', 'box', [20, 20, 20]), part('y', 'box', [30, 30, 30], [100, 0, 0])]));
    expect(codes(await build(two)).filter(code => code === 'LOOSE_PIECE')).toHaveLength(2);
    expect(codes(await build(addJoint(two, jointOf(side('a', 'x', '+x'), side('a', 'y', '-x'))))).filter(code => code === 'LOOSE_PIECE')).toHaveLength(0);
  });

  it('reports a piece longer than 250 mm as TOO_LARGE', async () => {
    const result = await build(workspaceOf(objectOf('a', 'Long', [part('rail', 'box', [300, 20, 20])])));
    expect(result.findings).toMatchObject([{ code: 'TOO_LARGE', piece: 'P01', message: '「rail」最長 300 mm，可能超過一般印表機的列印範圍。' }]);
    expect((await build(workspaceOf(objectOf('a', 'Short', [part('rail', 'box', [250, 20, 20])])))).findings).toEqual([]);
  });

  it('gives one piece per printed part when fusion is off', async () => {
    const ws = workspaceOf(objectOf('a', 'Camera', [
      part('body', 'box', [100, 60, 60]), part('tube', 'tube', [20, 40, 20], [0, 0, 40], { rotation: vec(90, 0, 0) }), part('plate', 'box', [30, 10, 10], [0, 35, 0]),
    ]));
    expect((await build(ws)).pieces).toHaveLength(1);
    const apart = await build(ws, { fuse: false });
    expect(apart.pieces.map(piece => piece.info.name)).toEqual(['body', 'tube', 'plate']);
    expect(codes(apart)).not.toContain('FUSED');
    expect(FUSE_PARTS).toBe(true);
  });

  it('never fuses parts of different objects', async () => {
    const ws = workspaceOf(
      objectOf('a', 'One', [part('x', 'box', [20, 20, 20])]),
      objectOf('b', 'Two', [part('y', 'box', [30, 30, 30])], { position: vec(mm(25), 0, 0), rotation: vec(0, 0, 0) }),
    );
    expect((await build(ws)).pieces.map(piece => piece.info.objectName)).toEqual(['One', 'Two']);
  });
});

describe('identical pieces', () => {
  it('counts two identical glass discs, in one object or two, as one piece with count 2', async () => {
    const glass = (id: string, x: number) => part(id, 'cylinder', [34, 4, 34], [x, 0, 0], { color: '#6ad7f2' });
    const ws = workspaceOf(
      objectOf('a', 'Lenses', [glass('glass-1', -60), glass('glass-2', 60)]),
      objectOf('b', 'More', [glass('glass-3', 0)], { position: vec(0.3, 0.1, 0), rotation: vec(0, 0, 0) }),
    );
    const result = await build(ws);
    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]!.info).toMatchObject({ number: 'P01', count: 3, name: 'glass-1', objectName: 'Lenses' });
    expect(result.pieces[0]!.mesh.positions.length).toBeGreaterThan(0);
  });

  it('keeps pieces of different materials or colours apart', async () => {
    const box = (id: string, extra: Partial<Part> = {}) => objectOf(id, id, [part('body', 'box', [30, 20, 10], [0, 0, 0], extra)]);
    let ws = workspaceOf(box('a'), box('b'), box('c', { color: '#ff0000' }));
    expect((await build(ws)).pieces.map(piece => piece.info.count)).toEqual([2, 1]);
    ws = setMaterial(setMaterial(workspaceOf(box('a'), box('b')), 'a', 'pla'), 'b', 'petg');
    const result = await build(ws);
    expect(result.pieces.map(piece => [piece.info.objectName, piece.info.material, piece.info.count])).toEqual([['a', 'pla', 1], ['b', 'petg', 1]]);
  });

  it('keeps a mirrored copy apart', async () => {
    const withLug = (id: string, x: number) => objectOf(id, id, [part('p', 'box', [30, 20, 10]), part('q', 'box', [10, 20, 10], [x, 0, 0])]);
    const result = await build(workspaceOf(withLug('a', 20), withLug('b', -20)));
    expect(result.pieces).toHaveLength(2);
  });
});

describe('geometry', () => {
  /** Body with a plate across the face the insert holes start on; the joint's insert side is the body. */
  function plateOverHole(): { ws: Workspace } {
    const body = part('body', 'box', [40, 20, 30]);
    const plate = part('plate', 'box', [6, 16, 24], [-20, 0, 0]);
    const other = objectOf('a', 'Block A', [part('body', 'box', [40, 20, 30])]);
    const holder = objectOf('b', 'Block B', [body, plate], { position: vec(BOX.x, 0, 0), rotation: vec(0, 0, 0) });
    const ws = addJoint(workspaceOf(other, holder), jointOf(side('a', 'body', '+x'), side('b', 'body', '-x'), {
      method: { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'b' }, confirmed: true,
    }));
    return { ws };
  }

  it('keeps an insert hole open when another part of the same piece overlaps it', async () => {
    const { ws } = plateOverHole();
    const features = jointFeatures(ws, PROFILE);
    const hole = features.parts.get('b:body')!.find(feature => feature.kind === 'insert-hole')!;
    expect(hole).toBeDefined();
    const result = await build(ws);
    const piece = result.pieces.find(item => item.info.objectName === 'Block B')!;
    expect(piece.info.partNames).toEqual(['body', 'plate']);
    expect(meshProblems(piece.mesh)).toEqual([]);
    // The piece spans x -23..20 mm in the body frame; the print frame maps (x, y, z) to (x, -z, y) and rests on Z = 0.
    const toPrint = (x: number, y: number, z: number): Triple => [x + 1.5, -z, y + 10];
    const along = (depthMm: number, offsetMm: number): Triple => {
      const at = hole.centre;
      const axis = hole.axis;
      return toPrint(at.x * 1000 + axis.x * depthMm, at.y * 1000 + axis.y * depthMm, at.z * 1000 + axis.z * depthMm + offsetMm);
    };
    // 1 mm and 2 mm into the hole lie inside the plate and inside the body: open all the same.
    expect(inside(piece.mesh, along(1, 0))).toBe(false);
    expect(inside(piece.mesh, along(2, 0))).toBe(false);
    // Beside the hole the material is there.
    expect(inside(piece.mesh, along(1, 8))).toBe(true);
    expect(inside(piece.mesh, along(2, -8))).toBe(true);

    // Control: with the joint's features left out (an error finding), the same point is solid.
    const plain = await build(ws, { skipped: new Set(['joint-1']) });
    const solid = plain.pieces.find(item => item.info.objectName === 'Block B')!;
    expect(inside(solid.mesh, along(1, 0))).toBe(true);
    expect(inside(solid.mesh, along(2, 0))).toBe(true);
    expect(plain.findings.filter(finding => finding.code === 'FEATURES_SKIPPED')).toMatchObject([
      { severity: 'warning', jointId: 'joint-1', step: 1, message: '接合「Block A・body」↔「Block B・body」有問題，孔位沒有加工。' },
    ]);
    expect(codes(result)).not.toContain('FEATURES_SKIPPED');
  });

  it('builds a one-part piece with the volume of printablePart', async () => {
    const ws = twoBoxes({ jointOverrides: { method: { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'b' }, confirmed: true }, joint: true });
    const features = jointFeatures(ws, PROFILE);
    const result = await build(ws);
    expect(result.pieces).toHaveLength(2);
    for (const [index, id] of ['a', 'b'].entries()) {
      const object = ws.objects.find(item => item.id === id)!;
      const expected = await printablePart(object.model.parts[0]!, features.parts.get(`${id}:body`) ?? []);
      expect(expected.mesh.volumeMm3).toBeGreaterThan(0);
      expect(Math.abs(result.pieces[index]!.info.volumeMm3 - expected.mesh.volumeMm3) / expected.mesh.volumeMm3).toBeLessThan(0.001);
      expect(Math.abs(meshVolume(result.pieces[index]!.mesh) - expected.mesh.volumeMm3) / expected.mesh.volumeMm3).toBeLessThan(0.001);
    }
    // The holes make the two blocks different, and both are valid solids.
    expect(result.pieces.map(piece => piece.info.volumeMm3).every(volume => volume < 40 * 20 * 30)).toBe(true);
  });

  it('writes a piece in the frame of its main part: upright, centred and resting on Z = 0', async () => {
    // The main part is turned 90 degrees about Y in the model; its own frame is what prints.
    const ws = workspaceOf(objectOf('a', 'Turned', [
      part('main', 'box', [60, 20, 30], [10, 5, 0], { rotation: vec(0, 90, 0) }),
      part('small', 'box', [10, 10, 10], [10, 5, 0]),
    ]));
    const result = await build(ws);
    const piece = result.pieces[0]!;
    expect(piece.info.partNames).toEqual(['main', 'small']);
    expect(piece.info.sizeMm.x).toBeCloseTo(60, 2);
    expect(piece.info.sizeMm.y).toBeCloseTo(30, 2);
    expect(piece.info.sizeMm.z).toBeCloseTo(20, 2);
    const bounds = meshBounds(piece.mesh);
    expect(bounds.min[2]).toBeCloseTo(0, 4);
    expect(bounds.min[0] + bounds.max[0]).toBeCloseTo(0, 3);
    expect(bounds.min[1] + bounds.max[1]).toBeCloseTo(0, 3);
  });

  it('puts the model top up and its front (+z) towards -Y of the print frame', async () => {
    const ws = workspaceOf(objectOf('a', 'Wedge', [
      part('body', 'box', [40, 20, 30]), part('lug', 'box', [10, 10, 10], [0, 0, 17]),
    ]));
    const piece = (await build(ws)).pieces[0]!;
    // Height is the model's y; depth runs along z, with the lug (front, +z) at -Y.
    expect(piece.info.sizeMm.z).toBeCloseTo(20, 3);
    expect(piece.info.sizeMm.y).toBeCloseTo(37, 3);
    expect(centroid(piece.mesh).y).toBeGreaterThan(0);
    expect(meshBounds(piece.mesh).min[2]).toBeCloseTo(0, 4);
  });

  it('writes valid, outward meshes for every primitive', async () => {
    const parts = (['box', 'sphere', 'cylinder', 'cone', 'torus', 'tube'] as const).map((primitive, index) =>
      part(primitive, primitive, [30, 30, 30], [index * 100, 0, 0]));
    const result = await build(workspaceOf(objectOf('a', 'All', parts)));
    expect(result.pieces).toHaveLength(6);
    for (const piece of result.pieces) {
      expect(meshProblems(piece.mesh)).toEqual([]);
      expect(piece.info.volumeMm3).toBeGreaterThan(0);
    }
  });

  it('numbers pieces by object, then by the model order of the main part, and names the files', async () => {
    const ws = workspaceOf(
      objectOf('first', 'First', [part('later', 'box', [20, 20, 20], [100, 0, 0]), part('small', 'cone', [15, 15, 15], [-100, 0, 0])]),
      objectOf('second', 'Second', [part('only', 'sphere', [25, 25, 25])]),
    );
    const result = await build(ws);
    expect(result.pieces.map(piece => [piece.info.number, piece.info.file, piece.info.objectName])).toEqual([
      ['P01', 'stl/P01-later.stl', 'First'], ['P02', 'stl/P02-small.stl', 'First'], ['P03', 'stl/P03-only.stl', 'Second'],
    ]);
    expect(result.pieces.every(piece => /^[A-Za-z0-9._/-]+$/.test(piece.info.file))).toBe(true);
  });

  it('reports progress by printed parts, yields after each piece and ignores bought parts', async () => {
    const ws = workspaceOf(objectOf('a', 'Three', [
      part('x', 'box', [20, 20, 20]), part('y', 'box', [30, 20, 20], [100, 0, 0]), part('z', 'box', [20, 30, 20], [200, 0, 0]),
      part('cell', 'box', [10, 10, 10], [0, 100, 0], { role: 'interior' }),
    ]));
    const calls: Array<[number, number]> = [];
    let yields = 0;
    await build(ws, { onProgress: (done, total) => calls.push([done, total]), yieldNow: async () => { yields += 1; } });
    expect(calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
    expect(yields).toBeGreaterThanOrEqual(3);
  });
});

describe('resources', () => {
  let tracker: ReturnType<typeof trackLive> | null = null;
  afterEach(() => {
    tracker?.restore();
    tracker = null;
  });

  const threePieces = () => workspaceOf(objectOf('a', 'Three', [
    part('x', 'box', [20, 20, 20]), part('y', 'cylinder', [30, 20, 30], [100, 0, 0]), part('z', 'cone', [20, 30, 20], [200, 0, 0]),
  ]));

  it('leaves no Manifold alive after a normal run, a run with joint features and a run without fusion', async () => {
    tracker = trackLive(wasm);
    await build(threePieces());
    await build(twoBoxes({ joint: true, jointOverrides: { method: { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'b' }, confirmed: true } }));
    await build(threePieces(), { fuse: false });
    expect(tracker.live()).toBe(0);
  });

  it('deletes everything when the run is stopped after the first piece', async () => {
    tracker = trackLive(wasm);
    const controller = new AbortController();
    const outcome = build(threePieces(), { signal: controller.signal, onProgress: done => { if (done > 0) controller.abort(); } });
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracker.live()).toBe(0);
  });

  it('deletes everything when the run is stopped before it starts or while it builds solids', async () => {
    tracker = trackLive(wasm);
    const early = new AbortController();
    early.abort();
    await expect(build(threePieces(), { signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracker.live()).toBe(0);
    const controller = new AbortController();
    await expect(build(threePieces(), { signal: controller.signal, yieldNow: async () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracker.live()).toBe(0);
  });

  it('writes a piece without its holes and reports FEATURES_SKIPPED when the cut fails, and leaks nothing', async () => {
    tracker = trackLive(wasm);
    const manifold = wasm.Manifold as unknown as { difference: unknown };
    const original = manifold.difference;
    manifold.difference = () => { throw new Error('boolean failed'); };
    let result: PiecesResult;
    try {
      result = await build(twoBoxes({ joint: true, jointOverrides: { method: { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'b' }, confirmed: true } }));
    } finally {
      manifold.difference = original;
    }
    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]!.info).toMatchObject({ count: 2, volumeMm3: expect.closeTo(40 * 20 * 30, 0) });
    expect(result.findings.filter(finding => finding.code === 'FEATURES_SKIPPED')).toMatchObject([{ jointId: 'joint-1', step: 1 }]);
    expect(codes(result)).not.toContain('PIECE_FAILED');
    expect(tracker.live()).toBe(0);
  });

  it('leaves a piece out and reports PIECE_FAILED when it cannot be built at all, and keeps the others', async () => {
    tracker = trackLive(wasm);
    const manifold = wasm.Manifold as unknown as { union: unknown };
    const original = manifold.union;
    manifold.union = () => { throw new Error('union failed'); };
    let result: PiecesResult;
    try {
      result = await build(workspaceOf(objectOf('a', 'Mixed', [
        part('body', 'box', [60, 20, 20]), part('lid', 'box', [60, 10, 20], [0, 15, 0]), part('alone', 'sphere', [30, 30, 30], [200, 0, 0]),
      ])));
    } finally {
      manifold.union = original;
    }
    expect(result.pieces.map(piece => piece.info.name)).toEqual(['alone']);
    expect(result.findings.filter(finding => finding.severity === 'error')).toMatchObject([{ severity: 'error', code: 'PIECE_FAILED', message: '「body（含 2 個零件）」無法產生列印檔，已略過。' }]);
    expect(tracker.live()).toBe(0);
  });

  it('deletes everything when the geometry library fails in the middle of a run', async () => {
    tracker = trackLive(wasm);
    const manifold = wasm.Manifold as unknown as { sphere: unknown };
    const original = manifold.sphere;
    manifold.sphere = () => { throw new Error('out of memory'); };
    try {
      const ws = workspaceOf(objectOf('a', 'Fail', [part('x', 'box', [20, 20, 20]), part('ball', 'sphere', [30, 30, 30], [100, 0, 0])]));
      await expect(build(ws)).rejects.toThrow('out of memory');
    } finally {
      manifold.sphere = original;
    }
    expect(tracker.live()).toBe(0);
  });
});

describe('prepareKit', () => {
  const exportedAt = new Date(2026, 10, 21, 9, 5, 0);
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const GLB = Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 4, 5, 6]);
  const input = (ws: Workspace, extra: Partial<KitInput> = {}): KitInput => ({
    workspace: ws, scope: { scope: 'workspace', objectId: null }, profile: PROFILE, exportedAt, loadManifold: () => loadManifold(),
    renderImage: async () => PNG, writeGlb: async () => GLB, ...extra,
  });
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  it('lists the files of the kit with their MIME types, and the zip holds exactly those bytes', async () => {
    const kit = await prepareKit(input(demoPairWithScrew()));
    const paths = kit.files.map(file => file.path);
    expect(paths.slice(0, 5)).toEqual(['assembly.html', 'exploded.png', 'bom.csv', 'bom.md', 'kit.3mf']);
    expect(paths[5]).toBe('workspace.glb');
    expect(paths.slice(6).every(path => /^stl\/P\d\d-[a-z0-9-]+\.stl$/.test(path))).toBe(true);
    expect(paths.length - 6).toBe(kit.summary.pieces);
    expect(Object.fromEntries(kit.files.slice(0, 6).map(file => [file.path, file.mime]))).toEqual({
      'assembly.html': 'text/html;charset=utf-8', 'exploded.png': 'image/png', 'bom.csv': 'text/csv;charset=utf-8',
      'bom.md': 'text/markdown;charset=utf-8', 'kit.3mf': 'model/3mf', 'workspace.glb': 'model/gltf-binary',
    });
    expect(kit.files.slice(6).every(file => file.mime === 'model/stl')).toBe(true);
    expect(kit.zipName).toBe('forgehand-kit-20261121-0905.zip');
    expect(kit.imageMissing).toBe(false);

    const zip = kitZip(kit, exportedAt);
    expect(zip).toEqual(zipFiles(kit.files, exportedAt));
    const unpacked = unzipSync(zip);
    expect(Object.keys(unpacked)).toEqual(paths);
    for (const file of kit.files) expect(unpacked[file.path]).toEqual(file.bytes);
    // TextDecoder drops a byte-order mark, so the bytes are checked.
    expect([...unpacked['bom.csv']!.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decode(unpacked['bom.csv']!).startsWith('類別,編號,名稱')).toBe(true);
    expect(decode(unpacked['kit.3mf']!.subarray(0, 2))).toBe('PK');
  });

  it('gives identical bytes for the same input (requirement 64)', async () => {
    const first = await prepareKit(input(demoPairWithScrew()));
    const second = await prepareKit(input(demoPairWithScrew()));
    expect(second.files.map(file => file.path)).toEqual(first.files.map(file => file.path));
    for (const [index, file] of first.files.entries()) expect(second.files[index]!.bytes).toEqual(file.bytes);
    expect(kitZip(second, exportedAt)).toEqual(kitZip(first, exportedAt));
    expect(second.findings).toEqual(first.findings);
    expect(second.summary).toEqual(first.summary);
  });

  it('leaves out exploded.png and workspace.glb when they are not given, and flags the missing image', async () => {
    const kit = await prepareKit(input(demoPairWithScrew(), { renderImage: undefined, writeGlb: undefined }));
    expect(kit.files.map(file => file.path)).not.toContain('exploded.png');
    expect(kit.files.map(file => file.path)).not.toContain('workspace.glb');
    expect(kit.imageMissing).toBe(true);
    const failed = await prepareKit(input(demoPairWithScrew(), { renderImage: async () => { throw new Error('no WebGL'); } }));
    expect(failed.imageMissing).toBe(true);
    expect(failed.files.map(file => file.path)).not.toContain('exploded.png');
    expect(decode(failed.files[0]!.bytes)).not.toContain('<img');
    const none = await prepareKit(input(demoPairWithScrew(), { renderImage: async () => null }));
    expect(none.imageMissing).toBe(true);
  });

  it('prepares a kit with no printed parts without loading the geometry library (requirement 22)', async () => {
    const cell = objectOf('a', 'Parts', [part('cell', 'box', [40, 20, 20], [0, 0, 0], { role: 'interior', name: '電池' })]);
    const metal = setMaterial(workspaceOf(objectOf('m', 'Bracket', [part('plate', 'box', [40, 5, 20], [0, 0, 0], { name: '底板' })]), cell), 'm', 'aluminium');
    let loaded = 0;
    const progress: Array<[number, number]> = [];
    const kit = await prepareKit(input(metal, { loadManifold: async () => { loaded += 1; throw new Error('must not load'); }, onProgress: (done, total) => progress.push([done, total]) }));
    expect(loaded).toBe(0);
    expect(progress).toEqual([[0, 0]]);
    const paths = kit.files.map(file => file.path);
    expect(paths).toEqual(['assembly.html', 'exploded.png', 'bom.csv', 'bom.md', 'workspace.glb']);
    expect(kit.summary).toEqual({ pieces: 0, copies: 0, bought: 1, machined: 1, standard: 0, totalVolumeMm3: 0 });
    expect(kit.findings.map(finding => finding.code).sort()).toEqual(['BOUGHT', 'MACHINED']);
    expect(kit.findings.find(finding => finding.code === 'MACHINED')!.message).toBe('「Bracket・底板」是金屬件，需另行加工，不會產生列印檔。');
  });

  it('stops with an AbortError when the signal fires, and deletes every Manifold', async () => {
    const tracker = trackLive(wasm);
    try {
      const controller = new AbortController();
      await expect(prepareKit(input(demoPairWithScrew(), { signal: controller.signal, onProgress: done => { if (done > 0) controller.abort(); } })))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(tracker.live()).toBe(0);
    } finally {
      tracker.restore();
    }
  });

  it('throws the plan error for an empty workspace and an unknown object', async () => {
    await expect(prepareKit(input(emptyWorkspace()))).rejects.toMatchObject({ code: 'NO_MODEL' });
    await expect(prepareKit(input(demoPairWithScrew(), { scope: { scope: 'assembly', objectId: 'nope' } }))).rejects.toMatchObject({ code: 'UNKNOWN_OBJECT' });
  });

  it('exports the demo pair with one screw joint: valid meshes, summary, and findings in the joint order', async () => {
    const ws = demoPairWithScrew();
    const kit = await prepareKit(input(ws));
    const list = kit.files.filter(file => file.path.startsWith('stl/'));
    expect(list.length).toBe(kit.summary.pieces);
    expect(kit.summary.copies).toBeGreaterThanOrEqual(kit.summary.pieces);
    expect(kit.summary.bought).toBe(2);
    expect(kit.summary.standard).toBeGreaterThan(0);
    expect(kit.findings.map(finding => finding.severity)).toEqual([...kit.findings.map(finding => finding.severity)].sort((x, y) => ['error', 'warning', 'info'].indexOf(x) - ['error', 'warning', 'info'].indexOf(y)));
    const sheet = decode(kit.files[0]!.bytes);
    expect(sheet).toContain('組裝步驟');
    expect(sheet).not.toContain('<script');
  });

  it('exports an assembly scope as only the joined objects', async () => {
    const ws = twoBoxes({ joint: true, jointOverrides: { confirmed: true } });
    const extra = addObject(ws, objectOf('c', 'Lonely', [part('body', 'sphere', [30, 30, 30])], { position: vec(1, 0, 0), rotation: vec(0, 0, 0) }));
    const all = await prepareKit(input(extra));
    const some = await prepareKit(input(extra, { scope: { scope: 'assembly', objectId: 'a' } }));
    expect(all.summary.pieces).toBeGreaterThan(some.summary.pieces);
    expect(some.files.map(file => file.path).filter(path => path.startsWith('stl/'))).toHaveLength(some.summary.pieces);
  });
});

describe('time of a large workspace (not an assertion)', () => {
  /** `objects` objects of 64 boxes in a 4 x 4 x 4 grid; `pitch` 10 mm touches, 15 mm leaves 5 mm gaps. */
  function grid(objects: number, pitch: number): Workspace {
    let ws = emptyWorkspace();
    for (let o = 0; o < objects; o += 1) {
      const parts: Part[] = [];
      for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) for (let k = 0; k < 4; k += 1) {
        parts.push(part(`b${i}${j}${k}`, 'box', [10, 10, 10], [i * pitch, j * pitch, k * pitch]));
      }
      ws = addObject(ws, objectOf(`o${o}`, `Grid ${o}`, parts, { position: vec(o * 0.3, 0, 0), rotation: vec(0, 0, 0) }));
    }
    return ws;
  }

  it.each([[10, 'touching boxes, one piece of 64 per object'], [15, 'boxes 5 mm apart, 64 pieces per object']] as const)(
    'builds 8 objects x 64 boxes with pitch %i mm (%s)', async (pitch, label) => {
      const ws = grid(8, pitch);
      const started = performance.now();
      const result = await build(ws);
      const seconds = (performance.now() - started) / 1000;
      console.log(`buildPieces 8 x 64 boxes, ${label}: ${seconds.toFixed(2)} s, ${result.pieces.length} unique pieces, copies ${result.pieces.reduce((sum, piece) => sum + piece.info.count, 0)}`);
      expect(result.pieces.length).toBeGreaterThan(0);
      for (const piece of result.pieces) expect(meshProblems(piece.mesh)).toEqual([]);
    }, 120_000,
  );
});
