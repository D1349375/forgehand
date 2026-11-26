import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PLACEMENT, type FitSummary, type Placement } from '../../shared/body';
import { applyEditPlan, EditPlanSchema, validateEditPlan } from '../../shared/edit';
import { offsetForPerimeter } from '../../shared/ellipse';
import { evaluateFit } from '../../shared/fit';
import { FitResizeError, resizeRing } from '../../shared/fit-resize';
import { FIT_TEXT } from '../../shared/fit-text';
import type { ModelSpec, Part } from '../../shared/model';
import { validateModel } from '../../shared/model';
import {
  bandWithCase, caseWithBand, fixtureModel, fixturePart, torusRingPart, tubeBand, tubeRingPart, wristMeasurement,
} from '../fixtures/fit-bracelet';
import { checkProperty, fc, printPropertyReport } from '../fixtures/fit-property';

afterAll(() => printPropertyReport('fit-resize'));

const mm = (metres: number) => metres * 1000;
const part = (model: ModelSpec, id: string): Part => model.parts.find(entry => entry.id === id)!;

/** The fit of a model's `band` part on a wrist, at the given placement. */
function fitOf(model: ModelSpec, widthMm: number, thicknessMm: number, clearanceMm: number, placement: Placement = DEFAULT_PLACEMENT, sign: 1 | -1 = 1): FitSummary {
  return evaluateFit({
    parts: model, choice: { kind: 'part', partId: 'band' }, wrist: wristMeasurement(widthMm, thicknessMm), placement, closure: 'closed', clearanceMm, sign,
  }).analysis.summary;
}

