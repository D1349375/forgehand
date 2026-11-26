/**
 * Constants of the body-fit maths (body-fit requirements and design 6).
 * Lengths are millimetres, angles are degrees. Each comment says where the
 * number comes from, or that it is an assumption that still has to be checked.
 */

/** Directions around the ring axis: 72 steps of 5 degrees (R48). */
export const FIT_ANGLES = 72;
/** Slices across the band width: both edges and the middle (R48). */
export const FIT_SLICES = 3;
/** Extra millimetres above the clearance's radial gap that still count as 合適 (R51). */
export const LOOSE_MARGIN_MM = 2;
/**
 * Clearance presets in millimetres of circumference over the wrist (R55, decision 10).
 * Assumption: about a quarter, a half and one inch, from common bracelet sizing advice; not checked against a standard.
 */
export const CLEARANCE_PRESETS_MM = { snug: 6, comfort: 13, loose: 25 } as const;
/** Custom clearance range in millimetres of circumference (R55). */
export const CLEARANCE_CUSTOM_MIN_MM = 0;
export const CLEARANCE_CUSTOM_MAX_MM = 40;
/** The default clearance preset (R55). */
export const DEFAULT_CLEARANCE_PRESET = 'comfort' as const;
/** Smallest and largest mean inner diameter of a part that counts as a ring (R29). */
export const RING_MIN_MM = 35;
export const RING_MAX_MM = 130;
/** An opening of at least this many degrees makes an open ring (R47). */
export const OPEN_GAP_DEG = 15;
/** Wrist thickness over width when only the circumference is known (R26; VISION 4.11 gives 0.6 to 0.7). */
export const DEFAULT_THICKNESS_RATIO = 0.65;
/** Distance of the band centre from the wrist landmark toward the elbow (R30). */
export const DEFAULT_BAND_OFFSET_MM = 20;
/** Measured profile along the arm, from the band position, toward the hand (negative) and the elbow (R20). */
export const PROFILE_MIN_MM = -20;
export const PROFILE_MAX_MM = 60;
export const PROFILE_STEP_MM = 5;
/** How far from the ring axis the inner profile searches for a solid point (design 6.4). */
export const PROFILE_REACH_MM = 90;
/** March step of the inner profile search (design 6.4). */
export const PROFILE_MARCH_STEP_MM = 1;
/** Halvings of the last march step: 1 / 2^6 mm (design 6.4). */
export const PROFILE_BISECT_STEPS = 6;
/** Distance of the two edge slices from the band edge (design 6.4). */
export const PROFILE_EDGE_INSET_MM = 0.5;
/** Band half-width used when the ring axis comes from the object's box and not from a ring part (design 6.4). */
export const FALLBACK_HALF_WIDTH_MM = 10;
/** Shorter than this, the bulk of the other parts gives no face direction (design 6.4). */
export const FACE_MIN_MM = 2;
/** The hand's passage perimeter over passage width: the compressed hand is flatter than a circle (design 6.2). Assumption. */
export const PASSAGE_SHAPE = 0.95;
/** Parts closer than this to the ring's outer box count as attached to it (design 6.6). */
export const ATTACH_GAP_MM = 1;
/** Resize keeps an ellipse mapping only within this angle of a ring axis; otherwise the inner ring becomes a circle (design 6.6). */
export const RESIZE_AXIS_TOLERANCE_DEG = 10;
/** Millimetres of arm width gained per millimetre toward the elbow, before any measurement (design 6.5). Assumption: an average adult forearm. */
export const DEFAULT_TAPER = 0.12;
/** Default wrist width and thickness at the band position, before any measurement (design 6.5). Assumption: an average adult wrist. */
export const DEFAULT_WRIST_WIDTH_MM = 60;
export const DEFAULT_WRIST_THICKNESS_MM = 40;
/** Placement ranges (R35). */
export const SLIDE_MIN_MM = -40;
export const SLIDE_MAX_MM = 60;
export const TILT_MIN_DEG = -30;
export const TILT_MAX_DEG = 30;
export const ROLL_MIN_DEG = -180;
export const ROLL_MAX_DEG = 180;
/** Tape input ranges (R25). */
export const TAPE_CIRCUMFERENCE_MIN_MM = 100;
export const TAPE_CIRCUMFERENCE_MAX_MM = 300;
export const TAPE_SIZE_MIN_MM = 30;
export const TAPE_SIZE_MAX_MM = 120;
/** The robust median drops values further than this many median absolute deviations from the median (R23). */
export const OUTLIER_MADS = 3;
/** Turns a median absolute deviation into a standard-deviation estimate for normal data (R73). */
export const MAD_TO_SIGMA = 1.4826;
/** Class colours, the Okabe-Ito palette (R51). */
export const CLASS_COLORS = { fits: '#009E73', presses: '#D55E00', loose: '#E69F00' } as const;
/** One character per angle in `FitSummary.classes`. */
export const CLASS_CHARS = { fits: 'g', presses: 'r', loose: 'a', open: '-' } as const;
/** `tubeRatio` limits of `PartSchema` (shared/model.ts), repeated here for the resize range check. */
export const TUBE_RATIO_MIN = 0.05;
export const TUBE_RATIO_MAX = 0.95;
