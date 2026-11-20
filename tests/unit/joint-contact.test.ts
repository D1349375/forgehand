import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { objectMatrix } from '../../shared/assembly';
import {
  JOIN_MESSAGES, alignTransform, contactRegion, facePolygon, facingPairs, initialSnapState, localFace, measurePair, planJoin,
  realignJoint, snapCandidates, snapStep, touching, worldFace, type PairMetrics, type SnapState, type WorldFace,
} from '../../shared/contact';
import {
  CENTRE_SNAP_MM, CONTACT_ANGLE_DEG, CONTACT_GAP_MM, DISC_SEGMENTS, MIN_CONTACT_MM2, SNAP_DISTANCE_MM, SNAP_PENETRATION_MM,
  SNAP_RELEASE_DEG, SNAP_RELEASE_MM, SNAP_SETTLE_MS,
} from '../../shared/joint-constants';
import { CONTACT_FACES, type FaceId } from '../../shared/joint';
import type { Part } from '../../shared/model';
import {
  WorkspaceError, addJoint, addObject, emptyWorkspace, findObject,
  type ObjectTransform, type Workspace, type WorkspaceErrorCode,
} from '../../shared/workspace';
import { buildModel } from '../../src/scene/geometry';
import { createPartGeometry } from '../../src/scene/geometry';
import {
  BOX, boxModel, demoPair, fixtureJoint, fixtureModel, fixtureObject, fixturePart, rotatedPair, side, twoBoxes,
} from '../fixtures/joint-workspace';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const mm = (value: number) => value / 1000;
const faceAt = (ws: Workspace, objectId: string, partId: string, face: FaceId, transform?: ObjectTransform): WorldFace => {
  const object = findObject(ws, objectId)!;
  const part = object.model.parts.find(candidate => candidate.id === partId)!;
  return worldFace(object, part, face, transform)!;
};
const codeOf = (action: () => unknown): WorkspaceErrorCode | 'no error' => {
  try { action(); } catch (error) {
    if (error instanceof WorkspaceError) return error.code;
    throw error;
  }
  return 'no error';
};
/** Area of a regular polygon with `DISC_SEGMENTS` corners on a circle, in mm squared. */
const polygonDiscMm2 = (radiusMm: number) => (DISC_SEGMENTS / 2) * Math.sin((2 * Math.PI) / DISC_SEGMENTS) * radiusMm ** 2;
const withTransform = (ws: Workspace, id: string, transform: ObjectTransform): Workspace =>
  ({ ...ws, objects: ws.objects.map(object => (object.id === id ? { ...object, transform } : object)) });

describe('localFace', () => {
  const dims = { x: 0.04, y: 0.06, z: 0.02 };
  const primitives: Part['primitive'][] = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'tube'];

  for (const primitive of primitives) {
    it(`${primitive}: contact faces match the display geometry; other faces are not contact faces`, () => {
      const part: Part = { ...fixturePart('p', primitive, dims), tubeRatio: 0.4 };
      const geometry = createPartGeometry(part);
      const positions = geometry.getAttribute('position');
      const box = geometry.boundingBox!;
      const faces: FaceId[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
      for (const face of faces) {
        const local = localFace(part, face);
        if (!(face in CONTACT_FACES[primitive])) {
          expect(local, face).toBeNull();
          continue;
        }
        expect(local, face).not.toBeNull();
        const { axis, sign } = local!;
        expect(local!.normal.getComponent(axis)).toBe(sign);
        const plane = local!.centre.getComponent(axis);
        // The face lies on the bounding box of the display geometry.
        expect(plane).toBeCloseTo(sign > 0 ? box.max.getComponent(axis) : box.min.getComponent(axis), 6);
        // Vertices on that plane give the face's in-plane extent.
        const radii: number[] = [];
        let maxU = 0;
        let maxV = 0;
        const uAxis = (axis + 1) % 3;
        const vAxis = (axis + 2) % 3;
        for (let at = 0; at < positions.count; at++) {
          if (Math.abs(positions.getComponent(at, axis) - plane) > 1e-6) continue;
          const u = positions.getComponent(at, uAxis);
          const v = positions.getComponent(at, vAxis);
          maxU = Math.max(maxU, Math.abs(u));
          maxV = Math.max(maxV, Math.abs(v));
          radii.push(Math.hypot(u / local!.half.u, v / local!.half.v));
        }
        expect(maxU).toBeCloseTo(local!.half.u, 6);
        expect(maxV).toBeCloseTo(local!.half.v, 6);
        // The centre vertex of a cap has radius 0; every other vertex of a disc is on the outline.
        if (local!.shape === 'disc') expect(Math.min(...radii.filter(radius => radius > 1e-6))).toBeCloseTo(1, 6);
        if (local!.shape === 'ring') {
          expect(local!.inner).toBe(0.4);
          expect(Math.max(...radii)).toBeCloseTo(1, 6);
          expect(Math.min(...radii)).toBeCloseTo(0.4, 6);
        } else {
          expect(local!.inner).toBeNull();
        }
      }
    });
  }

  it('names the in-plane axes (axis + 1) and (axis + 2)', () => {
    const face = localFace(fixturePart('p', 'box', dims), '-y')!;
    expect(face.u.toArray()).toEqual([0, 0, 1]);
    expect(face.v.toArray()).toEqual([1, 0, 0]);
    expect(face.half).toEqual({ u: 0.01, v: 0.02 });
    expect(face.centre.y).toBe(-0.03);
  });
});

