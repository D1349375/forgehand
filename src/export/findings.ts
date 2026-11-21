import { classifyPart, jointLabel, jointSideNames, METHOD_KIND_LABELS } from '../../shared/export-plan';
import type { Finding, FindingCode, Severity } from '../../shared/joint-rules';
import type { Workspace } from '../../shared/workspace';

/**
 * The findings of an export (requirements 16 to 19, design 5.1): the joint checks of every
 * joint in scope plus the export's own table. Messages are fixed Traditional Chinese text.
 * Pure code, runs in Node.
 */

export type ExportFindingCode =
  | 'PIECE_FAILED' | 'FEATURES_SKIPPED' | 'JOINT_UNCONFIRMED' | 'JOINT_FUSED' | 'JOINT_OVERLAP'
  | 'COMPONENT_BLOCKED' | 'LOOSE_PIECE' | 'TOO_LARGE' | 'BOUGHT' | 'MACHINED' | 'FUSED';

export interface ExportFinding {
  severity: Severity;
  /** The joint rules' codes come through unchanged. */
  code: ExportFindingCode | FindingCode;
  source: 'joint' | 'export';
  message: string;
  jointId: string | null;
  /** Step number of the joint, when it has one. */
  step: number | null;
  /** Piece number such as `P01`, when the finding is about a piece. */
  piece: string | null;
}

type Params = Record<string, string | number>;

export const EXPORT_SEVERITY: Record<ExportFindingCode, Severity> = {
  PIECE_FAILED: 'error',
  FEATURES_SKIPPED: 'warning',
  JOINT_UNCONFIRMED: 'warning',
  JOINT_FUSED: 'warning',
  JOINT_OVERLAP: 'warning',
  COMPONENT_BLOCKED: 'warning',
  LOOSE_PIECE: 'warning',
  TOO_LARGE: 'warning',
  BOUGHT: 'info',
  MACHINED: 'info',
  FUSED: 'info',
};

/**
 * The table of requirement 16. Parameters: `piece` (a piece's name), `a` and `b` (the names of a
 * joint's two parts), `method`, `part` and `n`.
 */
export const EXPORT_MESSAGES: Record<ExportFindingCode, (p: Params) => string> = {
  PIECE_FAILED: p => `「${p.piece}」無法產生列印檔，已略過。`,
  FEATURES_SKIPPED: p => `接合「${p.a}」↔「${p.b}」有問題，孔位沒有加工。`,
  JOINT_UNCONFIRMED: p => `接合「${p.a}」↔「${p.b}」尚未確認，先以「${p.method}」匯出。`,
  JOINT_FUSED: p => `接合「${p.a}」↔「${p.b}」的兩個零件會連成同一個列印件，孔位沒有加工。`,
  JOINT_OVERLAP: p => `接合「${p.a}」↔「${p.b}」的兩個零件重疊 ${p.n} mm³，印出後無法組合。`,
  COMPONENT_BLOCKED: p => `外購件「${p.part}」和「${p.piece}」重疊，印出後放不進去。`,
  LOOSE_PIECE: p => `「${p.piece}」沒有和其他零件相連或接合，組裝時需要另外固定。`,
  TOO_LARGE: p => `「${p.piece}」最長 ${p.n} mm，可能超過一般印表機的列印範圍。`,
  BOUGHT: p => `「${p.part}」是外購件，不會產生列印檔。`,
  MACHINED: p => `「${p.part}」是金屬件，需另行加工，不會產生列印檔。`,
  FUSED: p => `「${p.piece}」由 ${p.n} 個相連的零件合併而成。`,
};

export function exportMessage(code: ExportFindingCode, params: Params = {}): string {
  return EXPORT_MESSAGES[code](params);
}

/**
 * `checkJoints` output as export findings, in joint order. Each message starts with 「步驟 n：」
 * so the reader knows which joint is meant, or with the joint's label when it has no step.
 */
export function jointFindings(ws: Workspace, findings: ReadonlyMap<string, readonly Finding[]>, steps: ReadonlyMap<string, number>): ExportFinding[] {
  const list: ExportFinding[] = [];
  for (const joint of ws.joints) {
    const step = steps.get(joint.id) ?? null;
    const prefix = step !== null ? `步驟 ${step}：` : `${jointLabel(ws, joint)}：`;
    for (const finding of findings.get(joint.id) ?? []) {
      list.push({
        severity: finding.severity, code: finding.code, source: 'joint', message: `${prefix}${finding.message}`,
        jointId: joint.id, step, piece: null,
      });
    }
  }
  return list;
}

/** `JOINT_UNCONFIRMED` for every joint the user has not confirmed. */
export function unconfirmedFindings(ws: Workspace, steps: ReadonlyMap<string, number>): ExportFinding[] {
  return ws.joints.filter(joint => !joint.confirmed).map(joint => {
    const { a, b } = jointSideNames(ws, joint);
    return {
      severity: EXPORT_SEVERITY.JOINT_UNCONFIRMED, code: 'JOINT_UNCONFIRMED', source: 'export',
      message: exportMessage('JOINT_UNCONFIRMED', { a, b, method: METHOD_KIND_LABELS[joint.method.kind] }),
      jointId: joint.id, step: steps.get(joint.id) ?? null, piece: null,
    };
  });
}

/**
 * `BOUGHT` and `MACHINED` for every part that gets no print file. With more than one object in
 * scope the part name is qualified with its object's name, so two identical names stay apart.
 */
export function classFindings(ws: Workspace): ExportFinding[] {
  const list: ExportFinding[] = [];
  const qualify = ws.objects.length > 1;
  for (const object of ws.objects) {
    for (const part of object.model.parts) {
      const kind = classifyPart(object, part);
      if (kind === 'printed') continue;
      const code = kind === 'bought' ? 'BOUGHT' : 'MACHINED';
      list.push({
        severity: EXPORT_SEVERITY[code], code, source: 'export',
        message: exportMessage(code, { part: qualify ? `${object.model.name}・${part.name}` : part.name }),
        jointId: null, step: null, piece: null,
      });
    }
  }
  return list;
}

/** Joints whose features are not cut: every joint with an error finding (requirement 9). */
export function featuresSkippedJoints(findings: ReadonlyMap<string, readonly Finding[]>): Set<string> {
  const skipped = new Set<string>();
  for (const [jointId, list] of findings) if (list.some(finding => finding.severity === 'error')) skipped.add(jointId);
  return skipped;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
/** Numbers ascending, `null` last. */
const compareStep = (x: number | null, y: number | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x - y);
const comparePiece = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : compare(x, y));

/**
 * Severity (error, warning, info), then code, then step, then piece number, `null` last
 * (requirement 18). The message is the last tie-break, so the order never depends on input order.
 */
export function sortFindings(list: readonly ExportFinding[]): ExportFinding[] {
  return [...list].sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]
    || compare(x.code, y.code)
    || compareStep(x.step, y.step)
    || comparePiece(x.piece, y.piece)
    || compare(x.message, y.message));
}
