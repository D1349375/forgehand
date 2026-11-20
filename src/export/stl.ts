import { STL_HEADER_BYTES } from './constants';
import type { MeshData } from './mesh';

/**
 * Binary STL in millimetres. Header `Forgehand {label} mm` (ASCII, space padded to 80 bytes), a little-endian uint32
 * triangle count, then per triangle the unit normal from (v2 − v1) × (v3 − v1), three float32 vertices and a uint16 0.
 * A zero-area triangle gets the normal (0, 0, 0). The mesh must already be valid.
 */
export function writeStl(mesh: MeshData, label: string): Uint8Array {
  const triangles = Math.floor(mesh.indices.length / 3);
  const bytes = new Uint8Array(STL_HEADER_BYTES + 4 + 50 * triangles);
  const view = new DataView(bytes.buffer);

  bytes.fill(0x20, 0, STL_HEADER_BYTES);
  const header = `Forgehand ${label} mm`;
  for (let i = 0; i < header.length && i < STL_HEADER_BYTES; i += 1) {
    const code = header.charCodeAt(i);
    bytes[i] = code >= 0x20 && code < 0x7f ? code : 0x3f; // keep the header ASCII
  }
  view.setUint32(STL_HEADER_BYTES, triangles, true);

  const p = mesh.positions;
  let offset = STL_HEADER_BYTES + 4;
  for (let t = 0; t < triangles; t += 1) {
    const a = mesh.indices[t * 3]! * 3;
    const b = mesh.indices[t * 3 + 1]! * 3;
    const c = mesh.indices[t * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length > 0) { nx /= length; ny /= length; nz /= length; } else { nx = 0; ny = 0; nz = 0; }
    for (const value of [nx, ny, nz, p[a]!, p[a + 1]!, p[a + 2]!, p[b]!, p[b + 1]!, p[b + 2]!, p[c]!, p[c + 1]!, p[c + 2]!]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return bytes;
}
