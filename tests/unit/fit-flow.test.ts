import { describe, expect, it } from 'vitest';
import { CARD_STILL_MS, SEGMENT_INTERVAL_MS } from '../../shared/fit-constants';
import { guideEdges } from '../../src/fit/card';
import { MeasureStep, mmPerPx, stepOffsets, type StepInput } from '../../src/fit/measure';
import { createFitStore, type FitStore } from '../../src/fit/store';
import { createLiveGuide, distalOf, FitEngine, type FrozenPicture } from '../../src/fit/useBodyFit';
import type { HandSource, TrackedFrame } from '../../src/hands/useHandTracking';
import type { HandLandmarks, Landmark, SegmentCrop, TrackingDelegate } from '../../src/try-on/arm-pose';
import { renderCard } from '../fixtures/fit-card-image';
import { forearmSkinMask } from '../fixtures/fit-mask';
import { syntheticHand } from '../fixtures/synthetic-hand';

/**
 * The measuring flow of body fit without a browser (Task 3): `FitEngine` is fed synthetic hand frames, and a fake worker answers
 * the crop it asked for with a synthetic forearm mask, the way `tests/e2e/fake-body.ts` does in the browser.
 */
/** A square frame: the synthetic hand has the same pixels per metre in x and y only on a square frame (its aspect option does not change the layout). */
const FRAME = { width: 480, height: 480 };
const FRAME_MS = 100;
/** Lets the engine's asynchronous capture finish. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

interface FakeSource extends HandSource {
  push(frame: TrackedFrame): void;
  tick(now: number): void;
  setRate(rate: number | null): void;
  setDelegate(delegate: TrackingDelegate | null): void;
}
function fakeSource(): FakeSource {
  const frames = new Set<(frame: TrackedFrame) => void>();
  const ticks = new Set<(now: number) => void>();
  let latest: TrackedFrame | null = null, rate: number | null = 9, delegate: TrackingDelegate | null = 'GPU';
  return {
    latest: () => latest,
    subscribe(listener) { frames.add(listener); return () => { frames.delete(listener); }; },
    onTick(listener) { ticks.add(listener); return () => { ticks.delete(listener); }; },
    rate: () => rate,
    delegate: () => delegate,
    push(frame) { latest = frame; for (const listener of [...frames]) listener(frame); },
    tick(now) { for (const listener of [...ticks]) listener(now); },
    setRate(value) { rate = value; },
    setDelegate(value) { delegate = value; },
  };
}

/** Turns a hand about the vertical axis through its wrist by `deg` (image and world landmarks alike), like a wrist turned to thumb up. */
function turnHand(hand: HandLandmarks, deg: number): HandLandmarks {
  const cos = Math.cos(deg * Math.PI / 180), sin = Math.sin(deg * Math.PI / 180);
  const aspect = FRAME.width / FRAME.height;
  const wrist = hand.points[0]!;
  const points = hand.points.map(point => ({ ...point, x: wrist.x + (point.x - wrist.x) * cos, z: -(point.x - wrist.x) * aspect * sin }));
  const world = hand.world!.map((point): Landmark => ({ ...point, x: point.x * cos, z: -point.x * sin }));
  return { ...hand, points, world };
}

/** The synthetic hand of the tests: 180 mm over 0.3 of the frame height, so 1.25 mm per frame pixel. */
const HAND = syntheticHand({ cursor: { x: 0.5, y: 0.45 }, pinchM: 0.04, size: 0.3, aspect: FRAME.width / FRAME.height });
const SCALE = mmPerPx(HAND, FRAME)!;

interface World {
  store: FitStore;
  source: FakeSource;
  engine: FitEngine;
  /** What the fake worker sees now. */
  hand: HandLandmarks | null;
  widthMm: number;
  now: number;
  /** One camera frame: a tick, then the answer to the crop the engine asked for. */
  step(options?: { mask?: boolean; hand?: HandLandmarks | null; dt?: number }): TrackedFrame;
  asked: SegmentCrop[];
}

