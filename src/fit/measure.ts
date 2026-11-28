import { robustMedian } from '../../shared/fit';
import {
  AXIS_SEARCH_MM, FOREARM_FLAT_DEG, MASK_EDGE_LEVEL, MEASURE_FRAMES, MEASURE_MIN_KEPT, MEASURE_SPREAD_MM, PALM_FACING_DEG,
  PROFILE_MAX_MM, PROFILE_MIN_MM, PROFILE_STEP_MM, STILL_MM_PER_S, STILL_WINDOW_MS, WIDTH_SAMPLE_STEP_PX,
} from '../../shared/fit-constants';
import { SCALE_BONES, type ArmPose, type HandLandmarks, type Landmark } from '../try-on/arm-pose';
import { sample, type SkinMask } from './mask';

/**
 * The measurement core (body fit, design 5.1 to 5.3): the scale, the width across the forearm, the pose checks and the
 * measure step. Pure: no DOM, no worker. Lengths are millimetres, angles degrees.
 */

// ---------------------------------------------------------------------------
// Scale (design 5.1)

/**
 * Millimetres per frame pixel at the hand: the metric length of the palm bones (world landmarks, x and y only)
 * over their image length in frame pixels, the ratio `screenPalmWidth` forms in `arm-pose.ts`. `frame` is the
 * frame message's width and height. `k` is the card calibration factor (R10); 1 means no calibration.
 * `null` when the hand has no usable world landmarks or the bones project to almost nothing.
 */
export function mmPerPx(hand: HandLandmarks, frame: { width: number; height: number }, k = 1): number | null {
  const world = hand.world;
  if (!world || world.length < 21 || !(frame.width > 0 && frame.height > 0) || !(k > 0)) return null;
  let image = 0;
  let metric = 0;
  for (const [a, b] of SCALE_BONES) {
    const pa = hand.points[a];
    const pb = hand.points[b];
    const wa = world[a];
    const wb = world[b];
    if (!pa || !pb || !wa || !wb) return null;
    image += Math.hypot((pb.x - pa.x) * frame.width, (pb.y - pa.y) * frame.height);
    metric += Math.hypot(wb.x - wa.x, wb.y - wa.y) * 1000;
  }
  if (!(image > 1e-6) || !(metric > 0.1) || !Number.isFinite(image) || !Number.isFinite(metric)) return null;
  return metric / image * k;
}

// ---------------------------------------------------------------------------
// Width across the forearm (design 5.2)

export interface WidthLine {
  /** Millimetres per frame pixel (`mmPerPx`). */
  mmPerPx: number;
  /** Row of the line in mask pixels (continuous); see `offsetRow`. */
  row: number;
  /** Column of the forearm axis in mask pixels. Default: the crop centre, which is where the page puts the axis. */
  axisX?: number;
}
export interface WidthReading {
  widthMm: number;
  widthMaskPx: number;
  /** Sub-pixel edges (mask pixels) where the confidence crosses `MASK_EDGE_LEVEL`. */
  leftMaskPx: number;
  rightMaskPx: number;
}

/** Millimetres per mask pixel for a mask taken at `mmPerPx`. */
export const mmPerMaskPx = (mask: SkinMask, scale: number): number => scale * mask.crop.size / mask.size;

/**
 * The mask row of a line `offsetMm` along the forearm from the crop centre. The crop is turned so that the
 * hand is up, so a positive offset (toward the elbow, R20) is down the mask.
 */
export function offsetRow(mask: SkinMask, offsetMm: number, scale: number): number {
  return mask.size / 2 + offsetMm / mmPerMaskPx(mask, scale);
}

/**
 * The skin run that contains the forearm axis on one row of the mask, with sub-pixel edges (design 5.2).
 * The row is sampled every `WIDTH_SAMPLE_STEP_PX` with linear interpolation, and each edge is the 0.5 crossing
 * between the two samples around it. If the axis itself is off the skin, the nearest skin within `AXIS_SEARCH_MM`
 * is used. `null` when there is no skin there, or the run touches the mask's border (the crop was too small).
 */
