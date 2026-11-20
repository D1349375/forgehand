import * as THREE from 'three';
import { assemblyOf, moveRigid, objectMatrix, transformOfMatrix } from './assembly';
import { worldMatrices } from './bounds';
import {
  CENTRE_SNAP_MM, CONTACT_ANGLE_DEG, CONTACT_GAP_MM, DISC_SEGMENTS, MIN_CONTACT_MM2, SNAP_ANGLE_DEG, SNAP_DISTANCE_MM,
  SNAP_PENETRATION_MM, SNAP_RELEASE_DEG, SNAP_RELEASE_MM, SNAP_SETTLE_MS,
} from './joint-constants';
import { faceShape, type FaceId, type FaceShape, type JointSide } from './joint';
import type { ModelSpec, Part } from './model';
import {
  WorkspaceError, assertWorkspace, findObject,
  type ObjectTransform, type SceneObject, type Workspace,
} from './workspace';

/**
 * Contact faces, touching, facing pairs, snapping, alignment and re-alignment
 * (assembly-joints requirements 22 to 28, design 4). Pure: Three.js math classes
 * only. Lengths in the geometry are metres; `gapMm`, `areaMm2` and the like are
 * millimetres, as named.
 */

const EPS = 1e-9;
const FACE_ORDER: readonly FaceId[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;
const COS_SNAP = Math.cos(THREE.MathUtils.degToRad(SNAP_ANGLE_DEG));

/** Messages of a failed `planJoin` (design 4.6). */
export const JOIN_MESSAGES = {
  NO_CONTACT_FACE: '這兩個零件沒有可以接合的平面。',
  CANNOT_ALIGN: '兩個面的方向差太多，請先旋轉物件。',
  NOT_TOUCHING: '這兩個面沒有貼合；已接合在一起的零件只能在接觸面上新增接合。',
} as const;

// ---------------------------------------------------------------------------
// 4.1 World faces
// ---------------------------------------------------------------------------

export interface LocalFace {
  /** Index of the face's axis: 0 = x, 1 = y, 2 = z. */
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  shape: FaceShape;
  centre: THREE.Vector3;
  normal: THREE.Vector3;
  /** In-plane directions: axes `(axis + 1) % 3` and `(axis + 2) % 3`. */
  u: THREE.Vector3;
  v: THREE.Vector3;
  /** Half extents along `u` and `v`; a disc or ring is the ellipse with these radii. */
  half: { u: number; v: number };
  /** Ring only: the inner ellipse's size relative to the outer one (`tubeRatio`). */
  inner: number | null;
}

/** The centre, normal, `u` and `v` of a `WorldFace` are world coordinates; `half` and `inner` stay local. */
export interface WorldFace extends LocalFace {
  side: JointSide;
  /** Object matrix times the part's world matrix: part-local to world. */
  matrix: THREE.Matrix4;
}

const unit = (axis: number) => new THREE.Vector3().setComponent(axis, 1);

/** A part's contact face in its own axes, matching the display geometry after scaling. `null` for a face that is not a contact face. */
export function localFace(part: Part, face: FaceId): LocalFace | null {
  const shape = faceShape(part.primitive, face);
  if (shape === null) return null;
  const sign: 1 | -1 = face[0] === '+' ? 1 : -1;
  const axis = AXIS_INDEX[face[1] as 'x' | 'y' | 'z'];
  const dims = [part.dimensions.x, part.dimensions.y, part.dimensions.z];
  const uAxis = (axis + 1) % 3;
  const vAxis = (axis + 2) % 3;
  return {
    axis, sign, shape,
    centre: unit(axis).multiplyScalar((sign * dims[axis]!) / 2),
    normal: unit(axis).multiplyScalar(sign),
    u: unit(uAxis),
    v: unit(vAxis),
    half: { u: dims[uAxis]! / 2, v: dims[vAxis]! / 2 },
    inner: shape === 'ring' ? part.tubeRatio : null,
  };
}

const partMatrices = new WeakMap<ModelSpec, Map<string, THREE.Matrix4>>();

/** Part matrices of a model, cached per model object (models are never mutated). Callers must not change the result. */
function partMatrix(model: ModelSpec, partId: string): THREE.Matrix4 | undefined {
  let matrices = partMatrices.get(model);
  if (!matrices) {
    matrices = worldMatrices(model);
    partMatrices.set(model, matrices);
  }
  return matrices.get(partId);
}

function buildWorldFace(objectId: string, object: SceneObject, objectMat: THREE.Matrix4, part: Part, face: FaceId): WorldFace | null {
  const local = localFace(part, face);
  const part4 = partMatrix(object.model, part.id);
  if (!local || !part4) return null;
  const matrix = objectMat.clone().multiply(part4);
  return {
    ...local,
    side: { objectId, partId: part.id, face },
    matrix,
    centre: local.centre.applyMatrix4(matrix),
    normal: local.normal.transformDirection(matrix),
    u: local.u.transformDirection(matrix),
    v: local.v.transformDirection(matrix),
  };
}

/** World face of a part, with `transform` (a previewed pose) in place of the object's own when given. */
export function worldFace(object: SceneObject, part: Part, face: FaceId, transform?: ObjectTransform): WorldFace | null {
  return buildWorldFace(object.id, object, objectMatrix(transform ?? object.transform), part, face);
}

function ellipse(face: WorldFace, ratio: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let at = 0; at < DISC_SEGMENTS; at++) {
    const angle = (2 * Math.PI * at) / DISC_SEGMENTS;
    points.push(face.centre.clone()
      .addScaledVector(face.u, face.half.u * ratio * Math.cos(angle))
      .addScaledVector(face.v, face.half.v * ratio * Math.sin(angle)));
  }
  return points;
}

