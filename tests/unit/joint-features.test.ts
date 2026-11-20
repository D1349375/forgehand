import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { worldFace } from '../../shared/contact';
import {
  FEATURE_FIT, featuresForJoint, jointFeatures, layoutPositions, partThickness,
  type JointFeature, type JointFeatureSet,
} from '../../shared/features';
import { BOSS_WALL_MM, CLAMP_FLOOR_MM, EDGE_MARGIN_MM, MIN_FLOOR_MM, SCREW_TAIL_MM } from '../../shared/joint-constants';
import type { FaceId, Joint, JointMethod } from '../../shared/joint';
import type { MaterialId } from '../../shared/materials';
import type { Part } from '../../shared/model';
import { DEFAULT_PRINTER_PROFILE, type PrinterProfile } from '../../shared/printer';
import { INSERTS, SCREWS } from '../../shared/standard-parts';
import { addJoint, addObject, emptyWorkspace, findObject, type Workspace } from '../../shared/workspace';
import { fixtureJoint, fixtureModel, fixtureObject, fixturePart, side, twoBoxes } from '../fixtures/joint-workspace';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const mm = (value: number) => value / 1000;
const profile = DEFAULT_PRINTER_PROFILE;
const screw = (size: 'M2' | 'M3' = 'M3', count = 1, insertSide: 'a' | 'b' = 'a'): JointMethod => ({ kind: 'screw-insert', size, count, insertSide });
const magnet = (count = 1): JointMethod => ({ kind: 'magnet', magnet: 'd6x3', count });
const pin = (fit: 'press-both' | 'press-slide' = 'press-both', count = 1): JointMethod => ({ kind: 'pin', pin: 'd3', count, fit });

interface PairOptions {
  /** Thickness along x of a and b, in mm; the faces are 20 mm (y) by 30 mm (z). */
  aMm?: number;
  bMm?: number;
  aRole?: Part['role'];
  bRole?: Part['role'];
  aMaterial?: MaterialId | null;
  bMaterial?: MaterialId | null;
  /** Rotation of object b, degrees about x. Position is kept so that the faces still touch. */
  bRotationX?: number;
}

