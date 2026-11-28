import { Quaternion, Vector3 } from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AXIS_SEARCH_MM, CROP_SIDE_MM, FOREARM_FLAT_DEG, MEASURE_FRAMES, MEASURE_SPREAD_MM, PALM_FACING_DEG, SEGMENT_SIZE, STILL_MM_PER_S,
} from '../../shared/fit-constants';
import { cropTransform, frameToMask, lumaOf, maskToFrame, quantize, sample, wristCrop } from '../../src/fit/mask';
import {
  MeasureStep, PROFILE_OFFSETS, forearmFlat, mmPerPx, mmPerMaskPx, offsetRow, palmFacing, stepOffsets, stepReason, stillness, widthAcross,
  type StepInput, type StepKind,
} from '../../src/fit/measure';
import type { HandLandmarks, SegmentCrop } from '../../src/try-on/arm-pose';
import { forearmMask, forearmSkinMask, type ForearmSpec } from '../fixtures/fit-mask';
import { checkProperty, fc, printPropertyReport } from '../fixtures/fit-property';
import { syntheticHand } from '../fixtures/synthetic-hand';

afterAll(() => printPropertyReport('fit-measure'));

const unit = (deg: number) => ({ x: Math.cos(deg * Math.PI / 180), y: Math.sin(deg * Math.PI / 180) });

describe('crop geometry (design 4.2)', () => {
  it('maps mask points to frame points and back', () => {
    const crop: SegmentCrop = { x: 300, y: 200, size: 160, angleDeg: 37 };
    for (const [mx, my] of [[0, 0], [128, 128], [256, 0], [10.5, 240.25]] as const) {
      const frame = maskToFrame(crop, mx, my);
      const back = frameToMask(crop, frame.x, frame.y);
      expect(back.x).toBeCloseTo(mx, 9);
      expect(back.y).toBeCloseTo(my, 9);
    }
    expect(maskToFrame(crop, 128, 128)).toEqual({ x: 300, y: 200 });
  });
  it('cropTransform is the inverse of maskToFrame', () => {
    const crop: SegmentCrop = { x: 410, y: 95, size: 220, angleDeg: -130 };
    const [a, b, c, d, e, f] = cropTransform(crop);
    for (const [mx, my] of [[0, 0], [256, 256], [77, 201]] as const) {
      const frame = maskToFrame(crop, mx, my);
      expect(a * frame.x + c * frame.y + e).toBeCloseTo(mx, 9);
      expect(b * frame.x + d * frame.y + f).toBeCloseTo(my, 9);
    }
  });
  it('wristCrop puts the hand side up and sizes the crop in millimetres', () => {
    const scale = 0.8;
    for (const angle of [-90, -30, 0, 45, 90, 135, 180, -170]) {
      const distal = unit(angle);
      const crop = wristCrop({ x: 320, y: 240 }, distal, scale);
      expect(crop.size).toBeCloseTo(CROP_SIDE_MM / scale, 9);
      // The top-centre of the mask lies toward the hand, the bottom-centre toward the elbow.
      const top = maskToFrame(crop, 128, 0);
      const bottom = maskToFrame(crop, 128, 256);
      expect((top.x - 320) * distal.x + (top.y - 240) * distal.y).toBeCloseTo(crop.size / 2, 6);
      expect((bottom.x - 320) * distal.x + (bottom.y - 240) * distal.y).toBeCloseTo(-crop.size / 2, 6);
    }
    expect(wristCrop({ x: 1, y: 2 }, { x: 0, y: -1 }, 1).angleDeg).toBeCloseTo(0, 9);
  });
  it('samples bilinearly between pixel centres and is zero outside the mask', () => {
    const plane = new Uint8Array(4 * 4);
    plane[1 * 4 + 1] = 255;
    expect(sample(plane, 4, 1.5, 1.5)).toBeCloseTo(1, 9);
    expect(sample(plane, 4, 2, 1.5)).toBeCloseTo(0.5, 9);
    expect(sample(plane, 4, 2, 2)).toBeCloseTo(0.25, 9);
    expect(sample(plane, 4, 3.9, 3.9)).toBe(0);
    expect(sample(plane, 4, -0.1, 1)).toBe(0);
    expect(sample(plane, 4, 4.1, 1)).toBe(0);
  });
  it('quantises confidences to bytes and averages luma', () => {
    expect([...quantize([-1, 0, 0.5, 1, 2])]).toEqual([0, 0, 128, 255, 255]);
    expect(lumaOf([255, 255, 255, 255, 0, 0, 0, 255])).toBeCloseTo(0.5, 9);
    expect(lumaOf([255, 0, 0, 255])).toBeCloseTo(0.2126, 9);
    expect(lumaOf([0, 255, 0, 255])).toBeCloseTo(0.7152, 9);
    expect(lumaOf([])).toBe(0);
    expect(SEGMENT_SIZE).toBe(256);
  });
});

