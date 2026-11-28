import type { Calibration, ClearanceChoice, Measured, ProfileSlice, ScaleSource, WristMeasurement } from '../../shared/body';
import { scaleProfile, wristEllipse, type WristEllipse } from '../../shared/fit';
import {
  CLEARANCE_CUSTOM_MAX_MM, CLEARANCE_CUSTOM_MIN_MM, CLEARANCE_PRESETS_MM, DEFAULT_CLEARANCE_PRESET, DEFAULT_THICKNESS_RATIO,
  TAPE_CIRCUMFERENCE_MAX_MM, TAPE_CIRCUMFERENCE_MIN_MM, TAPE_SIZE_MAX_MM, TAPE_SIZE_MIN_MM,
} from '../../shared/fit-constants';
import type { ArmSide, SegmentCrop, SegmenterState } from '../try-on/arm-pose';
import type { StepKind, StepSlice } from './measure';

/**
 * The session store of body fit (design 7): what the user measured, calibrated and typed. A plain mutable store with
 * immutable snapshots, like `createSourceStore` in `useHandTracking.ts`: nothing here triggers a React render by itself.
 * Session state only (decision 5): it is never saved, and `reset()` clears it when fitting ends.
 */

/** The result of one finished measure step, in the scale in force when it was measured. */
export interface StepResult {
  kind: StepKind;
  slices: readonly StepSlice[];
  /** The card calibration factor `k` that was applied to the scale when these lengths were measured (1: none). */
  k: number;
}

export type TapeKey = 'circumferenceMm' | 'widthMm' | 'thicknessMm';
export interface TapeValues { circumferenceMm: number | null; widthMm: number | null; thicknessMm: number | null }
export type SegmenterStatus = 'idle' | SegmenterState;

export interface FitState {
  /** The worn arm's side, chosen when the first arm pose is placed; null until then. */
  side: ArmSide | null;
  steps: { width: StepResult | null; thickness: StepResult | null; passage: StepResult | null };
  calibration: Calibration | null;
  tape: TapeValues;
  clearance: ClearanceChoice;
  segmenter: SegmenterStatus;
}

export const initialFitState = (): FitState => ({
  side: null,
  steps: { width: null, thickness: null, passage: null },
  calibration: null,
  tape: { circumferenceMm: null, widthMm: null, thicknessMm: null },
  clearance: { preset: DEFAULT_CLEARANCE_PRESET, mm: CLEARANCE_PRESETS_MM[DEFAULT_CLEARANCE_PRESET] },
  segmenter: 'idle',
});

// ---------------------------------------------------------------------------
// Derived values

export interface TapeError { key: TapeKey; min: number; max: number }

/** What the camera, the card and the tape together say about the wrist (R7, R10, R24 to R28). */
export interface FitDerived {
  /** `null` while there is nothing to compute from. */
  measurement: WristMeasurement | null;
  /** The source of the circumference (or, before any measurement, the source a measurement would get). */
  source: ScaleSource;
  /** The camera circumference against the tape circumference (R27), when both exist. */
  cameraError: { cameraMm: number; tapeMm: number; cameraSource: ScaleSource } | null;
  /** A typed width or thickness and the circumference cannot belong to one ellipse (R25). */
  tapeInconsistent: boolean;
}

const rangeOf = (key: TapeKey) => key === 'circumferenceMm'
  ? { min: TAPE_CIRCUMFERENCE_MIN_MM, max: TAPE_CIRCUMFERENCE_MAX_MM }
  : { min: TAPE_SIZE_MIN_MM, max: TAPE_SIZE_MAX_MM };
export const tapeRange = rangeOf;

/** The value of the slice at `offsetMm`, or null. */
const sliceAt = (result: StepResult | null, offsetMm: number): StepSlice | null =>
  result?.slices.find(slice => slice.offsetMm === offsetMm && slice.valueMm !== null) ?? null;

