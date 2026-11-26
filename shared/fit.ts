import type {
  Closure, FitClass, FitSummary, Measured, Placement, ProfileSlice, RingChoice, ScaleSource, WristMeasurement,
} from './body';
import {
  ellipsePerimeter, offsetForPerimeter, polygonPerimeter, rayEllipse, semiAxisForPerimeter,
} from './ellipse';
import {
  CLASS_CHARS, DEFAULT_TAPER, DEFAULT_THICKNESS_RATIO, DEFAULT_WRIST_THICKNESS_MM, DEFAULT_WRIST_WIDTH_MM, FIT_ANGLES,
  LOOSE_MARGIN_MM, MAD_TO_SIGMA, OPEN_GAP_DEG, OUTLIER_MADS, PASSAGE_SHAPE,
} from './fit-constants';
import {
  axisBlocked, innerProfile, profilePartsOf, ringFrame, type InnerProfile, type PartsInput, type RingSetup,
} from './fit-geometry';

/**
 * Fit maths of body fit (design 5.4, 6.2, 6.5, 6.7): the arm section, gaps, classes,
 * the summary, the tape combination and the robust median. Millimetres and degrees.
 * Ring angles `theta` run around the ring axis (`d = cos(theta) z + sin(theta) x`);
 * body angles run around the wrist (0 back of the hand, 90 thumb side).
 */

const rad = (deg: number) => deg * Math.PI / 180;
const round = (value: number, digits: number) => { const f = 10 ** digits; return Math.round(value * f) / f + 0; };
export const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Robust statistics shared with the measurement core (T2)

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Spread of a list of values: the median absolute deviation times 1.4826 (R73). 0 for fewer than two values. */
export function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const centre = median(values);
  return median(values.map(value => Math.abs(value - centre))) * MAD_TO_SIGMA;
}

export interface RobustMedian { value: number; spread: number; kept: number; dropped: number }

/**
 * The median of the values after dropping those further than `OUTLIER_MADS` median
 * absolute deviations from the median (R23), with the spread of the values that stay.
 * `null` for an empty list.
 */
export function robustMedian(values: readonly number[]): RobustMedian | null {
  if (!values.length) return null;
  const centre = median(values);
  const mad = median(values.map(value => Math.abs(value - centre)));
  const kept = values.filter(value => Math.abs(value - centre) <= OUTLIER_MADS * mad);
  return { value: median(kept), spread: spread(kept), kept: kept.length, dropped: values.length - kept.length };
}

// ---------------------------------------------------------------------------
// Body angles

/** Body angle of a ring angle: `sign * (theta + roll)`, with `sign` +1 when the ring's x points to the thumb side. */
export const bodyAngle = (thetaDeg: number, rollDeg: number, sign: 1 | -1): number => norm360(sign * (thetaDeg + rollDeg));

/** Ring angles that land on the body grid `i * 360 / n`: the angles to sample so that `classes[i]` is the body angle `i * 360 / n`. */
export function bodyGridAngles(sign: 1 | -1, rollDeg: number, n = FIT_ANGLES): number[] {
  return Array.from({ length: n }, (_, i) => norm360(sign * (i * 360 / n) - rollDeg));
}

// ---------------------------------------------------------------------------
// Arm profile and section (design 6.2, 6.5)

/** Width and thickness of the arm at a position `s` along it (millimetres from the band position, toward the elbow). */
export interface ArmProfile { widthAt(sMm: number): number; thicknessAt(sMm: number): number }

function interpolated(points: readonly [number, number][]): (s: number) => number {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  return (s: number) => {
    if (s <= sorted[0]![0]) return sorted[0]![1];
    const last = sorted[sorted.length - 1]!;
    if (s >= last[0]) return last[1];
    let i = 1;
    while (sorted[i]![0] < s) i++;
    const [s0, v0] = sorted[i - 1]!, [s1, v1] = sorted[i]!;
    return v0 + (v1 - v0) * (s - s0) / (s1 - s0);
  };
}

