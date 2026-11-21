import { z } from 'zod';
import { assemblyOf } from './assembly';
import { jointFeatures, type FeatureSet, type JointFeature } from './features';
import { ObjectIdSchema } from './ids';
import type { Joint, JointMethod } from './joint';
import { checkJoints, partName, sideInfo } from './joint-rules';
import { assemblyNotes, jointBom } from './kit';
import { MATERIALS, MaterialIdSchema, type MaterialId } from './materials';
import type { Part } from './model';
import type { PrinterProfile } from './printer';
import { findObject, WorkspaceError, type SceneObject, type Workspace } from './workspace';

/**
 * The kit plan of the export spec (requirements 1, 4, 5, 30, 31, 56 and 63, design 4): which
 * objects are in scope, what is printed, bought or machined, how joints are named and numbered,
 * and the summary the agent reads. Pure: only Three.js math classes through the joint rules,
 * no DOM and no import from `src/`, so the server can import it.
 */

type Vector = { x: number; y: number; z: number };

export const ExportScopeSchema = z.strictObject({
  scope: z.enum(['workspace', 'assembly']),
  objectId: ObjectIdSchema.nullable(),
});
export type ExportScope = z.infer<typeof ExportScopeSchema>;

const NO_MODEL_MESSAGE = '目前沒有模型，請先生成設計。';

/**
 * `WorkspaceErrorCode` has no code for an empty workspace and that file belongs to
 * `assembly-joints`, so the one failure the plan adds has its own error. The message is fixed text.
 */
export class ExportPlanError extends Error {
  readonly code = 'NO_MODEL' as const;
  constructor() {
    super(NO_MODEL_MESSAGE);
    this.name = 'ExportPlanError';
  }
}

/**
 * The part of the workspace an export covers (requirement 1). `workspace` keeps every object;
 * `assembly` keeps `assemblyOf` of `scope.objectId` (or of the active object when it is null).
 * Objects and joints keep their references. The result keeps only joints whose two sides are
 * kept, clears the selection, sets explode to 0 and keeps the active object when it is kept
 * (else the first kept object). Throws `ExportPlanError` for an empty workspace and
 * `WorkspaceError('UNKNOWN_OBJECT')` for an unknown object.
 */
export function scopeWorkspace(ws: Workspace, scope: ExportScope): Workspace {
  if (ws.objects.length === 0) throw new ExportPlanError();
  let kept: ReadonlySet<string>;
  if (scope.scope === 'workspace') {
    kept = new Set(ws.objects.map(object => object.id));
  } else {
    const rootId = scope.objectId ?? ws.activeObjectId;
    if (rootId === null || !findObject(ws, rootId)) throw new WorkspaceError('UNKNOWN_OBJECT');
    kept = new Set(assemblyOf(ws, rootId));
  }
  const objects = ws.objects.filter(object => kept.has(object.id));
  const joints = ws.joints.filter(joint => kept.has(joint.a.objectId) && kept.has(joint.b.objectId));
  const activeObjectId = ws.activeObjectId !== null && kept.has(ws.activeObjectId) ? ws.activeObjectId : objects[0]!.id;
  return { ...ws, objects, joints, activeObjectId, selection: { objectId: null, partIds: [] }, display: { explode: 0 } };
}

export type PartClass = 'printed' | 'bought' | 'machined';

/**
 * Requirement 4. An interior part is a bought component whatever the object's material says;
 * an exterior part of an aluminium or steel object is machined; every other exterior part is
 * printed (an object with no material counts as generic FDM plastic).
 */
export function classifyPart(object: Pick<SceneObject, 'material'>, part: Pick<Part, 'role'>): PartClass {
  if (part.role === 'interior') return 'bought';
  const material = object.material ?? null;
  return material !== null && MATERIALS[material].process === 'metal' ? 'machined' : 'printed';
}

export const METHOD_KIND_LABELS: Record<JointMethod['kind'], string> = {
  'screw-insert': '熱壓螺母＋螺絲',
  magnet: '磁鐵',
  pin: '定位銷',
  glue: '膠合',
};

const MISSING_PART = '（已不存在的零件）';

/** The names of a joint's two parts, qualified with the object's name when the sides belong to different objects. */
export function jointSideNames(ws: Workspace, joint: Joint): { a: string; b: string } {
  const a = sideInfo(ws, joint.a, 'a');
  const b = sideInfo(ws, joint.b, 'b');
  const cross = joint.a.objectId !== joint.b.objectId;
  return { a: a ? partName(a, cross) : MISSING_PART, b: b ? partName(b, cross) : MISSING_PART };
}

/** 「A・電池」↔「B・外殼」, or 「電池」↔「外殼」 inside one object. */
export function jointLabel(ws: Workspace, joint: Joint): string {
  const { a, b } = jointSideNames(ws, joint);
  return `「${a}」↔「${b}」`;
}

/**
 * Step number of every joint that has an assembly note: step n is the n-th entry of
 * `assemblyNotes`, counted from 1 (requirements 36 and 42). A joint whose face is gone has no step.
 */
export function stepNumbers(ws: Workspace, profile: PrinterProfile, features?: FeatureSet): Map<string, number> {
  const steps = new Map<string, number>();
  assemblyNotes(ws, profile, features).forEach((note, index) => steps.set(note.jointId, index + 1));
  return steps;
}

// Micrometre precision keeps 0.16 m from becoming 160.00000000000003 mm.
const toMm = (metres: number) => Math.round(metres * 1e6) / 1e3;
const sizeMm = (dimensions: Vector): Vector => ({ x: toMm(dimensions.x), y: toMm(dimensions.y), z: toMm(dimensions.z) });
const tenth = (mm: number) => Math.round(mm * 10);

