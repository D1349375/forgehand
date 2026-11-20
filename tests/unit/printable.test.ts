import type { ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { featuresForJoint, type JointFeature } from '../../shared/features';
import type { JointMethod } from '../../shared/joint';
import type { Part } from '../../shared/model';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import { addJoint, addObject, emptyWorkspace } from '../../shared/workspace';
import { loadManifold } from '../../src/print/manifold';
import {
  featureSolids, OVERSHOOT_MM, primitiveSolid, printablePart, toBufferGeometry, type PrintableMesh,
} from '../../src/print/printable';
import { fixtureJoint, fixtureModel, fixtureObject, fixturePart, side } from '../fixtures/joint-workspace';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const mm = (value: number) => value / 1000;
const ZERO = { position: vec(0, 0, 0), rotation: vec(0, 0, 0) };

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

const part = (primitive: Part['primitive'], xMm: number, yMm: number, zMm: number, tubeRatio = 0.6): Part =>
  ({ ...fixturePart('p', primitive, vec(mm(xMm), mm(yMm), mm(zMm))), tubeRatio });

/** Every edge of the mesh is used by exactly two triangles, once in each direction. */
function isClosed(mesh: PrintableMesh): boolean {
  const directed = new Map<string, number>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const from = mesh.indices[i + k]!;
      const to = mesh.indices[i + ((k + 1) % 3)]!;
      directed.set(`${from}>${to}`, (directed.get(`${from}>${to}`) ?? 0) + 1);
    }
  }
  for (const [edge, count] of directed) {
    const [from, to] = edge.split('>');
    if (count !== 1 || directed.get(`${to}>${from}`) !== 1) return false;
  }
  return directed.size > 0;
}

/** Volume from the triangles (positive when they face outwards). */
function signedVolume(mesh: PrintableMesh): number {
  let total = 0;
  const p = (index: number) => new THREE.Vector3(mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    total += p(mesh.indices[i]!).dot(new THREE.Vector3().crossVectors(p(mesh.indices[i + 1]!), p(mesh.indices[i + 2]!))) / 6;
  }
  return total;
}

