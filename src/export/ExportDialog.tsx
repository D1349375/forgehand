import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ExportScope } from '../../shared/export-plan';
import type { PrinterProfile } from '../../shared/printer';
import type { Workspace } from '../../shared/workspace';
import { loadManifold } from '../print/manifold';
import type { Vector } from '../scene/SceneViewport';
import {
  fileRows, formatKb, problemBanner, sameSnapshot, scopeChoiceVisible, snapshotKey, summaryLines, type SnapshotKey,
} from './dialog-model';
import { downloadBytes } from './download';
import type { ExportFinding } from './findings';
import { explodedLayout, renderKitImage } from './kit-image';
import { kitZip, prepareKit, type PreparedKit } from './prepare';
/**
 * The export dialog (requirements 2, 14 to 15, 18, 20 to 22, 51 to 54, design 7.3). It is not modal: the scene stays
 * visible and usable. It prepares the kit once per snapshot of the workspace, scope and printer profile, shows the
 * summary and the findings, and downloads bytes that already exist. This module is loaded lazily (`React.lazy`).
 */
interface Props {
  workspace: Workspace;
  printer: PrinterProfile;
  request: ExportScope;
  /** The direction from the view's target to its camera, or null before the view exists. */
  viewDirection: () => Vector | null;
  onClose: () => void;
}
type Phase =
  | { state: 'preparing'; done: number; total: number }
  | { state: 'ready'; kit: PreparedKit; exportedAt: Date; key: SnapshotKey }
  | { state: 'failed' };
