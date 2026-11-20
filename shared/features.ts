import * as THREE from 'three';
import { contactRegion, regionCentroid, touching, worldFace, type P2, type Region, type WorldFace } from './contact';
import {
  BOSS_WALL_MM, CLAMP_FLOOR_MM, EDGE_MARGIN_MM, MIN_CONTACT_MM2, MIN_ENGAGEMENT_FACTOR, MIN_FLOOR_MM, SCREW_TAIL_MM,
} from './joint-constants';
import type { FaceId, Joint, JointSide } from './joint';
import { MATERIALS, type MaterialId } from './materials';
import type { Part } from './model';
import { printedDepth, printedDiameter, type Fit, type PrinterProfile } from './printer';
import { INSERTS, MAGNETS, PINS, SCREWS } from './standard-parts';
import { findObject, type SceneObject, type Workspace } from './workspace';

/**
 * Hole, pocket and boss features that joints need (assembly-joints requirements 29 to 38,
 * design 5). Derived from the joint, the geometry, the standard parts and the printer
 * profile; nothing here is stored. Pure and deterministic. Feature positions, centres,
 * diameters and depths are metres in the part's own frame; names ending in `Mm` are millimetres.
 */

export type FeatureKind =
  | 'insert-hole' | 'clearance-hole' | 'counterbore' | 'boss' | 'magnet-pocket' | 'pin-hole' | 'tapped-hole' | 'drilled-hole';

type Vector = { x: number; y: number; z: number };

export interface JointFeature {
  /** `${jointId}:${side}:${position}:${kind}`, stable. */
  id: string;
  jointId: string;
  side: 'a' | 'b';
  objectId: string;
  partId: string;
  kind: FeatureKind;
  /** Part-local, on the face where the feature starts. For a boss: on the face it grows from. */
  centre: Vector;
  /** Unit, part-local: into the material. For a boss: the direction it grows. For a counterbore: from the far face back towards the contact face. */
  axis: Vector;
  diameter: number;
  depth: number;
  /** The feature reaches the far face of the part (a boss: never). */
  through: boolean;
  fit: Fit;
  made: 'printed' | 'machined';
  nominal: { diameterMm: number; depthMm: number };
}

export interface JointDerived {
  positions: number;
  screwLengthMm: number | null;
  pinLengthMm: number | null;
  contactAreaMm2: number;
  /** Thinnest material along the contact axis at the feature positions (the part's thickness for glue). */
  thicknessMm: { a: number; b: number };
}

export interface FeatureProblem {
  code: 'APART' | 'NO_FACE' | 'NO_ROOM' | 'TOO_THIN' | 'NO_LENGTH' | 'COMPONENT_FEATURE' | 'OVERLAP';
  side?: 'a' | 'b';
}

export interface JointFeatureSet { features: JointFeature[]; derived: JointDerived; problems: FeatureProblem[] }

export interface FeatureSet {
  joints: Map<string, JointFeatureSet>;
  /** Features by `objectId:partId`. */
  parts: Map<string, JointFeature[]>;
}

/**
 * Fit class of each feature kind (requirement 18). A pin hole is `press` on side a and
 * on side b with `press-both`; side b of `press-slide` is `sliding`. Machined features
 * (metal) have no fit: they use nominal sizes.
 */
export const FEATURE_FIT: Record<FeatureKind, Fit> = {
  'insert-hole': 'none',
  'clearance-hole': 'none',
  counterbore: 'sliding',
  boss: 'none',
  'magnet-pocket': 'press',
  'pin-hole': 'press',
  'tapped-hole': 'none',
  'drilled-hole': 'none',
};

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;
const axisOf = (face: FaceId) => AXIS_INDEX[face[1] as 'x' | 'y' | 'z'];
const signOf = (face: FaceId): 1 | -1 => (face[0] === '+' ? 1 : -1);

/** Metres from millimetres, to the micrometre. */
const metres = (mm: number) => Math.round(mm * 1000) / 1e6;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// 5.2 Thickness
// ---------------------------------------------------------------------------

