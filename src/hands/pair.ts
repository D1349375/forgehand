import type { Point } from './types';

/** Distance between the owner's gesture point and the joining hand's cursor, in CSS pixels. */
export function pairSpan(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Angle of the vector from `a` to `b` in degrees. Screen y grows down, so a positive change is clockwise. */
export function pairAngle(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
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
