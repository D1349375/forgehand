import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACEMENT, FitSummarySchema, type Closure, type FitClass, type FitSummary, type Placement, type ProfileSlice, type WristMeasurement,
} from '../../shared/body';
import { ellipsePerimeter, ellipseRadius, offsetForPerimeter } from '../../shared/ellipse';
import { CLASS_COLORS, FIT_ANGLES, LOOSE_MARGIN_MM, OPEN_GAP_DEG } from '../../shared/fit-constants';
import { axisBlocked, modelParts, ringFrame, type InnerProfile } from '../../shared/fit-geometry';
import {
  analyseFit, armProfileOf, armSection, bodyAngle, bodyGridAngles, classRuns, classify, defaultArm, effectiveClearance, evaluateFit,
  fitGaps, fitSummary, norm360, passagePerimeter, robustMedian, scaleProfile, spread, taperedArm, wristEllipse,
} from '../../shared/fit';
import {
  FIT_TEXT, classLabel, clearanceLabel, closureLabel, fitResultLine, formatMeasured, formatMm, rangeLines, sideLabel, sourceLabel, summaryLines,
} from '../../shared/fit-text';
import { checkProperty, fc, printPropertyReport } from '../fixtures/fit-property';
import {
  bandWithCase, fixtureModel, fixturePart, noRing, openCuff, ringWithBar, torusRingPart, tubeBand, tubeRingPart, wristMeasurement,
} from '../fixtures/fit-bracelet';

afterAll(() => printPropertyReport('fit-gaps'));

const rad = (deg: number) => deg * Math.PI / 180;
const RANK: Record<FitClass, number> = { presses: 0, fits: 1, loose: 2 };

describe('arm section (design 6.2)', () => {
  const straight = taperedArm(60, 40, 0);
  const at = (arm = straight, placement: Partial<Placement> = {}, slices = [0], angles = [0, 90, 180, 270]) =>
    armSection(arm, { ...DEFAULT_PLACEMENT, ...placement }, slices, angles);

  it('is the wrist ellipse: thickness along the face (angle 0), width across (angle 90)', () => {
    const [row] = at();
    expect(row![0]).toBeCloseTo(20, 9);
    expect(row![1]).toBeCloseTo(30, 9);
    expect(row![2]).toBeCloseTo(20, 9);
    expect(row![3]).toBeCloseTo(30, 9);
    expect(at(straight, {}, [0], [37])[0]![0]).toBeCloseTo(ellipseRadius(20, 30, rad(37)), 9);
  });

  it('turns the ellipse by minus the roll', () => {
    const [row] = at(straight, { rollDeg: 90 });
    expect(row![0]).toBeCloseTo(30, 9);
    expect(row![1]).toBeCloseTo(20, 9);
    // The arm's thickness axis now points to ring angle -roll.
    expect(at(straight, { rollDeg: 30 }, [0], [-30])[0]![0]).toBeCloseTo(20, 9);
    expect(at(straight, { rollDeg: -30 }, [0], [30])[0]![0]).toBeCloseTo(20, 9);
  });

  it('stretches the thickness by 1 / cos(tilt) and shifts the centre by y tan(tilt) on a slice off the middle', () => {
    const tilt = 30, cos = Math.cos(rad(tilt)), tan = Math.tan(rad(tilt));
    const [middle, edge] = at(straight, { tiltDeg: tilt }, [0, 10]);
    expect(middle![0]).toBeCloseTo(20 / cos, 9);
    expect(middle![2]).toBeCloseTo(20 / cos, 9);
    expect(middle![1]).toBeCloseTo(30, 9);
    const shift = 10 * tan, b = 20 / cos;
    expect(edge![0]).toBeCloseTo(shift + b, 9);
    expect(edge![2]).toBeCloseTo(b - shift, 9);
    // Along x the ray crosses the ellipse where its z offset from the centre is -shift.
    expect(edge![1]).toBeCloseTo(30 * Math.sqrt(1 - (shift / b) ** 2), 9);
  });

  it('is null where the ring axis lies outside the arm', () => {
    const [row] = at(straight, { tiltDeg: 30 }, [100]);
    expect(row!.every(value => value === null)).toBe(true);
  });

  it('reads the profile at slide + y / cos(tilt)', () => {
    const taper = taperedArm(60, 40, 0.1);
    expect(at(taper, { slideMm: 20 })[0]![1]).toBeCloseTo((60 + 0.1 * 20) / 2, 9);
    expect(at(taper, {}, [10])[0]![1]).toBeCloseTo((60 + 0.1 * 10) / 2, 9);
    const tilted = at(taper, { tiltDeg: 30, slideMm: 5 }, [10]);
    const s = 5 + 10 / Math.cos(rad(30));
    const shift = 10 * Math.tan(rad(30)), b = (40 + 0.1 * s * 40 / 60) / (2 * Math.cos(rad(30)));
    expect(tilted[0]![1]).toBeCloseTo((60 + 0.1 * s) / 2 * Math.sqrt(1 - (shift / b) ** 2), 9);
  });
});

describe('arm profile of a measurement (design 6.5)', () => {
  it('interpolates its slices linearly and holds the end values beyond them', () => {
    const wrist = wristMeasurement(60, 40, { taper: 0.1 });
    const arm = armProfileOf(wrist);
    expect(arm.widthAt(0)).toBeCloseTo(60, 9);
    expect(arm.widthAt(12.5)).toBeCloseTo(61.25, 9);
    expect(arm.thicknessAt(12.5)).toBeCloseTo(40 + 0.1 * 12.5 * 40 / 60, 9);
    expect(arm.widthAt(-500)).toBeCloseTo(58, 9);
    expect(arm.widthAt(500)).toBeCloseTo(66, 9);
  });

  it('skips slices without a width, takes the thickness from the ratio when it is missing, and defaults without slices', () => {
    const wrist = wristMeasurement(60, 40);
    const profile: ProfileSlice[] = [
      { offsetMm: 0, width: wrist.width, thickness: null },
      { offsetMm: 5, width: null, thickness: wrist.thickness },
      { offsetMm: 10, width: { ...wrist.width, mm: 70 }, thickness: null },
    ];
    const arm = armProfileOf({ ...wrist, profile });
    expect(arm.widthAt(5)).toBeCloseTo(65, 9);
    expect(arm.thicknessAt(5)).toBeCloseTo(65 * 40 / 60, 9);
    const bare = armProfileOf({ ...wrist, profile: [] });
    expect(bare.widthAt(10)).toBeCloseTo(60 + 0.12 * 10, 9);
    expect(defaultArm().widthAt(0)).toBe(60);
    expect(defaultArm().thicknessAt(0)).toBe(40);
  });
});