function world(options: { capture?: () => Promise<FrozenPicture | null>; widthMm?: number } = {}): World {
  const store = createFitStore();
  const source = fakeSource();
  const state: World = {
    store, source, hand: HAND, widthMm: options.widthMm ?? 58, now: 1000, asked: [],
    engine: null as unknown as FitEngine,
    step(stepOptions = {}) {
      const { mask = true, dt = FRAME_MS } = stepOptions;
      const hand = stepOptions.hand === undefined ? state.hand : stepOptions.hand;
      state.now += dt;
      source.tick(state.now);
      const crop = store.segment.current;
      if (crop) state.asked.push(crop);
      const wrist = HAND.points[0]!;
      const knuckle = HAND.points[9]!;
      const point = { x: wrist.x * FRAME.width, y: wrist.y * FRAME.height };
      const axisDeg = Math.atan2((knuckle.y - wrist.y) * FRAME.height, (knuckle.x - wrist.x) * FRAME.width) * 180 / Math.PI;
      const frame: TrackedFrame = {
        ...FRAME, hands: hand ? [hand] : [], body: [], requestedAt: state.now - 20, capturedAt: state.now - 10, receivedAt: state.now,
        inferenceMs: 4, pose: true,
        ...(crop ? { luma: 0.45 } : {}),
        ...(crop && mask ? { mask: forearmSkinMask({ crop, point, axisDeg, widthPx: state.widthMm / SCALE }, state.now) } : {}),
      };
      source.push(frame);
      return frame;
    },
  };
  state.engine = new FitEngine({ store, source, guide: createLiveGuide(), clock: () => state.now, capture: options.capture });
  state.engine.start();
  return state;
}

/** Runs frames until `done()` or `limit` frames have passed. */
function run(w: World, done: () => boolean, limit = 80, options?: { mask?: boolean }): number {
  let frames = 0;
  while (!done() && frames < limit) { w.step(options); frames++; }
  return frames;
}