/** An arm that widens by `taper` millimetres of width per millimetre toward the elbow, keeping its shape. Taper 0 is a straight arm. */
export function taperedArm(widthMm: number, thicknessMm: number, taper = DEFAULT_TAPER): ArmProfile {
  return {
    widthAt: s => widthMm + taper * s,
    thicknessAt: s => thicknessMm + taper * s * (thicknessMm / widthMm),
  };
}

/** The default arm before any measurement (design 6.5). */
export const defaultArm = (): ArmProfile => taperedArm(DEFAULT_WRIST_WIDTH_MM, DEFAULT_WRIST_THICKNESS_MM);

/**
 * The arm of a measurement: linear between its profile slices and held at the end
 * values beyond them. Without usable slices, the band-position ellipse widened by
 * the default taper.
 */
export function armProfileOf(wrist: Pick<WristMeasurement, 'width' | 'thickness' | 'profile'>): ArmProfile {
  const ratio = wrist.thickness.mm / wrist.width.mm;
  const widths: [number, number][] = [], thicknesses: [number, number][] = [];
  for (const slice of wrist.profile) {
    if (!slice.width) continue;
    widths.push([slice.offsetMm, slice.width.mm]);
    thicknesses.push([slice.offsetMm, slice.thickness ? slice.thickness.mm : slice.width.mm * ratio]);
  }
  if (!widths.length) return taperedArm(wrist.width.mm, wrist.thickness.mm);
  return { widthAt: interpolated(widths), thicknessAt: interpolated(thicknesses) };
}

/**
 * Distance from the ring axis to the arm's surface, per slice and angle (design 6.2).
 * In the ring frame the arm's axis is the ring axis turned by the tilt about x; a slice
 * plane `y` cuts it in an ellipse of semi-axes `w(s) / 2` along x and `t(s) / (2 cos tilt)`
 * along z, centred at `(0, y tan tilt)`, with `s = slide + y / cos tilt`; the roll turns the
 * ellipse by minus the roll about the axis. `null` where the axis lies outside the ellipse.
 * `y` of a slice is toward the elbow.
 */
export function armSection(
  arm: ArmProfile, placement: Placement, sliceMm: readonly number[], anglesDeg: readonly number[],
): (number | null)[][] {
  const tilt = rad(placement.tiltDeg), cos = Math.cos(tilt), tan = Math.tan(tilt);
  return sliceMm.map(y => {
    const s = placement.slideMm + y / cos;
    const a = arm.widthAt(s) / 2, b = arm.thicknessAt(s) / (2 * cos);
    // The plane (z, x): the first axis is z, so `d(theta) = (cos, sin)` and a roll about y turns counter-clockwise.
    return anglesDeg.map(angle => {
      const theta = rad(angle);
      return rayEllipse({ x: Math.cos(theta), y: Math.sin(theta) }, { x: y * tan, y: 0 }, b, a, -rad(placement.rollDeg));
    });
  });
}

// ---------------------------------------------------------------------------
// Clearance, gaps and classes (design 6.2, 6.7)

/** Perimeter of the hand's outline at the knuckles from its passage width (design 6.2). */
export const passagePerimeter = (passageWidthMm: number): number => Math.PI * passageWidthMm * PASSAGE_SHAPE;

export interface EffectiveClearanceInput {
  clearanceMm: number;
  /** An open ring or a clasp: the ring need not pass over the hand. */
  opens: boolean;
  passageWidthMm: number | null;
  wristCircumferenceMm: number;
}

/** `max(clearance, passage perimeter - wrist circumference)` for a closed ring without a clasp, else the clearance (design 6.2). */
export function effectiveClearance(input: EffectiveClearanceInput): number {
  if (input.opens || input.passageWidthMm === null) return input.clearanceMm;
  return Math.max(input.clearanceMm, passagePerimeter(input.passageWidthMm) - input.wristCircumferenceMm);
}

/**
 * The gap per angle: the smallest over the slices of the inner distance minus the arm
 * distance (negative is overlap). `null` where the ring is open on every slice. Where
 * the axis lies outside the arm ellipse the slice counts as pressing: its gap is minus
 * the inner distance.
 */
