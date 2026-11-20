import { describe, expect, it, vi } from 'vitest';
import { CANCEL_NOTICE_MS, HAND_LOST_MS, TRACKING_LOSS_MS, TWO_HAND_MIN_SPAN_PX } from '../../src/hands/constants';
import { HandController, type GrabSession, type HandPort, type OrbitSession } from '../../src/hands/controller';
import { decidePinch } from '../../src/hands/decide';
import type { Gate } from '../../src/hands/gate';
import { joinGesture, type JoinRule } from '../../src/hands/join';
import { handSample } from '../../src/hands/mapping';
import { angleDelta, beyondDeadZone, pairAngle, pairSpan } from '../../src/hands/pair';
import { badgeBox, drawBadge, drawLink, drawRing, type Box } from '../../src/hands/skeleton';
import { createStats } from '../../src/hands/stats';
import { HAND_COLOUR, LINK_COLOUR, overlayStyle } from '../../src/hands/style';
import { badgeText, debugLine, handStatus, shortenName } from '../../src/hands/text';
import { EMPTY_TARGET, type HandSample, type HandSlot, type HandState, type OverlayFrame, type Point, type Target } from '../../src/hands/types';
import { clientToNormalized, syntheticHand } from '../fixtures/synthetic-hand';

const VIEW = { left: 0, top: 0, width: 1000, height: 800 };
const VIDEO = { width: 1000, height: 800 };
const OPEN = 0.08;
const CLOSED = 0.015;
const FRAME_MS = 33;
const FULL: Gate = { level: 'full', reason: null };
const VIEW_ONLY: Gate = { level: 'view-only', reason: 'exploded' };
const OFF: Gate = { level: 'off', reason: 'slow' };

/** A hand with its pinch midpoint at client point (x, y). */
function hand(x: number, y: number, closed = false): HandSample {
  const cursor = clientToNormalized({ x, y }, VIEW, VIDEO);
  return handSample(syntheticHand({ cursor, pinchM: closed ? CLOSED : OPEN }), VIEW, VIDEO)!;
}

const part = (objectId: string, partId: string, label = partId): Target => ({ kind: 'part', objectId, partId, label, hit: { x: 0, y: 0, z: 0 } });

class FakeGrab implements GrabSession {
  previews: Point[] = [];
  valid = true;
  commits = 0;
  cancels = 0;
  rebases = 0;
  constructor(private readonly log: string[]) {}
  preview(offset: Point) { this.previews.push(offset); return this.valid; }
  rebase() { this.rebases++; this.log.push('grab.rebase'); }
  commit() { this.commits++; this.log.push('grab.commit'); }
  cancel() { this.cancels++; this.log.push('grab.cancel'); }
}

class FakeOrbit implements OrbitSession {
  previews: Point[] = [];
  ends = 0;
  rebases = 0;
  constructor(private readonly log: string[]) {}
  preview(offset: Point) { this.previews.push(offset); }
  rebase() { this.rebases++; this.log.push('orbit.rebase'); }
  end() { this.ends++; this.log.push('orbit.end'); }
}

/** A controller, a fake port that records every call, and a clock that advances one frame at a time. */
function makeRig(options: { join?: JoinRule; objectCount?: number; pick?: (point: Point) => Target; lossMs?: number } = {}) {
  const log: string[] = [];
  const grabs: FakeGrab[] = [];
  const orbits: FakeOrbit[] = [];
  const state = {
    pick: options.pick ?? ((point: Point): Target => (point.x < 500 ? part('o1', 'p1', 'Arm') : EMPTY_TARGET)),
    refuseGrab: false,
  };
  const port: HandPort = {
    pick: point => state.pick(point),
    select: (objectId, partId) => { log.push(`select ${objectId}:${partId}`); },
    beginGrab: (objectId, partId) => {
      log.push(`beginGrab ${objectId}:${partId}`);
      if (state.refuseGrab) return null;
      const session = new FakeGrab(log);
      grabs.push(session);
      return session;
    },
    beginOrbit: () => {
      log.push('beginOrbit');
      const session = new FakeOrbit(log);
      orbits.push(session);
      return session;
    },
    press: id => { log.push(`press ${id}`); },
  };
  const controller = new HandController(port, { join: options.join, lossMs: options.lossMs });
  controller.setObjectCount(options.objectCount ?? 1);
  const cancelled: string[] = [];
  controller.onCancelled = reason => cancelled.push(reason);
  let now = 1000;
  let last: OverlayFrame = { hands: [], gesture: 'none', link: null, arc: null };
  /** `hands`: [x, y, closed?] per hand, in the order they are handed to the controller. */
  const run = (hands: ReadonlyArray<readonly [number, number, boolean?]>, frames = 1) => {
    for (let index = 0; index < frames; index++) {
      now += FRAME_MS;
      last = controller.frame(hands.map(([x, y, closed]) => hand(x, y, closed)), now);
    }
    return last;
  };
  const view = (slot: HandSlot) => last.hands.find(item => item.slot === slot);
  return { controller, state, log, grabs, orbits, cancelled, run, view, get now() { return now; }, get last() { return last; } };
}

type Rig = ReturnType<typeof makeRig>;

/** Open hands long enough for the hovered target to settle, then a closed pinch long enough to engage. */
function pinch(rig: Rig, hands: ReadonlyArray<readonly [number, number]>, closed: readonly boolean[] = hands.map(() => true)) {
  rig.run(hands.map(([x, y]) => [x, y, false] as const), 6);
  return rig.run(hands.map(([x, y], index) => [x, y, closed[index] ?? false] as const), 3);
}