/** Outline of the face's outer edge: 4 corners for a rectangle, `DISC_SEGMENTS` points on the ellipse for a disc or ring. */
export function facePolygon(face: WorldFace): THREE.Vector3[] {
  if (face.shape !== 'rect') return ellipse(face, 1);
  return ([[1, 1], [-1, 1], [-1, -1], [1, -1]] as const).map(([x, y]) =>
    face.centre.clone().addScaledVector(face.u, x * face.half.u).addScaledVector(face.v, y * face.half.v));
}

// ---------------------------------------------------------------------------
// 4.2 Touching and the contact region
// ---------------------------------------------------------------------------

export interface P2 { x: number; y: number }

export interface Region {
  /** Plane frame of side a's face: a point is `origin + x * u + y * v`, in metres. */
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  /** Convex outline of the overlap, counter-clockwise in the frame. For a ring it is the outer overlap; the hole is only taken off `areaMm2`. */
  polygon: P2[];
  areaMm2: number;
}

const area2 = (polygon: readonly P2[]): number => {
  let sum = 0;
  for (let at = 0; at < polygon.length; at++) {
    const p = polygon[at]!;
    const q = polygon[(at + 1) % polygon.length]!;
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
};

const counterClockwise = (polygon: P2[]): P2[] => (area2(polygon) < 0 ? [...polygon].reverse() : polygon);

/** Sutherland-Hodgman: `subject` clipped by the convex, counter-clockwise `clip`. */
function clipConvex(subject: readonly P2[], clip: readonly P2[]): P2[] {
  let output = [...subject];
  for (let edge = 0; edge < clip.length && output.length > 0; edge++) {
    const c0 = clip[edge]!;
    const c1 = clip[(edge + 1) % clip.length]!;
    const ex = c1.x - c0.x;
    const ey = c1.y - c0.y;
    const side = (p: P2) => ex * (p.y - c0.y) - ey * (p.x - c0.x);
    const input = output;
    output = [];
    for (let at = 0; at < input.length; at++) {
      const current = input[at]!;
      const previous = input[(at + input.length - 1) % input.length]!;
      const sc = side(current);
      const sp = side(previous);
      const currentIn = sc >= -1e-14;
      const previousIn = sp >= -1e-14;
      if (currentIn !== previousIn) {
        const t = sp / (sp - sc);
        output.push({ x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y) });
      }
      if (currentIn) output.push(current);
    }
  }
  return output;
}

