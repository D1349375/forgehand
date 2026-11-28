import { describe, expect, it } from 'vitest';
import { ellipsePerimeter } from '../../shared/ellipse';
import { CLEARANCE_PRESETS_MM } from '../../shared/fit-constants';
import { WristMeasurementSchema } from '../../shared/body';
import { PROFILE_OFFSETS } from '../../src/fit/measure';
import { createFitStore, derive, initialFitState, parseClearance, parseTape, type FitState, type StepResult } from '../../src/fit/store';
import type { StepKind } from '../../src/fit/measure';

/** A finished step whose width (or thickness) is `mm` at every offset, with a spread of 0.4 mm, measured with factor `k`. */
function step(kind: StepKind, mm: number, k = 1, taper = 0): StepResult {
  const offsets = kind === 'passage' ? [0] : PROFILE_OFFSETS;
  return { kind, k, slices: offsets.map(offsetMm => ({ offsetMm, valueMm: mm + taper * offsetMm, spreadMm: 0.4 })) };
}
const withSteps = (width: number | null, thickness: number | null, extra: Partial<FitState> = {}): FitState => ({
  ...initialFitState(),
  steps: { width: width === null ? null : step('width', width), thickness: thickness === null ? null : step('thickness', thickness), passage: null },
  ...extra,
});

describe('tape input (R25)', () => {
  it('reads millimetres and centimetres, a comma as the decimal mark, and empty text as clearing', () => {
    expect(parseTape('circumferenceMm', '165', 'mm')).toEqual({ ok: true, mm: 165 });
    expect(parseTape('circumferenceMm', '16,5', 'cm')).toEqual({ ok: true, mm: 165 });
    expect(parseTape('widthMm', ' 58.5 ', 'mm')).toEqual({ ok: true, mm: 58.5 });
    expect(parseTape('thicknessMm', '', 'mm')).toEqual({ ok: true, mm: null });
  });

  it('refuses values outside the range of the field, with that range', () => {
    expect(parseTape('circumferenceMm', '99.9', 'mm')).toEqual({ ok: false, key: 'circumferenceMm', min: 100, max: 300 });
    expect(parseTape('circumferenceMm', '301', 'mm')).toMatchObject({ ok: false, min: 100, max: 300 });
    expect(parseTape('circumferenceMm', '16', 'cm')).toMatchObject({ ok: true, mm: 160 });
    expect(parseTape('circumferenceMm', '31', 'cm')).toMatchObject({ ok: false });
    expect(parseTape('widthMm', '29', 'mm')).toEqual({ ok: false, key: 'widthMm', min: 30, max: 120 });
    expect(parseTape('thicknessMm', '121', 'mm')).toMatchObject({ ok: false, min: 30, max: 120 });
    expect(parseTape('widthMm', '12', 'cm')).toMatchObject({ ok: true, mm: 120 });
  });

  it('refuses text that is not a plain number', () => {
    for (const text of ['abc', '1e2', '-150', '150mm', '1.2.3', '--', 'Infinity', '0x10']) {
      expect(parseTape('circumferenceMm', text, 'mm').ok, text).toBe(false);
    }
  });

  it('reads a custom clearance from 0 to 40 mm', () => {
    expect(parseClearance('18')).toBe(18);
    expect(parseClearance('0')).toBe(0);
    expect(parseClearance('40')).toBe(40);
    expect(parseClearance('12,34')).toBe(12.3);
    expect(parseClearance('41')).toBeNull();
    expect(parseClearance('-1')).toBeNull();
    expect(parseClearance('')).toBeNull();
    expect(parseClearance('x')).toBeNull();
  });
});

