import * as THREE from 'three';
import type { RingChoice } from './body';
import { assemblyOf, objectMatrix } from './assembly';
import { worldMatrices } from './bounds';
import {
  FACE_MIN_MM, FALLBACK_HALF_WIDTH_MM, FIT_ANGLES, FIT_SLICES, PROFILE_BISECT_STEPS, PROFILE_EDGE_INSET_MM,
  PROFILE_MARCH_STEP_MM, PROFILE_REACH_MM, RING_MAX_MM, RING_MIN_MM,
} from './fit-constants';
import type { ModelSpec, Part } from './model';
import type { Workspace } from './workspace';

/**
 * Ring axis, face and inner profile of a worn object (body-fit design 6.4).
 * Uses only Three.js math classes, so it runs in Node. Lengths are millimetres,
 * model data is metres; the conversion happens once, in `innerProfile`.
 */

type Primitive = Part['primitive'];
type Vec3 = { x: number; y: number; z: number };

/**
 * Whether a point, given in the part's own frame, is inside the solid. The unit of
 * the point and of `dims` only has to be the same. Each test matches the mesh that
 * `createPartGeometry` (src/scene/geometry.ts) builds, centred and scaled to `dims`.
 */
export type InsideTest = (x: number, y: number, z: number, dims: Vec3, tubeRatio: number) => boolean;

const insideBox: InsideTest = (x, y, z, d) => Math.abs(x) <= d.x / 2 && Math.abs(y) <= d.y / 2 && Math.abs(z) <= d.z / 2;

/**
 * One inside test per primitive. A `Record` over the primitive enum: adding a
 * primitive to `PartSchema` fails the type check until its row exists, which is
 * the intended reminder (the same pattern as `CONTACT_FACES` in shared/joint.ts).
 */
export const PRIMITIVE_INSIDE: Record<Primitive, InsideTest> = {
  box: insideBox,
  // A closed hollow box: the outer box touches the skin and the void is never reachable from the ring axis (R84), so it counts as a box.
  shell: insideBox,
  sphere: (x, y, z, d) => (2 * x / d.x) ** 2 + (2 * y / d.y) ** 2 + (2 * z / d.z) ** 2 <= 1,
  cylinder: (x, y, z, d) => Math.abs(y) <= d.y / 2 && (2 * x / d.x) ** 2 + (2 * z / d.z) ** 2 <= 1,
  // ConeGeometry(0.5, 1): radius 0.5 at the base (-y), 0 at the apex (+y). The radius fraction
  // of the size is 0.5 * (0.5 - y / dy). (Design 6.4 writes 0.5 - y / dy, which is twice as wide.)
  cone: (x, y, z, d) => Math.abs(y) <= d.y / 2 && Math.hypot(x / d.x, z / d.z) <= 0.5 * (0.5 - y / d.y),
  // TorusGeometry(0.375, 0.125): axis z, hole diameter half the outer one, z extent a quarter of the width.
  torus: (x, y, z, d) => (Math.hypot(x / d.x, y / d.y) - 0.375) ** 2 + (z * 0.25 / d.z) ** 2 <= 0.125 ** 2,
  // Extruded ring: axis y, hole diameter `tubeRatio` times the outer one.
  tube: (x, y, z, d, ratio) => {
    if (Math.abs(y) > d.y / 2) return false;
    const rho = Math.hypot(x / d.x, z / d.z);
    return rho <= 0.5 && rho >= ratio / 2;
  },
};

/** A part with its world matrix (metres) in the frame of the worn object. */
export interface ProfilePart { part: Part; world: THREE.Matrix4; objectId?: string }
export type PartsInput = ModelSpec | readonly ProfilePart[];

const isModel = (input: PartsInput): input is ModelSpec => 'schemaVersion' in input;

/** The parts of one model with their world matrices. */
export function modelParts(model: ModelSpec, objectId?: string): ProfilePart[] {
  const matrices = worldMatrices(model);
  return model.parts.map(part => ({ part, world: matrices.get(part.id)!, ...(objectId === undefined ? {} : { objectId }) }));
}

