import { strFromU8, unzipSync } from 'fflate';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import { createObject, emptyWorkspace, type SceneObject } from '../../shared/workspace';
import { PLATE_GAP_MM, PLATE_ROW_MM } from '../../src/export/constants';
import { base64, csvField, csvRow, fmtNumber, formatCm3, formatDate, formatMm, formatSize, htmlEscape, mdCell, xmlEscape } from '../../src/export/format';
import { buildGlbScene } from '../../src/export/glb';
import { PRINT_FRAME, meshBounds, meshKey, meshProblems, meshVolume, toPrintFrame, type MeshData } from '../../src/export/mesh';
import { writeStl } from '../../src/export/stl';
import { layoutPlate, threeMfModelXml, write3mf, type ThreeMfObject } from '../../src/export/threemf';
import { kitZipName, zipFiles, type KitFile } from '../../src/export/zip';

// ---- hand-built meshes -------------------------------------------------------------------------------------------

/** A closed box with outward winding, corner at the origin. */
function box(x: number, y: number, z: number): MeshData {
  const positions = new Float32Array([0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4, // y = 0
    2, 3, 7, 2, 7, 6, // y = max
    0, 4, 7, 0, 7, 3, // x = 0
    1, 2, 6, 1, 6, 5, // x = max
  ]);
  return { positions, indices };
}

/** A right-angled tetrahedron with legs 10, 20 and 30 mm: asymmetric, volume 1000 mm³. */
function tetra(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30]),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  };
}

const flip = (mesh: MeshData): MeshData => {
  const indices = new Uint32Array(mesh.indices);
  for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!];
  return { positions: mesh.positions, indices };
};

const piece = (number: string, mesh: MeshData, extra: Partial<ThreeMfObject> = {}): ThreeMfObject =>
  ({ number, name: `零件 ${number}`, color: '#59d9e8', mesh, copies: 1, ...extra });

const MTIME = new Date(2026, 10, 20, 9, 5);

// ---- escaping and formats ----------------------------------------------------------------------------------------