describe('millimetres per pixel (design 5.1)', () => {
  const frame = { width: 400, height: 400 };
  it('recovers the scale of a synthetic hand of known size', () => {
    // The synthetic hand is 0.18 m high and drawn 0.25 of the frame height high: 180 mm over 100 px.
    const hand = syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08, size: 0.25 });
    expect(mmPerPx(hand, frame)).toBeCloseTo(1.8, 6);
    const near = syntheticHand({ cursor: { x: 0.4, y: 0.6 }, pinchM: 0.03, size: 0.4 });
    expect(mmPerPx(near, frame)).toBeCloseTo(1.125, 6);
  });
  it('does not change when the hand turns in the image plane', () => {
    const turned = syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08, size: 0.25, roll: 40 });
    expect(mmPerPx(turned, frame)).toBeCloseTo(1.8, 6);
  });
  it('multiplies by the calibration factor', () => {
    const hand = syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08 });
    expect(mmPerPx(hand, frame, 1.05)).toBeCloseTo(1.8 * 1.05, 6);
  });
  it('returns null without world landmarks, with a flat hand or a bad factor', () => {
    expect(mmPerPx(syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08, world: false }), frame)).toBeNull();
    const collapsed: HandLandmarks = { side: 'right', points: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 })), world: syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08 }).world };
    expect(mmPerPx(collapsed, frame)).toBeNull();
    expect(mmPerPx(syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08 }), frame, 0)).toBeNull();
    expect(mmPerPx(syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08 }), { width: 0, height: 400 })).toBeNull();
  });
});

