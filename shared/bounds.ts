import * as THREE from 'three';
import type { ModelSpec, Part } from './model';

/**
 * Pure geometry helpers shared by the browser and the server. They use only
 * Three.js math classes (no renderer, no DOM), so they run in Node.
 */

/** World matrix of every part with rotation in XYZ Euler degrees, as built in geometry.ts. */
export function worldMatrices(model: ModelSpec): Map<string, THREE.Matrix4> {
  const byId = new Map(model.parts.map(part => [part.id, part]));
  const result = new Map<string, THREE.Matrix4>();
  const resolve = (part: Part): THREE.Matrix4 => {
    const known = result.get(part.id);
    if (known) return known;
    const rotation = new THREE.Euler(...[part.rotation.x, part.rotation.y, part.rotation.z].map(THREE.MathUtils.degToRad) as [number, number, number]);
    const local = new THREE.Matrix4().compose(new THREE.Vector3(part.position.x, part.position.y, part.position.z),
      new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(1, 1, 1));
    const parent = part.parentId ? byId.get(part.parentId) : undefined;
    const world = parent ? resolve(parent).clone().multiply(local) : local;
    result.set(part.id, world);
    return world;
  };
  model.parts.forEach(resolve);
  return result;
}

/** Axis-aligned world box of each part's own primitive (every primitive is centred, full size = dimensions). */
export function partBoxes(model: ModelSpec, offsets?: Map<string, THREE.Vector3>): Map<string, THREE.Box3> {
  const matrices = worldMatrices(model);
  const boxes = new Map<string, THREE.Box3>();
  for (const part of model.parts) {
    const half = new THREE.Vector3(part.dimensions.x, part.dimensions.y, part.dimensions.z).multiplyScalar(0.5);
    const box = new THREE.Box3(half.clone().negate(), half).applyMatrix4(matrices.get(part.id)!);
    const shift = offsets?.get(part.id);
    boxes.set(part.id, shift ? box.translate(shift) : box);
  }
  return boxes;
}

/** Union of all part boxes, in the model's own frame. */
export function modelBox(model: ModelSpec): THREE.Box3 {
  const box = new THREE.Box3();
  for (const partBox of partBoxes(model).values()) box.union(partBox);
  return box;
}

/**
 * Box of a model placed in the workspace: `modelBox` moved by the object's
 * position (metres) and XYZ Euler rotation (degrees). This is the axis-aligned
 * box of the transformed corners, so it can be larger than the rotated shape.
 */
export function objectBox(
  model: ModelSpec,
  transform: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } },
): THREE.Box3 {
  const { position, rotation } = transform;
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotation.x), THREE.MathUtils.degToRad(rotation.y), THREE.MathUtils.degToRad(rotation.z));
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z), new THREE.Quaternion().setFromEuler(euler), new THREE.Vector3(1, 1, 1));
  return modelBox(model).applyMatrix4(matrix);
}