describe('gaps, classes and clearance (design 6.2, 6.7)', () => {
  const profile = (distances: (number | null)[][]): InnerProfile => ({
    anglesDeg: [0, 90, 180, 270], sliceMm: [-5, 0, 5], distanceMm: distances, halfWidthMm: 5.5,
  });

  it('takes the smallest gap over the slices, skips slices that are open and calls an angle open when every slice is', () => {
    const inner = profile([[30, 30, null, null], [31, 28, 30, null], [29, 33, null, null]]);
    const arm = [[25, 25, 25, 25], [25, 25, 25, 25], [25, 25, 25, 25]];
    expect(fitGaps(inner, arm)).toEqual([4, 3, 5, null]);
  });

  it('counts a slice as pressing where the axis lies outside the arm', () => {
    const inner = profile([[30, 30, 30, 30], [30, 30, 30, 30], [30, 30, 30, 30]]);
    const gaps = fitGaps(inner, [[25, 25, 25, 25], [25, null, 25, 25], [25, 25, 25, 25]]);
    expect(gaps).toEqual([5, -30, 5, 5]);
  });

  it('classifies: below 0 presses, up to the clearance gap plus 2 mm fits, above that is loose', () => {
    const green = 2.09 + LOOSE_MARGIN_MM;
    expect(classify(-0.001, green)).toBe('presses');
    expect(classify(0, green)).toBe('fits');
    expect(classify(green, green)).toBe('fits');
    expect(classify(green + 0.001, green)).toBe('loose');
    expect(LOOSE_MARGIN_MM).toBe(2);
  });

  it('is monotone in the gap', () => {
    checkProperty('classify is monotone in the gap', fc.property(
      fc.double({ min: -20, max: 40, noNaN: true }), fc.double({ min: -20, max: 40, noNaN: true }), fc.double({ min: 0, max: 15, noNaN: true }),
      (g1, g2, greenMax) => {
        const [low, high] = g1 <= g2 ? [g1, g2] : [g2, g1];
        return RANK[classify(low, greenMax)] <= RANK[classify(high, greenMax)];
      }), 500);
  });

  it('keeps the clearance for an open ring or a clasp, and raises it to pass over the hand for a closed ring', () => {
    const passageWidthMm = 62, wristCircumferenceMm = 160;
    const hand = passagePerimeter(passageWidthMm);
    expect(hand).toBeCloseTo(Math.PI * 62 * 0.95, 9);
    expect(effectiveClearance({ clearanceMm: 13, opens: true, passageWidthMm, wristCircumferenceMm })).toBe(13);
    expect(effectiveClearance({ clearanceMm: 13, opens: false, passageWidthMm, wristCircumferenceMm })).toBeCloseTo(hand - 160, 9);
    expect(effectiveClearance({ clearanceMm: 40, opens: false, passageWidthMm, wristCircumferenceMm })).toBe(40);
    expect(effectiveClearance({ clearanceMm: 13, opens: false, passageWidthMm: null, wristCircumferenceMm })).toBe(13);
  });
});