describe('widthAcross (design 5.2)', () => {
  /** A vertical forearm in an upright crop where one frame pixel is one mask pixel. */
  const upright = (widthPx: number, extra: Partial<ForearmSpec> = {}): ForearmSpec => ({
    crop: { x: 500, y: 300, size: SEGMENT_SIZE, angleDeg: 0 }, point: { x: 500, y: 300 }, axisDeg: -90, widthPx, ...extra,
  });
  it('reads the width of a vertical band with sub-pixel edges', () => {
    const spec = upright(40);
    const reading = widthAcross(forearmSkinMask(spec), { mmPerPx: 0.5, row: 128 });
    expect(reading).not.toBeNull();
    expect(reading!.widthMaskPx).toBeCloseTo(40, 1);
    expect(reading!.widthMm).toBeCloseTo(20, 1);
    expect(reading!.leftMaskPx).toBeCloseTo(108, 1);
    expect(reading!.rightMaskPx).toBeCloseTo(148, 1);
  });
  it('turns pixels into millimetres through the crop size and the scale', () => {
    // A 150-pixel crop shows 256 mask pixels, so one mask pixel is 150 / 256 frame pixels.
    const crop: SegmentCrop = { x: 200, y: 200, size: 150, angleDeg: 0 };
    const mask = forearmSkinMask({ crop, point: { x: 200, y: 200 }, axisDeg: -90, widthPx: 60 });
    const reading = widthAcross(mask, { mmPerPx: 1.2, row: 128 })!;
    expect(reading.widthMm).toBeCloseTo(72, 0);
    expect(mmPerMaskPx(mask, 1.2)).toBeCloseTo(1.2 * 150 / 256, 9);
  });
  it('finds the row of an offset along the arm: toward the elbow is down the mask', () => {
    const mask = forearmSkinMask(upright(30));
    expect(offsetRow(mask, 0, 0.5)).toBe(128);
    expect(offsetRow(mask, 20, 0.5)).toBeCloseTo(128 + 40, 9);
    expect(offsetRow(mask, -20, 0.5)).toBeCloseTo(128 - 40, 9);
  });
  it('reads the same width along the whole profile of a straight forearm', () => {
    const mask = forearmSkinMask(upright(50));
    for (const offset of PROFILE_OFFSETS) {
      const reading = widthAcross(mask, { mmPerPx: 0.5, row: offsetRow(mask, offset, 0.5) });
      expect(reading?.widthMaskPx).toBeCloseTo(50, 1);
    }
  });
  it('is one mask pixel wide at most when the edge is a hard step', () => {
    for (const width of [20, 31, 77.5, 120]) {
      const reading = widthAcross(forearmSkinMask(upright(width, { blurMaskPx: 0 })), { mmPerPx: 1, row: 128 })!;
      expect(Math.abs(reading.widthMaskPx - width)).toBeLessThanOrEqual(1);
    }
  });
  it('measures a tilted forearm across its axis when the crop follows the axis, and lengthened by 1 / cos when it does not', () => {
    const point = { x: 320, y: 240 };
    const direction = unit(-60);
    const aligned = wristCrop(point, direction, 1);
    const spec: ForearmSpec = { crop: aligned, point, axisDeg: -60, widthPx: 0.2 * aligned.size };
    // The edge ramp is sampled between pixel centres, so the reading is within a quarter of a mask pixel, not exact.
    expect(Math.abs(widthAcross(forearmSkinMask(spec), { mmPerPx: 1, row: 128 })!.widthMaskPx - 0.2 * 256)).toBeLessThan(0.25);
    // A crop 20 degrees off the axis cuts the band at a slant.
    const skewed = { ...aligned, angleDeg: aligned.angleDeg + 20 };
    const slanted = widthAcross(forearmSkinMask({ ...spec, crop: skewed }), { mmPerPx: 1, row: 128 })!;
    expect(Math.abs(slanted.widthMaskPx - 0.2 * 256 / Math.cos(20 * Math.PI / 180))).toBeLessThan(0.5);
  });
  it('uses the nearest skin within AXIS_SEARCH_MM when the axis is off the skin, and nothing beyond', () => {
    const scale = 0.5;
    const mmPerMask = scale * SEGMENT_SIZE / SEGMENT_SIZE;
    const reach = AXIS_SEARCH_MM / mmPerMask;
    // A 20-pixel band whose near edge is `gap` pixels right of the axis (column 128).
    const band = (gap: number) => forearmSkinMask(upright(20, { point: { x: 500 + gap + 10, y: 300 } }));
    const near = widthAcross(band(reach - 4), { mmPerPx: scale, row: 128 });
    expect(near?.widthMaskPx).toBeCloseTo(20, 1);
    expect(widthAcross(band(reach + 4), { mmPerPx: scale, row: 128 })).toBeNull();
    // Off to the left as well.
    const left = forearmSkinMask(upright(20, { point: { x: 500 - (reach - 4) - 10, y: 300 } }));
    expect(widthAcross(left, { mmPerPx: scale, row: 128 })?.widthMaskPx).toBeCloseTo(20, 1);
  });
  it('returns null for no skin, a row outside the mask, a run that touches the border, and clothes only', () => {
    const empty = { size: 256, crop: upright(10).crop, skin: new Uint8Array(256 * 256), clothes: new Uint8Array(256 * 256).fill(255), ms: 0, timestamp: 0 };
    expect(widthAcross(empty, { mmPerPx: 1, row: 128 })).toBeNull();
    const mask = forearmSkinMask(upright(40));
    expect(widthAcross(mask, { mmPerPx: 1, row: -1 })).toBeNull();
    expect(widthAcross(mask, { mmPerPx: 1, row: 300 })).toBeNull();
    expect(widthAcross(mask, { mmPerPx: 0, row: 128 })).toBeNull();
    const wide = forearmSkinMask(upright(400));
    expect(widthAcross(wide, { mmPerPx: 1, row: 128 })).toBeNull();
  });
  it('stops at a sleeve: skin rows are measured, rows under the sleeve are not', () => {
    // The sleeve starts 30 pixels toward the elbow (below the crop centre).
    const mask = forearmSkinMask(upright(40, { sleeve: { fromPx: 30, extraPx: 8 } }));
    expect(widthAcross(mask, { mmPerPx: 1, row: 128 + 10 })?.widthMaskPx).toBeCloseTo(40, 1);
    expect(widthAcross(mask, { mmPerPx: 1, row: 128 + 50 })).toBeNull();
    // The clothes plane holds the sleeve there.
    expect(mask.clothes[(128 + 50) * 256 + 128]).toBe(255);
    expect(mask.skin[(128 + 50) * 256 + 128]).toBe(0);
  });
  it('recovers a band within one mask pixel at any angle (design 6.8, R114)', () => {
    checkProperty('widthAcross within one mask pixel', fc.property(
      fc.double({ min: 20, max: 120, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }), fc.double({ min: 0, max: 2, noNaN: true }),
      fc.double({ min: 0.3, max: 3, noNaN: true }), fc.double({ min: -600, max: 600, noNaN: true }), fc.double({ min: -600, max: 600, noNaN: true }),
      (widthMaskPx, angleDeg, blurMaskPx, scale, x, y) => {
        const point = { x, y };
        const crop = wristCrop(point, unit(angleDeg), scale);
        const widthPx = widthMaskPx * crop.size / SEGMENT_SIZE;
        const mask = forearmSkinMask({ crop, point, axisDeg: angleDeg, widthPx, blurMaskPx });
        const reading = widthAcross(mask, { mmPerPx: scale, row: 128 });
        return reading !== null && Math.abs(reading.widthMaskPx - widthMaskPx) <= 1
          && Math.abs(reading.widthMm - widthPx * scale) <= mmPerMaskPx(mask, scale);
      }), 300);
  });
});