describe('resizeRing: a tube', () => {
  const widthMm = 56, thicknessMm = 38, clearanceMm = 13;

  it('gives the inner perimeter of the wrist plus the clearance, with every angle green', () => {
    const result = resizeRing({ model: tubeBand(), ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 0 });
    expect(result.changed).toBe(true);
    expect(result.roundedToCircle).toBe(false);
    expect(result.note).toBeNull();
    const g = offsetForPerimeter(28, 19, 13);
    expect(result.innerSemiAxesMm.across).toBeCloseTo(28 + g, 9);
    expect(result.innerSemiAxesMm.face).toBeCloseTo(19 + g, 9);
    const band = part(result.model, 'band');
    // The inner ellipse of the part: tubeRatio times the outer size, half of it.
    expect(band.tubeRatio * mm(band.dimensions.x) / 2).toBeCloseTo(28 + g, 2);
    expect(band.tubeRatio * mm(band.dimensions.z) / 2).toBeCloseTo(19 + g, 2);
    expect(mm(band.dimensions.y)).toBeCloseTo(20, 9);
    const fit = fitOf(result.model, widthMm, thicknessMm, clearanceMm);
    expect(fit.state).toBe('fits');
    expect(fit.classes).toBe('g'.repeat(72));
    expect(Math.abs(fit.spareMm! - clearanceMm)).toBeLessThan(0.3);
    expect(fit.minGap.mm).toBeCloseTo(g, 1);
  });

  it('keeps the wall on the width axis and returns a plan that applies cleanly', () => {
    const before = part(tubeBand(), 'band');
    const result = resizeRing({ model: tubeBand(), ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 0 });
    const after = part(result.model, 'band');
    const wall = (p: Part) => (mm(p.dimensions.x) - p.tubeRatio * mm(p.dimensions.x)) / 2;
    expect(wall(after)).toBeCloseTo(wall(before), 2);
    expect(result.plan.status).toBe('applied');
    expect(result.plan.operations.map(operation => [operation.op, operation.partId])).toEqual([['upsert', 'band']]);
    expect(() => validateEditPlan(result.plan)).not.toThrow();
    expect(EditPlanSchema.parse(result.plan)).toEqual(result.plan);
    expect(applyEditPlan(tubeBand(), result.plan).model).toEqual(result.model);
    expect(() => validateModel(result.model)).not.toThrow();
    expect(result.plan.explanation).toBe(FIT_TEXT.resizeExplanation(before.name));
  });

  it('does nothing more when it is run again on its own result', () => {
    const first = resizeRing({ model: tubeBand(), ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 0 });
    const second = resizeRing({ model: first.model, ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 0 });
    const a = part(first.model, 'band'), b = part(second.model, 'band');
    for (const axis of ['x', 'y', 'z'] as const) expect(mm(b.dimensions[axis])).toBeCloseTo(mm(a.dimensions[axis]), 2);
    expect(b.tubeRatio).toBeCloseTo(a.tubeRatio, 5);
  });

  it('reports no change, and an empty plan, for a ring that already has the size', () => {
    const first = resizeRing({ model: tubeBand(), ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 0 });
    const again = resizeRing({ model: first.model, ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 0 });
    expect(again.changed).toBe(false);
    expect(again.plan.operations).toEqual([]);
    expect(again.model).toBe(first.model);
    expect(() => validateEditPlan(again.plan)).not.toThrow();
  });
  it('turns the ring to the wrist: a ring turned a quarter, or a wrist rolled a quarter, swaps the axes', () => {
    const turned = fixtureModel('Turned', [{ ...tubeRingPart({ inner1Mm: 30.8, inner2Mm: 30.8, wallMm: 4.2, heightMm: 20 }), rotation: { x: 0, y: 90, z: 0 } }]);
    const swapped = resizeRing({ model: turned, ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 0 });
    const a = part(swapped.model, 'band');
    const g = offsetForPerimeter(28, 19, 13);
    // The part's own x now lies along the face, so it takes the thickness.
    expect(a.tubeRatio * mm(a.dimensions.x) / 2).toBeCloseTo(19 + g, 2);
    expect(a.tubeRatio * mm(a.dimensions.z) / 2).toBeCloseTo(28 + g, 2);
    const rolled = resizeRing({ model: tubeBand(), ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 90 });
    const b = part(rolled.model, 'band');
    expect(b.tubeRatio * mm(b.dimensions.x) / 2).toBeCloseTo(19 + g, 2);
    expect(b.tubeRatio * mm(b.dimensions.z) / 2).toBeCloseTo(28 + g, 2);
  });

  it('makes the inner ring a circle, and says so, when the ring is not square to the wrist', () => {
    for (const [rotation, rollDeg] of [[45, 0], [0, 45], [20, 0], [0, -30]] as const) {
      const odd = fixtureModel('Odd', [{ ...tubeRingPart({ inner1Mm: 30.8, inner2Mm: 30.8, wallMm: 4.2, heightMm: 20 }), rotation: { x: 0, y: rotation, z: 0 } }]);
      const result = resizeRing({ model: odd, ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg });
      const g = offsetForPerimeter(28, 19, 13);
      expect(result.roundedToCircle).toBe(true);
      expect(result.note).toBe('環的方向不是正對手腕，已改成圓形內圈。');
      expect(result.innerSemiAxesMm.across).toBeCloseTo(result.innerSemiAxesMm.face, 9);
      expect(result.innerSemiAxesMm.across).toBeCloseTo((28 + g + 19 + g) / 2, 9);
    }
    // 10 degrees off is still square.
    const near = fixtureModel('Near', [{ ...tubeRingPart({ inner1Mm: 30.8, inner2Mm: 30.8, wallMm: 4.2, heightMm: 20 }), rotation: { x: 0, y: 8, z: 0 } }]);
    expect(resizeRing({ model: near, ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 0 }).roundedToCircle).toBe(false);
  });

  it('says the ring is out of range when the wall is too thin for the new size', () => {
    const thin = fixtureModel('Thin', [tubeRingPart({ inner1Mm: 30, inner2Mm: 30, wallMm: 3, heightMm: 10 })]);
    expect(() => resizeRing({ model: thin, ringPartId: 'band', widthMm: 130, thicknessMm: 90, clearanceMm: 13, rollDeg: 0 }))
      .toThrowError(expect.objectContaining({ name: 'FitResizeError', code: 'FIT_OUT_OF_RANGE', message: FIT_TEXT.fitOutOfRange }));
  });

  it('refuses a part that is not a ring, and a part that is not there', () => {
    expect(() => resizeRing({ model: bandWithCase(), ringPartId: 'case', widthMm, thicknessMm, clearanceMm, rollDeg: 0 }))
      .toThrowError(expect.objectContaining({ code: 'NOT_RESIZABLE', message: '這個形狀請交給 AI 調整。' }));
    expect(() => resizeRing({ model: bandWithCase(), ringPartId: 'missing', widthMm, thicknessMm, clearanceMm, rollDeg: 0 }))
      .toThrowError(expect.objectContaining({ code: 'NO_RING' }));
    const shelled = fixtureModel('Shell', [fixturePart('band', 'shell', [60, 20, 60])]);
    expect(() => resizeRing({ model: shelled, ringPartId: 'band', widthMm, thicknessMm, clearanceMm, rollDeg: 0 }))
      .toThrow(FitResizeError);
  });
});

