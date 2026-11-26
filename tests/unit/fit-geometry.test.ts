import * as THREE from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import { ellipseRadius } from '../../shared/ellipse';
import { FIT_ANGLES, FIT_SLICES, PROFILE_REACH_MM } from '../../shared/fit-constants';
import {
  PRIMITIVE_INSIDE, axisBlocked, faceDirection, innerProfile, modelParts, ringCandidates, ringFrame, wornParts,
} from '../../shared/fit-geometry';
import type { Part } from '../../shared/model';
import { createPartGeometry } from '../../src/scene/geometry';
import {
  bandWithCase, caseWithBand, fixtureModel, fixturePart, noRing, openCuff, ringWithBar, torusBand, torusRingPart, tubeBand, tubeRingPart,
} from '../fixtures/fit-bracelet';
import { checkProperty, fc, printPropertyReport } from '../fixtures/fit-property';
import { fixtureJoint, fixtureObject, rotatedPair, side } from '../fixtures/joint-workspace';
import { addJoint, addObject, emptyWorkspace } from '../../shared/workspace';

afterAll(() => printPropertyReport('fit-geometry'));

const near = (actual: THREE.Vector3, expected: [number, number, number], digits = 6) => {
  expect(actual.x).toBeCloseTo(expected[0], digits);
  expect(actual.y).toBeCloseTo(expected[1], digits);
  expect(actual.z).toBeCloseTo(expected[2], digits);
};

describe('primitive inside tests against the meshes (design 6.4)', () => {
  const primitives: Part['primitive'][] = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'tube'];
  const size = fc.double({ min: 0.01, max: 0.08, noNaN: true });
  const fraction = fc.double({ min: -0.6, max: 0.6, noNaN: true });
  const direction = fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }))
    .filter(([x, y, z]) => Math.hypot(x, y, z) > 0.2);

  /** Number of triangles of the mesh that a ray from `origin` crosses; odd means the origin is inside. */
  const crossings = (mesh: THREE.Mesh, origin: THREE.Vector3, dir: THREE.Vector3) => {
    const raycaster = new THREE.Raycaster(origin, dir.clone().normalize());
    return raycaster.intersectObject(mesh, false).length;
  };

  for (const primitive of primitives) {
    it(`${primitive}: agrees with ray-mesh parity away from the surface`, () => {
      checkProperty(`inside test of ${primitive} agrees with mesh parity (1 % of size tolerance)`, fc.property(
        fc.tuple(size, size, size), fc.double({ min: 0.1, max: 0.9, noNaN: true }), fc.tuple(fraction, fraction, fraction), direction,
        ([dx, dy, dz], tubeRatio, [fx, fy, fz], [ux, uy, uz]) => {
          const [rx, ry, rz] = [ux + 0.0123, uy + 0.0371, uz + 0.0517];
          const dims = { x: dx, y: dy, z: dz };
          // Small constant offsets keep the point and the ray off the mesh's symmetry planes, where fast-check likes to shrink
          // to and where a ray would run exactly along a triangle edge and count twice.
          const point = { x: (fx * 2 + 0.0137) * dx, y: (fy * 2 + 0.0291) * dy, z: (fz * 2 + 0.0413) * dz };
          const test = PRIMITIVE_INSIDE[primitive];
          const expected = test(point.x, point.y, point.z, dims, tubeRatio);
          // Near the surface the mesh's flat facets and the analytic surface may disagree: such a point proves nothing.
          const tolerance = 0.01 * Math.max(dx, dy, dz);
          for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
            fc.pre(test(point.x + ox * tolerance, point.y + oy * tolerance, point.z + oz * tolerance, dims, tubeRatio) === expected);
          }
          const part = { ...fixturePart('p', primitive, [1, 1, 1]), dimensions: dims, tubeRatio };
          const geometry = createPartGeometry(part);
          try {
            const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
            const hits = crossings(mesh, new THREE.Vector3(point.x, point.y, point.z), new THREE.Vector3(rx, ry, rz));
            return (hits % 2 === 1) === expected;
          } finally { geometry.dispose(); }
        }), 300);
    });
  }

  it('puts a cone apex at +y with radius half the size at the base', () => {
    const test = PRIMITIVE_INSIDE.cone, d = { x: 0.04, y: 0.06, z: 0.04 };
    expect(test(0, 0.029, 0, d, 0.5)).toBe(true);
    expect(test(0.015, 0.029, 0, d, 0.5)).toBe(false);
    expect(test(0.019, -0.029, 0, d, 0.5)).toBe(true);
    expect(test(0.021, -0.029, 0, d, 0.5)).toBe(false);
    expect(test(0, 0.031, 0, d, 0.5)).toBe(false);
  });

  it('has a hole in a torus and a tube, and a flat box', () => {
    const d = { x: 0.07, y: 0.07, z: 0.01 };
    expect(PRIMITIVE_INSIDE.torus(0, 0, 0, d, 0.5)).toBe(false);
    expect(PRIMITIVE_INSIDE.torus(0.0262, 0, 0, d, 0.5)).toBe(true);
    expect(PRIMITIVE_INSIDE.torus(0.0262, 0, 0.0051, d, 0.5)).toBe(false);
    expect(PRIMITIVE_INSIDE.tube(0, 0, 0, { x: 0.07, y: 0.02, z: 0.07 }, 0.9)).toBe(false);
    expect(PRIMITIVE_INSIDE.tube(0.033, 0, 0, { x: 0.07, y: 0.02, z: 0.07 }, 0.9)).toBe(true);
    expect(PRIMITIVE_INSIDE.tube(0.033, 0.011, 0, { x: 0.07, y: 0.02, z: 0.07 }, 0.9)).toBe(false);
  });
});