describe('what the camera, the card and the tape say (R7, R10, R24 to R28)', () => {
  it('has nothing before a measurement, and the estimate as its source', () => {
    const result = derive(initialFitState());
    expect(result).toEqual({ measurement: null, source: 'estimate', cameraError: null, tapeInconsistent: false });
    expect(derive({ ...initialFitState(), calibration: { k: 0.96, at: '2026-11-29T00:00:00.000Z', spreadPct: 0 } }).source).toBe('card');
  });

  it('gives the camera width, thickness and perimeter with their source and spread', () => {
    const result = derive(withSteps(58, 39));
    const wrist = result.measurement!;
    expect(wrist.width).toEqual({ mm: 58, source: 'estimate', spreadMm: 0.4 });
    expect(wrist.thickness).toEqual({ mm: 39, source: 'estimate', spreadMm: 0.4 });
    expect(wrist.circumference.mm).toBeCloseTo(ellipsePerimeter(29, 19.5), 9);
    expect(wrist.circumference.source).toBe('estimate');
    expect(wrist.thicknessAssumed).toBe(false);
    expect(wrist.passage).toBeNull();
    expect(wrist.profile).toHaveLength(PROFILE_OFFSETS.length);
    expect(wrist.profile[0]!.offsetMm).toBe(-20);
    expect(result.source).toBe('estimate');
    expect(result.cameraError).toBeNull();
    expect(WristMeasurementSchema.safeParse(wrist).success).toBe(true);
  });

  it('assumes the thickness from the usual ratio when only the width was measured (R26)', () => {
    const wrist = derive(withSteps(60, null)).measurement!;
    expect(wrist.thickness.mm).toBeCloseTo(39, 9);
    expect(wrist.thicknessAssumed).toBe(true);
    expect(wrist.profile.every(slice => slice.thickness === null)).toBe(true);
  });

  it('takes the tape circumference, keeps the camera shape and names the tape as the source (R26, R28)', () => {
    const result = derive(withSteps(58, 39, { tape: { circumferenceMm: 165, widthMm: null, thicknessMm: null } }));
    const wrist = result.measurement!;
    expect(wrist.circumference).toEqual({ mm: 165, source: 'tape', spreadMm: null });
    expect(wrist.thickness.mm / wrist.width.mm).toBeCloseTo(39 / 58, 6);
    expect(ellipsePerimeter(wrist.width.mm / 2, wrist.thickness.mm / 2)).toBeCloseTo(165, 4);
    expect(result.source).toBe('tape');
    // The profile slices follow the tape's size, keeping the camera's taper.
    expect(wrist.profile[4]!.width!.source).toBe('tape');
    expect(wrist.profile[4]!.width!.mm).toBeCloseTo(wrist.width.mm, 6);
    expect(wrist.cameraCircumferenceMm).toBeCloseTo(ellipsePerimeter(29, 19.5), 9);
  });

  it('gives the error line of the camera against the tape (R27)', () => {
    const result = derive(withSteps(58, 39, { tape: { circumferenceMm: 165, widthMm: null, thicknessMm: null } }));
    expect(result.cameraError?.tapeMm).toBe(165);
    expect(result.cameraError?.cameraMm).toBeCloseTo(ellipsePerimeter(29, 19.5), 9);
    expect(result.cameraError?.cameraSource).toBe('estimate');
    expect(derive(withSteps(58, 39)).cameraError).toBeNull();
    expect(derive({ ...initialFitState(), tape: { circumferenceMm: 165, widthMm: null, thicknessMm: null } }).cameraError).toBeNull();
  });

  it('uses the tape alone with the usual ratio and says the thickness is assumed (R26)', () => {
    const wrist = derive({ ...initialFitState(), tape: { circumferenceMm: 165, widthMm: null, thicknessMm: null } }).measurement!;
    expect(wrist.thicknessAssumed).toBe(true);
    expect(wrist.thickness.mm / wrist.width.mm).toBeCloseTo(0.65, 9);
    expect(wrist.circumference).toEqual({ mm: 165, source: 'tape', spreadMm: null });
    expect(wrist.profile).toEqual([]);
  });

  it('lets typed values replace the camera values they stand for (R28)', () => {
    const wrist = derive(withSteps(58, 39, { tape: { circumferenceMm: null, widthMm: 62, thicknessMm: 41 } })).measurement!;
    expect(wrist.width).toEqual({ mm: 62, source: 'tape', spreadMm: null });
    expect(wrist.thickness).toEqual({ mm: 41, source: 'tape', spreadMm: null });
    expect(wrist.circumference.source).toBe('tape');
  });

  it('says so when a typed size and the circumference cannot belong to one ellipse', () => {
    const result = derive({ ...initialFitState(), tape: { circumferenceMm: 100, widthMm: 120, thicknessMm: null } });
    expect(result.measurement).toBeNull();
    expect(result.tapeInconsistent).toBe(true);
  });

  it('makes the card the source of every camera length and rescales the lengths measured before it (R10)', () => {
    const before = derive(withSteps(58, 39)).measurement!;
    const calibration = { k: 0.96, at: '2026-11-29T00:00:00.000Z', spreadPct: 0.5 };
    const after = derive(withSteps(58, 39, { calibration }));
    expect(after.source).toBe('card');
    expect(after.measurement!.width).toEqual({ mm: 58 * 0.96, source: 'card', spreadMm: 0.4 * 0.96 });
    expect(after.measurement!.circumference.mm).toBeCloseTo(before.circumference.mm * 0.96, 6);
    expect(after.measurement!.circumference.source).toBe('card');
    // A step that was measured with the factor already in force is not scaled twice.
    const measuredWithCard: FitState = { ...withSteps(null, null, { calibration }), steps: { width: step('width', 55.68, 0.96), thickness: step('thickness', 37.44, 0.96), passage: null } };
    expect(derive(measuredWithCard).measurement!.width.mm).toBeCloseTo(55.68, 9);
    // Clearing the calibration takes the correction back.
    expect(derive({ ...withSteps(null, null), steps: measuredWithCard.steps }).measurement!.width.mm).toBeCloseTo(55.68 / 0.96, 9);
  });

  it('keeps the card as the source of the camera error line', () => {
    const calibration = { k: 1.04, at: '2026-11-29T00:00:00.000Z', spreadPct: 0.5 };
    const result = derive(withSteps(58, 39, { calibration, tape: { circumferenceMm: 165, widthMm: null, thicknessMm: null } }));
    expect(result.cameraError?.cameraSource).toBe('card');
    expect(result.source).toBe('tape');
  });

  it('reads the hand passage width with the source of the camera', () => {
    const state: FitState = { ...withSteps(58, 39), steps: { ...withSteps(58, 39).steps, passage: step('passage', 82) } };
    expect(derive(state).measurement!.passage).toEqual({ mm: 82, source: 'estimate', spreadMm: 0.4 });
  });

  it('records the worn side, falling back to the right hand before it is known', () => {
    expect(derive(withSteps(58, 39)).measurement!.side).toBe('right');
    expect(derive(withSteps(58, 39, { side: 'left' })).measurement!.side).toBe('left');
  });
});

