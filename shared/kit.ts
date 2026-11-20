import { jointFeatures, type FeatureSet, type JointFeatureSet } from './features';
import type { Joint } from './joint';
import { partName, sideInfo, type SideInfo } from './joint-rules';
import type { PrinterProfile } from './printer';
import { INSERTS, MAGNETS, PINS, type GlueId } from './standard-parts';
import type { Workspace } from './workspace';

/**
 * The kit of a workspace: what to buy and how to put it together (assembly-joints
 * requirements 68 and 69, design 6.3 and 6.4). Pure; the `export` spec imports this one module
 * for everything it needs from the joint rules.
 */
export { assemblyOf } from './assembly';
export { jointFeatures } from './features';
export { checkJoints } from './joint-rules';

export interface BomItem {
  kind: 'screw' | 'insert' | 'magnet' | 'pin' | 'glue';
  /** `M3x8`, `M3x5.7`, `d6x3`, `d3x10`, `ca`. */
  standardId: string;
  /** Traditional Chinese label. */
  label: string;
  quantity: number;
  /** Joints that need the item, in workspace order. */
  jointIds: string[];
}

const GLUE_BOM_LABELS: Record<GlueId, string> = {
  ca: '瞬間膠（CA）',
  epoxy: 'AB 膠（環氧樹脂）',
  solvent: '溶劑（ABS 用，例如丙酮）',
};

const KIND_ORDER: Record<BomItem['kind'], number> = { screw: 0, insert: 1, magnet: 2, pin: 3, glue: 4 };
const GLUE_ORDER: Record<GlueId, number> = { ca: 0, epoxy: 1, solvent: 2 };

/** An item with its size key (diameter, then length or thickness), for ordering inside a kind. */
interface Sized extends BomItem { size: [number, number] }

/**
 * The standard parts to buy, aggregated across joints by standard id. Ordered screws, inserts,
 * magnets, pins, glue, then by size. A screw or pin item is left out when no standard length
 * fits (`NO_LENGTH`; the finding says why). Magnets count one per side and position. Glue is
 * one item per glue type, quantity 1.
 */
export function jointBom(ws: Workspace, profile: PrinterProfile, features: FeatureSet = jointFeatures(ws, profile)): BomItem[] {
  const items = new Map<string, Sized>();
  const add = (joint: Joint, kind: BomItem['kind'], standardId: string, label: string, quantity: number, size: [number, number]) => {
    if (quantity <= 0) return;
    const known = items.get(`${kind}:${standardId}`);
    if (known) {
      known.quantity = kind === 'glue' ? 1 : known.quantity + quantity;
      if (!known.jointIds.includes(joint.id)) known.jointIds.push(joint.id);
    } else {
      items.set(`${kind}:${standardId}`, { kind, standardId, label, quantity, jointIds: [joint.id], size });
    }
  };
  for (const joint of ws.joints) {
    const set = features.joints.get(joint.id);
    if (!set) continue;
    const { method } = joint;
    const positions = set.derived.positions;
    if (method.kind === 'screw-insert') {
      const diameter = Number(method.size.slice(1));
      const length = set.derived.screwLengthMm;
      if (length !== null) add(joint, 'screw', `${method.size}x${length}`, `${method.size}×${length} 內六角螺絲（ISO 4762）`, positions, [diameter, length]);
      const insert = INSERTS[method.size];
      const inserts = set.features.filter(feature => feature.kind === 'insert-hole').length;
      add(joint, 'insert', `${method.size}x${insert.lengthMm}`, `${method.size}×${insert.lengthMm} 熱壓螺母（${insert.vendor}）`, inserts, [diameter, insert.lengthMm]);
    } else if (method.kind === 'magnet') {
      const magnet = MAGNETS[method.magnet];
      add(joint, 'magnet', method.magnet, `${magnet.diameterMm}×${magnet.thicknessMm} mm 圓形釹磁鐵`, 2 * positions, [magnet.diameterMm, magnet.thicknessMm]);
    } else if (method.kind === 'pin') {
      const pin = PINS[method.pin];
      const length = set.derived.pinLengthMm;
      if (length !== null) add(joint, 'pin', `d${pin.diameterMm}x${length}`, `Ø${pin.diameterMm}×${length} mm 定位銷（ISO 8734）`, positions, [pin.diameterMm, length]);
    } else {
      add(joint, 'glue', method.glue, GLUE_BOM_LABELS[method.glue], 1, [GLUE_ORDER[method.glue], 0]);
    }
  }
  return [...items.values()]
    .sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.size[0] - y.size[0] || x.size[1] - y.size[1])
    .map(({ size: _size, ...item }) => item);
}