describe('shell (design-fidelity primitive, R84)', () => {
  it('counts as its outer box, whatever its wall', () => {
    const size = fc.double({ min: 0.01, max: 0.08, noNaN: true });
    const fraction = fc.double({ min: -0.7, max: 0.7, noNaN: true });
    checkProperty('the inside test of a shell equals the one of a box', fc.property(
      fc.tuple(size, size, size), fc.double({ min: 0.1, max: 0.9, noNaN: true }), fc.tuple(fraction, fraction, fraction),
      ([dx, dy, dz], tubeRatio, [fx, fy, fz]) => {
        const dims = { x: dx, y: dy, z: dz };
        return PRIMITIVE_INSIDE.shell(fx * dx, fy * dy, fz * dz, dims, tubeRatio) === PRIMITIVE_INSIDE.box(fx * dx, fy * dy, fz * dz, dims, tubeRatio);
      }), 300);
  });

  it('is hit at its outer face, and a ring axis through its void counts as blocked', () => {
    const outside = fixtureModel('Shell beside the axis', [fixturePart('case', 'shell', [20, 20, 20], [40, 0, 0], { tubeRatio: 0.9 })]);
    const profile = innerProfile(modelParts(outside), { centre: new THREE.Vector3(), x: new THREE.Vector3(0, 0, -1), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(1, 0, 0) }, 10);
    expect(profile.distanceMm[1]![0]!).toBeCloseTo(30, 1);
    const around = fixtureModel('Shell around the axis', [fixturePart('case', 'shell', [40, 20, 40], [0, 0, 0], { tubeRatio: 0.9 })]);
    const setup = ringFrame(around, { kind: 'axis', axis: 'y' })!;
    expect(axisBlocked(innerProfile(modelParts(around), setup.frame, setup.halfWidthMm))).toBe(true);
  });
});