describe('fit summary', () => {
  const base = (parts: Parameters<typeof evaluateFit>[0]['parts'], wrist: WristMeasurement, extra: Partial<Parameters<typeof evaluateFit>[0]> = {}) =>
    evaluateFit({ parts, choice: null, wrist, placement: DEFAULT_PLACEMENT, closure: 'closed', clearanceMm: 13, sign: 1, ...extra });
  const A = 30, B = 20, wrist = wristMeasurement(2 * A, 2 * B);
  const green = offsetForPerimeter(A, B, 13);

  /** A tube whose inner ellipse is the wrist's, grown by `grow` mm on both axes. */
  const ringFor = (grow: number, extra = {}) => fixtureModel('Ring', [tubeRingPart({ inner1Mm: A + grow, inner2Mm: B + grow, wallMm: 4, heightMm: 16, ...extra })]);

  it('fits when the ring is the wrist plus the clearance: spare 13 mm, every angle green', () => {
    const { analysis } = base(ringFor(green), wrist);
    const { summary } = analysis;
    expect(summary.state).toBe('fits');
    expect(summary.classes).toBe('g'.repeat(FIT_ANGLES));
    expect(summary.spareMm!).toBeGreaterThan(12.7);
    expect(summary.spareMm!).toBeLessThan(13.3);
    expect(summary.clearanceMm).toBe(13);
    expect(summary.minGap.mm).toBeCloseTo(green, 1);
    // The offset of the two ellipses is green on the axes and a little more between them.
    expect(summary.maxGap.mm).toBeGreaterThanOrEqual(summary.minGap.mm);
    expect(summary.maxGap.mm).toBeLessThan(green + 0.5);
    expect(summary.openingDeg).toBeNull();
    expect(summary.ringPartId).toBe('band');
    expect(summary.wrist).toEqual(wrist.circumference);
    expect(FitSummarySchema.parse(summary)).toEqual(summary);
  });

  it('presses all around when the ring is smaller than the wrist', () => {
    const { summary } = base(fixtureModel('Small', [tubeRingPart({ inner1Mm: 28, inner2Mm: 28, wallMm: 4, heightMm: 16 })]), wristMeasurement(70, 62)).analysis;
    expect(summary.state).toBe('presses');
    expect(summary.classes).toBe('r'.repeat(FIT_ANGLES));
    expect(summary.minGap.mm).toBeLessThan(0);
  });

  it('is loose when the ring is much bigger, and mixed when it presses on the width and is loose on the thickness', () => {
    expect(base(ringFor(10), wrist).analysis.summary.state).toBe('loose');
    const round = fixtureModel('Round', [tubeRingPart({ inner1Mm: 28, inner2Mm: 28, wallMm: 4, heightMm: 16 })]);
    const { summary } = base(round, wrist).analysis;
    expect(summary.state).toBe('mixed');
    expect(summary.classes).toContain('r');
    expect(summary.classes).toContain('a');
  });

  it('names body angles: a round ring is loose at the back and the palm (0 and 180) and tight at the sides (90 and 270)', () => {
    const { summary } = base(fixtureModel('Round', [tubeRingPart({ inner1Mm: 31, inner2Mm: 31, wallMm: 4, heightMm: 16 })]), wrist).analysis;
    const at = (deg: number) => summary.classes[deg / 5];
    expect([at(0), at(180)]).toEqual(['a', 'a']);
    expect([at(90), at(270)]).toEqual(['g', 'g']);
    expect(summary.minGap.mm).toBeCloseTo(1, 1);
    expect([90, 270]).toContain(summary.minGap.angleDeg);
    expect(summary.maxGap.mm).toBeCloseTo(11, 1);
    expect([0, 180]).toContain(summary.maxGap.angleDeg);
  });

  it('gives the same classes in body angles for any roll and either arm (round ring)', () => {
    const round = fixtureModel('Round', [tubeRingPart({ inner1Mm: 31, inner2Mm: 31, wallMm: 4, heightMm: 16 })]);
    const reference = base(round, wrist).analysis.summary.classes;
    checkProperty('classes in body angles do not depend on roll or side', fc.property(
      fc.double({ min: -180, max: 180, noNaN: true }), fc.boolean(), (rollDeg, left) => {
        const classes = base(round, wrist, { placement: { ...DEFAULT_PLACEMENT, rollDeg }, sign: left ? -1 : 1 }).analysis.summary.classes;
        return classes === reference;
      }), 150);
  });

  it('cannot pass over the hand: a closed ring without a clasp whose inside is smaller than the knuckles', () => {
    const tight = wristMeasurement(2 * A, 2 * B, { passageMm: 90 });
    const closed = base(ringFor(green), tight).analysis;
    expect(closed.cannotPass).toBe(true);
    expect(closed.summary.state).toBe('cannot-pass');
    expect(closed.summary.classes).toBe('r'.repeat(FIT_ANGLES));
    expect(closed.summary.clearanceMm).toBeGreaterThan(100);
    // A clasp, or an open ring, does not need to pass.
    for (const closure of ['clasp', 'open'] as Closure[]) {
      const opened = base(ringFor(green), tight, { closure }).analysis;
      expect(opened.cannotPass).toBe(false);
      expect(opened.opens).toBe(true);
      expect(opened.summary.state).toBe('fits');
      expect(opened.summary.clearanceMm).toBe(13);
    }
    // A passage the ring can pass raises the clearance to the hand's size only when that is more.
    const fine = base(ringFor(green), wristMeasurement(2 * A, 2 * B, { passageMm: 62 })).analysis.summary;
    expect(fine.clearanceMm).toBeCloseTo(passagePerimeter(62) - ellipsePerimeter(A, B), 1);
    expect(fine.clearanceMm).toBeGreaterThan(13);
  });

  it('has no ring for an object without one, and for no parts', () => {
    for (const parts of [noRing(), [] as ReturnType<typeof modelParts>]) {
      const { summary } = base(parts, wrist).analysis;
      expect(summary.state).toBe('no-ring');
      expect(summary.innerMm).toBeNull();
      expect(summary.classes).toBe('-'.repeat(FIT_ANGLES));
      expect(summary.openingDeg).toBeNull();
    }
    expect(base(noRing(), wrist).setup).not.toBeNull();
    expect(base([], wrist).setup).toBeNull();
  });

  it('is blocked, and presses everywhere, when a part lies across the axis of a ring', () => {
    const evaluation = base(ringWithBar(), wrist);
    expect(axisBlocked(evaluation.inner!)).toBe(true);
    expect(evaluation.analysis.summary.state).toBe('presses');
    expect(evaluation.analysis.summary.minGap.mm).toBeLessThan(0);
  });

  it('is open where an open cuff has no part: the opening width and its side, whatever the arm and the roll', () => {
    const open = base(openCuff(), wrist).analysis.summary;
    expect(open.openingDeg).toBeGreaterThanOrEqual(60);
    expect(open.openingDeg).toBeLessThanOrEqual(90);
    expect(open.openingDeg).toBeGreaterThanOrEqual(OPEN_GAP_DEG);
    expect(open.openingAtDeg).toBeCloseTo(180, -1);
    expect(open.innerMm).toBeNull();
    expect(open.spareMm).toBeNull();
    expect(open.classes.split('-').length - 1).toBe(open.openingDeg! / 5);
    expect(open.state).not.toBe('no-ring');
    // A body angle is sign * (ring angle + roll): the opening at ring 180 is at 210 with a roll of 30 on one arm and 150 on the other.
    const rolled = { ...DEFAULT_PLACEMENT, rollDeg: 30 };
    expect(base(openCuff(), wrist, { placement: rolled, sign: 1 }).analysis.summary.openingAtDeg).toBeCloseTo(210, -1);
    expect(base(openCuff(), wrist, { placement: rolled, sign: -1 }).analysis.summary.openingAtDeg).toBeCloseTo(150, -1);
    expect(bodyAngle(180, 30, 1)).toBe(210);
    expect(bodyAngle(180, 30, -1)).toBe(150);
    // Whatever is chosen for the closure, an opening makes it open: no passage needed.
    const withPassage = base(openCuff(), wristMeasurement(60, 40, { passageMm: 100 })).analysis;
    expect(withPassage.opens).toBe(true);
    expect(withPassage.summary.clearanceMm).toBe(13);
  });

  it('does not call a gap narrower than 15 degrees an open ring', () => {
    // 35 narrow boxes every 10 degrees, one left out: a hole of about 10 degrees, one or two samples wide.
    const model = fixtureModel('Slit', Array.from({ length: 36 }, (_, i) => i).filter(i => i !== 5).map(i => {
      const angle = i * 10, t = rad(angle);
      return fixturePart(`seg-${i}`, 'box', [6, 20, 3], [34.5 * Math.sin(t), 0, 34.5 * Math.cos(t)], { rotation: { x: 0, y: angle, z: 0 } });
    }));
    const { summary } = base(model, wrist, { choice: { kind: 'axis', axis: 'y' } }).analysis;
    const open = summary.classes.split('').filter(char => char === '-').length;
    expect(open).toBeGreaterThanOrEqual(1);
    expect(open * 5).toBeLessThan(OPEN_GAP_DEG);
    expect(summary.openingDeg).toBeNull();
    expect(summary.state).not.toBe('no-ring');
  });
  it('wraps a run of open angles past 0 degrees', () => {
    const inner: InnerProfile = {
      anglesDeg: bodyGridAngles(1, 0, 8), sliceMm: [0],
      distanceMm: [[null, 30, 30, 30, 30, 30, null, null]], halfWidthMm: 5,
    };
    const { summary } = analyseFit({ inner, wrist, placement: DEFAULT_PLACEMENT, closure: 'closed', clearanceMm: 13, sign: 1, ringPartId: null });
    expect(summary.openingDeg).toBe(135);
    expect(summary.openingAtDeg).toBe(315);
    expect(summary.classes).toHaveLength(8);
  });

  it('asks for a profile on the body grid', () => {
    const model = ringFor(green);
    const setup = ringFrame(model)!;
    const inner = evaluateFit({ parts: model, choice: null, wrist, placement: DEFAULT_PLACEMENT, closure: 'closed', clearanceMm: 13, sign: 1 }).inner!;
    expect(() => analyseFit({
      inner: { ...inner, anglesDeg: inner.anglesDeg.map(angle => angle + 2) }, wrist, placement: DEFAULT_PLACEMENT, closure: 'closed', clearanceMm: 13, sign: 1, ringPartId: setup.ringPartId,
    })).toThrow(/body grid/);
    expect(bodyGridAngles(-1, 30, 4)).toEqual([330, 240, 150, 60]);
    expect(norm360(-30)).toBe(330);
  });

  it('is always a valid summary, with one class character per angle', () => {
    checkProperty('fitSummary satisfies FitSummarySchema', fc.property(
      fc.double({ min: 22, max: 42, noNaN: true }), fc.double({ min: 22, max: 42, noNaN: true }), fc.double({ min: 3, max: 8, noNaN: true }), fc.double({ min: 4, max: 30, noNaN: true }),
      fc.double({ min: 45, max: 80, noNaN: true }), fc.double({ min: 0.55, max: 0.8, noNaN: true }),
      fc.record({ slideMm: fc.double({ min: -40, max: 60, noNaN: true }), tiltDeg: fc.double({ min: -30, max: 30, noNaN: true }), rollDeg: fc.double({ min: -180, max: 180, noNaN: true }) }),
      fc.constantFrom<Closure>('closed', 'open', 'clasp'), fc.boolean(), fc.double({ min: 0, max: 40, noNaN: true }), fc.boolean(),
      (inner1Mm, inner2Mm, wallMm, heightMm, width, ratio, placement, closure, left, clearanceMm, torus) => {
        const part = torus ? torusRingPart({ inner1Mm, inner2Mm, widthMm: heightMm }) : tubeRingPart({ inner1Mm, inner2Mm, wallMm, heightMm });
        const { summary } = evaluateFit({
          parts: fixtureModel('Ring', [part]), choice: { kind: 'part', partId: 'band' },
          wrist: wristMeasurement(width, width * ratio, { taper: 0.12, passageMm: width + 12 }), placement, closure, clearanceMm, sign: left ? -1 : 1,
        }).analysis;
        return FitSummarySchema.safeParse(summary).success && summary.classes.length === FIT_ANGLES;
      }), 200);
  });
});