const CHANGED_NOTICE = '工作區已變更，正在重新準備匯出內容…';
const FAILED_TEXT = '無法準備匯出內容，請重新整理頁面後再試。';
const IMAGE_MISSING_TEXT = '無法產生爆炸圖，其餘檔案不受影響。';
const ICONS = { error: '⛔', warning: '⚠', info: 'ℹ' } as const;
const WORDS = { error: '錯誤', warning: '警告', info: '提示' } as const;
const yieldNow = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
/** The snapshot of this render, or null when the scope cannot be resolved (an empty workspace, a removed object). Equal snapshots share one object. */
function useSnapshot(workspace: Workspace, scope: ExportScope, profile: PrinterProfile): SnapshotKey | null {
  const previous = useRef<SnapshotKey | null>(null);
  let next: SnapshotKey | null;
  try { next = snapshotKey(workspace, scope, profile); } catch { next = null; }
  if (next && previous.current && sameSnapshot(previous.current, next)) next = previous.current;
  previous.current = next;
  return next;
}
function FindingItem({ finding }: { finding: ExportFinding }) {
  return <li className={`finding ${finding.severity}`} data-code={finding.code}>
    <span className="finding-icon" aria-hidden="true">{ICONS[finding.severity]}</span>
    <span className="finding-word">{WORDS[finding.severity]}</span>
    <span>{finding.message}</span>
  </li>;
}
export default function ExportDialog({ workspace, printer, request, viewDirection, onClose }: Props) {
  const [scope, setScope] = useState<ExportScope>(request);
  const [phase, setPhase] = useState<Phase>({ state: 'preparing', done: 0, total: 0 });
  const [notice, setNotice] = useState('');
  const section = useRef<HTMLElement>(null);
  /** The snapshot of the last run, to tell a change from the first run (and from React's second run of the effect). */
  const lastRun = useRef<SnapshotKey | null>(null);
  /** The scope select changed the snapshot: that is not a change of the workspace, so it gets no notice. */
  const scopeEdit = useRef(false);
  const snapshot = useSnapshot(workspace, scope, printer);
  // A new request (the agent asks again while the dialog is open) replaces the scope.
  useEffect(() => setScope(request), [request]);
  // The dialog is the first panel of the control column: focus brings it into view and lets Esc reach it.
  useEffect(() => { section.current?.focus(); }, []);
  useEffect(() => { if (!snapshot) onClose(); }, [snapshot]);
  useEffect(() => {
    if (!snapshot) return;
    const controller = new AbortController();
    const { signal } = controller;
    const changed = lastRun.current !== null && lastRun.current !== snapshot && !scopeEdit.current;
    lastRun.current = snapshot;
    scopeEdit.current = false;
    setNotice(changed ? CHANGED_NOTICE : '');
    setPhase({ state: 'preparing', done: 0, total: 0 });
    const exportedAt = new Date();
    const view = viewDirection();
    prepareKit({
      workspace, scope, profile: printer, exportedAt, signal, yieldNow, loadManifold,
      onProgress: (done, total) => { if (!signal.aborted) setPhase({ state: 'preparing', done, total }); },
      renderImage: (scoped, steps) => renderKitImage(scoped, explodedLayout(scoped, steps), view),
      writeGlb: async objects => (await import('./glb')).writeGlb(objects),
    }).then(kit => {
      if (signal.aborted) return;
      setNotice('');
      setPhase({ state: 'ready', kit, exportedAt, key: snapshot });
    }, (error: unknown) => {
      // Nothing about the failure is shown or logged (requirement 54).
      if (signal.aborted || isAbort(error)) return;
      setPhase({ state: 'failed' });
    });
    return () => controller.abort();
  }, [snapshot]);
  // A kit built for an older snapshot is never offered: the render between a change and the new run shows the preparing state.
  const shown: Phase = phase.state === 'ready' && phase.key !== snapshot ? { state: 'preparing', done: 0, total: 0 } : phase;
  const kit = shown.state === 'ready' ? shown.kit : null;
  const rows = kit ? fileRows(kit) : [];
  const banner = kit ? problemBanner(kit.findings) : null;
  const important = kit ? kit.findings.filter(finding => finding.severity !== 'info') : [];
  const hints = kit ? kit.findings.filter(finding => finding.severity === 'info') : [];
  const showScope = scopeChoiceVisible(workspace) || scope.scope === 'assembly';
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  };
  const downloadFile = (path: string) => {
    const file = kit?.files.find(entry => entry.path === path);
    if (file) downloadBytes(basename(file.path), file.bytes, file.mime);
  };
  return <section ref={section} tabIndex={-1} className="panel export-dialog" role="dialog" aria-label="匯出套件" data-testid="export-dialog" onKeyDown={onKeyDown}
    data-export-state={shown.state}
    data-export-files={JSON.stringify(rows.map(({ path, bytes }) => ({ path, bytes })))}
    data-export-findings={JSON.stringify(kit ? kit.findings.map(finding => finding.code) : [])}
    data-export-image={kit ? (kit.imageMissing ? 'missing' : 'ok') : undefined}>
    <div className="panel-heading"><span className="eyebrow">EXPORT KIT</span></div>
    <h2>匯出套件</h2>
    {showScope && <div className="text-field export-scope">
      <label htmlFor="export-scope">匯出範圍</label>
      <select id="export-scope" value={scope.scope} onChange={event => {
        scopeEdit.current = true;
        setScope({ scope: event.target.value === 'assembly' ? 'assembly' : 'workspace', objectId: null });
      }}>
        <option value="workspace">整個工作區</option>
        <option value="assembly">目前物件的組合件</option>
      </select>
    </div>}
    {notice && <p className="notice info" role="status">{notice}</p>}
    {shown.state === 'preparing' && <div className="export-progress" role="status">
      <p>正在準備列印檔…（{shown.done}/{shown.total}）</p>
      <progress max={Math.max(shown.total, 1)} value={shown.done} />
      <button type="button" className="text-button" onClick={onClose}>停止準備</button>
    </div>}
    {shown.state === 'failed' && <p className="notice warning" role="alert">{FAILED_TEXT}</p>}
    {kit && <>
      <div className="export-summary">{summaryLines(kit).map(line => <p key={line}>{line}</p>)}</div>
      {important.length > 0 && <ul className="export-findings" aria-label="匯出檢查">{important.map((finding, index) => <FindingItem key={`${finding.code}-${index}`} finding={finding} />)}</ul>}
      {hints.length > 0 && <details className="export-hints">
        <summary>顯示 {hints.length} 則提示</summary>
        <ul className="export-findings">{hints.map((finding, index) => <FindingItem key={`${finding.code}-${index}`} finding={finding} />)}</ul>
      </details>}
      {banner && <p className="notice export-banner" role="status">{banner}</p>}
      {kit.imageMissing && <p className="notice info">{IMAGE_MISSING_TEXT}</p>}
      <button type="button" className="button primary" onClick={() => shown.state === 'ready' && downloadBytes(kit.zipName, kitZip(kit, shown.exportedAt), 'application/zip')}>下載完整套件</button>
      <ul className="export-files" aria-label="套件檔案">{rows.map(row => <li key={row.path}>
        <span className="export-path">{row.path}</span>
        <span className="small-muted">{formatKb(row.bytes)}</span>
        <button type="button" className="text-button" onClick={() => downloadFile(row.path)}>{row.label}</button>
      </li>)}</ul>
    </>}
    <button type="button" className="button export-close" onClick={onClose}>關閉匯出</button>
  </section>;
}