function centroid(polygon: readonly P2[]): P2 {
  const area = area2(polygon);
  if (Math.abs(area) < 1e-15) {
    return { x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length, y: polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length };
  }
  let cx = 0;
  let cy = 0;
  for (let at = 0; at < polygon.length; at++) {
    const p = polygon[at]!;
    const q = polygon[(at + 1) % polygon.length]!;
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

/**
 * Overlap of two faces in side a's plane (b is projected onto it along a's
 * normal). Both outlines are convex, so one clip gives the overlap. A ring
 * subtracts its hole: the area is |Oa and Ob| - |Ia and Ob| - |Ib and Oa| + |Ia and Ib|.
 * `null` when the overlap is empty.
 */
export function contactRegion(a: WorldFace, b: WorldFace): Region | null {
  // Cheap rejection: the faces' bounding boxes in a's frame must overlap.
  {
    const dx = b.centre.x - a.centre.x;
    const dy = b.centre.y - a.centre.y;
    const dz = b.centre.z - a.centre.z;
    const reach = (axis: THREE.Vector3) =>
      Math.abs(b.u.dot(axis)) * b.half.u + Math.abs(b.v.dot(axis)) * b.half.v;
    if (Math.abs(dx * a.u.x + dy * a.u.y + dz * a.u.z) >= a.half.u + reach(a.u)
      || Math.abs(dx * a.v.x + dy * a.v.y + dz * a.v.z) >= a.half.v + reach(a.v)) return null;
  }
  /** Outline of a face in a's plane frame, counter-clockwise, without allocating 3D vectors. */
  const project = (face: WorldFace, ratio: number | null): P2[] => {
    const ox = face.centre.x - a.centre.x;
    const oy = face.centre.y - a.centre.y;
    const oz = face.centre.z - a.centre.z;
    const cx = ox * a.u.x + oy * a.u.y + oz * a.u.z;
    const cy = ox * a.v.x + oy * a.v.y + oz * a.v.z;
    const ux = face.u.x * a.u.x + face.u.y * a.u.y + face.u.z * a.u.z;
    const uy = face.u.x * a.v.x + face.u.y * a.v.y + face.u.z * a.v.z;
    const vx = face.v.x * a.u.x + face.v.y * a.u.y + face.v.z * a.u.z;
    const vy = face.v.x * a.v.x + face.v.y * a.v.y + face.v.z * a.v.z;
    const at = (s: number, t: number): P2 => ({ x: cx + s * ux + t * vx, y: cy + s * uy + t * vy });
    const points: P2[] = [];
    if (ratio === null && face.shape === 'rect') {
      points.push(at(face.half.u, face.half.v), at(-face.half.u, face.half.v), at(-face.half.u, -face.half.v), at(face.half.u, -face.half.v));
    } else {
      const scale = ratio ?? 1;
      for (let step = 0; step < DISC_SEGMENTS; step++) {
        const angle = (2 * Math.PI * step) / DISC_SEGMENTS;
        points.push(at(face.half.u * scale * Math.cos(angle), face.half.v * scale * Math.sin(angle)));
      }
    }
    return counterClockwise(points);
  };
  const outerA = project(a, null);
  const outerB = project(b, null);
  const outer = clipConvex(outerB, outerA);
  if (outer.length < 3) return null;
  let area = area2(outer);
  if (a.inner !== null) area -= area2(clipConvex(outerB, project(a, a.inner)));
  if (b.inner !== null) area -= area2(clipConvex(project(b, b.inner), outerA));
  if (a.inner !== null && b.inner !== null) area += area2(clipConvex(project(b, b.inner), project(a, a.inner)));
  const areaMm2 = area * 1e6;
  if (areaMm2 < 1e-6) return null;
  return { origin: a.centre.clone(), normal: a.normal.clone(), u: a.u.clone(), v: a.v.clone(), polygon: outer, areaMm2 };
}

/** Area centroid of a region's outline, in the region's frame (metres). */
export const regionCentroid = (region: Pick<Region, 'polygon'>): { x: number; y: number } => centroid(region.polygon);

const angleBetweenOpposite = (a: THREE.Vector3, b: THREE.Vector3): number =>
  THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, -a.dot(b)))));

