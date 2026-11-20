import * as THREE from 'three';
import { partBoxes, worldMatrices } from './bounds';
import { jointFeatures, partThickness, type FeatureProblem, type FeatureSet, type JointFeature } from './features';
import type { Joint, JointMethod, JointNeeds, JointSide } from './joint';
import { MATERIALS, type MaterialId, type Rating } from './materials';
import type { Part } from './model';
import type { PrinterProfile } from './printer';
import { GLUES, type GlueId } from './standard-parts';
import { findObject, WorkspaceError, type SceneObject, type Workspace } from './workspace';

/**
 * Checks and recommendations for joints (assembly-joints requirements 39 to 42,
 * design 6.1 and 6.2). Pure: only Three.js math classes, no DOM, no model calls.
 * Checks are advisory; they never block a joint. Messages are fixed Traditional
 * Chinese text and never contain object, part or joint ids.
 */

export type FindingCode =
  | 'APART' | 'NO_FACE' | 'NO_ROOM' | 'TOO_THIN' | 'NO_LENGTH' | 'OVERLAP' | 'COMPONENT_FEATURE'
  | 'GLUE_POOR' | 'SOLVENT_NOT_ABS' | 'METAL_GLUE' | 'INSERT_UNSUITABLE' | 'BOSS_COLLIDES'
  | 'SAME_MATERIAL' | 'NO_MATERIAL' | 'PETG_EXTRA' | 'RESIN_PROFILE' | 'MACHINED' | 'BOSS_ADDED' | 'THROUGH_HOLE';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding { jointId: string; severity: Severity; code: FindingCode; message: string }

export const FINDING_SEVERITY: Record<FindingCode, Severity> = {
  APART: 'error', NO_FACE: 'error', NO_ROOM: 'error', TOO_THIN: 'error', NO_LENGTH: 'error', OVERLAP: 'error', COMPONENT_FEATURE: 'error',
  GLUE_POOR: 'warning', SOLVENT_NOT_ABS: 'warning', METAL_GLUE: 'warning', INSERT_UNSUITABLE: 'warning', BOSS_COLLIDES: 'warning',
  SAME_MATERIAL: 'info', NO_MATERIAL: 'info', PETG_EXTRA: 'info', RESIN_PROFILE: 'info', MACHINED: 'info', BOSS_ADDED: 'info', THROUGH_HOLE: 'info',
};

/** Words that fill the `{item}` slot of a message. */
const ITEM = { insert: '熱壓螺母', counterbore: '螺絲頭沉孔', magnet: '磁鐵', pin: '定位銷', screw: '螺絲', joint: '接合' } as const;

interface MessageParams { n: number; item: string; part: string; material: string; glue: string; sameObject: boolean }

/** The fixed message of every finding code (design 6.1). */
export const FINDING_MESSAGES: Record<FindingCode, (p: MessageParams) => string> = {
  APART: p => (p.sameObject ? '接合面已分開，請調整零件。' : '已分開，可按「重新對齊」。'),
  NO_FACE: () => '接合面已不存在，請刪除這個接合。',
  NO_ROOM: p => `接合面太小，放不下 ${p.n} 個${p.item}。`,
  TOO_THIN: p => `「${p.part}」太薄，放不下${p.item}。`,
  NO_LENGTH: p => `沒有合適長度的標準${p.item}。`,
  OVERLAP: () => '與另一個接合的孔位重疊。',
  COMPONENT_FEATURE: p => `「${p.part}」是外購件，無法加工${p.item}。`,
  GLUE_POOR: p => `「${p.material}」不易用${p.glue}黏合。`,
  SOLVENT_NOT_ABS: () => '溶劑黏合只適用於兩側都是 ABS。',
  METAL_GLUE: () => '金屬與塑膠建議用螺絲或銷固定。',
  INSERT_UNSUITABLE: p => `「${p.material}」不適合熱壓螺母。`,
  BOSS_COLLIDES: p => `螺柱會碰到「${p.part}」。`,
  SAME_MATERIAL: () => '同材質接合最容易。',
  NO_MATERIAL: () => '未指定材料，先以一般 FDM 塑膠估算。',
  PETG_EXTRA: p => `PETG 已加大配合間隙 ${p.n} mm。`,
  RESIN_PROFILE: () => '列印設定是依 FDM 調整的，樹脂列印請另行測試。',
  MACHINED: () => '金屬零件需另行加工。',
  BOSS_ADDED: () => '已在背面加上螺柱。',
  THROUGH_HOLE: () => '螺絲孔貫穿到背面。',
};

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