function boundsOf(mesh: PrintableMesh): THREE.Box3 {
  const box = new THREE.Box3();
  for (let i = 0; i < mesh.positions.length; i += 3) box.expandByPoint(new THREE.Vector3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
  return box;
}

/** Distance to the first triangle a ray hits (Moller-Trumbore), or null. */
function castRay(mesh: PrintableMesh, origin: THREE.Vector3, direction: THREE.Vector3): number | null {
  let nearest: number | null = null;
  const p = (index: number) => new THREE.Vector3(mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = p(mesh.indices[i]!);
    const e1 = p(mesh.indices[i + 1]!).sub(a);
    const e2 = p(mesh.indices[i + 2]!).sub(a);
    const h = new THREE.Vector3().crossVectors(direction, e2);
    const det = e1.dot(h);
    if (Math.abs(det) < 1e-12) continue;
    const s = origin.clone().sub(a);
    const u = s.dot(h) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q = new THREE.Vector3().crossVectors(s, e1);
    const v = direction.dot(q) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = e2.dot(q) / det;
    if (t > 1e-9 && (nearest === null || t < nearest)) nearest = t;
  }
  return nearest;
}

/** Size of the wasm heap; it only grows when live Manifold objects need more room than it has. */
const heapBytes = () => (wasm as unknown as { HEAPU8: Uint8Array }).HEAPU8.byteLength;

const within = (actual: number, expected: number, tolerance: number) => Math.abs(actual - expected) / expected <= tolerance;

describe('loadManifold', () => {
  it('loads once and returns the same set-up module every time', async () => {
    const first = loadManifold();
    expect(loadManifold()).toBe(first);
    expect(await first).toBe(wasm);
    expect(typeof wasm.Manifold.cube).toBe('function');
  });
});

describe('printablePart without features', () => {
  const cases: Array<{ name: string; part: Part; volume: number; tolerance: number }> = [
    { name: 'box', part: part('box', 30, 20, 10), volume: 30 * 20 * 10, tolerance: 0.01 },
    { name: 'cylinder', part: part('cylinder', 20, 30, 20), volume: Math.PI * 10 ** 2 * 30, tolerance: 0.01 },
    { name: 'cone', part: part('cone', 20, 30, 20), volume: (Math.PI * 10 ** 2 * 30) / 3, tolerance: 0.01 },
    { name: 'tube', part: part('tube', 20, 30, 20, 0.6), volume: Math.PI * (10 ** 2 - 6 ** 2) * 30, tolerance: 0.01 },
    { name: 'sphere', part: part('sphere', 20, 20, 20), volume: (4 / 3) * Math.PI * 10 ** 3, tolerance: 0.02 },
    // R = 15 mm, r = 5 mm (the unit torus 0.375 / 0.125 scaled by 40).
    { name: 'torus', part: part('torus', 40, 40, 10), volume: 2 * Math.PI ** 2 * 15 * 5 ** 2, tolerance: 0.02 },
  ];
  for (const { name, part: input, volume, tolerance } of cases) {
    it(`gives a closed ${name} with the analytic volume`, async () => {
      const result = await printablePart(input, []);
      expect(isClosed(result.mesh)).toBe(true);
      expect(within(result.mesh.volumeMm3, volume, tolerance)).toBe(true);
      expect(within(signedVolume(result.mesh), result.mesh.volumeMm3, 1e-4)).toBe(true);
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual([]);
    });
  }

  it('builds every primitive with the proportions and axes of the display geometry', async () => {
    const size = (box: THREE.Box3) => box.getSize(new THREE.Vector3());
    const cylinder = (await printablePart(part('cylinder', 20, 30, 10), [])).mesh;
    expect(size(boundsOf(cylinder)).toArray().map(Math.round)).toEqual([20, 30, 10]);
    const torus = (await printablePart(part('torus', 40, 40, 10), [])).mesh;
    expect(size(boundsOf(torus)).toArray().map(Math.round)).toEqual([40, 40, 10]);
    // The torus' hole axis is Z: a ray down Z through the centre passes through the hole.
    expect(castRay(torus, new THREE.Vector3(0, 0, 20), new THREE.Vector3(0, 0, -1))).toBeNull();
    // The cone's apex is at +Y: the widest ring is at -Y.
    const cone = (await printablePart(part('cone', 20, 30, 20), [])).mesh;
    let apexRadius = Infinity;
    let baseRadius = 0;
    for (let i = 0; i < cone.positions.length; i += 3) {
      const radius = Math.hypot(cone.positions[i]!, cone.positions[i + 2]!);
      if (Math.abs(cone.positions[i + 1]! - 15) < 1e-3) apexRadius = Math.min(apexRadius, radius);
      if (Math.abs(cone.positions[i + 1]! + 15) < 1e-3) baseRadius = Math.max(baseRadius, radius);
    }
    expect(apexRadius).toBeLessThan(1e-3);
    expect(baseRadius).toBeCloseTo(10, 3);
    // The tube's bore runs along Y: a ray down Y through the centre finds no wall.
    const tube = (await printablePart(part('tube', 20, 30, 20, 0.6), [])).mesh;
    expect(castRay(tube, new THREE.Vector3(0, 40, 0), new THREE.Vector3(0, -1, 0))).toBeNull();
    expect(castRay(tube, new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0))).toBeCloseTo(6, 1);
  });
});

