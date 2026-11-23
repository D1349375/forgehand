import type { Point } from './types';

/** Distance between the owner's gesture point and the joining hand's cursor, in CSS pixels. */
export function pairSpan(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Angle of the vector from `a` to `b` in degrees. Screen y grows down, so a positive change is clockwise. */
export function pairAngle(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Landmarks of the fist knob: the wrist and the middle-finger knuckle. */
const WRIST = 0;
const MIDDLE_KNUCKLE = 9;

/**
 * The on-screen angle of a hand, in degrees: the vector from the wrist (landmark 0) to the middle-finger knuckle (landmark 9), as
 * `pairAngle` measures it, so a positive change is clockwise on screen. `points` are the client-pixel landmarks of a hand sample,
 * which are in display space (the camera frame is flipped before tracking when the image is mirrored), so the angle is the one the
 * user sees with a mirrored or a plain camera view. Null for fewer than 10 points or a vector of zero length.
 */
export function knobAngle(points: readonly Point[]): number | null {
  const wrist = points[WRIST];
  const knuckle = points[MIDDLE_KNUCKLE];
  if (!wrist || !knuckle) return null;
  if (!(Math.hypot(knuckle.x - wrist.x, knuckle.y - wrist.y) > 1e-6)) return null;
  const angle = pairAngle(wrist, knuckle);
  return Number.isFinite(angle) ? angle : null;
}

/** The change from one angle to another, wrapped to (−180, 180]. */
export function angleDelta(fromDeg: number, toDeg: number): number {
  const wrapped = (((toDeg - fromDeg) % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** `sign(delta) · max(0, |delta| − deadZone)`: leaving the dead zone does not jump. */
export function beyondDeadZone(delta: number, deadZone: number): number {
  return Math.sign(delta) * Math.max(0, Math.abs(delta) - deadZone) || 0;
}