/** Gap, in metres along a's normal, from `point` (on a's plane) to b's plane. Positive when b is in front of a. */
function gapAt(a: WorldFace, b: WorldFace, point: THREE.Vector3): number {
  const denominator = b.normal.dot(a.normal);
  if (Math.abs(denominator) < 1e-9) return Infinity;
  return b.normal.dot(b.centre.clone().sub(point)) / denominator;
}

/**
 * Whether two faces touch (requirement 22): normals opposite within `CONTACT_ANGLE_DEG`,
 * gap at the overlap's centroid within `CONTACT_GAP_MM` in either direction, overlap of at
 * least `MIN_CONTACT_MM2`. The gap is positive when b is in front of a. `region` is the
 * overlap whenever there is one, also when `ok` is false.
 */
export function touching(a: WorldFace, b: WorldFace): { ok: boolean; gapMm: number; angleDeg: number; region: Region | null } {
  const angleDeg = angleBetweenOpposite(a.normal, b.normal);
  const region = contactRegion(a, b);
  const at = region ? centroid(region.polygon) : { x: 0, y: 0 };
  const point = a.centre.clone().addScaledVector(a.u, at.x).addScaledVector(a.v, at.y);
  const gapMm = gapAt(a, b, point) * 1000;
  const ok = region !== null && angleDeg <= CONTACT_ANGLE_DEG + EPS && Math.abs(gapMm) <= CONTACT_GAP_MM + EPS
    && region.areaMm2 >= MIN_CONTACT_MM2 - EPS;
  return { ok, gapMm, angleDeg, region };
}

// ---------------------------------------------------------------------------
// 4.3 Facing pairs and snap candidates
// ---------------------------------------------------------------------------

export interface PairMetrics {
  a: JointSide;
  b: JointSide;
  /** Distance of b's face centre from a's plane along a's normal; negative when b's face is inside a. */
  gapMm: number;
  /** Angle between a's normal and the opposite of b's normal. */
  angleDeg: number;
  /** Overlap of the two faces projected onto a's plane. */
  overlapMm2: number;
  /** `objectId:partId:face|objectId:partId:face`, side a first; identifies a pair for the hysteresis. */
  key: string;
}

const sideKey = (side: JointSide) => `${side.objectId}:${side.partId}:${side.face}`;
const pairKey = (a: JointSide, b: JointSide) => `${sideKey(a)}|${sideKey(b)}`;

interface Target { objectId: string; partId?: string }
type Poses = ReadonlyMap<string, ObjectTransform>;

function facesOf(ws: Workspace, target: Target, poses?: Poses): WorldFace[] {
  const object = findObject(ws, target.objectId);
  if (!object) return [];
  const matrix = objectMatrix(poses?.get(object.id) ?? object.transform);
  const faces: WorldFace[] = [];
  for (const part of object.model.parts) {
    if (target.partId === undefined ? part.role !== 'exterior' : part.id !== target.partId) continue;
    for (const face of FACE_ORDER) {
      const built = buildWorldFace(object.id, object, matrix, part, face);
      if (built) faces.push(built);
    }
  }
  return faces;
}

const between = new THREE.Vector3();