describe('ring candidates', () => {
  it('lists a tube and a torus part with their inner size, half width, centre and axis', () => {
    const [tube] = ringCandidates(tubeBand());
    expect(tube).toMatchObject({ partId: 'band', primitive: 'tube' });
    expect(tube!.innerMm).toBeCloseTo(61.6, 6);
    expect(tube!.halfWidthMm).toBeCloseTo(10, 9);
    near(tube!.axis, [0, 1, 0]);
    const [torus] = ringCandidates(torusBand());
    expect(torus).toMatchObject({ partId: 'band', primitive: 'torus' });
    expect(torus!.innerMm).toBeCloseTo(66, 6);
    expect(torus!.halfWidthMm).toBeCloseTo(6, 9);
    near(torus!.axis, [0, 0, 1]);
  });

  it('orders by inner size, largest first, and keeps only 35 to 130 mm', () => {
    const model = fixtureModel('Many', [
      tubeRingPart({ inner1Mm: 25, inner2Mm: 25, wallMm: 3, heightMm: 10 }, 'small'),
      tubeRingPart({ inner1Mm: 31, inner2Mm: 31, wallMm: 3, heightMm: 10 }, 'medium'),
      tubeRingPart({ inner1Mm: 10, inner2Mm: 10, wallMm: 3, heightMm: 10 }, 'tiny'),
      tubeRingPart({ inner1Mm: 70, inner2Mm: 70, wallMm: 5, heightMm: 10 }, 'huge'),
      torusRingPart({ inner1Mm: 28, inner2Mm: 28, widthMm: 8 }, 'torus'),
    ]);
    expect(ringCandidates(model).map(candidate => candidate.partId)).toEqual(['medium', 'torus', 'small']);
  });

  it('finds the ring in a band with a case, and in a case with a band', () => {
    expect(ringCandidates(bandWithCase()).map(candidate => candidate.partId)).toEqual(['band']);
    expect(ringCandidates(caseWithBand()).map(candidate => candidate.partId)).toEqual(['band']);
    expect(ringCandidates(noRing())).toEqual([]);
    expect(ringCandidates(openCuff())).toEqual([]);
  });

  it('gives the world axis of a turned ring and the world centre of a child ring', () => {
    const turned = fixtureModel('Turned', [{ ...tubeRingPart({ inner1Mm: 30, inner2Mm: 30, wallMm: 4, heightMm: 10 }), rotation: { x: 90, y: 0, z: 0 } }]);
    near(ringCandidates(turned)[0]!.axis, [0, 0, 1]);
    const [child] = ringCandidates(caseWithBand());
    near(child!.centre, [0, 0, -0.041]);
  });
});