describe('forearm mask fixture', () => {
  it('draws anti-aliased edges and a sleeve in the second plane', () => {
    const spec: ForearmSpec = { crop: { x: 100, y: 100, size: 256, angleDeg: 0 }, point: { x: 100, y: 100 }, axisDeg: -90, widthPx: 40, blurMaskPx: 2, sleeve: { fromPx: 20, extraPx: 5 } };
    const { skin, clothes } = forearmMask(spec);
    expect(skin[100 * 256 + 128]).toBe(255);
    expect(skin[100 * 256 + 100]).toBe(0);
    const edge = [...skin.slice(100 * 256 + 106, 100 * 256 + 112)];
    expect(edge.some(value => value > 0 && value < 255)).toBe(true);
    expect(clothes[200 * 256 + 128]).toBe(255);
    expect(clothes[200 * 256 + 128 + 20]).toBe(255);
    expect(clothes[200 * 256 + 128 + 40]).toBe(0);
    expect(clothes[100 * 256 + 128]).toBe(0);
  });
});

describe('pose checks (design 5.3)', () => {
  /** The synthetic hand's world landmarks turned by `deg` about the y axis (the hand turns left or right) or the x axis. */
  const turned = (deg: number, axis: 'x' | 'y') => {
    const world = syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08 }).world!;
    const cos = Math.cos(deg * Math.PI / 180);
    const sin = Math.sin(deg * Math.PI / 180);
    return world.map(p => axis === 'y' ? { ...p, x: p.x * cos + p.z * sin, z: -p.x * sin + p.z * cos } : { ...p, y: p.y * cos - p.z * sin, z: p.y * sin + p.z * cos });
  };
  it('reads 0 for a palm that faces the camera and the turn angle for a turned hand', () => {
    expect(palmFacing(turned(0, 'y'))).toBeCloseTo(0, 6);
    for (const deg of [10, 25, 60, 90]) {
      expect(palmFacing(turned(deg, 'y'))).toBeCloseTo(deg, 6);
      expect(palmFacing(turned(-deg, 'x'))).toBeCloseTo(deg, 6);
    }
    expect(palmFacing(turned(180, 'y'))).toBeCloseTo(0, 6);
    expect(palmFacing(turned(120, 'y'))).toBeCloseTo(60, 6);
  });
  it('returns null without usable landmarks', () => {
    expect(palmFacing(undefined)).toBeNull();
    expect(palmFacing([])).toBeNull();
    const flat = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
    expect(palmFacing(flat)).toBeNull();
  });
  it('measures how far the forearm is from the image plane', () => {
    // The pose's forearm axis is its local y axis; view space looks along -z.
    for (const deg of [0, 10, 30, 45, 80]) {
      const orientation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), deg * Math.PI / 180);
      expect(forearmFlat({ orientation })).toBeCloseTo(deg, 6);
      expect(forearmFlat({ orientation: orientation.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.2)) })).toBeCloseTo(deg, 6);
    }
    expect(forearmFlat({ orientation: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 6) })).toBeCloseTo(30, 6);
  });
  it('measures the wrist speed over the last 300 ms', () => {
    // 0.5 mm per pixel, 10 pixels per 100 ms is 50 mm/s.
    const moving = Array.from({ length: 8 }, (_, i) => ({ x: 100 + i * 10, y: 50, t: 1000 + i * 100 }));
    expect(stillness(moving, 0.5)).toBeCloseTo(50, 9);
    const stopped = [...moving, { x: 170, y: 50, t: 1800 }, { x: 170, y: 50, t: 1900 }, { x: 170, y: 50, t: 2000 }, { x: 170, y: 50, t: 2100 }];
    expect(stillness(stopped, 0.5)).toBe(0);
    expect(stillness(moving.slice(0, 2), 0.5)).toBeNull();
    expect(stillness([], 0.5)).toBeNull();
    expect(stillness(moving, 0)).toBeNull();
  });
  it('treats 1 pixel of jitter at 0.5 mm per pixel as still', () => {
    const jitter = Array.from({ length: 6 }, (_, i) => ({ x: 100 + (i % 2), y: 50 + ((i + 1) % 2), t: i * 100 }));
    expect(stillness(jitter, 0.5)!).toBeLessThan(STILL_MM_PER_S);
  });
});