/** The second hand moves in small steps from rom to 	o while the first stays put (a hand that jumps farther than HAND_MATCH_PX in one frame is a new hand). */
function glide(rig: Rig, owner: readonly [number, number], from: readonly [number, number], to: readonly [number, number], steps: number) {
  for (let step = 1; step <= steps; step++) {
    const k = step / steps;
    rig.run([[owner[0], owner[1], true], [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, true]], 1);
  }
}

const rotateRule: JoinRule = owner => (owner === 'grab' ? 'rotate' : owner === 'orbit' ? 'zoom' : null);

describe('decidePinch', () => {
  const screen: Target = { kind: 'screen', id: 'btn', label: '按鈕' };
  const p = part('o1', 'p1');
  const gate = (level: Gate['level']): Gate => ({ level, reason: level === 'full' ? null : 'agent' });
  it('follows the table for every gate', () => {
    expect(decidePinch(screen, { objectCount: 1, gate: gate('full') })).toEqual({ kind: 'press', id: 'btn' });
    expect(decidePinch(p, { objectCount: 1, gate: gate('full') })).toEqual({ kind: 'grab', objectId: 'o1', partId: 'p1', hit: { x: 0, y: 0, z: 0 } });
    expect(decidePinch(EMPTY_TARGET, { objectCount: 1, gate: gate('full') })).toEqual({ kind: 'orbit' });
    expect(decidePinch(screen, { objectCount: 1, gate: gate('view-only') })).toEqual({ kind: 'press', id: 'btn' });
    expect(decidePinch(p, { objectCount: 1, gate: gate('view-only') })).toEqual({ kind: 'orbit' });
    expect(decidePinch(EMPTY_TARGET, { objectCount: 1, gate: gate('view-only') })).toEqual({ kind: 'orbit' });
    for (const target of [screen, p, EMPTY_TARGET]) expect(decidePinch(target, { objectCount: 1, gate: gate('off') })).toEqual({ kind: 'none' });
  });
  it('does nothing on parts and empty space without objects, but still presses a screen target', () => {
    expect(decidePinch(p, { objectCount: 0, gate: gate('full') })).toEqual({ kind: 'none' });
    expect(decidePinch(EMPTY_TARGET, { objectCount: 0, gate: gate('full') })).toEqual({ kind: 'none' });
    expect(decidePinch(screen, { objectCount: 0, gate: gate('full') })).toEqual({ kind: 'press', id: 'btn' });
  });
});