const GLUE_NOTE_NAMES: Record<GlueId, string> = { ca: '瞬間膠', epoxy: 'AB 膠', solvent: '溶劑' };

const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

function noteFor(ws: Workspace, joint: Joint, set: JointFeatureSet): string | null {
  const a = sideInfo(ws, joint.a, 'a');
  const b = sideInfo(ws, joint.b, 'b');
  if (!a || !b) return null;
  const cross = joint.a.objectId !== joint.b.objectId;
  const name = (info: SideInfo) => `「${partName(info, cross)}」`;
  const { method } = joint;
  const count = set.derived.positions > 0 ? set.derived.positions : method.kind === 'glue' ? 1 : method.count;
  switch (method.kind) {
    case 'screw-insert': {
      const insertSide = method.insertSide === 'a' ? a : b;
      const screwSide = method.insertSide === 'a' ? b : a;
      const length = set.derived.screwLengthMm;
      const screw = `${count} 支 ${method.size}${length !== null ? `×${length}` : ''} 螺絲`;
      if (insertSide.kind === 'metal') return `用 ${screw}從${name(screwSide)}鎖入${name(insertSide)}的 ${method.size} 螺紋孔（需先攻牙）。`;
      const nuts = `先用烙鐵把 ${count} 顆 ${method.size} 熱壓螺母壓入${name(insertSide)}，`;
      return screwSide.kind === 'component'
        ? `${nuts}再用 ${screw}穿過${name(screwSide)}原有的孔鎖上。`
        : `${nuts}再用 ${screw}從${name(screwSide)}鎖上。`;
    }
    case 'magnet': {
      const magnet = MAGNETS[method.magnet];
      return `把 ${2 * count} 顆 ${magnet.diameterMm}×${magnet.thicknessMm} mm 磁鐵壓入${name(a)}與${name(b)}的孔位，壓入前先確認兩側磁極相吸。`;
    }
    case 'pin': {
      const pin = PINS[method.pin];
      const length = set.derived.pinLengthMm;
      const part = `${count} 支 Ø${pin.diameterMm}${length !== null ? `×${length}` : ''} mm 定位銷`;
      return method.fit === 'press-slide'
        ? `把 ${part}壓入${name(a)}，再把${name(b)}套上；這一側是滑配，可以拆開。`
        : `把 ${part}壓入${name(a)}，再對準${name(b)}壓合。`;
    }
    case 'glue':
      return `在${name(a)}與${name(b)}的接觸面塗上${GLUE_NOTE_NAMES[method.glue]}，對準後壓緊直到固化。`;
  }
}

/**
 * One instruction per joint, joints ordered by `createdAt`, then id. Part names are qualified
 * with the object's name when the two sides belong to different objects. A joint whose face no
 * longer exists has no note.
 */
export function assemblyNotes(
  ws: Workspace, profile: PrinterProfile, features: FeatureSet = jointFeatures(ws, profile),
): Array<{ jointId: string; text: string }> {
  const notes: Array<{ jointId: string; text: string }> = [];
  const ordered = [...ws.joints].sort((x, y) => compare(x.createdAt, y.createdAt) || compare(x.id, y.id));
  for (const joint of ordered) {
    const set = features.joints.get(joint.id);
    const text = set ? noteFor(ws, joint, set) : null;
    if (text !== null) notes.push({ jointId: joint.id, text });
  }
  return notes;
}