describe('ring frame and face direction', () => {
  it('uses the tube band: axis y, face z (nothing else to point at), x = y cross z', () => {
    const setup = ringFrame(tubeBand())!;
    expect(setup).toMatchObject({ ringPartId: 'band', source: 'part' });
    expect(setup.halfWidthMm).toBeCloseTo(10, 9);
    near(setup.frame.y, [0, 1, 0]);
    near(setup.frame.z, [0, 0, 1]);
    near(setup.frame.x, [1, 0, 0]);
  });

  it('points the face at the case, whether the band or the case is the root', () => {
    for (const model of [bandWithCase(), caseWithBand()]) {
      const { frame } = ringFrame(model)!;
      near(frame.y, [0, 1, 0]);
      near(frame.z, [0, 0, 1]);
    }
  });

  it('ignores interior parts when it looks for the bulk of the object', () => {
    const model = fixtureModel('Interior', [
      tubeRingPart({ inner1Mm: 30, inner2Mm: 30, wallMm: 4, heightMm: 10 }),
      fixturePart('battery', 'box', [20, 20, 20], [0, 0, 50], { role: 'interior' }),
      fixturePart('case', 'box', [20, 20, 6], [40, 0, 0]),
    ]);
    near(ringFrame(model)!.frame.z, [1, 0, 0]);
  });

  it('falls back to the object +y, then +z, when the bulk gives no direction', () => {
    const turned = fixtureModel('Turned', [{ ...tubeRingPart({ inner1Mm: 30, inner2Mm: 30, wallMm: 4, heightMm: 10 }), rotation: { x: 90, y: 0, z: 0 } }]);
    const { frame } = ringFrame(turned)!;
    near(frame.y, [0, 0, 1]);
    near(frame.z, [0, 1, 0]);
    near(frame.x, [-1, 0, 0]);
    // A bulk shorter than 2 mm does not count.
    const near2 = fixtureModel('Near', [tubeRingPart({ inner1Mm: 30, inner2Mm: 30, wallMm: 4, heightMm: 10 }), fixturePart('dot', 'box', [4, 4, 4], [0, 0, 1.5])]);
    near(ringFrame(near2)!.frame.z, [0, 0, 1]);
    const centre = new THREE.Vector3();
    near(faceDirection(near2, 'band', centre, new THREE.Vector3(0, 1, 0)), [0, 0, 1]);
  });

  it('returns unit, mutually perpendicular axes for any turn of the ring', () => {
    checkProperty('frame axes are orthonormal and the axis is the tube axis', fc.property(
      fc.double({ min: -180, max: 180, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }),
      fc.double({ min: -50, max: 50, noNaN: true }), fc.boolean(),
      (rx, ry, rz, shift, withCase) => {
        const band = { ...tubeRingPart({ inner1Mm: 30, inner2Mm: 30, wallMm: 4, heightMm: 10 }), rotation: { x: rx, y: ry, z: rz }, position: { x: shift / 1000, y: 0, z: 0 } };
        const parts = withCase ? [band, fixturePart('case', 'box', [10, 10, 10], [0, 0, 0], { parentId: 'band', rotation: { x: 0, y: 0, z: 0 } })] : [band];
        const { frame } = ringFrame(fixtureModel('Turned', parts))!;
        const axis = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz), 'XYZ'));
        const orthonormal = [frame.x, frame.y, frame.z].every(v => Math.abs(v.length() - 1) < 1e-9)
          && Math.abs(frame.x.dot(frame.y)) < 1e-9 && Math.abs(frame.y.dot(frame.z)) < 1e-9 && Math.abs(frame.x.dot(frame.z)) < 1e-9;
        return orthonormal && frame.y.angleTo(axis) < 1e-6 && new THREE.Vector3().crossVectors(frame.y, frame.z).angleTo(frame.x) < 1e-6;
      }), 200);
  });

  it('uses the smallest extent of the object when no part is a ring', () => {
    const setup = ringFrame(noRing())!;
    expect(setup).toMatchObject({ ringPartId: null, source: 'axis', halfWidthMm: 10 });
    near(setup.frame.y, [0, 0, 1]);
    const cuff = ringFrame(openCuff())!;
    near(cuff.frame.y, [0, 1, 0]);
  });

  it('obeys the user: a part (any size), or a model axis; and ignores a choice that is not a ring part', () => {
    const model = fixtureModel('Two', [
      tubeRingPart({ inner1Mm: 31, inner2Mm: 31, wallMm: 3, heightMm: 10 }, 'big'),
      { ...torusRingPart({ inner1Mm: 28, inner2Mm: 28, widthMm: 8 }, 'little'), position: { x: 0, y: 0.05, z: 0 } },
      fixturePart('case', 'box', [10, 10, 10], [0, 0, 40]),
    ]);
    expect(ringFrame(model)!.ringPartId).toBe('big');
    const picked = ringFrame(model, { kind: 'part', partId: 'little' })!;
    expect(picked).toMatchObject({ ringPartId: 'little', source: 'part', halfWidthMm: 4 });
    near(picked.frame.y, [0, 0, 1]);
    expect(ringFrame(model, { kind: 'part', partId: 'case' })!.ringPartId).toBe('big');
    expect(ringFrame(model, { kind: 'part', partId: 'missing' })!.ringPartId).toBe('big');
    const axis = ringFrame(model, { kind: 'axis', axis: 'x' })!;
    expect(axis).toMatchObject({ ringPartId: null, source: 'axis' });
    near(axis.frame.y, [1, 0, 0]);
    // A part below the minimum size is still taken when the user picks it.
    const tiny = fixtureModel('Tiny', [tubeRingPart({ inner1Mm: 10, inner2Mm: 10, wallMm: 3, heightMm: 10 }, 'tiny')]);
    expect(ringFrame(tiny, { kind: 'part', partId: 'tiny' })!.ringPartId).toBe('tiny');
    expect(ringFrame(tiny)!.ringPartId).toBeNull();
  });

  it('has no ring for an empty list of parts', () => {
    expect(ringFrame([])).toBeNull();
  });
});