/** The parts of a model or of an already prepared list. */
export const profilePartsOf = (input: PartsInput): readonly ProfilePart[] => (isModel(input) ? modelParts(input) : input);

/**
 * The parts worn together with `objectId`: the object and every object joined to
 * it (`assemblyOf`), the others placed in the worn object's frame through their
 * transforms, so a strap joined to a case is worn together. The worn object's
 * parts come first.
 */
export function wornParts(ws: Pick<Workspace, 'objects' | 'joints'>, objectId: string): ProfilePart[] {
  const worn = ws.objects.find(object => object.id === objectId);
  if (!worn) return [];
  const toWorn = objectMatrix(worn.transform).invert();
  const parts = modelParts(worn.model, worn.id);
  for (const id of assemblyOf(ws, objectId)) {
    if (id === objectId) continue;
    const other = ws.objects.find(object => object.id === id);
    if (!other) continue;
    const relative = new THREE.Matrix4().multiplyMatrices(toWorn, objectMatrix(other.transform));
    for (const entry of modelParts(other.model, other.id)) {
      parts.push({ ...entry, world: new THREE.Matrix4().multiplyMatrices(relative, entry.world) });
    }
  }
  return parts;
}

const MM = 1000;

/** A tube or torus part that can serve as the ring. */
export interface RingCandidate {
  partId: string;
  objectId: string | null;
  primitive: 'tube' | 'torus';
  /** Mean of the two inner diameters. */
  innerMm: number;
  /** Half of the band width along the axis. */
  halfWidthMm: number;
  /** In the frame of the worn object, metres. */
  centre: THREE.Vector3;
  /** Unit vector in the frame of the worn object. */
  axis: THREE.Vector3;
}

function candidateOf(entry: ProfilePart): RingCandidate | null {
  const { part, world } = entry;
  const d = part.dimensions;
  let innerMm: number, halfWidthMm: number, local: THREE.Vector3;
  if (part.primitive === 'tube') {
    innerMm = part.tubeRatio * (d.x + d.z) / 2 * MM;
    halfWidthMm = d.y / 2 * MM;
    local = new THREE.Vector3(0, 1, 0);
  } else if (part.primitive === 'torus') {
    innerMm = 0.5 * (d.x + d.y) / 2 * MM;
    halfWidthMm = d.z / 2 * MM;
    local = new THREE.Vector3(0, 0, 1);
  } else return null;
  return {
    partId: part.id, objectId: entry.objectId ?? null, primitive: part.primitive, innerMm, halfWidthMm,
    centre: new THREE.Vector3().setFromMatrixPosition(world),
    axis: local.transformDirection(world),
  };
}

/**
 * Every `tube` and `torus` part whose mean inner diameter is between `RING_MIN_MM`
 * and `RING_MAX_MM`, largest first (ties keep part order).
 */
export function ringCandidates(input: PartsInput): RingCandidate[] {
  const list: RingCandidate[] = [];
  for (const entry of profilePartsOf(input)) {
    const candidate = candidateOf(entry);
    if (candidate && candidate.innerMm >= RING_MIN_MM && candidate.innerMm <= RING_MAX_MM) list.push(candidate);
  }
  return list.map((candidate, order) => ({ candidate, order }))
    .sort((a, b) => b.candidate.innerMm - a.candidate.innerMm || a.order - b.order)
    .map(entry => entry.candidate);
}

/** Frame of the ring in the worn object's frame: origin in metres, unit axes `x = y cross z`. `y` is the ring axis, `z` points to the face. */
export interface RingFrame {
  centre: THREE.Vector3;
  x: THREE.Vector3;
  y: THREE.Vector3;
  z: THREE.Vector3;
}

export interface RingSetup {
  frame: RingFrame;
  /** The ring part, or null when the axis comes from the object's box or the user's axis choice. */
  ringPartId: string | null;
  source: 'part' | 'axis';
  halfWidthMm: number;
}