describe('invariants of the gap maths (design 6.8)', () => {
  /** A ring part within the body ranges: a tube or a torus with a random inner ellipse and band width. */
  const ring = fc.record({
    torus: fc.boolean(), inner1: fc.double({ min: 25, max: 38, noNaN: true }), inner2: fc.double({ min: 25, max: 38, noNaN: true }),
    wall: fc.double({ min: 4, max: 6, noNaN: true }), half: fc.double({ min: 3, max: 20, noNaN: true }),
  });
  const wristSize = fc.record({ width: fc.double({ min: 45, max: 80, noNaN: true }), ratio: fc.double({ min: 0.55, max: 0.8, noNaN: true }) });
  const placementArb = fc.record({
    slideMm: fc.double({ min: -40, max: 60, noNaN: true }), tiltDeg: fc.double({ min: -30, max: 30, noNaN: true }), rollDeg: fc.double({ min: -180, max: 180, noNaN: true }),
  });

  const ringModel = (spec: { torus: boolean; inner1: number; inner2: number; wall: number; half: number }, scale = 1) => {
    const part = spec.torus
      ? torusRingPart({ inner1Mm: spec.inner1 * scale, inner2Mm: spec.inner2 * scale, widthMm: 2 * spec.half * scale })
      : tubeRingPart({ inner1Mm: spec.inner1 * scale, inner2Mm: spec.inner2 * scale, wallMm: spec.wall * scale, heightMm: 2 * spec.half * scale });
    return fixtureModel('Ring', [part]);
  };

  const scaleWrist = (w: WristMeasurement, s: number): WristMeasurement => {
    const m = <T extends { mm: number; spreadMm: number | null } | null>(value: T): T => (value ? { ...value, mm: value.mm * s } : value) as T;
    return {
      ...w, width: m(w.width), thickness: m(w.thickness), circumference: m(w.circumference), passage: m(w.passage),
      profile: w.profile.map(slice => ({ offsetMm: slice.offsetMm * s, width: m(slice.width), thickness: m(slice.thickness) })),
    };
  };

  /** The summaries of a ring and of the same ring with every length scaled by `s`. */
  const scaledPair = (spec: Parameters<typeof ringModel>[0], size: { width: number; ratio: number }, placement: Placement, s: number, clearance: number, left: boolean, taper: number) => {
    const wrist = wristMeasurement(size.width, size.width * size.ratio, { taper, passageMm: size.width + 10 });
    const common = { choice: { kind: 'part', partId: 'band' } as const, closure: 'closed' as const, sign: left ? -1 as const : 1 as const };
    const one = evaluateFit({ parts: ringModel(spec), wrist, placement, clearanceMm: clearance, ...common }).analysis.summary;
    const two = evaluateFit({
      parts: ringModel(spec, s), wrist: scaleWrist(wrist, s), placement: { ...placement, slideMm: placement.slideMm * s }, clearanceMm: clearance * s, ...common,
    }).analysis.summary;
    return { one, two };
  };
  const closeBy = (s: number, one: FitSummary, two: FitSummary, gapTolerance: number) =>
    Math.abs(two.minGap.mm - s * one.minGap.mm) <= gapTolerance && Math.abs(two.maxGap.mm - s * one.maxGap.mm) <= gapTolerance
    // A perimeter has 72 points that are each found within 1/64 mm; the polygon moves by a small multiple of that.
    && Math.abs(two.innerMm! - s * one.innerMm!) <= 0.3 && Math.abs(two.spareMm! - s * one.spareMm!) <= 0.35
    && Math.abs(two.wrist.mm - s * one.wrist.mm) <= 0.02;

  it('scales every gap and perimeter by s when every length is scaled by s (straight arm, no tilt)', () => {
    // Each distance is found within 1/64 mm on the solid side, so the two searches differ by at most max(1, s) / 64.
    checkProperty('scaling all lengths by s scales gaps and perimeters by s', fc.property(
      ring, wristSize, fc.double({ min: -40, max: 60, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }),
      fc.double({ min: 0.5, max: 2, noNaN: true }), fc.double({ min: 0, max: 40, noNaN: true }), fc.boolean(),
      (spec, size, slideMm, rollDeg, s, clearance, left) => {
        const { one, two } = scaledPair(spec, size, { slideMm, tiltDeg: 0, rollDeg }, s, clearance, left, 0);
        return closeBy(s, one, two, Math.max(1, s) / 64 + 0.02);
      }), 200);
  });

  it('scales a tube ring with tilt and taper too, up to the fixed 0.5 mm edge inset of the slices', () => {
    // The edge slices lie 0.5 mm inside the band edge whatever the size, so after scaling they sit at a slightly different
    // relative height. That moves a gap by at most the slope of the arm along the band times 0.5 |s - 1| (design 6.4).
    checkProperty('scaling a tube ring with tilt and taper scales gaps within the inset allowance', fc.property(
      ring, wristSize, placementArb, fc.double({ min: 0.5, max: 2, noNaN: true }), fc.double({ min: 0, max: 40, noNaN: true }), fc.boolean(), fc.double({ min: 0, max: 0.2, noNaN: true }),
      (spec, size, placement, s, clearance, left, taper) => {
        const tube = { ...spec, torus: false };
        const { one, two } = scaledPair(tube, size, placement, s, clearance, left, taper);
        const slope = Math.tan(rad(Math.abs(placement.tiltDeg))) + taper;
        return closeBy(s, one, two, Math.max(1, s) / 64 + 0.5 * Math.abs(s - 1) * slope + 0.03);
      }), 200);
  });
  it('makes the smallest gap larger by almost nothing at most with more tilt, on a tapered arm', () => {
    // Found by fast-check: a tube of inner radius 25 mm and half-width 3 mm on a 45 x 24.75 mm wrist with a taper of 4.4e-9, tilted
    // by 0 and then 0.0027 degrees. The smallest gap is on the slice toward the elbow, where the arm is wider; a tilt moves that slice's
    // section sideways, so along x the arm is narrower there and the smallest gap rises by 1e-9 mm. The rise stays far below 0.02 mm in
    // 12 000 further random cases, so this property allows 0.05 mm; on a straight arm there is no rise at all (the next test).
    const slender = fixtureModel('Slender', [tubeRingPart({ inner1Mm: 25, inner2Mm: 25, wallMm: 4, heightMm: 6 })]);
    const smallest = (tiltDeg: number, taper: number) => Math.min(...evaluateFit({
      parts: slender, choice: { kind: 'part', partId: 'band' }, wrist: wristMeasurement(45, 24.75, { taper }), placement: { ...DEFAULT_PLACEMENT, tiltDeg }, closure: 'closed', clearanceMm: 13, sign: 1,
    }).analysis.angles.map(entry => entry.gapMm!));
    const rise = smallest(0.002673938736298001, 4.427281652397142e-9) - smallest(0, 4.427281652397142e-9);
    expect(rise).toBeGreaterThan(0);
    expect(rise).toBeLessThan(1e-6);
    checkProperty('more tilt raises the smallest gap by less than 0.05 mm (tapered arm)', fc.property(
      ring, wristSize, fc.double({ min: 0, max: 30, noNaN: true }), fc.double({ min: 0, max: 30, noNaN: true }), fc.double({ min: 0, max: 0.2, noNaN: true }),
      (spec, size, t1, t2, taper) => {
        const [low, high] = t1 <= t2 ? [t1, t2] : [t2, t1];
        const tight = (tiltDeg: number) => Math.min(...evaluateFit({
          parts: ringModel(spec), choice: { kind: 'part', partId: 'band' }, wrist: wristMeasurement(size.width, size.width * size.ratio, { taper }),
          placement: { ...DEFAULT_PLACEMENT, tiltDeg }, closure: 'closed', clearanceMm: 13, sign: 1,
        }).analysis.angles.map(entry => entry.gapMm!));
        return tight(high) <= tight(low) + 0.05;
      }), 200);
  });

  it('never makes the smallest gap larger with more tilt, on a straight arm', () => {
    checkProperty('more tilt never makes the smallest gap larger (straight arm)', fc.property(
      ring, wristSize, fc.double({ min: 0, max: 30, noNaN: true }), fc.double({ min: 0, max: 30, noNaN: true }), fc.double({ min: -40, max: 60, noNaN: true }),
      fc.double({ min: -180, max: 180, noNaN: true }), fc.constantFrom<1 | -1>(1, -1),
      (spec, size, t1, t2, slideMm, rollDeg, sign) => {
        const [low, high] = t1 <= t2 ? [t1, t2] : [t2, t1];
        const wrist = wristMeasurement(size.width, size.width * size.ratio);
        const smallest = (tiltDeg: number) => {
          const { analysis } = evaluateFit({
            parts: ringModel(spec), choice: { kind: 'part', partId: 'band' }, wrist, placement: { slideMm, tiltDeg, rollDeg }, closure: 'closed', clearanceMm: 13, sign,
          });
          return Math.min(...analysis.angles.map(entry => entry.gapMm!));
        };
        return smallest(high) <= smallest(low) + 1e-9;
      }), 200);
  });
});