export function fitGaps(inner: InnerProfile, arm: readonly (readonly (number | null)[])[]): (number | null)[] {
  return inner.anglesDeg.map((_, j) => {
    let gap: number | null = null;
    inner.distanceMm.forEach((row, k) => {
      const distance = row[j]!;
      if (distance === null) return;
      const reach = arm[k]![j]!;
      const value = reach === null ? -distance : distance - reach;
      if (gap === null || value < gap) gap = value;
    });
    return gap;
  });
}

/** 壓迫 below 0, 合適 up to the green range, 偏鬆 above it. Monotone in the gap. */
export function classify(gapMm: number, greenMaxMm: number): FitClass {
  if (gapMm < 0) return 'presses';
  return gapMm <= greenMaxMm ? 'fits' : 'loose';
}

// ---------------------------------------------------------------------------
// Summary

export interface FitSummaryInput {
  /** Must be sampled on the body grid: see `bodyGridAngles`. */
  inner: InnerProfile;
  wrist: WristMeasurement;
  placement: Placement;
  /** The user's choice; an opening in the ring itself makes it open whatever is chosen. */
  closure: Closure;
  clearanceMm: number;
  /** +1 when the ring's x points to the thumb side of the worn arm, else -1. */
  sign: 1 | -1;
  ringPartId: string | null;
}

export interface AngleFit {
  ringDeg: number;
  bodyDeg: number;
  gapMm: number | null;
  /** One of `CLASS_CHARS`. */
  cls: string;
}

export interface FitAnalysis {
  summary: FitSummary;
  /** In ring order, for drawing the ribbon and the dial. */
  angles: AngleFit[];
  /** The radial gap of the effective clearance plus `LOOSE_MARGIN_MM`. */
  greenMaxMm: number;
  /** Closed ring without a clasp that cannot pass over the hand. */
  cannotPass: boolean;
  /** The ring can be opened to put on: an open ring or a clasp. */
  opens: boolean;
}

/** Longest circular run of open samples, as its first index and length, or null when none is open. */
function longestOpenRun(open: readonly boolean[]): { start: number; length: number } | null {
  const n = open.length;
  const origin = open.findIndex(value => !value);
  if (origin < 0) return n ? { start: 0, length: n } : null;
  let best: { start: number; length: number } | null = null;
  // Begin at a closed sample so no run is split by the array's ends.
  for (let i = 0; i < n;) {
    if (!open[(origin + i) % n]) { i++; continue; }
    let length = 0;
    while (i + length < n && open[(origin + i + length) % n]) length++;
    if (!best || length > best.length) best = { start: (origin + i) % n, length };
    i += length;
  }
  return best;
}

/** Perimeter of the inner profile of one slice, or null when any angle is open. */
function slicePerimeter(row: readonly (number | null)[], anglesDeg: readonly number[]): number | null {
  const points: { x: number; y: number }[] = [];
  for (let j = 0; j < row.length; j++) {
    const distance = row[j]!;
    if (distance === null) return null;
    const theta = rad(anglesDeg[j]!);
    points.push({ x: distance * Math.sin(theta), y: distance * Math.cos(theta) });
  }
  return polygonPerimeter(points);
}

const GRID_ERROR = 'The inner profile is not on the body grid; sample it at bodyGridAngles(sign, roll).';