describe('the measure step (R21 to R23)', () => {
  const offsets = (kind: StepKind) => stepOffsets(kind);
  const good = (kind: StepKind, width = 58, patch: Partial<StepInput> = {}): StepInput => ({
    palmAngleDeg: kind === 'thickness' ? 90 : 5, forearmAngleDeg: 10, speedMmPerS: 4, widthsMm: offsets(kind).map(() => width), ...patch,
  });
  it('lists the profile lines of R20 and one line for the passage', () => {
    expect(PROFILE_OFFSETS).toEqual([-20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]);
    expect(stepOffsets('passage')).toEqual([0]);
    expect(stepOffsets('width')).toBe(PROFILE_OFFSETS);
  });
  it('gives the first reason that applies', () => {
    expect(stepReason('width', good('width'))).toBeNull();
    expect(stepReason('width', good('width', 58, { palmAngleDeg: null }))).toBe('no-hand');
    expect(stepReason('width', good('width', 58, { palmAngleDeg: PALM_FACING_DEG + 1 }))).toBe('palm');
    expect(stepReason('width', good('width', 58, { palmAngleDeg: PALM_FACING_DEG }))).toBeNull();
    expect(stepReason('passage', good('passage', 80, { palmAngleDeg: 60 }))).toBe('palm');
    expect(stepReason('thickness', good('thickness', 40, { palmAngleDeg: 5 }))).toBe('thumb-up');
    expect(stepReason('thickness', good('thickness', 40, { palmAngleDeg: 90 - PALM_FACING_DEG }))).toBeNull();
    expect(stepReason('thickness', good('thickness', 40, { palmAngleDeg: 90 - PALM_FACING_DEG - 1 }))).toBe('thumb-up');
    expect(stepReason('width', good('width', 58, { forearmAngleDeg: FOREARM_FLAT_DEG + 1 }))).toBe('flat');
    expect(stepReason('width', good('width', 58, { forearmAngleDeg: null }))).toBe('flat');
    expect(stepReason('width', good('width', 58, { speedMmPerS: STILL_MM_PER_S + 1 }))).toBe('still');
    expect(stepReason('width', good('width', 58, { speedMmPerS: null }))).toBe('still');
    expect(stepReason('width', good('width', 58, { widthsMm: null }))).toBe('no-mask');
    const noBand = offsets('width').map((offset, i) => offset === 0 ? null : 50 + i);
    expect(stepReason('width', good('width', 58, { widthsMm: noBand }))).toBe('no-mask');
    // Several problems at once: the hand comes first, then the pose, then stillness.
    expect(stepReason('width', { palmAngleDeg: 80, forearmAngleDeg: 80, speedMmPerS: 99, widthsMm: null })).toBe('palm');
  });
  it('ignores frames until it is started and after it is done', () => {
    const step = new MeasureStep('width');
    expect(step.push(good('width')).phase).toBe('idle');
    step.start();
    for (let i = 0; i < MEASURE_FRAMES; i++) step.push(good('width'));
    const done = step.state;
    expect(done.phase).toBe('done');
    expect(step.push(good('width', 90))).toBe(done);
    expect(step.start().phase).toBe('waiting');
  });
  it('records MEASURE_FRAMES accepted frames and then reports the median of every line', () => {
    const step = new MeasureStep('width');
    expect(step.start()).toEqual({ phase: 'waiting', reason: 'no-hand', accepted: 0 });
    for (let i = 1; i < MEASURE_FRAMES; i++) expect(step.push(good('width', 58 + i * 0.1))).toEqual({ phase: 'recording', accepted: i });
    const done = step.push(good('width', 58.7));
    expect(done.phase).toBe('done');
    if (done.phase !== 'done') return;
    expect(done.slices).toHaveLength(PROFILE_OFFSETS.length);
    expect(done.slices.map(slice => slice.offsetMm)).toEqual([...PROFILE_OFFSETS]);
    expect(done.slices[4]!.valueMm).toBeCloseTo(58.4, 9);
    expect(done.slices[4]!.spreadMm!).toBeLessThan(MEASURE_SPREAD_MM);
  });
  it('drops a wild frame as an outlier and still finishes', () => {
    const step = new MeasureStep('width');
    step.start();
    const widths = [58, 58.2, 57.9, 58.1, 58, 71, 58.1];
    for (const width of widths) step.push(good('width', width));
    const done = step.state;
    expect(done.phase).toBe('done');
    if (done.phase === 'done') expect(done.slices[4]!.valueMm).toBeCloseTo(58.05, 6);
  });
  it('says which pose to fix and keeps the frames it has while it waits', () => {
    const step = new MeasureStep('thickness');
    step.start();
    for (let i = 0; i < 3; i++) step.push(good('thickness', 40));
    expect(step.push(good('thickness', 40, { palmAngleDeg: 3 }))).toEqual({ phase: 'waiting', reason: 'thumb-up', accepted: 3 });
    expect(step.push(good('thickness', 40, { speedMmPerS: 60 }))).toEqual({ phase: 'waiting', reason: 'still', accepted: 3 });
    for (let i = 0; i < MEASURE_FRAMES - 3; i++) step.push(good('thickness', 40));
    expect(step.state.phase).toBe('done');
  });
  it('is unstable when the width at the band position spreads more than MEASURE_SPREAD_MM, and starts again on the next frame', () => {
    const step = new MeasureStep('width');
    step.start();
    for (const width of [50, 52, 54, 56, 58, 60, 62]) step.push(good('width', width));
    expect(step.state).toMatchObject({ phase: 'unstable', why: 'spread' });
    expect((step.state as { spreadMm: number }).spreadMm).toBeGreaterThan(MEASURE_SPREAD_MM);
    expect(step.push(good('width', 58))).toEqual({ phase: 'recording', accepted: 1 });
  });
  it('is unstable when fewer than 5 frames survive the outlier filter', () => {
    const step = new MeasureStep('width');
    step.start();
    // Four equal frames and three others: the median absolute deviation is 0, so only the 4 equal ones stay.
    for (const width of [50, 50, 50, 50, 60, 61, 62]) step.push(good('width', width));
    expect(step.state).toMatchObject({ phase: 'unstable', why: 'few-frames' });
  });
  it('leaves a line out of the profile when it was read in too few frames', () => {
    const step = new MeasureStep('width');
    step.start();
    for (let i = 0; i < MEASURE_FRAMES; i++) {
      step.push(good('width', 58, { widthsMm: offsets('width').map((offset, index) => offset === 60 && i < 4 ? null : 58 + index * 0.01) }));
    }
    const done = step.state;
    expect(done.phase).toBe('done');
    if (done.phase !== 'done') return;
    expect(done.slices[done.slices.length - 1]).toEqual({ offsetMm: 60, valueMm: null, spreadMm: null });
    expect(done.slices[0]!.valueMm).not.toBeNull();
  });
  it('reads one line for the passage step', () => {
    const step = new MeasureStep('passage');
    step.start();
    for (let i = 0; i < MEASURE_FRAMES; i++) step.push({ palmAngleDeg: 10, forearmAngleDeg: 5, speedMmPerS: 1, widthsMm: [82 + i * 0.05] });
    expect(step.state).toMatchObject({ phase: 'done', slices: [{ offsetMm: 0 }] });
  });
  it('resets to idle', () => {
    const step = new MeasureStep('width');
    step.start();
    step.push(good('width'));
    expect(step.reset()).toEqual({ phase: 'idle' });
    expect(step.push(good('width')).phase).toBe('idle');
  });
});