/**
 * A step's lengths in the scale now in force: a width measured with factor `k0` is `k / k0` times as long at factor `k`,
 * so a calibration made after a measurement corrects it, and clearing the calibration takes the correction back (R10).
 */
function measuredOf(result: StepResult, slice: StepSlice, k: number, source: ScaleSource): Measured {
  const factor = k / result.k;
  return { mm: slice.valueMm! * factor, source, spreadMm: slice.spreadMm === null ? null : slice.spreadMm * factor };
}

export function derive(state: FitState): FitDerived {
  const k = state.calibration?.k ?? 1;
  const cameraSource: ScaleSource = state.calibration ? 'card' : 'estimate';
  const { width: widthStep, thickness: thicknessStep, passage: passageStep } = state.steps;
  const bandWidth = sliceAt(widthStep, 0);
  const bandThickness = sliceAt(thicknessStep, 0);

  let camera: { width: Measured; thickness: Measured } | null = null;
  let thicknessFromCamera = false;
  if (widthStep && bandWidth) {
    const width = measuredOf(widthStep, bandWidth, k, cameraSource);
    thicknessFromCamera = Boolean(thicknessStep && bandThickness);
    const thickness = thicknessStep && bandThickness
      ? measuredOf(thicknessStep, bandThickness, k, cameraSource)
      : { mm: width.mm * DEFAULT_THICKNESS_RATIO, source: cameraSource, spreadMm: width.spreadMm === null ? null : width.spreadMm * DEFAULT_THICKNESS_RATIO };
    camera = { width, thickness };
  }
  const tape = state.tape;
  const ellipse: WristEllipse | null = wristEllipse({
    camera, tapeCircumferenceMm: tape.circumferenceMm, typedWidthMm: tape.widthMm, typedThicknessMm: tape.thicknessMm,
  });
  const typedAny = tape.widthMm !== null || tape.thicknessMm !== null;
  const inconsistent = ellipse === null && tape.circumferenceMm !== null && typedAny;
  if (!ellipse) return { measurement: null, source: cameraSource, cameraError: null, tapeInconsistent: inconsistent };

  // The profile slices come from the camera; a tape or typed value that rescaled the ellipse rescales them too, keeping the taper.
  let profile: ProfileSlice[] = [];
  if (widthStep) {
    profile = widthStep.slices.map(slice => ({
      offsetMm: slice.offsetMm,
      width: slice.valueMm === null ? null : measuredOf(widthStep, slice, k, cameraSource),
      thickness: (() => {
        const other = thicknessStep?.slices.find(item => item.offsetMm === slice.offsetMm);
        return thicknessStep && other && other.valueMm !== null ? measuredOf(thicknessStep, other, k, cameraSource) : null;
      })(),
    }));
    if (ellipse.profileScale !== 1) profile = scaleProfile(profile, ellipse.profileScale, 'tape');
  }
  const passage = passageStep && sliceAt(passageStep, 0) ? measuredOf(passageStep, sliceAt(passageStep, 0)!, k, cameraSource) : null;
  const measurement: WristMeasurement = {
    side: state.side ?? 'right',
    width: ellipse.width,
    thickness: ellipse.thickness,
    circumference: ellipse.circumference,
    profile,
    passage,
    thicknessAssumed: ellipse.thicknessAssumed || (camera !== null && !thicknessFromCamera && tape.thicknessMm === null),
    cameraCircumferenceMm: ellipse.cameraCircumferenceMm,
  };
  const cameraError = tape.circumferenceMm !== null && ellipse.cameraCircumferenceMm !== null
    ? { cameraMm: ellipse.cameraCircumferenceMm, tapeMm: tape.circumferenceMm, cameraSource }
    : null;
  return { measurement, source: ellipse.circumference.source, cameraError, tapeInconsistent: false };
}

// ---------------------------------------------------------------------------
// Tape input (R25)

export type TapeUnit = 'mm' | 'cm';
export type TapeParse = { ok: true; mm: number | null } | ({ ok: false } & TapeError);

