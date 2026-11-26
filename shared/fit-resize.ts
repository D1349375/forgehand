import * as THREE from 'three';
import { ellipseRadius, offsetForPerimeter } from './ellipse';
import { applyEditPlan, type EditOperation, type EditPlan } from './edit';
import { partBoxes, worldMatrices } from './bounds';
import { ATTACH_GAP_MM, RESIZE_AXIS_TOLERANCE_DEG, TUBE_RATIO_MAX, TUBE_RATIO_MIN } from './fit-constants';
import { ringFrame } from './fit-geometry';
import { FIT_TEXT } from './fit-text';
import type { ModelSpec, Part } from './model';

/**
 * Local resize of a tube or torus ring so that its inner perimeter is the wrist's plus the
 * clearance, with the parts attached to it moved outward by the same amount (design 6.6).
 * Pure; no joint is re-aligned here (the tool does that in T6).
 */

export type FitResizeCode = 'NO_RING' | 'NOT_RESIZABLE' | 'FIT_OUT_OF_RANGE';

export class FitResizeError extends Error {
  readonly code: FitResizeCode;
  constructor(code: FitResizeCode, message: string) {
    super(message);
    this.name = 'FitResizeError';
    this.code = code;
  }
}

export interface ResizeRingInput {
  model: ModelSpec;
  /** A `tube` or `torus` part of the model. */
  ringPartId: string;
  /** The wrist ellipse at the band position: width (thumb to little finger) and thickness, millimetres. */
  widthMm: number;
  thicknessMm: number;
  /** The effective clearance in millimetres of circumference (design 6.2). */
  clearanceMm: number;
  /** The placement's roll in degrees. */
  rollDeg: number;
}

export interface ResizeRingResult {
  /** `upsert` of every part that changed; `operations` is empty when the ring already has this size. */
  plan: EditPlan;
  /** The model with the plan applied; the input model when nothing changed. */
  model: ModelSpec;
  changed: boolean;
  ringPartId: string;
  /** The inner semi-axes the ring was given, millimetres: across the wrist and toward the face. */
  innerSemiAxesMm: { across: number; face: number };
  /** The ring's orientation did not match the wrist, so the inner ring is a circle (design 6.6, step 2). */
  roundedToCircle: boolean;
  /** The user-facing note for `roundedToCircle`, else null. */
  note: string | null;
}

const MM = 1000;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6 + 0;
const deg = (rad: number) => rad * 180 / Math.PI;
/** World matrices carry no scale, so their rotation is orthonormal and its transpose is its inverse. */
const toWorld = (matrix: THREE.Matrix4, v: THREE.Vector3) => v.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix));
const fromWorld = (matrix: THREE.Matrix4, v: THREE.Vector3) => v.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix).transpose());

/** An angle in degrees folded into (-90, 90]: the difference between two undirected axes. */
function foldAxis(angleDeg: number): number {
  let value = ((angleDeg % 180) + 180) % 180;
  if (value > 90) value -= 180;
  return value;
}

/** A part counts as changed only by more than the rounding of its numbers (1.5 micrometres, a ratio of 1e-5). */
function differs(a: Part, b: Part): boolean {
  const far = (x: number, y: number, tolerance: number) => Math.abs(x - y) > tolerance;
  return a.primitive !== b.primitive || a.parentId !== b.parentId || far(a.tubeRatio, b.tubeRatio, 1e-5)
    || (['x', 'y', 'z'] as const).some(axis => far(a.dimensions[axis], b.dimensions[axis], 1.5e-6) || far(a.position[axis], b.position[axis], 1.5e-6));
}

const outOfRange = () => new FitResizeError('FIT_OUT_OF_RANGE', FIT_TEXT.fitOutOfRange);

/**
 * Resizes the ring part (design 6.6).
 *
 * 1. `g = offsetForPerimeter(a, b, c)`; the inner semi-axes become `(a + g, b + g)`.
 * 2. The ring's two plane axes are matched to the arm's width and thickness axes. An axis within
 *    `RESIZE_AXIS_TOLERANCE_DEG` of one takes its size; otherwise both become the mean (a circle).
 * 3. A tube keeps the wall along the width axis and gets the `tubeRatio` that gives the inner size on both
 *    axes; a torus gets `4 * inner` on both plane axes.
 * 4. Direct children move outward by the growth of the ring's outer radius toward them; the parts
 *    that touch the ring from outside (within `ATTACH_GAP_MM`) move the same way. A ring with a parent
 *    moves away from its face direction by that direction's growth, so it keeps touching the parent.
 *
 * Throws `FitResizeError`: `NO_RING` for an unknown part, `NOT_RESIZABLE` for any primitive but tube or
 * torus, `FIT_OUT_OF_RANGE` when a new size leaves what `PartSchema` allows.
 */
