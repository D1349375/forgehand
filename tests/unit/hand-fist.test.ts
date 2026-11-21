import { describe, expect, it } from 'vitest';
import {
  DRAG_DEAD_ZONE_PX, FIST_ENGAGE_FRAMES, FIST_ENGAGE_RATIO, FIST_RELEASE_FRAMES, FIST_RELEASE_RATIO, HAND_LOST_MS, TRACKING_LOSS_MS,
} from '../../src/hands/constants';
import { curlRatio, fistStep, initialFistState, type FistEvent, type FistInput, type FistState } from '../../src/hands/fist';
import type { Point } from '../../src/hands/types';
import { syntheticHand } from '../fixtures/synthetic-hand';

const OPEN = 1.8;
const BETWEEN = (FIST_ENGAGE_RATIO + FIST_RELEASE_RATIO) / 2;
const CLOSED = 0.65;
const palm: Point = { x: 400, y: 300 };

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
  it('engages after FIST_ENGAGE_FRAMES consecutive frames below the engage ratio, not before', () => {
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
    const spiky = run([...frames(CLOSED, FIST_ENGAGE_FRAMES - 1, 0), [OPEN, 100], ...frames(CLOSED, FIST_ENGAGE_FRAMES - 1, 133)]);
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

  it('releases after FIST_RELEASE_FRAMES frames above the release ratio, and reports whether it moved', () => {
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
    const broken = run([...frames(CLOSED, FIST_ENGAGE_FRAMES - 1, 0), [{ kind: 'hand', palm, curl: null, pinchMoved: false }, 100], ...frames(CLOSED, FIST_ENGAGE_FRAMES - 1, 133)]);
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