export interface BoughtRow { name: string; objectNames: string[]; sizeMm: Vector; count: number }

/**
 * Requirement 30: the interior parts in scope, one row per name, primitive and dimensions
 * (rounded to 0.1 mm). Rows keep the order of first appearance; each object name is listed once.
 */
export function boughtRows(ws: Workspace): BoughtRow[] {
  const rows = new Map<string, BoughtRow>();
  for (const object of ws.objects) {
    for (const part of object.model.parts) {
      if (classifyPart(object, part) !== 'bought') continue;
      const size = sizeMm(part.dimensions);
      const key = JSON.stringify([part.name, part.primitive, tenth(size.x), tenth(size.y), tenth(size.z)]);
      const known = rows.get(key);
      if (known) {
        known.count += 1;
        if (!known.objectNames.includes(object.model.name)) known.objectNames.push(object.model.name);
      } else {
        rows.set(key, { name: part.name, objectNames: [object.model.name], sizeMm: size, count: 1 });
      }
    }
  }
  return [...rows.values()];
}

export interface MachinedRow { name: string; objectName: string; material: MaterialId; sizeMm: Vector; features: string[] }

const trimMm = (value: number) => String(Number(value.toFixed(2)));

/** The label of one machined feature, without its count; `null` for kinds that are never machined. */
function machinedLabel(ws: Workspace, feature: JointFeature): string | null {
  const diameter = trimMm(feature.nominal.diameterMm);
  switch (feature.kind) {
    case 'tapped-hole': {
      const method = ws.joints.find(joint => joint.id === feature.jointId)?.method;
      return method?.kind === 'screw-insert' ? `${method.size} 攻牙孔` : '攻牙孔';
    }
    case 'drilled-hole': return `Ø${diameter} mm 通孔`;
    case 'magnet-pocket': return `Ø${diameter}×${trimMm(feature.nominal.depthMm)} mm 磁鐵槽`;
    case 'pin-hole': return `Ø${diameter} mm 銷孔`;
    default: return null;
  }
}

/**
 * Requirement 31: one row per exterior part of an aluminium or steel object, with its
 * machined features from `jointFeatures` (「M3 攻牙孔 ×2」), grouped by label in order of first use.
 */
export function machinedRows(ws: Workspace, features: FeatureSet): MachinedRow[] {
  const rows: MachinedRow[] = [];
  for (const object of ws.objects) {
    for (const part of object.model.parts) {
      if (classifyPart(object, part) !== 'machined') continue;
      const counts = new Map<string, number>();
      for (const feature of features.parts.get(`${object.id}:${part.id}`) ?? []) {
        if (feature.made !== 'machined') continue;
        const label = machinedLabel(ws, feature);
        if (label !== null) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      rows.push({
        name: part.name, objectName: object.model.name, material: object.material!, sizeMm: sizeMm(part.dimensions),
        features: [...counts].map(([label, count]) => `${label} ×${count}`),
      });
    }
  }
  return rows;
}

export const MAX_SUMMARY_PROBLEMS = 40;

export const ExportSummarySchema = z.strictObject({
  scope: ExportScopeSchema,
  objects: z.array(z.strictObject({
    objectId: ObjectIdSchema,
    name: z.string(),
    material: MaterialIdSchema.nullable(),
    printed: z.number().int().min(0),
    bought: z.number().int().min(0),
    machined: z.number().int().min(0),
  })),
  standardParts: z.array(z.strictObject({ label: z.string(), quantity: z.number().int().min(1) })),
  unconfirmed: z.array(z.strictObject({ jointId: ObjectIdSchema, label: z.string(), method: z.string() })),
  problems: z.array(z.strictObject({ severity: z.enum(['error', 'warning']), code: z.string(), message: z.string() })).max(MAX_SUMMARY_PROBLEMS),
  note: z.string(),
});
export type ExportSummary = z.infer<typeof ExportSummarySchema>;

/**
 * What the agent needs to describe the kit (requirement 56), computed without CSG: the parts of
 * each object by class, the standard parts, the unconfirmed joints and the joint findings of
 * severity error or warning (at most `MAX_SUMMARY_PROBLEMS`, each prefixed with the joint's
 * label). Print pieces are counted only in the browser, so the note says so.
 */
export function exportSummary(ws: Workspace, scope: ExportScope, profile: PrinterProfile): ExportSummary {
  const scoped = scopeWorkspace(ws, scope);
  const features = jointFeatures(scoped, profile);
  const counted = scoped.objects.map(object => {
    const counts = { printed: 0, bought: 0, machined: 0 };
    for (const part of object.model.parts) counts[classifyPart(object, part)] += 1;
    return { objectId: object.id, name: object.model.name, material: object.material ?? null, ...counts };
  });
  const found = checkJoints(scoped, profile, features);
  const problems: ExportSummary['problems'] = [];
  for (const joint of scoped.joints) {
    for (const finding of found.get(joint.id) ?? []) {
      if (finding.severity === 'info') continue;
      problems.push({ severity: finding.severity, code: finding.code, message: `${jointLabel(scoped, joint)}：${finding.message}` });
    }
  }
  const printed = counted.reduce((sum, object) => sum + object.printed, 0);
  return {
    scope,
    objects: counted,
    standardParts: jointBom(scoped, profile, features).map(item => ({ label: item.label, quantity: item.quantity })),
    unconfirmed: scoped.joints.filter(joint => !joint.confirmed).map(joint => ({
      jointId: joint.id, label: jointLabel(scoped, joint), method: METHOD_KIND_LABELS[joint.method.kind],
    })),
    problems: problems.slice(0, MAX_SUMMARY_PROBLEMS),
    note: `列印零件 ${printed} 個（相連的零件會合併成一個列印件，實際數量以匯出視窗為準）`,
  };
}
