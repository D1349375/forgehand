import type { JointToolDetail } from '../../shared/agent';
import { featuresForJoint, type JointDerived } from '../../shared/features';
import { FACE_LABELS, type Joint, type JointMethod, type JointNeeds, type JointSide } from '../../shared/joint';
import { checkJoints, recommendJoint } from '../../shared/joint-rules';
import { DEFAULT_PRINTER_PROFILE, type PrinterProfile } from '../../shared/printer';
import { GLUES, MAGNETS, PINS } from '../../shared/standard-parts';
import type { Workspace } from '../../shared/workspace';
import type { AgentWorkingState } from '../agent-tools';

/**
 * Helpers of the joint tools and of the per-round snapshot: texts, the printer profile of a run and the
 * detail create_joint and update_joint return. No tool is registered here, so any tool file may import it.
 */

/** The printer profile of a run: the one the request carried, else the defaults. */
export const printerOf = (state: AgentWorkingState): PrinterProfile => state.printer ?? DEFAULT_PRINTER_PROFILE;

// ---------------------------------------------------------------------------
// Texts shared by the joint tools and the per-round snapshot (Traditional Chinese)
// ---------------------------------------------------------------------------

export const LOAD_TEXT: Record<NonNullable<JointNeeds['load']>, string> = { light: '輕', medium: '中', heavy: '重' };
export const DISASSEMBLY_TEXT: Record<NonNullable<JointNeeds['disassembly']>, string> = { never: '不拆', sometimes: '偶爾', often: '經常' };
export const UNKNOWN_NEED_TEXT = '未指定';

/** A method with its parameters in one phrase, for example 熱壓螺母＋螺絲 M3×2，螺母在 A 側. */
export function methodText(method: JointMethod): string {
  switch (method.kind) {
    case 'screw-insert': return `熱壓螺母＋螺絲 ${method.size}×${method.count}，螺母在 ${method.insertSide === 'a' ? 'A' : 'B'} 側`;
    case 'magnet': return `磁鐵 ${MAGNETS[method.magnet].diameterMm}×${MAGNETS[method.magnet].thicknessMm} mm ×${method.count}`;
    case 'pin': return `定位銷 Ø${PINS[method.pin].diameterMm} mm ×${method.count}（${method.fit === 'press-both' ? '兩側壓配' : '一側滑配'}）`;
    case 'glue': return `膠合（${GLUES[method.glue].label}）`;
  }
}

/** 「物件」零件（面） for one side of a joint. */
export function sideText(ws: Workspace, side: JointSide): string {
  const object = ws.objects.find(candidate => candidate.id === side.objectId);
  const part = object?.model.parts.find(candidate => candidate.id === side.partId);
  return `「${object?.model.name ?? side.objectId}」${part?.name ?? side.partId}（${FACE_LABELS[side.face]}）`;
}

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The derived numbers of a joint in one line. */
function derivedText(method: JointMethod, derived: JointDerived): string {
  switch (method.kind) {
    case 'screw-insert':
      return derived.screwLengthMm === null
        ? `${method.size} 螺絲：沒有合適的標準長度`
        : `${method.size}×${derived.screwLengthMm} mm 螺絲，${derived.positions} 個位置`;
    case 'magnet': return `磁鐵 ${2 * derived.positions} 顆（${derived.positions} 個位置）`;
    case 'pin':
      return derived.pinLengthMm === null
        ? `Ø${PINS[method.pin].diameterMm} mm 定位銷：沒有合適的標準長度`
        : `Ø${PINS[method.pin].diameterMm}×${derived.pinLengthMm} mm 定位銷，${derived.positions} 個位置`;
    case 'glue': return `接觸面積約 ${Math.round(derived.contactAreaMm2)} mm²`;
  }
}

/**
 * What `create_joint` and `update_joint` return: the joint, the recommendation of the rules for
 * its needs, the findings of the checks and its derived numbers, all computed on `ws` (the workspace after the change).
 */
export function jointDetail(ws: Workspace, joint: Joint, printer: PrinterProfile): JointToolDetail {
  return {
    jointId: joint.id,
    joint,
    recommendation: recommendJoint(ws, joint.id, printer).slice(0, 4).map(item => ({
      method: item.method, ok: item.ok, reasons: item.reasons.slice(0, 8).map(reason => clip(reason)),
    })),
    findings: (checkJoints(ws, printer).get(joint.id) ?? []).slice(0, 20).map(finding => ({
      severity: finding.severity, code: finding.code, message: clip(finding.message),
    })),
    derived: clip(derivedText(joint.method, featuresForJoint(ws, joint, printer).derived)),
  };
}