/**
 * The part's dimension along the face axis, in metres. A cone's base is thinner away
 * from its axis: `h * (1 - rho)`, with `rho` the outer distance of a feature footprint
 * (diameter `at.footprint`, centre at `at.u`, `at.v` on the face) from the axis relative to
 * the base radius.
 */
export function partThickness(part: Part, face: FaceId, at?: { u: number; v: number; footprint: number }): number {
  const axis = axisOf(face);
  const dims = [part.dimensions.x, part.dimensions.y, part.dimensions.z];
  const full = dims[axis]!;
  if (part.primitive !== 'cone' || !at) return full;
  const halfU = dims[(axis + 1) % 3]! / 2;
  const halfV = dims[(axis + 2) % 3]! / 2;
  const rho = Math.min(1, Math.hypot(at.u / halfU, at.v / halfV) + at.footprint / 2 / Math.min(halfU, halfV));
  return full * (1 - rho);
}

// ---------------------------------------------------------------------------
// 5.3 Layout
// ---------------------------------------------------------------------------

/**
 * Positions of `count` fasteners of the given footprint (diameter, metres) inside a
 * convex region, in the region's frame, or `null` when they do not fit (`NO_ROOM`). Every
 * point keeps `footprint / 2 + EDGE_MARGIN_MM` from every edge and two points keep at
 * least two footprints apart. 1: the centroid. 2: along the long axis. 3: in a line, or a
 * triangle for a nearly square region. 4: a centred rectangle. The spread `t` is the largest
 * value with every point valid, found by bisection.
 */
export function layoutPositions(region: Pick<Region, 'polygon'>, count: number, footprint: number): P2[] | null {
  const polygon = region.polygon;
  const margin = footprint / 2 + EDGE_MARGIN_MM / 1000;
  const valid = (p: P2): boolean => polygon.every((c0, at) => {
    const c1 = polygon[(at + 1) % polygon.length]!;
    const ex = c1.x - c0.x;
    const ey = c1.y - c0.y;
    const length = Math.hypot(ex, ey);
    return length < 1e-12 || (ex * (p.y - c0.y) - ey * (p.x - c0.x)) / length >= margin - 1e-12;
  });
  const centre = regionCentroid(region);
  if (!valid(centre)) return null;
  if (count <= 1) return [centre];

  const mean = { x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length, y: polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length };
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of polygon) {
    sxx += (p.x - mean.x) ** 2;
    syy += (p.y - mean.y) ** 2;
    sxy += (p.x - mean.x) * (p.y - mean.y);
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const e = { x: Math.cos(angle), y: Math.sin(angle) };
  const f = { x: -e.y, y: e.x };
  const extent = (axis: P2) => {
    const values = polygon.map(p => p.x * axis.x + p.y * axis.y);
    return Math.max(...values) - Math.min(...values);
  };
  const extentE = extent(e);
  const extentF = extent(f);

  // Offsets in (e, f) coordinates, scaled by t.
  let offsets: Array<[number, number]>;
  if (count === 2) offsets = [[-1, 0], [1, 0]];
  else if (count === 3) {
    offsets = extentE >= 1.5 * extentF
      ? [[0, 0], [-1, 0], [1, 0]]
      : [90, 210, 330].map(degrees => [Math.cos(THREE.MathUtils.degToRad(degrees)), Math.sin(THREE.MathUtils.degToRad(degrees))] as [number, number]);
  } else {
    const r = extentE > 0 ? extentF / extentE : 1;
    offsets = [[-1, -r], [1, -r], [1, r], [-1, r]];
  }
  const at = (t: number): P2[] => offsets.map(([oe, of]) => ({
    x: centre.x + t * (oe * e.x + of * f.x), y: centre.y + t * (oe * e.y + of * f.y),
  }));

  let nearest = Infinity;
  for (let i = 0; i < offsets.length; i++) {
    for (let j = i + 1; j < offsets.length; j++) {
      nearest = Math.min(nearest, Math.hypot(offsets[i]![0] - offsets[j]![0], offsets[i]![1] - offsets[j]![1]));
    }
  }
  const minimum = (2 * footprint) / nearest;

  let low = 0;
  let high = extentE + extentF;
  if (at(high).every(valid)) low = high;
  else {
    for (let step = 0; step < 60; step++) {
      const middle = (low + high) / 2;
      if (at(middle).every(valid)) low = middle;
      else high = middle;
    }
  }
  return low + 1e-9 >= minimum ? at(low) : null;
}

