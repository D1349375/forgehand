import { assemblyOf } from '../../shared/assembly';
import { scopeWorkspace, type ExportScope } from '../../shared/export-plan';
import type { Joint } from '../../shared/joint';
import type { PrinterProfile } from '../../shared/printer';
import type { SceneObject, Workspace } from '../../shared/workspace';
import type { ExportFinding } from './findings';
import { formatCm3 } from './format';
import type { PreparedKit } from './prepare';
/**
 * The decisions of the export dialog that need no DOM (requirements 1, 2, 15, 18, 21 and 22,
 * design 7.2): which scope to offer, when a prepared kit is stale, the file rows, the banner and
 * the summary text. Pure code, runs in Node. All user-facing text is Traditional Chinese.
 */
/** Requirement 1: the default scope is the whole workspace. */
export function defaultScope(_ws: Workspace): ExportScope {
  return { scope: 'workspace', objectId: null };
}
/** Requirement 1: the scope choice is hidden when the active object's assembly already is the whole workspace. */
export function scopeChoiceVisible(ws: Workspace): boolean {
  const activeId = ws.activeObjectId;
  if (ws.objects.length < 2 || activeId === null) return false;
  return assemblyOf(ws, activeId).length < ws.objects.length;
}
/**
 * Everything a kit is built from. The workspace store hands out new references only for objects
 * that changed, so reference equality on the scoped objects and on the joints notices every
 * change that matters and ignores selection, explode and activation.
 */
export interface SnapshotKey {
  objects: readonly SceneObject[];
  joints: readonly Joint[];
  profile: PrinterProfile;
  scope: ExportScope;
}
/** Throws what `scopeWorkspace` throws (an empty workspace, an unknown object): the dialog closes then. */
export function snapshotKey(ws: Workspace, scope: ExportScope, profile: PrinterProfile): SnapshotKey {
  const scoped = scopeWorkspace(ws, scope);
  return { objects: scoped.objects, joints: scoped.joints, profile, scope };
}
const sameList = <T>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);
const sameProfile = (a: PrinterProfile, b: PrinterProfile): boolean =>
  (Object.keys(a) as Array<keyof PrinterProfile>).every(key => a[key] === b[key])
  && Object.keys(a).length === Object.keys(b).length;
/** Element-wise reference equality of objects and joints, the scope, and the profile by value. */
export function sameSnapshot(a: SnapshotKey, b: SnapshotKey): boolean {
  return a.scope.scope === b.scope.scope && a.scope.objectId === b.scope.objectId
    && sameProfile(a.profile, b.profile) && sameList(a.objects, b.objects) && sameList(a.joints, b.joints);
}
export interface FileRow {
  path: string;
  bytes: number;
  /** The accessible name of the file's download button. */
  label: string;
}
export function fileRows(kit: PreparedKit): FileRow[] {
  return kit.files.map(file => ({ path: file.path, bytes: file.bytes.length, label: `下載 ${file.path}` }));
}
/** Requirement 18: errors and warnings are counted; info lines are not problems. */
export function problemBanner(findings: readonly ExportFinding[]): string | null {
  const count = findings.filter(finding => finding.severity !== 'info').length;
  return count > 0 ? `有 ${count} 個問題，仍可繼續匯出。` : null;
}
/** Requirements 15 and 22. */
export function summaryLines(kit: PreparedKit): string[] {
  const { summary } = kit;
  const others = `外購件 ${summary.bought} 個、加工件 ${summary.machined} 個、標準件 ${summary.standard} 項`;
  if (summary.pieces === 0) return ['沒有需要列印的零件。', others];
  return [`列印件 ${summary.pieces} 種（共 ${summary.copies} 件）、${others}、列印總體積 ${formatCm3(summary.totalVolumeMm3)} cm³`];
}
/** `1.5 KB`; the size of one kit file as the dialog lists it. */
export function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