describe('worldFace', () => {
  it('follows a rotated parent and a rotated object like the scene graph does', () => {
    const frame: Part = { ...fixturePart('frame', 'box', vec(0.1, 0.02, 0.02)), rotation: vec(0, 0, 90) };
    const plate: Part = { ...fixturePart('plate', 'box', vec(0.04, 0.02, 0.01), vec(0.03, 0, 0)), parentId: 'frame', rotation: vec(10, 20, 30) };
    const model = fixtureModel('Rig', [frame, plate]);
    const transform: ObjectTransform = { position: vec(0.2, -0.1, 0.3), rotation: vec(15, 40, -25) };
    const ws = addObject(emptyWorkspace(), fixtureObject('rig', model, transform));
    const root = buildModel(model, geometry => new THREE.Mesh(geometry));
    root.applyMatrix4(objectMatrix(transform));
    root.updateMatrixWorld(true);
    const world = root.getObjectByName('plate')!.matrixWorld;
    for (const face of ['+x', '-x', '+y', '-y', '+z', '-z'] as FaceId[]) {
      const local = localFace(plate, face)!;
      const got = faceAt(ws, 'rig', 'plate', face);
      expect(got.centre.distanceTo(local.centre.clone().applyMatrix4(world))).toBeLessThan(1e-9);
      expect(got.normal.distanceTo(local.normal.clone().transformDirection(world))).toBeLessThan(1e-9);
      expect(got.u.distanceTo(local.u.clone().transformDirection(world))).toBeLessThan(1e-9);
      expect(got.v.distanceTo(local.v.clone().transformDirection(world))).toBeLessThan(1e-9);
      expect(got.side).toEqual({ objectId: 'rig', partId: 'plate', face });
    }
  });

  it('uses a previewed transform instead of the object own', () => {
    const ws = twoBoxes();
    const preview = { position: vec(1, 2, 3), rotation: vec(0, 0, 0) };
    expect(faceAt(ws, 'b', 'body', '-x', preview).centre.toArray()).toEqual([1 - BOX.x / 2, 2, 3]);
    expect(faceAt(ws, 'b', 'body', '-x').centre.x).toBeCloseTo(BOX.x / 2, 12);
  });

  it('is null for a face that is not a contact face', () => {
    const model = fixtureModel('S', [fixturePart('s', 'sphere', vec(0.02, 0.02, 0.02))]);
    const object = fixtureObject('s', model, { position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
    expect(worldFace(object, model.parts[0]!, '+x')).toBeNull();
  });

  it('draws rectangles with 4 corners and discs and rings with DISC_SEGMENTS points', () => {
    const ws = twoBoxes();
    expect(facePolygon(faceAt(ws, 'a', 'body', '+x'))).toHaveLength(4);
    const model = fixtureModel('T', [{ ...fixturePart('t', 'tube', vec(0.04, 0.05, 0.04)), tubeRatio: 0.5 }, fixturePart('c', 'cylinder', vec(0.04, 0.05, 0.04))]);
    const both = addObject(emptyWorkspace(), fixtureObject('o', model, { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }));
    expect(facePolygon(faceAt(both, 'o', 't', '+y'))).toHaveLength(DISC_SEGMENTS);
    expect(facePolygon(faceAt(both, 'o', 'c', '-y'))).toHaveLength(DISC_SEGMENTS);
  });
});

describe('contactRegion', () => {
  it('gives the area of two offset rectangles', () => {
    // a's +x face is 20 (y) x 30 (z) mm; b is shifted by 5 mm in y and 10 mm in z.
    const ws = withTransform(twoBoxes(), 'b', { position: vec(BOX.x, mm(5), mm(10)), rotation: vec(0, 0, 0) });
    const region = contactRegion(faceAt(ws, 'a', 'body', '+x'), faceAt(ws, 'b', 'body', '-x'))!;
    expect(region.areaMm2).toBeCloseTo(15 * 20, 6);
    expect(region.polygon).toHaveLength(4);
    // The outline is counter-clockwise in a's frame.
    const xs = region.polygon.map(p => p.x);
    const ys = region.polygon.map(p => p.y);
    expect(Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)).toBeCloseTo(mm(15 + 20), 9);
  });

  it('is null when the faces do not overlap', () => {
    const ws = withTransform(twoBoxes(), 'b', { position: vec(BOX.x, mm(40), 0), rotation: vec(0, 0, 0) });
    expect(contactRegion(faceAt(ws, 'a', 'body', '+x'), faceAt(ws, 'b', 'body', '-x'))).toBeNull();
  });

  it('clips a disc on a rectangle', () => {
    const ws = addObject(addObject(emptyWorkspace(),
      fixtureObject('post', fixtureModel('Post', [fixturePart('post', 'cylinder', vec(0.04, 0.1, 0.04))]), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) })),
    fixtureObject('plate', fixtureModel('Plate', [fixturePart('plate', 'box', vec(0.1, 0.01, 0.1))]), { position: vec(0, 0.055, 0), rotation: vec(0, 0, 0) }));
    const region = contactRegion(faceAt(ws, 'post', 'post', '+y'), faceAt(ws, 'plate', 'plate', '-y'))!;
    expect(region.areaMm2).toBeCloseTo(polygonDiscMm2(20), 6);
    // Half of the disc hangs over the edge of a smaller plate.
    const edge = addObject(addObject(emptyWorkspace(),
      fixtureObject('post', fixtureModel('Post', [fixturePart('post', 'cylinder', vec(0.04, 0.1, 0.04))]), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) })),
    fixtureObject('plate', fixtureModel('Plate', [fixturePart('plate', 'box', vec(0.1, 0.01, 0.1))]), { position: vec(0.05, 0.055, 0), rotation: vec(0, 0, 0) }));
    const half = contactRegion(faceAt(edge, 'post', 'post', '+y'), faceAt(edge, 'plate', 'plate', '-y'))!;
    expect(half.areaMm2).toBeCloseTo(polygonDiscMm2(20) / 2, 6);
  });

  it('takes the hole out of a ring', () => {
    const tube: Part = { ...fixturePart('tube', 'tube', vec(0.04, 0.05, 0.04)), tubeRatio: 0.5 };
    const ws = addObject(addObject(emptyWorkspace(),
      fixtureObject('tube', fixtureModel('Tube', [tube]), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) })),
    fixtureObject('plate', fixtureModel('Plate', [fixturePart('plate', 'box', vec(0.1, 0.01, 0.1))]), { position: vec(0, 0.03, 0), rotation: vec(0, 0, 0) }));
    const region = contactRegion(faceAt(ws, 'tube', 'tube', '+y'), faceAt(ws, 'plate', 'plate', '-y'))!;
    expect(region.areaMm2).toBeCloseTo(polygonDiscMm2(20) - polygonDiscMm2(10), 6);
    // A plate that only covers the hole has no contact.
    const small = addObject(addObject(emptyWorkspace(),
      fixtureObject('tube', fixtureModel('Tube', [tube]), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) })),
    fixtureObject('plate', fixtureModel('Plate', [fixturePart('plate', 'box', vec(0.01, 0.01, 0.01))]), { position: vec(0, 0.03, 0), rotation: vec(0, 0, 0) }));
    expect(contactRegion(faceAt(small, 'tube', 'tube', '+y'), faceAt(small, 'plate', 'plate', '-y'))).toBeNull();
    // Two equal rings on top of each other overlap in the ring area.
    const rings = addObject(addObject(emptyWorkspace(),
      fixtureObject('r1', fixtureModel('R1', [tube]), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) })),
    fixtureObject('r2', fixtureModel('R2', [tube]), { position: vec(0, 0.05, 0), rotation: vec(0, 0, 0) }));
    expect(contactRegion(faceAt(rings, 'r1', 'tube', '+y'), faceAt(rings, 'r2', 'tube', '-y'))!.areaMm2)
      .toBeCloseTo(polygonDiscMm2(20) - polygonDiscMm2(10), 6);
  });
});

