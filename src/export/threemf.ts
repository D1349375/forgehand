import { strToU8 } from 'fflate';
import { PLATE_GAP_MM, PLATE_ROW_MM } from './constants';
import { fmtNumber, xmlEscape } from './format';
import { meshBounds, type MeshData } from './mesh';
import { zipEntries } from './zip';

export interface ThreeMfObject {
  /** Piece number such as `P01`. The object is named `{number} {name}`; the caller puts the owning object's name into `name`. */
  number: string;
  name: string;
  /** `#rrggbb`, any case. */
  color: string;
  mesh: MeshData;
  /** How many times the piece sits on the plate; an integer of at least 1. */
  copies: number;
}

export interface PlateItem {
  objectIndex: number;
  /** Centre of the copy's footprint on the plate, in millimetres. */
  x: number;
  y: number;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Places every copy flat on the plate: shelf packing, left to right from (0, 0) in piece order with `PLATE_GAP_MM`
 * between footprints. A row ends before it would pass `PLATE_ROW_MM`; a copy wider than a row gets a row of its own.
 */
export function layoutPlate(objects: readonly ThreeMfObject[]): PlateItem[] {
  const items: PlateItem[] = [];
  let cursorX = 0;
  let rowY = 0;
  let rowDepth = 0;
  objects.forEach((object, objectIndex) => {
    if (!Number.isInteger(object.copies) || object.copies < 1) throw new RangeError(`Piece ${object.number} needs at least one copy.`);
    const { min, max } = meshBounds(object.mesh);
    const width = max[0] - min[0];
    const depth = max[1] - min[1];
    for (let copy = 0; copy < object.copies; copy += 1) {
      if (cursorX > 0 && cursorX + width > PLATE_ROW_MM) {
        rowY += rowDepth + PLATE_GAP_MM;
        cursorX = 0;
        rowDepth = 0;
      }
      items.push({ objectIndex, x: cursorX + width / 2, y: rowY + depth / 2 });
      cursorX += width + PLATE_GAP_MM;
      rowDepth = Math.max(rowDepth, depth);
    }
  });
  return items;
}

/** The 3D/3dmodel.model document. Output is deterministic. */
export function threeMfModelXml(input: { title: string; objects: readonly ThreeMfObject[] }): string {
  const { objects } = input;
  if (objects.length === 0) throw new RangeError('A 3MF file needs at least one object.');

  const colors: string[] = [];
  const colorIndex = objects.map((object) => {
    if (!COLOR.test(object.color)) throw new RangeError(`Piece ${object.number} has an invalid colour.`);
    const color = object.color.toUpperCase();
    let index = colors.indexOf(color);
    if (index < 0) { index = colors.length; colors.push(color); }
    return index;
  });

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="zh-TW" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    `  <metadata name="Title">${xmlEscape(input.title)}</metadata>`,
    '  <metadata name="Application">Forgehand</metadata>',
    '  <resources>',
    `    <basematerials id="1">${colors.map((color) => `<base name="${color}" displaycolor="${color}FF"/>`).join('')}</basematerials>`,
  ];
  objects.forEach((object, index) => {
    const p = object.mesh.positions;
    const vertices: string[] = [];
    for (let i = 0; i + 2 < p.length; i += 3) {
      vertices.push(`<vertex x="${fmtNumber(p[i]!)}" y="${fmtNumber(p[i + 1]!)}" z="${fmtNumber(p[i + 2]!)}"/>`);
    }
    const triangles: string[] = [];
    const idx = object.mesh.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) triangles.push(`<triangle v1="${idx[t]}" v2="${idx[t + 1]}" v3="${idx[t + 2]}"/>`);
    lines.push(
      `    <object id="${index + 2}" type="model" name="${xmlEscape(`${object.number} ${object.name}`)}" pid="1" pindex="${colorIndex[index]}">`,
      `      <mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh>`,
      '    </object>',
    );
  });
  lines.push('  </resources>', '  <build>');
  for (const item of layoutPlate(objects)) {
    // The footprint centre lands on (item.x, item.y); meshes from `toPrintFrame` are centred, so the offset is zero.
    const { min, max } = meshBounds(objects[item.objectIndex]!.mesh);
    const tx = item.x - (min[0] + max[0]) / 2;
    const ty = item.y - (min[1] + max[1]) / 2;
    lines.push(`    <item objectid="${item.objectIndex + 2}" transform="1 0 0 0 1 0 0 0 1 ${fmtNumber(tx)} ${fmtNumber(ty)} 0"/>`);
  }
  lines.push('  </build>', '</model>', '');
  return lines.join('\n');
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
  + '</Types>';

const RELATIONSHIPS = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
  + '</Relationships>';

/** The 3MF package (Core Specification only), deflated, with every entry stamped `mtime`. */
export function write3mf(input: { title: string; objects: readonly ThreeMfObject[] }, mtime: Date): Uint8Array {
  return zipEntries([
    { path: '[Content_Types].xml', bytes: strToU8(CONTENT_TYPES) },
    { path: '_rels/.rels', bytes: strToU8(RELATIONSHIPS) },
    { path: '3D/3dmodel.model', bytes: strToU8(threeMfModelXml(input)) },
  ], mtime);
}