// ---------------------------------------------------------------------------
// 5.4 Per method
// ---------------------------------------------------------------------------

type SideKind = 'printed' | 'metal' | 'component';

interface SideContext {
  tag: 'a' | 'b';
  joint: JointSide;
  object: SceneObject;
  part: Part;
  face: WorldFace;
  kind: SideKind;
  material: MaterialId | null;
  inverse: THREE.Matrix4;
}

/** A position on a side: the point on the contact face in the part's frame, and its face coordinates. */
interface Spot { local: THREE.Vector3; u: number; v: number }

function sideContext(ws: Workspace, joint: JointSide, tag: 'a' | 'b'): SideContext | null {
  const object = findObject(ws, joint.objectId);
  const part = object?.model.parts.find(candidate => candidate.id === joint.partId);
  if (!object || !part) return null;
  const face = worldFace(object, part, joint.face);
  if (!face) return null;
  const material = object.material ?? null;
  const kind: SideKind = part.role === 'interior' ? 'component' : material !== null && MATERIALS[material].process === 'metal' ? 'metal' : 'printed';
  return { tag, joint, object, part, face, kind, material, inverse: face.matrix.clone().invert() };
}

const emptyDerived = (): JointDerived => ({ positions: 0, screwLengthMm: null, pinLengthMm: null, contactAreaMm2: 0, thicknessMm: { a: 0, b: 0 } });

function fullFaceRegion(face: WorldFace): Region | null {
  return contactRegion(face, face);
}

/** Maps positions in the region frame onto a side's contact face, in the part's own frame. */
function spotsOn(ctx: SideContext, region: Region, positions: readonly P2[]): Spot[] {
  const axis = axisOf(ctx.joint.face);
  const dims = [ctx.part.dimensions.x, ctx.part.dimensions.y, ctx.part.dimensions.z];
  return positions.map(p => {
    const local = region.origin.clone().addScaledVector(region.u, p.x).addScaledVector(region.v, p.y).applyMatrix4(ctx.inverse);
    local.setComponent(axis, (signOf(ctx.joint.face) * dims[axis]!) / 2);
    return { local, u: local.getComponent((axis + 1) % 3), v: local.getComponent((axis + 2) % 3) };
  });
}

const thicknessMm = (ctx: SideContext, spots: readonly Spot[], footprintMm: number): number[] =>
  spots.map(spot => partThickness(ctx.part, ctx.joint.face, { u: spot.u, v: spot.v, footprint: footprintMm / 1000 }) * 1000);

const minOf = (values: readonly number[]) => (values.length === 0 ? 0 : Math.min(...values));

interface Parts {
  features: JointFeature[];
  problems: FeatureProblem[];
  positions: P2[];
  screwLengthMm: number | null;
  pinLengthMm: number | null;
  thickness: { a: number[]; b: number[] };
}

