import { z } from 'zod';
import { PartIdSchema } from './model';
import {
  FIT_ANGLES, ROLL_MAX_DEG, ROLL_MIN_DEG, SLIDE_MAX_MM, SLIDE_MIN_MM, TILT_MAX_DEG, TILT_MIN_DEG,
} from './fit-constants';

/**
 * Data shapes of body fit (design 3). Lengths in millimetres, angles in degrees.
 * Angles in a `FitSummary` are body angles: 0 back of the hand, 90 thumb side,
 * 180 palm side, 270 little-finger side, for either arm.
 */

export const ScaleSourceSchema = z.enum(['estimate', 'card', 'tape']);
/** A value with where it came from and, for camera values, its spread (R8, R73). */
export const MeasuredSchema = z.strictObject({
  mm: z.number().min(0).max(1000),
  source: ScaleSourceSchema,
  spreadMm: z.number().min(0).max(1000).nullable(),
});

export const ProfileSliceSchema = z.strictObject({
  offsetMm: z.number().min(-200).max(200),
  width: MeasuredSchema.nullable(),
  thickness: MeasuredSchema.nullable(),
});

export const WristMeasurementSchema = z.strictObject({
  side: z.enum(['left', 'right']),
  /** At the band's default position (offset 0). */
  width: MeasuredSchema,
  thickness: MeasuredSchema,
  /** Ellipse perimeter, or the tape value. */
  circumference: MeasuredSchema,
  /** `PROFILE_MIN_MM` to `PROFILE_MAX_MM` in steps of `PROFILE_STEP_MM`. */
  profile: z.array(ProfileSliceSchema).max(64),
  /** Hand passage width at the knuckles (step 3), or typed. */
  passage: MeasuredSchema.nullable(),
  /** Thickness is `DEFAULT_THICKNESS_RATIO` times width (R26). */
  thicknessAssumed: z.boolean(),
  /** Kept for the error line of R27. */
  cameraCircumferenceMm: z.number().min(0).max(1000).nullable(),
});

/** R15. */
export const CalibrationSchema = z.strictObject({
  k: z.number().positive().max(10),
  at: z.iso.datetime(),
  spreadPct: z.number().min(0).max(100),
});

export const ClosureSchema = z.enum(['closed', 'open', 'clasp']);

/** R35: ranges are enforced by the schema. */
export const PlacementSchema = z.strictObject({
  slideMm: z.number().min(SLIDE_MIN_MM).max(SLIDE_MAX_MM),
  tiltDeg: z.number().min(TILT_MIN_DEG).max(TILT_MAX_DEG),
  rollDeg: z.number().min(ROLL_MIN_DEG).max(ROLL_MAX_DEG),
});

export const RingChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('part'), partId: PartIdSchema }),
  z.strictObject({ kind: z.literal('axis'), axis: z.enum(['x', 'y', 'z']) }),
]);

export const FitClassSchema = z.enum(['fits', 'presses', 'loose']);

const GapAtSchema = z.strictObject({ mm: z.number().min(-1000).max(1000), angleDeg: z.number().min(0).max(360) });

export const FitSummarySchema = z.strictObject({
  state: z.enum(['fits', 'presses', 'loose', 'mixed', 'cannot-pass', 'open', 'no-ring']),
  /** Inner perimeter at the narrowest slice; null for an open ring or no ring. */
  innerMm: z.number().min(0).max(5000).nullable(),
  /** The circumference used. */
  wrist: MeasuredSchema,
  /** `innerMm` minus `wrist.mm`. */
  spareMm: z.number().min(-5000).max(5000).nullable(),
  /** Effective clearance (design 6.2). */
  clearanceMm: z.number().min(0).max(1000),
  minGap: GapAtSchema,
  maxGap: GapAtSchema,
  /** One character per angle in body-angle order: `g` fits, `r` presses, `a` loose, `-` open. */
  classes: z.string().regex(/^[gra-]*$/).max(FIT_ANGLES),
  openingDeg: z.number().min(0).max(360).nullable(),
  openingAtDeg: z.number().min(0).max(360).nullable(),
  ringPartId: PartIdSchema.nullable(),
});

export const ClearanceChoiceSchema = z.strictObject({
  preset: z.enum(['snug', 'comfort', 'loose', 'custom']),
  mm: z.number().min(0).max(40),
});

/** What the browser sends in the agent request while fitting (R65). Never images, masks or landmarks. */
export const BodySnapshotSchema = z.strictObject({
  anchor: z.literal('wrist'),
  objectId: z.string().min(1).max(100),
  wrist: WristMeasurementSchema.nullable(),
  calibration: CalibrationSchema.nullable(),
  placement: PlacementSchema,
  closure: ClosureSchema,
  ring: RingChoiceSchema.nullable(),
  clearance: ClearanceChoiceSchema,
  fit: FitSummarySchema.nullable(),
});

export type ScaleSource = z.infer<typeof ScaleSourceSchema>;
export type Measured = z.infer<typeof MeasuredSchema>;
export type ProfileSlice = z.infer<typeof ProfileSliceSchema>;
export type WristMeasurement = z.infer<typeof WristMeasurementSchema>;
export type Calibration = z.infer<typeof CalibrationSchema>;
export type Closure = z.infer<typeof ClosureSchema>;
export type Placement = z.infer<typeof PlacementSchema>;
export type RingChoice = z.infer<typeof RingChoiceSchema>;
export type FitClass = z.infer<typeof FitClassSchema>;
export type FitSummary = z.infer<typeof FitSummarySchema>;
export type ClearanceChoice = z.infer<typeof ClearanceChoiceSchema>;
export type BodySnapshot = z.infer<typeof BodySnapshotSchema>;

/** Placement with every value at its default: no slide, no tilt, no roll (R30). */
export const DEFAULT_PLACEMENT: Placement = { slideMm: 0, tiltDeg: 0, rollDeg: 0 };