/** Objects `a` and `b`, a box part each, touching along z. Joint `joint-1`: a `+z` to b `-z`. */
function zPair(aThicknessMm: number, method: JointMethod) {
  const a = fixtureObject('a', fixtureModel('A', [fixturePart('body', 'box', vec(0.03, 0.02, mm(aThicknessMm)))]), ZERO);
  const b = fixtureObject('b', fixtureModel('B', [fixturePart('body', 'box', vec(0.03, 0.02, 0.01))]),
    { position: vec(0, 0, mm(aThicknessMm / 2 + 5)), rotation: vec(0, 0, 0) });
  const joint = fixtureJoint(side('a', 'body', '+z'), side('b', 'body', '-z'), { method });
  const ws = addJoint(addObject(addObject(emptyWorkspace(), a), b), joint);
  const set = featuresForJoint(ws, joint, DEFAULT_PRINTER_PROFILE);
  return { ws, set, partA: a.model.parts[0]!, onA: set.features.filter(feature => feature.side === 'a') };
}

const screw: JointMethod = { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'a' };
const cylinderVolume = (feature: JointFeature, depthMm = feature.depth * 1000) => Math.PI * (feature.diameter * 500) ** 2 * depthMm;

describe('printablePart with features', () => {
  it('cuts an M3 insert hole and its tail from a 30 x 20 x 10 mm box', async () => {
    const { set, partA, onA } = zPair(10, screw);
    expect(set.problems).toEqual([]);
    expect(onA.map(feature => feature.kind)).toEqual(['insert-hole', 'clearance-hole']);
    const result = await printablePart(partA, onA);
    expect(result.applied).toEqual(onA.map(feature => feature.id));
    expect(isClosed(result.mesh)).toBe(true);
    const expected = 30 * 20 * 10 - onA.reduce((sum, feature) => sum + cylinderVolume(feature), 0);
    expect(within(result.mesh.volumeMm3, expected, 0.01)).toBe(true);
    // The insert hole is 4.0 + 0.2 mm wide and 5.9 mm deep, the tail 3.4 + 0.2 mm wide: rays from the axis
    // sideways hit the wall at the printed radius (z is 5 at the top face).
    const [insert, tail] = onA;
    const radiusAt = (z: number) => castRay(result.mesh, new THREE.Vector3(0, 0, z), new THREE.Vector3(1, 0, 0));
    expect(insert!.diameter * 500).toBeCloseTo(0.0021 * 1000, 6);
    expect(radiusAt(5 - 2)).toBeCloseTo(2.1, 1);
    expect(radiusAt(5 - 5.9 - 1)).toBeCloseTo(tail!.diameter * 500, 1);
    expect(tail!.diameter * 500).toBeCloseTo(1.8, 6);
    // Down the axis from above the face the first wall is the bottom of the tail.
    const bottom = castRay(result.mesh, new THREE.Vector3(0, 0, 8), new THREE.Vector3(0, 0, -1));
    expect(bottom).toBeCloseTo(8 - (5 - 5.9 - 3), 1);
  });

  it('adds a boss to a 3 mm plate and the volume grows by the boss minus the hole', async () => {
    const { set, partA, onA } = zPair(3, screw);
    expect(set.problems).toEqual([]);
    const boss = onA.find(feature => feature.kind === 'boss')!;
    expect(boss).toBeDefined();
    const result = await printablePart(partA, onA);
    expect(isClosed(result.mesh)).toBe(true);
    const holes = onA.filter(feature => feature.kind !== 'boss');
    const expected = 30 * 20 * 3 + cylinderVolume(boss) - holes.reduce((sum, feature) => sum + cylinderVolume(feature), 0);
    expect(within(result.mesh.volumeMm3, expected, 0.01)).toBe(true);
    expect(result.mesh.volumeMm3).toBeGreaterThan(30 * 20 * 3);
    // The boss makes the part taller than the plate: 3 mm plus the boss height.
    expect(boundsOf(result.mesh).getSize(new THREE.Vector3()).z).toBeCloseTo(3 + boss.depth * 1000, 2);
  });

  it('leaves a skipped feature out and lists it', async () => {
    const { partA, onA } = zPair(10, screw);
    const [insert, tail] = onA;
    const all = await printablePart(partA, onA);
    const skipped = await printablePart(partA, onA, { skip: new Set([tail!.id]) });
    expect(skipped.skipped).toEqual([{ featureId: tail!.id, reason: 'problem' }]);
    expect(skipped.applied).toEqual([insert!.id]);
    expect(skipped.mesh.volumeMm3).toBeGreaterThan(all.mesh.volumeMm3);
    expect(within(skipped.mesh.volumeMm3, 30 * 20 * 10 - cylinderVolume(insert!), 0.01)).toBe(true);
  });

  it('skips a feature whose numbers are not finite and positive as invalid', async () => {
    const { partA, onA } = zPair(10, screw);
    const [insert, tail] = onA;
    const broken: JointFeature[] = [insert!, { ...tail!, diameter: Number.NaN }, { ...tail!, id: 'zero', depth: 0 }, { ...tail!, id: 'axis', axis: vec(0, 0, 0) }];
    const result = await printablePart(partA, broken);
    expect(result.skipped).toEqual([
      { featureId: tail!.id, reason: 'invalid' }, { featureId: 'zero', reason: 'invalid' }, { featureId: 'axis', reason: 'invalid' },
    ]);
    expect(result.applied).toEqual([insert!.id]);
    expect(isClosed(result.mesh)).toBe(true);
  });

  it('places features on a face that is not +z (axis mapped to the feature axis)', async () => {
    // The same joint on the +x face of a 10 mm thick plate: the hole must run along -x.
    const a = fixtureObject('a', fixtureModel('A', [fixturePart('body', 'box', vec(0.01, 0.02, 0.03))]), ZERO);
    const b = fixtureObject('b', fixtureModel('B', [fixturePart('body', 'box', vec(0.01, 0.02, 0.03))]), { position: vec(0.01, 0, 0), rotation: vec(0, 0, 0) });
    const joint = fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'), { method: screw });
    const ws = addJoint(addObject(addObject(emptyWorkspace(), a), b), joint);
    const onA = featuresForJoint(ws, joint, DEFAULT_PRINTER_PROFILE).features.filter(feature => feature.side === 'a');
    const result = await printablePart(a.model.parts[0]!, onA);
    const expected = 10 * 20 * 30 - onA.reduce((sum, feature) => sum + cylinderVolume(feature), 0);
    expect(within(result.mesh.volumeMm3, expected, 0.01)).toBe(true);
    expect(castRay(result.mesh, new THREE.Vector3(5 - 2, 0, 0), new THREE.Vector3(0, 1, 0))).toBeCloseTo(2.1, 1);
  });

  it('frees every Manifold it creates', async () => {
    // A solid that is never deleted keeps its mesh in the wasm heap (about 4 MB for this torus), so a leak
    // of even a few calls grows the heap. Deleted solids are reused and the heap stays the same size.
    const { partA, onA } = zPair(3, screw);
    const torus = part('torus', 40, 40, 10);
    const run = async () => {
      await printablePart(torus, []);
      await printablePart(partA, onA);
      await printablePart(partA, onA, { skip: new Set([onA[0]!.id]) });
    };
    for (let i = 0; i < 10; i++) await run();
    const before = heapBytes();
    for (let i = 0; i < 40; i++) await run();
    expect(heapBytes()).toBe(before);
  });
});