/** Metrics of a pair whose normals already passed the angle test (`dot`), or `null` when a later test fails. `radii` is the sum of the faces' outer radii. */
function evaluate(a: WorldFace, b: WorldFace, dot: number, radii: number, mode: 'facing' | 'snap'): PairMetrics | null {
  between.subVectors(b.centre, a.centre);
  const gapMm = between.dot(a.normal) * 1000;
  if (mode === 'facing') {
    if (gapMm < -SNAP_PENETRATION_MM || -between.dot(b.normal) * 1000 < -SNAP_PENETRATION_MM) return null;
  } else if (gapMm < -SNAP_PENETRATION_MM || gapMm > SNAP_DISTANCE_MM) return null;
  const along = between.dot(a.normal);
  if (Math.sqrt(Math.max(0, between.lengthSq() - along * along)) > radii) return null;
  const region = contactRegion(a, b);
  if (!region || region.areaMm2 < MIN_CONTACT_MM2) return null;
  return {
    a: a.side, b: b.side, gapMm, angleDeg: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, -dot))), overlapMm2: region.areaMm2,
    key: pairKey(a.side, b.side),
  };
}

const bucket = (value: number, scale: number) => Math.round(value * scale);

/** Smallest gap (by size), then smallest angle, then largest overlap, then the key. Values are bucketed so float noise cannot reorder ties. */
function compareMetrics(x: PairMetrics, y: PairMetrics): number {
  return bucket(Math.abs(x.gapMm), 1e4) - bucket(Math.abs(y.gapMm), 1e4)
    || bucket(x.angleDeg, 1e4) - bucket(y.angleDeg, 1e4)
    || bucket(y.overlapMm2, 1e3) - bucket(x.overlapMm2, 1e3)
    || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
}

function pairsBetween(ws: Workspace, a: Target, b: Target, poses: Poses | undefined, mode: 'facing' | 'snap'): PairMetrics[] {
  const facesA = facesOf(ws, a, poses);
  const facesB = facesOf(ws, b, poses);
  const result: PairMetrics[] = [];
  // Plain arrays for the hot loop: the angle test rejects most pairs before anything is allocated.
  const nb = new Float64Array(facesB.length * 4);
  facesB.forEach((face, at) => {
    nb[at * 4] = face.normal.x;
    nb[at * 4 + 1] = face.normal.y;
    nb[at * 4 + 2] = face.normal.z;
    nb[at * 4 + 3] = Math.hypot(face.half.u, face.half.v);
  });
  for (const fa of facesA) {
    const { x, y, z } = fa.normal;
    const radiusA = Math.hypot(fa.half.u, fa.half.v);
    for (let at = 0; at < facesB.length; at++) {
      const dot = x * nb[at * 4]! + y * nb[at * 4 + 1]! + z * nb[at * 4 + 2]!;
      if (dot > -COS_SNAP) continue;
      const fb = facesB[at]!;
      if (fa.side.objectId === fb.side.objectId && fa.side.partId === fb.side.partId) continue;
      const metrics = evaluate(fa, fb, dot, radiusA + nb[at * 4 + 3]!, mode);
      if (metrics) result.push(metrics);
    }
  }
  return result;
}

/**
 * Facing pairs of two objects' exterior parts (or of the given parts), ranked, with no
 * distance limit: each face centre lies in front of the other face (within
 * `SNAP_PENETRATION_MM`), the normals are within `SNAP_ANGLE_DEG` and the projected
 * overlap is at least `MIN_CONTACT_MM2`.
 */
export function facingPairs(ws: Workspace, a: Target, b: Target, transforms?: Poses): PairMetrics[] {
  return pairsBetween(ws, a, b, transforms, 'facing').sort(compareMetrics);
}

