import * as THREE from 'three';
import { MESH_KEY_MM } from './constants';

/** A triangle mesh in millimetres: xyz positions and triangle indices (counter-clockwise seen from outside). */
export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export type Triple = [number, number, number];

/** Axis-aligned bounds. An empty mesh gives zeros. */
export function meshBounds(mesh: MeshData): { min: Triple; max: Triple } {
  const p = mesh.positions;
  if (p.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: Triple = [Infinity, Infinity, Infinity];
  const max: Triple = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = p[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

/** Signed volume in mm³ (sum of tetrahedra to the first vertex). Positive for outward winding. Triangles with an index out of range are skipped. */
export function meshVolume(mesh: MeshData): number {
  const p = mesh.positions;
  const count = Math.floor(p.length / 3);
  if (count === 0) return 0;
  const ox = p[0]!;
  const oy = p[1]!;
  const oz = p[2]!;
  let sum = 0;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]!;
    const b = mesh.indices[t + 1]!;
    const c = mesh.indices[t + 2]!;
    if (a >= count || b >= count || c >= count) continue;
    const ax = p[a * 3]! - ox, ay = p[a * 3 + 1]! - oy, az = p[a * 3 + 2]! - oz;
    const bx = p[b * 3]! - ox, by = p[b * 3 + 1]! - oy, bz = p[b * 3 + 2]! - oz;
    const cx = p[c * 3]! - ox, cy = p[c * 3 + 1]! - oy, cz = p[c * 3 + 2]! - oz;
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

export type MeshProblem = 'empty' | 'index' | 'degenerate' | 'open-edge' | 'non-manifold-edge' | 'inward';

const MIN_AREA_MM2 = 1e-9;

/**
 * Reports why a mesh is not a printable solid; `[]` means closed, two-manifold, consistently wound and outward.
 * - `empty`: no vertices or no triangles. `index`: a malformed array or an index out of range (nothing else is checked then).
 * - `degenerate`: a triangle with a repeated index or an area below 1e-9 mm².
 * - `open-edge`: an edge used by one triangle. `non-manifold-edge`: an edge used by more than two triangles, or twice in
 *   the same direction (inconsistent winding).
 * - `inward`: the volume is not positive. Only reported once the edges are sound, because an open mesh has no volume.
 */
export function meshProblems(mesh: MeshData): MeshProblem[] {
  const p = mesh.positions;
  const idx = mesh.indices;
  if (p.length === 0 || idx.length === 0) return ['empty'];
  const count = p.length / 3;
  if (!Number.isInteger(count) || idx.length % 3 !== 0) return ['index'];
  for (let i = 0; i < idx.length; i += 1) if (idx[i]! >= count) return ['index'];
  for (let i = 0; i < p.length; i += 1) if (!Number.isFinite(p[i]!)) return ['index'];

  const problems = new Set<MeshProblem>();
  // Directed edge a→b counts, keyed a * count + b.
  const directed = new Map<number, number>();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    if (a === b || b === c || a === c) { problems.add('degenerate'); continue; }
    const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const vx = p[c * 3]! - p[a * 3]!, vy = p[c * 3 + 1]! - p[a * 3 + 1]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.sqrt(nx * nx + ny * ny + nz * nz) / 2 < MIN_AREA_MM2) problems.add('degenerate');
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      const key = from * count + to;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, forward] of directed) {
    const from = Math.floor(key / count);
    const to = key - from * count;
    const backward = directed.get(to * count + from) ?? 0;
    if (forward > 1) problems.add('non-manifold-edge'); // used twice in one direction
    else if (backward === 0) problems.add('open-edge');
    else if (backward > 1) problems.add('non-manifold-edge');
  }
  if (!problems.has('open-edge') && !problems.has('non-manifold-edge') && meshVolume(mesh) <= 0) problems.add('inward');

  const order: MeshProblem[] = ['degenerate', 'open-edge', 'non-manifold-edge', 'inward'];
  return order.filter((problem) => problems.has(problem));
}

/** Model frame (Y up, +z front) to the slicer frame (Z up, front toward −y): (x, y, z) → (x, −z, y). A +90° rotation about X. */
export const PRINT_FRAME: THREE.Matrix4 = Object.freeze(new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
));

/**
 * Applies `matrix` (default identity), then `PRINT_FRAME`, then moves the mesh so its bounds are centred on X and Y and
 * rest on Z = 0. Returns a new mesh. A mirroring matrix flips the triangle order so the mesh stays outward-facing;
 * rotations and translations keep the indices unchanged.
 */
