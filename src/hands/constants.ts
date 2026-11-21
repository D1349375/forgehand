/**
 * Every tuning constant of hand control lives here, so tuning on a real webcam
 * touches one file. The P1 tasks add their own constants (zoom, fist, explode, rotate).
 */

/** Which hand point drives the cursor: the midpoint of thumb tip and index tip (landmarks 4 and 8), or the index knuckle (landmark 5). */
export type CursorPoint = 'pinch-midpoint' | 'index-knuckle';
export const CURSOR_POINT: CursorPoint = 'pinch-midpoint';

/** One Euro filter of the cursor (Hz, per px/s, Hz). */
export const CURSOR_MIN_CUTOFF = 1.0;
export const CURSOR_BETA = 0.01;
export const CURSOR_D_CUTOFF = 1.0;

/** A pinch engages below this thumb-index distance (m) for this many consecutive tracking frames. */
export const PINCH_ENGAGE_M = 0.03;
export const PINCH_ENGAGE_FRAMES = 2;
/** A pinch releases above this distance (m) for this many consecutive tracking frames. */
export const PINCH_RELEASE_M = 0.05;
export const PINCH_RELEASE_FRAMES = 3;

/** A new raw target must hold this long before it becomes the settled target. */
export const HOVER_SETTLE_MS = 150;
/** The overlay hides, and the cursor filter and an idle pinch reset, after this long without a hand. */
export const HAND_LOST_MS = 300;

/** A pinch that stays within this many pixels of where it engaged is a tap, not a drag. */
export const DRAG_DEAD_ZONE_PX = 8;
/** Part movement per cursor movement; 1 keeps the grabbed point under the cursor. */
export const DRAG_GAIN = 1.5;
/** Degrees of orbit per cursor pixel when a pinch on empty space turns the view. */
export const ORBIT_DEG_PER_PX = 0.4;

/** An engaged pinch survives a tracking loss shorter than this. */
export const TRACKING_LOSS_MS = 300;
/** What a longer loss does to a running drag: put the part back, or commit where it is. */
export type TrackingLossPolicy = 'cancel' | 'keep';
export const ON_TRACKING_LOSS: TrackingLossPolicy = 'cancel';

/** Below this tracking rate (frames per second) for SPEED_HOLD_MS, hand control locks. */
export const MIN_CONTROL_FPS = 10;
export const SPEED_HOLD_MS = 2000;

/** How long the "cancelled" notice stays in the status line. */
export const CANCEL_NOTICE_MS = 4000;
/** Longest part name shown in the badge. */
export const BADGE_NAME_MAX = 12;
/** Hands the worker tracks per frame. 1 restores the one-hand tracking cost; two-hand gestures then never start. */
export const TRACKED_HANDS = 2;
/** Two detections whose palm centres are closer than this many pixels are one hand. */
export const DUPLICATE_HAND_PX = 40;
/** A hand that moved farther than this many pixels from a tracked slot is a new hand. */
export const HAND_MATCH_PX = 160;
/** A two-hand gesture reads the angle between the hands only while they are at least this far apart (pixels). */
export const TWO_HAND_MIN_SPAN_PX = 60;
/** Two-hand zoom ignores a change in the distance between the cursors smaller than this (pixels), so hand tremor does not zoom. */
export const ZOOM_DEAD_ZONE_PX = 12;