describe('asking the worker for a mask (requirements, review of Task 2, item 15a)', () => {
  it('keeps the request set until a frame comes back with a luma, then starts the interval from that frame', () => {
    const w = world();
    // The first frame only places the hand; the second tick asks, and the frame that follows answers with a luma (even before the segmenter is ready).
    w.step({ mask: false });
    w.step({ mask: false });
    expect(w.asked).toHaveLength(1);
    expect(w.store.segment.current).toBeNull();
    const answeredAt = w.now;
    // No new request for 333 ms after that answer.
    w.step({ mask: false });
    w.step({ mask: false });
    w.step({ mask: false });
    expect(w.now).toBe(answeredAt + 300);
    expect(w.asked).toHaveLength(1);
    w.source.tick(answeredAt + SEGMENT_INTERVAL_MS - 1);
    expect(w.store.segment.current).toBeNull();
    w.source.tick(answeredAt + SEGMENT_INTERVAL_MS);
    expect(w.store.segment.current).not.toBeNull();
  });

  it('keeps a request alive while the worker is busy, whatever the interval says', () => {
    const w = world();
    w.step({ mask: false });
    w.source.tick(w.now += 10);
    const first = w.store.segment.current!;
    expect(first).not.toBeNull();
    // Ticks without answers: the request must not be dropped.
    for (let i = 0; i < 5; i++) w.source.tick(w.now += 200);
    expect(w.store.segment.current).not.toBeNull();
    expect(w.store.segment.current!.size).toBeCloseTo(first.size, 6);
    w.engine.stop();
    expect(w.store.segment.current).toBeNull();
  });

  it('makes no request while no hand is placed, and does not start the interval from such a tick', () => {
    const w = world();
    w.step({ hand: null });
    w.step({ hand: null });
    expect(w.asked).toHaveLength(0);
    expect(w.store.segment.current).toBeNull();
    // The hand appears: the next tick asks at once.
    w.step({ mask: false });
    w.step({ mask: false });
    expect(w.asked).toHaveLength(1);
  });

  it('crops 160 mm around the band position, 20 mm from the wrist toward the elbow', () => {
    const w = world();
    w.step({ mask: false });
    w.step({ mask: false });
    const crop = w.asked[0]!;
    expect(crop.size * SCALE).toBeCloseTo(160, 6);
    const wrist = { x: HAND.points[0]!.x * FRAME.width, y: HAND.points[0]!.y * FRAME.height };
    const distal = distalOf(w.engine['placement']!.pose)!;
    expect(Math.hypot(crop.x - wrist.x, crop.y - wrist.y) * SCALE).toBeCloseTo(20, 0);
    expect((crop.x - wrist.x) * distal.x + (crop.y - wrist.y) * distal.y).toBeLessThan(0);
  });
});
describe('the guided measure steps (R21 to R23)', () => {
  it('measures the width of a synthetic forearm and stores it with a spread', () => {
    const w = world({ widthMm: 58 });
    w.step({ mask: false });
    w.engine.startStep('width');
    const frames = run(w, () => w.store.snapshot().steps.width !== null);
    const result = w.store.snapshot().steps.width!;
    expect(result.kind).toBe('width');
    expect(result.k).toBe(1);
    expect(frames).toBeLessThan(40);
    const band = result.slices.find(slice => slice.offsetMm === 0)!;
    // Within one mask pixel (about 0.6 mm at this scale).
    expect(Math.abs(band.valueMm! - 58)).toBeLessThan(0.8);
    expect(band.spreadMm).toBeLessThan(3);
    expect(w.engine.snapshot().step).toBeNull();
    const derived = w.store.derived();
    expect(derived.measurement!.width.source).toBe('estimate');
    expect(Math.abs(derived.measurement!.width.mm - 58)).toBeLessThan(0.8);
  });

  it('asks for a mask on every frame while the pose holds', () => {
    const w = world();
    w.step({ mask: false });
    w.engine.startStep('width');
    // Wait for the step to start recording (the hand history needs a moment to count as still).
    run(w, () => w.engine.snapshot().step?.state.phase === 'recording', 20, { mask: true });
    expect(w.engine.snapshot().step?.state.phase).toBe('recording');
    const before = w.asked.length;
    for (let i = 0; i < 3; i++) w.step({ mask: true });
    // Three frames in a row each carried a crop: a burst, not the 3 Hz interval.
    expect(w.asked.length).toBe(before + 3);
  });

  it('finishes a step whose readings are mostly identical (robust median fix, review of Task 2, item 15c)', () => {
    const step = new MeasureStep('width');
    step.start();
    const offsets = stepOffsets('width');
    const input = (mm: number): StepInput => ({ palmAngleDeg: 3, forearmAngleDeg: 3, speedMmPerS: 2, widthsMm: offsets.map(() => mm) });
    let state = step.state;
    for (const mm of [58, 58, 58, 58, 58.3, 57.8, 58.1]) state = step.push(input(mm));
    expect(state.phase).toBe('done');
    if (state.phase === 'done') expect(state.slices.find(slice => slice.offsetMm === 0)!.valueMm).toBeCloseTo(58, 9);
  });
  it('says what to change while the pose does not hold, and keeps what it recorded (R22)', () => {
    const w = world();
    w.step({ mask: false });
    w.engine.startStep('width');
    w.step({ mask: true, hand: null });
    expect(w.engine.snapshot().step?.state).toMatchObject({ phase: 'waiting', reason: 'no-hand' });
    w.step({ mask: true, hand: turnHand(HAND, 90) });
    w.step({ mask: true, hand: turnHand(HAND, 90) });
    expect(w.engine.snapshot().step?.state).toMatchObject({ phase: 'waiting', reason: 'palm' });
    run(w, () => w.engine.snapshot().step?.state.phase === 'recording', 20);
    expect(w.engine.snapshot().step?.state.phase).toBe('recording');
    // A moving wrist pauses the step with the reason 'still'.
    const moved = syntheticHand({ cursor: { x: 0.62, y: 0.45 }, pinchM: 0.04, size: 0.3, aspect: FRAME.width / FRAME.height });
    w.step({ mask: true, hand: moved });
    w.step({ mask: true, hand: moved });
    expect(w.engine.snapshot().step?.state).toMatchObject({ phase: 'waiting', reason: 'still' });
  });

  it('measures the thickness with the wrist turned to thumb up', () => {
    const w = world({ widthMm: 39 });
    w.hand = turnHand(HAND, 90);
    w.step({ mask: false });
    w.engine.startStep('thickness');
    run(w, () => w.store.snapshot().steps.thickness !== null);
    const band = w.store.snapshot().steps.thickness!.slices.find(slice => slice.offsetMm === 0)!;
    expect(Math.abs(band.valueMm! - 39)).toBeLessThan(0.8);
  });

  it('does not count frames that have no mask, and waits on a missing outline', () => {
    const w = world();
    w.step({ mask: false });
    w.engine.startStep('width');
    run(w, () => w.engine.snapshot().step?.state.phase === 'recording', 20);
    const before = w.engine.snapshot().step!.state;
    for (let i = 0; i < 5; i++) w.step({ mask: false });
    expect(w.engine.snapshot().step!.state).toEqual(before);
    expect(w.store.snapshot().steps.width).toBeNull();
    // A mask without any skin: the outline is missing.
    w.widthMm = -10;
    w.step({ mask: true });
    expect(w.engine.snapshot().step?.state).toMatchObject({ phase: 'waiting', reason: 'no-mask' });
  });

  it('restarts and says so when the frames disagree (R23)', () => {
    const w = world();
    w.step({ mask: false });
    w.engine.startStep('width');
    let width = 50;
    let frames = 0;
    // The width jumps by 6 mm every frame, so the spread at the band position is far above 3 mm.
    while (!w.engine.snapshot().unstable && frames++ < 80) { w.widthMm = width; width = width === 50 ? 56 : 50; w.step({ mask: true }); }
    expect(w.engine.snapshot().unstable).toBe(true);
    expect(w.store.snapshot().steps.width).toBeNull();
    expect(w.engine.snapshot().step).not.toBeNull();
  });

  it('counts a hand held still as still when frames come slower than the stillness window', () => {
    const w = world();
    w.step({ mask: false, dt: 350 });
    w.engine.startStep('width');
    let frames = 0;
    while (w.engine.snapshot().step?.state.phase !== 'recording' && frames++ < 12) w.step({ mask: true, dt: 350 });
    expect(w.engine.snapshot().step?.state.phase).toBe('recording');
  });
  it('stops a step on request and clears the crop burst', () => {
    const w = world();
    w.step({ mask: false });
    w.engine.startStep('width');
    expect(w.engine.snapshot().step?.kind).toBe('width');
    w.engine.stopStep();
    expect(w.engine.snapshot().step).toBeNull();
    expect(w.store.snapshot().steps.width).toBeNull();
  });

  it('takes the worn side from the arm pose, once', () => {
    const w = world();
    expect(w.store.snapshot().side).toBeNull();
    w.step({ mask: false });
    expect(w.store.snapshot().side).toBe('right');
  });

  it('marks the segmenter ready when a mask arrives, and sizes the crop with the calibrated scale', () => {
    const w = world();
    w.step({ mask: false });
    expect(w.store.snapshot().segmenter).toBe('idle');
    w.step({ mask: true });
    expect(w.store.snapshot().segmenter).toBe('ready');
    w.store.setCalibration({ k: 0.9, at: '2026-11-29T00:00:00.000Z', spreadPct: 0 });
    w.step({ mask: false });
    w.now += 400;
    w.source.tick(w.now);
    const crop = w.store.segment.current!;
    // With k = 0.9 a pixel is 10 % shorter in millimetres, so the 160 mm crop is larger in pixels.
    expect(crop.size * SCALE * 0.9).toBeCloseTo(160, 0);
  });
});
describe('the card calibration (R11 to R17)', () => {
  /** A picture with the card exactly where and as big as the guide frame says. */
  const cardPicture = (w: () => World): (() => Promise<FrozenPicture | null>) => async () => {
    const state = w().engine.guide.current();
    if (!state) return null;
    return { pixels: renderCard(state.guide, guideEdges(state.guide), { width: FRAME.width, height: FRAME.height }), bitmap: null };
  };

  it('aims, freezes after the hand was still for a second, finds the card and calibrates on confirm', async () => {
    let current: World;
    const w = (current = world({ capture: cardPicture(() => current) }));
    w.step({ mask: false });
    w.engine.startCard();
    expect(w.engine.snapshot().card).toBe('aiming');
    let frames = 0;
    while (w.engine.snapshot().card === 'aiming' && frames++ < 40) {
      w.step({ mask: false });
      await settle();
    }
    expect(w.engine.snapshot().card).toBe('frozen');
    // About a second of stillness (plus the history the stillness check needs) passed first.
    expect(frames * FRAME_MS).toBeGreaterThanOrEqual(CARD_STILL_MS);
    expect(frames * FRAME_MS).toBeLessThan(CARD_STILL_MS + 800);
    expect(w.engine['frozen']!.detection.found).toBe(true);
    const result = w.engine.confirmCard(w.engine['frozen']!.detection.edges);
    expect(result.ok).toBe(true);
    const calibration = w.store.snapshot().calibration!;
    // The card is as big as the estimate says, so only the depth correction (card nearer than the arm centre) remains: a little above 1.
    expect(calibration.k).toBeGreaterThan(1);
    expect(calibration.k).toBeLessThan(1.06);
    expect(w.store.derived().source).toBe('card');
    expect(w.engine.snapshot().card).toBe('off');
  });

  it('does not freeze while the hand moves, and the guide shows how long it has been still', () => {
    const w = world({ capture: async () => null });
    w.step({ mask: false });
    w.engine.startCard();
    for (let i = 0; i < 12; i++) {
      const moved = syntheticHand({ cursor: { x: 0.45 + (i % 2) * 0.1, y: 0.45 }, pinchM: 0.04, size: 0.3, aspect: FRAME.width / FRAME.height });
      w.step({ mask: false, hand: moved });
    }
    expect(w.engine.snapshot().card).toBe('aiming');
    expect(w.engine.guide.current()?.still).toBe(0);
    w.engine.cancelCard();
    expect(w.engine.snapshot().card).toBe('off');
    expect(w.engine.guide.current()).toBeNull();
  });

  it('refuses a card of the wrong shape and leaves the calibration unchanged (R16)', async () => {
    let current: World;
    const w = (current = world({ capture: cardPicture(() => current) }));
    w.step({ mask: false });
    w.engine.startCard();
    let frames = 0;
    while (w.engine.snapshot().card === 'aiming' && frames++ < 40) { w.step({ mask: false }); await settle(); }
    expect(w.engine.snapshot().card).toBe('frozen');
    const result = w.engine.confirmCard({ left: -50, right: 50, top: -40, bottom: 40 });
    expect(result).toEqual({ ok: false, reason: 'aspect' });
    expect(w.store.snapshot().calibration).toBeNull();
    expect(w.engine.snapshot().card).toBe('frozen');
    w.engine.retakeCard();
    expect(w.engine.snapshot().card).toBe('aiming');
  });

  it('measures lengths after a calibration with the calibrated scale', () => {
    const w = world({ widthMm: 58 });
    w.store.setCalibration({ k: 1.1, at: '2026-11-29T00:00:00.000Z', spreadPct: 0 });
    w.step({ mask: false });
    w.engine.startStep('width');
    run(w, () => w.store.snapshot().steps.width !== null);
    const result = w.store.snapshot().steps.width!;
    expect(result.k).toBe(1.1);
    // The synthetic mask is drawn for 58 mm at k = 1; at k = 1.1 the same pixels are 10 % longer.
    expect(Math.abs(result.slices.find(slice => slice.offsetMm === 0)!.valueMm! - 58 * 1.1)).toBeLessThan(0.9);
    expect(w.store.derived().measurement!.width.source).toBe('card');
  });
});
