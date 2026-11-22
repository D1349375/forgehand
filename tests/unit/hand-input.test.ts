import { describe, expect, it } from 'vitest';
import * as constants from '../../src/hands/constants';
import { DUPLICATE_HAND_PX, HAND_LOST_MS, HAND_MATCH_PX, HOVER_SETTLE_MS, TRACKING_LOSS_MS, TWO_HAND_MIN_SPAN_PX } from '../../src/hands/constants';
import { handSample, landmarkToClient } from '../../src/hands/mapping';
import { OneEuroFilter2D } from '../../src/hands/one-euro';
import { holdStep, initialPinchState, pinchStep, type PinchEvent, type PinchInput, type PinchState } from '../../src/hands/pinch';
import { HAND_CONNECTIONS } from '../../src/hands/skeleton';
import { assignHands, dedupeHands } from '../../src/hands/slots';
import { HAND_COLOUR, LINK_COLOUR, LOCKED_COLOUR, overlayStyle } from '../../src/hands/style';
import { initialSettleState, pickTarget, settleStep } from '../../src/hands/targets';
import { targetKey, type HandState, type Point, type ScreenTarget, type Target } from '../../src/hands/types';
import { HOLOGRAM, SELECTION } from '../../src/scene/style';
import { clientToNormalized, syntheticHand } from '../fixtures/synthetic-hand';

const wideView = { left: 100, top: 50, width: 1000, height: 400 };
const tallView = { left: 20, top: 10, width: 300, height: 600 };
const video = { width: 640, height: 480 };

describe('constants', () => {
  it('exports the P0 defaults by name', () => {
    expect(constants).toMatchObject({
      CURSOR_POINT: 'pinch-midpoint', CURSOR_MIN_CUTOFF: 1, CURSOR_BETA: 0.01, CURSOR_D_CUTOFF: 1,
      PINCH_ENGAGE_M: 0.04, PINCH_ENGAGE_MS: 80, PINCH_RELEASE_M: 0.055, PINCH_RELEASE_MS: 60, MIN_GESTURE_FRAMES: 2,
      HOVER_SETTLE_MS: 150, HAND_LOST_MS: 300, DRAG_DEAD_ZONE_PX: 8, DRAG_GAIN: 1.5, ORBIT_DEG_PER_PX: 0.4,
      TRACKING_LOSS_MS: 300, ON_TRACKING_LOSS: 'cancel', MIN_CONTROL_FPS: 5, SPEED_HOLD_MS: 2000, CANCEL_NOTICE_MS: 4000, BADGE_NAME_MAX: 12,
      TRACKED_HANDS: 2, DUPLICATE_HAND_PX: 40,
    });
  });
  it('no longer exports frame counts for engaging and releasing: they are times now', () => {
    for (const name of ['PINCH_ENGAGE_FRAMES', 'PINCH_RELEASE_FRAMES', 'FIST_ENGAGE_FRAMES', 'FIST_RELEASE_FRAMES']) expect(constants).not.toHaveProperty(name);
  });
  it('exports the fist defaults by name (Task 7)', () => {
    expect(constants).toMatchObject({
      FIST_ENABLED: true, FIST_ENGAGE_RATIO: 1.0, FIST_ENGAGE_MS: 150, FIST_RELEASE_RATIO: 1.25, FIST_RELEASE_MS: 60,
      EXPLODE_DEAD_ZONE_PX: 12, EXPLODE_FULL_FRACTION: 0.5,
    });
  });
});

describe('landmarkToClient', () => {
  it('undoes the cover crop for a view wider than the video', () => {
    // scale 1.5625: the video is shown 1000 x 750 and cropped top and bottom.
    expect(landmarkToClient({ x: 0.5, y: 0.5 }, wideView, video)).toEqual({ x: 600, y: 250 });
    const corner = landmarkToClient({ x: 0, y: 0 }, wideView, video);
    expect(corner.x).toBeCloseTo(100);
    expect(corner.y).toBeCloseTo(50 - 175);
  });

  it('undoes the cover crop for a view taller than the video', () => {
    // scale 1.25: the video is shown 800 x 600 and cropped left and right.
    expect(landmarkToClient({ x: 0.5, y: 0.5 }, tallView, video)).toEqual({ x: 170, y: 310 });
    const corner = landmarkToClient({ x: 1, y: 1 }, tallView, video);
    expect(corner.x).toBeCloseTo(20 - 250 + 800);
    expect(corner.y).toBeCloseTo(10 + 600);
  });

  it('round-trips with clientToNormalized on both views', () => {
    for (const view of [wideView, tallView]) {
      for (const point of [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.9 }, { x: 0.83, y: 0.27 }]) {
        const back = clientToNormalized(landmarkToClient(point, view, video), view, video);
        expect(back.x).toBeCloseTo(point.x, 9);
        expect(back.y).toBeCloseTo(point.y, 9);
      }
    }
  });
});

