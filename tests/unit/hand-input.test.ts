import { describe, expect, it } from 'vitest';
import * as constants from '../../src/hands/constants';
import { DUPLICATE_HAND_PX, HAND_LOST_MS, HAND_MATCH_PX, HOVER_SETTLE_MS, TRACKING_LOSS_MS, TWO_HAND_MIN_SPAN_PX } from '../../src/hands/constants';
import { handSample, landmarkToClient } from '../../src/hands/mapping';
import { OneEuroFilter2D } from '../../src/hands/one-euro';
import { initialPinchState, pinchStep, type PinchEvent, type PinchInput, type PinchState } from '../../src/hands/pinch';
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
      PINCH_ENGAGE_M: 0.03, PINCH_ENGAGE_FRAMES: 2, PINCH_RELEASE_M: 0.05, PINCH_RELEASE_FRAMES: 3,
      HOVER_SETTLE_MS: 150, HAND_LOST_MS: 300, DRAG_DEAD_ZONE_PX: 8, DRAG_GAIN: 1.5, ORBIT_DEG_PER_PX: 0.4,
      TRACKING_LOSS_MS: 300, ON_TRACKING_LOSS: 'cancel', MIN_CONTROL_FPS: 10, SPEED_HOLD_MS: 2000, CANCEL_NOTICE_MS: 4000, BADGE_NAME_MAX: 12,
      TRACKED_HANDS: 2, DUPLICATE_HAND_PX: 40,
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

  it('a custom loss window replaces both defaults', () => {
    const open = hand(0.08);
    const gap = Math.max(HAND_LOST_MS, TRACKING_LOSS_MS) + 700;
    // Idle: a gap longer than HAND_LOST_MS loses the hand by default, not with a wider window.
    expect(types(run([[open, 0], [open, gap]]).events)).toEqual(['found', 'lost', 'found']);
    const idle = pinchStep(pinchStep(initialPinchState(), open, 0, 2000).state, open, gap, 2000);
    expect(types(idle.events)).toEqual([]);
    // Engaged: the same for TRACKING_LOSS_MS.
    const engaged = (lossMs?: number) => {
      let state = initialPinchState();
      for (const [input, time] of [[hand(0.08), 0], [hand(0.02), 16], [hand(0.02), 32]] as Array<[PinchInput, number]>) state = pinchStep(state, input, time, lossMs).state;
      expect(state.engaged).toBe(true);
      return pinchStep(state, { kind: 'tick' }, 32 + gap, lossMs);
    };
    expect(types(engaged().events)).toEqual(['lost']);
    expect(types(engaged(2000).events)).toEqual([]);
    expect(types(engaged(500).events)).toEqual(['lost']);
  });
  it('emits found on the first hand frame', () => {
    expect(run([[hand(0.08), 0], [hand(0.08), 16]]).log.map(types)).toEqual([['found'], []]);
  });

  it('engages after two consecutive frames below the threshold', () => {
    const { log } = run([[hand(0.08), 0], [hand(0.02), 16], [hand(0.02), 32]]);
    expect(log.map(types)).toEqual([['found'], [], ['engage']]);
    expect(log[2]![0]).toEqual({ type: 'engage', point: cursor });
  });

  it('needs the distance strictly below the engage threshold', () => {
    expect(run([[hand(0.03), 0], [hand(0.03), 16], [hand(0.03), 32]]).events.map(event => event.type)).toEqual(['found']);
    expect(types(run([[hand(0.0299), 0], [hand(0.0299), 16]]).events)).toEqual(['found', 'engage']);
  });

  it('ignores a one-frame spike, and a distance between the thresholds breaks the streak', () => {
    expect(types(run([[hand(0.01), 0], [hand(0.08), 16], [hand(0.01), 32], [hand(0.08), 48]]).events)).toEqual(['found']);
    expect(types(run([[hand(0.01), 0], [hand(0.04), 16], [hand(0.01), 32]]).events)).toEqual(['found']);
  });

  it('never engages without a pinch distance, and a missing distance breaks the streak', () => {
    expect(types(run([[hand(null), 0], [hand(null), 16], [hand(null), 32], [hand(null), 48]]).events)).toEqual(['found']);
    expect(types(run([[hand(0.01), 0], [hand(null), 16], [hand(0.01), 32]]).events)).toEqual(['found']);
  });

  const engaged = () => run([[hand(0.01), 0], [hand(0.01), 16]]);

  it('releases after three consecutive frames above the release threshold', () => {
    const start = engaged();
    const { log } = run([[hand(0.08), 32], [hand(0.08), 48], [hand(0.08), 64]], start.state);
    expect(log.map(types)).toEqual([[], [], ['release']]);
    expect(log[2]![0]).toEqual({ type: 'release', tap: true, point: cursor });
  });

  it('keeps the pinch between the thresholds and through a one-frame spike', () => {
    const start = engaged();
    const { events, state } = run([
      [hand(0.04), 32], [hand(0.05), 48], [hand(0.08), 64], [hand(0.01), 80], [hand(0.08), 96], [hand(0.08), 112], [hand(0.04), 128],
    ], start.state);
    expect(events).toEqual([]);
    expect(state.engaged).toBe(true);
  });

  it('is a tap inside the dead zone and a drag outside it', () => {
    const tap = run([
      [hand(0.01, { x: 100, y: 100 }), 0], [hand(0.01, { x: 100, y: 100 }), 16],
      [hand(0.01, { x: 105, y: 104 }), 32],
      [hand(0.08, { x: 105, y: 104 }), 48], [hand(0.08, { x: 105, y: 104 }), 64], [hand(0.08, { x: 105, y: 104 }), 80],
    ]);
    expect(types(tap.events)).toEqual(['found', 'engage', 'release']);
    expect(tap.events.at(-1)).toMatchObject({ type: 'release', tap: true });

    const drag = run([
      [hand(0.01, { x: 100, y: 100 }), 0], [hand(0.01, { x: 100, y: 100 }), 16],
      [hand(0.01, { x: 112, y: 100 }), 32], [hand(0.01, { x: 140, y: 100 }), 48],
      [hand(0.01, { x: 102, y: 100 }), 64],
      [hand(0.08, { x: 102, y: 100 }), 80], [hand(0.08, { x: 102, y: 100 }), 96], [hand(0.08, { x: 102, y: 100 }), 112],
    ]);
    // drag-start is emitted once, and returning to the dead zone does not make the release a tap.
    expect(types(drag.events)).toEqual(['found', 'engage', 'drag-start', 'release']);
    expect(drag.events.at(-1)).toMatchObject({ type: 'release', tap: false });
  });

  it('does not turn a tap into a drag on the releasing frame', () => {
    const start = engaged();
    const { events } = run([[hand(0.08), 32], [hand(0.08), 48], [hand(0.08, { x: 180, y: 100 }), 64]], start.state);
    expect(events).toEqual([{ type: 'release', tap: true, point: { x: 180, y: 100 } }]);
  });

  it('continues the pinch when the hand is missing for less than TRACKING_LOSS_MS', () => {
    const start = engaged();
    const { events, state } = run([
      [{ kind: 'none' }, 32], [{ kind: 'tick' }, 100], [{ kind: 'none' }, 200], [{ kind: 'tick' }, 16 + TRACKING_LOSS_MS - 1], [hand(0.01), 16 + TRACKING_LOSS_MS - 1],
    ], start.state);
    expect(events).toEqual([]);
    expect(state.engaged).toBe(true);
  });

  it('loses an engaged pinch after TRACKING_LOSS_MS without a hand, and finds the hand again later', () => {
    const start = engaged();
    const lost = run([[{ kind: 'none' }, 100], [{ kind: 'tick' }, 16 + TRACKING_LOSS_MS]], start.state);
    expect(lost.events).toEqual([{ type: 'lost', engaged: true }]);
    expect(lost.state.engaged).toBe(false);
    const back = run([[{ kind: 'tick' }, 700], [hand(0.08), 716]], lost.state);
    expect(types(back.events)).toEqual(['found']);
  });

  it('loses an idle hand after HAND_LOST_MS and emits lost once', () => {
    const seen = run([[hand(0.08), 1000]]);
    const result = run([[{ kind: 'tick' }, 1000 + HAND_LOST_MS - 1], [{ kind: 'tick' }, 1000 + HAND_LOST_MS], [{ kind: 'tick' }, 1000 + HAND_LOST_MS + 16], [{ kind: 'none' }, 2000]], seen.state);
    expect(result.log.map(types)).toEqual([[], ['lost'], [], []]);
    expect(result.events[0]).toEqual({ type: 'lost', engaged: false });
  });

  it('treats a hand that arrives after a long gap without ticks as lost and found', () => {
    const seen = run([[hand(0.01), 0], [hand(0.01), 16]]);
    const result = run([[hand(0.08), 16 + TRACKING_LOSS_MS + 50]], seen.state);
    expect(types(result.events)).toEqual(['lost', 'found']);
    expect(result.state.engaged).toBe(false);
  });

  it('counts only tracking frames toward a streak, not ticks', () => {
    const { events } = run([[hand(0.01), 0], [{ kind: 'tick' }, 16], [{ kind: 'tick' }, 32]]);
    expect(types(events)).toEqual(['found']);
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
    // Part a is left of x = 100 and part b right of it; the cursor drifts 6 px across the edge over 3 frames.
    const scene = (point: Point): Target => part(point.x < 100 ? 'a' : 'b');
    let settle = settleStep(settleStep(initialSettleState(0), scene({ x: 95, y: 0 }), 0), scene({ x: 95, y: 0 }), 500);
    expect(targetKey(settle.settled)).toBe('o1:a');
    let pinch = initialPinchState();
    let grabbed: Target | null = null;
    const frames: Array<[number, number, number]> = [[95, 0.08, 500], [98, 0.02, 516], [101, 0.02, 532]];
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
