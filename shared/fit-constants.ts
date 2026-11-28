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
/** With a median absolute deviation of 0 the robust median keeps values this close to the median (same unit as the values; millimetres for widths, about one mask pixel). */
export const MAD_ZERO_TOLERANCE = 0.5;
/** Turns a median absolute deviation into a standard-deviation estimate for normal data (R73). */
export const MAD_TO_SIGMA = 1.4826;
/** Class colours, the Okabe-Ito palette (R51). */
export const CLASS_COLORS = { fits: '#009E73', presses: '#D55E00', loose: '#E69F00' } as const;
/** One character per angle in `FitSummary.classes`. */
export const CLASS_CHARS = { fits: 'g', presses: 'r', loose: 'a', open: '-' } as const;
/** `tubeRatio` limits of `PartSchema` (shared/model.ts), repeated here for the resize range check. */
export const TUBE_RATIO_MIN = 0.05;
export const TUBE_RATIO_MAX = 0.95;
// ---------------------------------------------------------------------------
// Task 2: the wrist segmenter and the measurement core (design 4, 5)
/** Side of the square crop the segmenter sees, in mask pixels (design 4.2): the multiclass selfie model takes 256 x 256. */
export const SEGMENT_SIZE = 256;
/** Side of the wrist crop in millimetres at the current scale: one mask pixel is then about 0.63 mm (design 4.2). */
export const CROP_SIDE_MM = 160;
/** Normal time between two segmenter runs while fitting: about 3 Hz (R109). */
export const SEGMENT_INTERVAL_MS = 333;
/** The interval never grows past this when the tracking rate is low (R109). */
export const SEGMENT_MAX_INTERVAL_MS = 1000;
/** On the CPU delegate the segmenter runs at most once a second (R109). */
export const SEGMENT_CPU_INTERVAL_MS = 1000;
/** A measure step asks for a mask on every frame for at most this long (R109). */
export const MEASURE_BURST_MS = 3000;
/** Below this tracking rate for SPEED_HOLD_MS (src/hands/constants.ts) the segmenter interval doubles (R109). */
export const FIT_MIN_FPS = 6;
/** Above this tracking rate for FIT_RECOVER_MS the interval halves again (design 4.3). */
export const FIT_RECOVER_FPS = 7;
export const FIT_RECOVER_MS = 5000;
/** Accepted frames that complete a measure step (R23). */
export const MEASURE_FRAMES = 7;
/** A step needs at least this many frames left after the outlier filter (R23). */
export const MEASURE_MIN_KEPT = 5;
/** A step is unstable when the spread of the width at the band position is above this (R23). */
export const MEASURE_SPREAD_MM = 3;
/** The palm normal must be within this angle of the camera axis (steps 1 and 3), or of perpendicular to it (step 2) (R22). */
export const PALM_FACING_DEG = 25;
/** The forearm axis must be within this angle of the image plane (R22). */
export const FOREARM_FLAT_DEG = 30;
/** The wrist must move slower than this for a frame to count (R22). */
export const STILL_MM_PER_S = 15;
/** Window of the wrist speed (design 5.3). */
export const STILL_WINDOW_MS = 300;
/** How far from the forearm axis the width line may look for skin when the axis itself is off the skin (design 5.2). */
export const AXIS_SEARCH_MM = 10;
/** Class indices of the multiclass selfie segmenter: 0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others (requirements decision 2). */
export const SKIN_CLASS = 2;
export const CLOTHES_CLASS = 4;
/** A mask pixel counts as skin at or above this confidence (design 5.2). */
export const MASK_EDGE_LEVEL = 0.5;
/** Side of the downscaled crop whose mean is the luma (design 4.2). */
export const LUMA_SIZE = 16;
/** Step of the width line across the mask, in mask pixels (design 5.2). */
export const WIDTH_SAMPLE_STEP_PX = 0.25;
// ---------------------------------------------------------------------------
// Task 3: card calibration (design 6.3)
/** An ID-1 card (ISO/IEC 7810): 85.60 x 53.98 mm (R7). */
export const CARD_LONG_MM = 85.6;
export const CARD_SHORT_MM = 53.98;
/** The hand must be still this long, with the card inside the guide, before the frame freezes (R12). */
export const CARD_STILL_MS = 1000;
/** A correction factor outside this range is rejected (R16). */
export const CARD_K_MIN = 0.75;
export const CARD_K_MAX = 1.33;
/** The measured aspect ratio may differ from the card's by this fraction (R16). */
export const CARD_ASPECT_TOLERANCE = 0.06;
/** An edge whose gradient peak is below this many times the median gradient falls back to the guide line (design 6.3). */
export const CARD_EDGE_CONFIDENCE = 2.5;
/** Each edge is searched within this fraction of the card's side around the guide line (design 6.3). */
export const CARD_SEARCH_FRACTION = 0.25;
/** Horizontal field of view assumed for a laptop webcam, for the depth correction (design 6.3). Assumption. */
export const ASSUMED_HFOV_DEG = 65;
/** Wrist thickness assumed by the depth correction before a thickness measurement (design 6.3). Assumption. */
export const CARD_DEFAULT_THICKNESS_MM = 40;