const partVolume = (part: Part): number => {
  const d = part.dimensions, box = d.x * d.y * d.z;
  switch (part.primitive) {
    case 'box': case 'shell': return box;
    case 'sphere': return box * Math.PI / 6;
    case 'cylinder': return box * Math.PI / 4;
    case 'cone': return box * Math.PI / 12;
    case 'torus': return box * 2 * Math.PI ** 2 * 0.375 * 0.125 ** 2 / 0.25;
    case 'tube': return box * Math.PI * (0.25 - (part.tubeRatio / 2) ** 2);
  }
};

const perpendicular = (v: THREE.Vector3, axis: THREE.Vector3) => v.clone().addScaledVector(axis, -v.dot(axis));

/**
 * The face direction: the volume-weighted mean position of the exterior parts that are
 * not the ring part, seen from the ring centre and projected perpendicular to the axis;
 * when that is shorter than `FACE_MIN_MM`, the object's +y projected; when that is
 * degenerate too, +z. A unit vector perpendicular to `axis`.
 */
export function faceDirection(input: PartsInput, ringPartId: string | null, centre: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 {
  const sum = new THREE.Vector3();
  let weight = 0;
  for (const { part, world } of profilePartsOf(input)) {
    if (part.id === ringPartId || part.role !== 'exterior') continue;
    const volume = partVolume(part);
    sum.addScaledVector(new THREE.Vector3().setFromMatrixPosition(world), volume);
    weight += volume;
  }
  if (weight > 0) {
    const bulk = perpendicular(sum.divideScalar(weight).sub(centre), axis);
    if (bulk.length() * MM >= FACE_MIN_MM) return bulk.normalize();
  }
  const up = perpendicular(new THREE.Vector3(0, 1, 0), axis);
  if (up.length() > 1e-6) return up.normalize();
  return perpendicular(new THREE.Vector3(0, 0, 1), axis).normalize();
}

function unionBox(parts: readonly ProfilePart[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const { part, world } of parts) {
    const half = new THREE.Vector3(part.dimensions.x, part.dimensions.y, part.dimensions.z).multiplyScalar(0.5);
    box.union(new THREE.Box3(half.clone().negate(), half).applyMatrix4(world));
  }
  return box;
}

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) } as const;

function buildFrame(parts: PartsInput, ringPartId: string | null, centre: THREE.Vector3, axis: THREE.Vector3): RingFrame {
  const y = axis.clone().normalize();
  const z = faceDirection(parts, ringPartId, centre, y);
  return { centre: centre.clone(), x: new THREE.Vector3().crossVectors(y, z).normalize(), y, z };
}

/**
 * The ring of a worn object. The user's choice wins: a tube or torus part (any size), or
 * a model axis through the box centre. With no choice the largest candidate is used, and
 * with none the smallest extent of the objects' box gives the axis (band half-width
 * `FALLBACK_HALF_WIDTH_MM`). `null` only when there are no parts. A choice naming a part
 * that is not a tube or torus is ignored.
 */
export function ringFrame(input: PartsInput, choice: RingChoice | null = null): RingSetup | null {
  const parts = profilePartsOf(input);
  if (!parts.length) return null;
  const fromCandidate = (candidate: RingCandidate): RingSetup => ({
    frame: buildFrame(parts, candidate.partId, candidate.centre, candidate.axis),
    ringPartId: candidate.partId, source: 'part', halfWidthMm: candidate.halfWidthMm,
  });
  if (choice?.kind === 'part') {
    const entry = parts.find(item => item.part.id === choice.partId);
    const candidate = entry ? candidateOf(entry) : null;
    if (candidate) return fromCandidate(candidate);
  }
  const box = unionBox(parts);
  const centre = box.getCenter(new THREE.Vector3());
  if (choice?.kind === 'axis') {
    return { frame: buildFrame(parts, null, centre, AXES[choice.axis]), ringPartId: null, source: 'axis', halfWidthMm: FALLBACK_HALF_WIDTH_MM };
  }
  const first = ringCandidates(parts)[0];
  if (first) return fromCandidate(first);
  const size = box.getSize(new THREE.Vector3());
  const axis = size.x <= size.y && size.x <= size.z ? AXES.x : size.y <= size.z ? AXES.y : AXES.z;
  return { frame: buildFrame(parts, null, centre, axis), ringPartId: null, source: 'axis', halfWidthMm: FALLBACK_HALF_WIDTH_MM };
}