describe('resizeRing: a torus', () => {
  it('gives the inner perimeter of the wrist plus the clearance and leaves the width along the axis', () => {
    const model = fixtureModel('Torus', [torusRingPart({ inner1Mm: 35, inner2Mm: 31, widthMm: 12 })]);
    const result = resizeRing({ model, ringPartId: 'band', widthMm: 60, thicknessMm: 40, clearanceMm: 25, rollDeg: 0 });
    const g = offsetForPerimeter(30, 20, 25);
    const band = part(result.model, 'band');
    expect(mm(band.dimensions.x)).toBeCloseTo(4 * (30 + g), 2);
    expect(mm(band.dimensions.y)).toBeCloseTo(4 * (20 + g), 2);
    expect(mm(band.dimensions.z)).toBeCloseTo(12, 9);
    const fit = fitOf(result.model, 60, 40, 25);
    expect(fit.state).toBe('fits');
    expect(Math.abs(fit.spareMm! - 25)).toBeLessThan(0.3);
  });
});

describe('resizeRing: the parts around the ring (design 6.6, step 4)', () => {
  const wrist = { widthMm: 56, thicknessMm: 38, clearanceMm: 13, rollDeg: 0 };

  it('moves the case, a child of the band, by the change of the outer radius toward it, and nothing inside the case', () => {
    const before = bandWithCase();
    const result = resizeRing({ model: before, ringPartId: 'band', ...wrist });
    const band = part(result.model, 'band');
    const growth = mm(band.dimensions.z) / 2 - mm(part(before, 'band').dimensions.z) / 2;
    expect(growth).toBeLessThan(-5);
    expect(mm(part(result.model, 'case').position.z)).toBeCloseTo(41 + growth, 2);
    expect(part(result.model, 'case').position.x).toBe(0);
    expect(part(result.model, 'battery')).toEqual(part(before, 'battery'));
    expect(part(result.model, 'board')).toEqual(part(before, 'board'));
    expect(result.plan.operations.map(operation => operation.partId).sort()).toEqual(['band', 'case']);
    // The case still touches the band's outer surface.
    expect(mm(part(result.model, 'case').position.z) - 6).toBeCloseTo(mm(band.dimensions.z) / 2, 2);
    const fit = fitOf(result.model, 56, 38, 13);
    expect(fit.state).toBe('fits');
    expect(fit.ringPartId).toBe('band');
  });

  it('moves the case away from a ring that grows, too', () => {
    const result = resizeRing({ model: bandWithCase(), ringPartId: 'band', widthMm: 76, thicknessMm: 66, clearanceMm: 13, rollDeg: 0 });
    const band = part(result.model, 'band');
    expect(mm(band.dimensions.z) / 2).toBeGreaterThan(35);
    expect(mm(part(result.model, 'case').position.z)).toBeCloseTo(mm(band.dimensions.z) / 2 + 6, 2);
  });

  it('moves a ring that has a parent, so that it keeps touching it, and leaves the parent where it is', () => {
    const before = caseWithBand();
    const result = resizeRing({ model: before, ringPartId: 'band', ...wrist });
    const band = part(result.model, 'band');
    expect(part(result.model, 'case')).toEqual(part(before, 'case'));
    // The band's outer surface on the case side stays at the case's lower face (z = -6 mm).
    expect(mm(band.position.z) + mm(band.dimensions.z) / 2).toBeCloseTo(-6, 2);
    expect(mm(band.position.z)).toBeGreaterThan(-41);
    expect(result.plan.operations.map(operation => operation.partId)).toEqual(['band']);
    expect(fitOf(result.model, 56, 38, 13).state).toBe('fits');
  });

  it('moves the parts that touch the ring from outside, and leaves the ones that do not', () => {
    const band = tubeRingPart({ inner1Mm: 30.8, inner2Mm: 30.8, wallMm: 4.2, heightMm: 20 });
    const model = fixtureModel('Attached', [
      band,
      fixturePart('clasp', 'box', [6, 10, 10], [38, 0, 0]),
      fixturePart('clasp-pin', 'cylinder', [2, 4, 2], [3, 0, 0], { parentId: 'clasp' }),
      fixturePart('bar', 'box', [4, 4, 4]),
      fixturePart('far', 'box', [6, 10, 10], [60, 0, 0]),
      fixturePart('gap', 'box', [6, 10, 10], [-41.5, 0, 0]),
    ]);
    const result = resizeRing({ model, ringPartId: 'band', ...wrist });
    const grown = part(result.model, 'band');
    const xGrowth = mm(grown.dimensions.x) / 2 - 35;
    expect(Math.abs(xGrowth)).toBeGreaterThan(1);
    expect(mm(part(result.model, 'clasp').position.x)).toBeCloseTo(38 + xGrowth, 2);
    expect(part(result.model, 'clasp').position.z).toBe(0);
    expect(part(result.model, 'clasp-pin')).toEqual(part(model, 'clasp-pin'));
    // `bar` has its centre in the hole, so it is not attached; gap is 3.5 mm away from the ring's box; `far` is far.
    for (const id of ['bar', 'far', 'gap']) expect(part(result.model, id)).toEqual(part(model, id));
    expect(result.plan.operations.map(operation => operation.partId).sort()).toEqual(['band', 'clasp']);
  });

  it('moves an attached part through the rotation of its own parent', () => {
    // The holder is turned a quarter about y, so the lug's local z is the object's x.
    const model = fixtureModel('Turned holder', [
      tubeRingPart({ inner1Mm: 30.8, inner2Mm: 30.8, wallMm: 4.2, heightMm: 20 }),
      fixturePart('holder', 'box', [4, 4, 4], [0, 0, 0], { rotation: { x: 0, y: 90, z: 0 } }),
      fixturePart('lug', 'box', [6, 10, 10], [0, 0, 38], { parentId: 'holder' }),
    ]);
    const result = resizeRing({ model, ringPartId: 'band', ...wrist });
    const growth = mm(part(result.model, 'band').dimensions.x) / 2 - 35;
    expect(Math.abs(growth)).toBeGreaterThan(1);
    expect(mm(part(result.model, 'lug').position.z)).toBeCloseTo(38 + growth, 2);
    expect(part(result.model, 'lug').position.x).toBe(0);
    expect(part(result.model, 'holder')).toEqual(part(model, 'holder'));
  });
});

