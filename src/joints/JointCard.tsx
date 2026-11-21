import type { ReactNode } from 'react';
import type { JointMethod, JointNeeds } from '../../shared/joint';
import { GLUE_IDS, MAGNET_IDS, PIN_IDS, SCREW_SIZES, type JointCardModel } from './card-model';
import {
  COUNT_OPTIONS, DISASSEMBLY_OPTIONS, LOAD_OPTIONS, METHOD_LABELS, PIN_FIT_LABELS, glueLabel, magnetLabel, pinLabel,
} from './labels';

/** The print preview a card button controls. `loading` while the printable solid is being built. */
export interface PrintPreviewState { objectId: string; partId: string; status: 'loading' | 'ready' }

interface Props {
  model: JointCardModel;
  /** True while an agent run is active, a mouse join runs or nothing can change: every control is disabled. */
  disabled: boolean;
  /** 請代理建議 is also off while a generate or edit request is running (the agent panel refuses then, too). */
  askDisabled: boolean;
  /** A rejected change (for example a failed 重新對齊), shown inside the card. */
  error: string;
  preview: PrintPreviewState | null;
  onNeeds: (change: Partial<JointNeeds>) => void;
  onMethod: (kind: JointMethod['kind']) => void;
  onParam: (param: Record<string, unknown>) => void;
  onConfirm: () => void;
  onUseRecommendation: () => void;
  onRealign: () => void;
  onPreview: (target: { objectId: string; partId: string }) => void;
  onAskAgent: () => void;
  onRemove: () => void;
  onClose: () => void;
}

const FieldSelect = ({ label, value, disabled, onChange, children }: {
  label: string; value: string; disabled: boolean; onChange: (value: string) => void; children: ReactNode;
}) => <label className="text-field"><span>{label}</span>
  <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{children}</select></label>;

