import { afterAll, describe, expect, it } from 'vitest';
import {
  ellipsePerimeter, ellipseRadius, offsetForPerimeter, polygonPerimeter, rayEllipse, semiAxisForPerimeter,
} from '../../shared/ellipse';
import { checkProperty, fc, printPropertyReport } from '../fixtures/fit-property';

afterAll(() => printPropertyReport('fit-ellipse'));

/** Semi-axes of a wrist-sized ellipse, millimetres (design 6.8: 10 to 80). */
const semi = fc.double({ min: 10, max: 80, noNaN: true });

/** A polygon of n points of the ellipse at equal steps of the parameter. */
const sampled = (a: number, b: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ x: a * Math.cos(2 * Math.PI * i / n), y: b * Math.sin(2 * Math.PI * i / n) }));

describe('ellipse perimeter (design 6.1)', () => {
  it('is 2 pi a for a circle and 4a-ish for a flat ellipse', () => {
    expect(ellipsePerimeter(30, 30)).toBeCloseTo(2 * Math.PI * 30, 9);
    expect(ellipsePerimeter(30, 0)).toBeCloseTo(4 * 30, 0);
  });

  it('matches a 20 000 segment polygon to 1e-4 for b / a of at least 0.3', () => {
    for (const [a, b] of [[30, 20], [40, 12], [60, 18], [30, 30], [80, 24]] as const) {
      const exact = polygonPerimeter(sampled(a, b, 20_000));
      expect(Math.abs(ellipsePerimeter(a, b) - exact) / exact).toBeLessThan(1e-4);
    }
  });

  it('lies between pi (a + b) and pi sqrt(2 (a^2 + b^2)), equals 2 pi a for a circle, and is symmetric', () => {
    checkProperty('perimeter bounds, circle and symmetry', fc.property(semi, semi, (a, b) => {
      const p = ellipsePerimeter(a, b);
      return p >= Math.PI * (a + b) - 1e-9 && p <= Math.PI * Math.sqrt(2 * (a * a + b * b)) + 1e-9
        && Math.abs(ellipsePerimeter(a, a) - 2 * Math.PI * a) < 1e-9 && Math.abs(p - ellipsePerimeter(b, a)) < 1e-9;
    }), 500);
  });

  it('grows with either semi-axis', () => {
    checkProperty('perimeter increases with a and with b', fc.property(semi, semi, fc.double({ min: 0.01, max: 20, noNaN: true }), (a, b, step) =>
      ellipsePerimeter(a + step, b) > ellipsePerimeter(a, b) && ellipsePerimeter(a, b + step) > ellipsePerimeter(a, b)), 500);
  });

  it('is within 0.05 % of a polygon of at least 360 sampled points', () => {
    // The generator is the one of design 6.8: any a and b in 10 to 80 mm, so b / a goes down to 0.125.
    checkProperty('360+ point polygon within 0.05 % of the perimeter', fc.property(semi, semi, fc.integer({ min: 360, max: 2000 }), (a, b, n) => {
      const exact = ellipsePerimeter(a, b);
      return Math.abs(polygonPerimeter(sampled(a, b, n)) - exact) / exact <= 5e-4;
    }), 300);
  });

  it('converges to the perimeter as the polygon gets finer', () => {
    const exact = ellipsePerimeter(32, 21);
    const errors = [90, 360, 1440, 5760].map(n => Math.abs(polygonPerimeter(sampled(32, 21, n)) - exact));
    for (let i = 1; i < errors.length; i++) expect(errors[i]!).toBeLessThan(errors[i - 1]!);
  });
});

describe('polygonPerimeter', () => {
  it('sums the segments of a closed polygon', () => {
    expect(polygonPerimeter([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }])).toBeCloseTo(12, 12);
    expect(polygonPerimeter([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }])).toBe(8);
  });
});

describe('ellipse radius', () => {
  it('is a at 0, b at a quarter turn and a circle radius for a circle', () => {
    expect(ellipseRadius(30, 20, 0)).toBeCloseTo(30, 12);
    expect(ellipseRadius(30, 20, Math.PI / 2)).toBeCloseTo(20, 12);
    expect(ellipseRadius(25, 25, 1.234)).toBeCloseTo(25, 12);
  });

  it('stays between the semi-axes and repeats after a half turn', () => {
    checkProperty('r(phi) in [min, max] and r(phi) = r(phi + pi)', fc.property(semi, semi, fc.double({ min: -10, max: 10, noNaN: true }), (a, b, phi) => {
      const r = ellipseRadius(a, b, phi);
      return r >= Math.min(a, b) - 1e-9 && r <= Math.max(a, b) + 1e-9 && Math.abs(r - ellipseRadius(a, b, phi + Math.PI)) < 1e-9;
    }), 500);
  });
});