const message = (code: FindingCode, params: Partial<MessageParams> = {}) =>
  FINDING_MESSAGES[code]({ n: 0, item: '', part: '', material: '', glue: '', sameObject: false, ...params });

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

type SideKind = 'printed' | 'metal' | 'component';

export interface SideInfo {
  tag: 'a' | 'b';
  side: JointSide;
  object: SceneObject;
  part: Part;
  kind: SideKind;
  /** The object's material; `null` when not set. */
  material: MaterialId | null;
}

export function sideInfo(ws: Workspace, side: JointSide, tag: 'a' | 'b'): SideInfo | null {
  const object = findObject(ws, side.objectId);
  const part = object?.model.parts.find(candidate => candidate.id === side.partId);
  if (!object || !part) return null;
  const material = object.material ?? null;
  // Interior parts are bought components whatever the object's material says (requirement 12).
  const kind: SideKind = part.role === 'interior' ? 'component' : material !== null && MATERIALS[material].process === 'metal' ? 'metal' : 'printed';
  return { tag, side, object, part, kind, material };
}

/** A part's name for a message: qualified with its object's name when the joint joins two objects. */
export const partName = (info: SideInfo, crossObject: boolean) => (crossObject ? `${info.object.model.name}・${info.part.name}` : info.part.name);

const materialLabel = (material: MaterialId) => MATERIALS[material].label;

/** The item a method puts on a side, for `TOO_THIN` and `COMPONENT_FEATURE` messages. */
function itemOn(method: JointMethod, tag: 'a' | 'b'): string {
  switch (method.kind) {
    case 'screw-insert': return tag === method.insertSide ? ITEM.insert : ITEM.counterbore;
    case 'magnet': return ITEM.magnet;
    case 'pin': return ITEM.pin;
    case 'glue': return ITEM.joint;
  }
}

/** The fixed message of a feature problem of a joint. */
function problemMessage(sides: { a: SideInfo | null; b: SideInfo | null }, joint: Pick<Joint, 'a' | 'b' | 'method'>, problem: FeatureProblem): string {
  const crossObject = joint.a.objectId !== joint.b.objectId;
  const info = problem.side ? sides[problem.side] : null;
  const part = info ? partName(info, crossObject) : '';
  const method = joint.method;
  switch (problem.code) {
    case 'APART': return message('APART', { sameObject: !crossObject });
    case 'NO_FACE': return message('NO_FACE');
    case 'OVERLAP': return message('OVERLAP');
    case 'NO_ROOM': return message('NO_ROOM', { n: method.kind === 'glue' ? 1 : method.count, item: method.kind === 'screw-insert' ? ITEM.insert : itemOn(method, 'a') });
    case 'NO_LENGTH': return message('NO_LENGTH', { item: method.kind === 'pin' ? ITEM.pin : ITEM.screw });
    case 'TOO_THIN': return message('TOO_THIN', { part, item: problem.side ? itemOn(method, problem.side) : ITEM.joint });
    case 'COMPONENT_FEATURE': return message('COMPONENT_FEATURE', { part, item: problem.side ? itemOn(method, problem.side) : ITEM.joint });
  }
}

// ---------------------------------------------------------------------------
// 6.1 Findings
// ---------------------------------------------------------------------------

const RATING_RANK: Record<Rating, number> = { poor: 0, fair: 1, good: 2 };
const worseOf = (ratings: readonly Rating[]): Rating => ratings.reduce<Rating>((worst, rating) => (RATING_RANK[rating] < RATING_RANK[worst] ? rating : worst), 'good');

/** Ratings of a glue on the sides that carry a known material (components and unset materials do not count). */
function glueRatings(infos: readonly SideInfo[], glue: GlueId): Rating[] {
  return infos.filter(info => info.kind !== 'component' && info.material !== null).map(info => MATERIALS[info.material!].glue[glue]);
}

/**
 * Sample points that cover a boss cylinder: rings at 90 % of its radius plus the axis, at
 * steps of at most 0.5 mm along it. `matrix` takes part-local points into the object's model frame.
 */