/** The joint card (requirements 54 to 56): sides, recommendation, needs, method with parameters, derived values, findings and actions. */
export function JointCard({ model, disabled, askDisabled, error, preview, onNeeds, onMethod, onParam, onConfirm, onUseRecommendation, onRealign, onPreview, onAskAgent, onRemove, onClose }: Props) {
  const { method, needs, actions } = model;
  const params = (() => {
    switch (method.kind) {
      case 'screw-insert': return <>
        <FieldSelect label="規格" value={method.size} disabled={disabled} onChange={value => onParam({ size: value })}>
          {SCREW_SIZES.map(size => <option key={size} value={size}>{size}</option>)}</FieldSelect>
        <FieldSelect label="數量" value={String(method.count)} disabled={disabled} onChange={value => onParam({ count: Number(value) })}>
          {COUNT_OPTIONS.map(count => <option key={count} value={count}>{count}</option>)}</FieldSelect>
        <FieldSelect label="螺母側" value={method.insertSide} disabled={disabled} onChange={value => onParam({ insertSide: value })}>
          <option value="a">{model.sideA.name}</option><option value="b">{model.sideB.name}</option></FieldSelect></>;
      case 'magnet': return <>
        <FieldSelect label="磁鐵尺寸" value={method.magnet} disabled={disabled} onChange={value => onParam({ magnet: value })}>
          {MAGNET_IDS.map(id => <option key={id} value={id}>{magnetLabel(id)}</option>)}</FieldSelect>
        <FieldSelect label="數量" value={String(method.count)} disabled={disabled} onChange={value => onParam({ count: Number(value) })}>
          {COUNT_OPTIONS.map(count => <option key={count} value={count}>{count}</option>)}</FieldSelect></>;
      case 'pin': return <>
        <FieldSelect label="銷徑" value={method.pin} disabled={disabled} onChange={value => onParam({ pin: value })}>
          {PIN_IDS.map(id => <option key={id} value={id}>{pinLabel(id)}</option>)}</FieldSelect>
        <FieldSelect label="數量" value={String(method.count)} disabled={disabled} onChange={value => onParam({ count: Number(value) })}>
          {COUNT_OPTIONS.map(count => <option key={count} value={count}>{count}</option>)}</FieldSelect>
        <FieldSelect label="配合" value={method.fit} disabled={disabled} onChange={value => onParam({ fit: value })}>
          {(Object.keys(PIN_FIT_LABELS) as Array<keyof typeof PIN_FIT_LABELS>).map(fit => <option key={fit} value={fit}>{PIN_FIT_LABELS[fit]}</option>)}</FieldSelect></>;
      case 'glue': return <FieldSelect label="膠種" value={method.glue} disabled={disabled} onChange={value => onParam({ glue: value })}>
        {GLUE_IDS.map(id => <option key={id} value={id}>{glueLabel(id)}</option>)}</FieldSelect>;
    }
  })();
  return <div className="joint-card" data-testid="joint-card" data-joint-id={model.jointId} data-state={model.state}>
    <div className="joint-card-head">
      <strong>{model.title}</strong>
      <span className={`joint-state ${model.state}`}><span aria-hidden="true">{model.icon}</span>{model.stateText}</span>
    </div>
    <p className="small-muted">{model.sideA.name}（{model.sideA.faceLabel}）↔ {model.sideB.name}（{model.sideB.faceLabel}）</p>
    {model.recommendation && <div className="joint-recommendation" data-testid="joint-recommendation">
      <span className="small-muted">建議：{model.recommendation.label}{model.recommendation.ok ? '' : '（目前放不下）'}</span>
      <ul>{model.recommendation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
    </div>}
    <div className="joint-fields">
      <FieldSelect label="負重" value={needs.load ?? ''} disabled={disabled} onChange={value => onNeeds({ load: (value || null) as JointNeeds['load'] })}>
        {LOAD_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</FieldSelect>
      <FieldSelect label="拆裝" value={needs.disassembly ?? ''} disabled={disabled} onChange={value => onNeeds({ disassembly: (value || null) as JointNeeds['disassembly'] })}>
        {DISASSEMBLY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</FieldSelect>
      <FieldSelect label="固定方式" value={method.kind} disabled={disabled} onChange={value => onMethod(value as JointMethod['kind'])}>
        {model.methodKinds.map(kind => <option key={kind.kind} value={kind.kind} disabled={!kind.allowed}>{METHOD_LABELS[kind.kind]}</option>)}</FieldSelect>
      {params}
    </div>
    {model.derived && <p className="joint-derived" data-testid="joint-derived">{model.derived}</p>}
    {model.findings.length > 0 && <ul className="joint-findings" aria-label="接合檢查">{model.findings.map((finding, at) =>
      <li key={`${finding.text}-${at}`} className={finding.severity}><span aria-hidden="true">{finding.icon}</span>{finding.text}</li>)}</ul>}
    {error && <p className="notice warning" role="alert">{error}</p>}
    <div className="button-group editor-actions">
      {actions.confirm && <button type="button" className="button" disabled={disabled} onClick={onConfirm}>確認方式</button>}
      {actions.useRecommendation && <button type="button" className="button" disabled={disabled} onClick={onUseRecommendation}>改用建議</button>}
      {actions.realign && <button type="button" className="button" disabled={disabled} onClick={onRealign}>重新對齊</button>}
      {actions.previews.map(item => {
        const open = preview?.objectId === item.objectId && preview.partId === item.partId;
        const loading = open && preview.status === 'loading';
        return <button key={item.side} type="button" className={`button ${open && !loading ? 'active' : ''}`} aria-pressed={open && !loading} disabled={loading}
          onClick={() => onPreview({ objectId: item.objectId, partId: item.partId })}>{loading ? '正在產生列印件預覽…' : open ? '關閉預覽' : item.label}</button>;
      })}
      <button type="button" className="button" disabled={disabled || askDisabled} onClick={onAskAgent}>請代理建議</button>
      <button type="button" className="button danger" disabled={disabled} onClick={onRemove}>刪除接合</button>
      <button type="button" className="text-button" onClick={onClose}>收合</button>
    </div>
  </div>;
}