/** The best pair within the engage limits (`SNAP_PENETRATION_MM` to `SNAP_DISTANCE_MM`), or `null`. */
export function snapCandidates(ws: Workspace, aObjectId: string, bObjectId: string, transforms: Poses): PairMetrics | null {
  if (aObjectId === bObjectId) return null;
  const pairs = pairsBetween(ws, { objectId: aObjectId }, { objectId: bObjectId }, transforms, 'snap');
  let best: PairMetrics | null = null;
  for (const pair of pairs) if (best === null || compareMetrics(pair, best) < 0) best = pair;
  return best;
}

function faceOfSide(ws: Workspace, side: JointSide, poses?: Poses): WorldFace | null {
  const object = findObject(ws, side.objectId);
  const part = object?.model.parts.find(candidate => candidate.id === side.partId);
  return object && part ? worldFace(object, part, side.face, poses?.get(object.id)) : null;
}

/** Metrics of one named pair, with no limits; `null` when a side does not exist or is not a contact face. */
export function measurePair(ws: Workspace, a: JointSide, b: JointSide, transforms?: Poses): PairMetrics | null {
  const fa = faceOfSide(ws, a, transforms);
  const fb = faceOfSide(ws, b, transforms);
  if (!fa || !fb) return null;
  const dot = fa.normal.dot(fb.normal);
  return {
    a, b,
    gapMm: fb.centre.clone().sub(fa.centre).dot(fa.normal) * 1000,
    angleDeg: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, -dot)))),
    overlapMm2: contactRegion(fa, fb)?.areaMm2 ?? 0,
    key: pairKey(a, b),
  };
}

// ---------------------------------------------------------------------------
// 4.4 Alignment
// ---------------------------------------------------------------------------

/**
 * New transform for side b's object: rotated about b's face centre by the smallest
 * rotation that makes the normals exactly opposite, moved along a's normal so the planes
 * meet, and centred in the plane when the face centres are closer than `CENTRE_SNAP_MM`.
 * Side a never moves. `null` when the angle exceeds `SNAP_ANGLE_DEG`, when both sides
 * are one object, or when the result leaves the transform limits. Rounded like other
 * transforms; a last correction along the normal removes the gap that rounding adds.
 */