/** The inner profile: for each slice and angle, the distance from the axis to the first solid point, or null when nothing is hit. */
export interface InnerProfile {
  /** Ring angles in degrees: `d(theta) = cos(theta) z + sin(theta) x`. */
  anglesDeg: number[];
  /** Position of each slice along the ring axis. */
  sliceMm: number[];
  /** `distanceMm[slice][angle]`; null is open, 0 means the axis itself is inside a part. */
  distanceMm: (number | null)[][];
  halfWidthMm: number;
}

export interface InnerProfileOptions {
  /** Ring angles in degrees; the default is `FIT_ANGLES` steps around the circle starting at the face. */
  anglesDeg?: readonly number[];
  /** Receives the number of inside tests that were run (for the cost test). */
  counter?: { insideTests: number };
}

/** The default sampling: `FIT_ANGLES` directions of equal steps. */
export const defaultAngles = (): number[] => Array.from({ length: FIT_ANGLES }, (_, i) => i * 360 / FIT_ANGLES);

/** Slice positions for a band half-width: both edges (inset by `PROFILE_EDGE_INSET_MM`) and the middle. */
export function sliceOffsets(halfWidthMm: number): number[] {
  const edge = Math.max(0, halfWidthMm - PROFILE_EDGE_INSET_MM);
  return FIT_SLICES === 3 ? [-edge, 0, edge] : Array.from({ length: FIT_SLICES }, (_, i) => -edge + 2 * edge * i / (FIT_SLICES - 1));
}