export function toPrintFrame(mesh: MeshData, matrix: THREE.Matrix4 = new THREE.Matrix4()): MeshData {
  const m = new THREE.Matrix4().multiplyMatrices(PRINT_FRAME, matrix).elements;
  const src = mesh.positions;
  const out = new Float64Array(src.length);
  for (let i = 0; i + 2 < src.length; i += 3) {
    const x = src[i]!, y = src[i + 1]!, z = src[i + 2]!;
    out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  const min: Triple = [Infinity, Infinity, Infinity];
  const max: Triple = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < out.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = out[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  const positions = new Float32Array(out.length);
  if (out.length > 0) {
    const shiftX = (min[0] + max[0]) / 2;
    const shiftY = (min[1] + max[1]) / 2;
    for (let i = 0; i + 2 < out.length; i += 3) {
      positions[i] = out[i]! - shiftX;
      positions[i + 1] = out[i + 1]! - shiftY;
      positions[i + 2] = out[i + 2]! - min[2];
    }
  }
  const indices = new Uint32Array(mesh.indices);
  if (new THREE.Matrix4().multiplyMatrices(PRINT_FRAME, matrix).determinant() < 0) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const swap = indices[t + 1]!;
      indices[t + 1] = indices[t + 2]!;
      indices[t + 2] = swap;
    }
  }
  return { positions, indices };
}

// FNV-1a 64 on two 32-bit halves, so no BigInt is needed.
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LO = 0x1b3; // the prime is 2^40 + 0x1b3

/**
 * Identity of a mesh independent of vertex order, triangle order, where a triangle starts, and position (the bounds
 * minimum is moved to the origin). Mirror images and rotated copies get other keys. Coordinates are rounded to `MESH_KEY_MM`.
 * The mesh must be valid (`meshProblems` is `[]`). Returns `${triangleCount}:${16 hex digits}`.
 */
export function meshKey(mesh: MeshData): string {
  const p = mesh.positions;
  const triangles = Math.floor(mesh.indices.length / 3);
  // Round every vertex to the key grid, then move the minimum of each axis to 0 so the key ignores position.
  const grid = new Int32Array(p.length);
  for (let i = 0; i < p.length; i += 1) grid[i] = Math.round(p[i]! / MESH_KEY_MM);
  const origin = [Infinity, Infinity, Infinity];
  for (let i = 0; i < triangles * 3; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) origin[axis] = Math.min(origin[axis]!, grid[mesh.indices[i]! * 3 + axis]!);
  }
  const ints = new Int32Array(triangles * 9);
  const vertex = new Int32Array(9);
  for (let t = 0; t < triangles; t += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const v = mesh.indices[t * 3 + corner]!;
      for (let axis = 0; axis < 3; axis += 1) vertex[corner * 3 + axis] = grid[v * 3 + axis]! - origin[axis]!;
    }
    // Rotate so the lexicographically smallest vertex comes first; this keeps the winding.
    let first = 0;
    for (let corner = 1; corner < 3; corner += 1) if (compareVertex(vertex, corner, first) < 0) first = corner;
    for (let corner = 0; corner < 3; corner += 1) {
      const from = ((first + corner) % 3) * 3;
      ints.set(vertex.subarray(from, from + 3), t * 9 + corner * 3);
    }
  }
  const order = Array.from({ length: triangles }, (_, i) => i);
  order.sort((a, b) => {
    for (let i = 0; i < 9; i += 1) {
      const diff = ints[a * 9 + i]! - ints[b * 9 + i]!;
      if (diff !== 0) return diff;
    }
    return 0;
  });
  let hi = FNV_OFFSET_HI;
  let lo = FNV_OFFSET_LO;
  const step = (byte: number): void => {
    lo = (lo ^ byte) >>> 0;
    const product = lo * FNV_PRIME_LO; // below 2^41, exact
    const carry = Math.floor(product / 0x1_0000_0000);
    const nextLo = product % 0x1_0000_0000;
    hi = (Math.imul(hi, FNV_PRIME_LO) + carry + (lo << 8)) >>> 0;
    lo = nextLo;
  };
  for (const t of order) {
    for (let i = 0; i < 9; i += 1) {
      const value = ints[t * 9 + i]!;
      step(value & 0xff);
      step((value >>> 8) & 0xff);
      step((value >>> 16) & 0xff);
      step((value >>> 24) & 0xff);
    }
  }
  return `${triangles}:${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
}

function compareVertex(ints: Int32Array, a: number, b: number): number {
  for (let axis = 0; axis < 3; axis += 1) {
    const diff = ints[a * 3 + axis]! - ints[b * 3 + axis]!;
    if (diff !== 0) return diff;
  }
  return 0;
}
