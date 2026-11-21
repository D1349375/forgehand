import type { ReactNode } from 'react';
import { MAX_JOINTS } from '../../shared/joint';
import type { JointRow } from './card-model';
import { MOUSE_JOIN_STATUS } from './labels';
import type { MouseJoinState } from './mouse-join';

interface Props {
  rows: JointRow[];
  showJoints: boolean;
  mouseJoin: MouseJoinState;
  /** The latest explanation of a click that did not work (no flat face, a failed plan). */
  mouseNotice: string;
  /** A rejected joint change that has no card to show it in, for example a failed 確認接合. */
  error: string;
  /** True while an agent run is active: every manual control is disabled. */
  disabled: boolean;
  openJointId: string | null;
  onToggleShow: () => void;
  onOpen: (id: string | null) => void;
  onStart: () => void;
  onConfirmJoin: () => void;
  onNextPair: () => void;
  onCancelJoin: () => void;
  /** The open joint's card. */
  children?: ReactNode;
}

/** The 接合 panel (requirements 48, 51 to 53): the joint list, 顯示接合, the mouse join controls and, below the list, the open card. */
export function JointPanel({
  rows, showJoints, mouseJoin, mouseNotice, error, disabled, openJointId, onToggleShow, onOpen, onStart, onConfirmJoin, onNextPair, onCancelJoin, children,
}: Props) {
  const joining = mouseJoin.step !== 'off';
  const previewing = mouseJoin.step === 'preview';
  const status = mouseJoin.step === 'first' ? MOUSE_JOIN_STATUS.first : mouseJoin.step === 'second' ? MOUSE_JOIN_STATUS.second
    : mouseJoin.step === 'preview' ? MOUSE_JOIN_STATUS.preview : '';
  return <section className="panel joints-panel" aria-label="接合">
    <div className="panel-heading"><span className="eyebrow">JOINTS</span><span className="tag" data-testid="joint-tag">{rows.length} / {MAX_JOINTS}</span></div>
    <h2>接合</h2>
    <div className="button-group editor-actions">
      <button type="button" className={`button ${showJoints ? 'active' : ''}`} aria-pressed={showJoints} onClick={onToggleShow}>顯示接合</button>
      {!joining && <button type="button" className="button" disabled={disabled || rows.length >= MAX_JOINTS} onClick={onStart}>新增接合</button>}
      {joining && <>
        <button type="button" className="button" disabled={disabled || !previewing} onClick={onConfirmJoin}>確認接合</button>
        <button type="button" className="button" disabled={disabled || !(mouseJoin.step === 'preview' && mouseJoin.plan.pairs.length > 1)} onClick={onNextPair}>換一組面</button>
        <button type="button" className="button" onClick={onCancelJoin}>取消接合</button>
      </>}
    </div>
    {joining && <p className="notice info mouse-join-status" role="status" data-testid="mouse-join-status" data-step={mouseJoin.step}>{status}</p>}
    {mouseNotice && <p className="small-muted" data-testid="mouse-join-notice">{mouseNotice}</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
    {rows.length > 0 && <ul className="joint-list" aria-label="接合清單">{rows.map(row => <li key={row.id}>
      <button type="button" aria-pressed={row.id === openJointId} className={row.id === openJointId ? 'selected' : ''} onClick={() => onOpen(row.id === openJointId ? null : row.id)}>
        <span>{row.label}<small>{row.methodLabel}</small></span>
        <span className={`joint-state ${row.state}`}><span aria-hidden="true">{row.icon}</span>{row.stateText}</span>
      </button></li>)}</ul>}
    {rows.length === 0 && !joining && <p className="small-muted">還沒有接合。按「新增接合」，依序點選兩個零件。</p>}
    {children}
  </section>;
}