interface Prepared {
  part: Part;
  test: InsideTest;
  dims: Vec3;
  /** Ring-mm to part-local-mm, column-major 4x4. */
  m: Float64Array;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

const BOX_EPS_MM = 0.01;

function prepare(entry: ProfilePart, frame: RingFrame): Prepared {
  const basis = new THREE.Matrix4().makeBasis(frame.x, frame.y, frame.z);
  // Ring mm -> model m: centre + basis * p / 1000.
  const modelFromRing = new THREE.Matrix4().multiplyMatrices(
    new THREE.Matrix4().makeTranslation(frame.centre.x, frame.centre.y, frame.centre.z),
    new THREE.Matrix4().multiplyMatrices(basis, new THREE.Matrix4().makeScale(1 / MM, 1 / MM, 1 / MM)));
  const ringFromModel = modelFromRing.clone().invert();
  const localFromRing = new THREE.Matrix4().multiplyMatrices(
    new THREE.Matrix4().makeScale(MM, MM, MM), new THREE.Matrix4().multiplyMatrices(entry.world.clone().invert(), modelFromRing));
  const half = new THREE.Vector3(entry.part.dimensions.x, entry.part.dimensions.y, entry.part.dimensions.z).multiplyScalar(0.5);
  const box = new THREE.Box3(half.clone().negate(), half).applyMatrix4(new THREE.Matrix4().multiplyMatrices(ringFromModel, entry.world));
  box.min.addScalar(-BOX_EPS_MM);
  box.max.addScalar(BOX_EPS_MM);
  const d = entry.part.dimensions;
  return {
    part: entry.part, test: PRIMITIVE_INSIDE[entry.part.primitive], dims: { x: d.x * MM, y: d.y * MM, z: d.z * MM },
    m: Float64Array.from(localFromRing.elements), min: box.min, max: box.max,
  };
}

interface Active { prepared: Prepared; t0: number; t1: number; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }

/** The parameter interval where the ray `(sx r, y, cz r)` is inside the box, or null. */
function boxInterval(p: Prepared, y: number, sx: number, cz: number): [number, number] | null {
  if (y < p.min.y || y > p.max.y) return null;
  let t0 = -Infinity, t1 = Infinity;
  for (const [dir, lo, hi] of [[sx, p.min.x, p.max.x], [cz, p.min.z, p.max.z]] as const) {
    if (Math.abs(dir) < 1e-12) {
      if (0 < lo || 0 > hi) return null;
    } else {
      const a = lo / dir, b = hi / dir;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/**
 * The inner profile of the parts around a ring axis (design 6.4). For each slice and
 * angle the search marches outward from the axis in `PROFILE_MARCH_STEP_MM` steps, up
 * to `PROFILE_REACH_MM`, until a point is inside any part, then halves the last step
 * `PROFILE_BISECT_STEPS` times and reports the solid side. A part is only tested where
 * the ray is inside its box. The march can step over a wall thinner than one step.
 */
export function innerProfile(
  parts: readonly ProfilePart[], frame: RingFrame, halfWidthMm: number, options: InnerProfileOptions = {},
): InnerProfile {
  const anglesDeg = [...(options.anglesDeg ?? defaultAngles())];
  const sliceMm = sliceOffsets(halfWidthMm);
  const prepared = parts.map(entry => prepare(entry, frame));
  const counter = options.counter;
  const distanceMm: (number | null)[][] = [];
  for (const y of sliceMm) {
    const row: (number | null)[] = [];
    for (const angle of anglesDeg) {
      const theta = angle * Math.PI / 180;
      const sx = Math.sin(theta), cz = Math.cos(theta);
      const active: Active[] = [];
      for (const p of prepared) {
        const interval = boxInterval(p, y, sx, cz);
        if (!interval || interval[1] < 0 || interval[0] > PROFILE_REACH_MM) continue;
        const m = p.m;
        active.push({
          prepared: p, t0: interval[0], t1: interval[1],
          ox: m[4]! * y + m[12]!, oy: m[5]! * y + m[13]!, oz: m[6]! * y + m[14]!,
          dx: m[0]! * sx + m[8]! * cz, dy: m[1]! * sx + m[9]! * cz, dz: m[2]! * sx + m[10]! * cz,
        });
      }
      row.push(active.length ? march(active, counter) : null);
    }
    distanceMm.push(row);
  }
  return { anglesDeg, sliceMm, distanceMm, halfWidthMm };
}

function hit(active: readonly Active[], r: number, counter: { insideTests: number } | undefined): boolean {
  for (const a of active) {
    if (r < a.t0 || r > a.t1) continue;
    if (counter) counter.insideTests++;
    if (a.prepared.test(a.ox + a.dx * r, a.oy + a.dy * r, a.oz + a.dz * r, a.prepared.dims, a.prepared.part.tubeRatio)) return true;
  }
  return false;
}

function march(active: readonly Active[], counter: { insideTests: number } | undefined): number | null {
  const start = Math.max(0, Math.floor(Math.min(...active.map(a => a.t0)) / PROFILE_MARCH_STEP_MM)) * PROFILE_MARCH_STEP_MM;
  for (let r = start; r <= PROFILE_REACH_MM; r += PROFILE_MARCH_STEP_MM) {
    if (!hit(active, r, counter)) continue;
    if (r === 0) return 0;
    let lo = r - PROFILE_MARCH_STEP_MM, hi = r;
    for (let i = 0; i < PROFILE_BISECT_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (hit(active, mid, counter)) hi = mid; else lo = mid;
    }
    return hi;
  }
  return null;
}

/** True when the ring axis itself is inside a part on some slice: the ring is blocked (shown as 「環內有零件擋住」). */
export function axisBlocked(profile: InnerProfile): boolean {
  return profile.distanceMm.some(row => row.length > 0 && row.every(value => value === 0));
}