/** All the numbers behind a fit summary, per angle as well. Throws when `inner` is not on the body grid. */
export function analyseFit(input: FitSummaryInput): FitAnalysis {
  const { inner, wrist, placement, sign } = input;
  const n = inner.anglesDeg.length;
  const step = 360 / n;
  const a = wrist.width.mm / 2, b = wrist.thickness.mm / 2;
  const gaps = fitGaps(inner, armSection(armProfileOf(wrist), placement, inner.sliceMm, inner.anglesDeg));

  // Body slot of every ring angle: the body angle divided by the step.
  const bodyDeg = inner.anglesDeg.map(theta => bodyAngle(theta, placement.rollDeg, sign));
  const slot = bodyDeg.map(angle => {
    const exact = angle / step, index = Math.round(exact) % n;
    if (Math.abs(exact - Math.round(exact)) * step > 1e-6) throw new Error(GRID_ERROR);
    return index;
  });
  if (new Set(slot).size !== n) throw new Error(GRID_ERROR);
  const byBody = <T>(values: readonly T[]): T[] => {
    const sorted = new Array<T>(n);
    values.forEach((value, j) => { sorted[slot[j]!] = value; });
    return sorted;
  };
  const gapsByBody = byBody(gaps);
  const open = gapsByBody.map(gap => gap === null);

  const noRing = n === 0 || open.every(Boolean);
  const run = noRing ? null : longestOpenRun(open);
  const isOpenRing = !!run && run.length * step >= OPEN_GAP_DEG;
  const opens = isOpenRing || input.closure !== 'closed';

  const passageWidth = wrist.passage?.mm ?? null;
  const clearance = effectiveClearance({
    clearanceMm: input.clearanceMm, opens, passageWidthMm: passageWidth, wristCircumferenceMm: wrist.circumference.mm,
  });
  const greenMaxMm = offsetForPerimeter(a, b, clearance) + LOOSE_MARGIN_MM;

  let innerMm: number | null = null;
  for (const row of inner.distanceMm) {
    const perimeter = slicePerimeter(row, inner.anglesDeg);
    if (perimeter !== null && (innerMm === null || perimeter < innerMm)) innerMm = perimeter;
  }
  const cannotPass = !noRing && !opens && innerMm !== null && passageWidth !== null && innerMm < passagePerimeter(passageWidth);

  const cls = gaps.map(gap => (gap === null ? CLASS_CHARS.open : CLASS_CHARS[cannotPass ? 'presses' : classify(gap, greenMaxMm)]));
  const angles: AngleFit[] = inner.anglesDeg.map((ringDeg, j) => ({ ringDeg, bodyDeg: bodyDeg[j]!, gapMm: gaps[j]!, cls: cls[j]! }));

  const closed = angles.filter(entry => entry.gapMm !== null);
  const lowest = closed.reduce<AngleFit | null>((best, entry) => (!best || entry.gapMm! < best.gapMm! ? entry : best), null);
  const highest = closed.reduce<AngleFit | null>((best, entry) => (!best || entry.gapMm! > best.gapMm! ? entry : best), null);
  const at = (entry: AngleFit | null) => ({ mm: entry ? round(entry.gapMm!, 2) : 0, angleDeg: entry ? round(entry.bodyDeg, 1) : 0 });

  let state: FitSummary['state'];
  if (noRing) state = 'no-ring';
  else if (cannotPass) state = 'cannot-pass';
  else if (cls.includes('r') && cls.includes('a')) state = 'mixed';
  else if (cls.includes('r')) state = 'presses';
  else if (cls.includes('a')) state = 'loose';
  else state = 'fits';

  const shownInner = noRing || isOpenRing || innerMm === null ? null : round(innerMm, 2);
  const summary: FitSummary = {
    state,
    innerMm: shownInner,
    wrist: wrist.circumference,
    spareMm: shownInner === null ? null : round(shownInner - wrist.circumference.mm, 2),
    clearanceMm: round(clearance, 2),
    minGap: at(lowest),
    maxGap: at(highest),
    classes: byBody(cls).join(''),
    openingDeg: isOpenRing ? round(run!.length * step, 1) : null,
    openingAtDeg: isOpenRing ? round(norm360((run!.start + (run!.length - 1) / 2) * step), 1) : null,
    ringPartId: input.ringPartId,
  };
  return { summary, angles, greenMaxMm, cannotPass, opens };
}

/** The fit summary (design 6.7). */
export const fitSummary = (input: FitSummaryInput): FitSummary => analyseFit(input).summary;

export interface ClassRun {
  /** One of `CLASS_CHARS`. */
  cls: string;
  /** Body angles of the first and last angle of the run, in degrees. */
  fromDeg: number;
  toDeg: number;
  /** Body angle of the middle of the run. */
  midDeg: number;
}

/**
 * Runs of equal classes of a summary's `classes` string, going around the circle (design 6.7).
 * A run that wraps past 0 degrees has `fromDeg > toDeg`. When every angle has the same
 * class the single run starts at 0.
 */