describe('touching', () => {
  const pose = (x: number, y: number, z: number, rz = 0): ObjectTransform => ({ position: vec(x, y, z), rotation: vec(0, 0, rz) });
  const check = (transform: ObjectTransform) => {
    const ws = twoBoxes();
    return touching(faceAt(ws, 'a', 'body', '+x'), faceAt(ws, 'b', 'body', '-x', transform));
  };

  it('holds for the fixture pair', () => {
    const result = check(pose(BOX.x, 0, 0));
    expect(result.ok).toBe(true);
    expect(result.gapMm).toBeCloseTo(0, 9);
    expect(result.angleDeg).toBeCloseTo(0, 6);
    expect(result.region!.areaMm2).toBeCloseTo(600, 6);
  });

  it('allows a gap of CONTACT_GAP_MM in either direction and no more', () => {
    for (const sign of [1, -1]) {
      const inside = check(pose(BOX.x + sign * mm(CONTACT_GAP_MM * 0.99), 0, 0));
      expect(inside.ok).toBe(true);
      expect(inside.gapMm).toBeCloseTo(sign * CONTACT_GAP_MM * 0.99, 6);
      expect(check(pose(BOX.x + sign * mm(CONTACT_GAP_MM * 1.05), 0, 0)).ok).toBe(false);
    }
  });

  it('allows an angle of CONTACT_ANGLE_DEG and no more', () => {
    expect(check(pose(BOX.x, 0, 0, CONTACT_ANGLE_DEG * 0.9)).ok).toBe(true);
    const over = check(pose(BOX.x, 0, 0, CONTACT_ANGLE_DEG * 1.1));
    expect(over.ok).toBe(false);
    expect(over.angleDeg).toBeCloseTo(1.1, 6);
  });

  it('needs MIN_CONTACT_MM2 of overlap', () => {
    // The face is 20 mm wide, so an overlap of 20 mm^2 is 1 mm of the 30 mm length.
    const enough = check(pose(BOX.x, 0, mm(30 - MIN_CONTACT_MM2 / 20 - 0.01)));
    expect(enough.ok).toBe(true);
    const short = check(pose(BOX.x, 0, mm(30 - MIN_CONTACT_MM2 / 20 + 0.01)));
    expect(short.ok).toBe(false);
    expect(short.region!.areaMm2).toBeLessThan(MIN_CONTACT_MM2);
    expect(check(pose(BOX.x, 0, 0.1)).region).toBeNull();
  });

  it('is false for faces that look the same way', () => {
    const ws = twoBoxes();
    expect(touching(faceAt(ws, 'a', 'body', '+x'), faceAt(ws, 'b', 'body', '+x')).ok).toBe(false);
  });
});