function bossSamples(feature: JointFeature, matrix: THREE.Matrix4): THREE.Vector3[] {
  const start = new THREE.Vector3(feature.centre.x, feature.centre.y, feature.centre.z).applyMatrix4(matrix);
  const axis = new THREE.Vector3(feature.axis.x, feature.axis.y, feature.axis.z).transformDirection(matrix);
  const helper = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(axis, helper).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  const radius = feature.diameter / 2;
  const steps = Math.max(3, Math.ceil(feature.depth / 0.0005));
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < steps; i++) {
    const centre = start.clone().addScaledVector(axis, ((i + 0.5) / steps) * feature.depth);
    points.push(centre);
    for (let k = 0; k < 8; k++) {
      const angle = (k / 8) * 2 * Math.PI;
      points.push(centre.clone().addScaledVector(u, Math.cos(angle) * radius * 0.9).addScaledVector(v, Math.sin(angle) * radius * 0.9));
    }
  }
  return points;
}

/** Other parts of the same object whose box contains part of the boss. */
function bossCollisions(ws: Workspace, feature: JointFeature): Part[] {
  const object = findObject(ws, feature.objectId);
  if (!object) return [];
  const matrix = worldMatrices(object.model).get(feature.partId);
  if (!matrix) return [];
  const samples = bossSamples(feature, matrix);
  const boxes = partBoxes(object.model);
  return object.model.parts.filter(part => {
    if (part.id === feature.partId) return false;
    const box = boxes.get(part.id)!.clone().expandByScalar(-1e-6);
    return !box.isEmpty() && samples.some(point => box.containsPoint(point));
  });
}

const trimNumber = (value: number) => String(Number(value.toFixed(3)));

/**
 * Findings for every joint, sorted error, warning, info, then by code and message,
 * so the card and the agent see a stable order. Every joint has an entry (maybe empty).
 */