describe('invariants of the resize (design 6.8)', () => {
  const tubeSpec = fc.record({
    inner1: fc.double({ min: 25, max: 40, noNaN: true }), inner2: fc.double({ min: 25, max: 40, noNaN: true }),
    wall: fc.double({ min: 4, max: 8, noNaN: true }), half: fc.double({ min: 3, max: 20, noNaN: true }),
  });
  const ringArb = fc.record({ torus: fc.boolean(), spec: tubeSpec });
  const wristArb = fc.record({ width: fc.double({ min: 45, max: 80, noNaN: true }), ratio: fc.double({ min: 0.55, max: 0.8, noNaN: true }) });

  const build = (ring: { torus: boolean; spec: { inner1: number; inner2: number; wall: number; half: number } }) =>
    fixtureModel('Ring', [ring.torus
      ? torusRingPart({ inner1Mm: ring.spec.inner1, inner2Mm: ring.spec.inner2, widthMm: 2 * ring.spec.half })
      : tubeRingPart({ inner1Mm: ring.spec.inner1, inner2Mm: ring.spec.inner2, wallMm: ring.spec.wall, heightMm: 2 * ring.spec.half })]);

  it('leaves a spare equal to the clearance within 0.3 mm and no angle red, at slide 0 and tilt 0 (straight arm)', () => {
    // A clearance of exactly 0 puts the ring on the skin: whether a gap of 0.000 is red is then a matter of the last bit,
    // so the generator starts at 1 mm.
    checkProperty('after resizeRing: spare = clearance within 0.3 mm and no red angle', fc.property(
      ringArb, wristArb, fc.double({ min: 1, max: 40, noNaN: true }), fc.constantFrom<1 | -1>(1, -1),
      (ring, size, clearance, sign) => {
        const thickness = size.width * size.ratio;
        const result = resizeRing({ model: build(ring), ringPartId: 'band', widthMm: size.width, thicknessMm: thickness, clearanceMm: clearance, rollDeg: 0 });
        const fit = fitOf(result.model, size.width, thickness, clearance, DEFAULT_PLACEMENT, sign);
        return Math.abs(fit.spareMm! - clearance) <= 0.3 && !fit.classes.includes('r') && fit.minGap.mm >= 0;
      }), 200);
  });

  it('does the same for a ring that is turned a quarter and a wrist that is rolled a quarter', () => {
    checkProperty('after resizeRing with quarter turns: spare = clearance and no red angle', fc.property(
      ringArb, wristArb, fc.double({ min: 1, max: 40, noNaN: true }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 }), fc.constantFrom<1 | -1>(1, -1),
      (ring, size, clearance, turn, quarter, sign) => {
        const thickness = size.width * size.ratio;
        const base = build(ring);
        const turned = { ...base, parts: base.parts.map(entry => ({ ...entry, rotation: ring.torus ? { x: 0, y: 0, z: turn * 90 } : { x: 0, y: turn * 90, z: 0 } })) };
        const rollDeg = quarter * 90;
        const result = resizeRing({ model: turned, ringPartId: 'band', widthMm: size.width, thicknessMm: thickness, clearanceMm: clearance, rollDeg });
        const fit = fitOf(result.model, size.width, thickness, clearance, { slideMm: 0, tiltDeg: 0, rollDeg }, sign);
        return !result.roundedToCircle && Math.abs(fit.spareMm! - clearance) <= 0.3 && !fit.classes.includes('r') && fit.minGap.mm >= 0;
      }), 200);
  });

  it('never makes any gap smaller with a larger clearance', () => {
    checkProperty('a larger clearance never makes any gap of the resized ring smaller', fc.property(
      ringArb, wristArb, fc.double({ min: 0, max: 40, noNaN: true }), fc.double({ min: 0, max: 40, noNaN: true }), fc.integer({ min: 0, max: 3 }),
      (ring, size, c1, c2, quarter) => {
        const [low, high] = c1 <= c2 ? [c1, c2] : [c2, c1];
        const thickness = size.width * size.ratio, rollDeg = quarter * 90;
        const gaps = (clearance: number) => evaluateFit({
          parts: resizeRing({ model: build(ring), ringPartId: 'band', widthMm: size.width, thicknessMm: thickness, clearanceMm: clearance, rollDeg }).model,
          choice: { kind: 'part', partId: 'band' }, wrist: wristMeasurement(size.width, thickness), placement: { slideMm: 0, tiltDeg: 0, rollDeg }, closure: 'closed', clearanceMm: clearance, sign: 1,
        }).analysis.angles.map(entry => entry.gapMm!);
        const smallClearance = gaps(low), largeClearance = gaps(high);
        // Each distance is found within 1/64 mm on the solid side, and the part is rounded to 0.0001 mm.
        return smallClearance.every((gap, j) => largeClearance[j]! >= gap - 1 / 64 - 1e-3);
      }), 200);
  });

  it('is about the same ring for the same wrist, however often it is run', () => {
    checkProperty('resizeRing is stable under repetition', fc.property(ringArb, wristArb, fc.double({ min: 1, max: 40, noNaN: true }), (ring, size, clearance) => {
      const input = { ringPartId: 'band', widthMm: size.width, thicknessMm: size.width * size.ratio, clearanceMm: clearance, rollDeg: 0 };
      const once = resizeRing({ model: build(ring), ...input }).model;
      const twice = resizeRing({ model: once, ...input }).model;
      const a = part(once, 'band'), b = part(twice, 'band');
      return (['x', 'y', 'z'] as const).every(axis => Math.abs(mm(a.dimensions[axis]) - mm(b.dimensions[axis])) < 0.01) && Math.abs(a.tubeRatio - b.tubeRatio) < 1e-4;
    }), 200);
  });
});