export function alignTransform(ws: Workspace, a: JointSide, b: JointSide, transforms?: Poses): ObjectTransform | null {
  if (a.objectId === b.objectId) return null;
  const objectB = findObject(ws, b.objectId);
  const partB = objectB?.model.parts.find(part => part.id === b.partId);
  const fa = faceOfSide(ws, a, transforms);
  const fb = faceOfSide(ws, b, transforms);
  if (!objectB || !partB || !fa || !fb) return null;
  if (angleBetweenOpposite(fa.normal, fb.normal) > SNAP_ANGLE_DEG + EPS) return null;

  const current = transforms?.get(b.objectId) ?? objectB.transform;
  const pivot = fb.centre;
  const rotation = new THREE.Quaternion().setFromUnitVectors(fb.normal, fa.normal.clone().negate());
  const matrix = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rotation))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    .multiply(objectMatrix(current));

  // The pivot did not move, so the planes meet after moving by the gap along a's normal.
  const offset = fa.centre.clone().sub(pivot);
  const along = offset.dot(fa.normal);
  const shift = fa.normal.clone().multiplyScalar(along);
  const inPlane = offset.clone().sub(shift);
  if (inPlane.length() * 1000 < CENTRE_SNAP_MM) shift.add(inPlane);
  matrix.premultiply(new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z));

  let result = transformOfMatrix(matrix);
  if (!result) return null;
  // Rounding the rotation to 0.01 degrees moves the face a little: correct the gap once.
  const rounded = faceOfSide(ws, b, new Map<string, ObjectTransform>([...(transforms ?? []), [b.objectId, result]]));
  if (rounded) {
    const residual = rounded.centre.clone().sub(fa.centre).dot(fa.normal);
    if (Math.abs(residual) > EPS) {
      const corrected = transformOfMatrix(new THREE.Matrix4().makeTranslation(
        -residual * fa.normal.x, -residual * fa.normal.y, -residual * fa.normal.z).multiply(objectMatrix(result)));
      if (!corrected) return null;
      result = corrected;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 4.5 Snap hysteresis
// ---------------------------------------------------------------------------

export interface SnapState {
  key: string | null;
  /** Time (ms) the current key was first seen. */
  since: number;
  ready: boolean;
  /** Another pair that has been better than the ready one, and since when. */
  rival: { key: string; since: number } | null;
}

export const initialSnapState: SnapState = Object.freeze({ key: null, since: 0, ready: false, rival: null });

const fresh = (best: PairMetrics | null, now: number): SnapState =>
  best ? { key: best.key, since: now, ready: false, rival: null } : initialSnapState;

/**
 * One step of the stable snap state for live use. `best` is `snapCandidates` (engage
 * limits); `held` is `measurePair` for `state.key` (no limits). A pair becomes ready after
 * holding for `SNAP_SETTLE_MS`; a ready pair is released when `held` is missing, further
 * than `SNAP_RELEASE_MM` (in either direction) or at more than `SNAP_RELEASE_DEG`; a
 * different best pair replaces it after holding for `SNAP_SETTLE_MS` as the rival.
 */
export function snapStep(state: SnapState, best: PairMetrics | null, held: PairMetrics | null, now: number): SnapState {
  if (!state.ready) {
    if (best === null) return initialSnapState;
    if (best.key !== state.key) return fresh(best, now);
    return now - state.since >= SNAP_SETTLE_MS ? { ...state, ready: true, rival: null } : state;
  }
  if (!held || Math.abs(held.gapMm) > SNAP_RELEASE_MM || held.angleDeg > SNAP_RELEASE_DEG) return fresh(best, now);
  if (best === null || best.key === state.key) return state.rival ? { ...state, rival: null } : state;
  if (state.rival?.key !== best.key) return { ...state, rival: { key: best.key, since: now } };
  if (now - state.rival.since >= SNAP_SETTLE_MS) return { key: best.key, since: now, ready: true, rival: null };
  return state;
}

// ---------------------------------------------------------------------------
// 4.6 Planning a join and re-alignment
// ---------------------------------------------------------------------------

export type JoinPlan =
  | { ok: true; a: JointSide; b: JointSide; move: { objectId: string; transform: ObjectTransform } | null; pairs: PairMetrics[] }
  | { ok: false; code: 'NO_CONTACT_FACE' | 'CANNOT_ALIGN' | 'NOT_TOUCHING'; message: string };

const failure = (code: 'NO_CONTACT_FACE' | 'CANNOT_ALIGN' | 'NOT_TOUCHING'): JoinPlan => ({ ok: false, code, message: JOIN_MESSAGES[code] });

function requireObject(ws: Workspace, id: string): void {
  if (!findObject(ws, id)) throw new WorkspaceError('UNKNOWN_OBJECT');
}

const touchesExactly = (ws: Workspace, pair: PairMetrics, poses?: Poses): boolean => {
  const fa = faceOfSide(ws, pair.a, poses);
  const fb = faceOfSide(ws, pair.b, poses);
  return !!fa && !!fb && touching(fa, fb).ok;
};

/**
 * Plans one join (requirements 26, 27, 52). With both sides named in full, those faces are
 * used; otherwise the facing pairs are ranked (filtered by the faces or parts given) and
 * `pairIndex` picks one. Objects of one assembly must already touch and nothing moves; for
 * others `move` is the aligned transform of b's object (`null` when the faces already
 * touch). Unknown objects throw `UNKNOWN_OBJECT`.
 */
export function planJoin(
  ws: Workspace,
  a: { objectId: string; partId?: string; face?: FaceId },
  b: { objectId: string; partId?: string; face?: FaceId },
  pairIndex = 0,
): JoinPlan {
  requireObject(ws, a.objectId);
  requireObject(ws, b.objectId);
  const complete = a.partId !== undefined && a.face !== undefined && b.partId !== undefined && b.face !== undefined;
  let pairs: PairMetrics[];
  if (complete) {
    const measured = measurePair(ws, { objectId: a.objectId, partId: a.partId!, face: a.face! }, { objectId: b.objectId, partId: b.partId!, face: b.face! });
    if (!measured || (a.objectId === b.objectId && a.partId === b.partId)) return failure('NO_CONTACT_FACE');
    pairs = [measured];
  } else {
    pairs = facingPairs(ws, a, b).filter(pair => (a.face === undefined || pair.a.face === a.face) && (b.face === undefined || pair.b.face === b.face));
  }
  if (pairs.length === 0) return failure('NO_CONTACT_FACE');

  const together = a.objectId === b.objectId || assemblyOf(ws, a.objectId).includes(b.objectId);
  if (together) {
    // Loose pre-filter on the cheap metrics, then the exact rule.
    const close = pairs.filter(pair => Math.abs(pair.gapMm) <= 1 && pair.angleDeg <= 3).filter(pair => touchesExactly(ws, pair));
    const chosen = complete ? (close[0] ?? null) : (close[pairIndex] ?? null);
    if (!chosen) return failure(complete || close.length === 0 ? 'NOT_TOUCHING' : 'NO_CONTACT_FACE');
    return { ok: true, a: chosen.a, b: chosen.b, move: null, pairs: complete ? [chosen] : close };
  }

  const chosen = pairs[pairIndex];
  if (!chosen) return failure('NO_CONTACT_FACE');
  if (touchesExactly(ws, chosen)) return { ok: true, a: chosen.a, b: chosen.b, move: null, pairs };
  const aligned = alignTransform(ws, chosen.a, chosen.b);
  if (!aligned) return failure('CANNOT_ALIGN');
  // The aligned faces must still overlap enough to be a contact.
  if (!touchesExactly(ws, chosen, new Map([[chosen.b.objectId, aligned]]))) return failure('NO_CONTACT_FACE');
  return { ok: true, a: chosen.a, b: chosen.b, move: { objectId: chosen.b.objectId, transform: aligned }, pairs };
}

const sameVector = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => p.x === q.x && p.y === q.y && p.z === q.z;

/**
 * Applies the alignment of requirement 24 to a joint's own faces, whatever the distance
 * (normals within `SNAP_ANGLE_DEG`). Moves side b's object with every object that stays
 * connected to it without this joint. Throws `UNKNOWN_JOINT`, `LINKED` (side a's object is
 * among them, which includes a joint inside one object), `CANNOT_ALIGN` (angle too large) or
 * `INVALID_WORKSPACE` (a member would leave the limits). Returns the same workspace when
 * nothing moves.
 */
export function realignJoint(ws: Workspace, jointId: string): Workspace {
  const joint = ws.joints.find(candidate => candidate.id === jointId);
  if (!joint) throw new WorkspaceError('UNKNOWN_JOINT');
  const members = assemblyOf(ws, joint.b.objectId, jointId);
  if (members.includes(joint.a.objectId)) throw new WorkspaceError('LINKED');
  const aligned = alignTransform(ws, joint.a, joint.b);
  if (!aligned) throw new WorkspaceError('CANNOT_ALIGN');
  const moves = moveRigid(ws, members, joint.b.objectId, aligned);
  if (!moves) throw new WorkspaceError('INVALID_WORKSPACE');
  let changed = false;
  const objects = ws.objects.map(object => {
    const moved = moves.get(object.id);
    if (!moved || (sameVector(moved.position, object.transform.position) && sameVector(moved.rotation, object.transform.rotation))) return object;
    changed = true;
    return { ...object, transform: moved };
  });
  if (!changed) return ws;
  const next = { ...ws, objects };
  assertWorkspace(next);
  return next;
}