describe('pair geometry', () => {
  it('measures span and angle, positive clockwise on screen', () => {
    expect(pairSpan({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(pairAngle({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
    expect(pairAngle({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90);
    expect(pairAngle({ x: 0, y: 0 }, { x: -10, y: 0 })).toBeCloseTo(180);
  });
  it('wraps angle changes to (−180, 180]', () => {
    expect(angleDelta(170, -170)).toBeCloseTo(20);
    expect(angleDelta(-170, 170)).toBeCloseTo(-20);
    expect(angleDelta(0, 180)).toBe(180);
    expect(angleDelta(0, -180)).toBe(180);
    expect(angleDelta(10, 40)).toBeCloseTo(30);
    expect(angleDelta(350, 10)).toBeCloseTo(20);
  });
  it('subtracts the dead zone from the change', () => {
    expect(beyondDeadZone(5, 12)).toBe(0);
    expect(beyondDeadZone(-5, 12)).toBe(0);
    expect(beyondDeadZone(20, 12)).toBe(8);
    expect(beyondDeadZone(-20, 12)).toBe(-8);
    expect(beyondDeadZone(12, 12)).toBe(0);
  });
});

describe('joinGesture', () => {
  it('has no rows yet: it returns null for every input', () => {
    for (const owner of ['press', 'grab', 'orbit', 'hold'] as const) {
      for (const kind of ['pinch', 'fist'] as const) {
        for (const target of [EMPTY_TARGET, part('o1', 'p1')]) {
          for (const gate of [FULL, VIEW_ONLY, OFF]) expect(joinGesture(owner, { kind, target }, gate)).toBeNull();
        }
      }
    }
  });
});

describe('HandController, one hand', () => {
  it('grabs a part of the active object: select, then beginGrab, and shows the grab state and badge', () => {
    const rig = makeRig();
    expect(pinch(rig, [[200, 300]]).hands[0]!.state).toBe('grab');
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
    expect(rig.last.gesture).toBe('grab');
    expect(rig.view(0)!.badge).toBe('手勢：已抓取 Arm');
  });
  it('grabs a part of an inactive object in one gesture: select first, then beginGrab, nothing else', () => {
    const rig = makeRig({ pick: () => part('o2', 'p9') });
    pinch(rig, [[200, 300]]);
    expect(rig.log).toEqual(['select o2:p9', 'beginGrab o2:p9']);
  });
  it('shows hover with the part name before the pinch, after the target has settled', () => {
    const rig = makeRig();
    rig.run([[200, 300]], 2);
    expect(rig.view(0)!.state).toBe('tracked');
    rig.run([[200, 300]], 6);
    expect(rig.view(0)!.state).toBe('hover');
    expect(rig.view(0)!.badge).toBe('手勢：對準 Arm');
    expect(rig.view(0)!.targetKey).toBe('o1:p1');
  });
  it('treats a pinch released inside the dead zone as a tap: it selects and cancels, with no commit', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([[200, 300, false]], 4);
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1', 'grab.cancel']);
    expect(rig.controller.stats).toMatchObject({ commits: 0, cancels: 0, drags: 0 });
    expect(rig.last.gesture).toBe('none');
  });
  it('previews offsets from the engage point and commits once on release', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([[200, 300, true]], 1);
    expect(rig.grabs[0]!.previews).toHaveLength(0);
    rig.run([[320, 360, true]], 40);
    const previews = rig.grabs[0]!.previews;
    expect(previews.length).toBeGreaterThan(5);
    const final = previews[previews.length - 1]!;
    expect(final.x).toBeCloseTo(120, 0);
    expect(final.y).toBeCloseTo(60, 0);
    expect(previews[0]!.x).toBeGreaterThan(8);
    expect(previews[0]!.x).toBeLessThan(final.x);
    rig.run([[320, 360, false]], 4);
    expect(rig.grabs[0]!.commits).toBe(1);
    expect(rig.grabs[0]!.cancels).toBe(0);
    expect(rig.controller.stats).toMatchObject({ drags: 1, commits: 1, cancels: 0 });
    rig.run([[320, 360, false]], 4);
    expect(rig.grabs[0]!.commits).toBe(1);
  });
  it('makes the pinch inert when beginGrab returns null', () => {
    const rig = makeRig();
    rig.state.refuseGrab = true;
    pinch(rig, [[200, 300]]);
    expect(rig.view(0)!.state).toBe('locked');
    expect(rig.view(0)!.badge).toBe('手勢：暫停');
    rig.run([[330, 300, true]], 30);
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
    expect(rig.last.gesture).toBe('none');
  });
  it('cancels when preview returns false, reports external, and stays inert until release', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.grabs[0]!.valid = false;
    rig.run([[330, 300, true]], 10);
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.cancelled).toEqual(['external']);
    const calls = rig.grabs[0]!.previews.length;
    rig.run([[400, 300, true]], 10);
    expect(rig.grabs[0]!.previews).toHaveLength(calls);
    expect(rig.view(0)!.state).toBe('locked');
    rig.run([[400, 300, false]], 4);
    rig.run([[400, 300, false]], 8);
    expect(rig.view(0)!.state).not.toBe('locked');
    expect(rig.grabs[0]!.commits).toBe(0);
  });
  it('continues the drag when the hand returns within TRACKING_LOSS_MS', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([[330, 300, true]], 10);
    rig.run([], 3);
    expect(rig.grabs[0]!.cancels).toBe(0);
    rig.run([[360, 300, true]], 5);
    expect(rig.grabs[0]!.cancels).toBe(0);
    expect(rig.last.gesture).toBe('grab');
    expect(rig.controller.stats.dragLosses).toBe(1);
    expect(rig.controller.stats.longestDragGapMs).toBeGreaterThan(0);
    expect(rig.controller.stats.longestDragGapMs).toBeLessThan(TRACKING_LOSS_MS);
  });
  it('cancels a grab when the hand is lost for longer than TRACKING_LOSS_MS and reports loss', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([[330, 300, true]], 10);
    rig.run([], Math.ceil(TRACKING_LOSS_MS / FRAME_MS) + 2);
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.grabs[0]!.commits).toBe(0);
    expect(rig.cancelled).toEqual(['loss']);
    expect(rig.controller.stats.cancels).toBe(1);
    expect(rig.controller.stats.longestDragGapMs).toBeGreaterThanOrEqual(TRACKING_LOSS_MS - FRAME_MS);
    expect(rig.last.hands).toHaveLength(0);
  });
  it('commits instead when the policy is keep', async () => {
    vi.resetModules();
    vi.doMock('../../src/hands/constants', async importOriginal => ({ ...(await importOriginal<typeof import('../../src/hands/constants')>()), ON_TRACKING_LOSS: 'keep' }));
    try {
      const { HandController: Keep } = await import('../../src/hands/controller');
      const grab = new FakeGrab([]);
      const controller = new Keep({ pick: () => part('o1', 'p1'), select: () => {}, beginGrab: () => grab, beginOrbit: () => null, press: () => {} });
      controller.setObjectCount(1);
      const cancelled: string[] = [];
      controller.onCancelled = reason => cancelled.push(reason);
      let now = 1000;
      const step = (hands: HandSample[]) => { now += FRAME_MS; controller.frame(hands, now); };
      for (let index = 0; index < 6; index++) step([hand(200, 300)]);
      for (let index = 0; index < 3; index++) step([hand(200, 300, true)]);
      for (let index = 0; index < 10; index++) step([hand(330, 300, true)]);
      for (let index = 0; index < 14; index++) step([]);
      expect(grab.commits).toBe(1);
      expect(grab.cancels).toBe(0);
      expect(cancelled).toEqual([]);
    } finally {
      vi.doUnmock('../../src/hands/constants');
      vi.resetModules();
    }
  });
  it('cancels a grab when the gate leaves full, and keeps the pinch inert until release', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([[330, 300, true]], 10);
    rig.controller.setGate(VIEW_ONLY);
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.cancelled).toEqual(['gate']);
    rig.controller.setGate(FULL);
    const log = [...rig.log];
    rig.run([[400, 300, true]], 10);
    expect(rig.log).toEqual(log);
    expect(rig.view(0)!.state).toBe('locked');
    rig.run([[400, 300, false]], 4);
    expect(rig.view(0)!.state).not.toBe('locked');
  });
  it('turns the view on empty space, previews offsets, and ends the orbit on release', () => {
    const rig = makeRig();
    pinch(rig, [[800, 300]]);
    expect(rig.log).toEqual(['beginOrbit']);
    expect(rig.view(0)!.state).toBe('orbit');
    expect(rig.view(0)!.badge).toBe('手勢：轉動視角');
    rig.run([[700, 300, true]], 40);
    const previews = rig.orbits[0]!.previews;
    expect(previews[previews.length - 1]!.x).toBeCloseTo(-100, 0);
    rig.run([[700, 300, false]], 4);
    expect(rig.orbits[0]!.ends).toBe(1);
    expect(rig.last.gesture).toBe('none');
  });
  it('turns the view on a part while the gate is view-only, and never grabs', () => {
    const rig = makeRig();
    rig.controller.setGate(VIEW_ONLY);
    rig.run([[200, 300]], 6);
    expect(rig.view(0)!.state).toBe('locked');
    rig.run([[200, 300, true]], 3);
    expect(rig.log).toEqual(['beginOrbit']);
  });
  it('ends an orbit when the gate turns off, but not when it turns view-only', () => {
    const rig = makeRig();
    pinch(rig, [[800, 300]]);
    rig.controller.setGate(VIEW_ONLY);
    expect(rig.orbits[0]!.ends).toBe(0);
    rig.controller.setGate(OFF);
    expect(rig.orbits[0]!.ends).toBe(1);
    expect(rig.cancelled).toEqual([]);
    rig.run([[800, 300, true]], 1);
    expect(rig.view(0)!.state).toBe('locked');
    rig.run([[700, 300, true]], 5);
    expect(rig.orbits[0]!.previews).toHaveLength(0);
  });
  it('does nothing while the gate is off, and stays inert when the gate returns during a held pinch', () => {
    const rig = makeRig();
    rig.controller.setGate(OFF);
    pinch(rig, [[800, 300]]);
    expect(rig.log).toEqual([]);
    rig.controller.setGate(FULL);
    rig.run([[700, 300, true]], 5);
    expect(rig.log).toEqual([]);
    expect(rig.view(0)!.state).toBe('locked');
    rig.run([[700, 300, false]], 4);
    rig.run([[700, 300, true]], 3);
    expect(rig.log).toEqual(['beginOrbit']);
  });
  it('does nothing without objects', () => {
    const rig = makeRig({ objectCount: 0 });
    pinch(rig, [[200, 300]]);
    pinch(rig, [[800, 300]]);
    expect(rig.log).toEqual([]);
  });
  it('presses a screen target on a tap, but not after a drag', () => {
    const screen: Target = { kind: 'screen', id: 'btn', label: '按鈕' };
    const rig = makeRig({ pick: () => screen });
    pinch(rig, [[200, 300]]);
    expect(rig.view(0)!.state).toBe('hover');
    rig.run([[200, 300, false]], 4);
    expect(rig.log).toEqual(['press btn']);
    const dragged = makeRig({ pick: () => screen });
    pinch(dragged, [[200, 300]]);
    dragged.run([[330, 300, true]], 30);
    dragged.run([[330, 300, false]], 4);
    expect(dragged.log).toEqual([]);
  });
  it('reset cancels a running grab and forgets the hands', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([[330, 300, true]], 10);
    rig.controller.reset();
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.cancelled).toEqual([]);
    const frame = rig.run([], 1);
    expect(frame.hands).toHaveLength(0);
    expect(frame.gesture).toBe('none');
  });
  it('reset ends a running orbit', () => {
    const rig = makeRig();
    pinch(rig, [[800, 300]]);
    rig.controller.reset();
    expect(rig.orbits[0]!.ends).toBe(1);
  });
  it('hides a hand that has been missing for HAND_LOST_MS, and tick reports the change once', () => {
    const rig = makeRig();
    rig.run([[200, 300]], 3);
    expect(rig.last.hands).toHaveLength(1);
    const lastSeen = rig.now;
    expect(rig.controller.tick(lastSeen + 100)).toBeNull();
    const hidden = rig.controller.tick(lastSeen + HAND_LOST_MS + 1);
    expect(hidden?.hands).toHaveLength(0);
    expect(rig.controller.tick(lastSeen + HAND_LOST_MS + 50)).toBeNull();
  });
  it('lets tick apply the loss time-out of a running grab when no frames arrive', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([[330, 300, true]], 10);
    const lastSeen = rig.now;
    expect(rig.controller.tick(lastSeen + TRACKING_LOSS_MS + 1)?.gesture).toBe('none');
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.cancelled).toEqual(['loss']);
  });
  describe('with a custom loss window (?hands-loss-ms)', () => {
    const GAP_MS = 1000;
    const gapFrames = Math.ceil(GAP_MS / FRAME_MS);
    it('keeps a drag through a 1000 ms gap at 2000 ms', () => {
      const rig = makeRig({ lossMs: 2000 });
      pinch(rig, [[200, 300]]);
      rig.run([[330, 300, true]], 10);
      rig.run([], gapFrames);
      expect(rig.grabs[0]!.cancels).toBe(0);
      rig.run([[360, 300, true]], 3);
      expect(rig.last.gesture).toBe('grab');
      expect(rig.cancelled).toEqual([]);
    });
    it('cancels the same drag at the default window', () => {
      const rig = makeRig();
      pinch(rig, [[200, 300]]);
      rig.run([[330, 300, true]], 10);
      rig.run([], gapFrames);
      expect(rig.grabs[0]!.cancels).toBe(1);
      expect(rig.cancelled).toEqual(['loss']);
    });
    it('still cancels once the gap passes the custom window', () => {
      const rig = makeRig({ lossMs: 2000 });
      pinch(rig, [[200, 300]]);
      rig.run([[330, 300, true]], 10);
      rig.run([], Math.ceil(2000 / FRAME_MS) + 2);
      expect(rig.grabs[0]!.cancels).toBe(1);
      expect(rig.cancelled).toEqual(['loss']);
    });
    it('keeps an idle hand visible for the custom window and hides it by the default', () => {
      const custom = makeRig({ lossMs: 2000 });
      custom.run([[200, 300]], 3);
      expect(custom.controller.tick(custom.now + GAP_MS)).toBeNull();
      expect(custom.controller.tick(custom.now + 2001)?.hands).toHaveLength(0);
      const normal = makeRig();
      normal.run([[200, 300]], 3);
      expect(normal.controller.tick(normal.now + GAP_MS)?.hands).toHaveLength(0);
    });
  });
  it('records per-hand numbers for the debug panel', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    const hand0 = rig.controller.stats.hands[0];
    expect(hand0.pinching).toBe(true);
    expect(hand0.pinchM).toBeCloseTo(CLOSED);
    expect(hand0.target).toBe('o1:p1');
    expect(rig.controller.stats.hands[1]).toEqual({ pinchM: null, pinching: false, target: '' });
  });
});