describe('rayEllipse', () => {
  const unit = (angle: number) => ({ x: Math.cos(angle), y: Math.sin(angle) });

  it('equals the ellipse radius for a centred ellipse', () => {
    for (const angle of [0, 0.4, 1.2, 2.5, 4]) expect(rayEllipse(unit(angle), { x: 0, y: 0 }, 30, 20, 0)).toBeCloseTo(ellipseRadius(30, 20, angle), 9);
  });

  it('turns the ellipse by the rotation', () => {
    expect(rayEllipse(unit(0), { x: 0, y: 0 }, 30, 20, Math.PI / 2)).toBeCloseTo(20, 9);
    expect(rayEllipse(unit(Math.PI / 2), { x: 0, y: 0 }, 30, 20, Math.PI / 2)).toBeCloseTo(30, 9);
    expect(rayEllipse(unit(0), { x: 0, y: 0 }, 30, 20, Math.PI / 6)).toBeCloseTo(ellipseRadius(30, 20, -Math.PI / 6), 9);
  });

  it('is the near and far side of an off-centre ellipse along its axis', () => {
    expect(rayEllipse({ x: 1, y: 0 }, { x: 5, y: 0 }, 30, 20, 0)).toBeCloseTo(35, 9);
    expect(rayEllipse({ x: -1, y: 0 }, { x: 5, y: 0 }, 30, 20, 0)).toBeCloseTo(25, 9);
  });

  it('is null when the origin is outside the ellipse', () => {
    expect(rayEllipse({ x: 1, y: 0 }, { x: 40, y: 0 }, 30, 20, 0)).toBeNull();
    expect(rayEllipse({ x: 0, y: 1 }, { x: 0, y: -25 }, 30, 20, 0)).toBeNull();
  });

  it('returns a point on the boundary, for any centre inside, rotation and direction', () => {
    checkProperty('ray hits the ellipse boundary', fc.property(
      semi, semi, fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }), fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
      fc.double({ min: -0.9, max: 0.9, noNaN: true }), fc.double({ min: -0.9, max: 0.9, noNaN: true }),
      (a, b, rotation, direction, cx, cy) => {
        // A centre strictly inside the ellipse's bounding circle of radius min(a, b) keeps the origin inside the ellipse.
        const centre = { x: cx * Math.min(a, b) / 2, y: cy * Math.min(a, b) / 2 };
        const t = rayEllipse(unit(direction), centre, a, b, rotation);
        if (t === null) return false;
        const px = t * Math.cos(direction) - centre.x, py = t * Math.sin(direction) - centre.y;
        const u = Math.cos(rotation) * px + Math.sin(rotation) * py, v = -Math.sin(rotation) * px + Math.cos(rotation) * py;
        return t > 0 && Math.abs((u / a) ** 2 + (v / b) ** 2 - 1) < 1e-9;
      }), 500);
  });
});

describe('offsetForPerimeter', () => {
  it('is about extra / 2 pi: 13 mm of perimeter is about 2.07 mm', () => {
    expect(offsetForPerimeter(30, 20, 13)).toBeCloseTo(13 / (2 * Math.PI), 1);
    // The offset ellipse (a + g, b + g) is not the offset curve, so g differs from extra / 2 pi by about 1 %.
    expect(offsetForPerimeter(30, 20, 13)).toBeCloseTo(2.07, 1);
    expect(offsetForPerimeter(30, 20, 0)).toBeCloseTo(0, 9);
  });

  it('adds exactly the extra perimeter and grows with it', () => {
    checkProperty('P(a+g, b+g) - P(a, b) = extra to 1e-3 mm; g increasing in extra', fc.property(
      semi, semi, fc.double({ min: 0, max: 40, noNaN: true }), fc.double({ min: 0.001, max: 10, noNaN: true }),
      (a, b, extra, more) => {
        const g = offsetForPerimeter(a, b, extra);
        const bigger = offsetForPerimeter(a, b, extra + more);
        return Math.abs(ellipsePerimeter(a + g, b + g) - ellipsePerimeter(a, b) - extra) < 1e-3 && bigger > g;
      }), 500);
  });

  it('gives the nearest end of its search range for an extra it cannot reach', () => {
    expect(offsetForPerimeter(30, 20, 1e6)).toBe(60);
    expect(offsetForPerimeter(30, 20, -1e6)).toBe(-10);
  });
});

describe('semiAxisForPerimeter', () => {
  it('inverts the perimeter in b', () => {
    checkProperty('b = semiAxisForPerimeter(a, P(a, b))', fc.property(semi, semi, (a, b) => {
      const back = semiAxisForPerimeter(a, ellipsePerimeter(a, b));
      return back !== null && Math.abs(back - b) < 1e-6;
    }), 300);
  });

  it('is null for a perimeter below the flat ellipse', () => {
    expect(semiAxisForPerimeter(30, 100)).toBeNull();
    expect(semiAxisForPerimeter(0, 100)).toBeNull();
  });
});
