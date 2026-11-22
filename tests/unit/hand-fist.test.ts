import { describe, expect, it } from 'vitest';
import {
  DRAG_DEAD_ZONE_PX, FIST_ENGAGE_MS, FIST_ENGAGE_RATIO, FIST_RELEASE_MS, FIST_RELEASE_RATIO, HAND_LOST_MS, MIN_GESTURE_FRAMES, TRACKING_LOSS_MS,
} from '../../src/hands/constants';
import { curlRatio, fistStep, initialFistState, type FistEvent, type FistInput, type FistState } from '../../src/hands/fist';
import type { Point } from '../../src/hands/types';
import { syntheticHand } from '../fixtures/synthetic-hand';

const OPEN = 1.8;
const BETWEEN = (FIST_ENGAGE_RATIO + FIST_RELEASE_RATIO) / 2;
const CLOSED = 0.65;
const palm: Point = { x: 400, y: 300 };
/** Frame spacing of `frames` (33 ms, about 30 fps), and the frames that spacing needs to engage and to release: the first qualifying frame starts the clock. */
const FRAME_MS = 33;
const FIST_ENGAGE_FRAMES = Math.ceil(FIST_ENGAGE_MS / FRAME_MS) + 1;
const FIST_RELEASE_FRAMES = Math.ceil(FIST_RELEASE_MS / FRAME_MS) + 1;

describe('curlRatio', () => {
  const world = (options: { pinchM: number; fist?: boolean }) => syntheticHand({ cursor: { x: 0.5, y: 0.5 }, ...options }).world;
  it('is the largest tip-to-wrist over knuckle-to-wrist ratio: about 1.88 for the open hand', () => {
    expect(curlRatio(world({ pinchM: 0.08 }))).toBeCloseTo(1.88, 1);
  });
  it('stays high for a pinch, because the other fingers are still extended and the largest ratio counts', () => {
    const pinch = curlRatio(world({ pinchM: 0.01 }))!;
    expect(pinch).toBeGreaterThan(FIST_RELEASE_RATIO);
  });
  it('is 0.65 for the synthetic fist, below the engage ratio', () => {
    const fist = curlRatio(world({ pinchM: 0.08, fist: true }))!;
    expect(fist).toBeCloseTo(0.65, 2);
    expect(fist).toBeLessThan(FIST_ENGAGE_RATIO);
  });
  it('lets one extended finger rule out a fist', () => {
    const points = world({ pinchM: 0.08, fist: true })!.map(point => ({ ...point }));
    // Straighten the middle finger: its tip goes back to the open position.
    const open = world({ pinchM: 0.08 })!;
    points[12] = { ...open[12]! };
    expect(curlRatio(points)).toBeCloseTo(1.88, 1);
  });
  it('is null without 21 finite world landmarks or with a degenerate knuckle', () => {
    expect(curlRatio(undefined)).toBeNull();
    expect(curlRatio([])).toBeNull();
    const full = world({ pinchM: 0.08 })!;
    expect(curlRatio(full.slice(0, 20))).toBeNull();
    expect(curlRatio(full.map((point, index) => (index === 8 ? { ...point, x: Number.NaN } : point)))).toBeNull();
    // Knuckle 9 on the wrist: no distance to divide by.
    expect(curlRatio(full.map((point, index) => (index === 9 ? { ...full[0]! } : point)))).toBeNull();
  });
});

/** Feeds `[curl, time]` pairs (or explicit inputs) and returns the events of every step plus the final state. */
function run(steps: Array<[FistInput | number | 'none' | 'tick', number]>, from: FistState = initialFistState(), lossMs?: number) {
  let state = from;
  const log: FistEvent[][] = [];
  for (const [step, time] of steps) {
    const input: FistInput = step === 'none' ? { kind: 'none' } : step === 'tick' ? { kind: 'tick' }
      : typeof step === 'number' ? { kind: 'hand', palm, curl: step, pinchMoved: false } : step;
    const result = fistStep(state, input, time, lossMs);
    state = result.state;
    log.push(result.events);
  }
  return { state, log, events: log.flat() };
}
const types = (events: FistEvent[]) => events.map(event => event.type);
const frames = (value: number, count: number, from: number): Array<[number, number]> => Array.from({ length: count }, (_, index) => [value, from + index * 33]);

