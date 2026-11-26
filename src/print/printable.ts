import * as THREE from 'three';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import type { JointFeature } from '../../shared/features';
import { shellWall } from '../../shared/hollow';
import type { Part } from '../../shared/model';
import { loadManifold } from './manifold';

/**
 * Printable geometry (assembly-joints design 7.2 to 7.4, export design 6.1). A part's solid is
 * built from its analytic description in millimetres, the unit slicers expect, then the joint
 * features are cut: bosses are united first, then every hole is subtracted in one batch.
 * Only Manifold objects are created here; the caller owns and deletes whatever
 * `primitiveSolid` and `featureSolids` return. `printablePart` deletes everything it creates.
 */

export interface PrintableMesh {
  /** Millimetres, x y z per vertex. */
  positions: Float32Array;
  indices: Uint32Array;
  volumeMm3: number;
}

export type SkipReason = 'problem' | 'invalid';

export interface PrintableResult {
  mesh: PrintableMesh;
  /** Ids of the features that were cut or added. */
  applied: string[];
  skipped: Array<{ featureId: string; reason: SkipReason }>;
}

/** A hole starts this far outside its face, so no two faces are coplanar. */
export const OVERSHOOT_MM = 0.05;

const MM = 1000;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** Circular segments of a body of the given radius: one per 0.5 mm of circumference, 32 to 128. */
const bodySegments = (radiusMm: number) => clamp(Math.ceil((2 * Math.PI * radiusMm) / 0.5), 32, 128);
/** Circular segments of a hole or boss: one per 0.3 mm of circumference, 24 to 64. */
const holeSegments = (radiusMm: number) => clamp(Math.ceil((2 * Math.PI * radiusMm) / 0.3), 24, 64);

interface Disposable { delete(): void }

/** Keeps track of intermediate objects so they can be deleted together. */
function tracker() {
  const owned: Disposable[] = [];
  return {
    keep: <T extends Disposable>(item: T): T => {
      owned.push(item);
      return item;
    },
    /** Deletes everything kept except `result`, which the caller takes over. */
    release: (result?: Disposable) => {
      for (const item of owned) if (item !== result) item.delete();
      owned.length = 0;
    },
  };
}

/**
 * The primitive of a part as a Manifold, in the part's own frame and in millimetres: the
 * same proportions as the display geometry (`createPartGeometry`), centred, scaled to the
 * dimensions. The caller deletes the result.
 */
export function primitiveSolid(wasm: ManifoldToplevel, part: Part): Manifold {
  const { Manifold, CrossSection } = wasm;
  const { x, y, z } = part.dimensions;
  const size: [number, number, number] = [x * MM, y * MM, z * MM];
  const radius = (Math.max(x, z) / 2) * MM;
  const own = tracker();
  let result: Manifold | null = null;
  try {
    switch (part.primitive) {
      case 'box':
        result = own.keep(own.keep(Manifold.cube([1, 1, 1], true)).scale(size));
        break;
      case 'cylinder': {
        const n = bodySegments(radius);
        // The axis of a Manifold cylinder is Z; -90 degrees about X turns it into Y.
        result = own.keep(own.keep(own.keep(Manifold.cylinder(1, 0.5, 0.5, n, true)).rotate([-90, 0, 0])).scale(size));
        break;
      }
      case 'cone': {
        const n = bodySegments(radius);
        result = own.keep(own.keep(own.keep(Manifold.cylinder(1, 0.5, 0, n, true)).rotate([-90, 0, 0])).scale(size));
        break;
      }
      case 'sphere': {
        const n = bodySegments((Math.max(x, y, z) / 2) * MM);
        result = own.keep(own.keep(Manifold.sphere(0.5, n)).scale(size));
        break;
      }
      case 'tube': {
        const n = bodySegments(radius);
        const outer = own.keep(Manifold.cylinder(1, 0.5, 0.5, n, true));
        // Slightly longer than the outer cylinder, so the cut leaves no skin on the ends.
        const inner = own.keep(Manifold.cylinder(1.02, 0.5 * part.tubeRatio, 0.5 * part.tubeRatio, n, true));
        result = own.keep(own.keep(own.keep(outer.subtract(inner)).rotate([-90, 0, 0])).scale(size));
        break;
      }
      case 'shell': {
        // The outer box minus the void; the void never reaches the outer faces, so no faces are coplanar.
        const wall = shellWall(part) * MM;
        const outer = own.keep(own.keep(Manifold.cube([1, 1, 1], true)).scale(size));
        const voidSize: [number, number, number] = [size[0] - 2 * wall, size[1] - 2 * wall, size[2] - 2 * wall];
        const hollow = own.keep(own.keep(Manifold.cube([1, 1, 1], true)).scale(voidSize));
        result = own.keep(outer.subtract(hollow));
        break;
      }
      case 'torus': {
        const tube = clamp(Math.ceil((2 * Math.PI * 0.125 * Math.max(x, y) * MM) / 0.5), 32, 128);
        const ring = own.keep(CrossSection.circle(0.125, tube));
        const moved = own.keep(ring.translate([0.375, 0]));
        // The hole axis is Z, as in TorusGeometry; the unit torus is 0.25 thick.
        result = own.keep(own.keep(moved.revolve(bodySegments((Math.max(x, y) / 2) * MM))).scale([x * MM, y * MM, (z * MM) / 0.25]));
        break;
      }
    }
    return result!;
  } finally {
    own.release(result ?? undefined);
  }
}