describe('the session store', () => {
  it('notifies listeners on a change, gives a new snapshot, and not on a no-op', () => {
    const store = createFitStore();
    let calls = 0;
    const off = store.subscribe(() => { calls++; });
    const first = store.snapshot();
    store.setTape('circumferenceMm', 165);
    expect(calls).toBe(1);
    expect(store.snapshot()).not.toBe(first);
    expect(first.tape.circumferenceMm).toBeNull();
    store.setTape('circumferenceMm', 165);
    store.setSide(null);
    expect(calls).toBe(1);
    off();
    store.setTape('widthMm', 60);
    expect(calls).toBe(1);
  });

  it('caches the derived values until the state changes', () => {
    const store = createFitStore();
    store.recordStep(step('width', 58));
    const a = store.derived();
    expect(store.derived()).toBe(a);
    store.setTape('circumferenceMm', 160);
    expect(store.derived()).not.toBe(a);
  });

  it('records steps, calibration, tape and clearance, and starts from the comfort preset', () => {
    const store = createFitStore();
    expect(store.snapshot().clearance).toEqual({ preset: 'comfort', mm: CLEARANCE_PRESETS_MM.comfort });
    expect(store.k()).toBe(1);
    store.recordStep(step('width', 58));
    store.recordStep(step('thickness', 39, 1));
    store.setCalibration({ k: 0.97, at: '2026-11-29T00:00:00.000Z', spreadPct: 1 });
    expect(store.k()).toBe(0.97);
    store.setClearancePreset('snug');
    expect(store.snapshot().clearance).toEqual({ preset: 'snug', mm: 6 });
    store.setClearanceCustom(55);
    expect(store.snapshot().clearance).toEqual({ preset: 'custom', mm: 40 });
    store.setClearanceCustom(-3);
    expect(store.snapshot().clearance.mm).toBe(0);
    store.setCalibration(null);
    expect(store.k()).toBe(1);
    expect(store.derived().source).toBe('estimate');
  });

  it('clears the tape values and the measured steps separately', () => {
    const store = createFitStore();
    store.recordStep(step('width', 58));
    store.setTape('circumferenceMm', 165);
    store.clearTape();
    expect(store.snapshot().tape).toEqual({ circumferenceMm: null, widthMm: null, thicknessMm: null });
    expect(store.snapshot().steps.width).not.toBeNull();
    store.clearSteps();
    expect(store.snapshot().steps).toEqual({ width: null, thickness: null, passage: null });
  });

  it('ends the session with reset: everything back to its default, the crop request cleared, the segmenter state kept', () => {
    const store = createFitStore();
    store.recordStep(step('width', 58));
    store.setTape('circumferenceMm', 165);
    store.setSide('left');
    store.setCalibration({ k: 0.97, at: '2026-11-29T00:00:00.000Z', spreadPct: 1 });
    store.setClearancePreset('loose');
    store.setSegmenter('ready');
    store.segment.current = { x: 1, y: 2, size: 3, angleDeg: 4 };
    store.reset();
    expect(store.snapshot()).toEqual({ ...initialFitState(), segmenter: 'ready' });
    expect(store.segment.current).toBeNull();
    expect(store.derived().measurement).toBeNull();
  });
});
