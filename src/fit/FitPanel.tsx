import { useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { CLEARANCE_PRESETS_MM, MEASURE_FRAMES } from '../../shared/fit-constants';
import { formatMm } from '../../shared/fit-text';
import { cameraErrorText, FIT_UI, lengthText, measuredText, sourceName } from '../../shared/i18n/fit';
import { useLang } from '../i18n/LanguageProvider';
import { calibrationDirection } from './card';
import type { StepKind, WaitReason } from './measure';
import { parseClearance, parseTape, type FitStore, type TapeKey, type TapeUnit } from './store';
import type { BodyFitApi } from './useBodyFit';

/** The fit state of R77: what the tracking is doing for the fit session. */
export type FitPanelState = 'off' | 'loading' | 'searching' | 'worn' | 'error';

const STEP_KINDS: readonly StepKind[] = ['width', 'thickness', 'passage'];
const TAPE_KEYS: readonly TapeKey[] = ['circumferenceMm', 'widthMm', 'thicknessMm'];
const REASON_KEY: Record<WaitReason, 'noHand' | 'palm' | 'thumbUp' | 'flat' | 'still' | 'noMask'> = {
  'no-hand': 'noHand', palm: 'palm', 'thumb-up': 'thumbUp', flat: 'flat', still: 'still', 'no-mask': 'noMask',
};

const unitText = (mm: number, unit: TapeUnit): string => String(unit === 'cm' ? Math.round(mm) / 10 : Math.round(mm * 10) / 10);

/**
 * The fit panel (R76): the worn object and side, the size source, the guided wrist measurement, the card calibration, the
 * tape input and the clearance. It takes `{ store, bodyFit, ... }` only, so `workbench-ui` can mount it in its slot unchanged.
 * Sections that belong to later tasks (placement, closure, the fit numbers and dial) are not rendered yet.
 */
export function FitPanel({ store, bodyFit, state, objectName, onClose }: {
  store: FitStore;
  bodyFit: BodyFitApi;
  state: FitPanelState;
  objectName: string | null;
  onClose: () => void;
}) {
  const { lang } = useLang();
  const text = FIT_UI[lang];
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot);
  const derived = store.derived();
  const { live } = bodyFit;
  const measurement = derived.measurement;
  const [unit, setUnit] = useState<TapeUnit>('mm');
  const [drafts, setDrafts] = useState<Record<TapeKey, string>>({ circumferenceMm: '', widthMm: '', thicknessMm: '' });
  const [errors, setErrors] = useState<Partial<Record<TapeKey, { min: number; max: number }>>>({});
  const [customDraft, setCustomDraft] = useState('');
  const [customInvalid, setCustomInvalid] = useState(false);

  const stepActive = live.step !== null;
  const cardActive = live.card !== 'off';
  const measured = STEP_KINDS.some(kind => snapshot.steps[kind] !== null);
  const dataStep = cardActive ? 'card' : live.step ? live.step.kind : snapshot.steps.width && snapshot.steps.thickness ? 'done' : 'idle';

  function commitTape(key: TapeKey) {
    const result = parseTape(key, drafts[key], unit);
    if (!result.ok) { setErrors(current => ({ ...current, [key]: { min: result.min, max: result.max } })); return; }
    setErrors(current => { const next = { ...current }; delete next[key]; return next; });
    store.setTape(key, result.mm);
    if (result.mm !== null) setDrafts(current => ({ ...current, [key]: unitText(result.mm!, unit) }));
  }
  function changeUnit(next: TapeUnit) {
    setUnit(next);
    setErrors({});
    const tape = store.snapshot().tape;
    setDrafts({
      circumferenceMm: tape.circumferenceMm === null ? '' : unitText(tape.circumferenceMm, next),
      widthMm: tape.widthMm === null ? '' : unitText(tape.widthMm, next),
      thicknessMm: tape.thicknessMm === null ? '' : unitText(tape.thicknessMm, next),
    });
  }
  function clearTape() {
    store.clearTape();
    setErrors({});
    setDrafts({ circumferenceMm: '', widthMm: '', thicknessMm: '' });
  }
  function commitCustom() {
    const mm = parseClearance(customDraft);
    if (mm === null) { setCustomInvalid(true); return; }
    setCustomInvalid(false);
    store.setClearanceCustom(mm);
  }
  const enterCommits = (commit: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
  };

  const sideText = snapshot.side === 'left' ? text.panel.sideLeft : snapshot.side === 'right' ? text.panel.sideRight : text.panel.sideNone;
  const tapeLabels: Record<TapeKey, string> = { circumferenceMm: text.tape.circumference, widthMm: text.tape.width, thicknessMm: text.tape.thickness };
  const step = live.step;
  const calibration = snapshot.calibration ? calibrationDirection(snapshot.calibration.k) : null;
  const delegateIsCpu = live.delegate === 'CPU';

  return <section className="panel fit-panel" data-testid="fit-panel" aria-label={text.panel.title}
    data-fit-state={state} data-fit-source={derived.source} data-fit-step={dataStep}>
    <span className="eyebrow">BODY FIT</span>
    <h2>{text.panel.title}</h2>
    <dl className="fit-facts">
      <div><dt>{text.panel.object}</dt><dd data-testid="fit-object">{objectName ?? text.panel.noObject}</dd></div>
      <div><dt>{text.panel.side}</dt><dd data-testid="fit-side">{sideText}</dd></div>
    </dl>

    <div className="fit-section" data-testid="fit-source">
      <h3>{text.source.heading}</h3>
      <p>{text.source.current({ source: measurement ? sourceName(lang, derived.source) : snapshot.calibration ? sourceName(lang, 'card') : text.source.none })}</p>
    </div>

    <div className="fit-section" data-testid="fit-measure">
      <h3>{text.measure.heading}</h3>
      {snapshot.segmenter === 'loading' && <p className="fit-note" role="status">{text.measure.segmenterLoading}</p>}
      {snapshot.segmenter === 'error' && <p className="fit-note warning" role="alert">{text.measure.segmenterError}</p>}
      {delegateIsCpu && <p className="fit-note">{text.measure.cpu}</p>}
      <ol className="fit-steps">
        {STEP_KINDS.map(kind => {
          const running = step?.kind === kind;
          const copy = text.measure[kind];
          const result = snapshot.steps[kind];
          return <li key={kind} className={running ? 'running' : ''} data-testid={`fit-step-${kind}`} data-done={result ? 'true' : 'false'}>
            <div className="fit-step-head">
              <strong>{copy.title}</strong>
              <button type="button" className="button" disabled={(stepActive && !running) || cardActive || state === 'off'}
                onClick={() => (running ? bodyFit.stopStep() : bodyFit.startStep(kind))}>{running ? text.measure.stop : copy.button}</button>
            </div>
            {kind === 'passage' && !running && <p className="fit-note">{text.measure.passage.note}</p>}
            {running && step && <div className="fit-step-body" role="status" aria-live="polite" data-testid="fit-step-status" data-phase={step.state.phase}>
              <p>{copy.instruction}</p>
              {step.state.phase === 'waiting' && <p className="fit-reason" data-reason={step.state.reason}>{text.measure.reason[REASON_KEY[step.state.reason]]}</p>}
              {(step.state.phase === 'waiting' || step.state.phase === 'recording') && <>
                <progress max={MEASURE_FRAMES} value={step.state.accepted} aria-label={text.measure.progress({ n: step.state.accepted, total: MEASURE_FRAMES })} />
                <span className="small-muted">{text.measure.progress({ n: step.state.accepted, total: MEASURE_FRAMES })}</span>
              </>}
            </div>}
          </li>;
        })}
      </ol>
      {live.unstable && <p className="fit-note warning" role="alert" data-testid="fit-unstable">{text.measure.unstable}</p>}
      {measurement && <div className="fit-result" data-testid="fit-result">
        <p>{text.measure.result({ width: lengthText(measurement.width), thickness: lengthText(measurement.thickness), circumference: measuredText(lang, measurement.circumference) })}</p>
        {measurement.thicknessAssumed && <p className="fit-note">{text.measure.thicknessAssumed}</p>}
        {measurement.passage && <p>{text.measure.passageResult({ value: measuredText(lang, measurement.passage) })}</p>}
      </div>}
      {measured && <button type="button" className="text-button" disabled={stepActive || cardActive}
        onClick={() => { store.clearSteps(); bodyFit.startStep('width'); }}>{text.measure.again}</button>}
    </div>

    <div className="fit-section" data-testid="fit-card">
      <h3>{text.card.heading}</h3>
      {cardActive
        ? <p className="fit-note" role="status">{live.card === 'aiming' ? text.card.instruction : text.card.frozenHelp}</p>
        : <>
          <button type="button" className="button" disabled={!live.tracking || stepActive || state === 'off'} onClick={() => bodyFit.startCard()}>{text.card.start}</button>
          {!live.tracking && <p className="fit-note">{text.card.needHand}</p>}
        </>}
      {calibration && !cardActive && <div data-testid="fit-calibration">
        <p>{calibration.direction === 'same' ? text.card.same : calibration.direction === 'bigger' ? text.card.biggerBy({ percent: calibration.percent }) : text.card.smallerBy({ percent: calibration.percent })}</p>
        <button type="button" className="text-button" onClick={() => store.setCalibration(null)}>{text.card.clear}</button>
      </div>}
    </div>

    <div className="fit-section" data-testid="fit-tape">
      <h3>{text.tape.heading}</h3>
      <label className="fit-unit">{text.tape.unit}
        <select value={unit} aria-label={text.tape.unit} onChange={event => changeUnit(event.target.value as TapeUnit)}>
          <option value="mm">mm</option>
          <option value="cm">cm</option>
        </select>
      </label>
      {TAPE_KEYS.map(key => <div key={key} className={`fit-field ${errors[key] ? 'invalid' : ''}`}>
        <label>
          <span>{tapeLabels[key]}</span>
          <input inputMode="decimal" value={drafts[key]} aria-label={tapeLabels[key]} aria-invalid={Boolean(errors[key])} data-testid={`fit-tape-${key}`}
            onChange={event => setDrafts(current => ({ ...current, [key]: event.target.value }))} onBlur={() => commitTape(key)} onKeyDown={enterCommits(() => commitTape(key))} />
        </label>
        {errors[key] && <p className="fit-note warning" role="alert">{text.tape.range({ min: errors[key]!.min, max: errors[key]!.max })}</p>}
      </div>)}
      {derived.tapeInconsistent && <p className="fit-note warning" role="alert">{text.tape.inconsistent}</p>}
      {derived.cameraError && <p className="fit-note" data-testid="fit-camera-error">{cameraErrorText(lang, derived.cameraError.cameraMm, derived.cameraError.tapeMm, derived.cameraError.cameraSource)}</p>}
      {(snapshot.tape.circumferenceMm !== null || snapshot.tape.widthMm !== null || snapshot.tape.thicknessMm !== null) &&
        <button type="button" className="text-button" onClick={clearTape}>{text.tape.clear}</button>}
    </div>

    <div className="fit-section" data-testid="fit-clearance">
      <h3>{text.clearance.heading}</h3>
      <div className="fit-choices" role="group" aria-label={text.clearance.heading}>
        {(['snug', 'comfort', 'loose'] as const).map(preset => <button key={preset} type="button" className={`button ${snapshot.clearance.preset === preset ? 'active' : ''}`}
          aria-pressed={snapshot.clearance.preset === preset} onClick={() => store.setClearancePreset(preset)}>{text.clearance[preset]} <small>{text.clearance.value({ mm: String(CLEARANCE_PRESETS_MM[preset]) })}</small></button>)}
        <button type="button" className={`button ${snapshot.clearance.preset === 'custom' ? 'active' : ''}`} aria-pressed={snapshot.clearance.preset === 'custom'}
          onClick={() => { setCustomDraft(formatMm(snapshot.clearance.mm)); store.setClearanceCustom(snapshot.clearance.mm); }}>{text.clearance.custom}</button>
      </div>
      {snapshot.clearance.preset === 'custom' && <label className={`fit-field ${customInvalid ? 'invalid' : ''}`}>
        <span>{text.clearance.customLabel}</span>
        <input inputMode="decimal" value={customDraft} aria-label={text.clearance.customLabel} aria-invalid={customInvalid}
          onChange={event => setCustomDraft(event.target.value)} onBlur={commitCustom} onKeyDown={enterCommits(commitCustom)} />
      </label>}
      <p className="small-muted">{text.clearance.help}</p>
    </div>

    <button type="button" className="button" onClick={onClose}>{text.panel.end}</button>
    <p className="small-muted">{text.panel.note}</p>
  </section>;
}