export function resizeRing(input: ResizeRingInput): ResizeRingResult {
  const { model } = input;
  const ring = model.parts.find(part => part.id === input.ringPartId);
  if (!ring) throw new FitResizeError('NO_RING', FIT_TEXT.noRingToFit);
  if (ring.primitive !== 'tube' && ring.primitive !== 'torus') throw new FitResizeError('NOT_RESIZABLE', FIT_TEXT.resizeNeedsAi);

  const a = input.widthMm / 2, b = input.thicknessMm / 2;
  const g = offsetForPerimeter(a, b, input.clearanceMm);
  let across = a + g, face = b + g;

  const worlds = worldMatrices(model);
  const ringWorld = worlds.get(ring.id)!;
  const isTube = ring.primitive === 'tube';
  // Local plane axes of the ring part, and the local axis along the ring axis.
  const e1 = new THREE.Vector3(1, 0, 0), e2 = isTube ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const setup = ringFrame(model, { kind: 'part', partId: ring.id })!;
  const { frame } = setup;

  // Angle of a world direction in the ring plane, from the face z toward x.
  const planeAngle = (v: THREE.Vector3) => deg(Math.atan2(v.dot(frame.x), v.dot(frame.z)));
  const u1 = e1.clone().transformDirection(ringWorld);
  // The arm's thickness axis lies at -roll from z; the width axis is 90 degrees further.
  const offThickness = foldAxis(planeAngle(u1) + input.rollDeg);
  let firstTakesWidth: boolean, roundedToCircle = false;
  if (Math.abs(offThickness) <= RESIZE_AXIS_TOLERANCE_DEG) firstTakesWidth = false;
  else if (Math.abs(Math.abs(offThickness) - 90) <= RESIZE_AXIS_TOLERANCE_DEG) firstTakesWidth = true;
  else {
    firstTakesWidth = true;
    roundedToCircle = true;
    across = face = (across + face) / 2;
  }
  // Inner semi-axes along the ring part's own plane axes 1 and 2, millimetres.
  const inner1 = firstTakesWidth ? across : face, inner2 = firstTakesWidth ? face : across;

  const dims = ring.dimensions;
  let nx = dims.x, ny = dims.y, nz = dims.z, ratio = ring.tubeRatio;
  if (isTube) {
    // The wall stays as it is along the axis that takes the width (A); the other axis follows from the shared ratio.
    const dA = (firstTakesWidth ? dims.x : dims.z) * MM, wallA = (1 - ring.tubeRatio) * dA / 2;
    const newDA = 2 * across + 2 * wallA;
    const newRatio = 2 * across / newDA;
    const newDB = 2 * face / newRatio;
    if (!(newRatio >= TUBE_RATIO_MIN && newRatio <= TUBE_RATIO_MAX)) throw outOfRange();
    nx = (firstTakesWidth ? newDA : newDB) / MM;
    nz = (firstTakesWidth ? newDB : newDA) / MM;
    ratio = newRatio;
  } else {
    nx = 4 * inner1 / MM; ny = 4 * inner2 / MM;
  }  const resized: Part = { ...ring, dimensions: { x: round6(nx), y: round6(ny), z: round6(nz) }, tubeRatio: round6(ratio) };

  // Outer radius of the ring in the direction of local plane angle phi, before and after (metres).
  const outer = (d: { x: number; y: number; z: number }) => [d.x / 2, (isTube ? d.z : d.y) / 2] as const;
  const [b1, b2] = outer(ring.dimensions), [n1, n2] = outer(resized.dimensions);
  const growth = (phi: number) => ellipseRadius(n1, n2, phi) - ellipseRadius(b1, b2, phi);
  const inPlane = (local: THREE.Vector3) => ({ p1: local.dot(e1), p2: local.dot(e2) });
  /** Outward growth vector (ring-local, metres) at a ring-local position, or null on the axis. */
  const outward = (local: THREE.Vector3): THREE.Vector3 | null => {
    const { p1, p2 } = inPlane(local);
    const length = Math.hypot(p1, p2);
    if (length < 1e-9) return null;
    const delta = growth(Math.atan2(p2, p1));
    return e1.clone().multiplyScalar(p1 / length * delta).addScaledVector(e2, p2 / length * delta);
  };

  const byId = new Map(model.parts.map(part => [part.id, part]));
  const ancestors = new Set<string>();
  for (let id = ring.parentId; id !== null; id = byId.get(id)!.parentId) ancestors.add(id);
  const descendantOfRing = (part: Part) => {
    for (let id = part.parentId; id !== null; id = byId.get(id)!.parentId) if (id === ring.id) return true;
    return false;
  };

  const next = new Map<string, Part>([[ring.id, resized]]);
  const move = (part: Part, deltaLocal: THREE.Vector3) => {
    const base = next.get(part.id) ?? part;
    next.set(part.id, {
      ...base,
      position: { x: round6(base.position.x + deltaLocal.x), y: round6(base.position.y + deltaLocal.y), z: round6(base.position.z + deltaLocal.z) },
    });
  };

  // Direct children follow the outer surface; their own children follow them.
  for (const part of model.parts) {
    if (part.parentId !== ring.id) continue;
    const delta = outward(new THREE.Vector3(part.position.x, part.position.y, part.position.z));
    if (delta) move(part, delta);
  }

  // Parts that touch the ring from outside move the same way, in the object frame.
  const boxes = partBoxes(model);
  const reach = boxes.get(ring.id)!.clone().expandByScalar(ATTACH_GAP_MM / MM);
  const ringInverse = ringWorld.clone().invert();
  const hole1 = (isTube ? ring.tubeRatio * ring.dimensions.x : ring.dimensions.x / 2) / 2;
  const hole2 = (isTube ? ring.tubeRatio * ring.dimensions.z : ring.dimensions.y / 2) / 2;
  const attached = model.parts.filter(part => {
    if (part.id === ring.id || part.parentId === ring.id || ancestors.has(part.id) || descendantOfRing(part)) return false;
    if (!reach.intersectsBox(boxes.get(part.id)!)) return false;
    const { p1, p2 } = inPlane(new THREE.Vector3().setFromMatrixPosition(worlds.get(part.id)!).applyMatrix4(ringInverse));
    return (p1 / hole1) ** 2 + (p2 / hole2) ** 2 > 1;
  });
  const movers = new Set(attached.map(part => part.id));
  for (const part of attached) {
    // A part under another mover follows it.
    let followed = false;
    for (let id = part.parentId; id !== null && !followed; id = byId.get(id)!.parentId) followed = movers.has(id);
    if (followed) continue;
    const delta = outward(new THREE.Vector3().setFromMatrixPosition(worlds.get(part.id)!).applyMatrix4(ringInverse));
    if (!delta) continue;
    const world = toWorld(ringWorld, delta);
    move(part, part.parentId ? fromWorld(worlds.get(part.parentId)!, world) : world);
  }

  // A ring that has a parent moves away from its face by the growth toward the face, so it keeps touching the parent.
  if (ring.parentId !== null) {
    const { p1, p2 } = inPlane(fromWorld(ringWorld, frame.z));
    move(ring, fromWorld(worlds.get(ring.parentId)!, frame.z.clone().multiplyScalar(-growth(Math.atan2(p2, p1)))));
  }

  const operations: EditOperation[] = [];
  for (const part of model.parts) {
    const updated = next.get(part.id);
    if (updated && differs(updated, part)) operations.push({ op: 'upsert', partId: part.id, part: updated });
  }
  const plan: EditPlan = {
    status: 'applied', explanation: FIT_TEXT.resizeExplanation(ring.name), operations, name: null, summary: null, assumptions: null,
  };
  const result = {
    plan, ringPartId: ring.id, innerSemiAxesMm: { across, face }, roundedToCircle, note: roundedToCircle ? FIT_TEXT.resizeRound : null,
  };
  if (!operations.length) return { ...result, model, changed: false };
  try {
    return { ...result, model: applyEditPlan(model, plan).model, changed: true };
  } catch {
    throw outOfRange();
  }
}