/** Objects `a` and `b`, a box part `body` each, touching along x. Joint `joint-1`: a `+x` to b `-x`. */
function pair(method: JointMethod, options: PairOptions = {}): { ws: Workspace; joint: Joint } {
  const aMm = options.aMm ?? 40;
  const bMm = options.bMm ?? 40;
  const a = fixtureObject('a', fixtureModel('A', [fixturePart('body', 'box', vec(mm(aMm), 0.02, 0.03), vec(0, 0, 0), options.aRole ?? 'exterior')]),
    { position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
  const b = fixtureObject('b', fixtureModel('B', [fixturePart('body', 'box', vec(mm(bMm), 0.02, 0.03), vec(0, 0, 0), options.bRole ?? 'exterior')]),
    { position: vec(mm(aMm / 2 + bMm / 2), 0, 0), rotation: vec(options.bRotationX ?? 0, 0, 0) });
  const joint = fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'), { method });
  let ws = addObject(addObject(emptyWorkspace(), { ...a, material: options.aMaterial ?? null }), { ...b, material: options.bMaterial ?? null });
  ws = addJoint(ws, joint);
  return { ws, joint };
}

const featuresOf = (set: JointFeatureSet, side: 'a' | 'b', kind: JointFeature['kind']) => set.features.filter(f => f.side === side && f.kind === kind);
const codes = (set: JointFeatureSet) => set.problems.map(problem => problem.code);
const world = (ws: Workspace, feature: JointFeature): THREE.Vector3 => {
  const object = findObject(ws, feature.objectId)!;
  const part = object.model.parts.find(candidate => candidate.id === feature.partId)!;
  // Any face of the part gives the part's object-and-part matrix.
  const matrix = worldFace(object, part, '+x')!.matrix;
  return new THREE.Vector3(feature.centre.x, feature.centre.y, feature.centre.z).applyMatrix4(matrix);
};

const rectangle = (widthMm: number, heightMm: number) => {
  const w = mm(widthMm) / 2;
  const h = mm(heightMm) / 2;
  return { polygon: [{ x: -w, y: -h }, { x: w, y: -h }, { x: w, y: h }, { x: -w, y: h }] };
};

describe('layoutPositions', () => {
  const footprint = mm(6);
  const margin = footprint / 2 + mm(EDGE_MARGIN_MM);
  const minimumDistance = (points: Array<{ x: number; y: number }>) => {
    let nearest = Infinity;
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) nearest = Math.min(nearest, Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y));
    return nearest;
  };
  const insideWithMargin = (points: Array<{ x: number; y: number }>, widthMm: number, heightMm: number) =>
    points.every(p => Math.abs(p.x) <= mm(widthMm) / 2 - margin + 1e-9 && Math.abs(p.y) <= mm(heightMm) / 2 - margin + 1e-9);

  it('puts one position at the centre', () => {
    expect(layoutPositions(rectangle(60, 20), 1, footprint)).toEqual([{ x: 0, y: 0 }]);
  });

  it('spreads two, three and four positions along a long region as far as the edge margin allows', () => {
    const region = rectangle(60, 20);
    const two = layoutPositions(region, 2, footprint)!;
    expect(two).toHaveLength(2);
    expect(two[0]!.x).toBeCloseTo(-(mm(30) - margin), 9);
    expect(two[1]!.x).toBeCloseTo(mm(30) - margin, 9);
    expect(two.every(p => Math.abs(p.y) < 1e-9)).toBe(true);

    const three = layoutPositions(region, 3, footprint)!;
    expect(three.map(p => Math.round(p.x * 1e6))).toEqual([0, -Math.round((mm(30) - margin) * 1e6), Math.round((mm(30) - margin) * 1e6)]);
    expect(three.every(p => Math.abs(p.y) < 1e-9)).toBe(true);

    // Four: a centred rectangle with the aspect ratio of the region, limited by the short side.
    const wide = rectangle(60, 30);
    const four = layoutPositions(wide, 4, footprint)!;
    expect(four).toHaveLength(4);
    expect(insideWithMargin(four, 60, 30)).toBe(true);
    const ys = four.map(p => p.y);
    expect(Math.max(...ys)).toBeCloseTo(mm(15) - margin, 9);
    expect(Math.max(...four.map(p => p.x))).toBeCloseTo(2 * (mm(15) - margin), 9);
    // A 60 x 20 region is too narrow for four positions two footprints apart.
    expect(layoutPositions(region, 4, footprint)).toBeNull();
    expect(four.reduce((sum, p) => sum + p.x, 0)).toBeCloseTo(0, 12);
    expect(minimumDistance(four)).toBeGreaterThanOrEqual(2 * footprint - 1e-9);
  });

  it('uses a triangle in a nearly square region', () => {
    const three = layoutPositions(rectangle(30, 30), 3, footprint)!;
    const radii = three.map(p => Math.hypot(p.x, p.y));
    expect(radii[0]).toBeCloseTo(radii[1]!, 9);
    expect(radii[1]).toBeCloseTo(radii[2]!, 9);
    expect(three[0]!.x).toBeCloseTo(0, 9);
    expect(three[0]!.y).toBeGreaterThan(0);
    expect(three.reduce((sum, p) => sum + p.y, 0)).toBeCloseTo(0, 9);
    expect(insideWithMargin(three, 30, 30)).toBe(true);
    // A square region also gives a square of four.
    const four = layoutPositions(rectangle(30, 30), 4, footprint)!;
    expect(Math.abs(four[0]!.x)).toBeCloseTo(Math.abs(four[0]!.y), 9);
  });

  it('keeps two footprints between positions, or gives up with null', () => {
    const roomy = layoutPositions(rectangle(40, 20), 2, footprint)!;
    expect(minimumDistance(roomy)).toBeGreaterThanOrEqual(2 * footprint);
    // 20 mm long with a 6 mm footprint: the margin leaves +-5.8 mm, so the points are 11.6 mm apart (< 12).
    expect(layoutPositions(rectangle(20, 12), 2, footprint)).toBeNull();
  });

  it('gives null when even the centre is too close to an edge', () => {
    expect(layoutPositions(rectangle(8, 8), 1, footprint)).toBeNull();
    expect(layoutPositions(rectangle(8.3, 30), 1, footprint)).toBeNull();
    expect(layoutPositions(rectangle(8.5, 30), 1, footprint)).not.toBeNull();
  });
});

describe('partThickness', () => {
  const cone: Part = fixturePart('c', 'cone', vec(0.04, 0.03, 0.04));
  it('is the dimension along the face axis', () => {
    expect(partThickness(fixturePart('b', 'box', vec(0.04, 0.02, 0.03)), '+x')).toBe(0.04);
    expect(partThickness(fixturePart('b', 'box', vec(0.04, 0.02, 0.03)), '-z')).toBe(0.03);
    expect(partThickness(fixturePart('c', 'cylinder', vec(0.04, 0.1, 0.04)), '+y')).toBe(0.1);
  });
  it('gets thinner away from a cone axis', () => {
    expect(partThickness(cone, '-y')).toBe(0.03);
    expect(partThickness(cone, '-y', { u: 0, v: 0, footprint: 0 })).toBeCloseTo(0.03, 12);
    expect(partThickness(cone, '-y', { u: 0, v: 0, footprint: 0.004 })).toBeCloseTo(0.03 * (1 - 0.1), 12);
    expect(partThickness(cone, '-y', { u: 0.01, v: 0, footprint: 0.004 })).toBeCloseTo(0.03 * (1 - 0.6), 12);
    expect(partThickness(cone, '-y', { u: 0.019, v: 0, footprint: 0.004 })).toBe(0);
  });
});