describe('facingPairs', () => {
  it('ranks the demo pair: battery +x of a against housing -x of b first', () => {
    const ws = demoPair();
    const pairs = facingPairs(ws, { objectId: 'demo-a' }, { objectId: 'demo-b' });
    expect(pairs.length).toBeGreaterThan(1);
    expect(pairs[0]!.a).toEqual(side('demo-a', 'battery', '+x'));
    expect(pairs[0]!.b).toEqual(side('demo-b', 'housing', '-x'));
    expect(pairs[0]!.gapMm).toBeCloseTo(20, 4);
    expect(pairs[0]!.key).toBe('demo-a:battery:+x|demo-b:housing:-x');
    // Sorted by gap, then angle.
    for (let at = 1; at < pairs.length; at++) expect(Math.abs(pairs[at]!.gapMm)).toBeGreaterThanOrEqual(Math.abs(pairs[at - 1]!.gapMm) - 1e-6);
    // The bought component (the board) is not offered unless named.
    expect(pairs.some(pair => pair.a.partId === 'board' || pair.b.partId === 'board')).toBe(false);
    expect(facingPairs(ws, { objectId: 'demo-a', partId: 'board' }, { objectId: 'demo-b', partId: 'housing' }).length).toBeGreaterThan(0);
  });

  it('needs each face in front of the other', () => {
    // b on the left of a: a's -x face meets b's +x face, a's +x face does not face b's -x face.
    const ws = withTransform(twoBoxes(), 'b', { position: vec(-0.2, 0, 0), rotation: vec(0, 0, 0) });
    const pairs = facingPairs(ws, { objectId: 'a' }, { objectId: 'b' });
    expect(pairs.map(pair => pair.key)).toEqual(['a:body:-x|b:body:+x']);
    expect(pairs[0]!.gapMm).toBeCloseTo(160, 4);
  });

  it('allows b to sink up to SNAP_PENETRATION_MM into a', () => {
    const at = (depth: number) => facingPairs(withTransform(twoBoxes(), 'b', { position: vec(BOX.x - mm(depth), 0, 0), rotation: vec(0, 0, 0) }),
      { objectId: 'a' }, { objectId: 'b' }).some(pair => pair.a.face === '+x' && pair.b.face === '-x');
    expect(at(SNAP_PENETRATION_MM - 0.1)).toBe(true);
    expect(at(SNAP_PENETRATION_MM + 0.1)).toBe(false);
  });

  it('needs MIN_CONTACT_MM2 of overlap and normals within the snap angle', () => {
    const shifted = withTransform(twoBoxes(), 'b', { position: vec(BOX.x + 0.01, 0, 0.2), rotation: vec(0, 0, 0) });
    expect(facingPairs(shifted, { objectId: 'a' }, { objectId: 'b' })).toEqual([]);
    const turned = withTransform(twoBoxes(), 'b', { position: vec(BOX.x + 0.01, 0, 0), rotation: vec(0, 0, 20) });
    expect(facingPairs(turned, { objectId: 'a' }, { objectId: 'b' }).some(pair => pair.a.face === '+x' && pair.b.face === '-x')).toBe(false);
  });

  it('does not pair a part with itself', () => {
    const ws = twoBoxes();
    expect(facingPairs(ws, { objectId: 'a' }, { objectId: 'a' })).toEqual([]);
  });
});