describe('primitiveSolid and featureSolids', () => {
  it('primitiveSolid returns a solid in millimetres that the caller owns', () => {
    const solid = primitiveSolid(wasm, part('box', 30, 20, 10));
    try {
      expect(solid.volume()).toBeCloseTo(6000, 6);
      expect(solid.status()).toBe('NoError');
      expect(solid.boundingBox()).toEqual({ min: [-15, -10, -5], max: [15, 10, 5] });
    } finally {
      solid.delete();
    }
  });

  it('primitiveSolid frees its intermediates', () => {
    const run = () => {
      for (const primitive of ['box', 'cylinder', 'cone', 'sphere', 'tube', 'torus'] as const) primitiveSolid(wasm, part(primitive, 40, 40, 10)).delete();
    };
    for (let i = 0; i < 10; i++) run();
    const before = heapBytes();
    for (let i = 0; i < 60; i++) run();
    expect(heapBytes()).toBe(before);
  });

  it('featureSolids returns bosses and holes in part-local millimetres, with the overshoot', () => {
    const { onA } = zPair(3, screw);
    const result = featureSolids(wasm, onA);
    try {
      expect(result.skipped).toEqual([]);
      const bossFeature = onA.find(feature => feature.kind === 'boss')!;
      expect(result.bosses).toHaveLength(1);
      expect(result.holes).toHaveLength(onA.length - 1);
      // The boss starts OVERSHOOT_MM inside the face it grows from.
      expect(result.bosses[0]!.volume()).toBeGreaterThan(cylinderVolume(bossFeature) * 0.98);
      expect(result.bosses[0]!.volume()).toBeLessThan((cylinderVolume(bossFeature) + Math.PI * (bossFeature.diameter * 500) ** 2 * OVERSHOOT_MM) * 1.01);
      // Every hole starts OVERSHOOT_MM outside its face. A blind hole (the insert hole) ends at its depth; a
      // through hole (the clearance hole, which goes through the boss) runs OVERSHOOT_MM past the far face.
      const holeFeatures = onA.filter(feature => feature.kind !== 'boss');
      const insertHole = holeFeatures.findIndex(feature => feature.kind === 'insert-hole');
      const throughHole = holeFeatures.findIndex(feature => feature.through);
      expect(throughHole).toBeGreaterThanOrEqual(0);
      const blind = result.holes[insertHole]!.boundingBox();
      const blindFeature = holeFeatures[insertHole]!;
      expect(blind.max[2]).toBeCloseTo(blindFeature.centre.z * 1000 + OVERSHOOT_MM, 3);
      expect(blind.min[2]).toBeCloseTo(blindFeature.centre.z * 1000 - blindFeature.depth * 1000, 3);
      const through = result.holes[throughHole]!.boundingBox();
      const throughFeature = holeFeatures[throughHole]!;
      expect(through.max[2]).toBeCloseTo(throughFeature.centre.z * 1000 + OVERSHOOT_MM, 3);
      expect(through.min[2]).toBeCloseTo(throughFeature.centre.z * 1000 - throughFeature.depth * 1000 - OVERSHOOT_MM, 3);
    } finally {
      [...result.bosses, ...result.holes].forEach(solid => solid.delete());
    }
  });

  it('featureSolids reports skipped and invalid features without building them', () => {
    const { onA } = zPair(10, screw);
    const [insert, tail] = onA;
    const result = featureSolids(wasm, [insert!, tail!, { ...tail!, id: 'bad', diameter: -1 }], { skip: new Set([insert!.id]) });
    try {
      expect(result.skipped).toEqual([{ featureId: insert!.id, reason: 'problem' }, { featureId: 'bad', reason: 'invalid' }]);
      expect(result.holes).toHaveLength(1);
      expect(result.bosses).toHaveLength(0);
    } finally {
      result.holes.forEach(solid => solid.delete());
    }
  });
});

describe('toBufferGeometry', () => {
  it('keeps millimetres and the indices, and computes normals', async () => {
    const { mesh } = await printablePart(part('box', 30, 20, 10), []);
    const geometry = toBufferGeometry(mesh);
    try {
      expect(geometry.getAttribute('position').count).toBe(mesh.positions.length / 3);
      expect(geometry.getIndex()!.count).toBe(mesh.indices.length);
      expect(geometry.getAttribute('normal').count).toBe(geometry.getAttribute('position').count);
      geometry.computeBoundingBox();
      expect(geometry.boundingBox!.getSize(new THREE.Vector3()).toArray().map(Math.round)).toEqual([30, 20, 10]);
    } finally {
      geometry.dispose();
    }
  });
});