describe('HandController, two hands', () => {
  const left: [number, number] = [200, 300];
  const right: [number, number] = [700, 300];

  it('keeps each hand in its slot while they move', () => {
    const rig = makeRig();
    rig.run([[200, 300], [700, 300]], 3);
    rig.run([[230, 310], [670, 320]], 3);
    expect(rig.view(0)!.cursor.x).toBeLessThan(500);
    expect(rig.view(1)!.cursor.x).toBeGreaterThan(500);
    // The same two hands arriving in the other order keep their slots.
    rig.run([[670, 320], [230, 310]], 3);
    expect(rig.view(0)!.cursor.x).toBeLessThan(500);
    expect(rig.view(1)!.cursor.x).toBeGreaterThan(500);
  });

  it('makes a second pinch inert while the first hand grabs: locked, 另一手操作中, no port call', () => {
    const rig = makeRig({ pick: point => part('o1', point.x < 500 ? 'p1' : 'p2') });
    pinch(rig, [left]);
    const log = [...rig.log];
    rig.run([[...left, true], [...right, false]], 6);
    rig.run([[...left, true], [...right, true]], 3);
    expect(rig.log).toEqual(log);
    expect(rig.view(1)!.state).toBe('locked');
    expect(rig.view(1)!.badge).toBe('手勢：另一手操作中');
    expect(rig.view(0)!.state).toBe('grab');
    expect(rig.controller.stats.inert).toBe(1);
    expect(rig.last.link).toBeNull();
    rig.run([[...left, true], [...right, false]], 4);
    expect(rig.view(1)!.state).toBe('hover');
  });

  it('leaves a second hand free when the first pinch decided none, and the second starts its own gesture', () => {
    const screen: Target = { kind: 'screen', id: 'btn', label: '按鈕' };
    const rig = makeRig({ objectCount: 0, pick: point => (point.x < 500 ? EMPTY_TARGET : screen) });
    rig.run([[...left, false], [...right, false]], 6);
    rig.run([[...left, true], [...right, false]], 3);
    expect(rig.view(0)!.state).toBe('locked');
    expect(rig.view(0)!.badge).toBe('手勢：暫停');
    rig.run([[...left, true], [...right, true]], 3);
    expect(rig.view(1)!.state).toBe('hover');
    rig.run([[...left, true], [...right, false]], 4);
    expect(rig.log).toEqual(['press btn']);
    expect(rig.controller.stats.inert).toBe(0);
  });

  it('gives the gesture to slot 0 when both hands engage in the same frame', () => {
    const rig = makeRig({ pick: point => part('o1', point.x < 500 ? 'p1' : 'p2') });
    rig.run([[...left, false], [...right, false]], 6);
    rig.run([[...left, true], [...right, true]], 3);
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
    expect(rig.view(0)!.state).toBe('grab');
    expect(rig.view(1)!.state).toBe('locked');
    expect(rig.controller.stats.inert).toBe(1);
  });

  it('gives slot 0 to the first hand in the frame when two new hands appear, whatever their position', () => {
    const rig = makeRig({ pick: () => EMPTY_TARGET });
    rig.run([[700, 300], [200, 300]], 6);
    rig.run([[700, 300, true], [200, 300, true]], 3);
    expect(rig.view(0)!.state).toBe('orbit');
    expect(rig.view(0)!.cursor.x).toBeGreaterThan(500);
  });

  describe('with a test join rule', () => {
    /** A grabs the part on the left; B joins on the right with a rotate. */
    function joined(rule: JoinRule = rotateRule) {
      const rig = makeRig({ join: rule, pick: point => (point.x < 500 ? part('o1', 'p1', 'Arm') : EMPTY_TARGET) });
      rig.run([[...left, false], [...right, false]], 6);
      rig.run([[...left, true], [...right, false]], 3);
      rig.run([[320, 300, true], [...right, false]], 30);
      rig.run([[320, 300, true], [...right, true]], 3);
      return rig;
    }

    it('starts the joiner: join state, the gesture on the frame, and a link from the owner to the joiner', () => {
      const rig = joined();
      expect(rig.view(1)!.state).toBe('join');
      expect(rig.view(1)!.badge).toBe('手勢：雙手操作');
      expect(rig.last.gesture).toBe('rotate');
      expect(rig.controller.stats.twoHand).toEqual({ rotate: 1 });
      expect(rig.controller.stats.inert).toBe(0);
      const link = rig.last.link!;
      expect(link.from).toEqual(rig.view(0)!.cursor);
      expect(link.to).toEqual(rig.view(1)!.cursor);
      expect(rig.view(0)!.state).toBe('grab');
    });

    it('freezes the owner: its preview holds still while the joiner is engaged', () => {
      const rig = joined();
      const count = rig.grabs[0]!.previews.length;
      rig.run([[400, 350, true], [...right, true]], 30);
      expect(rig.grabs[0]!.previews).toHaveLength(count);
    });

    it('measures the joiner span and angle from the owner point, relative to the engage values', () => {
      const rig = joined();
      const start = rig.controller.twoHand!;
      expect(start.gesture).toBe('rotate');
      expect(start.startSpan).toBeCloseTo(pairSpan(rig.view(0)!.cursor, rig.view(1)!.cursor), 0);
      expect(start.startSpan).toBeGreaterThan(300);
      expect(start.angle).toBe(0);
      const owner = rig.view(0)!.cursor;
      // The joiner swings 30° clockwise about the owner at twice the distance.
      const radius = 2 * start.startSpan;
      glide(rig, [320, 300], [...right], [owner.x + radius * Math.cos(Math.PI / 6), owner.y + radius * Math.sin(Math.PI / 6)], 12);
      rig.run([[320, 300, true], [owner.x + radius * Math.cos(Math.PI / 6), owner.y + radius * Math.sin(Math.PI / 6), true]], 90);
      const measured = rig.controller.twoHand!;
      expect(measured.angle).toBeCloseTo(30, 0);
      expect(measured.span).toBeCloseTo(radius, -1);
      expect(measured.startSpan).toBe(start.startSpan);
    });

    it('accumulates angle past 180° without wrapping back', () => {
      const rig = joined();
      const owner = rig.view(0)!.cursor;
      const radius = 300;
      for (let degrees = 20; degrees <= 270; degrees += 10) {
        const radians = (degrees * Math.PI) / 180;
        rig.run([[320, 300, true], [owner.x + radius * Math.cos(radians), owner.y + radius * Math.sin(radians), true]], 12);
      }
      expect(rig.controller.twoHand!.angle).toBeGreaterThan(200);
    });

    it('holds the angle still while the hands are closer than TWO_HAND_MIN_SPAN_PX', () => {
      const rig = joined();
      const owner = rig.view(0)!.cursor;
      const near = (degrees: number): [number, number, boolean] => [owner.x + 45 * Math.cos((degrees * Math.PI) / 180), owner.y + 45 * Math.sin((degrees * Math.PI) / 180), true];
      expect(45).toBeLessThan(TWO_HAND_MIN_SPAN_PX);
      glide(rig, [320, 300], [...right], [near(0)[0], near(0)[1]], 10);
      rig.run([[320, 300, true], near(0)], 80);
      const held = rig.controller.twoHand!.angle;
      expect(rig.controller.twoHand!.span).toBeLessThan(TWO_HAND_MIN_SPAN_PX);
      rig.run([[320, 300, true], near(90)], 80);
      expect(rig.controller.twoHand!.angle).toBe(held);
    });

    it('re-bases the owner when the joiner releases: no jump on the next preview, and the owner keeps going', () => {
      const rig = joined();
      rig.run([[400, 350, true], [...right, true]], 40);
      const grab = rig.grabs[0]!;
      const before = grab.previews.length;
      rig.run([[400, 350, true], [...right, false]], 3);
      expect(grab.rebases).toBe(1);
      expect(rig.last.link).toBeNull();
      expect(rig.last.gesture).toBe('grab');
      expect(rig.view(1)!.state).not.toBe('join');
      expect(grab.previews.length).toBeGreaterThan(before);
      const jump = grab.previews[before]!;
      expect(Math.hypot(jump.x, jump.y)).toBeLessThan(20);
      rig.run([[480, 400, true], [...right, false]], 40);
      const final = grab.previews[grab.previews.length - 1]!;
      expect(final.x).toBeCloseTo(80, 0);
      expect(grab.cancels).toBe(0);
    });

    it('ends everything when the owner releases, and leaves the joiner inert until it releases', () => {
      const rig = joined();
      rig.run([[320, 300, false], [...right, true]], 4);
      expect(rig.grabs[0]!.commits).toBe(1);
      expect(rig.last.gesture).toBe('none');
      expect(rig.last.link).toBeNull();
      expect(rig.view(1)!.state).toBe('locked');
      const log = [...rig.log];
      rig.run([[320, 300, false], [640, 340, true]], 20);
      expect(rig.log).toEqual(log);
      expect(rig.view(1)!.state).toBe('locked');
      rig.run([[320, 300, false], [640, 340, false]], 4);
      expect(rig.view(1)!.state).not.toBe('locked');
      // Pinching again starts a gesture of its own now.
      rig.run([[320, 300, false], [640, 340, false]], 6);
      rig.run([[320, 300, false], [640, 340, true]], 3);
      expect(rig.log).not.toEqual(log);
    });

    it('treats a joiner lost for longer than TRACKING_LOSS_MS like a release', () => {
      const rig = joined();
      rig.run([[320, 300, true]], 4);
      expect(rig.grabs[0]!.rebases).toBe(0);
      expect(rig.last.link).not.toBeNull();
      rig.run([[320, 300, true]], Math.ceil(TRACKING_LOSS_MS / FRAME_MS) + 1);
      expect(rig.grabs[0]!.rebases).toBe(1);
      expect(rig.last.link).toBeNull();
      expect(rig.last.gesture).toBe('grab');
      expect(rig.grabs[0]!.cancels).toBe(0);
      expect(rig.controller.twoHand).toBeNull();
    });

    it('cancels the owner on its own loss and leaves the joiner inert', () => {
      const rig = joined();
      rig.run([[...right, true]], Math.ceil(TRACKING_LOSS_MS / FRAME_MS) + 2);
      expect(rig.grabs[0]!.cancels).toBe(1);
      expect(rig.cancelled).toEqual(['loss']);
      expect(rig.last.gesture).toBe('none');
      expect(rig.view(1)!.state).toBe('locked');
    });

    it('has the joiner leave when the rule no longer allows its gesture', () => {
      const rig = makeRig({ join: (owner, _joiner, gate) => (owner === 'orbit' && gate.reason !== 'agent' ? 'zoom' : null), pick: () => EMPTY_TARGET });
      rig.run([[...left, false], [...right, false]], 6);
      rig.run([[...left, true], [...right, false]], 3);
      rig.run([[...left, true], [...right, true]], 3);
      expect(rig.last.gesture).toBe('zoom');
      rig.controller.setGate({ level: 'view-only', reason: 'agent' });
      expect(rig.orbits[0]!.rebases).toBe(1);
      rig.run([[...left, true], [...right, true]], 2);
      expect(rig.last.gesture).toBe('orbit');
      expect(rig.view(1)!.state).toBe('locked');
      expect(rig.orbits[0]!.ends).toBe(0);
    });

    it('turns the view with the owner and re-bases the orbit when the joiner leaves', () => {
      const rig = makeRig({ join: rotateRule, pick: () => EMPTY_TARGET });
      rig.run([[...left, false], [...right, false]], 6);
      rig.run([[...left, true], [...right, false]], 3);
      rig.run([[...left, true], [...right, true]], 3);
      expect(rig.last.gesture).toBe('zoom');
      rig.run([[...left, true], [...right, false]], 4);
      expect(rig.orbits[0]!.rebases).toBe(1);
      expect(rig.last.gesture).toBe('orbit');
    });

    it('stays inert for a second joiner pinch, and for a pinch the rule refuses', () => {
      const rig = makeRig({ join: () => null, pick: () => EMPTY_TARGET });
      rig.run([[...left, false], [...right, false]], 6);
      rig.run([[...left, true], [...right, false]], 3);
      rig.run([[...left, true], [...right, true]], 3);
      expect(rig.view(1)!.state).toBe('locked');
      expect(rig.view(1)!.badge).toBe('手勢：另一手操作中');
      expect(rig.controller.twoHand).toBeNull();
    });
  });
});

