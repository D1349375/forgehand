import * as THREE from 'three';
import type { ObjectTransform, Workspace } from './workspace';

/**
 * Assemblies and rigid moves (assembly-joints requirements 84 to 86, design 3.4).
 * No workspace rules live here, and `Workspace` is imported as a type only, so
 * `workspace.ts` can call this module without a runtime cycle. Uses only Three.js
 * math classes.
 */

const POSITION_LIMIT = 100;
const ROTATION_LIMIT = 360;

// + 0 turns -0 into 0.
const round5 = (value: number) => Math.round(value * 1e5) / 1e5 + 0;
const round2 = (value: number) => Math.round(value * 1e2) / 1e2 + 0;

/**
 * Ids of the objects connected to `objectId` through joints between different
 * objects, directly or through other objects, in workspace order. Always
 * contains `objectId`. A joint between two parts of one object links nothing.
 * `skipJointId` leaves one joint out, to ask what stays connected without it.
 */
export function assemblyOf(ws: Pick<Workspace, 'objects' | 'joints'>, objectId: string, skipJointId?: string): string[] {
  const neighbours = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = neighbours.get(from);
    if (list) list.push(to);
    else neighbours.set(from, [to]);
  };
  for (const joint of ws.joints) {
    if (joint.id === skipJointId || joint.a.objectId === joint.b.objectId) continue;
    link(joint.a.objectId, joint.b.objectId);
    link(joint.b.objectId, joint.a.objectId);
  }
  const seen = new Set<string>([objectId]);
  const queue = [objectId];
  for (let at = 0; at < queue.length; at++) {
    for (const next of neighbours.get(queue[at]!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  const ordered = ws.objects.map(object => object.id).filter(id => seen.has(id));
  return ordered.includes(objectId) ? ordered : [objectId, ...ordered];
}

/** Matrix of an object transform: position in metres, XYZ Euler rotation in degrees. */
export function objectMatrix(transform: ObjectTransform): THREE.Matrix4 {
  const { position, rotation } = transform;
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotation.x), THREE.MathUtils.degToRad(rotation.y), THREE.MathUtils.degToRad(rotation.z), 'XYZ');
  return new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z), new THREE.Quaternion().setFromEuler(euler), new THREE.Vector3(1, 1, 1));
}

/**
 * Object transform of a matrix: position rounded to 5 decimals, XYZ Euler
 * degrees rounded to 2; null when the result leaves the transform limits.
 */
export function transformOfMatrix(matrix: THREE.Matrix4): ObjectTransform | null {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  matrix.decompose(position, quaternion, new THREE.Vector3());
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  const transform: ObjectTransform = {
    position: { x: round5(position.x), y: round5(position.y), z: round5(position.z) },
    rotation: {
      x: round2(THREE.MathUtils.radToDeg(euler.x)), y: round2(THREE.MathUtils.radToDeg(euler.y)), z: round2(THREE.MathUtils.radToDeg(euler.z)),
    },
  };
  return within(transform.position, POSITION_LIMIT) && within(transform.rotation, ROTATION_LIMIT) ? transform : null;
}
const sameVector = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x === b.x && a.y === b.y && a.z === b.z;

const within = (v: { x: number; y: number; z: number }, limit: number) =>
  Math.abs(v.x) <= limit && Math.abs(v.y) <= limit && Math.abs(v.z) <= limit;

/**
 * Moves the anchor object to `anchor` and every other member by the same rigid
 * motion, so their placement relative to each other is kept. Returns the new
 * transform of every member (the anchor's is `anchor` itself), or `null` when a
 * member would leave the transform limits.
 *
 * Only the position changed: every other member moves by the same offset and
 * keeps its rotation object by reference. Otherwise `D = M(anchor) * M(old anchor)^-1`
 * and each member gets `D * M(member)`, decomposed into a position (5 decimals)
 * and XYZ Euler degrees (2 decimals).
 */
export function moveRigid(
  ws: Workspace, memberIds: readonly string[], anchorId: string, anchor: ObjectTransform,
): Map<string, ObjectTransform> | null {
  const old = ws.objects.find(object => object.id === anchorId)?.transform;
  if (!old) return null;
  const result = new Map<string, ObjectTransform>([[anchorId, anchor]]);
  const others = ws.objects.filter(object => object.id !== anchorId && memberIds.includes(object.id));
  if (others.length === 0) return result;

  if (sameVector(anchor.rotation, old.rotation)) {
    const dx = anchor.position.x - old.position.x;
    const dy = anchor.position.y - old.position.y;
    const dz = anchor.position.z - old.position.z;
    for (const object of others) {
      const { position, rotation } = object.transform;
      const moved = { x: round5(position.x + dx), y: round5(position.y + dy), z: round5(position.z + dz) };
      if (!within(moved, POSITION_LIMIT)) return null;
      result.set(object.id, { position: moved, rotation });
    }
    return result;
  }

  const delta = objectMatrix(anchor).multiply(objectMatrix(old).invert());
  for (const object of others) {
    const moved = transformOfMatrix(new THREE.Matrix4().multiplyMatrices(delta, objectMatrix(object.transform)));
    if (!moved) return null;
    result.set(object.id, moved);
  }
  return result;
}