describe('escaping and formats', () => {
  it('escapes XML, drops characters XML cannot hold, and keeps Traditional Chinese', () => {
    expect(xmlEscape(`a<&>"'b\u0001\u0008\u000b\u000c\u000e\u001f\ufffe\uffffc`)).toBe('a&lt;&amp;&gt;&quot;&apos;bc');
    expect(xmlEscape('x\ud800y')).toBe('xy'); // lone surrogate
    expect(xmlEscape('外殼\t\n😀')).toBe('外殼\t\n😀');
  });

  it('escapes HTML so a name cannot open a tag', () => {
    const out = htmlEscape('<script>alert("x")</script> & \'');
    expect(out).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;');
    expect(out).not.toContain('<');
  });

  it('escapes Markdown table cells', () => {
    const out = mdCell('| <b>x</b> \n*a*_b_ [l] `c` \\ & \r\nz');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe('\\| &lt;b&gt;x&lt;/b&gt;  \\*a\\*\\_b\\_ \\[l\\] \\`c\\` \\\\ &amp;  z');
  });

  it('guards CSV formulas and quotes fields', () => {
    expect(csvField("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) expect(csvField(`${lead}x`).startsWith(`${lead === '\r' ? '"' : ''}'${lead}`)).toBe(true);
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('=1,2')).toBe('"\'=1,2"');
    expect(csvField('外殼')).toBe('外殼');
    expect(csvRow(['a', 'b,c', ''])).toBe('a,"b,c",\r\n');
  });

  it('formats numbers, sizes, volumes, dates and base64', () => {
    expect(fmtNumber(12.5)).toBe('12.5');
    expect(fmtNumber(10)).toBe('10');
    expect(fmtNumber(100)).toBe('100');
    expect(fmtNumber(0.123456)).toBe('0.1235');
    expect(fmtNumber(-0)).toBe('0');
    expect(fmtNumber(-0.00001)).toBe('0');
    expect(fmtNumber(-3.25)).toBe('-3.25');
    expect(() => fmtNumber(Number.NaN)).toThrow();
    expect(formatMm(12.5)).toBe('12.5');
    expect(formatMm(8)).toBe('8.0');
    expect(formatMm(-0.04)).toBe('0.0');
    expect(formatSize({ x: 12.5, y: 30, z: 8 })).toBe('12.5 × 30.0 × 8.0');
    expect(formatCm3(412_340)).toBe('412.3');
    expect(formatDate(new Date(2026, 0, 5, 7, 3))).toBe('2026-01-05 07:03');
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) % 256);
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(base64(new Uint8Array())).toBe('');
  });
});

// ---- mesh helpers ------------------------------------------------------------------------------------------------

describe('mesh helpers', () => {
  it('reports no problems for a closed, outward cube and computes its volume', () => {
    expect(meshProblems(box(10, 10, 10))).toEqual([]);
    expect(meshVolume(box(10, 10, 10))).toBeCloseTo(1000, 6);
    expect(meshProblems(tetra())).toEqual([]);
    expect(meshVolume(tetra())).toBeCloseTo(1000, 6);
  });

  it('finds an open box, a flipped cube, a bad index, an empty mesh and a degenerate triangle', () => {
    const cube = box(10, 10, 10);
    expect(meshProblems({ positions: cube.positions, indices: cube.indices.slice(0, 30) })).toEqual(['open-edge']);
    const flipped = flip(cube);
    expect(meshProblems(flipped)).toEqual(['inward']);
    expect(meshVolume(flipped)).toBeCloseTo(-1000, 6);
    expect(meshProblems({ positions: cube.positions, indices: new Uint32Array([...cube.indices.slice(0, 33), 0, 1, 99]) })).toEqual(['index']);
    expect(meshProblems({ positions: new Float32Array(), indices: new Uint32Array() })).toEqual(['empty']);
    expect(meshProblems({ positions: cube.positions, indices: new Uint32Array([0, 1]) })).toEqual(['index']);
    const degenerate = new Uint32Array([...cube.indices, 0, 0, 1]);
    expect(meshProblems({ positions: cube.positions, indices: degenerate })).toContain('degenerate');
    const collinear = new Float32Array([...cube.positions, 5, 0, 0]); // a vertex on the edge 0-1: a zero-area triangle
    expect(meshProblems({ positions: collinear, indices: new Uint32Array([...cube.indices, 0, 1, 8]) })).toContain('degenerate');
  });

  it('finds an edge used by three triangles and one wound against its neighbour', () => {
    const cube = box(10, 10, 10);
    const extra = new Float32Array([...cube.positions, 5, 5, 20]);
    const three = new Uint32Array([...cube.indices, 6, 7, 8]); // a fin on the top-back edge 6-7
    expect(meshProblems({ positions: extra, indices: three })).toContain('non-manifold-edge');
    const mixed = new Uint32Array(cube.indices);
    [mixed[1], mixed[2]] = [mixed[2]!, mixed[1]!]; // one triangle reversed
    expect(meshProblems({ positions: cube.positions, indices: mixed })).toContain('non-manifold-edge');
  });

  it('maps the model frame to the print frame, rests on Z = 0 and centres X and Y', () => {
    expect(PRINT_FRAME.elements).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
    // Model box x 10, y 40 (tall), z 20 (front toward +z).
    const moved = toPrintFrame(box(10, 40, 20), new THREE.Matrix4().makeTranslation(100, -50, 7));
    const { min, max } = meshBounds(moved);
    expect(min[0]).toBeCloseTo(-5, 5);
    expect(max[0]).toBeCloseTo(5, 5);
    expect(min[1]).toBeCloseTo(-10, 5);
    expect(max[1]).toBeCloseTo(10, 5);
    expect(min[2]).toBe(0);
    expect(max[2]).toBeCloseTo(40, 5); // +Y tall became +Z tall
    // The model vertex (0, 0, 20) (front face, +z) lands on −y: (−5, −10, 0).
    const found = Array.from({ length: moved.positions.length / 3 }, (_, i) => [...moved.positions.subarray(i * 3, i * 3 + 3)])
      .some(([x, y, z]) => Math.abs(x! + 5) < 1e-4 && Math.abs(y! + 10) < 1e-4 && Math.abs(z!) < 1e-4);
    expect(found).toBe(true);
    expect(meshProblems(moved)).toEqual([]);
    expect(meshVolume(moved)).toBeCloseTo(8000, 3);
  });

  it('does not change its input and keeps the outward winding for a rotation', () => {
    const input = tetra();
    const before = Array.from(input.positions);
    const rotated = toPrintFrame(input, new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.3, 1.1, -0.4)));
    expect(Array.from(input.positions)).toEqual(before);
    expect(Array.from(rotated.indices)).toEqual(Array.from(input.indices));
    expect(meshProblems(rotated)).toEqual([]);
    expect(meshVolume(rotated)).toBeCloseTo(1000, 2);
    expect(meshBounds(rotated).min[2]).toBe(0);
  });

  it('repairs the winding of a mirroring matrix', () => {
    const mirrored = toPrintFrame(tetra(), new THREE.Matrix4().makeScale(-1, 1, 1));
    expect(meshProblems(mirrored)).toEqual([]);
  });

  it('gives a translated and re-ordered copy the same key and a mirror image another', () => {
    const base = tetra();
    // Translate by whole millimetres, reverse the vertex order, rotate every triangle's start, reverse the triangle order.
    const vertexCount = base.positions.length / 3;
    const positions = new Float32Array(base.positions.length);
    for (let v = 0; v < vertexCount; v += 1) {
      const target = vertexCount - 1 - v;
      positions.set([base.positions[v * 3]! + 7, base.positions[v * 3 + 1]! - 3, base.positions[v * 3 + 2]! + 2], target * 3);
    }
    const triangles: number[][] = [];
    for (let t = 0; t < base.indices.length; t += 3) {
      const [a, b, c] = [base.indices[t]!, base.indices[t + 1]!, base.indices[t + 2]!].map((i) => vertexCount - 1 - i);
      triangles.push([b!, c!, a!]);
    }
    const reordered: MeshData = { positions, indices: Uint32Array.from(triangles.reverse().flat()) };
    expect(meshProblems(reordered)).toEqual([]);
    expect(meshKey(reordered)).toBe(meshKey(base));
    expect(meshKey(base)).toMatch(/^4:[0-9a-f]{16}$/);

    const mirroredPositions = Float32Array.from(base.positions, (value, i) => (i % 3 === 0 ? 10 - value : value));
    const mirrored = flip({ positions: mirroredPositions, indices: base.indices });
    expect(meshProblems(mirrored)).toEqual([]);
    expect(meshKey(mirrored)).not.toBe(meshKey(base));
    expect(meshKey(box(10, 10, 10))).not.toBe(meshKey(box(10, 10, 11)));
    expect(meshKey(flip(box(10, 10, 10)))).not.toBe(meshKey(box(10, 10, 10)));
  });
});

// ---- STL ---------------------------------------------------------------------------------------------------------

describe('writeStl', () => {
  it('writes the header, the size 84 + 50 n, little-endian floats and unit normals', () => {
    const mesh = tetra();
    const bytes = writeStl(mesh, 'P01');
    expect(bytes.length).toBe(84 + 50 * 4);
    const header = new TextDecoder('ascii').decode(bytes.subarray(0, 80));
    expect(header).toBe('Forgehand P01 mm'.padEnd(80, ' '));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(80, true)).toBe(4);
    // First triangle (0, 2, 1) is the bottom: normal −z, then its three vertices, then attribute 0.
    expect([0, 1, 2].map((i) => view.getFloat32(84 + i * 4, true))).toEqual([0, 0, -1]);
    expect([3, 4, 5].map((i) => view.getFloat32(84 + i * 4, true))).toEqual([0, 0, 0]);
    expect([6, 7, 8].map((i) => view.getFloat32(84 + i * 4, true))).toEqual([0, 20, 0]);
    expect([9, 10, 11].map((i) => view.getFloat32(84 + i * 4, true))).toEqual([10, 0, 0]);
    expect(view.getUint16(84 + 48, true)).toBe(0);
    // Last triangle (1, 2, 3) is the slanted face with a unit normal pointing outward.
    const base = 84 + 50 * 3;
    const normal = [0, 1, 2].map((i) => view.getFloat32(base + i * 4, true));
    expect(Math.hypot(...(normal as [number, number, number]))).toBeCloseTo(1, 6);
    expect(normal.every((value) => value > 0)).toBe(true);
  });

  it('writes a zero normal for a zero-area triangle, keeps the header ASCII and handles an empty mesh', () => {
    const flat: MeshData = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), indices: new Uint32Array([0, 1, 2]) };
    const view = new DataView(writeStl(flat, 'P02').buffer);
    expect([0, 1, 2].map((i) => view.getFloat32(84 + i * 4, true))).toEqual([0, 0, 0]);
    const odd = writeStl(flat, '外殼');
    expect(Array.from(odd.subarray(0, 80)).every((byte) => byte >= 0x20 && byte < 0x7f)).toBe(true);
    expect(writeStl({ positions: new Float32Array(), indices: new Uint32Array() }, 'P03').length).toBe(84);
  });
});

// ---- zip ---------------------------------------------------------------------------------------------------------

/** Reads local file headers: name, compression method and compressed size of each entry in file order. */
function zipEntryInfo(zip: Uint8Array): Array<{ name: string; method: number; compressed: number }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries: Array<{ name: string; method: number; compressed: number }> = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    entries.push({ name: strFromU8(zip.subarray(offset + 30, offset + 30 + nameLength)), method, compressed });
    offset += 30 + nameLength + extraLength + compressed;
  }
  return entries;
}

describe('zipFiles', () => {
  const png = Uint8Array.from({ length: 400 }, (_, i) => i % 7);
  const text = new TextEncoder().encode('材料清單 '.repeat(300));
  const files: KitFile[] = [
    { path: 'exploded.png', bytes: png, mime: 'image/png' },
    { path: 'bom.csv', bytes: text, mime: 'text/csv;charset=utf-8' },
    { path: 'stl/P01-housing.stl', bytes: text, mime: 'model/stl' },
  ];

  it('keeps the entry order, stores PNG and deflates text', () => {
    const zip = zipFiles(files, MTIME);
    const info = zipEntryInfo(zip);
    expect(info.map((entry) => entry.name)).toEqual(['exploded.png', 'bom.csv', 'stl/P01-housing.stl']);
    expect(info[0]).toMatchObject({ method: 0, compressed: png.length });
    expect(info[1]!.method).toBe(8);
    expect(info[1]!.compressed).toBeLessThan(text.length);
    const unzipped = unzipSync(zip);
    expect(Object.keys(unzipped)).toEqual(['exploded.png', 'bom.csv', 'stl/P01-housing.stl']);
    expect(Array.from(unzipped['exploded.png']!)).toEqual(Array.from(png));
    expect(strFromU8(unzipped['bom.csv']!)).toBe(strFromU8(text));
  });

  it('gives identical bytes for the same input and mtime', () => {
    expect(Array.from(zipFiles(files, MTIME))).toEqual(Array.from(zipFiles(files, MTIME)));
    expect(Array.from(zipFiles(files, new Date(MTIME.getTime() + 60_000 * 60 * 24)))).not.toEqual(Array.from(zipFiles(files, MTIME)));
  });

  it('rejects non-ASCII, unsafe, digit-only and duplicate paths', () => {
    const file = (path: string): KitFile => ({ path, bytes: new Uint8Array([1]), mime: 'text/plain' });
    for (const path of ['外殼.stl', 'a b.txt', '', '../x', '/abs', 'a//b', './a', 'a/', '12', '[Content_Types].xml']) {
      expect(() => zipFiles([file(path)], MTIME), path).toThrow();
    }
    expect(() => zipFiles([file('a.txt'), file('a.txt')], MTIME)).toThrow();
    expect(() => zipFiles([file('__proto__')], MTIME)).toThrow();
    expect(() => zipFiles([file('a/__proto__/b')], MTIME)).toThrow();
    expect(() => zipFiles([file('constructor'), file('toString')], MTIME)).not.toThrow();
  });

  it('names the kit by local time', () => {
    expect(kitZipName(new Date(2026, 10, 20, 9, 5))).toBe('forgehand-kit-20261120-0905.zip');
    expect(kitZipName(new Date(2027, 0, 2, 23, 59))).toBe('forgehand-kit-20270102-2359.zip');
  });
});

// ---- 3MF ---------------------------------------------------------------------------------------------------------

describe('3MF', () => {
  const objects = [
    piece('P01', box(30, 20, 10), { name: '外殼（相機）' }),
    piece('P02', box(10, 10, 10), { color: '#59D9E8', copies: 3 }),
    piece('P03', tetra(), { color: '#ff0000' }),
  ];

  it('writes the three package entries in order with the exact strings', () => {
    const files = unzipSync(write3mf({ title: '相機', objects }, MTIME));
    expect(Object.keys(files)).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    const types = strFromU8(files['[Content_Types].xml']!);
    expect(types).toContain('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">');
    expect(types).toContain('<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>');
    expect(types).toContain('<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>');
    const rels = strFromU8(files['_rels/.rels']!);
    expect(rels).toContain('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">');
    expect(rels).toContain('<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>');
    const xml = strFromU8(files['3D/3dmodel.model']!);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="zh-TW" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">')).toBe(true);
    expect(xml).toContain('<metadata name="Title">相機</metadata>');
    expect(xml).toContain('<metadata name="Application">Forgehand</metadata>');
    expect(xml).not.toContain('\r');
    // Every entry is deflated.
    expect(zipEntryInfo(write3mf({ title: 't', objects }, MTIME)).every((entry) => entry.method === 8)).toBe(true);
  });

  it('writes one base material per distinct colour and points every object at it', () => {
    const xml = threeMfModelXml({ title: 't', objects });
    expect(xml.match(/<base /g)).toHaveLength(2);
    expect(xml).toContain('<basematerials id="1"><base name="#59D9E8" displaycolor="#59D9E8FF"/><base name="#FF0000" displaycolor="#FF0000FF"/></basematerials>');
    expect([...xml.matchAll(/<object id="(\d+)" type="model" name="[^"]*" pid="1" pindex="(\d+)">/g)].map((m) => [m[1], m[2]]))
      .toEqual([['2', '0'], ['3', '0'], ['4', '1']]);
  });

  it('escapes names and drops control characters', () => {
    const xml = threeMfModelXml({ title: 'a<b>&"c\u0002', objects: [piece('P01', box(1, 1, 1), { name: 'x<&"\'\u0001y' })] });
    expect(xml).toContain('name="P01 x&lt;&amp;&quot;&apos;y"');
    expect(xml).toContain('<metadata name="Title">a&lt;b&gt;&amp;&quot;c</metadata>');
    expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it('keeps every triangle index inside its mesh and every item on an existing object', () => {
    const xml = threeMfModelXml({ title: 't', objects });
    const ids = new Set<string>();
    for (const match of xml.matchAll(/<object id="(\d+)"[^>]*>\s*<mesh>(.*?)<\/mesh>/gs)) {
      expect(ids.has(match[1]!)).toBe(false);
      ids.add(match[1]!);
      const body = match[2]!;
      const vertices = (body.match(/<vertex /g) ?? []).length;
      const refs = [...body.matchAll(/v[123]="(\d+)"/g)].map((m) => Number(m[1]));
      expect(vertices).toBeGreaterThan(0);
      expect(refs.length).toBeGreaterThan(0);
      expect(Math.max(...refs)).toBeLessThan(vertices);
    }
    expect([...ids]).toEqual(['2', '3', '4']);
    for (const item of xml.matchAll(/<item objectid="(\d+)"/g)) expect(ids.has(item[1]!)).toBe(true);
  });

  it('writes one build item per copy, in piece order, with a flat transform', () => {
    const xml = threeMfModelXml({ title: 't', objects });
    const items = [...xml.matchAll(/<item objectid="(\d+)" transform="1 0 0 0 1 0 0 0 1 (-?[\d.]+) (-?[\d.]+) 0"\/>/g)];
    expect(items.map((m) => m[1])).toEqual(['2', '3', '3', '3', '4']);
    expect(xml.match(/<item /g)).toHaveLength(5);
  });

  it('is deterministic and refuses an empty or malformed input', () => {
    expect(Array.from(write3mf({ title: 't', objects }, MTIME))).toEqual(Array.from(write3mf({ title: 't', objects }, MTIME)));
    expect(() => threeMfModelXml({ title: 't', objects: [] })).toThrow();
    expect(() => threeMfModelXml({ title: 't', objects: [piece('P01', box(1, 1, 1), { color: 'red' })] })).toThrow();
    expect(() => layoutPlate([piece('P01', box(1, 1, 1), { copies: 0 })])).toThrow();
    expect(() => layoutPlate([piece('P01', box(1, 1, 1), { copies: 1.5 })])).toThrow();
  });
});

describe('plate layout', () => {
  const footprints = (list: readonly ThreeMfObject[]) => layoutPlate(list).map((item) => {
    const { min, max } = meshBounds(list[item.objectIndex]!.mesh);
    const w = max[0] - min[0];
    const d = max[1] - min[1];
    return { index: item.objectIndex, x0: item.x - w / 2, x1: item.x + w / 2, y0: item.y - d / 2, y1: item.y + d / 2 };
  });

  it('keeps footprints apart by at least the gap and starts at (0, 0)', () => {
    const list = [piece('P01', box(60, 40, 10), { copies: 2 }), piece('P02', box(30, 90, 10)), piece('P03', box(100, 20, 10), { copies: 2 })];
    const boxes = footprints(list);
    expect(boxes[0]).toMatchObject({ x0: 0, y0: 0 });
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const gapX = Math.max(a.x0 - b.x1, b.x0 - a.x1);
        const gapY = Math.max(a.y0 - b.y1, b.y0 - a.y1);
        expect(Math.max(gapX, gapY), `${i} and ${j}`).toBeGreaterThanOrEqual(PLATE_GAP_MM - 1e-9);
      }
    }
  });

  it('wraps a row before it passes 220 mm and puts a wide copy on its own row', () => {
    const list = [piece('P01', box(60, 40, 10), { copies: 5 })];
    const boxes = footprints(list);
    expect(boxes.map((b) => b.x0)).toEqual([0, 65, 130, 0, 65]); // 3 × 60 + 2 × 5 = 190; a fourth would end at 255
    expect(boxes.map((b) => b.y0)).toEqual([0, 0, 0, 45, 45]);
    expect(Math.max(...boxes.map((b) => b.x1))).toBeLessThanOrEqual(PLATE_ROW_MM);

    const wide = footprints([piece('P01', box(30, 20, 10)), piece('P02', box(300, 50, 10)), piece('P03', box(30, 20, 10))]);
    expect(wide.map((b) => [b.x0, b.y0])).toEqual([[0, 0], [0, 25], [0, 80]]);
  });

  it('offsets the item so an off-centre mesh still lands on its footprint', () => {
    const shifted = box(10, 10, 10);
    const moved: MeshData = { positions: shifted.positions.map((v, i) => (i % 3 === 0 ? v + 100 : v)), indices: shifted.indices };
    const xml = threeMfModelXml({ title: 't', objects: [piece('P01', moved)] });
    // Footprint x 0..10 has its centre at 5 and the mesh centre is at 105, so the item moves by −100; y is already centred.
    expect(xml).toContain('transform="1 0 0 0 1 0 0 0 1 -100 0 0"');
  });
});

// ---- GLB scene ---------------------------------------------------------------------------------------------------

describe('buildGlbScene', () => {
  const base = createObject(emptyWorkspace(), { id: 'cam', model: demoModel, source: 'demo', providerModel: 'demo', createdAt: '2026-11-20T00:00:00.000Z' });
  const cam: SceneObject = { ...base, material: 'pla', transform: { position: { x: 0.5, y: 0.1, z: -0.2 }, rotation: { x: 0, y: 90, z: 0 } } };
  const other: SceneObject = { ...base, id: 'cam2', material: null, transform: { position: { x: -1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } };

  it('names objects and parts, applies object transforms and carries extras', () => {
    const scene = buildGlbScene([cam, other]);
    try {
      expect(scene.children.map((child) => child.name)).toEqual([demoModel.name, demoModel.name]);
      const [first, second] = scene.children;
      expect(first!.position.toArray()).toEqual([0.5, 0.1, -0.2]);
      expect(first!.rotation.y).toBeCloseTo(Math.PI / 2, 9);
      expect(first!.userData).toEqual({ objectId: 'cam', material: 'pla' });
      expect(second!.userData).toEqual({ objectId: 'cam2', material: null });

      const parts = new Map<string, THREE.Object3D>();
      first!.traverse((node) => { if (typeof node.userData.partId === 'string') parts.set(node.userData.partId, node); });
      expect([...parts.keys()]).toEqual(demoModel.parts.map((part) => part.id));
      for (const part of demoModel.parts) {
        const node = parts.get(part.id)!;
        expect(node.name).toBe(part.name);
        expect(node.userData).toMatchObject({ objectId: 'cam', material: 'pla', partId: part.id, role: part.role, primitive: part.primitive });
        expect(node.position.toArray()).toEqual([part.position.x, part.position.y, part.position.z]);
        const mesh = node.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh)!;
        expect(mesh.name).toBe(part.name);
        const material = mesh.material as THREE.MeshStandardMaterial;
        expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect(material.color.getHexString()).toBe(part.color.slice(1).toLowerCase());
        expect(material.transparent).toBe(false);
        expect(material.opacity).toBe(1);
      }
      // A child part keeps its parent in the hierarchy.
      const child = demoModel.parts.find((part) => part.parentId)!;
      expect(parts.get(child.id)!.parent).toBe(parts.get(child.parentId!));
    } finally {
      scene.traverse((node) => {
        if (node instanceof THREE.Mesh) { node.geometry.dispose(); (node.material as THREE.Material).dispose(); }
      });
    }
  });

  it('gives an empty scene for no objects', () => {
    expect(buildGlbScene([]).children).toHaveLength(0);
  });
});