export function checkJoints(ws: Workspace, profile: PrinterProfile, features: FeatureSet = jointFeatures(ws, profile)): Map<string, Finding[]> {
  const result = new Map<string, Finding[]>();
  for (const joint of ws.joints) {
    const set = features.joints.get(joint.id);
    const found = new Map<string, Finding>();
    const add = (code: FindingCode, text: string) => {
      const key = `${code}|${text}`;
      if (!found.has(key)) found.set(key, { jointId: joint.id, severity: FINDING_SEVERITY[code], code, message: text });
    };
    const a = sideInfo(ws, joint.a, 'a');
    const b = sideInfo(ws, joint.b, 'b');
    const sides = { a, b };
    for (const problem of set?.problems ?? []) add(problem.code, problemMessage(sides, joint, problem));
    if (!set || !a || !b || set.problems.some(problem => problem.code === 'NO_FACE')) {
      if (!set || !a || !b) add('NO_FACE', message('NO_FACE'));
      result.set(joint.id, sortFindings([...found.values()]));
      continue;
    }

    const infos = [a, b];
    const crossObject = joint.a.objectId !== joint.b.objectId;
    const method = joint.method;
    const printed = infos.filter(info => info.kind === 'printed');

    if (method.kind === 'glue') {
      if (method.glue === 'solvent') {
        if (!infos.every(info => info.kind !== 'component' && info.material !== null && MATERIALS[info.material].solvent === 'abs')) add('SOLVENT_NOT_ABS', message('SOLVENT_NOT_ABS'));
      } else {
        const label = GLUES[method.glue].label;
        const poor = new Set(infos.filter(info => info.kind !== 'component' && info.material !== null && MATERIALS[info.material].glue[method.glue] === 'poor').map(info => info.material!));
        for (const material of poor) add('GLUE_POOR', message('GLUE_POOR', { material: materialLabel(material), glue: label }));
      }
      const metal = infos.some(info => info.kind === 'metal');
      if (metal && printed.length > 0) add('METAL_GLUE', message('METAL_GLUE'));
    }
    if (method.kind === 'screw-insert') {
      const insertSide = method.insertSide === 'a' ? a : b;
      if (insertSide.kind === 'printed' && insertSide.material !== null && !MATERIALS[insertSide.material].inserts) {
        add('INSERT_UNSUITABLE', message('INSERT_UNSUITABLE', { material: materialLabel(insertSide.material) }));
      }
    }

    if (printed.some(info => info.material === null)) add('NO_MATERIAL', message('NO_MATERIAL'));
    if (crossObject && a.kind !== 'component' && b.kind !== 'component' && a.material !== null && a.material === b.material) add('SAME_MATERIAL', message('SAME_MATERIAL'));
    if (printed.some(info => info.material === 'resin')) add('RESIN_PROFILE', message('RESIN_PROFILE'));

    const list = set.features;
    if (profile.petgExtra > 0 && list.some(feature => feature.fit !== 'none' && feature.made === 'printed' && findObject(ws, feature.objectId)?.material === 'petg')) {
      add('PETG_EXTRA', message('PETG_EXTRA', { n: Number(trimNumber(profile.petgExtra)) }));
    }
    if (list.some(feature => feature.made === 'machined')) add('MACHINED', message('MACHINED'));
    if (list.some(feature => feature.kind === 'boss')) add('BOSS_ADDED', message('BOSS_ADDED'));
    if (method.kind === 'screw-insert' && list.some(feature => feature.side === method.insertSide && feature.through && (feature.kind === 'clearance-hole' || feature.kind === 'tapped-hole'))) {
      add('THROUGH_HOLE', message('THROUGH_HOLE'));
    }
    for (const boss of list.filter(feature => feature.kind === 'boss')) {
      const owner = boss.side === 'a' ? a : b;
      const object = owner.object;
      for (const part of bossCollisions(ws, boss)) {
        add('BOSS_COLLIDES', message('BOSS_COLLIDES', { part: crossObject ? `${object.model.name}・${part.name}` : part.name }));
      }
    }
    result.set(joint.id, sortFindings([...found.values()]));
  }
  return result;
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]
    || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0)
    || (x.message < y.message ? -1 : x.message > y.message ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 6.2 Recommendations
// ---------------------------------------------------------------------------

export interface Recommendation { method: JointMethod; ok: boolean; reasons: string[] }

type Kind = JointMethod['kind'];
type Load = NonNullable<JointNeeds['load']>;
type Disassembly = NonNullable<JointNeeds['disassembly']>;

/** Order of the method kinds by needs (design 6.2, step 2). */
export const NEEDS_ORDER: Record<Disassembly, Record<Load, readonly Kind[]>> = {
  often: {
    light: ['magnet', 'screw-insert', 'pin', 'glue'],
    medium: ['screw-insert', 'magnet', 'pin', 'glue'],
    heavy: ['screw-insert', 'magnet', 'pin', 'glue'],
  },
  sometimes: {
    light: ['magnet', 'screw-insert', 'pin', 'glue'],
    medium: ['screw-insert', 'pin', 'magnet', 'glue'],
    heavy: ['screw-insert', 'pin', 'magnet', 'glue'],
  },
  never: {
    light: ['glue', 'pin', 'screw-insert', 'magnet'],
    medium: ['glue', 'pin', 'screw-insert', 'magnet'],
    heavy: ['screw-insert', 'glue', 'pin', 'magnet'],
  },
};

const ASSUMED_LOAD: Load = 'medium';
const ASSUMED_DISASSEMBLY: Disassembly = 'sometimes';

const ASSUMPTION_REASON = {
  both: '尚未得知負重與拆裝需求，先假設中等負重、偶爾拆裝。',
  load: '尚未得知負重需求，先假設中等負重。',
  disassembly: '尚未得知拆裝需求，先假設偶爾拆裝。',
} as const;

const KIND_REASON: Record<Kind, string> = {
  'screw-insert': '螺絲配熱壓螺母最牢固，也能重複拆裝。',
  magnet: '磁鐵拆裝最方便，適合輕負重。',
  pin: '定位銷對位準確，壓入後很牢固。',
  glue: '膠合不需加工，但之後無法拆開。',
};
const REASON_SLIDE = '一側滑配，可以拆開。';
const REASON_TAPPED = '金屬側使用攻牙孔，不需熱壓螺母。';
const reasonInsertUnsuitable = (material: MaterialId) => `「${materialLabel(material)}」不適合熱壓螺母，改用其他方式。`;

/** Screw variants in order: size and count (design 6.2, step 1). */
const SCREW_VARIANTS: ReadonlyArray<{ size: 'M2' | 'M3'; count: number }> = [
  { size: 'M3', count: 2 }, { size: 'M3', count: 1 }, { size: 'M2', count: 2 }, { size: 'M2', count: 1 },
];
const MAGNET_ORDER = ['d10x3', 'd10x2', 'd8x3', 'd6x3', 'd6x2'] as const;
const PIN_ORDER = ['d4', 'd3', 'd2'] as const;

const CANDIDATE_ID = '__candidate__';
const CANDIDATE_TIME = '2000-01-01T00:00:00.000Z';

/**
 * One recommendation per method kind, best first (requirement 41). A kind is `ok` when one of its
 * variants has no error from the feature rules (a joint whose faces are apart still counts: placement
 * is not a method problem). `excludeJointId` leaves one joint out of the overlap test, for a joint that is being re-planned.
 * `needs` unknown assume medium load and occasional disassembly, and say so in every first reason.
 */
export function recommendFor(
  ws: Workspace, sides: { a: JointSide; b: JointSide }, needs: JointNeeds, profile: PrinterProfile, excludeJointId?: string,
): Recommendation[] {
  const load = needs.load ?? ASSUMED_LOAD;
  const disassembly = needs.disassembly ?? ASSUMED_DISASSEMBLY;
  const assumption = needs.load === null && needs.disassembly === null ? ASSUMPTION_REASON.both
    : needs.load === null ? ASSUMPTION_REASON.load : needs.disassembly === null ? ASSUMPTION_REASON.disassembly : null;
  const lead = assumption ? [assumption] : [];
  const order = NEEDS_ORDER[disassembly][load];

  const a = sideInfo(ws, sides.a, 'a');
  const b = sideInfo(ws, sides.b, 'b');
  const infos = [a, b].filter((info): info is SideInfo => info !== null);
  const crossObject = sides.a.objectId !== sides.b.objectId;
  const noSides = { a, b };

  const insertSides = (): Array<'a' | 'b'> => {
    const thickness = (info: SideInfo) => partThickness(info.part, info.side.face);
    const byThickness = (list: SideInfo[]) => [...list].sort((x, y) => thickness(y) - thickness(x));
    const takes = (info: SideInfo) => info.material === null || MATERIALS[info.material].inserts;
    return [
      ...byThickness(infos.filter(info => info.kind === 'printed' && takes(info))),
      ...byThickness(infos.filter(info => info.kind === 'metal')),
    ].map(info => info.tag);
  };

  const bothAbs = infos.length === 2 && infos.every(info => info.kind !== 'component' && info.material !== null && MATERIALS[info.material].solvent === 'abs');
  const worstRating = (glue: GlueId) => worseOf(glueRatings(infos, glue));
  const hasMetal = infos.some(info => info.kind === 'metal');
  const metalPlastic = hasMetal && infos.some(info => info.kind === 'printed');
  const glueChoice = (): GlueId => {
    if (bothAbs) return 'solvent';
    const ca = RATING_RANK[worstRating('ca')];
    const epoxy = RATING_RANK[worstRating('epoxy')];
    return epoxy > ca || (epoxy === ca && hasMetal) ? 'epoxy' : 'ca';
  };

  const variants = (kind: Kind): { methods: JointMethod[]; blocked: string | null } => {
    switch (kind) {
      case 'screw-insert': {
        const candidates = insertSides();
        if (candidates.length === 0) {
          const unsuitable = infos.find(info => info.kind === 'printed' && info.material !== null && !MATERIALS[info.material].inserts);
          const component = infos.find(info => info.kind === 'component');
          const blocked = unsuitable ? reasonInsertUnsuitable(unsuitable.material!)
            : component ? message('COMPONENT_FEATURE', { part: partName(component, crossObject), item: ITEM.insert }) : message('NO_FACE');
          return { methods: [{ kind, size: 'M3', count: 2, insertSide: 'a' }], blocked };
        }
        return {
          methods: SCREW_VARIANTS.flatMap(variant => candidates.map((insertSide): JointMethod => ({ kind, size: variant.size, count: variant.count, insertSide }))),
          blocked: null,
        };
      }
      case 'magnet': return { methods: MAGNET_ORDER.flatMap(id => [2, 1].map((count): JointMethod => ({ kind, magnet: id, count }))), blocked: null };
      case 'pin': {
        const fit = needs.disassembly === 'never' ? 'press-both' : 'press-slide';
        return { methods: PIN_ORDER.flatMap(id => [2, 1].map((count): JointMethod => ({ kind, pin: id, count, fit }))), blocked: null };
      }
      case 'glue': return { methods: [{ kind, glue: glueChoice() }], blocked: null };
    }
  };

  // Joints that share a part with the pair are the only ones a candidate can collide with.
  const partKeys = new Set([`${sides.a.objectId}:${sides.a.partId}`, `${sides.b.objectId}:${sides.b.partId}`]);
  const related = ws.joints.filter(joint => joint.id !== excludeJointId
    && (partKeys.has(`${joint.a.objectId}:${joint.a.partId}`) || partKeys.has(`${joint.b.objectId}:${joint.b.partId}`)));

  /** The first error of a candidate method, as a message; `null` when the method fits. */
  const firstError = (method: JointMethod): string | null => {
    const candidate: Joint = { id: CANDIDATE_ID, a: sides.a, b: sides.b, method, needs, confirmed: false, createdAt: CANDIDATE_TIME };
    const set = jointFeatures({ ...ws, joints: [...related, candidate] }, profile).joints.get(CANDIDATE_ID);
    const problem = set?.problems.find(item => item.code !== 'APART');
    return problem ? problemMessage(noSides, candidate, problem) : null;
  };

  const evaluate = (kind: Kind): Recommendation => {
    const { methods, blocked } = variants(kind);
    const first = methods[0]!;
    if (!a || !b) return { method: first, ok: false, reasons: [...lead, message('NO_FACE')] };
    if (blocked) return { method: first, ok: false, reasons: [...lead, blocked] };
    let firstProblem: string | null = null;
    for (const method of methods) {
      const problem = firstError(method);
      if (problem === null) return { method, ok: true, reasons: [...lead, ...reasonsFor(method)] };
      firstProblem ??= problem;
    }
    return { method: first, ok: false, reasons: [...lead, firstProblem!] };
  };

  const reasonsFor = (method: JointMethod): string[] => {
    const reasons = [KIND_REASON[method.kind]];
    if (method.kind === 'screw-insert') {
      const insertInfo = method.insertSide === 'a' ? a : b;
      if (insertInfo?.kind === 'metal') reasons.push(REASON_TAPPED);
    } else if (method.kind === 'pin' && method.fit === 'press-slide') {
      reasons.push(REASON_SLIDE);
    } else if (method.kind === 'glue' && metalPlastic) {
      reasons.push(message('METAL_GLUE'));
    }
    return reasons;
  };

  const evaluated = new Map<Kind, Recommendation>(order.map(kind => [kind, evaluate(kind)] as const));
  const valid = order.filter(kind => evaluated.get(kind)!.ok);
  const invalid = order.filter(kind => !evaluated.get(kind)!.ok);
  let ranked: Kind[] = [...valid];
  // Metal to plastic: glue goes behind every valid kind.
  if (metalPlastic && ranked.includes('glue')) ranked = [...ranked.filter(kind => kind !== 'glue'), 'glue'];
  // Glue that bonds a side poorly goes behind pins.
  const glue = evaluated.get('glue')!;
  if (glue.ok && glue.method.kind === 'glue' && worstRating(glue.method.glue) === 'poor' && ranked.includes('pin')) {
    const withoutGlue: Kind[] = ranked.filter(kind => kind !== 'glue');
    withoutGlue.splice(withoutGlue.indexOf('pin') + 1, 0, 'glue');
    ranked = withoutGlue;
  }
  return [...ranked, ...invalid].map(kind => evaluated.get(kind)!);
}

/** Recommendations for an existing joint, using its own needs and ignoring itself in the overlap test. */
export function recommendJoint(ws: Workspace, jointId: string, profile: PrinterProfile): Recommendation[] {
  const joint = ws.joints.find(candidate => candidate.id === jointId);
  if (!joint) throw new WorkspaceError('UNKNOWN_JOINT');
  return recommendFor(ws, { a: joint.a, b: joint.b }, joint.needs, profile, joint.id);
}

/** A new joint: the top recommendation as its method, needs unknown, not confirmed (requirement 42). */
export function newJoint(
  ws: Workspace, input: { id: string; createdAt: string; a: JointSide; b: JointSide }, profile: PrinterProfile,
): Joint {
  const needs: JointNeeds = { load: null, disassembly: null };
  const [top] = recommendFor(ws, { a: input.a, b: input.b }, needs, profile);
  return { id: input.id, a: input.a, b: input.b, method: top!.method, needs, confirmed: false, createdAt: input.createdAt };
}