describe('handSample', () => {
  const hand = syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.04 });

  it('maps 21 points and puts the cursor at the midpoint of thumb tip and index tip', () => {
    const sample = handSample(hand, wideView, video)!;
    expect(sample.points).toHaveLength(21);
    const expected = landmarkToClient({ x: 0.5, y: 0.5 }, wideView, video);
    expect(sample.cursor.x).toBeCloseTo(expected.x, 6);
    expect(sample.cursor.y).toBeCloseTo(expected.y, 6);
    expect(sample.pinchM).toBeCloseTo(0.04, 9);
  });

  it('uses the index knuckle when asked', () => {
    const sample = handSample(hand, tallView, video, 'index-knuckle')!;
    expect(sample.cursor).toEqual(sample.points[5]);
  });

  it('has no pinch distance without world landmarks, and still gives the skeleton', () => {
    const sample = handSample(syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.04, world: false }), wideView, video)!;
    expect(sample.pinchM).toBeNull();
    expect(sample.points).toHaveLength(21);
  });

  it('gives the palm as the mean of the wrist and the four knuckles', () => {
    const sample = handSample(hand, wideView, video)!;
    const palm = [0, 5, 9, 13, 17].map(index => sample.points[index]!);
    expect(sample.palm.x).toBeCloseTo(palm.reduce((sum, p) => sum + p.x, 0) / 5, 9);
    expect(sample.palm.y).toBeCloseTo(palm.reduce((sum, p) => sum + p.y, 0) / 5, 9);
    // The fingers curling (pinch distance) does not move the palm.
    const closed = handSample(syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.01 }), wideView, video)!;
    expect(closed.palm.x).toBeCloseTo(sample.palm.x, 6);
    expect(closed.palm.y).toBeCloseTo(sample.palm.y, 6);
  });
  it('gives the curl ratio: about 1.88 for the open hand, 1.88 still for a pinch (the middle finger is the largest), 0.65 for the fist, null without world landmarks', () => {
    expect(handSample(syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08 }), wideView, video)!.curl).toBeCloseTo(1.88, 1);
    expect(handSample(syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.01 }), wideView, video)!.curl).toBeCloseTo(1.88, 1);
    const fist = handSample(syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08, fist: true }), wideView, video)!;
    expect(fist.curl).toBeCloseTo(0.65, 2);
    expect(fist.curl!).toBeLessThan(constants.FIST_ENGAGE_RATIO);
    // The fist is not a pinch: the thumb tip stays 6 cm from the index tip.
    expect(fist.pinchM).toBeCloseTo(0.06, 6);
    expect(handSample(syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.04, world: false }), wideView, video)!.curl).toBeNull();
  });
  it('places the palm centre at the cursor of a synthetic fist', () => {
    const at = { x: 0.4, y: 0.6 };
    const fist = handSample(syntheticHand({ cursor: at, pinchM: 0.08, fist: true }), wideView, video)!;
    const expected = landmarkToClient(at, wideView, video);
    expect(fist.palm.x).toBeCloseTo(expected.x, 6);
    expect(fist.palm.y).toBeCloseTo(expected.y, 6);
  });
  it('rejects a hand with fewer than 21 finite points', () => {
    expect(handSample({ ...hand, points: hand.points.slice(0, 20) }, wideView, video)).toBeNull();
    const broken = hand.points.map((point, index) => (index === 7 ? { ...point, x: Number.NaN } : point));
    expect(handSample({ ...hand, points: broken }, wideView, video)).toBeNull();
    expect(handSample(hand, { ...wideView, width: 0 }, video)).toBeNull();
  });
});

