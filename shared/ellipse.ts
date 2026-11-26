/**
 * Ellipse maths for the wrist section and the ring (body-fit design 6.1).
 * Pure functions; lengths are in whatever unit the caller uses (the fit uses
 * millimetres). No imports, so it runs anywhere.
 */

export interface Vec2 { x: number; y: number }

/** Distance from the centre to the boundary of an ellipse with semi-axes `a` and `b`, at angle `phi` (radians) from the `a` axis. */
export function ellipseRadius(a: number, b: number, phi: number): number {
  const c = b * Math.cos(phi), s = a * Math.sin(phi);
  return (a * b) / Math.sqrt(c * c + s * s);
}

/** Perimeter by Ramanujan's second approximation. Exact for a circle, tiny error for wrist-like ratios. */
export function ellipsePerimeter(a: number, b: number): number {
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/** Length of a closed polygon: the sum of the segments, the last point joined back to the first. */
export function polygonPerimeter(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, q = points[(i + 1) % points.length]!;
    total += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return total;
}

/**
 * Distance from the origin along the unit direction `dir` to the boundary of an
 * ellipse, or `null` when the origin is outside the ellipse. The ellipse has its
 * `a` semi-axis along the direction `rotation` radians counter-clockwise from the
 * first axis, `b` perpendicular to it, and its centre at `centre`.
 */
export function rayEllipse(dir: Vec2, centre: Vec2, a: number, b: number, rotation: number): number | null {
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  // Into the ellipse's own axes: rotate by -rotation.
  const d1 = cos * dir.x + sin * dir.y, d2 = -sin * dir.x + cos * dir.y;
  const c1 = cos * centre.x + sin * centre.y, c2 = -sin * centre.x + cos * centre.y;
  const qa = (d1 * d1) / (a * a) + (d2 * d2) / (b * b);
  const qb = (d1 * c1) / (a * a) + (d2 * c2) / (b * b);
  const qc = (c1 * c1) / (a * a) + (c2 * c2) / (b * b) - 1;
  if (qc > 0) return null;
  // qa t^2 - 2 qb t + qc = 0 with qc <= 0: exactly one non-negative root.
  return (qb + Math.sqrt(qb * qb - qa * qc)) / qa;
}

const BISECTIONS = 80;

/**
 * The uniform outward offset `g` for which `P(a + g, b + g) = P(a, b) + extra`.
 * `P` grows strictly with `g`, so the root is unique; it is searched on
 * `[-min(a, b) / 2, 60]` and an `extra` outside that range gives the nearest end.
 * `g` is close to `extra / 2 pi` (13 mm of perimeter is about 2.07 mm).
 */
export function offsetForPerimeter(a: number, b: number, extra: number): number {
  const target = ellipsePerimeter(a, b) + extra;
  let lo = -Math.min(a, b) / 2, hi = 60;
  if (ellipsePerimeter(a + lo, b + lo) >= target) return lo;
  if (ellipsePerimeter(a + hi, b + hi) <= target) return hi;
  for (let i = 0; i < BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    if (ellipsePerimeter(a + mid, b + mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The semi-axis `b` for which an ellipse with semi-axis `a` has the given perimeter,
 * or `null` when the perimeter is below that of the flat ellipse (`4a`).
 */
export function semiAxisForPerimeter(a: number, perimeter: number): number | null {
  if (!(a > 0) || !(perimeter > 4 * a)) return null;
  let lo = 0, hi = perimeter / Math.PI;
  for (let i = 0; i < BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    if (ellipsePerimeter(a, mid) < perimeter) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