describe('fistStep', () => {
  const spaced = (value: number, count: number, spacing: number, from = 0): Array<[number, number]> => Array.from({ length: count }, (_, index) => [value, from + index * spacing]);

  it('engages after FIST_ENGAGE_MS from the first qualifying frame, whatever the frame rate, and never in fewer than MIN_GESTURE_FRAMES frames', () => {
    for (const spacing of [20, 33, 50, 100, 200]) {
      const log = run(spaced(CLOSED, 14, spacing)).log;
      const at = log.findIndex(events => types(events).includes('fist-engage'));
      expect(at).toBeGreaterThanOrEqual(MIN_GESTURE_FRAMES - 1);
      expect(at * spacing).toBeGreaterThanOrEqual(FIST_ENGAGE_MS);
      expect((at - 1) * spacing).toBeLessThan(FIST_ENGAGE_MS);
    }
    // 10 frames per second: three frames (200 ms); 30 frames per second: six (165 ms).
    expect(run(spaced(CLOSED, 2, 100)).state.engaged).toBe(false);
    expect(run(spaced(CLOSED, 3, 100)).state.engaged).toBe(true);
    expect(run(spaced(CLOSED, 5, 33)).state.engaged).toBe(false);
    expect(run(spaced(CLOSED, 6, 33)).state.engaged).toBe(true);
  });

  it('releases after FIST_RELEASE_MS from the first qualifying frame, whatever the frame rate', () => {
    const engaged = run(spaced(CLOSED, 3, 100)).state;
    // 10 frames per second: two frames; 30 frames per second: three.
    expect(run(spaced(OPEN, 1, 100, 300), engaged).state.engaged).toBe(true);
    expect(run(spaced(OPEN, 2, 100, 300), engaged).events).toEqual([{ type: 'fist-release', moved: false }]);
    expect(run(spaced(OPEN, 2, 33, 300), engaged).state.engaged).toBe(true);
    expect(run(spaced(OPEN, 3, 33, 300), engaged).events).toEqual([{ type: 'fist-release', moved: false }]);
  });

  it('a single noisy frame never engages or releases, at any frame rate', () => {
    for (const spacing of [33, 100, 200]) {
      const noisy = run([[CLOSED, 0], [OPEN, spacing], [CLOSED, 2 * spacing], [OPEN, 3 * spacing], [CLOSED, 4 * spacing], [OPEN, 5 * spacing]]);
      expect(noisy.state.engaged).toBe(false);
      const engaged = run(spaced(CLOSED, 8, spacing)).state;
      const from = 8 * spacing;
      const flicker = run([[OPEN, from], [CLOSED, from + spacing], [OPEN, from + 2 * spacing], [CLOSED, from + 3 * spacing], [OPEN, from + 4 * spacing]], engaged);
      expect(flicker.state.engaged).toBe(true);
      expect(flicker.events).toEqual([]);
    }
  });

  it('a long gap inside a long loss window does not make one frame enough: the minimum number of frames still holds', () => {
    expect(run([[CLOSED, 0], ['tick', 1000]], initialFistState(), 5000).state.engaged).toBe(false);
    expect(run([[CLOSED, 0], [CLOSED, 1000]], initialFistState(), 5000).state.engaged).toBe(true);
  });

  it('engages after FIST_ENGAGE_MS of consecutive frames below the engage ratio (6 frames 33 ms apart), not before', () => {
    const early = run(frames(CLOSED, FIST_ENGAGE_FRAMES - 1, 0));
    expect(early.state.engaged).toBe(false);
    expect(early.events).toEqual([]);
    const done = run(frames(CLOSED, FIST_ENGAGE_FRAMES, 0));
    expect(done.state.engaged).toBe(true);
    expect(done.events).toEqual([{ type: 'fist-engage', palm }]);
    expect(done.state.engagePalm).toEqual(palm);
  });

  it('engages only below the ratio: a value at the ratio does not count', () => {
    expect(run(frames(FIST_ENGAGE_RATIO, 10, 0)).state.engaged).toBe(false);
    expect(run(frames(FIST_ENGAGE_RATIO - 0.01, FIST_ENGAGE_FRAMES, 0)).state.engaged).toBe(true);
  });

  it('ignores a one-frame spike: the streak restarts', () => {
    const spiky = run([...frames(CLOSED, FIST_ENGAGE_FRAMES - 1, 0), [OPEN, 200], ...frames(CLOSED, FIST_ENGAGE_FRAMES - 1, 233)]);
    expect(spiky.state.engaged).toBe(false);
    expect(spiky.events).toEqual([]);
  });

  it('does not change between the two ratios, in either direction', () => {
    const open = run(frames(BETWEEN, 20, 0));
    expect(open.state.engaged).toBe(false);
    const engaged = run(frames(CLOSED, FIST_ENGAGE_FRAMES, 0)).state;
    const held = run(frames(BETWEEN, 20, 200), engaged);
    expect(held.state.engaged).toBe(true);
    expect(held.events).toEqual([]);
  });

  it('releases after FIST_RELEASE_MS of frames above the release ratio (3 frames 33 ms apart), and reports whether it moved', () => {
    const engaged = run(frames(CLOSED, FIST_ENGAGE_FRAMES, 0)).state;
    const early = run(frames(OPEN, FIST_RELEASE_FRAMES - 1, 200), engaged);
    expect(early.state.engaged).toBe(true);
    const done = run(frames(OPEN, FIST_RELEASE_FRAMES, 200), engaged);
    expect(done.state.engaged).toBe(false);
    expect(done.events).toEqual([{ type: 'fist-release', moved: false }]);
    const atRatio = run(frames(FIST_RELEASE_RATIO, 10, 200), engaged);
    expect(atRatio.state.engaged).toBe(true);
  });

  it('a spike while engaged does not release', () => {
    const engaged = run(frames(CLOSED, FIST_ENGAGE_FRAMES, 0)).state;
    const result = run([...frames(OPEN, FIST_RELEASE_FRAMES - 1, 200), [CLOSED, 300], ...frames(OPEN, FIST_RELEASE_FRAMES - 1, 333)], engaged);
    expect(result.state.engaged).toBe(true);
    expect(result.events).toEqual([]);
  });

  it('a frame without a curl ratio (no world landmarks) never engages and resets the streak', () => {
    const none = run(Array.from({ length: 10 }, (_, index): [FistInput, number] => [{ kind: 'hand', palm, curl: null, pinchMoved: false }, index * 33]));
    expect(none.state.engaged).toBe(false);
    const broken = run([...frames(CLOSED, FIST_ENGAGE_FRAMES - 1, 0), [{ kind: 'hand', palm, curl: null, pinchMoved: false }, 200], ...frames(CLOSED, FIST_ENGAGE_FRAMES - 1, 233)]);
    expect(broken.state.engaged).toBe(false);
  });

  it('a hand whose pinch has left its dead zone cannot engage', () => {
    const blocked = run(Array.from({ length: 10 }, (_, index): [FistInput, number] => [{ kind: 'hand', palm, curl: CLOSED, pinchMoved: true }, index * 33]));
    expect(blocked.state.engaged).toBe(false);
    expect(blocked.events).toEqual([]);
    // It can engage once the pinch is no longer moved.
    const free = run([...Array.from({ length: 2 }, (_, index): [FistInput, number] => [{ kind: 'hand', palm, curl: CLOSED, pinchMoved: true }, index * 33]), ...frames(CLOSED, FIST_ENGAGE_FRAMES, 100)]);
    expect(free.state.engaged).toBe(true);
  });

  it('starts a move after DRAG_DEAD_ZONE_PX of palm movement, once, and the releasing frame does not start one', () => {
    const engaged = run(frames(CLOSED, FIST_ENGAGE_FRAMES, 0)).state;
    const inside = run([[{ kind: 'hand', palm: { x: palm.x + DRAG_DEAD_ZONE_PX, y: palm.y }, curl: CLOSED, pinchMoved: false }, 200]], engaged);
    expect(inside.events).toEqual([]);
    expect(inside.state.moved).toBe(false);
    const far = { x: palm.x + DRAG_DEAD_ZONE_PX + 1, y: palm.y };
    const outside = run([
      [{ kind: 'hand', palm: far, curl: CLOSED, pinchMoved: false }, 200],
      [{ kind: 'hand', palm: { x: far.x + 40, y: far.y }, curl: CLOSED, pinchMoved: false }, 233],
    ], engaged);
    expect(types(outside.events)).toEqual(['fist-move-start']);
    expect(outside.state.moved).toBe(true);
    // Fingers opening shifts the palm: the frame that releases starts no move.
    const releasing = run([
      ...frames(OPEN, FIST_RELEASE_FRAMES - 1, 200),
      [{ kind: 'hand', palm: far, curl: OPEN, pinchMoved: false }, 300],
    ], engaged);
    expect(types(releasing.events)).toEqual(['fist-release']);
    expect(releasing.events).toEqual([{ type: 'fist-release', moved: false }]);
    // After a move, the release says so.
    const afterMove = run(frames(OPEN, FIST_RELEASE_FRAMES, 400), outside.state);
    expect(afterMove.events).toEqual([{ type: 'fist-release', moved: true }]);
  });

  describe('time-outs', () => {
    it('forgets an idle hand missing for HAND_LOST_MS without an event, and an engaged one after TRACKING_LOSS_MS with fist-lost', () => {
      const idle = run([...frames(CLOSED, 1, 0), ['none', 100], ['tick', HAND_LOST_MS + 1]]);
      expect(idle.state).toEqual(initialFistState());
      expect(idle.events).toEqual([]);
      const engaged = run(frames(CLOSED, FIST_ENGAGE_FRAMES, 0));
      const lastSeen = engaged.state.handSeenAt!;
      const early = run([['none', lastSeen + TRACKING_LOSS_MS - 1]], engaged.state);
      expect(early.state.engaged).toBe(true);
      expect(early.events).toEqual([]);
      const lost = run([['none', lastSeen + TRACKING_LOSS_MS]], engaged.state);
      expect(lost.events).toEqual([{ type: 'fist-lost' }]);
      expect(lost.state).toMatchObject({ engaged: false, handSeenAt: null });
    });

    it('a tick alone applies the time-out, and a hand back within it continues the same fist', () => {
      const engaged = run(frames(CLOSED, FIST_ENGAGE_FRAMES, 0));
      const lastSeen = engaged.state.handSeenAt!;
      expect(run([['tick', lastSeen + TRACKING_LOSS_MS + 1]], engaged.state).events).toEqual([{ type: 'fist-lost' }]);
      const back = run([['none', lastSeen + 100], [CLOSED, lastSeen + 200]], engaged.state);
      expect(back.state.engaged).toBe(true);
      expect(back.events).toEqual([]);
    });

    it('a custom loss window replaces the defaults', () => {
      const engaged = run(frames(CLOSED, FIST_ENGAGE_FRAMES, 0));
      const lastSeen = engaged.state.handSeenAt!;
      expect(run([['tick', lastSeen + 1000]], engaged.state, 2000).events).toEqual([]);
      expect(run([['tick', lastSeen + 2001]], engaged.state, 2000).events).toEqual([{ type: 'fist-lost' }]);
    });
  });
});