describe('text', () => {
  const name13 = 'ABCDEFGHIJKLM';
  const target = (label: string): Target => part('o1', 'p1', label);
  const base = { gesture: 'none' as const, value: null };
  it('cuts a name to 12 code points and adds an ellipsis', () => {
    expect(shortenName('ABCDEFGHIJKL')).toBe('ABCDEFGHIJKL');
    expect(shortenName(name13)).toBe('ABCDEFGHIJKL…');
    expect(shortenName('𠀀'.repeat(13))).toBe(`${'𠀀'.repeat(12)}…`);
    expect(shortenName('一二三四五六七', 3)).toBe('一二三…');
  });
  it('writes the badge of every state with a 13-character name', () => {
    expect(badgeText({ ...base, state: 'tracked', target: EMPTY_TARGET })).toBe('手勢：待命');
    expect(badgeText({ ...base, state: 'hover', target: target(name13) })).toBe('手勢：對準 ABCDEFGHIJKL…');
    expect(badgeText({ ...base, state: 'hover', target: { kind: 'screen', id: 'x', label: name13 } })).toBe('手勢：對準 ABCDEFGHIJKL…');
    expect(badgeText({ ...base, state: 'grab', target: target(name13) })).toBe('手勢：已抓取 ABCDEFGHIJKL…');
    expect(badgeText({ ...base, state: 'orbit', target: EMPTY_TARGET })).toBe('手勢：轉動視角');
    expect(badgeText({ ...base, state: 'locked', target: target(name13) })).toBe('手勢：暫停');
    expect(badgeText({ ...base, state: 'locked', target: target(name13), inert: true })).toBe('手勢：另一手操作中');
    expect(badgeText({ ...base, state: 'join', target: EMPTY_TARGET })).toBe('手勢：雙手操作');
    expect(badgeText({ ...base, state: 'none', target: EMPTY_TARGET })).toBe('');
  });
  it('shows the cancel notice for CANCEL_NOTICE_MS, then nothing once a hand has been seen', () => {
    const input = { tracker: 'ready' as const, gate: FULL, cancelledAt: 1000, handSeen: true };
    expect(handStatus({ ...input, now: 1000 })).toEqual({ state: 'cancelled', text: '手部追蹤中斷，已取消這次移動。' });
    expect(handStatus({ ...input, now: 1000 + CANCEL_NOTICE_MS - 1 }).state).toBe('cancelled');
    expect(handStatus({ ...input, now: 1000 + CANCEL_NOTICE_MS })).toEqual({ state: 'hidden', text: '' });
    expect(handStatus({ ...input, cancelledAt: null, now: 1000 })).toEqual({ state: 'hidden', text: '' });
    // The agent and exploded notices come before it.
    expect(handStatus({ ...input, gate: VIEW_ONLY, now: 1000 }).state).toBe('exploded');
  });
  it('writes the debug line with the counters', () => {
    const stats = createStats();
    Object.assign(stats, { drags: 3, commits: 2, cancels: 1, dragLosses: 1, longestDragGapMs: 420, twoHand: { zoom: 1 }, inert: 2 });
    expect(debugLine(stats, { delegate: 'GPU', fps: 22, inferenceMs: 48, hands: 2, pinchMm: [24, 61], gesture: 'grab' })).toBe(
      'GPU · 每秒 22 幀 · 辨識 48 ms · 2 隻手 · 捏合 24／61 mm · 手勢 grab · 拖曳 3／完成 2／取消 1／拖曳中遺失 1（最長 420 ms） · 雙手 1 · 無效捏合 2',
    );
  });
});