describe('camera, card and tape (design 5.4)', () => {
  const camera = (w: number, t: number, source: 'estimate' | 'card' = 'estimate') => ({
    width: { mm: w, source, spreadMm: 1 }, thickness: { mm: t, source, spreadMm: 0.5 },
  });
  const none = { camera: null, tapeCircumferenceMm: null, typedWidthMm: null, typedThicknessMm: null };

  it('uses the camera alone with its source, its ellipse perimeter and a propagated spread', () => {
    const result = wristEllipse({ ...none, camera: camera(58, 39) })!;
    expect(result.width).toEqual({ mm: 58, source: 'estimate', spreadMm: 1 });
    expect(result.circumference.mm).toBeCloseTo(ellipsePerimeter(29, 19.5), 9);
    expect(result.circumference.source).toBe('estimate');
    expect(result.circumference.spreadMm).toBeGreaterThan(0.5);
    expect(result.circumference.spreadMm).toBeLessThan(3);
    expect(result.thicknessAssumed).toBe(false);
    expect(result.profileScale).toBe(1);
    expect(result.cameraCircumferenceMm).toBeCloseTo(result.circumference.mm, 9);
    expect(wristEllipse({ ...none, camera: camera(58, 39, 'card') })!.circumference.source).toBe('card');
    expect(wristEllipse({ ...none, camera: { width: { mm: 58, source: 'estimate', spreadMm: null }, thickness: { mm: 39, source: 'estimate', spreadMm: 1 } } })!.circumference.spreadMm).toBeNull();
  });

  it('keeps the camera shape and scales it to the tape circumference', () => {
    const result = wristEllipse({ ...none, camera: camera(58, 39), tapeCircumferenceMm: 165 })!;
    expect(result.circumference).toEqual({ mm: 165, source: 'tape', spreadMm: null });
    expect(ellipsePerimeter(result.width.mm / 2, result.thickness.mm / 2)).toBeCloseTo(165, 9);
    expect(result.thickness.mm / result.width.mm).toBeCloseTo(39 / 58, 9);
    expect(result.width.source).toBe('tape');
    expect(result.profileScale).toBeCloseTo(result.width.mm / 58, 9);
    expect(result.thicknessAssumed).toBe(false);
    expect(result.cameraCircumferenceMm).toBeCloseTo(ellipsePerimeter(29, 19.5), 9);
  });

  it('assumes a thickness of 0.65 of the width from the tape alone', () => {
    const result = wristEllipse({ ...none, tapeCircumferenceMm: 160 })!;
    expect(result.thickness.mm / result.width.mm).toBeCloseTo(0.65, 9);
    expect(ellipsePerimeter(result.width.mm / 2, result.thickness.mm / 2)).toBeCloseTo(160, 9);
    expect(result.thicknessAssumed).toBe(true);
    expect(result.profileScale).toBe(1);
    expect(result.cameraCircumferenceMm).toBeNull();
  });

  it('lets typed values replace the camera ones', () => {
    const both = wristEllipse({ ...none, camera: camera(58, 39), typedWidthMm: 62, typedThicknessMm: 42 })!;
    expect(both.width).toEqual({ mm: 62, source: 'tape', spreadMm: null });
    expect(both.thickness.mm).toBe(42);
    expect(both.circumference.mm).toBeCloseTo(ellipsePerimeter(31, 21), 9);
    expect(both.profileScale).toBeCloseTo(62 / 58, 9);
    // One typed value: the other axis follows the tape, else the camera, else the ratio.
    const withTape = wristEllipse({ ...none, camera: camera(58, 39), tapeCircumferenceMm: 165, typedWidthMm: 62 })!;
    expect(withTape.width.mm).toBe(62);
    expect(ellipsePerimeter(31, withTape.thickness.mm / 2)).toBeCloseTo(165, 6);
    const onlyThickness = wristEllipse({ ...none, tapeCircumferenceMm: 165, typedThicknessMm: 40 })!;
    expect(ellipsePerimeter(onlyThickness.width.mm / 2, 20)).toBeCloseTo(165, 6);
    expect(wristEllipse({ ...none, camera: camera(58, 39), typedWidthMm: 62 })!.thickness.mm).toBe(39);
    const ratio = wristEllipse({ ...none, typedWidthMm: 60 })!;
    expect(ratio.thickness.mm).toBeCloseTo(39, 9);
    expect(ratio.thicknessAssumed).toBe(true);
  });

  it('is null with nothing to go on, or with a size the tape circumference cannot belong to', () => {
    expect(wristEllipse(none)).toBeNull();
    expect(wristEllipse({ ...none, tapeCircumferenceMm: 100, typedWidthMm: 120 })).toBeNull();
  });

  it('scales a profile and its spreads', () => {
    const wrist = wristMeasurement(60, 40, { source: 'estimate', spreadMm: 1 });
    const scaled = scaleProfile(wrist.profile, 1.1);
    expect(scaled).toHaveLength(wrist.profile.length);
    expect(scaled[0]!.offsetMm).toBe(wrist.profile[0]!.offsetMm);
    expect(scaled[0]!.width!.mm).toBeCloseTo(wrist.profile[0]!.width!.mm * 1.1, 9);
    expect(scaled[0]!.width).toMatchObject({ source: 'tape' });
    expect(scaled[0]!.width!.spreadMm).toBeCloseTo(1.1, 9);
    expect(scaleProfile([{ offsetMm: 0, width: null, thickness: null }], 2)[0]).toEqual({ offsetMm: 0, width: null, thickness: null });
  });

  it('gives a combined measurement whose perimeter equals the tape value for any shape', () => {
    checkProperty('tape circumference is reproduced by the combined ellipse', fc.property(
      fc.double({ min: 100, max: 300, noNaN: true }), fc.double({ min: 40, max: 80, noNaN: true }), fc.double({ min: 0.4, max: 1, noNaN: true }),
      (tape, width, ratio) => {
        const result = wristEllipse({ ...none, camera: camera(width, width * ratio), tapeCircumferenceMm: tape })!;
        return Math.abs(ellipsePerimeter(result.width.mm / 2, result.thickness.mm / 2) - tape) < 1e-6
          && Math.abs(result.thickness.mm / result.width.mm - ratio) < 1e-9;
      }), 300);
  });
});

