import { jointFeatures, type FeatureSet, type JointFeature, type JointFeatureSet } from '../../shared/features';
import { FACE_LABELS, faceAllows, faceShape, type FaceShape, type Joint, type JointMethod, type JointNeeds, type JointSide } from '../../shared/joint';
import { checkJoints, recommendFor, sideInfo, type Finding, type Recommendation, type Severity } from '../../shared/joint-rules';
import type { PrinterProfile } from '../../shared/printer';
import { GLUES, INSERTS, MAGNETS, PINS, SCREWS } from '../../shared/standard-parts';
import { findObject, type Workspace } from '../../shared/workspace';
import {
  JOINT_STATE_LABELS, METHOD_KIND_ORDER, METHOD_LABELS, askAgentText, findingLine, glueLabel, magnetLabel, methodSummary, sideName, type JointState,
} from './labels';

/**
 * View models of the 接合 panel and the joint card (assembly-joints design 8.4), plus the
 * pure rules of requirement 55 (what a change in the card does to the joint). No React, no DOM.
 */

/** Everything derived from the workspace and the printer profile that the panel shows (design 8.1). */
export interface Kit { features: FeatureSet; findings: Map<string, Finding[]> }

export function buildKit(ws: Workspace, profile: PrinterProfile): Kit {
  const features = jointFeatures(ws, profile);
  return { features, findings: checkJoints(ws, profile, features) };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** 有問題 when any finding is an error, else 已確認 or 待確認 (requirement 51). */
export function jointState(joint: Pick<Joint, 'confirmed'>, findings: readonly Finding[] | undefined): JointState {
  if (findings?.some(finding => finding.severity === 'error')) return 'problem';
  return joint.confirmed ? 'confirmed' : 'pending';
}

export interface JointRow {
  id: string;
  /** 「{object name}・{part name} ↔ {object name}・{part name}」 */
  label: string;
  methodLabel: string;
  state: JointState;
  stateText: string;
  icon: string;
}

/** The two side names of a joint, `object・part`. */
export function jointSideNames(ws: Workspace, joint: Pick<Joint, 'a' | 'b'>): { a: string; b: string } {
  const name = (side: JointSide) => {
    const object = findObject(ws, side.objectId);
    const part = object?.model.parts.find(candidate => candidate.id === side.partId);
    return sideName(object?.model.name ?? side.objectId, part?.name ?? side.partId);
  };
  return { a: name(joint.a), b: name(joint.b) };
}

export function jointRows(ws: Workspace, findings: ReadonlyMap<string, readonly Finding[]>): JointRow[] {
  return ws.joints.map(joint => {
    const names = jointSideNames(ws, joint);
    const state = jointState(joint, findings.get(joint.id));
    return {
      id: joint.id, label: `${names.a} ↔ ${names.b}`, methodLabel: methodSummary(joint.method), state,
      stateText: JOINT_STATE_LABELS[state].text, icon: JOINT_STATE_LABELS[state].icon,
    };
  });
}

// ---------------------------------------------------------------------------
// Derived text
// ---------------------------------------------------------------------------

const mm = (metres: number) => (metres * 1000).toFixed(2);

const firstOf = (features: readonly JointFeature[], kind: JointFeature['kind']) => features.find(feature => feature.kind === kind);

/**
 * The read-only derived values of a joint, for example
 * 「M3×8 螺絲 ×2、M3×5.7 熱壓螺母 ×2、螺母孔 Ø4.20 mm、沉孔 Ø6.20 mm」 (requirement 54).
 * Hole sizes are the printed sizes (the printer profile is already in them).
 */
export function derivedText(joint: Pick<Joint, 'method'>, set: JointFeatureSet | undefined): string {
  if (!set) return '';
  const { method } = joint;
  const { features, derived } = set;
  const parts: string[] = [];
  const hole = (label: string, feature: JointFeature | undefined) => { if (feature) parts.push(`${label} Ø${mm(feature.diameter)} mm`); };
  switch (method.kind) {
    case 'screw-insert': {
      const length = derived.screwLengthMm;
      parts.push(length === null ? `${method.size} 螺絲：沒有合適的標準長度` : `${method.size}×${length} 螺絲 ×${derived.positions}`);
      const inserts = features.filter(feature => feature.kind === 'insert-hole').length;
      if (inserts > 0) parts.push(`${method.size}×${INSERTS[method.size].lengthMm} 熱壓螺母 ×${inserts}`);
      hole('螺母孔', firstOf(features, 'insert-hole'));
      hole('螺紋孔', firstOf(features, 'tapped-hole'));
      hole('沉孔', firstOf(features, 'counterbore'));
      hole('螺柱', firstOf(features, 'boss'));
      break;
    }
    case 'magnet': {
      parts.push(`${magnetLabel(method.magnet)} 磁鐵 ×${2 * derived.positions}`);
      hole('磁鐵孔', firstOf(features, 'magnet-pocket'));
      break;
    }
    case 'pin': {
      const length = derived.pinLengthMm;
      parts.push(length === null ? `Ø${PINS[method.pin].diameterMm} mm 定位銷：沒有合適的標準長度` : `Ø${PINS[method.pin].diameterMm}×${length} mm 定位銷 ×${derived.positions}`);
      hole('銷孔', firstOf(features, 'pin-hole'));
      break;
    }
    case 'glue': {
      parts.push(glueLabel(method.glue));
      parts.push(`接觸面積 ${Math.round(derived.contactAreaMm2)} mm²`);
      break;
    }
  }
  return parts.join('、');
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface CardSide { tag: 'a' | 'b'; name: string; faceLabel: string }

export interface JointCardModel {
  jointId: string;
  title: string;
  sideA: CardSide;
  sideB: CardSide;
  state: JointState;
  stateText: string;
  icon: string;
  confirmed: boolean;
  method: JointMethod;
  /** The four methods in menu order; `allowed` is false for a method a ring face (tube cap) does not take. */
  methodKinds: Array<{ kind: JointMethod['kind']; label: string; allowed: boolean }>;
  needs: JointNeeds;
  recommendation: { label: string; reasons: string[]; ok: boolean } | null;
  derived: string;
  findings: Array<{ severity: Severity; icon: string; text: string }>;
  actions: {
    /** 確認方式 is shown while the joint is not confirmed. */
    confirm: boolean;
    /** 改用建議 is shown when the joint is confirmed and the top recommendation is another method. */
    useRecommendation: boolean;
    /** 重新對齊 is offered while the faces are apart, for a joint between two objects. */
    realign: boolean;
    /** One 列印件預覽 button per printed side. */
    previews: Array<{ side: 'a' | 'b'; objectId: string; partId: string; label: string }>;
    /** The instruction of 請代理建議. */
    askAgent: string;
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `null` when the joint does not exist (a card whose joint is gone closes). */
export function jointCardModel(ws: Workspace, jointId: string, kit: Kit, recommendations: readonly Recommendation[]): JointCardModel | null {
  const joint = ws.joints.find(candidate => candidate.id === jointId);
  if (!joint) return null;
  const names = jointSideNames(ws, joint);
  const findings = kit.findings.get(joint.id) ?? [];
  const state = jointState(joint, findings);
  const cardSide = (tag: 'a' | 'b', side: JointSide): CardSide => ({ tag, name: names[tag], faceLabel: FACE_LABELS[side.face] });

  const shapes: Array<FaceShape | null> = [joint.a, joint.b].map(side => {
    const part = findObject(ws, side.objectId)?.model.parts.find(candidate => candidate.id === side.partId);
    return part ? faceShape(part.primitive, side.face) : null;
  });
  const methodKinds = METHOD_KIND_ORDER.map(kind => ({
    kind, label: METHOD_LABELS[kind],
    allowed: shapes.every(shape => shape === null || faceAllows(shape, { kind } as JointMethod)),
  }));

  const top = recommendations[0] ?? null;
  const previews = (['a', 'b'] as const).flatMap(tag => {
    const side = joint[tag];
    const info = sideInfo(ws, side, tag);
    return info && info.kind === 'printed' ? [{ side: tag, objectId: side.objectId, partId: side.partId, label: `預覽「${info.part.name}」列印件` }] : [];
  });
  const crossObject = joint.a.objectId !== joint.b.objectId;
  return {
    jointId: joint.id,
    title: `${names.a} ↔ ${names.b}`,
    sideA: cardSide('a', joint.a),
    sideB: cardSide('b', joint.b),
    state, stateText: JOINT_STATE_LABELS[state].text, icon: JOINT_STATE_LABELS[state].icon,
    confirmed: joint.confirmed,
    method: joint.method,
    methodKinds,
    needs: joint.needs,
    recommendation: top ? { label: methodSummary(top.method), reasons: top.reasons, ok: top.ok } : null,
    derived: derivedText(joint, kit.features.joints.get(joint.id)),
    findings: findings.map(findingLine),
    actions: {
      confirm: !joint.confirmed,
      useRecommendation: joint.confirmed && top !== null && !sameJson(top.method, joint.method),
      realign: crossObject && findings.some(finding => finding.code === 'APART'),
      previews,
      askAgent: askAgentText(names.a, names.b),
    },
  };
}

// ---------------------------------------------------------------------------
// Requirement 55: what a change in the card does
// ---------------------------------------------------------------------------

/** A change to hand to `updateJoint`. An empty patch changes nothing. */
export interface JointPatch { method?: JointMethod; needs?: Partial<JointNeeds>; confirmed?: boolean }

/** 確認方式. */
export const onConfirm = (): JointPatch => ({ confirmed: true });

/**
 * 負重 or 拆裝 changed. An unconfirmed joint takes the new top recommendation as its method and stays
 * unconfirmed; a confirmed joint keeps its method (the card then offers 改用建議).
 */
export function onNeeds(ws: Workspace, joint: Joint, change: Partial<JointNeeds>, profile: PrinterProfile): JointPatch {
  const needs: Partial<JointNeeds> = { ...change };
  if (joint.confirmed) return { needs };
  const merged: JointNeeds = { ...joint.needs, ...change };
  const [top] = recommendFor(ws, { a: joint.a, b: joint.b }, merged, profile, joint.id);
  return top ? { needs, method: top.method } : { needs };
}

/** The 固定方式 select: the recommended parameters of the chosen kind, and the joint is confirmed. */
export function onMethod(joint: Joint, kind: JointMethod['kind'], recommendations: readonly Recommendation[]): JointPatch {
  if (joint.method.kind === kind) return {};
  const found = recommendations.find(recommendation => recommendation.method.kind === kind);
  return found ? { method: found.method, confirmed: true } : {};
}

/** A parameter of the current method changed (size, count, insert side, magnet, pin, fit, glue), and the joint is confirmed. */
export function onParam(joint: Joint, param: Record<string, unknown>): JointPatch {
  return { method: { ...joint.method, ...param } as JointMethod, confirmed: true };
}

/** 改用建議. */
export const onRecommendation = (top: Recommendation): JointPatch => ({ method: top.method, confirmed: true });

/** The options of the card's parameter selects. */
export const SCREW_SIZES = Object.keys(SCREWS) as Array<keyof typeof SCREWS>;
export const MAGNET_IDS = Object.keys(MAGNETS) as Array<keyof typeof MAGNETS>;
export const PIN_IDS = Object.keys(PINS) as Array<keyof typeof PINS>;
export const GLUE_IDS = Object.keys(GLUES) as Array<keyof typeof GLUES>;
