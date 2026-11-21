import type { Finding, Severity } from '../../shared/joint-rules';
import type { JointMethod, JointNeeds } from '../../shared/joint';
import { MATERIALS, type MaterialId } from '../../shared/materials';
import { GLUES, MAGNETS, PINS, type GlueId, type MagnetId, type PinId, type Thread } from '../../shared/standard-parts';

/**
 * Traditional Chinese tables of the joint UI (assembly-joints design 8.1 and 8.4). Pure data
 * and small formatters; no React, no DOM. Face labels live in `shared/joint.ts` (`FACE_LABELS`).
 */

type Kind = JointMethod['kind'];
type Load = NonNullable<JointNeeds['load']>;
type Disassembly = NonNullable<JointNeeds['disassembly']>;

// ---------------------------------------------------------------------------
// Materials (requirement 10)
// ---------------------------------------------------------------------------

export const NO_MATERIAL_LABEL = '未指定';

/** The 材料 select: 未指定 (empty value) and the eight materials in table order. */
export const MATERIAL_OPTIONS: ReadonlyArray<{ value: '' | MaterialId; label: string }> = [
  { value: '', label: NO_MATERIAL_LABEL },
  ...(Object.keys(MATERIALS) as MaterialId[]).map(id => ({ value: id, label: MATERIALS[id].label })),
];

// ---------------------------------------------------------------------------
// Methods and their parameters (requirement 54)
// ---------------------------------------------------------------------------

export const METHOD_KIND_ORDER: readonly Kind[] = ['screw-insert', 'magnet', 'pin', 'glue'];

export const METHOD_LABELS: Record<Kind, string> = {
  'screw-insert': '熱壓螺母＋螺絲',
  magnet: '磁鐵',
  pin: '定位銷',
  glue: '膠合',
};

export const THREAD_OPTIONS: readonly Thread[] = ['M2', 'M3'];
export const COUNT_OPTIONS: readonly number[] = [1, 2, 3, 4];
export const magnetLabel = (id: MagnetId): string => `${MAGNETS[id].diameterMm}×${MAGNETS[id].thicknessMm} mm`;
export const pinLabel = (id: PinId): string => `Ø${PINS[id].diameterMm} mm`;
export const glueLabel = (id: GlueId): string => GLUES[id].label;
export const PIN_FIT_LABELS: Record<'press-both' | 'press-slide', string> = { 'press-both': '兩側壓配', 'press-slide': '一側滑配' };

/** A short label of a method with its parameters, for the joint list and the recommendation. */
export function methodSummary(method: JointMethod): string {
  switch (method.kind) {
    case 'screw-insert': return `${METHOD_LABELS[method.kind]} ${method.size} ×${method.count}`;
    case 'magnet': return `${METHOD_LABELS[method.kind]} ${magnetLabel(method.magnet)} ×${method.count}`;
    case 'pin': return `${METHOD_LABELS[method.kind]} ${pinLabel(method.pin)} ×${method.count}`;
    case 'glue': return `${METHOD_LABELS[method.kind]}（${glueLabel(method.glue)}）`;
  }
}

// ---------------------------------------------------------------------------
// Needs (requirement 54)
// ---------------------------------------------------------------------------

export const NEEDS_UNKNOWN_LABEL = '未指定';
export const LOAD_OPTIONS: ReadonlyArray<{ value: '' | Load; label: string }> = [
  { value: '', label: NEEDS_UNKNOWN_LABEL }, { value: 'light', label: '輕' }, { value: 'medium', label: '中' }, { value: 'heavy', label: '重' },
];
export const DISASSEMBLY_OPTIONS: ReadonlyArray<{ value: '' | Disassembly; label: string }> = [
  { value: '', label: NEEDS_UNKNOWN_LABEL }, { value: 'never', label: '不拆' }, { value: 'sometimes', label: '偶爾' }, { value: 'often', label: '經常' },
];

// ---------------------------------------------------------------------------
// States and findings
// ---------------------------------------------------------------------------

export type JointState = 'pending' | 'confirmed' | 'problem';

/** The state of a joint in text and icon: the icon never carries the state alone (requirement 51). */
export const JOINT_STATE_LABELS: Record<JointState, { text: string; icon: string }> = {
  pending: { text: '待確認', icon: '○' },
  confirmed: { text: '已確認', icon: '✓' },
  problem: { text: '有問題', icon: '⚠' },
};

export const SEVERITY_LABELS: Record<Severity, { text: string; icon: string }> = {
  error: { text: '錯誤', icon: '✕' },
  warning: { text: '警告', icon: '⚠' },
  info: { text: '提示', icon: 'ⓘ' },
};

export const findingLine = (finding: Finding): { severity: Severity; icon: string; text: string } =>
  ({ severity: finding.severity, icon: SEVERITY_LABELS[finding.severity].icon, text: finding.message });

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** 「{object name}・{part name}」, the name of one side in the joint list, the notices and the agent instruction. */
export const sideName = (objectName: string, partName: string): string => `${objectName}・${partName}`;

// ---------------------------------------------------------------------------
// Notices (design 8.1) and status lines (design 8.3)
// ---------------------------------------------------------------------------

export const JOINT_NOTICES = {
  joined: (a: string, b: string) => `已接合「${a}」與「${b}」，請確認固定方式。`,
  method: '已更新接合方式，可按「復原」回到上一步。',
  confirmed: '已確認固定方式。',
  removed: '已刪除接合，可按「復原」回到上一步。',
  realigned: '已重新對齊接合面，可按「復原」回到上一步。',
  material: '已設定材料，可按「復原」回到上一步。',
  /** `others` is the number of other objects that moved with the one the user moved. */
  assemblyMoved: (others: number) => `已調整物件位置（連同接合的 ${others} 個物件），可按「復原」回到上一步。`,
  cascade: (removed: number) => `已一併移除 ${removed} 個接合。`,
  noFaceOnPart: '這個零件沒有平面可以接合。',
  previewFailed: '無法產生列印件預覽，目前模型未變更。',
  rejected: '這個接合調整未通過驗證，未套用。',
  /** A wrong joint id or a stale click: nothing changed. */
  missing: '找不到這個接合，工作區未變更。',
} as const;

export const MOUSE_JOIN_STATUS = {
  first: '點選第一個要接合的零件。',
  second: '點選另一個物件上要接合的零件。',
  preview: '可以接合：按「確認接合」完成，或按 Esc 取消。',
} as const;

/** The instruction 請代理建議 sends to the agent (requirement 57). */
export const askAgentText = (a: string, b: string): string => `請幫我為接合「${a}」↔「${b}」選擇固定方式，先問我負重和拆裝需求。`;