export function featuresForJoint(ws: Workspace, joint: Joint, profile: PrinterProfile): JointFeatureSet {
  const sa = sideContext(ws, joint.a, 'a');
  const sb = sideContext(ws, joint.b, 'b');
  if (!sa || !sb) return { features: [], derived: emptyDerived(), problems: [{ code: 'NO_FACE' }] };

  const contact = touching(sa.face, sb.face);
  const problems: FeatureProblem[] = [];
  if (!contact.ok) problems.push({ code: 'APART' });
  // Features stay laid out when the faces are apart: on the overlap if there is one, otherwise on side a's face.
  const region = contact.region && contact.region.areaMm2 >= MIN_CONTACT_MM2 ? contact.region : fullFaceRegion(sa.face);
  const contactAreaMm2 = contact.region?.areaMm2 ?? 0;

  const sides = { a: sa, b: sb };
  const features: JointFeature[] = [];
  const method = joint.method;
  let positions: P2[] = [];
  let screwLengthMm: number | null = null;
  let pinLengthMm: number | null = null;
  const thickness: { a: number[]; b: number[] } = { a: [], b: [] };

  const spotsFor = (ctx: SideContext) => spotsOn(ctx, region!, positions);
  const holeDiameter = (ctx: SideContext, nominalMm: number, fit: Fit) =>
    ctx.kind === 'printed' ? printedDiameter(nominalMm, fit, profile, ctx.material) : nominalMm;
  const holeDepth = (ctx: SideContext, nominalMm: number) => (ctx.kind === 'printed' ? printedDepth(nominalMm, profile) : nominalMm);

  const emit = (
    ctx: SideContext, position: number, spot: Spot, kind: FeatureKind,
    o: { offsetMm?: number; reverse?: boolean; diameterMm: number; depthMm: number; through: boolean; fit: Fit; nominalDiameterMm: number; nominalDepthMm: number },
  ) => {
    const inward = new THREE.Vector3().setComponent(axisOf(ctx.joint.face), -signOf(ctx.joint.face));
    const centre = spot.local.clone().addScaledVector(inward, (o.offsetMm ?? 0) / 1000);
    const axis = o.reverse ? inward.clone().negate() : inward;
    features.push({
      id: `${joint.id}:${ctx.tag}:${position}:${kind}`,
      jointId: joint.id, side: ctx.tag, objectId: ctx.joint.objectId, partId: ctx.joint.partId, kind,
      centre: { x: centre.x, y: centre.y, z: centre.z },
      axis: { x: axis.x + 0, y: axis.y + 0, z: axis.z + 0 },
      diameter: metres(o.diameterMm), depth: metres(o.depthMm), through: o.through,
      fit: ctx.kind === 'metal' ? 'none' : o.fit, made: ctx.kind === 'metal' ? 'machined' : 'printed',
      nominal: { diameterMm: o.nominalDiameterMm, depthMm: round3(o.nominalDepthMm) },
    });
  };

  /** Lays out `count` positions for the footprint (mm); records `NO_ROOM` and returns false when they do not fit. */
  const lay = (count: number, footprintMm: number): boolean => {
    const laid = layoutPositions(region!, count, footprintMm / 1000);
    if (!laid) {
      problems.push({ code: 'NO_ROOM' });
      positions = [];
      return false;
    }
    positions = laid;
    return true;
  };
  const noteComponents = (...ctxs: SideContext[]) => {
    for (const ctx of ctxs) if (ctx.kind === 'component') problems.push({ code: 'COMPONENT_FEATURE', side: ctx.tag });
  };

  if (!region) {
    problems.push({ code: 'NO_ROOM' });
  } else if (method.kind === 'glue') {
    // No features.
  } else if (method.kind === 'screw-insert') {
    const insertCtx = sides[method.insertSide];
    const screwCtx = method.insertSide === 'a' ? sb : sa;
    const insert = INSERTS[method.size];
    const screw = SCREWS[method.size];
    const d = Number(method.size.slice(1));
    if (insertCtx.kind === 'component') problems.push({ code: 'COMPONENT_FEATURE', side: insertCtx.tag });

    const insertHoleMm = holeDiameter(insertCtx, insert.holeMm, 'none');
    const insertDepthMm = holeDepth(insertCtx, insert.lengthMm);
    const clearanceOf = (ctx: SideContext) => holeDiameter(ctx, screw.clearanceMm, 'none');
    const counterboreMm = holeDiameter(screwCtx, screw.headMm, 'sliding');
    const bossOuterMm = insert.outerMm + 2 * BOSS_WALL_MM;
    const insertSideMm = insertCtx.kind === 'metal' ? screw.tapDrillMm : insertHoleMm;
    const thicknessOnScrewSide = partThickness(screwCtx.part, screwCtx.joint.face) * 1000;

    const footprints: number[] = [];
    if (insertCtx.kind !== 'component') footprints.push(insertSideMm);
    if (screwCtx.kind !== 'component') {
      footprints.push(clearanceOf(screwCtx));
      if (screwCtx.kind === 'printed' && thicknessOnScrewSide > CLAMP_FLOOR_MM) footprints.push(counterboreMm);
    }
    if (footprints.length > 0 && lay(method.count, Math.max(...footprints))) {
      let footprint = Math.max(...footprints);
      // A thin insert side needs a boss, which is wider than the holes: lay out again with its outer diameter.
      const boss = insertCtx.kind === 'printed' && minOf(thicknessMm(insertCtx, spotsFor(insertCtx), footprint)) < insertDepthMm + MIN_FLOOR_MM - EPS;
      if (boss) {
        footprint = Math.max(footprint, bossOuterMm);
        lay(method.count, footprint);
      }
      if (positions.length > 0) {
        const insertSpots = spotsFor(insertCtx);
        const screwSpots = spotsFor(screwCtx);
        const tInsert = thicknessMm(insertCtx, insertSpots, footprint);
        const tScrew = thicknessMm(screwCtx, screwSpots, footprint);
        thickness[insertCtx.tag] = tInsert;
        thickness[screwCtx.tag] = tScrew;

        positions.forEach((_, position) => {
          const tI = tInsert[position]!;
          const tS = tScrew[position]!;
          if (insertCtx.kind === 'printed') {
            emit(insertCtx, position, insertSpots[position]!, 'insert-hole', {
              diameterMm: insertHoleMm, depthMm: insertDepthMm, through: false, fit: 'none',
              nominalDiameterMm: insert.holeMm, nominalDepthMm: insert.lengthMm,
            });
            const bossHeight = boss ? Math.max(0, insertDepthMm + MIN_FLOOR_MM - tI) : 0;
            if (bossHeight > 0) {
              emit(insertCtx, position, insertSpots[position]!, 'boss', {
                offsetMm: tI, diameterMm: bossOuterMm, depthMm: bossHeight, through: false, fit: 'none',
                nominalDiameterMm: bossOuterMm, nominalDepthMm: bossHeight,
              });
            }
            const through = bossHeight > 0 || tI < insertDepthMm + SCREW_TAIL_MM + MIN_FLOOR_MM - EPS;
            const tail = through ? tI + bossHeight - insertDepthMm : SCREW_TAIL_MM;
            emit(insertCtx, position, insertSpots[position]!, 'clearance-hole', {
              offsetMm: insertDepthMm, diameterMm: clearanceOf(insertCtx), depthMm: tail, through, fit: 'none',
              nominalDiameterMm: screw.clearanceMm, nominalDepthMm: tail,
            });
          } else if (insertCtx.kind === 'metal') {
            const depth = Math.min(tI, d * MIN_ENGAGEMENT_FACTOR + 1 + SCREW_TAIL_MM);
            emit(insertCtx, position, insertSpots[position]!, 'tapped-hole', {
              diameterMm: screw.tapDrillMm, depthMm: depth, through: tI <= depth + EPS, fit: 'none',
              nominalDiameterMm: screw.tapDrillMm, nominalDepthMm: depth,
            });
          }
          if (screwCtx.kind === 'printed') {
            emit(screwCtx, position, screwSpots[position]!, 'clearance-hole', {
              diameterMm: clearanceOf(screwCtx), depthMm: tS, through: true, fit: 'none',
              nominalDiameterMm: screw.clearanceMm, nominalDepthMm: tS,
            });
            if (tS > CLAMP_FLOOR_MM + EPS) {
              emit(screwCtx, position, screwSpots[position]!, 'counterbore', {
                offsetMm: tS, reverse: true, diameterMm: counterboreMm, depthMm: tS - CLAMP_FLOOR_MM, through: false, fit: 'sliding',
                nominalDiameterMm: screw.headMm, nominalDepthMm: tS - CLAMP_FLOOR_MM,
              });
            }
          } else if (screwCtx.kind === 'metal') {
            emit(screwCtx, position, screwSpots[position]!, 'drilled-hole', {
              diameterMm: screw.clearanceMm, depthMm: tS, through: true, fit: 'none',
              nominalDiameterMm: screw.clearanceMm, nominalDepthMm: tS,
            });
          }
        });

        if (insertCtx.kind !== 'component') {
          const clamp = screwCtx.kind === 'printed' ? Math.min(CLAMP_FLOOR_MM, minOf(tScrew)) : minOf(tScrew);
          const tMin = minOf(tInsert);
          let upper: number;
          if (insertCtx.kind === 'printed') {
            const bossHeight = boss ? Math.max(0, insertDepthMm + MIN_FLOOR_MM - tMin) : 0;
            const through = bossHeight > 0 || tMin < insertDepthMm + SCREW_TAIL_MM + MIN_FLOOR_MM - EPS;
            upper = clamp + insertDepthMm + (through ? tMin + bossHeight - insertDepthMm : SCREW_TAIL_MM);
          } else {
            upper = clamp + Math.min(tMin, d * MIN_ENGAGEMENT_FACTOR + 1 + SCREW_TAIL_MM);
          }
          const lower = clamp + MIN_ENGAGEMENT_FACTOR * d;
          screwLengthMm = screw.lengthsMm.find(length => length >= lower - EPS && length <= upper + EPS) ?? null;
          if (screwLengthMm === null) problems.push({ code: 'NO_LENGTH' });
        }
      }
    }
  } else if (method.kind === 'magnet') {
    const magnet = MAGNETS[method.magnet];
    const active = [sa, sb].filter(ctx => ctx.kind !== 'component');
    noteComponents(sa, sb);
    const diameterOf = (ctx: SideContext) => holeDiameter(ctx, magnet.diameterMm, 'press');
    if (active.length > 0 && lay(method.count, Math.max(...active.map(diameterOf)))) {
      const footprint = Math.max(...active.map(diameterOf));
      for (const ctx of active) {
        const spots = spotsFor(ctx);
        const tAll = thicknessMm(ctx, spots, footprint);
        thickness[ctx.tag] = tAll;
        const depthMm = holeDepth(ctx, magnet.thicknessMm);
        if (tAll.some(t => t < depthMm + MIN_FLOOR_MM - EPS)) problems.push({ code: 'TOO_THIN', side: ctx.tag });
        spots.forEach((spot, position) => emit(ctx, position, spot, 'magnet-pocket', {
          diameterMm: diameterOf(ctx), depthMm, through: false, fit: 'press',
          nominalDiameterMm: magnet.diameterMm, nominalDepthMm: magnet.thicknessMm,
        }));
      }
    }
  } else {
    const pin = PINS[method.pin];
    const active = [sa, sb].filter(ctx => ctx.kind !== 'component');
    noteComponents(sa, sb);
    const fitOf = (ctx: SideContext): Fit => (ctx.tag === 'a' || method.fit === 'press-both' ? 'press' : 'sliding');
    const diameterOf = (ctx: SideContext) => holeDiameter(ctx, pin.diameterMm, fitOf(ctx));
    if (active.length > 0 && lay(method.count, Math.max(...active.map(diameterOf)))) {
      const footprint = Math.max(...active.map(diameterOf));
      const spotsBySide = new Map(active.map(ctx => [ctx.tag, spotsFor(ctx)] as const));
      for (const ctx of active) thickness[ctx.tag] = thicknessMm(ctx, spotsBySide.get(ctx.tag)!, footprint);
      // The longest standard pin whose half fits every side with a floor under it.
      pinLengthMm = [...pin.lengthsMm].reverse().find(length => length >= 2 * pin.diameterMm - EPS
        && active.every(ctx => length / 2 + (ctx.kind === 'printed' ? profile.depthAllowance : 0) + MIN_FLOOR_MM <= minOf(thickness[ctx.tag]) + EPS)) ?? null;
      if (pinLengthMm === null) problems.push({ code: 'NO_LENGTH' });
      else {
        const half = pinLengthMm / 2;
        for (const ctx of active) {
          spotsBySide.get(ctx.tag)!.forEach((spot, position) => emit(ctx, position, spot, 'pin-hole', {
            diameterMm: diameterOf(ctx), depthMm: holeDepth(ctx, half), through: false, fit: fitOf(ctx),
            nominalDiameterMm: pin.diameterMm, nominalDepthMm: half,
          }));
        }
      }
    }
  }

  // Thickness of a side with no positions (glue, or nothing placed): the part's own.
  const side = (ctx: SideContext) => round3(thickness[ctx.tag].length > 0 ? minOf(thickness[ctx.tag]) : partThickness(ctx.part, ctx.joint.face) * 1000);
  return {
    features,
    derived: {
      positions: positions.length,
      screwLengthMm, pinLengthMm, contactAreaMm2: round3(contactAreaMm2), thicknessMm: { a: side(sa), b: side(sb) },
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// 5.5 Collisions
// ---------------------------------------------------------------------------

/** Axis-aligned box of a feature (every feature axis is a part axis). */
function boxOf(feature: JointFeature): { axis: number; min: number[]; max: number[] } {
  const centre = [feature.centre.x, feature.centre.y, feature.centre.z];
  const direction = [feature.axis.x, feature.axis.y, feature.axis.z];
  const axis = direction.findIndex(component => Math.abs(component) > 0.5);
  const min = centre.map(value => value - feature.diameter / 2);
  const max = centre.map(value => value + feature.diameter / 2);
  const end = centre[axis]! + Math.sign(direction[axis]!) * feature.depth;
  min[axis] = Math.min(centre[axis]!, end);
  max[axis] = Math.max(centre[axis]!, end);
  return { axis, min, max };
}

/**
 * Whether two features of one part intersect: along one axis a circle test in the plane plus
 * the depth ranges; along different axes the boxes of the two cylinders.
 */
function collide(x: JointFeature, y: JointFeature): boolean {
  const bx = boxOf(x);
  const by = boxOf(y);
  if (bx.axis !== by.axis) {
    return [0, 1, 2].every(i => Math.min(bx.max[i]!, by.max[i]!) - Math.max(bx.min[i]!, by.min[i]!) > EPS);
  }
  const k = bx.axis;
  if (Math.min(bx.max[k]!, by.max[k]!) - Math.max(bx.min[k]!, by.min[k]!) <= EPS) return false;
  const others = [0, 1, 2].filter(i => i !== k);
  const cx = [x.centre.x, x.centre.y, x.centre.z];
  const cy = [y.centre.x, y.centre.y, y.centre.z];
  const distance = Math.hypot(cx[others[0]!]! - cy[others[0]!]!, cx[others[1]!]! - cy[others[1]!]!);
  return distance < (x.diameter + y.diameter) / 2 - EPS;
}

/**
 * Every joint's features, with an `OVERLAP` problem on both joints (and the side of the
 * part) when features of different joints on one part intersect. Features of one joint never collide.
 */
export function jointFeatures(ws: Workspace, profile: PrinterProfile): FeatureSet {
  const joints = new Map<string, JointFeatureSet>();
  const parts = new Map<string, JointFeature[]>();
  for (const joint of ws.joints) {
    const set = featuresForJoint(ws, joint, profile);
    joints.set(joint.id, set);
    for (const feature of set.features) {
      const key = `${feature.objectId}:${feature.partId}`;
      const list = parts.get(key);
      if (list) list.push(feature);
      else parts.set(key, [feature]);
    }
  }
  const flagged = new Set<string>();
  for (const features of parts.values()) {
    for (let i = 0; i < features.length; i++) {
      for (let j = i + 1; j < features.length; j++) {
        const x = features[i]!;
        const y = features[j]!;
        if (x.jointId === y.jointId || !collide(x, y)) continue;
        for (const feature of [x, y]) {
          const mark = `${feature.jointId}:${feature.side}`;
          if (flagged.has(mark)) continue;
          flagged.add(mark);
          joints.get(feature.jointId)!.problems.push({ code: 'OVERLAP', side: feature.side });
        }
      }
    }
  }
  return { joints, parts };
}