export function widthAcross(mask: SkinMask, line: WidthLine): WidthReading | null {
  const { size, skin } = mask;
  const { row } = line;
  if (!(line.mmPerPx > 0) || !(row >= 0 && row <= size) || skin.length < size * size) return null;
  const at = (x: number) => sample(skin, size, x, row);
  const step = WIDTH_SAMPLE_STEP_PX;
  const axis = line.axisX ?? size / 2;
  let start: number | null = null;
  if (at(axis) >= MASK_EDGE_LEVEL) start = axis;
  else {
    const reach = AXIS_SEARCH_MM / mmPerMaskPx(mask, line.mmPerPx);
    for (let offset = step; offset <= reach && start === null; offset += step) {
      const left = at(axis - offset);
      const right = at(axis + offset);
      if (left >= MASK_EDGE_LEVEL || right >= MASK_EDGE_LEVEL) start = left >= right ? axis - offset : axis + offset;
    }
  }
  if (start === null) return null;
  const edge = (direction: -1 | 1): number | null => {
    let inside = start;
    let value = at(inside);
    for (let x = start + direction * step; x >= 0 && x <= size; x += direction * step) {
      const next = at(x);
      if (next < MASK_EDGE_LEVEL) return inside + (x - inside) * ((value - MASK_EDGE_LEVEL) / (value - next));
      inside = x;
      value = next;
    }
    return null;
  };
  const left = edge(-1);
  const right = edge(1);
  if (left === null || right === null || right <= left) return null;
  return { widthMm: (right - left) * mmPerMaskPx(mask, line.mmPerPx), widthMaskPx: right - left, leftMaskPx: left, rightMaskPx: right };
}

// ---------------------------------------------------------------------------
// Pose checks (design 5.3)

const DEG = 180 / Math.PI;

/**
 * The angle (0 to 90 degrees) between the palm's plane normal and the camera axis, from the metric world landmarks:
 * the normal is the cross product of wrist to index knuckle and wrist to little knuckle. 0 means the palm (or the
 * back of the hand) faces the camera, 90 means the palm is edge on. The sign of the normal is not used: the full
 * width of the wrist shows either way, and a handedness label would only add a way to get it wrong.
 * `null` when the landmarks are missing or the three points are in a line.
 */
export function palmFacing(world: readonly Landmark[] | undefined): number | null {
  const wrist = world?.[0];
  const index = world?.[5];
  const little = world?.[17];
  if (!wrist || !index || !little) return null;
  const ax = index.x - wrist.x, ay = index.y - wrist.y, az = index.z - wrist.z;
  const bx = little.x - wrist.x, by = little.y - wrist.y, bz = little.z - wrist.z;
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 1e-9) || !Number.isFinite(length)) return null;
  return Math.acos(Math.min(1, Math.abs(nz) / length)) * DEG;
}

/**
 * The angle (0 to 90 degrees) between the forearm axis and the image plane: 0 when the forearm is parallel to the
 * screen. The axis is the arm pose's local y axis (`orient` in `arm-pose.ts` builds the basis that way); view space
 * looks along -z, so the z component of that axis is its depth.
 */
export function forearmFlat(pose: Pick<ArmPose, 'orientation'>): number {
  const { x, y, z, w } = pose.orientation;
  const depth = 2 * (y * z + w * x);
  return Math.asin(Math.min(1, Math.abs(depth))) * DEG;
}

export interface TimedPoint { x: number; y: number; t: number }

/**
 * The wrist speed in mm/s over the last `windowMs` of `history` (frame pixels and milliseconds, oldest first):
 * the distance between the oldest and the newest point of the window over the time between them. Net
 * displacement and not path length, because landmark jitter would add up along a path and read as motion.
 * `null` while the history covers less than half the window.
 */
export function stillness(history: readonly TimedPoint[], scale: number, windowMs = STILL_WINDOW_MS): number | null {
  const last = history[history.length - 1];
  if (!last || !(scale > 0)) return null;
  const first = history.find(point => point.t >= last.t - windowMs);
  if (!first || last.t - first.t < windowMs / 2) return null;
  return Math.hypot(last.x - first.x, last.y - first.y) * scale / ((last.t - first.t) / 1000);
}

// ---------------------------------------------------------------------------
// The measure step (design 5.3, R21 to R23)

/** Step 1 reads the width, step 2 the thickness (the wrist turned 90 degrees), step 3 the hand's passage width at the knuckles. */
export type StepKind = 'width' | 'thickness' | 'passage';
/** What the user must change; T3 turns each into its text (R22). */
export type WaitReason = 'no-hand' | 'palm' | 'thumb-up' | 'flat' | 'still' | 'no-mask';

/** The offsets along the arm (mm from the band position, toward the elbow) of the profile lines (R20). */
export const PROFILE_OFFSETS: readonly number[] = Array.from(
  { length: Math.round((PROFILE_MAX_MM - PROFILE_MIN_MM) / PROFILE_STEP_MM) + 1 }, (_, i) => PROFILE_MIN_MM + i * PROFILE_STEP_MM);

/** The lines a step reads: the whole profile for width and thickness, one line (the knuckles) for the passage. */
export const stepOffsets = (kind: StepKind): readonly number[] => kind === 'passage' ? [0] : PROFILE_OFFSETS;