describe('badgeBox', () => {
  const canvas = { width: 1000, height: 800 };
  const inside = (box: Box) => box.x >= 0 && box.y >= 0 && box.x + box.width <= canvas.width && box.y + box.height <= canvas.height;
  it('puts the badge 16 px right of and above the cursor', () => {
    const box = badgeBox({ x: 400, y: 400 }, 100, canvas);
    expect(box.x).toBe(416);
    expect(box.y + box.height).toBe(384);
    expect(box.width).toBeGreaterThanOrEqual(100);
  });
  it('stays inside the canvas near every edge and corner', () => {
    for (const x of [0, 5, 500, 995, 1000]) {
      for (const y of [0, 5, 400, 795, 800]) expect(inside(badgeBox({ x, y }, 120, canvas))).toBe(true);
    }
  });
  it('moves to the left of the cursor at the right edge and below it at the top edge', () => {
    const right = badgeBox({ x: 990, y: 400 }, 100, canvas);
    expect(right.x + right.width).toBeLessThan(990);
    const top = badgeBox({ x: 400, y: 4 }, 100, canvas);
    expect(top.y).toBeGreaterThan(4);
  });
  it('goes below its cursor when it would overlap the other badge', () => {
    const first = badgeBox({ x: 400, y: 400 }, 100, canvas);
    const second = badgeBox({ x: 410, y: 402 }, 100, canvas, first);
    expect(second.y).toBeGreaterThan(402);
    const apart = badgeBox({ x: 800, y: 400 }, 100, canvas, first);
    expect(apart.y + apart.height).toBe(384);
  });
});

