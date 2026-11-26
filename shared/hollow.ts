import * as THREE from 'three';
import { worldMatrices } from './bounds';
import type { ModelSpec, Part } from './model';

/**
 * Hollow parts (design-fidelity requirements 2, 3 and 13, design 3.1). A `shell` is a closed
 * hollow box: the outer box is `dimensions`, the wall is uniform and comes from `tubeRatio`,
 * the void is the outer box minus the wall on every side. Everything here is in metres, in the
 * part's own frame unless a name says world. Three.js math only, so it runs in Node.
 */

/** 0.1 mm: how far a part may stick into a wall and still count as inside the void. */
export const VOID_TOLERANCE_M = 0.0001;

const hasWall = (part: Part): boolean => part.primitive === 'shell';

/** Wall of a shell in metres: `(1 - tubeRatio) * smallest dimension / 2`. Throws for any other primitive. */
export function shellWall(part: Part): number {
  if (!hasWall(part)) throw new Error('只有中空殼體有壁厚。');
  const { x, y, z } = part.dimensions;
  return ((1 - part.tubeRatio) * Math.min(x, y, z)) / 2;
}

/** Half extents of the void of a shell, or `null` for a part that is not a shell. */
export function innerBox(part: Part): { x: number; y: number; z: number } | null {
  if (!hasWall(part)) return null;
  const wall = shellWall(part);
  const { x, y, z } = part.dimensions;
  return { x: x / 2 - wall, y: y / 2 - wall, z: z / 2 - wall };
}

/**
 * Exact solid volume of a part in m³, with the proportions of the display geometry
 * (`createPartGeometry`) and of the printable solid (`primitiveSolid`).
 */
export function partVolume(part: Part): number {
  const { x, y, z } = part.dimensions;
  switch (part.primitive) {
    case 'box': return x * y * z;
    case 'sphere': return (Math.PI / 6) * x * y * z;
    case 'cylinder': return (Math.PI / 4) * x * z * y;
    case 'cone': return (Math.PI / 12) * x * z * y;
    case 'tube': return (Math.PI / 4) * (1 - part.tubeRatio ** 2) * x * z * y;
    // The unit TorusGeometry(0.375, 0.125) is 1 x 1 x 0.25; it is scaled to x, y and z.
    case 'torus': return 2 * Math.PI ** 2 * 0.375 * 0.125 ** 2 * x * y * (z / 0.25);
    case 'shell': {
      const wall = shellWall(part);
      return x * y * z - (x - 2 * wall) * (y - 2 * wall) * (z - 2 * wall);
    }
  }
}

/** The inner surface of a hollow part, in its own frame (requirement 3). */
export type InnerSurface =
  | { kind: 'box'; half: { x: number; y: number; z: number }; wall: number }
  | { kind: 'cylinder'; radius: { x: number; z: number }; halfLength: number; wall: number };

/**
 * Shell: the inner box. Tube: the bore, a cylinder along Y whose wall is measured on the smaller
 * of the two outer radii. Every other primitive is solid: `null`.
 */
export function innerSurface(part: Part): InnerSurface | null {
  if (part.primitive === 'shell') return { kind: 'box', half: innerBox(part)!, wall: shellWall(part) };
  if (part.primitive === 'tube') {
    const { x, y, z } = part.dimensions;
    return {
      kind: 'cylinder',
      radius: { x: (x / 2) * part.tubeRatio, z: (z / 2) * part.tubeRatio },
      halfLength: y / 2,
      wall: ((1 - part.tubeRatio) * Math.min(x, z)) / 2,
    };
  }
  return null;
}

/**
 * Largest distance in metres by which a corner of `partId`'s own box lies outside the void of
 * `shellId`, 0 when every corner is inside. The part's own box is used, which is conservative for
 * round parts. `Infinity` when either part is missing or `shellId` is not a shell. Pass `matrices`
 * (from `worldMatrices`) to reuse them across many calls.
 */
export function voidExcess(model: ModelSpec, partId: string, shellId: string, matrices?: Map<string, THREE.Matrix4>): number {
  const part = model.parts.find(entry => entry.id === partId);
  const shell = model.parts.find(entry => entry.id === shellId);
  const half = shell ? innerBox(shell) : null;
  if (!part || !shell || !half || partId === shellId) return Infinity;
  const worlds = matrices ?? worldMatrices(model);
  const partWorld = worlds.get(partId);
  const shellWorld = worlds.get(shellId);
  if (!partWorld || !shellWorld) return Infinity;
  const toShell = shellWorld.clone().invert().multiply(partWorld);
  const corner = new THREE.Vector3();
  let excess = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corner.set((sx * part.dimensions.x) / 2, (sy * part.dimensions.y) / 2, (sz * part.dimensions.z) / 2).applyMatrix4(toShell);
        excess = Math.max(excess, Math.abs(corner.x) - half.x, Math.abs(corner.y) - half.y, Math.abs(corner.z) - half.z);
      }
    }
  }
  return excess;
}

/** True when every corner of `partId`'s own box lies inside the void of `shellId`, within `toleranceM`. */
export function containedInVoid(
  model: ModelSpec, partId: string, shellId: string, toleranceM: number = VOID_TOLERANCE_M, matrices?: Map<string, THREE.Matrix4>,
): boolean {
  return voidExcess(model, partId, shellId, matrices) <= toleranceM;
}