export function classRuns(classes: string): ClassRun[] {
  const n = classes.length;
  if (!n) return [];
  const step = 360 / n;
  const origin = [...classes].findIndex((char, i) => char !== classes[(i + n - 1) % n]);
  if (origin < 0) return [{ cls: classes[0]!, fromDeg: 0, toDeg: round((n - 1) * step, 1), midDeg: round(((n - 1) * step) / 2, 1) }];
  const runs: ClassRun[] = [];
  for (let i = 0; i < n;) {
    const first = (origin + i) % n;
    let length = 1;
    while (i + length < n && classes[(origin + i + length) % n] === classes[first]) length++;
    const last = (first + length - 1) % n;
    runs.push({
      cls: classes[first]!, fromDeg: round(first * step, 1), toDeg: round(last * step, 1),
      midDeg: round(norm360(first * step + ((length - 1) * step) / 2), 1),
    });
    i += length;
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Whole pipeline

export interface EvaluateFitInput {
  parts: PartsInput;
  choice: RingChoice | null;
  wrist: WristMeasurement;
  placement: Placement;
  closure: Closure;
  clearanceMm: number;
  sign: 1 | -1;
}

export interface FitEvaluation {
  analysis: FitAnalysis;
  setup: RingSetup | null;
  inner: InnerProfile | null;
}

/**
 * The ring, its inner profile on the body grid and the fit of an object on a measured wrist:
 * the one function the panel and the server tools both call (R57). With no parts the summary
 * is `no-ring`. `counter` receives the number of inside tests (for the cost test).
 */
export function evaluateFit(input: EvaluateFitInput, counter?: { insideTests: number }): FitEvaluation {
  const setup = ringFrame(input.parts, input.choice);
  const anglesDeg = bodyGridAngles(input.sign, input.placement.rollDeg);
  const common = {
    wrist: input.wrist, placement: input.placement, closure: input.closure, clearanceMm: input.clearanceMm, sign: input.sign,
  };
  if (!setup) {
    const inner: InnerProfile = { anglesDeg, sliceMm: [0], distanceMm: [anglesDeg.map(() => null)], halfWidthMm: 0 };
    return { analysis: analyseFit({ ...common, inner, ringPartId: null }), setup: null, inner: null };
  }
  const inner = innerProfile(profilePartsOf(input.parts), setup.frame, setup.halfWidthMm, { anglesDeg, ...(counter ? { counter } : {}) });
  // With no ring part, an axis inside a part means that nothing surrounds the axis: the object has no ring.
  const surrounds = setup.source === 'part' || !axisBlocked(inner);
  const seen: InnerProfile = surrounds ? inner : { ...inner, distanceMm: inner.distanceMm.map(row => row.map(() => null)) };
  return { analysis: analyseFit({ ...common, inner: seen, ringPartId: setup.ringPartId }), setup, inner };
}

// ---------------------------------------------------------------------------
// Camera, card and tape (design 5.4)

export interface WristEllipseInput {
  /** The camera's width and thickness at the band position (source estimate or card), or null before a measurement. */
  camera: { width: Measured; thickness: Measured } | null;
  /** The tape circumference, 100 to 300 mm (R25), or null. */
  tapeCircumferenceMm: number | null;
  /** Typed width and thickness, 30 to 120 mm (R25), or null. */
  typedWidthMm: number | null;
  typedThicknessMm: number | null;
}

export interface WristEllipse {
  width: Measured;
  thickness: Measured;
  circumference: Measured;
  /** Thickness is `DEFAULT_THICKNESS_RATIO` times width (R26). */
  thicknessAssumed: boolean;
  /** Factor for the camera profile slices so that they keep their taper at the new size; 1 when nothing was rescaled. */
  profileScale: number;
  /** Perimeter of the camera's own ellipse, for the error line of R27; null without a camera. */
  cameraCircumferenceMm: number | null;
}

const tapeValue = (mm: number): Measured => ({ mm, source: 'tape', spreadMm: null });

/** Spread of the perimeter from the spreads of width and thickness, by the partial derivatives of the perimeter. */
function perimeterSpread(widthMm: number, thicknessMm: number, widthSpread: number | null, thicknessSpread: number | null): number | null {
  if (widthSpread === null || thicknessSpread === null) return null;
  const a = widthMm / 2, b = thicknessMm / 2, h = 0.01;
  const da = (ellipsePerimeter(a + h, b) - ellipsePerimeter(a - h, b)) / (2 * h);
  const db = (ellipsePerimeter(a, b + h) - ellipsePerimeter(a, b - h)) / (2 * h);
  return Math.hypot(da * widthSpread / 2, db * thicknessSpread / 2);
}

/**
 * Combines the camera, a tape circumference and typed values into one wrist ellipse (design 5.4):
 *
 * - camera only: its width and thickness, source estimate or card;
 * - tape circumference with the camera: the camera's shape `t / w` scaled until the perimeter is the tape value;
 * - tape circumference alone: `t = DEFAULT_THICKNESS_RATIO * w`, thickness assumed;
 * - typed width and thickness: they replace the camera values, source tape. A single typed value replaces its
 *   counterpart and the other axis comes from the tape circumference, else from the camera, else from the ratio.
 *
 * Returns `null` when there is nothing to compute from, or when a typed size and the tape circumference
 * cannot belong to one ellipse (the circumference is below the flat ellipse of that size).
 */
export function wristEllipse(input: WristEllipseInput): WristEllipse | null {
  const { camera, tapeCircumferenceMm: tape, typedWidthMm: typedW, typedThicknessMm: typedT } = input;
  const cameraW = camera?.width.mm ?? null, cameraT = camera?.thickness.mm ?? null;
  const cameraCircumferenceMm = cameraW !== null && cameraT !== null ? ellipsePerimeter(cameraW / 2, cameraT / 2) : null;
  const make = (w: Measured, t: Measured, c: Measured, assumed: boolean): WristEllipse => ({
    width: w, thickness: t, circumference: c, thicknessAssumed: assumed,
    profileScale: cameraW !== null && w.mm !== cameraW ? w.mm / cameraW : 1, cameraCircumferenceMm,
  });
  const fromTape = (w: number, t: number, assumed: boolean) => make(tapeValue(w), tapeValue(t), tapeValue(ellipsePerimeter(w / 2, t / 2)), assumed);

  if (typedW !== null && typedT !== null) return fromTape(typedW, typedT, false);
  if (tape !== null) {
    if (typedW !== null || typedT !== null) {
      const known = (typedW ?? typedT)!;
      const other = semiAxisForPerimeter(known / 2, tape);
      if (other === null) return null;
      return typedW !== null ? fromTape(typedW, other * 2, false) : fromTape(other * 2, typedT!, false);
    }
    const ratio = cameraW !== null && cameraT !== null ? cameraT / cameraW : DEFAULT_THICKNESS_RATIO;
    const width = tape / ellipsePerimeter(0.5, ratio / 2);
    const result = fromTape(width, width * ratio, camera === null);
    return { ...result, circumference: tapeValue(tape) };
  }
  if (typedW !== null || typedT !== null) {
    const w = typedW ?? cameraW ?? typedT! / DEFAULT_THICKNESS_RATIO;
    const t = typedT ?? cameraT ?? w * DEFAULT_THICKNESS_RATIO;
    return fromTape(w, t, typedT === null && cameraT === null || typedW === null && cameraW === null);
  }
  if (!camera) return null;
  const source: ScaleSource = camera.width.source;
  return make(camera.width, camera.thickness, {
    mm: cameraCircumferenceMm!, source, spreadMm: perimeterSpread(camera.width.mm, camera.thickness.mm, camera.width.spreadMm, camera.thickness.spreadMm),
  }, false);
}

/**
 * The profile slices scaled by `factor` (widths, thicknesses and their spreads), for the case
 * where a tape value rescales the ellipse and the camera's taper is kept at the tape's size.
 * The scaled values have source `source`.
 */
export function scaleProfile(profile: readonly ProfileSlice[], factor: number, source: ScaleSource = 'tape'): ProfileSlice[] {
  const scale = (value: Measured | null): Measured | null => (value ? {
    mm: value.mm * factor, source, spreadMm: value.spreadMm === null ? null : value.spreadMm * factor,
  } : null);
  return profile.map(slice => ({ offsetMm: slice.offsetMm, width: scale(slice.width), thickness: scale(slice.thickness) }));
}