describe('worn assembly', () => {
  it('puts the parts of the joined objects in the worn object\'s frame', () => {
    const ws = rotatedPair({ joint: true, degrees: 30 });
    const parts = wornParts(ws, 'a');
    expect(parts.map(entry => entry.objectId)).toEqual(['a', 'b']);
    // In a's frame, b's box is one box width along a's own x, whatever the pair's turn in the workspace.
    near(new THREE.Vector3().setFromMatrixPosition(parts[1]!.world), [0.04, 0, 0], 4);
    near(new THREE.Vector3().setFromMatrixPosition(parts[0]!.world), [0, 0, 0], 6);
    expect(wornParts(ws, 'missing')).toEqual([]);
  });

  it('finds the strap of another object and wears it with the case', () => {
    let ws = addObject(emptyWorkspace(), fixtureObject('case', fixtureModel('Case', [fixturePart('case', 'box', [40, 36, 12])]), { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
    ws = addObject(ws, fixtureObject('strap', tubeBand(), { position: { x: 0, y: 0, z: -0.041 }, rotation: { x: 0, y: 0, z: 0 } }));
    const unjoined = wornParts(ws, 'case');
    expect(unjoined.map(entry => entry.part.id)).toEqual(['case']);
    ws = addJoint(ws, fixtureJoint(side('case', 'case', '-z'), side('strap', 'band', '+y')));
    const joined = wornParts(ws, 'case');
    expect(joined.map(entry => entry.part.id)).toEqual(['case', 'band']);
    const setup = ringFrame(joined)!;
    expect(setup.ringPartId).toBe('band');
    near(setup.frame.centre, [0, 0, -0.041]);
    near(setup.frame.z, [0, 0, 1]);
  });
});

describe('inner profile (design 6.4)', () => {
  const profileOf = (model: ReturnType<typeof tubeBand>, options = {}) => {
    const setup = ringFrame(model)!;
    return { setup, profile: innerProfile(modelParts(model), setup.frame, setup.halfWidthMm, options) };
  };

  it('samples 72 angles and 3 slices: both edges (0.5 mm inside) and the middle', () => {
    const { profile } = profileOf(tubeBand());
    expect(profile.anglesDeg).toHaveLength(FIT_ANGLES);
    expect(profile.anglesDeg[1]).toBe(5);
    expect(profile.sliceMm).toEqual([-9.5, 0, 9.5]);
    expect(profile.distanceMm).toHaveLength(FIT_SLICES);
    expect(profile.distanceMm[0]).toHaveLength(FIT_ANGLES);
  });

  it('equals the analytic inner ellipse of a tube within 0.1 mm on every slice', () => {
    checkProperty('tube inner profile = inner ellipse within 0.1 mm', fc.property(
      fc.double({ min: 25, max: 40, noNaN: true }), fc.double({ min: 25, max: 40, noNaN: true }), fc.double({ min: 3, max: 8, noNaN: true }), fc.double({ min: 4, max: 30, noNaN: true }),
      (inner1Mm, inner2Mm, wallMm, heightMm) => {
        const model = fixtureModel('Tube', [tubeRingPart({ inner1Mm, inner2Mm, wallMm, heightMm }), fixturePart('lug', 'box', [6, 6, 6], [0, 0, 60])]);
        const setup = ringFrame(model, { kind: 'part', partId: 'band' })!;
        const profile = innerProfile(modelParts(model), setup.frame, setup.halfWidthMm);
        // The face points at the lug (local +z), the across axis is local x.
        return profile.distanceMm.every(row => row.every((distance, j) => {
          const expected = ellipseRadius(inner2Mm, inner1Mm, profile.anglesDeg[j]! * Math.PI / 180);
          return distance !== null && Math.abs(distance - expected) < 0.1;
        }));
      }), 200);
  });

  it('equals the analytic inner ellipse of a torus at the middle slice and is wider at the edges', () => {
    checkProperty('torus inner profile = inner ellipse within 0.1 mm at the middle', fc.property(
      fc.double({ min: 18, max: 45, noNaN: true }), fc.double({ min: 18, max: 45, noNaN: true }), fc.double({ min: 8, max: 20, noNaN: true }),
      (inner1Mm, inner2Mm, widthMm) => {
        const model = fixtureModel('Torus', [torusRingPart({ inner1Mm, inner2Mm, widthMm }), fixturePart('lug', 'box', [6, 6, 6], [0, 60, 0])]);
        const setup = ringFrame(model)!;
        const profile = innerProfile(modelParts(model), setup.frame, setup.halfWidthMm);
        // The ring's z is the lug's direction (local +y), its x is the part's -x.
        return profile.distanceMm[1]!.every((distance, j) => {
          const expected = ellipseRadius(inner2Mm, inner1Mm, profile.anglesDeg[j]! * Math.PI / 180);
          const edges = [profile.distanceMm[0]![j]!, profile.distanceMm[2]![j]!];
          return distance !== null && Math.abs(distance - expected) < 0.1 && edges.every(edge => edge >= distance - 1e-9);
        });
      }), 200);
  });

  it('does not depend on how the ring is turned or where it sits', () => {
    checkProperty('a circular tube has the same inner radius under any rotation and offset', fc.property(
      fc.double({ min: -180, max: 180, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }),
      fc.tuple(fc.double({ min: -0.05, max: 0.05, noNaN: true }), fc.double({ min: -0.05, max: 0.05, noNaN: true }), fc.double({ min: -0.05, max: 0.05, noNaN: true })),
      fc.double({ min: 20, max: 40, noNaN: true }),
      (rx, ry, rz, [px, py, pz], radiusMm) => {
        const band = { ...tubeRingPart({ inner1Mm: radiusMm, inner2Mm: radiusMm, wallMm: 4, heightMm: 12 }), rotation: { x: rx, y: ry, z: rz }, position: { x: px, y: py, z: pz } };
        const model = fixtureModel('Turned', [band]);
        const setup = ringFrame(model)!;
        const profile = innerProfile(modelParts(model), setup.frame, setup.halfWidthMm);
        return profile.distanceMm.every(row => row.every(distance => distance !== null && Math.abs(distance - radiusMm) < 0.1));
      }), 150);
  });

  it('can be sampled at other angles', () => {
    const { profile } = profileOf(tubeBand(), { anglesDeg: [0, 90, 200.5] });
    expect(profile.anglesDeg).toEqual([0, 90, 200.5]);
    expect(profile.distanceMm[1]!.every(distance => Math.abs(distance! - 30.8) < 0.05)).toBe(true);
  });

  it('is open (null) all around when the ring is wider than the search reaches, and where an open cuff has no part', () => {
    const wide = fixtureModel('Wide', [tubeRingPart({ inner1Mm: 95, inner2Mm: 95, wallMm: 6, heightMm: 10 })]);
    const setup = ringFrame(wide, { kind: 'part', partId: 'band' })!;
    const open = innerProfile(modelParts(wide), setup.frame, setup.halfWidthMm);
    expect(open.distanceMm.flat().every(distance => distance === null)).toBe(true);
    expect(PROFILE_REACH_MM).toBe(90);

    const { setup: cuff, profile } = profileOf(openCuff());
    const middle = profile.distanceMm[1]!;
    const nulls = profile.anglesDeg.filter((_, j) => middle[j] === null);
    // The face points at the closed side (+x), so the opening is opposite it: ring angle 180, about 76 degrees wide.
    near(cuff.frame.z, [1, 0, 0], 1);
    expect(Math.min(...nulls)).toBeGreaterThanOrEqual(140);
    expect(Math.max(...nulls)).toBeLessThanOrEqual(222);
    expect((Math.min(...nulls) + Math.max(...nulls)) / 2).toBeCloseTo(180, -1);
    expect(nulls.length).toBeGreaterThanOrEqual(11);
    expect(middle[36]).toBeNull();
    expect(middle[0]).not.toBeNull();
    // The centre of the frame is the centre of the object's box, which is not the axis of a C: it lies 3 to 4 mm toward the closed side.
    const shiftMm = cuff.frame.centre.x * 1000;
    expect(shiftMm).toBeGreaterThan(2);
    expect(shiftMm).toBeLessThan(5);
    // Straight ahead (ring angle 0) the flat inner face of the segment at 90 degrees is 33 mm from the axis,
    // so about 33 mm minus the shift from the frame's centre (the face turns a little with the box centre's z).
    expect(Math.abs(middle[0]! - (33 - shiftMm))).toBeLessThan(1);
  });

  it('reports the axis inside a part as distance 0 (blocked), for a bar across the ring and for a solid box', () => {
    const bar = profileOf(ringWithBar());
    expect(bar.profile.distanceMm[1]!.every(distance => distance === 0)).toBe(true);
    expect(axisBlocked(bar.profile)).toBe(true);
    expect(bar.profile.distanceMm[0]!.every(distance => distance !== null && distance > 25)).toBe(true);
    expect(axisBlocked(profileOf(noRing()).profile)).toBe(true);
    expect(axisBlocked(profileOf(tubeBand()).profile)).toBe(false);
  });

  it('counts its inside tests and stays far under the design budget for a band with a case', () => {
    const model = bandWithCase();
    const parts = modelParts(model);
    const setup = ringFrame(model)!;
    const counter = { insideTests: 0 };
    const start = performance.now();
    innerProfile(parts, setup.frame, setup.halfWidthMm, { counter });
    const ms = performance.now() - start;
    // Design 6.4: at most 3 x 72 x (90 + 6) tests per part in range.
    const budget = FIT_SLICES * FIT_ANGLES * (PROFILE_REACH_MM + 6) * parts.length;
    expect(counter.insideTests).toBeGreaterThan(0);
    expect(counter.insideTests).toBeLessThan(budget);
    console.info(`[inner profile cost] band + case (${parts.length} parts): ${counter.insideTests} inside tests, ${ms.toFixed(2)} ms (budget ${budget} tests, 8 ms)`);
    // Warm runs, as the panel recomputes it: the mean of 20 runs. The time is printed, not asserted tightly (other sessions share the laptop).
    const again = { insideTests: 0 };
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) innerProfile(parts, setup.frame, setup.halfWidthMm, { counter: i === 0 ? again : undefined });
    const mean = (performance.now() - t1) / 20;
    console.info(`[inner profile cost] band + case, mean of 20 warm runs: ${mean.toFixed(2)} ms`);
    expect(again.insideTests).toBe(counter.insideTests);
    expect(mean).toBeLessThan(50);
  });

  it('skips a part whose box misses the slice', () => {
    const base = bandWithCase();
    const withFar = fixtureModel('Far', [...base.parts, fixturePart('far', 'box', [10, 10, 10], [0, 200, 0])]);
    const count = (model: typeof base) => {
      const setup = ringFrame(model, { kind: 'part', partId: 'band' })!;
      const counter = { insideTests: 0 };
      innerProfile(modelParts(model), setup.frame, setup.halfWidthMm, { counter });
      return counter.insideTests;
    };
    expect(count(withFar)).toBe(count(base));
  });
});