describe('snapCandidates', () => {
  const demoAt = (gapMm: number) => {
    const ws = demoPair();
    // a's battery +x face is at 0.1165 m; b's housing -x face is 0.08 m left of its origin.
    const x = 0.1165 + mm(gapMm) + 0.08;
    return { ws, poses: new Map<string, ObjectTransform>([['demo-b', { position: vec(x, 0, 0), rotation: vec(0, 0, 0) }]]) };
  };

  it('finds the pair inside the engage limits', () => {
    for (const gap of [5, SNAP_DISTANCE_MM - 0.1, -(SNAP_PENETRATION_MM - 0.1)]) {
      const { ws, poses } = demoAt(gap);
      const best = snapCandidates(ws, 'demo-a', 'demo-b', poses)!;
      expect(best.key, `gap ${gap}`).toBe('demo-a:battery:+x|demo-b:housing:-x');
      expect(best.gapMm).toBeCloseTo(gap, 4);
    }
  });

  it('finds nothing outside the engage limits', () => {
    for (const gap of [SNAP_DISTANCE_MM + 0.5, -(SNAP_PENETRATION_MM + 0.5)]) {
      const { ws, poses } = demoAt(gap);
      const best = snapCandidates(ws, 'demo-a', 'demo-b', poses);
      expect(best?.key, `gap ${gap}`).not.toBe('demo-a:battery:+x|demo-b:housing:-x');
    }
    const { ws, poses } = demoAt(30);
    expect(snapCandidates(ws, 'demo-a', 'demo-b', poses)).toBeNull();
  });

  it('prefers the smaller gap, then the smaller angle, then the larger overlap', () => {
    // Two parts of b face a's +x face: p1 is 2 mm away, p2 is 1 mm away.
    const model = (parts: Part[]) => fixtureModel('B', parts);
    const a = fixtureObject('a', boxModel('A'), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
    const closer = fixtureObject('b', model([
      fixturePart('p1', 'box', vec(0.01, 0.02, 0.01), vec(mm(2), 0, mm(-7.5))),
      fixturePart('p2', 'box', vec(0.01, 0.02, 0.01), vec(mm(1), 0, mm(7.5))),
    ]), { position: vec(0.03, 0, 0), rotation: vec(0, 0, 0) });
    const ws = addObject(addObject(emptyWorkspace(), a), closer);
    expect(snapCandidates(ws, 'a', 'b', new Map())!.b.partId).toBe('p2');
    // Equal gap and angle: the larger overlap wins.
    const sized = fixtureObject('b', model([
      fixturePart('p1', 'box', vec(0.01, 0.02, 0.01), vec(0, 0, mm(-8))),
      fixturePart('p2', 'box', vec(0.01, 0.02, 0.02), vec(0, 0, mm(5))),
    ]), { position: vec(0.025, 0, 0), rotation: vec(0, 0, 0) });
    expect(snapCandidates(addObject(addObject(emptyWorkspace(), a), sized), 'a', 'b', new Map())!.b.partId).toBe('p2');
  });

  it('breaks an exact tie by the key, whatever the part order', () => {
    const a = fixtureObject('a', boxModel('A'), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
    const parts = [
      fixturePart('p1', 'box', vec(0.01, 0.02, 0.01), vec(0, 0, mm(-7.5))),
      fixturePart('p2', 'box', vec(0.01, 0.02, 0.01), vec(0, 0, mm(7.5))),
    ];
    for (const order of [parts, [...parts].reverse()]) {
      const b = fixtureObject('b', fixtureModel('B', order), { position: vec(0.025, 0, 0), rotation: vec(0, 0, 0) });
      const best = snapCandidates(addObject(addObject(emptyWorkspace(), a), b), 'a', 'b', new Map())!;
      expect(best.key).toBe('a:body:+x|b:p1:-x');
    }
  });

  it('is null for one object', () => {
    expect(snapCandidates(twoBoxes(), 'a', 'a', new Map())).toBeNull();
  });
});

describe('measurePair', () => {
  it('measures a named pair without limits', () => {
    const ws = demoPair();
    const m = measurePair(ws, side('demo-a', 'housing', '+x'), side('demo-b', 'housing', '-x'))!;
    expect(m.gapMm).toBeCloseTo(56.5, 3);
    expect(m.angleDeg).toBeCloseTo(0, 6);
    expect(m.overlapMm2).toBeCloseTo(90 * 70, 3);
  });

  it('is null for a side that does not exist or is not a contact face', () => {
    const ws = twoBoxes();
    expect(measurePair(ws, side('a', 'nope', '+x'), side('b', 'body', '-x'))).toBeNull();
    expect(measurePair(ws, side('ghost', 'body', '+x'), side('b', 'body', '-x'))).toBeNull();
  });
});

describe('alignTransform', () => {
  const tilted = (degrees: number, dx: number, dy: number, dz: number): { ws: Workspace; poses: Map<string, ObjectTransform> } => ({
    ws: twoBoxes(),
    poses: new Map([['b', { position: vec(BOX.x + mm(dx), mm(dy), mm(dz)), rotation: vec(0, 0, degrees) }]]),
  });
  const applied = (ws: Workspace, aligned: ObjectTransform) => withTransform(ws, 'b', aligned);
  const a = side('a', 'body', '+x');
  const b = side('b', 'body', '-x');

  it('turns a pair that is 10 degrees off into a touching pair', () => {
    const { ws, poses } = tilted(10, 4, 1.5, 2);
    const aligned = alignTransform(ws, a, b, poses)!;
    expect(aligned).not.toBeNull();
    const next = applied(ws, aligned);
    const fa = faceAt(next, 'a', 'body', '+x');
    const fb = faceAt(next, 'b', 'body', '-x');
    // Normals opposite after rounding to 0.01 degrees.
    expect(fa.normal.angleTo(fb.normal.clone().negate()) * (180 / Math.PI)).toBeLessThan(0.02);
    const result = touching(fa, fb);
    expect(result.ok).toBe(true);
    expect(Math.abs(result.gapMm)).toBeLessThan(0.02);
    // Rounded like other transforms.
    expect(aligned.position.x).toBe(Math.round(aligned.position.x * 1e5) / 1e5);
    expect(aligned.rotation.z).toBe(Math.round(aligned.rotation.z * 100) / 100);
    // Side a is not part of the result and the workspace is untouched.
    expect(ws.objects).toEqual(twoBoxes().objects);
  });

  it('centres the faces below CENTRE_SNAP_MM and leaves bigger offsets alone', () => {
    const near = tilted(0, 4, CENTRE_SNAP_MM * 0.7, 0);
    const centred = alignTransform(near.ws, a, b, near.poses)!;
    expect(centred.position.y).toBeCloseTo(0, 4);
    expect(centred.position.z).toBeCloseTo(0, 4);
    expect(centred.position.x).toBeCloseTo(BOX.x, 4);
    const far = tilted(0, 4, CENTRE_SNAP_MM * 1.3, 0);
    const kept = alignTransform(far.ws, a, b, far.poses)!;
    expect(kept.position.y).toBeCloseTo(mm(CENTRE_SNAP_MM * 1.3), 4);
    expect(kept.position.x).toBeCloseTo(BOX.x, 4);
  });

  it('works for rotated objects and parents, and the result still touches after rounding', () => {
    const frame: Part = { ...fixturePart('frame', 'box', vec(0.02, 0.02, 0.02)), rotation: vec(0, 0, 7) };
    const body: Part = { ...fixturePart('body', 'box', vec(0.04, 0.02, 0.03), vec(0.01, 0.005, 0)), parentId: 'frame', rotation: vec(0, 3, 0) };
    const base = twoBoxes();
    const ws = addObject({ ...base, objects: [base.objects[0]!], activeObjectId: 'a' }, fixtureObject('r', fixtureModel('Rig', [frame, body]), { position: vec(0.2, 0.1, 0.1), rotation: vec(10, 20, 30) }));
    const aTransform: ObjectTransform = { position: vec(0.5, 0.2, -0.1), rotation: vec(0, 25, 5) };
    const moved = withTransform(ws, 'a', aTransform);
    // The faces may be a little off 180 degrees but are within the snap angle: check that it turns it.
    const pa = faceAt(moved, 'a', 'body', '+x');
    const pr = faceAt(moved, 'r', 'body', '-x');
    expect(pa.normal.angleTo(pr.normal.clone().negate()) * (180 / Math.PI)).toBeGreaterThan(0);
    const result = alignTransform(moved, side('a', 'body', '+x'), side('r', 'body', '-x'));
    // Too far apart in angle for these poses is acceptable only when the angle exceeds the limit.
    if (!result) {
      expect(pa.normal.angleTo(pr.normal.clone().negate()) * (180 / Math.PI)).toBeGreaterThan(15);
      return;
    }
    const next = withTransform(moved, 'r', result);
    expect(touching(faceAt(next, 'a', 'body', '+x'), faceAt(next, 'r', 'body', '-x')).ok).toBe(true);
  });

  it('is null when the angle is over SNAP_ANGLE_DEG or both sides are one object', () => {
    const over = tilted(20, 4, 0, 0);
    expect(alignTransform(over.ws, a, b, over.poses)).toBeNull();
    const ok = tilted(14, 4, 0, 0);
    expect(alignTransform(ok.ws, a, b, ok.poses)).not.toBeNull();
    expect(alignTransform(twoBoxes(), a, side('a', 'body', '-x'))).toBeNull();
  });

  it('is null when the result leaves the transform limits', () => {
    const ws = withTransform(twoBoxes(), 'a', { position: vec(99.99, 0, 0), rotation: vec(0, 0, 0) });
    expect(alignTransform(ws, a, b, new Map([['b', { position: vec(99.99 + BOX.x + 0.1, 0, 0), rotation: vec(0, 0, 0) }]]))).toBeNull();
  });

  it('keeps touching pairs where they are (up to rounding)', () => {
    const ws = twoBoxes();
    const same = alignTransform(ws, a, b)!;
    expect(same.position.x).toBeCloseTo(BOX.x, 5);
    expect(same.rotation).toEqual(vec(0, 0, 0));
  });
});

describe('snapStep', () => {
  const metrics = (key: string, gapMm = 2, angleDeg = 3): PairMetrics => ({
    a: side('a', 'body', '+x'), b: side('b', 'body', '-x'), gapMm, angleDeg, overlapMm2: 100, key,
  });
  const ready = (key = 'k1'): SnapState => ({ key, since: 0, ready: true, rival: null });

  it('settles after SNAP_SETTLE_MS on the same pair', () => {
    let state = snapStep(initialSnapState, metrics('k1'), null, 1000);
    expect(state).toEqual({ key: 'k1', since: 1000, ready: false, rival: null });
    state = snapStep(state, metrics('k1'), null, 1000 + SNAP_SETTLE_MS - 1);
    expect(state.ready).toBe(false);
    state = snapStep(state, metrics('k1'), null, 1000 + SNAP_SETTLE_MS);
    expect(state.ready).toBe(true);
    expect(state.key).toBe('k1');
  });

  it('restarts on another pair and resets without a candidate', () => {
    const state = snapStep(initialSnapState, metrics('k1'), null, 0);
    expect(snapStep(state, metrics('k2'), null, 100)).toEqual({ key: 'k2', since: 100, ready: false, rival: null });
    expect(snapStep(state, null, null, 100)).toBe(initialSnapState);
  });

  it('releases by gap, by angle and when the held pair is missing', () => {
    expect(snapStep(ready(), metrics('k1'), metrics('k1', SNAP_RELEASE_MM - 1), 500).ready).toBe(true);
    expect(snapStep(ready(), metrics('k1'), metrics('k1', SNAP_RELEASE_MM + 1), 500).ready).toBe(false);
    expect(snapStep(ready(), metrics('k1'), metrics('k1', 2, SNAP_RELEASE_DEG - 1), 500).ready).toBe(true);
    expect(snapStep(ready(), metrics('k1'), metrics('k1', 2, SNAP_RELEASE_DEG + 1), 500).ready).toBe(false);
    expect(snapStep(ready(), metrics('k1'), null, 500).ready).toBe(false);
    // The released state starts over with the best candidate, or with nothing.
    expect(snapStep(ready(), null, null, 500)).toBe(initialSnapState);
    expect(snapStep(ready(), metrics('k2'), null, 500)).toEqual({ key: 'k2', since: 500, ready: false, rival: null });
  });

  it('lets a rival take over after SNAP_SETTLE_MS, and forgets a rival that goes away', () => {
    let state = snapStep(ready(), metrics('k2'), metrics('k1'), 1000);
    expect(state).toEqual({ key: 'k1', since: 0, ready: true, rival: { key: 'k2', since: 1000 } });
    state = snapStep(state, metrics('k2'), metrics('k1'), 1000 + SNAP_SETTLE_MS - 1);
    expect(state.key).toBe('k1');
    const gone = snapStep(state, metrics('k1'), metrics('k1'), 1100);
    expect(gone.rival).toBeNull();
    const swapped = snapStep(state, metrics('k2'), metrics('k1'), 1000 + SNAP_SETTLE_MS);
    expect(swapped).toEqual({ key: 'k2', since: 1000 + SNAP_SETTLE_MS, ready: true, rival: null });
    // A different rival restarts the timer.
    expect(snapStep(state, metrics('k3'), metrics('k1'), 1100).rival).toEqual({ key: 'k3', since: 1100 });
  });
});

describe('planJoin', () => {
  const apart = () => withTransform(twoBoxes(), 'b', { position: vec(BOX.x + 0.02, mm(2), mm(1)), rotation: vec(0, 0, 0) });

  it('uses the given faces and aligns side b', () => {
    const ws = apart();
    const plan = planJoin(ws, { objectId: 'a', partId: 'body', face: '+x' }, { objectId: 'b', partId: 'body', face: '-x' });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.a).toEqual(side('a', 'body', '+x'));
    expect(plan.b).toEqual(side('b', 'body', '-x'));
    expect(plan.move!.objectId).toBe('b');
    expect(plan.pairs).toHaveLength(1);
    const next = withTransform(ws, 'b', plan.move!.transform);
    expect(touching(faceAt(next, 'a', 'body', '+x'), faceAt(next, 'b', 'body', '-x')).ok).toBe(true);
  });

  it('ranks the facing pairs and lets pairIndex pick another', () => {
    const ws = demoPair();
    const first = planJoin(ws, { objectId: 'demo-a' }, { objectId: 'demo-b' });
    if (!first.ok) throw new Error(first.message);
    expect(first.a).toEqual(side('demo-a', 'battery', '+x'));
    expect(first.b).toEqual(side('demo-b', 'housing', '-x'));
    expect(first.pairs.length).toBeGreaterThan(1);
    const second = planJoin(ws, { objectId: 'demo-a' }, { objectId: 'demo-b' }, 1);
    if (!second.ok) throw new Error(second.message);
    expect(second.pairs[1]).toEqual(first.pairs[1]);
    expect(`${second.a.partId}${second.a.face}${second.b.partId}${second.b.face}`).not.toBe(`${first.a.partId}${first.a.face}${first.b.partId}${first.b.face}`);
    expect(planJoin(ws, { objectId: 'demo-a' }, { objectId: 'demo-b' }, 999)).toMatchObject({ ok: false, code: 'NO_CONTACT_FACE' });
    // A face filter keeps only matching pairs.
    const filtered = planJoin(ws, { objectId: 'demo-a', face: '+x' }, { objectId: 'demo-b', partId: 'housing', face: '-x' });
    if (!filtered.ok) throw new Error(filtered.message);
    expect(filtered.pairs.every(pair => pair.a.face === '+x' && pair.b.face === '-x' && pair.b.partId === 'housing')).toBe(true);
  });

  it('moves nothing when the faces already touch', () => {
    const plan = planJoin(twoBoxes(), { objectId: 'a', partId: 'body', face: '+x' }, { objectId: 'b', partId: 'body', face: '-x' });
    expect(plan).toMatchObject({ ok: true, move: null });
  });

  it('needs touching faces inside one object and inside one assembly, and moves nothing', () => {
    const model = fixtureModel('Two', [fixturePart('p1', 'box', vec(0.02, 0.02, 0.02), vec(-0.01, 0, 0)), fixturePart('p2', 'box', vec(0.02, 0.02, 0.02), vec(0.01, 0, 0))]);
    const ws = addObject(emptyWorkspace(), fixtureObject('o', model, { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }));
    const plan = planJoin(ws, { objectId: 'o', partId: 'p1' }, { objectId: 'o', partId: 'p2' });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.move).toBeNull();
    expect(plan.a).toEqual(side('o', 'p1', '+x'));
    expect(plan.b).toEqual(side('o', 'p2', '-x'));
    expect(planJoin(ws, { objectId: 'o', partId: 'p1', face: '+y' }, { objectId: 'o', partId: 'p2', face: '+y' })).toMatchObject({ ok: false, code: 'NOT_TOUCHING' });
    expect(planJoin(ws, { objectId: 'o', partId: 'p1', face: '+x' }, { objectId: 'o', partId: 'p1', face: '-x' })).toMatchObject({ ok: false, code: 'NO_CONTACT_FACE' });

    const joined = twoBoxes({ joint: true });
    expect(planJoin(joined, { objectId: 'a', partId: 'body', face: '+y' }, { objectId: 'b', partId: 'body', face: '-y' })).toMatchObject({ ok: false, code: 'NOT_TOUCHING', message: JOIN_MESSAGES.NOT_TOUCHING });
    expect(planJoin(joined, { objectId: 'a' }, { objectId: 'b' })).toMatchObject({ ok: true, move: null });
    // Facing but not touching, and no faces named: NOT_TOUCHING too.
    const moved = withTransform(joined, 'b', { position: vec(BOX.x + 0.01, 0, 0), rotation: vec(0, 0, 0) });
    expect(planJoin(moved, { objectId: 'a' }, { objectId: 'b' })).toMatchObject({ ok: false, code: 'NOT_TOUCHING' });
  });

  it('fails with CANNOT_ALIGN when the faces are too far from parallel', () => {
    const ws = withTransform(twoBoxes(), 'b', { position: vec(BOX.x + 0.02, 0, 0), rotation: vec(0, 0, 40) });
    expect(planJoin(ws, { objectId: 'a', partId: 'body', face: '+x' }, { objectId: 'b', partId: 'body', face: '-x' }))
      .toEqual({ ok: false, code: 'CANNOT_ALIGN', message: JOIN_MESSAGES.CANNOT_ALIGN });
  });

  it('fails with NO_CONTACT_FACE for parts without flat faces and for faces that overlap nothing', () => {
    const ball = fixtureObject('ball', fixtureModel('Ball', [fixturePart('s', 'sphere', vec(0.02, 0.02, 0.02))]), { position: vec(0.1, 0, 0), rotation: vec(0, 0, 0) });
    const ws = addObject(twoBoxes(), ball);
    expect(planJoin(ws, { objectId: 'a' }, { objectId: 'ball' })).toEqual({ ok: false, code: 'NO_CONTACT_FACE', message: JOIN_MESSAGES.NO_CONTACT_FACE });
    expect(planJoin(ws, { objectId: 'a', partId: 'body', face: '+x' }, { objectId: 'ball', partId: 's', face: '-x' })).toMatchObject({ code: 'NO_CONTACT_FACE' });
    const far = withTransform(twoBoxes(), 'b', { position: vec(BOX.x + 0.02, 0.1, 0), rotation: vec(0, 0, 0) });
    expect(planJoin(far, { objectId: 'a', partId: 'body', face: '+x' }, { objectId: 'b', partId: 'body', face: '-x' })).toMatchObject({ code: 'NO_CONTACT_FACE' });
  });

  it('throws UNKNOWN_OBJECT for an object that does not exist', () => {
    expect(codeOf(() => planJoin(twoBoxes(), { objectId: 'a' }, { objectId: 'ghost' }))).toBe('UNKNOWN_OBJECT');
  });
});