describe('OneEuroFilter2D', () => {
  const at = (index: number) => index * 16;

  it('passes the first sample through unchanged', () => {
    expect(new OneEuroFilter2D().filter({ x: 12, y: 34 }, 1000)).toEqual({ x: 12, y: 34 });
  });

  it('smooths jitter at rest', () => {
    const filter = new OneEuroFilter2D();
    let output = { x: 0, y: 0 };
    let worst = 0;
    for (let index = 0; index < 80; index++) {
      const noise = index % 2 ? 2 : -2;
      output = filter.filter({ x: 100 + noise, y: 100 - noise }, at(index));
      if (index >= 20) worst = Math.max(worst, Math.abs(output.x - 100), Math.abs(output.y - 100));
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('follows a fast move with much less lag than a fixed cutoff', () => {
    const adaptive = new OneEuroFilter2D();
    const fixed = new OneEuroFilter2D({ beta: 0 });
    let lagAdaptive = 0;
    let lagFixed = 0;
    for (let index = 0; index < 80; index++) {
      const x = index * 16; // 1000 px/s
      lagAdaptive = x - adaptive.filter({ x, y: 0 }, at(index)).x;
      lagFixed = x - fixed.filter({ x, y: 0 }, at(index)).x;
    }
    expect(lagAdaptive).toBeLessThan(40);
    expect(lagFixed).toBeGreaterThan(lagAdaptive * 3);
  });

  it('starts again after a reset and ignores a repeated timestamp', () => {
    const filter = new OneEuroFilter2D();
    filter.filter({ x: 0, y: 0 }, 0);
    const second = filter.filter({ x: 50, y: 0 }, 16);
    expect(filter.filter({ x: 999, y: 0 }, 16)).toEqual(second);
    filter.reset();
    expect(filter.filter({ x: 300, y: 400 }, 20)).toEqual({ x: 300, y: 400 });
  });
});

describe('pinchStep', () => {
  const cursor = { x: 100, y: 100 };
  const hand = (pinchM: number | null, at: Point = cursor): PinchInput => ({ kind: 'hand', cursor: at, pinchM });

  /** Feeds `[input, time]` pairs and returns the events of every step plus the final state. */
  function run(steps: Array<[PinchInput, number]>, from: PinchState = initialPinchState()) {
    let state = from;
    const log: PinchEvent[][] = [];
    for (const [input, time] of steps) {
      const result = pinchStep(state, input, time);
      state = result.state;
      log.push(result.events);
    }
    return { state, log, events: log.flat() };
  }
  const types = (events: PinchEvent[]) => events.map(event => event.type);

  const closed = hand(0.01);
  const open = hand(0.08);
  /** Feeds the inputs at a constant frame spacing, starting at `from` (the first input is at `from`). */
  const spaced = (inputs: PinchInput[], spacing: number, from = 0): Array<[PinchInput, number]> => inputs.map((input, index) => [input, from + index * spacing]);
  const same = (input: PinchInput, count: number): PinchInput[] => Array.from({ length: count }, () => input);

  it('a custom loss window replaces both defaults', () => {
    const gap = Math.max(HAND_LOST_MS, TRACKING_LOSS_MS) + 700;
    // Idle: a gap longer than HAND_LOST_MS loses the hand by default, not with a wider window.
    expect(types(run([[open, 0], [open, gap]]).events)).toEqual(['found', 'lost', 'found']);
    const idle = pinchStep(pinchStep(initialPinchState(), open, 0, 2000).state, open, gap, 2000);
    expect(types(idle.events)).toEqual([]);
    // Engaged: the same for TRACKING_LOSS_MS.
    const engagedAfter = (lossMs?: number) => {
      let state = initialPinchState();
      for (const [input, time] of [[hand(0.08), 0], [hand(0.02), 100], [hand(0.02), 200]] as Array<[PinchInput, number]>) state = pinchStep(state, input, time, lossMs).state;
      expect(state.engaged).toBe(true);
      return pinchStep(state, { kind: 'tick' }, 200 + gap, lossMs);
    };
    expect(types(engagedAfter().events)).toEqual(['lost']);
    expect(types(engagedAfter(2000).events)).toEqual([]);
    expect(types(engagedAfter(500).events)).toEqual(['lost']);
  });
  it('emits found on the first hand frame', () => {
    expect(run([[hand(0.08), 0], [hand(0.08), 16]]).log.map(types)).toEqual([['found'], []]);
  });

  it('engages in two frames at 10 frames per second: the second frame is 100 ms after the first', () => {
    const { log } = run(spaced([open, closed, closed], 100));
    expect(log.map(types)).toEqual([['found'], [], ['engage']]);
    expect(log[2]![0]).toEqual({ type: 'engage', point: cursor });
  });

  it('engages after PINCH_ENGAGE_MS from the first qualifying frame, whatever the frame rate', () => {
    for (const spacing of [20, 33, 50, 100, 200]) {
      const frames = run(spaced([open, ...same(closed, 12)], spacing)).log;
      const engageAt = frames.findIndex(events => types(events).includes('engage'));
      expect(engageAt).toBeGreaterThan(0);
      // The first closed frame is index 1; the engage frame is the first one at least PINCH_ENGAGE_MS later (and at least the second frame).
      const elapsed = (engageAt - 1) * spacing;
      expect(elapsed).toBeGreaterThanOrEqual(constants.PINCH_ENGAGE_MS);
      expect(elapsed - spacing).toBeLessThan(constants.PINCH_ENGAGE_MS);
      expect(engageAt - 1).toBeGreaterThanOrEqual(constants.MIN_GESTURE_FRAMES - 1);
    }
    // The cases the task names: 2 frames at 10 frames per second, 4 at 30 (33 ms apart).
    expect(run(spaced([open, ...same(closed, 2)], 100)).events.map(event => event.type)).toEqual(['found', 'engage']);
    expect(run(spaced([open, ...same(closed, 3)], 33)).events.map(event => event.type)).toEqual(['found']);
    expect(run(spaced([open, ...same(closed, 4)], 33)).events.map(event => event.type)).toEqual(['found', 'engage']);
  });

  it('needs the distance strictly below the engage threshold: 40 mm, not 30 mm', () => {
    expect(constants.PINCH_ENGAGE_M).toBe(0.04);
    expect(types(run(spaced(same(hand(0.04), 8), 100)).events)).toEqual(['found']);
    expect(types(run(spaced(same(hand(0.0399), 2), 100)).events)).toEqual(['found', 'engage']);
    // 26 mm, what a closed pinch measured on the webcam, engages; 58 mm, half open, does not.
    expect(types(run(spaced(same(hand(0.026), 2), 100)).events)).toEqual(['found', 'engage']);
    expect(types(run(spaced(same(hand(0.058), 8), 100)).events)).toEqual(['found']);
  });

  it('never engages on a single noisy frame, however long the frames are apart or how long the time-out is', () => {
    expect(types(run(spaced([open, closed, open, closed, open, closed, open], 100)).events)).toEqual(['found']);
    expect(types(run(spaced([closed, open, closed, open], 33)).events)).toEqual(['found']);
    // With a long loss window a lone closed frame after a long gap has the time but not the second frame.
    let state = initialPinchState();
    const events: PinchEvent[] = [];
    for (const [input, time] of [[open, 0], [closed, 1000], [{ kind: 'tick' }, 1900]] as Array<[PinchInput, number]>) {
      const result = pinchStep(state, input, time, 5000);
      state = result.state;
      events.push(...result.events);
    }
    expect(types(events)).toEqual(['found']);
    expect(state.engaged).toBe(false);
    // The second closed frame completes the minimum, and 1000 ms is more than enough time.
    expect(types(pinchStep(state, closed, 2000, 5000).events)).toEqual(['engage']);
  });

  it('ignores a one-frame spike, and a distance between the thresholds breaks the streak', () => {
    expect(types(run(spaced([closed, open, closed, open], 100)).events)).toEqual(['found']);
    expect(types(run(spaced([closed, hand(0.045), closed], 100)).events)).toEqual(['found']);
  });

  it('never engages without a pinch distance, and a missing distance breaks the streak', () => {
    expect(types(run(spaced([hand(null), hand(null), hand(null), hand(null)], 100)).events)).toEqual(['found']);
    expect(types(run(spaced([closed, hand(null), closed], 100)).events)).toEqual(['found']);
  });

  it('a frame without a hand breaks the streak', () => {
    expect(types(run(spaced([closed, { kind: 'none' }, closed], 100)).events)).toEqual(['found']);
  });

  const engaged = () => run(spaced([closed, closed], 100));

  it('releases in two frames at 10 frames per second', () => {
    const start = engaged();
    const { log } = run(spaced([open, open], 100, 200), start.state);
    expect(log.map(types)).toEqual([[], ['release']]);
    expect(log[1]![0]).toEqual({ type: 'release', tap: true, point: cursor });
  });

  it('releases after PINCH_RELEASE_MS from the first qualifying frame, whatever the frame rate', () => {
    for (const spacing of [20, 33, 50, 100, 200]) {
      const start = engaged();
      const frames = run(spaced(same(open, 12), spacing, 200), start.state).log;
      const releaseAt = frames.findIndex(events => types(events).includes('release'));
      expect(releaseAt).toBeGreaterThanOrEqual(1);
      expect(releaseAt * spacing).toBeGreaterThanOrEqual(constants.PINCH_RELEASE_MS);
      expect((releaseAt - 1) * spacing).toBeLessThan(constants.PINCH_RELEASE_MS);
    }
    // 30 frames per second: three frames, 66 ms.
    const at30 = run(spaced(same(open, 3), 33, 200), engaged().state);
    expect(at30.log.map(types)).toEqual([[], [], ['release']]);
    expect(run(spaced(same(open, 2), 33, 200), engaged().state).events).toEqual([]);
  });

  it('does not release on one noisy frame, also not at a low frame rate', () => {
    for (const spacing of [33, 100, 200]) {
      const { events, state } = run(spaced([open, closed, open, closed, open], spacing, 200), engaged().state);
      expect(events).toEqual([]);
      expect(state.engaged).toBe(true);
    }
  });

  it('keeps the pinch between the thresholds and through a one-frame spike: release needs more than 55 mm', () => {
    expect(constants.PINCH_RELEASE_M).toBe(0.055);
    const start = engaged();
    const { events, state } = run(spaced([
      hand(0.04), hand(0.05), hand(0.055), hand(0.055), hand(0.08), hand(0.01), hand(0.08), hand(0.01), hand(0.045),
    ], 100, 200), start.state);
    expect(events).toEqual([]);
    expect(state.engaged).toBe(true);
    expect(types(run(spaced(same(hand(0.0551), 2), 100, 200), engaged().state).events)).toEqual(['release']);
  });

  it('is a tap inside the dead zone and a drag outside it', () => {
    const tap = run([
      [hand(0.01, { x: 100, y: 100 }), 0], [hand(0.01, { x: 100, y: 100 }), 100],
      [hand(0.01, { x: 105, y: 104 }), 200],
      [hand(0.08, { x: 105, y: 104 }), 300], [hand(0.08, { x: 105, y: 104 }), 400], [hand(0.08, { x: 105, y: 104 }), 500],
    ]);
    expect(types(tap.events)).toEqual(['found', 'engage', 'release']);
    expect(tap.events.at(-1)).toMatchObject({ type: 'release', tap: true });

    const drag = run([
      [hand(0.01, { x: 100, y: 100 }), 0], [hand(0.01, { x: 100, y: 100 }), 100],
      [hand(0.01, { x: 112, y: 100 }), 200], [hand(0.01, { x: 140, y: 100 }), 300],
      [hand(0.01, { x: 102, y: 100 }), 400],
      [hand(0.08, { x: 102, y: 100 }), 500], [hand(0.08, { x: 102, y: 100 }), 600], [hand(0.08, { x: 102, y: 100 }), 700],
    ]);
    // drag-start is emitted once, and returning to the dead zone does not make the release a tap.
    expect(types(drag.events)).toEqual(['found', 'engage', 'drag-start', 'release']);
    expect(drag.events.at(-1)).toMatchObject({ type: 'release', tap: false });
  });

  it('does not turn a tap into a drag on the releasing frame', () => {
    const start = engaged();
    const { events } = run([[hand(0.08), 200], [hand(0.08, { x: 180, y: 100 }), 300]], start.state);
    expect(events).toEqual([{ type: 'release', tap: true, point: { x: 180, y: 100 } }]);
  });

  it('continues the pinch when the hand is missing for less than TRACKING_LOSS_MS', () => {
    const start = engaged();
    const { events, state } = run([
      [{ kind: 'none' }, 150], [{ kind: 'tick' }, 200], [{ kind: 'none' }, 300], [{ kind: 'tick' }, 100 + TRACKING_LOSS_MS - 1], [hand(0.01), 100 + TRACKING_LOSS_MS - 1],
    ], start.state);
    expect(events).toEqual([]);
    expect(state.engaged).toBe(true);
  });

  it('loses an engaged pinch after TRACKING_LOSS_MS without a hand, and finds the hand again later', () => {
    const start = engaged();
    const lost = run([[{ kind: 'none' }, 200], [{ kind: 'tick' }, 100 + TRACKING_LOSS_MS]], start.state);
    expect(lost.events).toEqual([{ type: 'lost', engaged: true }]);
    expect(lost.state.engaged).toBe(false);
    const back = run([[{ kind: 'tick' }, 800], [hand(0.08), 816]], lost.state);
    expect(types(back.events)).toEqual(['found']);
  });

  it('loses an idle hand after HAND_LOST_MS and emits lost once', () => {
    const seen = run([[hand(0.08), 1000]]);
    const result = run([[{ kind: 'tick' }, 1000 + HAND_LOST_MS - 1], [{ kind: 'tick' }, 1000 + HAND_LOST_MS], [{ kind: 'tick' }, 1000 + HAND_LOST_MS + 16], [{ kind: 'none' }, 2000]], seen.state);
    expect(result.log.map(types)).toEqual([[], ['lost'], [], []]);
    expect(result.events[0]).toEqual({ type: 'lost', engaged: false });
  });

  it('treats a hand that arrives after a long gap without ticks as lost and found', () => {
    const seen = engaged();
    const result = run([[hand(0.08), 100 + TRACKING_LOSS_MS + 50]], seen.state);
    expect(types(result.events)).toEqual(['lost', 'found']);
    expect(result.state.engaged).toBe(false);
  });

  it('counts only tracking frames toward a streak, not ticks', () => {
    const { events } = run([[hand(0.01), 0], [{ kind: 'tick' }, 100], [{ kind: 'tick' }, 200]]);
    expect(types(events)).toEqual(['found']);
  });
});

describe('holdStep', () => {
  it('needs both the time from the first qualifying frame and the minimum number of frames, and a non-qualifying frame ends the streak', () => {
    const first = holdStep(0, null, true, 1000, 80);
    expect(first).toEqual({ streak: 1, since: 1000, done: false });
    expect(holdStep(first.streak, first.since, true, 1060, 80).done).toBe(false);
    expect(holdStep(first.streak, first.since, true, 1080, 80)).toEqual({ streak: 2, since: 1000, done: true });
    // Enough time in one frame is not enough: two frames are the minimum.
    expect(holdStep(0, null, true, 1000, 0).done).toBe(false);
    expect(holdStep(1, 1000, true, 1000, 0).done).toBe(true);
    expect(holdStep(first.streak, first.since, false, 1100, 80)).toEqual({ streak: 0, since: null, done: false });
  });
});

describe('pickTarget and settleStep', () => {
  const part = (id: string, hit = { x: 0, y: 0, z: 0 }): Target => ({ kind: 'part', objectId: 'o1', partId: id, label: id, hit });
  const button: ScreenTarget = { id: 'mode-rotate', label: '手勢旋轉', left: 10, top: 10, right: 110, bottom: 60 };

  it('prefers an on-screen target over the part behind it', () => {
    const scene = () => part('housing');
    expect(pickTarget({ x: 50, y: 30 }, [button], scene)).toEqual({ kind: 'screen', id: 'mode-rotate', label: '手勢旋轉' });
    expect(pickTarget({ x: 500, y: 30 }, [button], scene)).toEqual(part('housing'));
    expect(pickTarget({ x: 500, y: 30 }, [], () => ({ kind: 'empty' }))).toEqual({ kind: 'empty' });
  });

  it('lets the last registered on-screen target win where they overlap', () => {
    const upper: ScreenTarget = { id: 'upper', label: 'upper', left: 50, top: 10, right: 200, bottom: 60 };
    expect(pickTarget({ x: 60, y: 30 }, [button, upper], () => ({ kind: 'empty' }))).toMatchObject({ id: 'upper' });
    expect(pickTarget({ x: 20, y: 30 }, [button, upper], () => ({ kind: 'empty' }))).toMatchObject({ id: 'mode-rotate' });
  });

  it('gives each target a key', () => {
    expect(targetKey({ kind: 'empty' })).toBe('');
    expect(targetKey({ kind: 'screen', id: 'mode-rotate', label: 'x' })).toBe('screen:mode-rotate');
    expect(targetKey(part('housing'))).toBe('o1:housing');
  });

  it('settles a raw target only after HOVER_SETTLE_MS', () => {
    let state = initialSettleState(0);
    state = settleStep(state, part('a'), 0);
    state = settleStep(state, part('a'), HOVER_SETTLE_MS - 1);
    expect(targetKey(state.settled)).toBe('');
    state = settleStep(state, part('a'), HOVER_SETTLE_MS);
    expect(targetKey(state.settled)).toBe('o1:a');
  });

  it('restarts the timer when the raw target changes before it settles', () => {
    let state = initialSettleState(0);
    state = settleStep(state, part('a'), 0);
    state = settleStep(state, part('b'), 100);
    state = settleStep(state, part('a'), 120);
    state = settleStep(state, part('a'), 120 + HOVER_SETTLE_MS - 1);
    expect(targetKey(state.settled)).toBe('');
    state = settleStep(state, part('a'), 120 + HOVER_SETTLE_MS);
    expect(targetKey(state.settled)).toBe('o1:a');
  });

  it('keeps a settled target through a short glance at another one and refreshes its hit point', () => {
    let state = settleStep(settleStep(initialSettleState(0), part('a'), 0), part('a'), HOVER_SETTLE_MS);
    state = settleStep(state, part('b'), 400);
    state = settleStep(state, part('a', { x: 1, y: 2, z: 3 }), 450);
    expect(state.settled).toEqual(part('a', { x: 1, y: 2, z: 3 }));
  });

  it('keeps the grabbed target when the cursor drifts while the fingers close', () => {
    // Part a is left of x = 100 and part b right of it; the cursor drifts 6 px across the edge over the frames that engage the pinch.
    const scene = (point: Point): Target => part(point.x < 100 ? 'a' : 'b');
    let settle = settleStep(settleStep(initialSettleState(0), scene({ x: 95, y: 0 }), 0), scene({ x: 95, y: 0 }), 500);
    expect(targetKey(settle.settled)).toBe('o1:a');
    let pinch = initialPinchState();
    let grabbed: Target | null = null;
    const frames: Array<[number, number, number]> = [[95, 0.08, 500], [98, 0.02, 540], [101, 0.02, 580], [101, 0.02, 620]];
    for (const [x, pinchM, time] of frames) {
      const cursor = { x, y: 0 };
      settle = settleStep(settle, pickTarget(cursor, [], scene), time);
      const result = pinchStep(pinch, { kind: 'hand', cursor, pinchM }, time);
      pinch = result.state;
      if (result.events.some(event => event.type === 'engage')) grabbed = settle.settled;
    }
    expect(grabbed && targetKey(grabbed)).toBe('o1:a');
  });
});

describe('overlayStyle and the skeleton', () => {
  const states: HandState[] = ['none', 'tracked', 'hover', 'grab', 'orbit', 'locked', 'join', 'fist', 'hold'];

  it('uses one hand colour for every state except locked, a different link colour, and none of the scene colours', () => {
    const taken = [HOLOGRAM.edgeColor, SELECTION.edgeColor].map(colour => colour.toLowerCase());
    expect(LINK_COLOUR).not.toBe(HAND_COLOUR);
    for (const colour of [HAND_COLOUR, LINK_COLOUR, LOCKED_COLOUR]) expect(taken).not.toContain(colour.toLowerCase());
    for (const state of states) {
      const { colour } = overlayStyle({ state });
      expect(colour).toBe(state === 'locked' ? LOCKED_COLOUR : HAND_COLOUR);
    }
  });
  it('shows state by shape: marks, line width and grey dashes for locked', () => {
    const style = (state: HandState) => overlayStyle({ state });
    expect(style('tracked')).toMatchObject({ dashed: false, lineWidth: 2, mark: 'none' });
    expect(style('hover')).toMatchObject({ dashed: false, lineWidth: 2, mark: 'ring-hollow' });
    expect(style('grab')).toMatchObject({ dashed: false, lineWidth: 3.5, mark: 'ring-filled' });
    expect(style('orbit')).toMatchObject({ dashed: false, lineWidth: 3.5, mark: 'ring-filled' });
    expect(style('join')).toMatchObject({ dashed: false, lineWidth: 3.5, mark: 'ring-filled' });
    expect(style('locked')).toMatchObject({ colour: LOCKED_COLOUR, dashed: true, mark: 'none' });
  });
  it('shows the fist by a rounded square instead of a ring: hollow for a closed fist, filled with thicker lines while it holds an object', () => {
    const style = (state: HandState) => overlayStyle({ state });
    expect(style('fist')).toMatchObject({ dashed: false, lineWidth: 2, mark: 'square-hollow' });
    expect(style('hold')).toMatchObject({ dashed: false, lineWidth: 3.5, mark: 'square-filled' });
  });  it('has the 21 distinct MediaPipe hand connections between valid landmarks', () => {
    expect(HAND_CONNECTIONS).toHaveLength(21);
    expect(new Set(HAND_CONNECTIONS.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`)).size).toBe(21);
    for (const [a, b] of HAND_CONNECTIONS) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(20);
    }
    // Every landmark is on at least one connection.
    expect(new Set(HAND_CONNECTIONS.flat()).size).toBe(21);
  });
});
describe('dedupeHands', () => {
  const sampleAt = (x: number, y: number) => handSample(syntheticHand({ cursor: { x, y }, pinchM: 0.06 }), { left: 0, top: 0, width: 1000, height: 1000 }, video)!;
  it('keeps one of two detections whose palm centres are closer than the limit, the first', () => {
    const first = sampleAt(0.5, 0.5);
    const near = { ...sampleAt(0.5, 0.5), palm: { x: first.palm.x + DUPLICATE_HAND_PX - 1, y: first.palm.y } };
    expect(dedupeHands([first, near])).toEqual([first]);
    expect(dedupeHands([near, first])).toEqual([near]);
  });
  it('keeps two hands whose palm centres are farther apart', () => {
    const first = sampleAt(0.3, 0.5);
    const second = sampleAt(0.7, 0.5);
    expect(dedupeHands([first, second])).toEqual([first, second]);
    const edge = { ...first, palm: { x: first.palm.x + DUPLICATE_HAND_PX, y: first.palm.y } };
    expect(dedupeHands([first, edge])).toHaveLength(2);
  });
  it('passes through none or one hand and honours a custom limit', () => {
    expect(dedupeHands([])).toEqual([]);
    const first = sampleAt(0.5, 0.5);
    expect(dedupeHands([first])).toEqual([first]);
    const near = { ...first, palm: { x: first.palm.x + 100, y: first.palm.y } };
    expect(dedupeHands([first, near], 150)).toEqual([first]);
  });
});
describe('assignHands', () => {
  const sample = (x: number, y = 300) => handSample(syntheticHand({ cursor: clientToNormalized({ x, y }, wideView, video), pinchM: 0.08 }), wideView, video)!;
  const palm = (x: number, y = 300): Point => sample(x, y).palm;

  it('has the two-hand constants of Task 4', () => {
    expect(HAND_MATCH_PX).toBe(160);
    expect(TWO_HAND_MIN_SPAN_PX).toBe(60);
  });
  it('gives a first hand the lowest free slot and a second hand the other one', () => {
    expect(assignHands([null, null], [sample(300)])).toEqual([0, null]);
    expect(assignHands([null, null], [sample(300), sample(700)])).toEqual([0, 1]);
    expect(assignHands([palm(300), null], [sample(310), sample(700)])).toEqual([0, 1]);
    expect(assignHands([null, palm(700)], [sample(705)])).toEqual([null, 0]);
  });
  it('keeps two moving hands in their slots, whatever their order in the frame', () => {
    const slots = [palm(300), palm(700)];
    expect(assignHands(slots, [sample(330), sample(680)])).toEqual([0, 1]);
    expect(assignHands(slots, [sample(680), sample(330)])).toEqual([1, 0]);
  });
  it('treats a jump beyond HAND_MATCH_PX as a new hand, and drops it when no slot is free', () => {
    expect(assignHands([palm(300), null], [sample(300 + HAND_MATCH_PX + 20)])).toEqual([null, 0]);
    expect(assignHands([palm(300), null], [sample(300 + HAND_MATCH_PX - 20)])).toEqual([0, null]);
    expect(assignHands([palm(300), palm(700)], [sample(500)])).toEqual([null, null]);
  });
  it('leaves the slot of a missing hand null', () => {
    expect(assignHands([palm(300), palm(700)], [sample(310)])).toEqual([0, null]);
    expect(assignHands([palm(300), palm(700)], [sample(690)])).toEqual([null, 0]);
    expect(assignHands([palm(300), palm(700)], [])).toEqual([null, null]);
  });
  it('takes the pairing with the smaller total movement', () => {
    // Hands at 300 and 420 move to 360 and 470: pairing 0→360 and 1→470 costs 110, the crossing one is not even in range.
    const slots = [palm(300), palm(420)];
    expect(assignHands(slots, [sample(470), sample(360)])).toEqual([1, 0]);
    expect(assignHands(slots, [sample(360), sample(470)])).toEqual([0, 1]);
  });
  it('prefers a valid pairing over a cheaper one that needs a jump beyond the limit, and matches as many slots as it can', () => {
    const slots = [palm(300), palm(560)];
    // Sample at 440 is within the limit of both slots; sample at 700 only of slot 1. The only full matching is 0→440, 1→700.
    expect(assignHands(slots, [sample(440), sample(700)])).toEqual([0, 1]);
  });
  it('honours a custom limit', () => {
    expect(assignHands([palm(300), null], [sample(360)], 30)).toEqual([null, 0]);
  });
});