/** Whether a feature has numbers a cylinder can be built from. */
function usable(feature: JointFeature): boolean {
  const { centre, axis } = feature;
  const numbers = [centre.x, centre.y, centre.z, axis.x, axis.y, axis.z, feature.diameter, feature.depth];
  return numbers.every(Number.isFinite) && feature.diameter > 0 && feature.depth > 0 && Math.hypot(axis.x, axis.y, axis.z) > 0.5;
}

/** A cylinder of `diameter` and `height` (mm) that starts at `origin` (mm) and grows along `axis`. The caller deletes it. */
function cylinderAlong(wasm: ManifoldToplevel, diameterMm: number, heightMm: number, origin: THREE.Vector3, axis: THREE.Vector3): Manifold {
  const base = wasm.Manifold.cylinder(heightMm, diameterMm / 2, diameterMm / 2, holeSegments(diameterMm / 2), false);
  try {
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const matrix = new THREE.Matrix4().compose(origin, rotation, new THREE.Vector3(1, 1, 1));
    return base.transform(matrix.elements as Mat4);
  } finally {
    base.delete();
  }
}

/**
 * The solids of a part's features, in the part's own frame and in millimetres: bosses (to unite)
 * and holes (to subtract), plus the features left out. A feature in `options.skip` is left out
 * as `problem` (its joint has an error); one whose numbers are not finite and positive is left
 * out as `invalid`. Bosses start `OVERSHOOT_MM` inside the face they grow from; holes start
 * `OVERSHOOT_MM` outside their face, and a hole that goes through runs `OVERSHOOT_MM` past the
 * far face (a blind hole keeps its depth), so no faces are coplanar. The caller deletes every
 * returned Manifold.
 */
export function featureSolids(
  wasm: ManifoldToplevel, features: readonly JointFeature[], options: { skip?: ReadonlySet<string> } = {},
): { bosses: Manifold[]; holes: Manifold[]; skipped: Array<{ featureId: string; reason: SkipReason }> } {
  const bosses: Manifold[] = [];
  const holes: Manifold[] = [];
  const skipped: Array<{ featureId: string; reason: SkipReason }> = [];
  try {
    for (const feature of features) {
      if (options.skip?.has(feature.id)) {
        skipped.push({ featureId: feature.id, reason: 'problem' });
        continue;
      }
      if (!usable(feature)) {
        skipped.push({ featureId: feature.id, reason: 'invalid' });
        continue;
      }
      const axis = new THREE.Vector3(feature.axis.x, feature.axis.y, feature.axis.z).normalize();
      const start = new THREE.Vector3(feature.centre.x, feature.centre.y, feature.centre.z).multiplyScalar(MM).addScaledVector(axis, -OVERSHOOT_MM);
      const diameterMm = feature.diameter * MM;
      const depthMm = feature.depth * MM;
      if (feature.kind === 'boss') bosses.push(cylinderAlong(wasm, diameterMm, depthMm + OVERSHOOT_MM, start, axis));
      // A blind hole keeps its depth; only a hole that reaches the far face runs past it.
      else holes.push(cylinderAlong(wasm, diameterMm, depthMm + (feature.through ? 2 : 1) * OVERSHOOT_MM, start, axis));
    }
  } catch (error) {
    for (const item of [...bosses, ...holes]) item.delete();
    throw error;
  }
  return { bosses, holes, skipped };
}

function meshOf(solid: Manifold): PrintableMesh {
  const mesh = solid.getMesh();
  const { numProp, vertProperties, triVerts } = mesh;
  const count = vertProperties.length / numProp;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = vertProperties[i * numProp]!;
    positions[i * 3 + 1] = vertProperties[i * numProp + 1]!;
    positions[i * 3 + 2] = vertProperties[i * numProp + 2]!;
  }
  return { positions, indices: Uint32Array.from(triVerts), volumeMm3: solid.volume() };
}

/**
 * The printable solid of a part in its own frame, in millimetres: the primitive plus its bosses
 * minus its holes. The mesh is a closed two-manifold. Features that cannot be applied are left
 * out and reported. Never throws for a part that passed `validateModel`, except when the
 * geometry library cannot be loaded.
 */
export async function printablePart(
  part: Part, features: readonly JointFeature[], options: { skip?: ReadonlySet<string> } = {},
): Promise<PrintableResult> {
  const wasm = await loadManifold();
  const { Manifold } = wasm;
  const own = tracker();
  try {
    const solids = featureSolids(wasm, features, options);
    for (const item of [...solids.bosses, ...solids.holes]) own.keep(item);
    let solid = own.keep(primitiveSolid(wasm, part));
    if (solids.bosses.length > 0) solid = own.keep(Manifold.union([solid, ...solids.bosses]));
    // One batch subtraction: the first solid minus every hole.
    if (solids.holes.length > 0) solid = own.keep(Manifold.difference([solid, ...solids.holes]));
    if (solid.status() !== 'NoError' || solid.isEmpty()) throw new Error('無法產生列印件。');
    const left = new Set(solids.skipped.map(item => item.featureId));
    return { mesh: meshOf(solid), applied: features.filter(feature => !left.has(feature.id)).map(feature => feature.id), skipped: solids.skipped };
  } finally {
    own.release();
  }
}

/** A BufferGeometry of a printable mesh: millimetres, indexed, with computed normals. */
export function toBufferGeometry(mesh: PrintableMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}