describe('what a taper does to the resize (a known limit of design 6.6)', () => {
  it('can leave the band edge toward the elbow pressing, because the ring is sized for the arm at the band position only', () => {
    // A tube 40 mm wide on an arm that widens by 0.12 mm per mm: at the edge slice the arm is 2 x 0.12 x 19.5 / 2 = 2.3 mm wider
    // across than at the middle, and the 6 mm clearance only gives 0.95 mm of radial gap. The spare is still the clearance.
    const model = fixtureModel('Wide', [tubeRingPart({ inner1Mm: 30, inner2Mm: 30, wallMm: 5, heightMm: 40 })]);
    const result = resizeRing({ model, ringPartId: 'band', widthMm: 58, thicknessMm: 40, clearanceMm: 6, rollDeg: 0 });
    const tapered = evaluateFit({
      parts: result.model, choice: { kind: 'part', partId: 'band' }, wrist: wristMeasurement(58, 40, { taper: 0.12 }), placement: DEFAULT_PLACEMENT, closure: 'closed', clearanceMm: 6, sign: 1,
    }).analysis.summary;
    expect(Math.abs(tapered.spareMm! - 6)).toBeLessThan(0.3);
    expect(tapered.state).toBe('presses');
    const straight = fitOf(result.model, 58, 40, 6);
    expect(straight.state).toBe('fits');
  });
});