describe('realignJoint', () => {
  const jointed = () => twoBoxes({ joint: true });
  const unlinked = (ws: Workspace, transform: ObjectTransform) => withTransform(ws, 'b', transform);

  it('moves side b back against side a and leaves side a alone', () => {
    const ws = unlinked(jointed(), { position: vec(BOX.x + 0.01, mm(3), mm(2)), rotation: vec(0, 0, 8) });
    const next = realignJoint(ws, 'joint-1');
    expect(next.objects[0]).toBe(ws.objects[0]);
    expect(touching(faceAt(next, 'a', 'body', '+x'), faceAt(next, 'b', 'body', '-x')).ok).toBe(true);
    expect(ws.objects[1]!.transform.position.x).toBe(BOX.x + 0.01);
  });

  it('returns the same workspace when the faces already touch', () => {
    const ws = jointed();
    expect(realignJoint(ws, 'joint-1')).toBe(ws);
  });

  it('moves everything that stays connected to side b', () => {
    const base = unlinked(jointed(), { position: vec(BOX.x + 0.01, 0, 0), rotation: vec(0, 0, 0) });
    const withC = addObject(base, fixtureObject('c', boxModel('Block C'), { position: vec(BOX.x + 0.01 + BOX.x, 0, 0), rotation: vec(0, 0, 0) }));
    const ws = addJoint(withC, fixtureJoint(side('b', 'body', '+x'), side('c', 'body', '-x'), { id: 'joint-2' }));
    const next = realignJoint(ws, 'joint-1');
    expect(findObject(next, 'b')!.transform.position.x).toBeCloseTo(BOX.x, 5);
    expect(findObject(next, 'c')!.transform.position.x).toBeCloseTo(2 * BOX.x, 5);
    expect(next.objects[0]).toBe(ws.objects[0]);
  });

  it('fails with LINKED when side a is connected to side b another way', () => {
    const base = unlinked(jointed(), { position: vec(BOX.x + 0.01, 0, 0), rotation: vec(0, 0, 0) });
    const withC = addObject(base, fixtureObject('c', boxModel('Block C'), { position: vec(0, 0.1, 0), rotation: vec(0, 0, 0) }));
    const linked = addJoint(addJoint(withC, fixtureJoint(side('b', 'body', '+y'), side('c', 'body', '-y'), { id: 'joint-2' })),
      fixtureJoint(side('c', 'body', '+x'), side('a', 'body', '-x'), { id: 'joint-3' }));
    expect(codeOf(() => realignJoint(linked, 'joint-1'))).toBe('LINKED');
  });

  it('fails with CANNOT_ALIGN for a joint turned too far', () => {
    const ws = unlinked(jointed(), { position: vec(BOX.x, 0, 0), rotation: vec(0, 0, 30) });
    expect(codeOf(() => realignJoint(ws, 'joint-1'))).toBe('CANNOT_ALIGN');
  });

  it('fails with UNKNOWN_JOINT, and with LINKED for a joint inside one object', () => {
    expect(codeOf(() => realignJoint(jointed(), 'nope'))).toBe('UNKNOWN_JOINT');
    const model = fixtureModel('Two', [fixturePart('p1', 'box', vec(0.02, 0.02, 0.02), vec(-0.01, 0, 0)), fixturePart('p2', 'box', vec(0.02, 0.02, 0.02), vec(0.01, 0, 0))]);
    const ws = addJoint(addObject(emptyWorkspace(), fixtureObject('o', model, { position: vec(0, 0, 0), rotation: vec(0, 0, 0) })),
      fixtureJoint(side('o', 'p1', '+x'), side('o', 'p2', '-x')));
    expect(codeOf(() => realignJoint(ws, 'joint-1'))).toBe('LINKED');
  });

  it('works for a rotated pair', () => {
    const base = rotatedPair({ joint: true });
    const ws = unlinked(base, { ...base.objects[1]!.transform, position: { ...base.objects[1]!.transform.position, y: base.objects[1]!.transform.position.y + 0.004 } });
    const next = realignJoint(ws, 'joint-1');
    expect(touching(faceAt(next, 'a', 'body', '+x'), faceAt(next, 'b', 'body', '-x')).ok).toBe(true);
  });
});