describe('screws with inserts', () => {
  it('derives the holes of an M3 joint from the standard parts and the profile', () => {
    const { ws, joint } = pair(screw('M3'));
    const set = featuresForJoint(ws, joint, profile);
    expect(set.problems).toEqual([]);
    expect(set.derived.positions).toBe(1);
    expect(set.derived.screwLengthMm).toBe(8);
    expect(set.derived.contactAreaMm2).toBeCloseTo(600, 3);
    expect(set.derived.thicknessMm).toEqual({ a: 40, b: 40 });
    expect(set.features.map(f => f.id)).toEqual([
      'joint-1:a:0:insert-hole', 'joint-1:a:0:clearance-hole', 'joint-1:b:0:clearance-hole', 'joint-1:b:0:counterbore',
    ]);

    const [insertHole] = featuresOf(set, 'a', 'insert-hole');
    expect(insertHole!.diameter).toBeCloseTo(mm(INSERTS.M3.holeMm + profile.holeCompensation), 9); // 4.2
    expect(insertHole!.depth).toBeCloseTo(mm(INSERTS.M3.lengthMm + profile.depthAllowance), 9); // 5.9
    expect(insertHole!.through).toBe(false);
    expect(insertHole!.fit).toBe('none');
    expect(insertHole!.made).toBe('printed');
    expect(insertHole!.nominal).toEqual({ diameterMm: 4, depthMm: 5.7 });
    // On a's +x face (x = 20 mm), into the part: along -x.
    expect(insertHole!.centre).toEqual({ x: 0.02, y: 0, z: 0 });
    expect(insertHole!.axis).toEqual({ x: -1, y: 0, z: 0 });
    expect(insertHole!.objectId).toBe('a');
    expect(insertHole!.partId).toBe('body');
    expect(insertHole!.jointId).toBe('joint-1');

    // Tail: blind, SCREW_TAIL_MM long, below the insert.
    const [tail] = featuresOf(set, 'a', 'clearance-hole');
    expect(tail!.through).toBe(false);
    expect(tail!.diameter).toBeCloseTo(mm(SCREWS.M3.clearanceMm + profile.holeCompensation), 9); // 3.6
    expect(tail!.depth).toBeCloseTo(mm(SCREW_TAIL_MM), 9);
    expect(tail!.centre.x).toBeCloseTo(0.02 - mm(5.9), 9);

    // Screw side: a clearance hole through the part and a counterbore from the far face down to the clamp floor.
    const [through] = featuresOf(set, 'b', 'clearance-hole');
    expect(through!.through).toBe(true);
    expect(through!.depth).toBeCloseTo(0.04, 9);
    expect(through!.centre).toEqual({ x: -0.02, y: 0, z: 0 });
    expect(through!.axis).toEqual({ x: 1, y: 0, z: 0 });
    const [bore] = featuresOf(set, 'b', 'counterbore');
    expect(bore!.diameter).toBeCloseTo(mm(SCREWS.M3.headMm + profile.holeCompensation + 2 * profile.slidingFit), 9); // 6.2
    expect(bore!.fit).toBe('sliding');
    expect(bore!.depth).toBeCloseTo(mm(40 - CLAMP_FLOOR_MM), 9);
    expect(bore!.centre.x).toBeCloseTo(0.02, 9); // the far face
    expect(bore!.axis).toEqual({ x: -1, y: 0, z: 0 }); // back towards the contact face
    expect(bore!.nominal.diameterMm).toBe(5.5);
  });

  it('uses the M2 sizes and screw length', () => {
    const { ws, joint } = pair(screw('M2'));
    const set = featuresForJoint(ws, joint, profile);
    expect(set.derived.screwLengthMm).toBe(5);
    const [insertHole] = featuresOf(set, 'a', 'insert-hole');
    expect(insertHole!.diameter).toBeCloseTo(mm(3.2 + profile.holeCompensation), 9);
    expect(insertHole!.depth).toBeCloseTo(mm(3 + profile.depthAllowance), 9);
    expect(featuresOf(set, 'b', 'clearance-hole')[0]!.diameter).toBeCloseTo(mm(2.4 + profile.holeCompensation), 9);
  });

  it('follows the printer profile and PETG', () => {
    const custom: PrinterProfile = { slidingFit: 0.3, pressFit: 0.15, holeCompensation: 0.4, depthAllowance: 0.5, petgExtra: 0.1 };
    const { ws, joint } = pair(screw('M3'), { aMaterial: 'petg', bMaterial: 'petg' });
    const set = featuresForJoint(ws, joint, custom);
    expect(featuresOf(set, 'a', 'insert-hole')[0]!.diameter).toBeCloseTo(mm(4.4), 9); // fit none: no PETG extra
    expect(featuresOf(set, 'a', 'insert-hole')[0]!.depth).toBeCloseTo(mm(6.2), 9);
    expect(featuresOf(set, 'b', 'counterbore')[0]!.diameter).toBeCloseTo(mm(5.5 + 0.4 + 2 * (0.3 + 0.1)), 9);
    // Longer holes change the derived length window, which the derived value reports.
    expect(set.derived.screwLengthMm).toBe(8);
  });

  it('lays out the same positions on both sides, mirrored through the contact plane (rotated b)', () => {
    const { ws, joint } = pair(screw('M3', 2), { bRotationX: 180 });
    const set = featuresForJoint(ws, joint, profile);
    expect(set.problems).toEqual([]);
    expect(set.derived.positions).toBe(2);
    const onA = set.features.filter(f => f.side === 'a' && f.kind === 'insert-hole').map(f => world(ws, f));
    const onB = set.features.filter(f => f.side === 'b' && f.kind === 'clearance-hole').map(f => world(ws, f));
    expect(onA).toHaveLength(2);
    onA.forEach((point, at) => expect(point.distanceTo(onB[at]!)).toBeLessThan(1e-9));
    // b is turned 180 degrees about x, so its local z is flipped: the local centres differ in sign.
    const localA = set.features.filter(f => f.side === 'a' && f.kind === 'insert-hole');
    const localB = set.features.filter(f => f.side === 'b' && f.kind === 'clearance-hole');
    expect(localB[0]!.centre.z).toBeCloseTo(-localA[0]!.centre.z, 9);
  });

  it('keeps the edge margin and the spacing for two positions', () => {
    const { ws, joint } = pair(screw('M3', 2));
    const set = featuresForJoint(ws, joint, profile);
    const [first, second] = featuresOf(set, 'a', 'insert-hole');
    const footprint = mm(SCREWS.M3.headMm + profile.holeCompensation + 2 * profile.slidingFit); // the counterbore is the widest
    expect(Math.abs(first!.centre.z - second!.centre.z)).toBeGreaterThanOrEqual(2 * footprint - 1e-9);
    // The face is 30 mm long (z): the points sit at the margin from its ends.
    expect(Math.abs(first!.centre.z)).toBeCloseTo(0.015 - (footprint / 2 + mm(EDGE_MARGIN_MM)), 9);
    expect(first!.centre.y).toBeCloseTo(0, 9);
  });

  it('reports NO_ROOM when the positions do not fit, with no features', () => {
    const { ws, joint } = pair(screw('M3', 4));
    const set = featuresForJoint(ws, joint, profile);
    expect(codes(set)).toEqual(['NO_ROOM']);
    expect(set.features).toEqual([]);
    expect(set.derived.positions).toBe(0);
  });

  it('makes the tail go through a thin insert side, without a boss', () => {
    // 8 mm: room for the 5.9 mm insert and the 1 mm floor, but not for the 3 mm tail.
    const { ws, joint } = pair(screw('M3'), { aMm: 8 });
    const set = featuresForJoint(ws, joint, profile);
    expect(featuresOf(set, 'a', 'boss')).toEqual([]);
    const [tail] = featuresOf(set, 'a', 'clearance-hole');
    expect(tail!.through).toBe(true);
    expect(tail!.depth).toBeCloseTo(mm(8 - 5.9), 9);
    expect(set.derived.thicknessMm.a).toBe(8);
    expect(set.derived.screwLengthMm).toBe(8); // window [6.5, 2 + 5.9 + 2.1 = 10]
  });

  it('adds a boss when the insert side is thinner than the insert plus the floor', () => {
    const { ws, joint } = pair(screw('M3'), { aMm: 5 });
    const set = featuresForJoint(ws, joint, profile);
    expect(codes(set)).toEqual([]);
    const [boss] = featuresOf(set, 'a', 'boss');
    expect(boss!.diameter).toBeCloseTo(mm(INSERTS.M3.outerMm + 2 * BOSS_WALL_MM), 9); // 7.8
    expect(boss!.depth).toBeCloseTo(mm(5.9 + MIN_FLOOR_MM - 5), 9); // 1.9 mm beyond the far face
    expect(boss!.fit).toBe('none');
    expect(boss!.made).toBe('printed');
    expect(boss!.through).toBe(false);
    expect(boss!.centre.x).toBeCloseTo(-0.0025, 9); // a is 5 mm thick: the boss grows from the far face at -2.5 mm
    expect(boss!.axis).toEqual({ x: -1, y: 0, z: 0 }); // it grows away from the part
    // The tail goes through the boss.
    const [tail] = featuresOf(set, 'a', 'clearance-hole');
    expect(tail!.through).toBe(true);
    expect(tail!.depth).toBeCloseTo(mm(5 + 1.9 - 5.9), 9);
    expect(set.derived.screwLengthMm).toBe(8); // window [6.5, 2 + 5.9 + 1 = 8.9]
  });

  it('puts the insert on side b when asked', () => {
    const { ws, joint } = pair(screw('M3', 1, 'b'));
    const set = featuresForJoint(ws, joint, profile);
    expect(featuresOf(set, 'b', 'insert-hole')).toHaveLength(1);
    expect(featuresOf(set, 'a', 'counterbore')).toHaveLength(1);
    expect(featuresOf(set, 'a', 'insert-hole')).toEqual([]);
  });

  it('has no clamp counterbore on a thin screw side and clamps its whole thickness', () => {
    const thin = featuresForJoint(...(() => { const p = pair(screw('M3'), { bMm: 1.5 }); return [p.ws, p.joint, profile] as const; })());
    expect(featuresOf(thin, 'b', 'counterbore')).toEqual([]);
    expect(featuresOf(thin, 'b', 'clearance-hole')[0]!.through).toBe(true);
    expect(thin.derived.screwLengthMm).toBe(6); // c = 1.5: window [6, 10.4]
    const atFloor = featuresForJoint(...(() => { const p = pair(screw('M3'), { bMm: CLAMP_FLOOR_MM }); return [p.ws, p.joint, profile] as const; })());
    expect(featuresOf(atFloor, 'b', 'counterbore')).toEqual([]);
    expect(atFloor.derived.screwLengthMm).toBe(8);
  });

  it('reports NO_LENGTH when no standard length fits, and still places the holes', () => {
    // A 8 mm component on the screw side clamps 8 mm: the window [12.5, 14.9] holds no M3 length (12, 16).
    const { ws, joint } = pair(screw('M3'), { aMm: 5, bMm: 8, bRole: 'interior' });
    const set = featuresForJoint(ws, joint, profile);
    expect(codes(set)).toEqual(['NO_LENGTH']);
    expect(set.derived.screwLengthMm).toBeNull();
    expect(featuresOf(set, 'a', 'insert-hole')).toHaveLength(1);
  });

  it('uses a tapped hole and no insert in a metal part', () => {
    const { ws, joint } = pair(screw('M3'), { aMaterial: 'aluminium' });
    const set = featuresForJoint(ws, joint, profile);
    expect(featuresOf(set, 'a', 'insert-hole')).toEqual([]);
    const [tapped] = featuresOf(set, 'a', 'tapped-hole');
    expect(tapped!.made).toBe('machined');
    expect(tapped!.diameter).toBeCloseTo(mm(SCREWS.M3.tapDrillMm), 9); // no compensation
    expect(tapped!.fit).toBe('none');
    expect(tapped!.through).toBe(false);
    expect(set.derived.screwLengthMm).toBe(8);
    // A thin metal part is tapped through.
    const thin = pair(screw('M3'), { aMaterial: 'steel', aMm: 4 });
    const thinSet = featuresForJoint(thin.ws, thin.joint, profile);
    expect(featuresOf(thinSet, 'a', 'tapped-hole')[0]!.through).toBe(true);
    expect(featuresOf(thinSet, 'a', 'tapped-hole')[0]!.depth).toBeCloseTo(0.004, 9);
  });

  it('drills a clearance hole in a metal screw side, without counterbore', () => {
    const { ws, joint } = pair(screw('M3'), { bMaterial: 'steel' });
    const set = featuresForJoint(ws, joint, profile);
    expect(featuresOf(set, 'b', 'counterbore')).toEqual([]);
    expect(featuresOf(set, 'b', 'clearance-hole')).toEqual([]);
    const [drilled] = featuresOf(set, 'b', 'drilled-hole');
    expect(drilled!.made).toBe('machined');
    expect(drilled!.diameter).toBeCloseTo(mm(SCREWS.M3.clearanceMm), 9);
    expect(drilled!.through).toBe(true);
    // The clamp is the whole metal part: 40 mm, so no standard M3 length reaches (window [44.5, ...]).
    expect(codes(set)).toEqual(['NO_LENGTH']);
    const thin = pair(screw('M3'), { bMaterial: 'steel', bMm: 2 });
    expect(featuresForJoint(thin.ws, thin.joint, profile).derived.screwLengthMm).toBe(8);
  });

  it('puts nothing on a component screw side and clamps its thickness', () => {
    const { ws, joint } = pair(screw('M3'), { bMm: 2, bRole: 'interior' });
    const set = featuresForJoint(ws, joint, profile);
    expect(set.features.every(f => f.side === 'a')).toBe(true);
    expect(codes(set)).toEqual([]);
    expect(set.derived.screwLengthMm).toBe(8); // c = 2
    expect(set.derived.thicknessMm.b).toBe(2);
  });

  it('reports COMPONENT_FEATURE for a component insert side and puts the rest on the other side', () => {
    const { ws, joint } = pair(screw('M3'), { aRole: 'interior' });
    const set = featuresForJoint(ws, joint, profile);
    expect(set.problems).toEqual([{ code: 'COMPONENT_FEATURE', side: 'a' }]);
    expect(set.features.every(f => f.side === 'b')).toBe(true);
    expect(featuresOf(set, 'b', 'counterbore')).toHaveLength(1);
    expect(set.derived.screwLengthMm).toBeNull();
  });

  it('puts the screw side on a cone base thinner away from the axis', () => {
    const cone: Part = fixturePart('cone', 'cone', vec(0.04, 0.03, 0.04));
    const bar = fixturePart('bar', 'box', vec(0.06, 0.01, 0.06));
    // Cone base (-y) on top of the bar (+y), the bar below.
    let ws = addObject(emptyWorkspace(), fixtureObject('cone', fixtureModel('Cone', [cone]), { position: vec(0, 0.02, 0), rotation: vec(0, 0, 0) }));
    ws = addObject(ws, fixtureObject('bar', fixtureModel('Bar', [bar]), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }));
    const joint = fixtureJoint(side('cone', 'cone', '-y'), side('bar', 'bar', '+y'), { method: screw('M3') });
    const withJoint = addJoint(ws, joint);
    const set = featuresForJoint(withJoint, joint, profile);
    // Footprint 6.2 (the counterbore on the bar): rho = 3.1 / 20.
    expect(set.derived.thicknessMm.a).toBeCloseTo(30 * (1 - 3.1 / 20), 3);
    expect(set.derived.thicknessMm.b).toBe(10);
    expect(partThickness(cone, '-y')).toBe(0.03);
    // Two positions sit away from the axis, where the cone is thinner.
    const joint2 = fixtureJoint(side('cone', 'cone', '-y'), side('bar', 'bar', '+y'), { method: screw('M3', 2) });
    const set2 = featuresForJoint(addJoint(ws, joint2), joint2, profile);
    expect(set2.derived.positions).toBe(2);
    expect(set2.derived.thicknessMm.a).toBeLessThan(set.derived.thicknessMm.a);
  });
});