describe('robust median and spread (R23, R73)', () => {
  it('drops values beyond 3 median absolute deviations and reports the spread of the rest', () => {
    const result = robustMedian([30, 30.2, 29.8, 30.1, 29.9, 30, 45])!;
    expect(result.dropped).toBe(1);
    expect(result.kept).toBe(6);
    expect(result.value).toBeCloseTo(30, 9);
    expect(result.spread).toBeCloseTo(0.1482, 3);
    expect(spread([30, 30.2, 29.8, 30.1, 29.9, 30])).toBeCloseTo(0.1482, 3);
  });

  it('handles an empty list, one value, and values that are all equal', () => {
    expect(robustMedian([])).toBeNull();
    expect(robustMedian([12])).toEqual({ value: 12, spread: 0, kept: 1, dropped: 0 });
    expect(robustMedian([5, 5, 5, 5])).toEqual({ value: 5, spread: 0, kept: 4, dropped: 0 });
    expect(spread([3])).toBe(0);
  });

  it('is the median and a non-negative spread, stays within the data, and ignores one far outlier', () => {
    checkProperty('robust median lies in the data range and ignores a far outlier', fc.property(
      fc.array(fc.double({ min: 20, max: 80, noNaN: true }), { minLength: 5, maxLength: 20 }), (values) => {
        const result = robustMedian(values)!;
        const withOutlier = robustMedian([...values, 1e6])!;
        return result.value >= Math.min(...values) && result.value <= Math.max(...values) && result.spread >= 0
          && result.kept + result.dropped === values.length && withOutlier.value <= Math.max(...values) + 1e-9;
      }), 300);
  });
});