describe('worst-case timing (design 4.3)', () => {
  /** A square grid of 64 box parts of 20 mm. */
  const grid = (id: string, transform: ObjectTransform) => fixtureObject(id, fixtureModel(id, Array.from({ length: 64 }, (_, at) =>
    fixturePart(`${id}${at}`, 'box', vec(0.02, 0.02, 0.02), vec((at % 8) * 0.02, Math.floor(at / 8) * 0.02, 0)))), transform);
  const ws = addObject(addObject(emptyWorkspace(), grid('a', { position: vec(0, 0, 0), rotation: vec(0, 0, 0) })),
    grid('b', { position: vec(0.01, 0.01, 0.0205), rotation: vec(0, 0, 0) }));
  const poses = new Map<string, ObjectTransform>();

  it('runs facingPairs and snapCandidates for two 64-part objects under 25 ms each', () => {
    // The best of several runs: a busy machine slows single runs, a regression slows all of them.
    const best = (run: () => unknown) => {
      run();
      return Math.min(...Array.from({ length: 7 }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
      }));
    };
    const pairs = facingPairs(ws, { objectId: 'a' }, { objectId: 'b' });
    expect(pairs.length).toBeGreaterThan(64);
    expect(snapCandidates(ws, 'a', 'b', poses)).not.toBeNull();
    expect(best(() => facingPairs(ws, { objectId: 'a' }, { objectId: 'b' }))).toBeLessThan(25);
    expect(best(() => snapCandidates(ws, 'a', 'b', poses))).toBeLessThan(25);
  });
});