describe('drawing helpers', () => {
  /** A 2D context that records the calls the helpers make. */
  function recorder() {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => {
        if (key === 'measureText') return (text: string) => ({ width: text.length * 7 });
        if (key in target) return target[key];
        return (...args: unknown[]) => { calls.push(`${key}(${args.map(String).join(',')})`); };
      },
      set: (target, key: string, value) => { target[key] = value; calls.push(`${key}=${String(value)}`); return true; },
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }
  it('draws a hollow ring over a target and a filled ring while acting, and nothing for other marks', () => {
    const hollow = recorder();
    drawRing(hollow.ctx, { x: 10, y: 20 }, overlayStyle({ state: 'hover' }));
    expect(hollow.calls.some(call => call.startsWith('arc(10,20'))).toBe(true);
    expect(hollow.calls.some(call => call.startsWith('fill('))).toBe(false);
    const filled = recorder();
    drawRing(filled.ctx, { x: 10, y: 20 }, overlayStyle({ state: 'grab' }));
    expect(filled.calls.some(call => call.startsWith('fill('))).toBe(true);
    expect(filled.calls).toContain(`strokeStyle=${HAND_COLOUR}`);
    const none = recorder();
    drawRing(none.ctx, { x: 10, y: 20 }, overlayStyle({ state: 'tracked' }));
    expect(none.calls).toEqual([]);
  });
  it('draws a badge with its text inside the box it returns', () => {
    const { ctx, calls } = recorder();
    const box = drawBadge(ctx, '手勢：待命', { x: 300, y: 300 }, { width: 1000, height: 800 });
    expect(box.x).toBe(316);
    expect(calls.some(call => call.startsWith('fillText(手勢：待命,'))).toBe(true);
    expect(calls.some(call => call.startsWith('roundRect('))).toBe(true);
  });
  it('draws the link between the hands in the link colour', () => {
    const { ctx, calls } = recorder();
    drawLink(ctx, { from: { x: 1, y: 2 }, to: { x: 30, y: 40 } });
    expect(calls).toContain('moveTo(1,2)');
    expect(calls).toContain('lineTo(30,40)');
    expect(calls).toContain(`strokeStyle=${LINK_COLOUR}`);
  });
});

describe('frame states', () => {
  it('reports the state names the overlay exposes', () => {
    const states: HandState[] = [];
    const rig = makeRig();
    rig.run([[200, 300]], 2);
    states.push(rig.view(0)!.state);
    rig.run([[200, 300]], 6);
    states.push(rig.view(0)!.state);
    rig.run([[200, 300, true]], 3);
    states.push(rig.view(0)!.state);
    expect(states).toEqual(['tracked', 'hover', 'grab']);
  });
});