describe('class runs and text (R54, R83)', () => {
  it('finds runs of equal classes around the circle, naming the side of their middle', () => {
    const classes = 'g'.repeat(12) + 'r'.repeat(11) + 'g'.repeat(49);
    expect(classRuns(classes)).toEqual([
      { cls: 'r', fromDeg: 60, toDeg: 110, midDeg: 85 },
      { cls: 'g', fromDeg: 115, toDeg: 55, midDeg: 265 },
    ]);
    expect(classRuns('g'.repeat(72))).toEqual([{ cls: 'g', fromDeg: 0, toDeg: 355, midDeg: 177.5 }]);
    expect(classRuns('')).toEqual([]);
  });

  it('writes the strings of the requirements', () => {
    const summary: FitSummary = {
      state: 'presses', innerMm: 180, wrist: { mm: 165, source: 'tape', spreadMm: null }, spareMm: 15, clearanceMm: 13,
      minGap: { mm: 1.5, angleDeg: 0 }, maxGap: { mm: 9, angleDeg: 180 }, classes: 'g'.repeat(12) + 'r'.repeat(11) + 'g'.repeat(49),
      openingDeg: null, openingAtDeg: null, ringPartId: 'band',
    };
    expect(FIT_TEXT.inner(summary)).toBe('內圍 180 mm · 手腕 165 mm（捲尺）· 餘量 15 mm');
    expect(FIT_TEXT.tightest(summary)).toBe('最緊 1.5 mm（手背側）');
    expect(rangeLines(summary)[0]).toBe('壓迫：拇指側 60°–110°');
    expect(summaryLines(summary)).toEqual([
      '內圍 180 mm · 手腕 165 mm（捲尺）· 餘量 15 mm', '最緊 1.5 mm（手背側）', '最鬆 9 mm（掌心側）', '壓迫：拇指側 60°–110°', '合適：小指側 115°–55°',
    ]);
    expect(FIT_TEXT.opening(40, 270)).toBe('開口 40°（小指側）');
    expect(summaryLines({ ...summary, state: 'no-ring' })).toEqual(['這個物件沒有環繞手腕的部分，只顯示位置。']);
    expect(summaryLines({ ...summary, state: 'cannot-pass' })).toEqual([
      '內圍 180 mm · 手腕 165 mm（捲尺）· 餘量 15 mm', '封閉手環的內圍小於手掌最寬處，戴不進去。可加大內圍或改成有扣環。',
    ]);
    expect(summaryLines({ ...summary, innerMm: null, spareMm: null, openingDeg: 40, openingAtDeg: 270 })[0]).toBe('開口 40°（小指側）');
  });

  it('writes the wrist result, the tape error and the result of fit_to_body', () => {
    const tape = { mm: 165, source: 'tape', spreadMm: null } as const;
    const estimate = (mm: number) => ({ mm, source: 'estimate', spreadMm: null }) as const;
    expect(FIT_TEXT.wristResult(estimate(58), estimate(39), estimate(155))).toBe('寬 58 mm · 厚 39 mm · 周長 155 mm（相機估計）');
    expect(FIT_TEXT.cameraError(155, 165)).toBe('相機估計 155 mm，捲尺 165 mm，相機偏小 10 mm（6.1%）');
    expect(FIT_TEXT.cameraError(170, 165, 'card')).toBe('卡片校正 170 mm，捲尺 165 mm，相機偏大 5 mm（3.0%）');
    expect(FIT_TEXT.tapeRange(100, 300)).toBe('請輸入 100–300 mm 之間的數值。');
    expect(FIT_TEXT.noMeasurement).toBe('還沒有手腕尺寸。請先在試戴面板量測手腕或輸入捲尺數值。');
    expect(FIT_TEXT.resizeNeedsAi).toBe('這個形狀請交給 AI 調整。');
    const fits: FitSummary = {
      state: 'fits', innerMm: 171, wrist: tape, spareMm: 6, clearanceMm: 6, minGap: { mm: 0.95, angleDeg: 90 }, maxGap: { mm: 0.95, angleDeg: 90 },
      classes: 'g'.repeat(72), openingDeg: null, openingAtDeg: null, ringPartId: 'band',
    };
    expect(fitResultLine(fits, 'snug')).toBe('已調整：內圍 171 mm，手腕 165 mm（捲尺），餘量 6 mm（貼合）。全部角度合適。');
    const tight = { ...fits, state: 'presses' as const, classes: 'g'.repeat(12) + 'r'.repeat(11) + 'g'.repeat(49) };
    expect(fitResultLine(tight, 'comfort')).toBe('已調整：內圍 171 mm，手腕 165 mm（捲尺），餘量 6 mm（舒適）。還有地方不合適（壓迫：拇指側 60°–110°）。可以再試一次。');
  });

  it('labels sides, sources, classes, clearances and closures', () => {
    expect([0, 44.9, 45, 90, 134.9, 135, 180, 224.9, 225, 270, 314.9, 315, 359.9, -90, 450].map(sideLabel)).toEqual([
      '手背側', '手背側', '拇指側', '拇指側', '拇指側', '掌心側', '掌心側', '掌心側', '小指側', '小指側', '小指側', '手背側', '手背側', '小指側', '拇指側',
    ]);
    expect(['estimate', 'card', 'tape'].map(source => sourceLabel(source as 'tape'))).toEqual(['相機估計', '卡片校正', '捲尺']);
    expect((['fits', 'presses', 'loose'] as const).map(classLabel)).toEqual(['合適', '壓迫', '偏鬆']);
    expect((['snug', 'comfort', 'loose', 'custom'] as const).map(clearanceLabel)).toEqual(['貼合', '舒適', '寬鬆', '自訂']);
    expect((['closed', 'open', 'clasp'] as const).map(closureLabel)).toEqual(['封閉', '開口', '有扣環或可打開']);
    expect(CLASS_COLORS).toEqual({ fits: '#009E73', presses: '#D55E00', loose: '#E69F00' });
  });

  it('shows a value with its source and its spread', () => {
    expect(formatMeasured({ mm: 165, source: 'tape', spreadMm: null })).toBe('165 mm（捲尺）');
    expect(formatMeasured({ mm: 155.04, source: 'estimate', spreadMm: 1.23 })).toBe('155 mm ± 1.2 mm（相機估計）');
    expect(formatMeasured({ mm: 58.46, source: 'card', spreadMm: 0 })).toBe('58.5 mm ± 0 mm（卡片校正）');
    expect(formatMm(1.5)).toBe('1.5');
    expect(formatMm(-0.04)).toBe('0');
    expect(formatMm(12)).toBe('12');
  });
});

describe('the fit of a band with a case', () => {
  it('the case does not change the inner profile of its band', () => {
    const wrist = wristMeasurement(60, 40);
    const withCase = evaluateFit({ parts: bandWithCase(), choice: null, wrist, placement: DEFAULT_PLACEMENT, closure: 'closed', clearanceMm: 13, sign: 1 });
    const alone = evaluateFit({ parts: tubeBand(), choice: null, wrist, placement: DEFAULT_PLACEMENT, closure: 'closed', clearanceMm: 13, sign: 1 });
    expect(withCase.analysis.summary.innerMm).toBe(alone.analysis.summary.innerMm);
    expect(withCase.analysis.summary.classes).toBe(alone.analysis.summary.classes);
    expect(withCase.analysis.summary.ringPartId).toBe('band');
    expect(fitSummary({
      inner: withCase.inner!, wrist, placement: DEFAULT_PLACEMENT, closure: 'closed', clearanceMm: 13, sign: 1, ringPartId: 'band',
    })).toEqual(withCase.analysis.summary);
    expect(withCase.analysis.summary.innerMm).toBeGreaterThan(190);
    expect(withCase.analysis.summary.innerMm).toBeLessThan(197);
  });
});