describe('magnets', () => {
  it('puts a pocket on both sides, open at the contact face', () => {
    const { ws, joint } = pair(magnet());
    const set = featuresForJoint(ws, joint, profile);
    expect(set.problems).toEqual([]);
    expect(set.features.map(f => f.id)).toEqual(['joint-1:a:0:magnet-pocket', 'joint-1:b:0:magnet-pocket']);
    for (const feature of set.features) {
      expect(feature.diameter).toBeCloseTo(mm(6 + profile.holeCompensation + 2 * profile.pressFit), 9); // 6.4
      expect(feature.depth).toBeCloseTo(mm(3 + profile.depthAllowance), 9); // 3.2
      expect(feature.fit).toBe('press');
      expect(feature.through).toBe(false);
      expect(feature.nominal).toEqual({ diameterMm: 6, depthMm: 3 });
    }
    expect(set.features[0]!.centre).toEqual({ x: 0.02, y: 0, z: 0 });
    expect(set.features[0]!.axis).toEqual({ x: -1, y: 0, z: 0 });
    expect(set.features[1]!.centre).toEqual({ x: -0.02, y: 0, z: 0 });
    expect(set.features[1]!.axis).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('adds the PETG allowance, and uses nominal sizes in metal', () => {
    const petg = pair(magnet(), { aMaterial: 'petg' });
    expect(featuresOf(featuresForJoint(petg.ws, petg.joint, profile), 'a', 'magnet-pocket')[0]!.diameter).toBeCloseTo(mm(6.5), 9);
    const metal = pair(magnet(), { bMaterial: 'aluminium' });
    const set = featuresForJoint(metal.ws, metal.joint, profile);
    const [pocket] = featuresOf(set, 'b', 'magnet-pocket');
    expect(pocket!.made).toBe('machined');
    expect(pocket!.diameter).toBeCloseTo(mm(6), 9);
    expect(pocket!.depth).toBeCloseTo(mm(3), 9);
  });

  it('reports TOO_THIN for a side without room for the pocket and the floor', () => {
    const { ws, joint } = pair(magnet(), { aMm: 4 });
    const set = featuresForJoint(ws, joint, profile);
    expect(set.problems).toEqual([{ code: 'TOO_THIN', side: 'a' }]);
    expect(set.features).toHaveLength(2);
    const fine = pair(magnet(), { aMm: 3.2 + MIN_FLOOR_MM });
    expect(featuresForJoint(fine.ws, fine.joint, profile).problems).toEqual([]);
  });

  it('places two magnets and puts nothing on a component', () => {
    const two = pair(magnet(2));
    expect(featuresForJoint(two.ws, two.joint, profile).features).toHaveLength(4);
    const component = pair(magnet(), { bRole: 'interior' });
    const set = featuresForJoint(component.ws, component.joint, profile);
    expect(set.problems).toEqual([{ code: 'COMPONENT_FEATURE', side: 'b' }]);
    expect(set.features.map(f => f.side)).toEqual(['a']);
  });
});

describe('pins', () => {
  it('picks the longest standard pin that fits and presses on both sides', () => {
    const { ws, joint } = pair(pin());
    const set = featuresForJoint(ws, joint, profile);
    expect(set.derived.pinLengthMm).toBe(20); // d3: 20 / 2 + 0.2 + 1 <= 40
    expect(set.problems).toEqual([]);
    for (const feature of set.features) {
      expect(feature.kind).toBe('pin-hole');
      expect(feature.diameter).toBeCloseTo(mm(3 + profile.holeCompensation + 2 * profile.pressFit), 9); // 3.4
      expect(feature.depth).toBeCloseTo(mm(10 + profile.depthAllowance), 9);
      expect(feature.fit).toBe('press');
      expect(feature.through).toBe(false);
    }
  });

  it('limits the length by the thinner side, with a floor under the hole', () => {
    const { ws, joint } = pair(pin(), { bMm: 6 });
    expect(featuresForJoint(ws, joint, profile).derived.pinLengthMm).toBe(8); // 12 / 2 + 1.2 > 6, 8 / 2 + 1.2 <= 6
  });

  it('uses the sliding fit on side b for press-slide', () => {
    const { ws, joint } = pair(pin('press-slide'));
    const set = featuresForJoint(ws, joint, profile);
    const [a] = featuresOf(set, 'a', 'pin-hole');
    const [b] = featuresOf(set, 'b', 'pin-hole');
    expect(a!.fit).toBe('press');
    expect(a!.diameter).toBeCloseTo(mm(3.4), 9);
    expect(b!.fit).toBe('sliding');
    expect(b!.diameter).toBeCloseTo(mm(3 + profile.holeCompensation + 2 * profile.slidingFit), 9); // 3.7
  });

  it('reports NO_LENGTH when the thinner side leaves no standard length, with no features', () => {
    const { ws, joint } = pair(pin(), { aMm: 4 });
    const set = featuresForJoint(ws, joint, profile);
    expect(codes(set)).toEqual(['NO_LENGTH']);
    expect(set.features).toEqual([]);
    expect(set.derived.pinLengthMm).toBeNull();
  });

  it('puts two pins in a long region', () => {
    const { ws, joint } = pair(pin('press-both', 2));
    const set = featuresForJoint(ws, joint, profile);
    expect(featuresOf(set, 'a', 'pin-hole')).toHaveLength(2);
    expect(set.derived.positions).toBe(2);
  });
});

describe('glue', () => {
  it('adds no features and reports the contact area', () => {
    const { ws, joint } = pair({ kind: 'glue', glue: 'epoxy' });
    const set = featuresForJoint(ws, joint, profile);
    expect(set.features).toEqual([]);
    expect(set.problems).toEqual([]);
    expect(set.derived.contactAreaMm2).toBeCloseTo(600, 3);
    expect(set.derived.positions).toBe(0);
    expect(set.derived.thicknessMm).toEqual({ a: 40, b: 40 });
  });
});

describe('a joint whose faces are apart', () => {
  it('reports APART and keeps the layout on side a', () => {
    const { ws, joint } = pair(screw('M3', 2));
    const touching = featuresForJoint(ws, joint, profile);
    const moved = { ...ws, objects: ws.objects.map(o => (o.id === 'b' ? { ...o, transform: { ...o.transform, position: vec(0.045, 0, 0) } } : o)) };
    const apart = featuresForJoint(moved, joint, profile);
    expect(codes(apart)).toEqual(['APART']);
    expect(apart.features).toEqual(touching.features);
    // Far enough sideways that there is no overlap at all: still laid out, on side a's face.
    const away = { ...ws, objects: ws.objects.map(o => (o.id === 'b' ? { ...o, transform: { ...o.transform, position: vec(0.045, 0.2, 0) } } : o)) };
    const none = featuresForJoint(away, joint, profile);
    expect(codes(none)).toEqual(['APART']);
    expect(none.derived.contactAreaMm2).toBe(0);
    expect(featuresOf(none, 'a', 'insert-hole')).toHaveLength(2);
  });

  it('reports NO_FACE when a side is gone', () => {
    const { ws, joint } = pair(screw('M3'));
    const broken = { ...ws, objects: ws.objects.filter(o => o.id !== 'b') };
    expect(featuresForJoint(broken, joint, profile)).toMatchObject({ features: [], problems: [{ code: 'NO_FACE' }] });
  });
});

describe('jointFeatures', () => {
  const addBlock = (ws: Workspace, id: string, x: number): Workspace =>
    addObject(ws, fixtureObject(id, fixtureModel(id, [fixturePart('body', 'box', vec(0.04, 0.02, 0.03))]), { position: vec(x, 0, 0), rotation: vec(0, 0, 0) }));

  it('derives every joint and groups the features by part', () => {
    let ws = addBlock(addBlock(emptyWorkspace(), 'a', 0), 'b', 0.04);
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'), { method: magnet() }));
    const set = jointFeatures(ws, profile);
    expect([...set.joints.keys()]).toEqual(['joint-1']);
    expect([...set.parts.keys()]).toEqual(['a:body', 'b:body']);
    expect(set.parts.get('a:body')).toHaveLength(1);
    expect(set.joints.get('joint-1')!.problems).toEqual([]);
  });

  it('flags OVERLAP on both joints when features of two joints on one part intersect', () => {
    let ws = addBlock(addBlock(addBlock(emptyWorkspace(), 'a', 0), 'b', 0.04), 'c', 0.04);
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'), { id: 'j1', method: magnet() }));
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '+x'), side('c', 'body', '-x'), { id: 'j2', method: magnet() }));
    const set = jointFeatures(ws, profile);
    expect(set.joints.get('j1')!.problems).toEqual([{ code: 'OVERLAP', side: 'a' }]);
    expect(set.joints.get('j2')!.problems).toEqual([{ code: 'OVERLAP', side: 'a' }]);
    // The single-joint function knows nothing about other joints.
    expect(featuresForJoint(ws, ws.joints[0]!, profile).problems).toEqual([]);
  });

  it('does not flag features that are apart, on opposite faces or in different parts', () => {
    let ws = addBlock(addBlock(addBlock(emptyWorkspace(), 'a', 0), 'b', 0.04), 'c', -0.04);
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'), { id: 'j1', method: magnet() }));
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '-x'), side('c', 'body', '+x'), { id: 'j2', method: magnet() }));
    const set = jointFeatures(ws, profile);
    expect(set.joints.get('j1')!.problems).toEqual([]);
    expect(set.joints.get('j2')!.problems).toEqual([]);
  });

  it('flags a hole of one joint that crosses a hole of another at a right angle', () => {
    // A 16 mm cube: j1 drills along x and j2 along y from the middle of two faces; both reach past the centre.
    const cube = fixtureObject('a', fixtureModel('A', [fixturePart('body', 'box', vec(0.016, 0.016, 0.016))]), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
    let ws = addObject(emptyWorkspace(), cube);
    ws = addBlock(ws, 'b', 0.028);
    ws = addObject(ws, fixtureObject('t', fixtureModel('T', [fixturePart('body', 'box', vec(0.04, 0.02, 0.03))]), { position: vec(0, 0.018, 0), rotation: vec(0, 0, 0) }));
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'), { id: 'j1', method: screw('M3') }));
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '+y'), side('t', 'body', '-y'), { id: 'j2', method: screw('M3') }));
    const set = jointFeatures(ws, profile);
    expect(set.joints.get('j1')!.problems).toEqual([{ code: 'OVERLAP', side: 'a' }]);
    expect(set.joints.get('j2')!.problems).toEqual([{ code: 'OVERLAP', side: 'a' }]);
  });
  it('gives equal output for the same input', () => {
    const { ws } = pair(screw('M3', 2), { bRotationX: 180 });
    expect(jointFeatures(ws, profile)).toEqual(jointFeatures(ws, profile));
    expect(jointFeatures(twoBoxes({ joint: true }), profile)).toEqual(jointFeatures(twoBoxes({ joint: true }), profile));
  });

  it('takes the fit class of each kind from one table', () => {
    expect(FEATURE_FIT).toEqual({
      'insert-hole': 'none', 'clearance-hole': 'none', counterbore: 'sliding', boss: 'none',
      'magnet-pocket': 'press', 'pin-hole': 'press', 'tapped-hole': 'none', 'drilled-hole': 'none',
    });
    const { ws, joint } = pair(screw('M3'));
    for (const feature of featuresForJoint(ws, joint, profile).features) expect(feature.fit).toBe(FEATURE_FIT[feature.kind]);
  });
});