/**
 * Reads what the user typed into a tape field. Empty text clears the field. Otherwise the number (a comma may be the
 * decimal mark) in `unit` becomes millimetres and must lie in the field's range: the circumference 100 to 300 mm,
 * the width and the thickness 30 to 120 mm.
 */
export function parseTape(key: TapeKey, text: string, unit: TapeUnit): TapeParse {
  const trimmed = text.trim();
  const range = rangeOf(key);
  if (trimmed === '') return { ok: true, mm: null };
  const number = Number(trimmed.replace(',', '.'));
  const mm = Math.round(number * (unit === 'cm' ? 10 : 1) * 100) / 100;
  if (!/^[+]?\d*\.?\d+$/.test(trimmed.replace(',', '.')) || !Number.isFinite(mm) || mm < range.min || mm > range.max) return { ok: false, key, ...range };
  return { ok: true, mm };
}

/** A custom clearance in millimetres of circumference (R55): 0 to 40. `null` when it is not a number in range. */
export function parseClearance(text: string): number | null {
  const number = Number(text.trim().replace(',', '.'));
  if (text.trim() === '' || !Number.isFinite(number) || number < CLEARANCE_CUSTOM_MIN_MM || number > CLEARANCE_CUSTOM_MAX_MM) return null;
  return Math.round(number * 10) / 10;
}

// ---------------------------------------------------------------------------
// The store

export interface FitStore {
  snapshot(): FitState;
  derived(): FitDerived;
  subscribe(listener: () => void): () => void;
  /** The crop the next camera frames carry to the worker; the cadence in `useBodyFit` sets and clears it. */
  readonly segment: { current: SegmentCrop | null };
  /** The factor `k` of the calibration in force, 1 without one. */
  k(): number;
  setSide(side: ArmSide | null): void;
  recordStep(result: StepResult): void;
  clearSteps(): void;
  setCalibration(calibration: Calibration | null): void;
  setTape(key: TapeKey, mm: number | null): void;
  clearTape(): void;
  setClearancePreset(preset: 'snug' | 'comfort' | 'loose'): void;
  setClearanceCustom(mm: number): void;
  setSegmenter(state: SegmenterStatus): void;
  /** Ends the session: measurements, calibration, tape and clearance go back to their defaults. The segmenter state stays: it belongs to the worker. */
  reset(): void;
}

export function createFitStore(): FitStore {
  let state = initialFitState();
  let cached: FitDerived | null = null;
  const listeners = new Set<() => void>();
  const segment: { current: SegmentCrop | null } = { current: null };
  const set = (next: FitState) => {
    state = next;
    cached = null;
    for (const listener of [...listeners]) listener();
  };
  return {
    snapshot: () => state,
    derived: () => (cached ??= derive(state)),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    segment,
    k: () => state.calibration?.k ?? 1,
    setSide(side) { if (side !== state.side) set({ ...state, side }); },
    recordStep(result) { set({ ...state, steps: { ...state.steps, [result.kind]: result } }); },
    clearSteps() { set({ ...state, steps: { width: null, thickness: null, passage: null } }); },
    setCalibration(calibration) { set({ ...state, calibration }); },
    setTape(key, mm) { if (mm !== state.tape[key]) set({ ...state, tape: { ...state.tape, [key]: mm } }); },
    clearTape() { set({ ...state, tape: { circumferenceMm: null, widthMm: null, thicknessMm: null } }); },
    setClearancePreset(preset) { set({ ...state, clearance: { preset, mm: CLEARANCE_PRESETS_MM[preset] } }); },
    setClearanceCustom(mm) { set({ ...state, clearance: { preset: 'custom', mm: Math.min(CLEARANCE_CUSTOM_MAX_MM, Math.max(CLEARANCE_CUSTOM_MIN_MM, mm)) } }); },
    setSegmenter(next) { if (next !== state.segmenter) set({ ...state, segmenter: next }); },
    reset() {
      segment.current = null;
      set({ ...initialFitState(), segmenter: state.segmenter });
    },
  };
}