export interface StepInput {
  /** `palmFacing` of the hand; `null`: no hand. */
  palmAngleDeg: number | null;
  /** `forearmFlat` of the arm pose; `null`: no arm pose. */
  forearmAngleDeg: number | null;
  /** `stillness`; `null`: not enough history yet, which counts as not still. */
  speedMmPerS: number | null;
  /** One width per `stepOffsets(kind)` entry (mm), `null` where no line could be read. `null`: no mask for this frame. */
  widthsMm: readonly (number | null)[] | null;
}
export interface StepSlice { offsetMm: number; valueMm: number | null; spreadMm: number | null }
export type StepState =
  | { phase: 'idle' }
  | { phase: 'waiting'; reason: WaitReason; accepted: number }
  | { phase: 'recording'; accepted: number }
  | { phase: 'done'; slices: StepSlice[] }
  /** Fewer than MEASURE_MIN_KEPT frames survived the outlier filter, or the width at the band position spread more than MEASURE_SPREAD_MM. The next frame starts again. */
  | { phase: 'unstable'; why: 'few-frames' | 'spread'; spreadMm: number | null };

/** Why a frame cannot be recorded for `kind`, or `null` when it can (R22). The first reason that applies is returned. */
export function stepReason(kind: StepKind, input: StepInput): WaitReason | null {
  if (input.palmAngleDeg === null) return 'no-hand';
  if (kind === 'thickness') {
    if (Math.abs(input.palmAngleDeg - 90) > PALM_FACING_DEG) return 'thumb-up';
  } else if (input.palmAngleDeg > PALM_FACING_DEG) return 'palm';
  if (input.forearmAngleDeg === null || input.forearmAngleDeg > FOREARM_FLAT_DEG) return 'flat';
  if (input.speedMmPerS === null || input.speedMmPerS > STILL_MM_PER_S) return 'still';
  const band = stepOffsets(kind).indexOf(0);
  if (!input.widthsMm || input.widthsMm[band] === null || input.widthsMm[band] === undefined) return 'no-mask';
  return null;
}

/**
 * One measure step as a state machine: `idle` until `start()`, `waiting` while the pose does not hold,
 * `recording` while frames are accepted, then `done` after MEASURE_FRAMES accepted frames or `unstable` (R23).
 * A frame that is not accepted pauses the step and keeps what it has recorded; the median and the spread
 * check at the end decide whether the frames agree.
 */
export class MeasureStep {
  private samples: number[][] = [];
  private current: StepState = { phase: 'idle' };
  constructor(readonly kind: StepKind) {}
  get state(): StepState { return this.current; }
  get offsets(): readonly number[] { return stepOffsets(this.kind); }
  /** Starts (or restarts) the step: forgets every frame. */
  start(): StepState {
    this.samples = this.offsets.map(() => []);
    this.current = { phase: 'waiting', reason: 'no-hand', accepted: 0 };
    return this.current;
  }
  reset(): StepState {
    this.samples = [];
    this.current = { phase: 'idle' };
    return this.current;
  }
  /** Feeds one tracked frame. Ignored while `idle` or `done`. */
  push(input: StepInput): StepState {
    if (this.current.phase === 'idle' || this.current.phase === 'done') return this.current;
    if (this.current.phase === 'unstable') this.start();
    const reason = stepReason(this.kind, input);
    if (reason) {
      this.current = { phase: 'waiting', reason, accepted: this.count() };
      return this.current;
    }
    input.widthsMm!.forEach((width, index) => { if (width !== null && Number.isFinite(width)) this.samples[index]!.push(width); });
    const count = this.count();
    if (count < MEASURE_FRAMES) {
      this.current = { phase: 'recording', accepted: count };
      return this.current;
    }
    this.current = this.finish();
    return this.current;
  }
  /** Accepted frames so far: every accepted frame has a width at the band position, so that column counts them. */
  private count(): number {
    return this.samples[this.offsets.indexOf(0)]?.length ?? 0;
  }
  private finish(): StepState {
    const slices: StepSlice[] = this.offsets.map((offsetMm, index) => {
      const median = robustMedian(this.samples[index]!);
      return median && median.kept >= MEASURE_MIN_KEPT
        ? { offsetMm, valueMm: median.value, spreadMm: median.spread }
        : { offsetMm, valueMm: null, spreadMm: null };
    });
    const band = slices[this.offsets.indexOf(0)]!;
    if (band.valueMm === null) return { phase: 'unstable', why: 'few-frames', spreadMm: null };
    if (band.spreadMm! > MEASURE_SPREAD_MM) return { phase: 'unstable', why: 'spread', spreadMm: band.spreadMm };
    return { phase: 'done', slices };
  }
}
