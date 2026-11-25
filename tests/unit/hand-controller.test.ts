import { describe, expect, it, vi } from 'vitest';
import {
  CANCEL_NOTICE_MS, DRAG_DEAD_ZONE_PX, EXPLODE_DEAD_ZONE_PX, EXPLODE_FULL_FRACTION, FIST_ENGAGE_MS, FIST_ENGAGE_RATIO, FIST_RELEASE_MS, HAND_LOST_MS, PINCH_ENGAGE_MS, PINCH_RELEASE_MS, ROTATE_DEAD_ZONE_DEG,
  TRACKING_LOSS_MS, TWO_HAND_MIN_SPAN_PX, ZOOM_DEAD_ZONE_PX,
} from '../../src/hands/constants';
import { HandController, type GrabSession, type HandPort, type HoldSession, type OrbitSession } from '../../src/hands/controller';
import { decideFist, decidePinch } from '../../src/hands/decide';
import { explodeAmount } from '../../src/hands/drag';
import type { Gate } from '../../src/hands/gate';
import { joinGesture, type JoinRule } from '../../src/hands/join';
import { handSample } from '../../src/hands/mapping';
import { angleDelta, beyondDeadZone, knobAngle, pairAngle, pairSpan } from '../../src/hands/pair';
import { badgeBox, drawArc, drawBadge, drawLink, drawRing, drawSquare, type Box } from '../../src/hands/skeleton';
import { createStats } from '../../src/hands/stats';
import { HAND_COLOUR, LINK_COLOUR, overlayStyle } from '../../src/hands/style';
import { badgeText, debugLine, handStatus, shortenName } from '../../src/hands/text';
import { EMPTY_TARGET, type HandSample, type HandSlot, type HandState, type OverlayFrame, type Point, type Target } from '../../src/hands/types';
import { clientToNormalized, syntheticHand } from '../fixtures/synthetic-hand';

const VIEW = { left: 0, top: 0, width: 1000, height: 800 };
const VIDEO = { width: 1000, height: 800 };
const OPEN = 0.08;
const CLOSED = 0.015;
const FRAME_MS = 40;
/** Frames at FRAME_MS spacing that a fist needs to engage and to release. The first qualifying frame starts the clock, so one more than the time spans. */
const FIST_ENGAGE_FRAMES = Math.ceil(FIST_ENGAGE_MS / FRAME_MS) + 1;
const FIST_RELEASE_FRAMES = Math.ceil(FIST_RELEASE_MS / FRAME_MS) + 1;
const PINCH_ENGAGE_FRAMES = Math.ceil(PINCH_ENGAGE_MS / FRAME_MS) + 1;
const FULL: Gate = { level: 'full', reason: null };
const VIEW_ONLY: Gate = { level: 'view-only', reason: 'exploded' };
const OFF: Gate = { level: 'off', reason: 'slow' };

/** A hand with its pinch midpoint at client point (x, y). */
function hand(x: number, y: number, closed = false): HandSample {
  const cursor = clientToNormalized({ x, y }, VIEW, VIDEO);
  return handSample(syntheticHand({ cursor, pinchM: closed ? CLOSED : OPEN }), VIEW, VIDEO)!;
}

/** How far the palm centre of an open hand lies below its pinch midpoint, in client pixels. */
const PALM_DY = (() => { const sample = hand(500, 400); return sample.palm.y - sample.cursor.y; })();

/**
 * A hand with its palm centre at client point (x, y): a fist, or an open hand (pinching when closed). The palm stays where it is while
 * the fingers curl, so a hand can go from open to pinching to fist without moving. `thumbIn` puts the thumb on the index finger of a fist
 * (a real fist does), so it has a short thumb-index distance. `roll` turns the hand on screen, in degrees, clockwise (Task 11).
 */
function palmHand(x: number, y: number, mode: 'open' | 'pinch' | 'fist', thumbIn = false, roll = 0, side: 'left' | 'right' = 'right'): HandSample {
  const fist = mode === 'fist';
  const cursor = clientToNormalized({ x, y: fist ? y : y - PALM_DY }, VIEW, VIDEO);
  const sample = handSample(syntheticHand({ cursor, pinchM: mode === 'pinch' ? CLOSED : OPEN, fist, roll, side, aspect: VIDEO.width / VIDEO.height }), VIEW, VIDEO)!;
  return thumbIn ? { ...sample, pinchM: CLOSED } : sample;
}

const part = (objectId: string, partId: string, label = partId, objectName?: string): Target => ({ kind: 'part', objectId, partId, label, hit: { x: 0, y: 0, z: 0 }, ...(objectName ? { objectName } : {}) });

class FakeGrab implements GrabSession {
  previews: Point[] = [];
  rotates: number[] = [];
  valid = true;
  commits = 0;
  cancels = 0;
  rebases = 0;
  constructor(private readonly log: string[]) {}
  preview(offset: Point) { this.previews.push(offset); return this.valid; }
  rotate(angleDeg: number) { this.rotates.push(angleDeg); return this.valid; }
  rebase() { this.rebases++; this.log.push('grab.rebase'); }
  commit() { this.commits++; this.log.push('grab.commit'); }
  cancel() { this.cancels++; this.log.push('grab.cancel'); }
}

class FakeHold implements HoldSession {
  previews: Point[] = [];
  valid = true;
  commits = 0;
  cancels = 0;
  rebases = 0;
  constructor(private readonly log: string[]) {}
  preview(offset: Point) { this.previews.push(offset); return this.valid; }
  rebase() { this.rebases++; this.log.push('hold.rebase'); }
  commit() { this.commits++; this.log.push('hold.commit'); }
  cancel() { this.cancels++; this.log.push('hold.cancel'); }
}

class FakeOrbit implements OrbitSession {
  previews: Point[] = [];
  zooms: number[] = [];
  ends = 0;
  rebases = 0;
  constructor(private readonly log: string[]) {}
  preview(offset: Point) { this.previews.push(offset); }
  zoom(ratio: number) { this.zooms.push(ratio); }
  rebase() { this.rebases++; this.log.push('orbit.rebase'); }
  end() { this.ends++; this.log.push('orbit.end'); }
}

/** A controller, a fake port that records every call, and a clock that advances one frame at a time. */
function makeRig(options: { join?: JoinRule; objectCount?: number; pick?: (point: Point) => Target; lossMs?: number; fistEnabled?: boolean; frameMs?: number } = {}) {
  const log: string[] = [];
  const grabs: FakeGrab[] = [];
  const holds: FakeHold[] = [];
  const orbits: FakeOrbit[] = [];
  const explodes: number[] = [];
  const state = {
    pick: options.pick ?? ((point: Point): Target => (point.x < 500 ? part('o1', 'p1', 'Arm', 'Demo') : EMPTY_TARGET)),
    refuseGrab: false,
    refuseHold: false,
    /** The active object's explode amount, which setExplode writes like the workspace does. */
    explode: 0,
    viewportHeight: 800,
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
    activate: objectId => { log.push(`activate ${objectId}`); },
    beginHold: (objectId, hit) => {
      log.push(`beginHold ${objectId}`);
      if (state.refuseHold) return null;
      expect(hit).toEqual({ x: 0, y: 0, z: 0 });
      const session = new FakeHold(log);
      holds.push(session);
      return session;
    },
    explodeAmount: () => state.explode,
    setExplode: amount => { explodes.push(amount); state.explode = amount; },
    viewportHeight: () => state.viewportHeight,
  };
  const controller = new HandController(port, { join: options.join, lossMs: options.lossMs, fistEnabled: options.fistEnabled });
  controller.setObjectCount(options.objectCount ?? 1);
  const cancelled: string[] = [];
  controller.onCancelled = reason => cancelled.push(reason);
  let now = 1000;
  let last: OverlayFrame = { hands: [], gesture: 'none', link: null, arc: null };
  /** `hands`: [x, y, closed?] per hand (the pinch midpoint at x, y), or a ready sample (`palmHand`), in the order they are handed to the controller. */
  const run = (hands: ReadonlyArray<readonly [number, number, boolean?] | HandSample>, frames = 1) => {
    for (let index = 0; index < frames; index++) {
      now += options.frameMs ?? FRAME_MS;
      last = controller.frame(hands.map(entry => (Array.isArray(entry) ? hand(entry[0], entry[1], entry[2]) : entry as HandSample)), now);
    }
    return last;
  };
  const view = (slot: HandSlot) => last.hands.find(item => item.slot === slot);
  return { controller, state, log, grabs, holds, orbits, explodes, cancelled, run, view, get now() { return now; }, get last() { return last; } };
}

type Rig = ReturnType<typeof makeRig>;

/** Open hands long enough for the hovered target to settle, then a closed pinch long enough to engage. */
function pinch(rig: Rig, hands: ReadonlyArray<readonly [number, number]>, closed: readonly boolean[] = hands.map(() => true)) {
  rig.run(hands.map(([x, y]) => [x, y, false] as const), 6);
  return rig.run(hands.map(([x, y], index) => [x, y, closed[index] ?? false] as const), PINCH_ENGAGE_FRAMES);
}

/** The second hand moves in small steps from `from` to `to` while the first stays put (a hand that jumps farther than HAND_MATCH_PX in one frame is a new hand). */
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
  const AGENT: Gate = { level: 'view-only', reason: 'agent' };
  it('has these rows without the assemble context: orbit + pinch is a zoom unless hand control is off (Task 6), hold + pinch is an explode at full control or while exploded (Task 7), grab + pinch is a rotate by circling and grab + fist a rotate by the knob, both at full control only (Tasks 8 and 11); every other input is null', () => {
    for (const owner of ['press', 'grab', 'orbit', 'hold'] as const) {
      for (const kind of ['pinch', 'fist'] as const) {
        for (const target of [EMPTY_TARGET, part('o1', 'p1')]) {
          for (const gate of [FULL, VIEW_ONLY, AGENT, OFF]) {
            const zoom = owner === 'orbit' && kind === 'pinch' && gate.level !== 'off';
            const explode = owner === 'hold' && kind === 'pinch' && (gate.level === 'full' || (gate.level === 'view-only' && gate.reason === 'exploded'));
            const rotate = owner === 'grab' && gate.level === 'full';
            expect(joinGesture(owner, { kind, target }, gate)).toBe(zoom ? 'zoom' : explode ? 'explode' : rotate ? 'rotate' : null);
          }
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
    expect(hand0.curl).toBeCloseTo(1.88, 1);
    expect(hand0.fist).toBe(false);
    expect(rig.controller.stats.hands[1]).toEqual({ pinchM: null, pinching: false, target: '', curl: null, fist: false });
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

  it('makes a second pinch inert while the first hand grabs and the rule has no row for it: locked, 另一手操作中, no port call', () => {
    const rig = makeRig({ join: () => null, pick: point => part('o1', point.x < 500 ? 'p1' : 'p2') });
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

  it('gives the gesture to slot 0 when both hands engage in the same frame, and slot 1 then joins it as a rotate', () => {
    const rig = makeRig({ pick: point => part('o1', point.x < 500 ? 'p1' : 'p2') });
    rig.run([[...left, false], [...right, false]], 6);
    rig.run([[...left, true], [...right, true]], 3);
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
    expect(rig.view(0)!.state).toBe('grab');
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.last.gesture).toBe('rotate');
    expect(rig.controller.stats.inert).toBe(0);
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
      expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 0°');
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

describe('HandController, two-hand zoom (the real joinGesture)', () => {
  const owner: [number, number] = [260, 300];
  const start: [number, number] = [700, 300];
  /** The owner turns the view on empty space on the left; the other hand hovers over a part on the right. */
  const pickSides = (point: Point): Target => (point.x < 500 ? EMPTY_TARGET : part('o1', 'p2', 'Arm'));
  /** Where each rig's second hand is, so a second move starts from there (a jump beyond HAND_MATCH_PX is a new hand). */
  const joinerAt = new WeakMap<Rig, readonly [number, number]>();

  /** The owner pinches on the left and drags a little (so its preview is live), then the second hand pinches. */
  function zooming(options: { gate?: Gate; pick?: (point: Point) => Target } = {}) {
    const rig = makeRig({ pick: options.pick ?? pickSides });
    if (options.gate) rig.controller.setGate(options.gate);
    rig.run([[200, 300, false], [...start, false]], 6);
    rig.run([[200, 300, true], [...start, false]], 3);
    rig.run([[230, 300, true], [...start, false]], 6);
    rig.run([[...owner, true], [...start, false]], 30);
    expect(rig.orbits).toHaveLength(1);
    expect(rig.orbits[0]!.previews.length).toBeGreaterThan(0);
    rig.run([[...owner, true], [...start, true]], 3);
    return rig;
  }
  /** The second hand moves in small steps from where it is to `to`, then settles there. */
  function moveJoiner(rig: Rig, to: readonly [number, number]) {
    const from = joinerAt.get(rig) ?? start;
    glide(rig, owner, from, to, 20);
    rig.run([[...owner, true], [...to, true]], 80);
    joinerAt.set(rig, to);
  }

  it('joins an orbit with a pinch as a zoom: join state, 手勢：雙手縮放, gesture zoom, a link, even over a part', () => {
    const rig = zooming();
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.view(1)!.badge).toBe('手勢：雙手縮放');
    expect(rig.view(1)!.targetKey).not.toBe('');
    expect(rig.view(0)!.state).toBe('orbit');
    expect(rig.last.gesture).toBe('zoom');
    expect(rig.last.link).not.toBeNull();
    expect(rig.controller.stats.twoHand).toEqual({ zoom: 1 });
    expect(rig.controller.stats.inert).toBe(0);
    expect(rig.controller.twoHand!.gesture).toBe('zoom');
    // Joining alone does not zoom: the hands are inside the dead zone.
    expect(rig.orbits[0]!.zooms).toEqual([]);
    expect(rig.log).toEqual(['beginOrbit']);
  });

  it('zooms in when the hands spread and out when they come together, from the span at join', () => {
    const rig = zooming();
    const startSpan = rig.controller.twoHand!.startSpan;
    expect(startSpan).toBeGreaterThan(400);
    moveJoiner(rig, [900, 300]);
    const spread = rig.orbits[0]!.zooms.at(-1)!;
    const span = rig.controller.twoHand!.span;
    expect(span).toBeGreaterThan(startSpan + 100);
    expect(spread).toBeLessThan(1);
    expect(spread).toBeCloseTo(startSpan / (span - ZOOM_DEAD_ZONE_PX), 6);
    moveJoiner(rig, [450, 300]);
    const together = rig.orbits[0]!.zooms.at(-1)!;
    expect(rig.controller.twoHand!.span).toBeLessThan(startSpan - 100);
    expect(together).toBeGreaterThan(1);
    expect(together).toBeCloseTo(startSpan / (rig.controller.twoHand!.span + ZOOM_DEAD_ZONE_PX), 6);
  });

  it('does not zoom for a movement inside the dead zone', () => {
    const rig = zooming();
    moveJoiner(rig, [start[0] + ZOOM_DEAD_ZONE_PX - 3, 300]);
    expect(rig.orbits[0]!.zooms).toEqual([]);
    moveJoiner(rig, [start[0] - ZOOM_DEAD_ZONE_PX + 3, 300]);
    expect(rig.orbits[0]!.zooms).toEqual([]);
  });

  it('holds the orbit preview still while zooming', () => {
    const rig = zooming();
    const previews = rig.orbits[0]!.previews.length;
    glide(rig, owner, start, [800, 300], 10);
    // The owner's hand keeps moving too; the view is not turned.
    rig.run([[330, 380, true], [800, 300, true]], 60);
    expect(rig.orbits[0]!.zooms.length).toBeGreaterThan(0);
    expect(rig.orbits[0]!.previews).toHaveLength(previews);
    expect(rig.last.gesture).toBe('zoom');
  });

  it("re-bases the orbit when the second hand lets go, and the first hand then turns the view from there with no jump", () => {
    const rig = zooming();
    moveJoiner(rig, [850, 300]);
    const orbit = rig.orbits[0]!;
    const previews = orbit.previews.length;
    rig.run([[...owner, true], [850, 300, false]], 4);
    const zooms = orbit.zooms.length;
    expect(orbit.rebases).toBe(1);
    expect(orbit.ends).toBe(0);
    expect(rig.last.gesture).toBe('orbit');
    expect(rig.last.link).toBeNull();
    expect(rig.view(1)!.state).not.toBe('join');
    expect(orbit.zooms).toHaveLength(zooms);
    // The owner has not moved since the re-base, so the next previews start near zero.
    expect(orbit.previews.length).toBeGreaterThan(previews);
    const first = orbit.previews[previews]!;
    expect(Math.hypot(first.x, first.y)).toBeLessThan(20);
    rig.run([[owner[0] + 70, 300, true], [850, 300, false]], 40);
    expect(orbit.previews.at(-1)!.x).toBeCloseTo(70, 0);
    expect(orbit.zooms).toHaveLength(zooms);
  });

  it('ends the zoom with the owner and leaves the second hand inert until it releases', () => {
    const rig = zooming();
    moveJoiner(rig, [850, 300]);
    rig.run([[...owner, false], [850, 300, true]], 4);
    expect(rig.orbits[0]!.ends).toBe(1);
    expect(rig.last.gesture).toBe('none');
    expect(rig.view(1)!.state).toBe('locked');
    const zooms = rig.orbits[0]!.zooms.length;
    rig.run([[...owner, false], [700, 300, true]], 30);
    expect(rig.orbits[0]!.zooms).toHaveLength(zooms);
  });

  it('works while the gate is view-only: a pinch on a part turns the view and the second hand zooms', () => {
    const rig = zooming({ gate: VIEW_ONLY, pick: () => part('o1', 'p1', 'Arm') });
    expect(rig.log).toEqual(['beginOrbit']);
    expect(rig.last.gesture).toBe('zoom');
    moveJoiner(rig, [880, 300]);
    expect(rig.orbits[0]!.zooms.at(-1)!).toBeLessThan(1);
    expect(rig.view(1)!.badge).toBe('手勢：雙手縮放');
  });

  it('is inert while hand control is off, and a gate that turns off ends the zoom', () => {
    const off = makeRig({ pick: pickSides });
    off.controller.setGate(OFF);
    off.run([[...owner, false], [...start, false]], 6);
    off.run([[...owner, true], [...start, false]], 3);
    off.run([[...owner, true], [...start, true]], 3);
    expect(off.log).toEqual([]);
    expect(off.controller.twoHand).toBeNull();
    expect(off.last.gesture).toBe('none');
    expect(off.view(1)!.state).toBe('locked');

    const rig = zooming();
    moveJoiner(rig, [850, 300]);
    rig.controller.setGate(OFF);
    expect(rig.orbits[0]!.ends).toBe(1);
    rig.run([[...owner, true], [850, 300, true]], 3);
    expect(rig.last.gesture).toBe('none');
    expect(rig.view(1)!.state).toBe('locked');
  });

  it('writes the zoom badge only for the joining hand', () => {
    const base = { target: EMPTY_TARGET, value: null };
    expect(badgeText({ ...base, state: 'join', gesture: 'zoom' })).toBe('手勢：雙手縮放');
    expect(badgeText({ ...base, state: 'orbit', gesture: 'zoom' })).toBe('手勢：轉動視角');
  });
});

describe('HandController, two-hand rotate (Task 8, the real joinGesture)', () => {
  const owner: [number, number] = [500, 400];
  const RADIUS = 250;
  const onPart = () => part('o1', 'p1', 'Arm');
  /** The second hand's place on its circle around the owner, at `degrees` (positive is clockwise on screen, y grows down). */
  const at = (degrees: number, radius = RADIUS): [number, number] =>
    [owner[0] + radius * Math.cos((degrees * Math.PI) / 180), owner[1] + radius * Math.sin((degrees * Math.PI) / 180)];

  /** The owner pinches a part in the middle of the view and the second hand pinches 250 px to its right: they join as a rotate. */
  function rotating(options: { pick?: (point: Point) => Target } = {}) {
    const rig = makeRig({ pick: options.pick ?? onPart });
    rig.run([[...owner, false], [...at(0), false]], 6);
    rig.run([[...owner, true], [...at(0), false]], 3);
    rig.run([[...owner, true], [...at(0), true]], 3);
    return rig;
  }
  /** The second hand swings on its circle in steps of 10°, then settles (a hand that jumps beyond HAND_MATCH_PX in one frame is a new hand). */
  function swing(rig: Rig, from: number, to: number, ownerAt: readonly [number, number] = owner, settle = 40) {
    const step = to >= from ? 10 : -10;
    for (let degrees = from + step; step > 0 ? degrees < to : degrees > to; degrees += step) rig.run([[...ownerAt, true], [...at(degrees), true]], 6);
    rig.run([[...ownerAt, true], [...at(to), true]], settle);
  }
  const last = <T>(values: T[]): T => values[values.length - 1]!;

  it('joins a grab with a pinch as a rotate: join state, 手勢：雙手旋轉 0°, gesture rotate, a link and no arc yet, whatever is under the second hand', () => {
    const rig = rotating({ pick: point => (point.x < 600 ? onPart() : part('o1', 'p2', 'Cover')) });
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
    expect(rig.view(0)!.state).toBe('grab');
    expect(rig.view(0)!.badge).toBe('手勢：已抓取 Arm');
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 0°');
    expect(rig.last.gesture).toBe('rotate');
    expect(rig.last.link).not.toBeNull();
    expect(rig.last.arc).toBeNull();
    expect(rig.controller.stats.twoHand).toEqual({ rotate: 1 });
    expect(rig.controller.stats.inert).toBe(0);
    expect(rig.controller.twoHand!.gesture).toBe('rotate');
    // Joining alone turns nothing: the hands are inside the dead zone.
    expect(rig.grabs[0]!.rotates).toEqual([]);
  });

  it('turns the part clockwise for a clockwise swing of the vector and the other way for the other swing, by the angle less the dead zone', () => {
    const rig = rotating();
    swing(rig, 0, 30);
    expect(rig.controller.twoHand!.angle).toBeCloseTo(30, 0);
    const clockwise = last(rig.grabs[0]!.rotates);
    expect(clockwise).toBeCloseTo(beyondDeadZone(rig.controller.twoHand!.angle, ROTATE_DEAD_ZONE_DEG), 6);
    expect(clockwise).toBeCloseTo(25, 0);
    expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 25°');
    swing(rig, 30, -30);
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(-25, 0);
    expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 -25°');
    expect(rig.grabs[0]!.commits).toBe(0);
    expect(rig.grabs[0]!.cancels).toBe(0);
  });

  it('ignores a turn smaller than the dead zone and does not jump when it leaves it', () => {
    const rig = rotating();
    swing(rig, 0, ROTATE_DEAD_ZONE_DEG - 1);
    expect(rig.grabs[0]!.rotates).toEqual([]);
    expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 0°');
    expect(rig.last.arc).toBeNull();
    swing(rig, ROTATE_DEAD_ZONE_DEG - 1, ROTATE_DEAD_ZONE_DEG + 8);
    const sent = rig.grabs[0]!.rotates;
    expect(sent.length).toBeGreaterThan(0);
    // The first angle sent is small: the dead zone is taken off, so leaving it does not jump.
    expect(Math.abs(sent[0]!)).toBeLessThan(3);
    expect(last(sent)).toBeCloseTo(beyondDeadZone(rig.controller.twoHand!.angle, ROTATE_DEAD_ZONE_DEG), 6);
    expect(last(sent)).toBeCloseTo(8, 0);
    // Back inside the dead zone the part goes back to where the turn started.
    swing(rig, ROTATE_DEAD_ZONE_DEG + 8, 2);
    expect(last(rig.grabs[0]!.rotates)).toBe(0);
  });

  it('accumulates the angle across ±180° instead of wrapping back', () => {
    const rig = rotating();
    swing(rig, 0, 200);
    expect(rig.controller.twoHand!.angle).toBeCloseTo(200, 0);
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(195, 0);
    expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 195°');
    swing(rig, 200, -170);
    expect(rig.controller.twoHand!.angle).toBeCloseTo(-170, 0);
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(-165, 0);
  });

  it('holds the angle while the hands are closer than TWO_HAND_MIN_SPAN_PX, and reads it again when they part', () => {
    const rig = rotating();
    swing(rig, 0, 40);
    const held = rig.controller.twoHand!.angle;
    const sent = rig.grabs[0]!.rotates.length;
    // In along the same direction, around the owner while close, and out again at the new direction.
    for (let radius = 210; radius >= 45; radius -= 40) rig.run([[...owner, true], [...at(40, radius)!, true]], 6);
    rig.run([[...owner, true], [...at(40, 45), true]], 20);
    expect(rig.controller.twoHand!.span).toBeLessThan(TWO_HAND_MIN_SPAN_PX);
    for (let degrees = 50; degrees <= 130; degrees += 10) rig.run([[...owner, true], [...at(degrees, 45), true]], 6);
    rig.run([[...owner, true], [...at(130, 45), true]], 20);
    // The filters lag a little on the way in and out, so the angle may drift by a degree or two, but not by the 90° swung while close.
    expect(Math.abs(rig.controller.twoHand!.angle - held)).toBeLessThan(3);
    for (let radius = 85; radius <= 250; radius += 40) rig.run([[...owner, true], [...at(130, radius), true]], 6);
    rig.run([[...owner, true], [...at(130, 250), true]], 30);
    // The 90° swung while close was not read; turning on from there is.
    const back = rig.controller.twoHand!.angle;
    expect(Math.abs(back - held)).toBeLessThan(3);
    expect(rig.grabs[0]!.rotates.length).toBeGreaterThan(sent);
    swing(rig, 130, 160);
    expect(rig.controller.twoHand!.angle).toBeCloseTo(back + 30, 0);
  });

  it('holds the part still while rotating: the owner moving does not preview', () => {
    const rig = rotating();
    const previews = rig.grabs[0]!.previews.length;
    swing(rig, 0, 30, [400, 450]);
    expect(rig.grabs[0]!.rotates.length).toBeGreaterThan(0);
    expect(rig.grabs[0]!.previews).toHaveLength(previews);
    expect(rig.last.gesture).toBe('rotate');
  });

  it('draws an arc at the owner cursor from the start angle to the angle shown, and none inside the dead zone', () => {
    const rig = rotating();
    swing(rig, 0, 3);
    expect(rig.last.arc).toBeNull();
    swing(rig, 3, 40);
    const arc = rig.last.arc!;
    expect(arc).not.toBeNull();
    expect(arc.centre).toEqual(rig.view(0)!.cursor);
    expect(arc.fromDeg).toBeCloseTo(0, 0);
    expect(arc.toDeg).toBeCloseTo(35, 0);
    swing(rig, 40, -20);
    expect(rig.last.arc!.toDeg).toBeCloseTo(-15, 0);
  });

  it('keeps the rotation and re-bases the move when the second hand lets go, then the owner moves the part on from there', () => {
    const rig = rotating();
    swing(rig, 0, 30);
    const grab = rig.grabs[0]!;
    // The owner moves while the second hand stays: the vector between the hands turns, so the part turns on a little, but does not move.
    rig.run([[560, 400, true], [...at(30), true]], 30);
    expect(grab.previews).toEqual([]);
    const previews = grab.previews.length;
    rig.run([[560, 400, true], [...at(30), false]], 4);
    expect(grab.rebases).toBe(1);
    // Whatever turn was shown when the second hand left stays: nothing sends 0 or anything else afterwards.
    const sent = grab.rotates.length;
    const turned = last(grab.rotates);
    expect(turned).not.toBe(0);
    expect(rig.last.gesture).toBe('grab');
    expect(rig.last.link).toBeNull();
    expect(rig.last.arc).toBeNull();
    expect(rig.view(1)!.state).not.toBe('join');
    // The owner has not moved since the re-base: the next preview starts near zero, and it ends where the owner went.
    expect(grab.previews.length).toBeGreaterThan(previews);
    expect(Math.hypot(grab.previews[previews]!.x, grab.previews[previews]!.y)).toBeLessThan(20);
    rig.run([[640, 400, true], [...at(30), false]], 40);
    expect(last(grab.previews).x).toBeCloseTo(80, 0);
    expect(grab.rotates).toHaveLength(sent);
    expect(grab.cancels).toBe(0);
    rig.run([[640, 400, false], [...at(30), false]], 4);
    expect(grab.commits).toBe(1);
    expect(grab.cancels).toBe(0);
  });

  it('commits once when the owner lets go, although it never left its dead zone, and leaves the second hand inert', () => {
    const rig = rotating();
    swing(rig, 0, 30);
    expect(rig.grabs[0]!.previews).toEqual([]);
    rig.run([[...owner, false], [...at(30), true]], 4);
    expect(rig.grabs[0]!.commits).toBe(1);
    expect(rig.grabs[0]!.cancels).toBe(0);
    expect(rig.controller.stats.commits).toBe(1);
    expect(rig.last.gesture).toBe('none');
    expect(rig.last.link).toBeNull();
    expect(rig.view(1)!.state).toBe('locked');
    rig.run([[...owner, false], [...at(60), true]], 20);
    expect(rig.grabs[0]!.rotates.length).toBeGreaterThan(0);
    expect(rig.grabs).toHaveLength(1);
  });

  it('cancels quietly, like a tap, when the second hand only stayed inside the dead zone', () => {
    const rig = rotating();
    swing(rig, 0, ROTATE_DEAD_ZONE_DEG - 2);
    rig.run([[...owner, false], [...at(ROTATE_DEAD_ZONE_DEG - 2), true]], 4);
    expect(rig.grabs[0]!.commits).toBe(0);
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.cancelled).toEqual([]);
  });

  it('commits when the turn went out of the dead zone and came back: the scene sees there is nothing to write', () => {
    const rig = rotating();
    swing(rig, 0, 30);
    swing(rig, 30, 0);
    expect(last(rig.grabs[0]!.rotates)).toBe(0);
    rig.run([[...owner, false], [...at(0), true]], 4);
    expect(rig.grabs[0]!.commits).toBe(1);
  });

  it('cancels the grab and its rotation when the owner is lost for longer than TRACKING_LOSS_MS, and reports loss', () => {
    const rig = rotating();
    swing(rig, 0, 30);
    rig.run([[...at(30), true]], Math.ceil(TRACKING_LOSS_MS / FRAME_MS) + 2);
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.grabs[0]!.commits).toBe(0);
    expect(rig.cancelled).toEqual(['loss']);
    expect(rig.last.gesture).toBe('none');
    expect(rig.view(1)!.state).toBe('locked');
  });

  it('cancels when the scene says the grab is no longer valid while turning, and keeps both pinches inert until they open', () => {
    const rig = rotating();
    rig.grabs[0]!.valid = false;
    swing(rig, 0, 30);
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.cancelled).toEqual(['external']);
    expect(rig.last.gesture).toBe('none');
    expect(rig.view(0)!.state).toBe('locked');
    expect(rig.view(1)!.state).toBe('locked');
  });

  it('is cancelled with the grab when the gate leaves full control', () => {
    const rig = rotating();
    swing(rig, 0, 30);
    rig.controller.setGate(VIEW_ONLY);
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.grabs[0]!.commits).toBe(0);
    expect(rig.cancelled).toEqual(['gate']);
    rig.run([[...owner, true], [...at(30), true]], 3);
    expect(rig.last.gesture).toBe('none');
    expect(rig.view(1)!.state).toBe('locked');
  });

  it('does not exist without full control: at view-only the first pinch turns the view and the second hand zooms', () => {
    const rig = makeRig({ pick: onPart });
    rig.controller.setGate(VIEW_ONLY);
    rig.run([[...owner, false], [...at(0), false]], 6);
    rig.run([[...owner, true], [...at(0), false]], 3);
    rig.run([[...owner, true], [...at(0), true]], 3);
    expect(rig.log).toEqual(['beginOrbit']);
    expect(rig.last.gesture).toBe('zoom');
    expect(rig.controller.stats.twoHand).toEqual({ zoom: 1 });
    expect(rig.grabs).toHaveLength(0);
  });

  it('leaves the second hand of an orbit a zoom: the rotate row is for grabs only', () => {
    const orbit = makeRig({ pick: () => EMPTY_TARGET });
    orbit.run([[...owner, false], [...at(0), false]], 6);
    orbit.run([[...owner, true], [...at(0), false]], 3);
    orbit.run([[...owner, true], [...at(0), true]], 3);
    expect(orbit.last.gesture).toBe('zoom');
    expect(orbit.view(1)!.badge).toBe('手勢：雙手縮放');
  });

  it('writes the rotate badge only for the joining hand, and the signed angle as given', () => {
    const base = { target: EMPTY_TARGET };
    expect(badgeText({ ...base, state: 'join', gesture: 'rotate', value: null })).toBe('手勢：雙手旋轉');
    expect(badgeText({ ...base, state: 'join', gesture: 'rotate', value: 25 })).toBe('手勢：雙手旋轉 25°');
    expect(badgeText({ ...base, state: 'join', gesture: 'rotate', value: -35 })).toBe('手勢：雙手旋轉 -35°');
    expect(badgeText({ ...base, state: 'join', gesture: 'rotate', value: 0 })).toBe('手勢：雙手旋轉 0°');
    expect(badgeText({ target: part('o1', 'p1', 'Arm'), state: 'grab', gesture: 'rotate', value: null })).toBe('手勢：已抓取 Arm');
  });
});

describe('HandController, fist (Task 7, the real joinGesture)', () => {
  const owner: [number, number] = [200, 300];
  const second: [number, number] = [700, 300];
  const open = (at: readonly [number, number]) => palmHand(at[0], at[1], 'open');
  const pinching = (at: readonly [number, number]) => palmHand(at[0], at[1], 'pinch');
  const fist = (at: readonly [number, number], thumbIn = false) => palmHand(at[0], at[1], 'fist', thumbIn);

  /** An open hand over the object for a few frames, then a fist: the fist holds the object under its palm. */
  function holding(options: Parameters<typeof makeRig>[0] = {}, others: ReadonlyArray<readonly [number, number]> = []) {
    const rig = makeRig(options);
    rig.run([open(owner), ...others.map(open)], 4);
    rig.run([fist(owner), ...others.map(open)], FIST_ENGAGE_FRAMES);
    return rig;
  }
  /** The fist holds, then the other hand (far to the right) pinches and joins as an explode. */
  function pulling(options: Parameters<typeof makeRig>[0] & { explode?: number } = {}) {
    const rig = makeRig(options);
    rig.state.explode = options.explode ?? 0.3;
    rig.run([open(owner), open(second)], 4);
    rig.run([fist(owner), open(second)], FIST_ENGAGE_FRAMES);
    rig.run([fist(owner), pinching(second)], 3);
    return rig;
  }
  /** The second hand moves in small steps to x, at the height of the first (a jump beyond HAND_MATCH_PX is a new hand). */
  function pull(rig: Rig, from: number, to: number, ownerAt: readonly [number, number] = owner) {
    const steps = Math.max(1, Math.ceil(Math.abs(to - from) / 25));
    for (let step = 1; step <= steps; step++) rig.run([fist(ownerAt), palmHand(from + ((to - from) * step) / steps, second[1], 'pinch')], 1);
    rig.run([fist(ownerAt), palmHand(to, second[1], 'pinch')], 40);
  }
  const expectedAmount = (rig: Rig, start: number) => {
    const measured = rig.controller.twoHand!;
    return explodeAmount({
      start, startSpan: measured.startSpan, span: measured.span, deadZonePx: EXPLODE_DEAD_ZONE_PX, viewportHeight: rig.state.viewportHeight, fullFraction: EXPLODE_FULL_FRACTION,
    });
  };

  describe('holding an object', () => {
    it('holds the object under the palm: activate, then beginHold, a hold state, the badge with the object name', () => {
      const rig = holding();
      expect(rig.log).toEqual(['activate o1', 'beginHold o1']);
      expect(rig.view(0)!.state).toBe('hold');
      expect(rig.view(0)!.badge).toBe('手勢：握住 Demo');
      expect(rig.last.gesture).toBe('hold');
      expect(rig.controller.stats.hands[0].fist).toBe(true);
      expect(rig.controller.stats.hands[0].curl).toBeCloseTo(0.65, 2);
    });

    it('needs FIST_ENGAGE_FRAMES frames and shows nothing held before that', () => {
      const rig = makeRig();
      rig.run([open(owner)], 4);
      rig.run([fist(owner)], FIST_ENGAGE_FRAMES - 1);
      expect(rig.log).toEqual([]);
      expect(rig.view(0)!.state).not.toBe('hold');
      rig.run([fist(owner)], 1);
      expect(rig.view(0)!.state).toBe('hold');
    });

    it('calls activate then beginHold for a part of an inactive object, and cuts a long object name in the badge', () => {
      const target = part('o2', 'p9', 'Leg', 'ABCDEFGHIJKLM');
      const rig = holding({ pick: () => target });
      expect(rig.log).toEqual(['activate o2', 'beginHold o2']);
      expect(rig.view(0)!.badge).toBe('手勢：握住 ABCDEFGHIJKL…');
    });

    it('holds nothing over empty space: a hollow fist with its own badge, until the hand opens', () => {
      const rig = holding({ pick: () => EMPTY_TARGET });
      expect(rig.log).toEqual([]);
      expect(rig.view(0)!.state).toBe('fist');
      expect(rig.view(0)!.badge).toBe('手勢：握拳');
      expect(rig.last.gesture).toBe('none');
      rig.run([fist([320, 360])], 20);
      expect(rig.log).toEqual([]);
      rig.run([open([320, 360])], FIST_RELEASE_FRAMES + 1);
      expect(rig.view(0)!.state).toBe('tracked');
    });

    it('holds nothing without objects, and when the scene refuses (the hand shows a fist)', () => {
      const none = holding({ objectCount: 0 });
      expect(none.log).toEqual([]);
      expect(none.view(0)!.state).toBe('fist');
      const refused = makeRig();
      refused.state.refuseHold = true;
      refused.run([open(owner)], 4);
      refused.run([fist(owner)], FIST_ENGAGE_FRAMES);
      expect(refused.log).toEqual(['activate o1', 'beginHold o1']);
      expect(refused.view(0)!.state).toBe('fist');
      expect(refused.last.gesture).toBe('none');
    });

    it('previews the palm offset from the engage point and commits once on release; a stationary fist commits nothing', () => {
      const rig = holding();
      rig.run([fist([200, 300])], 5);
      expect(rig.holds[0]!.previews).toHaveLength(0);
      rig.run([fist([320, 360])], 40);
      const previews = rig.holds[0]!.previews;
      expect(previews.length).toBeGreaterThan(5);
      expect(previews.at(-1)!.x).toBeCloseTo(120, 0);
      expect(previews.at(-1)!.y).toBeCloseTo(60, 0);
      expect(previews[0]!.x).toBeGreaterThan(DRAG_DEAD_ZONE_PX);
      expect(rig.controller.stats.drags).toBe(1);
      rig.run([open([320, 360])], FIST_RELEASE_FRAMES + 1);
      expect(rig.holds[0]).toMatchObject({ commits: 1, cancels: 0 });
      expect(rig.controller.stats).toMatchObject({ commits: 1, cancels: 0 });
      expect(rig.last.gesture).toBe('none');
      rig.run([open([320, 360])], 6);
      expect(rig.holds[0]!.commits).toBe(1);

      const still = holding();
      still.run([fist(owner)], 10);
      still.run([open(owner)], FIST_RELEASE_FRAMES + 1);
      expect(still.holds[0]).toMatchObject({ commits: 0, cancels: 1 });
      expect(still.controller.stats).toMatchObject({ commits: 0, cancels: 0 });
      expect(still.cancelled).toEqual([]);
    });

    it('cancels when the hand is lost for longer than TRACKING_LOSS_MS, and continues after a shorter loss', () => {
      const short = holding();
      short.run([fist([300, 300])], 8);
      short.run([], 3);
      short.run([fist([340, 300])], 5);
      expect(short.holds[0]!.cancels).toBe(0);
      expect(short.last.gesture).toBe('hold');
      expect(short.controller.stats.dragLosses).toBe(1);

      const long = holding();
      long.run([fist([300, 300])], 8);
      long.run([], Math.ceil(TRACKING_LOSS_MS / FRAME_MS) + 2);
      expect(long.holds[0]).toMatchObject({ cancels: 1, commits: 0 });
      expect(long.cancelled).toEqual(['loss']);
      expect(long.controller.stats.cancels).toBe(1);
      expect(long.last.hands).toHaveLength(0);
    });

    it('cancels and reports external when the scene says the hold is no longer valid, and stays inert until the fist opens', () => {
      const rig = holding();
      rig.holds[0]!.valid = false;
      rig.run([fist([320, 300])], 10);
      expect(rig.holds[0]!.cancels).toBe(1);
      expect(rig.cancelled).toEqual(['external']);
      expect(rig.view(0)!.state).toBe('locked');
      rig.run([open([320, 300])], FIST_RELEASE_FRAMES + 1);
      expect(rig.view(0)!.state).not.toBe('locked');
      expect(rig.holds[0]!.commits).toBe(0);
    });

    it('reset puts a running hold back without reporting', () => {
      const rig = holding();
      rig.run([fist([320, 300])], 10);
      rig.controller.reset();
      expect(rig.holds[0]!.cancels).toBe(1);
      expect(rig.cancelled).toEqual([]);
      expect(rig.run([], 1).gesture).toBe('none');
    });
  });

  describe('fist and pinch', () => {
    it('never lets a fist-like frame count toward a pinch, even with the thumb on the index finger', () => {
      const rig = makeRig({ pick: () => part('o1', 'p1', 'Arm') });
      rig.run([open(owner)], 6);
      // Two frames are enough for a pinch (PINCH_ENGAGE_FRAMES) and too few for a fist: nothing may start.
      rig.run([fist(owner, true)], FIST_ENGAGE_FRAMES - 1);
      expect(rig.log).toEqual([]);
      expect(rig.controller.stats.hands[0].pinching).toBe(false);
      rig.run([fist(owner, true)], 10);
      expect(rig.log).toEqual(['activate o1', 'beginHold o1']);
      expect(rig.grabs).toHaveLength(0);
      expect(rig.controller.stats.hands[0].pinching).toBe(false);
    });

    it('cancels a pinch that has not moved when the fist engages: nothing is committed, and the fist takes over', () => {
      const rig = makeRig();
      rig.run([open(owner)], 6);
      rig.run([pinching(owner)], 3);
      expect(rig.view(0)!.state).toBe('grab');
      expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
      // The pinch midpoint drifts while the hand closes; that does not count as a move.
      rig.run([fist(owner, true)], FIST_ENGAGE_FRAMES);
      expect(rig.grabs[0]).toMatchObject({ commits: 0, cancels: 1 });
      expect(rig.controller.stats).toMatchObject({ commits: 0, cancels: 0 });
      expect(rig.cancelled).toEqual([]);
      expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1', 'grab.cancel', 'activate o1', 'beginHold o1']);
      expect(rig.view(0)!.state).toBe('hold');
      // Opening the fist does not start a pinch by itself, and the hold ends without a commit.
      rig.run([open(owner)], FIST_RELEASE_FRAMES + 1);
      expect(rig.holds[0]).toMatchObject({ commits: 0, cancels: 1 });
      expect(rig.view(0)!.state).not.toBe('locked');
    });

    it('cancels an orbit that has not moved the same way', () => {
      const rig = makeRig({ pick: () => EMPTY_TARGET });
      rig.run([open(owner)], 6);
      rig.run([pinching(owner)], 3);
      expect(rig.view(0)!.state).toBe('orbit');
      rig.run([fist(owner, true)], FIST_ENGAGE_FRAMES);
      expect(rig.orbits[0]!.ends).toBe(1);
      expect(rig.view(0)!.state).toBe('fist');
    });

    it('lets a pinch that has moved block the fist', () => {
      const rig = makeRig();
      rig.run([open(owner)], 6);
      rig.run([pinching(owner)], 3);
      rig.run([pinching([320, 300])], 20);
      expect(rig.grabs[0]!.previews.length).toBeGreaterThan(0);
      rig.run([fist([320, 300], true)], 10);
      expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
      expect(rig.grabs[0]!.cancels).toBe(0);
      expect(rig.view(0)!.state).toBe('grab');
    });

    it('with fistEnabled false leaves the pinch exactly as without fists: a fist with the thumb on the index finger is a pinch', () => {
      const rig = makeRig({ fistEnabled: false, pick: () => part('o1', 'p1', 'Arm') });
      rig.run([open(owner)], 6);
      rig.run([fist(owner, true)], 10);
      expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
      expect(rig.view(0)!.state).toBe('grab');
      expect(rig.holds).toHaveLength(0);
      // The curl is still computed for the debug line, but no fist state is.
      expect(rig.controller.stats.hands[0].curl).toBeCloseTo(0.65, 2);
      expect(rig.controller.stats.hands[0].fist).toBe(false);
    });
  });

  describe('another gesture runs', () => {
    it('joins a part grab as the knob rotate since Task 11 instead of being inert: join state, 手勢：雙手旋轉 0°, no hold', () => {
      const rig = makeRig({ pick: () => part('o1', 'p1', 'Arm') });
      rig.run([open(owner), open(second)], 6);
      rig.run([pinching(owner), open(second)], 3);
      rig.run([pinching(owner), fist(second)], FIST_ENGAGE_FRAMES + 1);
      expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
      expect(rig.view(1)!.state).toBe('join');
      expect(rig.view(1)!.input).toBe('fist');
      expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 0°');
      expect(rig.view(0)!.state).toBe('grab');
      expect(rig.controller.stats.inert).toBe(0);
      expect(rig.controller.twoHand).toMatchObject({ gesture: 'rotate' });
      expect(rig.last.gesture).toBe('rotate');
      expect(rig.last.link).not.toBeNull();
      // The fist opens: it leaves, and the owner goes on grabbing.
      rig.run([pinching(owner), open(second)], FIST_RELEASE_FRAMES + 1);
      expect(rig.controller.twoHand).toBeNull();
      expect(rig.last.gesture).toBe('grab');
      expect(rig.view(1)!.state).not.toBe('locked');
    });

    it('is inert while the other hand turns the view', () => {
      const rig = makeRig({ pick: point => (point.x > 500 ? EMPTY_TARGET : part('o1', 'p1', 'Arm')) });
      rig.run([open(second), open(owner)], 6);
      rig.run([pinching(second), open(owner)], 3);
      expect(rig.view(0)!.state).toBe('orbit');
      rig.run([pinching(second), fist(owner)], FIST_ENGAGE_FRAMES + 1);
      expect(rig.log).toEqual(['beginOrbit']);
      expect(rig.view(1)!.badge).toBe('手勢：另一手操作中');
      expect(rig.holds).toHaveLength(0);
    });

  });

  describe('gates (requirement 94)', () => {
    const AGENT: Gate = { level: 'view-only', reason: 'agent' };
    const TRY_ON: Gate = { level: 'off', reason: 'try-on' };

    it('holds and moves at full control and while the exploded view is open', () => {
      for (const gate of [FULL, VIEW_ONLY]) {
        const rig = makeRig();
        rig.controller.setGate(gate);
        rig.run([open(owner)], 4);
        rig.run([fist(owner)], FIST_ENGAGE_FRAMES);
        expect(rig.view(0)!.state).toBe('hold');
        rig.run([fist([320, 300])], 20);
        expect(rig.holds[0]!.previews.length).toBeGreaterThan(0);
      }
    });

    it('holds nothing during an agent run, with try-on or while tracking is too slow, and shows a locked hand', () => {
      for (const gate of [AGENT, TRY_ON, OFF]) {
        const rig = makeRig();
        rig.controller.setGate(gate);
        rig.run([open(owner)], 4);
        rig.run([fist(owner)], FIST_ENGAGE_FRAMES + 2);
        expect(rig.log).toEqual([]);
        expect(rig.view(0)!.state).toBe('locked');
      }
    });

    it('cancels a running hold when the fist is no longer allowed, but not when the exploded view opens', () => {
      const rig = holding();
      rig.run([fist([320, 300])], 10);
      rig.controller.setGate(VIEW_ONLY);
      expect(rig.holds[0]!.cancels).toBe(0);
      expect(rig.last.gesture).toBe('hold');
      rig.controller.setGate(FULL);
      rig.controller.setGate(AGENT);
      expect(rig.holds[0]!.cancels).toBe(1);
      expect(rig.cancelled).toEqual(['gate']);
      // The held fist does nothing until it opens, even when control returns.
      rig.controller.setGate(FULL);
      const log = [...rig.log];
      rig.run([fist([360, 300])], 10);
      expect(rig.log).toEqual(log);
      expect(rig.view(0)!.state).toBe('locked');
      rig.run([open([360, 300])], FIST_RELEASE_FRAMES + 1);
      expect(rig.view(0)!.state).not.toBe('locked');
    });

    it('cancels a hold when hand control turns off', () => {
      const rig = holding();
      rig.run([fist([320, 300])], 10);
      rig.controller.setGate(OFF);
      expect(rig.holds[0]!.cancels).toBe(1);
      expect(rig.cancelled).toEqual(['gate']);
    });
  });

  describe('pulling the object apart with the other hand', () => {
    it('joins a hold with a pinch as an explode: join state, 手勢：拉開 {n}%, gesture explode, a link from the palm to the pinch', () => {
      const rig = pulling();
      expect(rig.view(1)!.state).toBe('join');
      expect(rig.view(1)!.badge).toBe('手勢：拉開 30%');
      expect(rig.view(0)!.state).toBe('hold');
      expect(rig.last.gesture).toBe('explode');
      expect(rig.last.link).toEqual({ from: rig.view(0)!.palm, to: rig.view(1)!.cursor });
      expect(rig.controller.stats.twoHand).toEqual({ explode: 1 });
      expect(rig.controller.stats.inert).toBe(0);
      expect(rig.controller.twoHand).toMatchObject({ gesture: 'explode', startValue: 0.3 });
      // The span is measured from the palm centre to the pinch cursor.
      expect(rig.controller.twoHand!.startSpan).toBeCloseTo(pairSpan(rig.view(0)!.palm, rig.view(1)!.cursor), 3);
      // Joining alone changes nothing: the hands are inside the dead zone.
      expect(rig.explodes).toEqual([]);
      expect(rig.log).toEqual(['activate o1', 'beginHold o1']);
    });

    it('sets the amount from the change in distance, starting from explodeAmount(), and only when the rounded value changes', () => {
      const rig = pulling();
      pull(rig, second[0], 900);
      expect(rig.controller.twoHand!.span).toBeGreaterThan(rig.controller.twoHand!.startSpan + 100);
      expect(rig.explodes.length).toBeGreaterThan(2);
      expect(rig.explodes.at(-1)).toBe(expectedAmount(rig, 0.3));
      expect(rig.explodes.at(-1)!).toBeGreaterThan(0.3);
      expect(rig.explodes.some((value, index) => index > 0 && value === rig.explodes[index - 1])).toBe(false);
      expect(rig.view(1)!.badge).toBe(`手勢：拉開 ${Math.round(rig.explodes.at(-1)! * 100)}%`);
      // Back together: the amount falls, clamped at 0.
      pull(rig, 900, 380);
      expect(rig.explodes.at(-1)).toBe(expectedAmount(rig, 0.3));
      expect(rig.explodes.at(-1)!).toBeLessThan(0.3);
      expect(Math.min(...rig.explodes)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...rig.explodes)).toBeLessThanOrEqual(1);
    });

    it('goes from assembled to fully exploded by half the viewport height of spreading', () => {
      const rig = pulling({ explode: 0 });
      pull(rig, second[0], 700 + EXPLODE_DEAD_ZONE_PX + EXPLODE_FULL_FRACTION * rig.state.viewportHeight + 25);
      expect(rig.explodes.at(-1)).toBe(1);
    });

    it('ignores a change smaller than the dead zone', () => {
      const rig = pulling();
      pull(rig, second[0], second[0] + EXPLODE_DEAD_ZONE_PX - 4);
      expect(rig.explodes).toEqual([]);
      pull(rig, second[0] + EXPLODE_DEAD_ZONE_PX - 4, second[0] - EXPLODE_DEAD_ZONE_PX + 4);
      expect(rig.explodes).toEqual([]);
    });

    it('ignores the angle: moving around the fist at the same distance changes nothing', () => {
      const rig = pulling();
      const centre = rig.view(0)!.palm;
      const radius = pairSpan(centre, rig.view(1)!.cursor);
      for (let degrees = 0; degrees <= 60; degrees += 5) {
        const radians = (degrees * Math.PI) / 180;
        rig.run([fist(owner), palmHand(centre.x + radius * Math.cos(radians), centre.y + radius * Math.sin(radians) + PALM_DY, 'pinch')], 6);
      }
      expect(rig.explodes).toEqual([]);
    });

    it('holds the object still during the pull, and continues from where it is, re-based, after the joining hand lets go', () => {
      const rig = makeRig();
      rig.state.explode = 0.3;
      rig.run([open(owner), open(second)], 4);
      rig.run([fist(owner), open(second)], FIST_ENGAGE_FRAMES);
      rig.run([fist([260, 300]), open(second)], 30);
      const hold = rig.holds[0]!;
      expect(hold.previews.length).toBeGreaterThan(0);
      rig.run([fist([260, 300]), pinching(second)], 3);
      expect(rig.last.gesture).toBe('explode');
      const before = hold.previews.length;
      // The fist keeps moving during the pull: the object does not follow.
      rig.run([fist([330, 380]), pinching(second)], 40);
      expect(hold.previews).toHaveLength(before);
      pull(rig, second[0], 850, [330, 380]);
      expect(rig.explodes.length).toBeGreaterThan(0);
      rig.run([fist([330, 380]), palmHand(850, second[1], 'open')], 4);
      expect(hold.rebases).toBe(1);
      expect(rig.last.gesture).toBe('hold');
      expect(rig.last.link).toBeNull();
      expect(rig.view(1)!.state).not.toBe('join');
      expect(hold.previews.length).toBeGreaterThan(before);
      expect(Math.hypot(hold.previews[before]!.x, hold.previews[before]!.y)).toBeLessThan(20);
      rig.run([fist([400, 380]), palmHand(850, second[1], 'open')], 40);
      expect(hold.previews.at(-1)!.x).toBeCloseTo(70, 0);
      expect(hold.cancels).toBe(0);
    });

    it('starts the next pull from the amount the previous one left', () => {
      const rig = pulling();
      pull(rig, second[0], 850);
      const left = rig.state.explode;
      expect(left).not.toBe(0.3);
      rig.run([fist(owner), palmHand(850, second[1], 'open')], 4);
      rig.run([fist(owner), palmHand(850, second[1], 'pinch')], 3);
      expect(rig.controller.twoHand).toMatchObject({ gesture: 'explode', startValue: left });
      expect(rig.view(1)!.badge).toBe(`手勢：拉開 ${Math.round(left * 100)}%`);
    });

    it('ends everything when the fist opens, commits a moved hold and leaves the pinch inert', () => {
      const rig = makeRig();
      rig.run([open(owner), open(second)], 4);
      rig.run([fist(owner), open(second)], FIST_ENGAGE_FRAMES);
      rig.run([fist([320, 300]), open(second)], 30);
      rig.run([fist([320, 300]), pinching(second)], 3);
      rig.run([open([320, 300]), pinching(second)], FIST_RELEASE_FRAMES + 1);
      expect(rig.holds[0]!.commits).toBe(1);
      expect(rig.last.gesture).toBe('none');
      expect(rig.last.link).toBeNull();
      expect(rig.view(1)!.state).toBe('locked');
      const calls = rig.explodes.length;
      rig.run([open([320, 300]), palmHand(800, second[1], 'pinch')], 20);
      expect(rig.explodes).toHaveLength(calls);
    });

    it('keeps working while the exploded view is open, and everything ends when the agent starts', () => {
      const exploded = makeRig();
      exploded.controller.setGate(VIEW_ONLY);
      exploded.run([open(owner), open(second)], 4);
      exploded.run([fist(owner), open(second)], FIST_ENGAGE_FRAMES);
      exploded.run([fist(owner), pinching(second)], 3);
      expect(exploded.last.gesture).toBe('explode');
      pull(exploded, second[0], 900);
      expect(exploded.explodes.length).toBeGreaterThan(0);

      const running = pulling();
      running.controller.setGate(VIEW_ONLY);
      expect(running.last.gesture).toBe('explode');
      expect(running.holds[0]!.cancels).toBe(0);
      running.controller.setGate({ level: 'view-only', reason: 'agent' });
      expect(running.holds[0]!.cancels).toBe(1);
      expect(running.cancelled).toEqual(['gate']);
      running.run([fist(owner), pinching(second)], 1);
      expect(running.last.gesture).toBe('none');
      expect(running.view(1)!.state).toBe('locked');
    });

    it('does not set the amount while the port cannot say how tall the view is', () => {
      const rig = pulling();
      rig.state.viewportHeight = 0;
      pull(rig, second[0], 900);
      expect(rig.explodes).toEqual([]);
    });

    it('is inert for a fist as the joining hand (the rule has no row for it)', () => {
      const rig = holding({}, [second]);
      rig.run([fist(owner), fist(second)], FIST_ENGAGE_FRAMES + 1);
      expect(rig.controller.twoHand).toBeNull();
      expect(rig.view(1)!.state).toBe('locked');
      expect(rig.view(1)!.badge).toBe('手勢：另一手操作中');
      expect(rig.holds).toHaveLength(1);
    });
  });
});

describe('decideFist', () => {
  const p = part('o1', 'p1', 'p1', 'Demo');
  const gate = (level: Gate['level'], reason: Gate['reason']): Gate => ({ level, reason });
  it('holds the object of the part under the palm at full control and while exploded, and nothing otherwise', () => {
    const hold = { kind: 'hold', objectId: 'o1', hit: { x: 0, y: 0, z: 0 } };
    expect(decideFist(p, { objectCount: 1, gate: gate('full', null) })).toEqual(hold);
    expect(decideFist(p, { objectCount: 1, gate: gate('view-only', 'exploded') })).toEqual(hold);
    expect(decideFist(p, { objectCount: 1, gate: gate('view-only', 'agent') })).toEqual({ kind: 'none' });
    expect(decideFist(p, { objectCount: 1, gate: gate('off', 'try-on') })).toEqual({ kind: 'none' });
    expect(decideFist(p, { objectCount: 1, gate: gate('off', 'slow') })).toEqual({ kind: 'none' });
  });
  it('holds nothing over empty space, over an on-screen target, or with no objects', () => {
    expect(decideFist(EMPTY_TARGET, { objectCount: 1, gate: FULL })).toEqual({ kind: 'none' });
    expect(decideFist({ kind: 'screen', id: 'btn', label: '按鈕' }, { objectCount: 1, gate: FULL })).toEqual({ kind: 'none' });
    expect(decideFist(p, { objectCount: 0, gate: FULL })).toEqual({ kind: 'none' });
  });
});

describe('fist texts and marks', () => {
  const base = { gesture: 'none' as const, value: null };
  it('writes the badges: 握拳, 握住 with the object name, 拉開 with the percentage', () => {
    expect(badgeText({ ...base, state: 'fist', target: EMPTY_TARGET })).toBe('手勢：握拳');
    expect(badgeText({ ...base, state: 'hold', target: EMPTY_TARGET, objectName: 'Demo' })).toBe('手勢：握住 Demo');
    expect(badgeText({ ...base, state: 'hold', target: EMPTY_TARGET, objectName: 'ABCDEFGHIJKLM' })).toBe('手勢：握住 ABCDEFGHIJKL…');
    expect(badgeText({ ...base, state: 'hold', target: EMPTY_TARGET })).toBe('手勢：握住');
    expect(badgeText({ state: 'join', target: EMPTY_TARGET, gesture: 'explode', value: 45 })).toBe('手勢：拉開 45%');
    expect(badgeText({ state: 'join', target: EMPTY_TARGET, gesture: 'explode', value: 0 })).toBe('手勢：拉開 0%');
    expect(badgeText({ state: 'join', target: EMPTY_TARGET, gesture: 'zoom', value: null })).toBe('手勢：雙手縮放');
  });
  it('writes the exploded line of requirement 94 when fists are on, and the P0 line otherwise', () => {
    const input = { tracker: 'ready' as const, gate: VIEW_ONLY, cancelledAt: null, now: 0, handSeen: true };
    expect(handStatus({ ...input, fistEnabled: true })).toEqual({
      state: 'exploded', text: '爆炸圖開啟中，捏合只能轉動視角，握拳仍可移動整個物件；收回後即可抓取零件。',
    });
    expect(handStatus({ ...input, fistEnabled: false })).toEqual({ state: 'exploded', text: '爆炸圖開啟中，手勢只能轉動視角；收回後即可抓取零件。' });
    expect(handStatus(input).text).toBe('爆炸圖開啟中，手勢只能轉動視角；收回後即可抓取零件。');
    // The agent line does not change.
    expect(handStatus({ ...input, gate: { level: 'view-only', reason: 'agent' }, fistEnabled: true }).text).toBe('代理執行中，手勢只能轉動視角。');
  });
  it('adds the curl ratio and the fist state of both hands to the debug line once a hand has been seen', () => {
    const stats = createStats();
    const tracking = { delegate: 'GPU' as const, fps: 22, inferenceMs: 48, hands: 2, pinchMm: [24, 61], gesture: 'hold' as const };
    expect(debugLine(stats, tracking)).not.toContain('曲度');
    stats.hands[0] = { pinchM: 0.06, pinching: false, target: 'o1:p1', curl: 0.65, fist: true };
    stats.hands[1] = { pinchM: 0.05, pinching: false, target: '', curl: 1.841, fist: false };
    expect(debugLine(stats, tracking)).toContain('手勢 hold · 曲度 0.65／1.84 · 握拳 是／否 · 拖曳');
    stats.hands[1] = { pinchM: null, pinching: false, target: '', curl: null, fist: false };
    expect(debugLine(stats, tracking)).toContain('曲度 0.65／—');
  });
  it('draws a hollow rounded square for the fist and a filled one while it holds, and nothing for other marks', () => {
    const recorder = () => {
      const calls: string[] = [];
      const ctx = new Proxy({} as Record<string, unknown>, {
        get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => { calls.push(`${key}(${args.map(String).join(',')})`); }),
        set: (target, key: string, value) => { target[key] = value; calls.push(`${key}=${String(value)}`); return true; },
      });
      return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
    };
    const hollow = recorder();
    drawSquare(hollow.ctx, { x: 100, y: 200 }, overlayStyle({ state: 'fist' }));
    expect(hollow.calls.some(call => call.startsWith('roundRect(85,185,30,30'))).toBe(true);
    expect(hollow.calls.some(call => call.startsWith('fill('))).toBe(false);
    expect(hollow.calls).toContain(`strokeStyle=${HAND_COLOUR}`);
    const filled = recorder();
    drawSquare(filled.ctx, { x: 100, y: 200 }, overlayStyle({ state: 'hold' }));
    expect(filled.calls.some(call => call.startsWith('fill('))).toBe(true);
    for (const state of ['hover', 'grab', 'tracked', 'locked'] as const) {
      const none = recorder();
      drawSquare(none.ctx, { x: 100, y: 200 }, overlayStyle({ state }));
      expect(none.calls).toEqual([]);
    }
    // The ring helper draws nothing for the square marks, so a hand never shows both.
    const ring = recorder();
    drawRing(ring.ctx, { x: 100, y: 200 }, overlayStyle({ state: 'hold' }));
    expect(ring.calls).toEqual([]);
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
  it('draws the rotate arc around the owner cursor, clockwise for a positive angle and the other way for a negative one, and nothing for 0', () => {
    const clockwise = recorder();
    drawArc(clockwise.ctx, { centre: { x: 100, y: 200 }, fromDeg: 0, toDeg: 30 });
    const arcCall = clockwise.calls.find(call => call.startsWith('arc('))!;
    expect(arcCall.startsWith('arc(100,200,')).toBe(true);
    expect(arcCall.endsWith(',false)')).toBe(true);
    expect(clockwise.calls).toContain(`strokeStyle=${LINK_COLOUR}`);
    const back = recorder();
    drawArc(back.ctx, { centre: { x: 100, y: 200 }, fromDeg: 10, toDeg: -20 });
    expect(back.calls.find(call => call.startsWith('arc('))!.endsWith(',true)')).toBe(true);
    const none = recorder();
    drawArc(none.ctx, { centre: { x: 100, y: 200 }, fromDeg: 10, toDeg: 10 });
    expect(none.calls).toEqual([]);
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

// ---- Task 10: release timing, thresholds and the freeze while a hand opens ----------------------------------------------------------

describe('HandController, release timing and the freeze while a hand opens (Task 10)', () => {
  /** The pinch distances of the webcam test: closed 26 mm, half open 58 mm, open 100 mm; and 45 mm, between the engage (40) and the release (55) threshold. */
  const CLOSED_MM = 0.026;
  const OPENING_MM = 0.045;
  const WIDE_OPEN_MM = 0.08;
  const pinchAt = (x: number, y: number, pinchM: number): HandSample => ({ ...hand(x, y), pinchM });
  /** A fist whose fingers have begun to open: the curl ratio is above the engage ratio and below the release ratio. */
  const halfOpenFist = (x: number, y: number): HandSample => ({ ...palmHand(x, y, 'fist'), curl: 1.1 });

  it('engages in 2 frames at 10 frames per second and in 4 at 30, the pinch of 26 mm engages and the half-open 58 mm does not', () => {
    for (const [frameMs, frames] of [[100, 2], [33, 4]] as const) {
      const rig = makeRig({ frameMs });
      rig.run([[200, 300]], Math.ceil(300 / frameMs));
      rig.run([pinchAt(200, 300, 0.058)], 10);
      expect(rig.log).toEqual([]);
      rig.run([pinchAt(200, 300, CLOSED_MM)], frames - 1);
      expect(rig.log).toEqual([]);
      rig.run([pinchAt(200, 300, CLOSED_MM)], 1);
      expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
    }
  });

  it('never engages on one noisy frame, and never releases on one', () => {
    const rig = makeRig({ frameMs: 100 });
    rig.run([[200, 300]], 4);
    rig.run([pinchAt(200, 300, CLOSED_MM)], 1);
    rig.run([[200, 300]], 1);
    rig.run([pinchAt(200, 300, CLOSED_MM)], 1);
    rig.run([[200, 300]], 1);
    expect(rig.log).toEqual([]);
    rig.run([pinchAt(200, 300, CLOSED_MM)], 2);
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
    rig.run([pinchAt(330, 300, CLOSED_MM)], 12);
    const grab = rig.grabs[0]!;
    rig.run([pinchAt(330, 300, WIDE_OPEN_MM)], 1);
    rig.run([pinchAt(330, 300, CLOSED_MM)], 1);
    rig.run([pinchAt(330, 300, WIDE_OPEN_MM)], 1);
    rig.run([pinchAt(330, 300, CLOSED_MM)], 3);
    expect(grab.commits).toBe(0);
    expect(grab.cancels).toBe(0);
    expect(rig.view(0)!.state).toBe('grab');
  });

  it('releases in 2 frames at 10 frames per second and in 3 at 30 frames per second', () => {
    for (const [frameMs, frames] of [[100, 2], [33, 3]] as const) {
      expect(Math.ceil(PINCH_RELEASE_MS / frameMs) + 1).toBe(frames);
      const rig = makeRig({ frameMs });
      rig.run([[200, 300]], Math.ceil(300 / frameMs));
      rig.run([pinchAt(200, 300, CLOSED_MM)], 8);
      rig.run([pinchAt(330, 300, CLOSED_MM)], Math.ceil(2000 / frameMs));
      const grab = rig.grabs[0]!;
      rig.run([pinchAt(330, 300, WIDE_OPEN_MM)], frames - 1);
      expect(grab.commits).toBe(0);
      rig.run([pinchAt(330, 300, WIDE_OPEN_MM)], 1);
      expect(grab.commits).toBe(1);
    }
  });

  it('freezes the part while the hand opens: it does not move, and the confirmed release commits the frozen state', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([[320, 300, true]], 40);
    const grab = rig.grabs[0]!;
    const count = grab.previews.length;
    const frozen = grab.previews.at(-1)!;
    expect(frozen.x).toBeCloseTo(120, 0);
    // The fingers start to open (45 mm, above the engage threshold, below the release threshold) and the hand keeps travelling.
    rig.run([pinchAt(400, 300, OPENING_MM)], 12);
    expect(grab.previews).toHaveLength(count);
    expect(grab.commits).toBe(0);
    expect(rig.view(0)!.state).toBe('grab');
    // Fully open: the release is confirmed after PINCH_RELEASE_MS and commits where the hand started to open.
    rig.run([pinchAt(480, 300, WIDE_OPEN_MM)], 1);
    expect(grab.commits).toBe(0);
    rig.run([pinchAt(520, 300, WIDE_OPEN_MM)], 2);
    expect(grab.commits).toBe(1);
    expect(grab.cancels).toBe(0);
    expect(grab.previews).toHaveLength(count);
    expect(grab.previews.at(-1)).toEqual(frozen);
    expect(rig.controller.stats).toMatchObject({ drags: 1, commits: 1, cancels: 0 });
  });

  it('resumes from the frozen point when the hand closes again before the release: the first preview is zero, nothing jumps', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([[320, 300, true]], 40);
    const grab = rig.grabs[0]!;
    const count = grab.previews.length;
    const frozen = grab.previews.at(-1)!;
    rig.run([pinchAt(300, 360, OPENING_MM)], 6);
    rig.run([pinchAt(420, 360, OPENING_MM)], 12);
    expect(grab.previews).toHaveLength(count);
    expect(grab.rebases).toBe(0);
    // One wide-open frame is not a release; closing again continues the same grab.
    rig.run([pinchAt(420, 360, WIDE_OPEN_MM)], 1);
    rig.run([pinchAt(420, 360, CLOSED_MM)], 1);
    expect(grab.commits).toBe(0);
    expect(grab.rebases).toBe(1);
    expect(grab.previews).toHaveLength(count + 1);
    expect(grab.previews[count]).toEqual({ x: 0, y: 0 });
    expect(frozen.x).toBeCloseTo(120, 0);
    // From there the part follows the hand again, relative to the re-based preview.
    rig.run([pinchAt(480, 360, CLOSED_MM)], 40);
    expect(grab.previews.at(-1)!.x).toBeCloseTo(60, 0);
    expect(grab.previews.at(-1)!.y).toBeCloseTo(0, 0);
    rig.run([pinchAt(480, 360, WIDE_OPEN_MM)], 3);
    expect(grab.commits).toBe(1);
  });

  it('does not turn a tap into a drag while the fingers open', () => {
    const rig = makeRig();
    pinch(rig, [[200, 300]]);
    rig.run([pinchAt(260, 330, OPENING_MM)], 6);
    rig.run([pinchAt(280, 340, WIDE_OPEN_MM)], 3);
    const grab = rig.grabs[0]!;
    expect(grab.previews).toEqual([]);
    expect(grab.commits).toBe(0);
    expect(grab.cancels).toBe(1);
    expect(rig.controller.stats.drags).toBe(0);
  });

  it('freezes the view turn while the hand that turns it opens, and ends the orbit on the release', () => {
    const rig = makeRig();
    pinch(rig, [[800, 300]]);
    rig.run([[700, 300, true]], 30);
    const orbit = rig.orbits[0]!;
    const count = orbit.previews.length;
    expect(count).toBeGreaterThan(0);
    rig.run([pinchAt(600, 300, OPENING_MM)], 10);
    expect(orbit.previews).toHaveLength(count);
    rig.run([pinchAt(560, 300, WIDE_OPEN_MM)], 3);
    expect(orbit.ends).toBe(1);
    expect(orbit.previews).toHaveLength(count);
  });

  it('freezes the object while the fist opens, and the confirmed release commits it where it was', () => {
    const rig = makeRig();
    rig.run([palmHand(300, 400, 'open')], 8);
    rig.run([palmHand(300, 400, 'fist')], FIST_ENGAGE_FRAMES);
    expect(rig.holds).toHaveLength(1);
    rig.run([palmHand(380, 400, 'fist')], 30);
    const hold = rig.holds[0]!;
    const count = hold.previews.length;
    const frozen = hold.previews.at(-1)!;
    expect(frozen.x).toBeCloseTo(80, 0);
    rig.run([halfOpenFist(440, 400)], 6);
    rig.run([halfOpenFist(480, 400)], 6);
    expect(hold.previews).toHaveLength(count);
    expect(hold.commits).toBe(0);
    rig.run([palmHand(500, 400, 'open')], FIST_RELEASE_FRAMES);
    expect(hold.commits).toBe(1);
    expect(hold.previews).toHaveLength(count);
    expect(hold.previews.at(-1)).toEqual(frozen);
  });

  it('resumes a fist that closes again with a re-base and no jump', () => {
    const rig = makeRig();
    rig.run([palmHand(300, 400, 'open')], 8);
    rig.run([palmHand(300, 400, 'fist')], FIST_ENGAGE_FRAMES);
    rig.run([palmHand(380, 400, 'fist')], 30);
    const hold = rig.holds[0]!;
    const count = hold.previews.length;
    rig.run([halfOpenFist(430, 400)], 6);
    rig.run([halfOpenFist(470, 400)], 6);
    rig.run([palmHand(470, 400, 'fist')], 2);
    expect(hold.rebases).toBe(1);
    expect(hold.previews[count]).toEqual({ x: 0, y: 0 });
    expect(hold.commits).toBe(0);
  });

  describe('two-hand gestures', () => {
    /** The second hand moves in steps of 25 px from `from` to `to`, with the owner holding still (a jump beyond HAND_MATCH_PX counts as a new hand). */
    function slide(rig: Rig, owner: HandSample | readonly [number, number, boolean], from: [number, number], to: [number, number], pinchM: number) {
      const steps = Math.max(1, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / 25));
      for (let step = 1; step <= steps; step++) {
        const k = step / steps;
        rig.run([owner, pinchAt(from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, pinchM)], 2);
      }
    }

    it('freezes a two-hand zoom while either pinch opens, and resumes from the span it froze at', () => {
      const rig = makeRig({ pick: point => (point.x < 500 ? EMPTY_TARGET : part('o1', 'p2', 'Arm')) });
      const owner: [number, number, boolean] = [330, 300, true];
      rig.run([[200, 300, false], [700, 300, false]], 6);
      rig.run([[200, 300, true], [700, 300, false]], PINCH_ENGAGE_FRAMES);
      rig.run([[230, 300, true], [700, 300, false]], 6);
      rig.run([owner, [700, 300, false]], 30);
      rig.run([owner, [700, 300, true]], PINCH_ENGAGE_FRAMES);
      const orbit = rig.orbits[0]!;
      expect(rig.last.gesture).toBe('zoom');
      slide(rig, owner, [700, 300], [800, 300], CLOSED_MM);
      rig.run([owner, [800, 300, true]], 10);
      const zooms = orbit.zooms.length;
      expect(zooms).toBeGreaterThan(0);
      // The joining hand opens while it travels out: the view does not zoom any further.
      slide(rig, owner, [800, 300], [950, 300], OPENING_MM);
      rig.run([owner, pinchAt(950, 300, OPENING_MM)], 6);
      expect(orbit.zooms).toHaveLength(zooms);
      expect(rig.last.gesture).toBe('zoom');
      // It closes again at the wide span: a re-base, and no zoom jump.
      rig.run([owner, [950, 300, true]], 3);
      expect(orbit.rebases).toBe(1);
      expect(orbit.zooms).toHaveLength(zooms);
      const startSpan = rig.controller.twoHand!.startSpan;
      expect(startSpan).toBeCloseTo(pairSpan(rig.view(0)!.cursor, rig.view(1)!.cursor), 0);
      // Coming back in zooms relative to the re-based span.
      slide(rig, owner, [950, 300], [800, 300], CLOSED_MM);
      rig.run([owner, [800, 300, true]], 30);
      expect(orbit.zooms.length).toBeGreaterThan(zooms);
      expect(orbit.zooms.at(-1)!).toBeCloseTo(startSpan / (rig.controller.twoHand!.span + ZOOM_DEAD_ZONE_PX), 6);
      expect(orbit.zooms.at(-1)!).toBeGreaterThan(1);
    });

    it('freezes the part while the other hand opens in a two-hand rotate, and measures the turn again from the re-base', () => {
      const rig = makeRig();
      const owner: [number, number] = [400, 300];
      const around = (degrees: number): [number, number] => [owner[0] + 250 * Math.cos((degrees * Math.PI) / 180), owner[1] + 250 * Math.sin((degrees * Math.PI) / 180)];
      const swing = (from: number, to: number, pinchM: number) => {
        for (let degrees = from + 10; degrees <= to; degrees += 10) rig.run([[...owner, true], pinchAt(...around(degrees), pinchM)], 6);
      };
      rig.run([[...owner, false], [...around(0), false]], 6);
      rig.run([[...owner, true], [...around(0), false]], PINCH_ENGAGE_FRAMES);
      rig.run([[...owner, true], [...around(0), true]], PINCH_ENGAGE_FRAMES);
      const grab = rig.grabs[0]!;
      expect(rig.last.gesture).toBe('rotate');
      swing(0, 30, CLOSED_MM);
      rig.run([[...owner, true], pinchAt(...around(30), CLOSED_MM)], 20);
      const sent = grab.rotates.length;
      expect(grab.rotates.at(-1)!).toBeCloseTo(25, 0);
      swing(30, 70, OPENING_MM);
      rig.run([[...owner, true], pinchAt(...around(70), OPENING_MM)], 10);
      expect(grab.rotates).toHaveLength(sent);
      expect(grab.rebases).toBe(0);
      rig.run([[...owner, true], pinchAt(...around(70), CLOSED_MM)], 4);
      expect(grab.rebases).toBe(1);
      expect(grab.rotates).toHaveLength(sent);
      expect(rig.controller.twoHand!.angle).toBeCloseTo(0, 0);
      // Another 30° from the re-base turns the part by 25° more relative to it, not by the 70° swung in total.
      swing(70, 100, CLOSED_MM);
      rig.run([[...owner, true], pinchAt(...around(100), CLOSED_MM)], 20);
      expect(grab.rotates.at(-1)!).toBeCloseTo(25, 0);
      // The owner's release commits the move and the turn once.
      rig.run([pinchAt(...owner, WIDE_OPEN_MM), pinchAt(...around(100), CLOSED_MM)], 3);
      expect(grab.commits).toBe(1);
    });

    it('freezes the pull while the fist of an explode opens, and the pinch that opens does not change the amount', () => {
      const rig = makeRig();
      const ownerAt: [number, number] = [200, 300];
      rig.run([palmHand(...ownerAt, 'open'), palmHand(700, 300, 'open')], 4);
      rig.run([palmHand(...ownerAt, 'fist'), palmHand(700, 300, 'open')], FIST_ENGAGE_FRAMES);
      rig.run([palmHand(...ownerAt, 'fist'), palmHand(700, 300, 'pinch')], PINCH_ENGAGE_FRAMES);
      expect(rig.last.gesture).toBe('explode');
      for (let x = 725; x <= 800; x += 25) rig.run([palmHand(...ownerAt, 'fist'), palmHand(x, 300, 'pinch')], 3);
      rig.run([palmHand(...ownerAt, 'fist'), palmHand(800, 300, 'pinch')], 10);
      const amount = rig.explodes.at(-1)!;
      expect(amount).toBeGreaterThan(0);
      const calls = rig.explodes.length;
      for (let x = 825; x <= 1000; x += 25) rig.run([palmHand(...ownerAt, 'fist'), { ...palmHand(x, 300, 'pinch'), pinchM: OPENING_MM }], 3);
      expect(rig.explodes).toHaveLength(calls);
      const hold = rig.holds[0]!;
      rig.run([{ ...palmHand(ownerAt[0] + 30, ownerAt[1], 'fist'), curl: 1.1 }, { ...palmHand(1000, 300, 'pinch'), pinchM: OPENING_MM }], 6);
      expect(rig.explodes).toHaveLength(calls);
      expect(hold.previews).toEqual([]);
    });
  });
});

// ---- Task 11: the fist knob ------------------------------------------------------------------------------------------------------

describe('HandController, fist knob (Task 11, the real joinGesture)', () => {
  const owner: [number, number] = [200, 300];
  const second: [number, number] = [700, 300];
  const PINCH_RELEASE_FRAMES = Math.ceil(PINCH_RELEASE_MS / FRAME_MS) + 1;
  const onPart = () => part('o1', 'p1', 'Arm');
  const open = (at: readonly [number, number]) => palmHand(at[0], at[1], 'open');
  const pinching = (at: readonly [number, number]) => palmHand(at[0], at[1], 'pinch');
  /** A fist at a palm position, turned `roll` degrees clockwise on screen. */
  const knob = (at: readonly [number, number], roll = 0, side: 'left' | 'right' = 'right') => palmHand(at[0], at[1], 'fist', false, roll, side);
  /** A fist whose fingers have begun to open (the curl ratio is between the engage and the release ratio), turned `roll` degrees. */
  const opening = (at: readonly [number, number], roll: number): HandSample => ({ ...knob(at, roll), curl: 1.1 });
  const last = <T>(values: T[]): T => values[values.length - 1]!;

  /** The first hand pinches a part, then the second hand closes into a fist anywhere: they join as the knob. */
  function knobbing(options: Parameters<typeof makeRig>[0] = {}, side: 'left' | 'right' = 'right') {
    const rig = makeRig({ pick: onPart, ...options });
    rig.run([open(owner), open(second)], 6);
    rig.run([pinching(owner), open(second)], 3);
    rig.run([pinching(owner), knob(second, 0, side)], FIST_ENGAGE_FRAMES + 1);
    return rig;
  }
  /** The fist twists in steps of 10 degrees from `from` to `to`, then settles. */
  function twist(rig: Rig, from: number, to: number, at: readonly [number, number] = second, side: 'left' | 'right' = 'right', ownerAt: readonly [number, number] = owner) {
    const step = to >= from ? 10 : -10;
    for (let degrees = from + step; step > 0 ? degrees < to : degrees > to; degrees += step) rig.run([pinching(ownerAt), knob(at, degrees, side)], 3);
    rig.run([pinching(ownerAt), knob(at, to, side)], 12);
  }

  it('joins a part grab as a rotate through the fist: join state with the fist mark, 手勢：雙手旋轉 0°, a link, no arc yet and nothing turned', () => {
    const rig = knobbing();
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
    expect(rig.view(0)!.state).toBe('grab');
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.view(1)!.input).toBe('fist');
    expect(overlayStyle(rig.view(1)!).mark).toBe('square-filled');
    expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 0°');
    expect(rig.last.gesture).toBe('rotate');
    expect(rig.last.link).not.toBeNull();
    expect(rig.last.arc).toBeNull();
    expect(rig.controller.stats.twoHand).toEqual({ rotate: 1 });
    expect(rig.controller.stats.inert).toBe(0);
    expect(rig.holds).toHaveLength(0);
    expect(rig.grabs[0]!.rotates).toEqual([]);
  });

  it('turns the part clockwise for a clockwise twist and the other way for the other, by the angle less the dead zone', () => {
    const rig = knobbing();
    twist(rig, 0, 30);
    expect(rig.controller.twoHand!.angle).toBeCloseTo(30, 0);
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(25, 0);
    expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 25°');
    twist(rig, 30, -30);
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(-25, 0);
    expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 -25°');
    expect(rig.grabs[0]!.commits).toBe(0);
    expect(rig.grabs[0]!.cancels).toBe(0);
  });

  it('draws the arc at the owner cursor from the angle of the fist at engage to the angle shown', () => {
    const rig = knobbing();
    twist(rig, 0, 3);
    expect(rig.last.arc).toBeNull();
    twist(rig, 3, 40);
    const arc = rig.last.arc!;
    expect(arc.centre).toEqual(rig.view(0)!.cursor);
    expect(arc.toDeg - arc.fromDeg).toBeCloseTo(35, 0);
  });

  it('ignores a twist smaller than the dead zone and does not jump when it leaves it', () => {
    const rig = knobbing();
    twist(rig, 0, ROTATE_DEAD_ZONE_DEG - 1);
    expect(rig.grabs[0]!.rotates).toEqual([]);
    expect(rig.view(1)!.badge).toBe('手勢：雙手旋轉 0°');
    // One degree at a time: the first angle sent must be small, as the dead zone is taken off the turn.
    for (let degrees = ROTATE_DEAD_ZONE_DEG; degrees <= ROTATE_DEAD_ZONE_DEG + 8; degrees++) rig.run([pinching(owner), knob(second, degrees)], 3);
    rig.run([pinching(owner), knob(second, ROTATE_DEAD_ZONE_DEG + 8)], 12);
    expect(rig.grabs[0]!.rotates.length).toBeGreaterThan(0);
    expect(Math.abs(rig.grabs[0]!.rotates[0]!)).toBeLessThan(3);
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(8, 0);
  });

  it('accumulates across ±180° instead of wrapping back', () => {
    const rig = knobbing();
    // The wrist-to-knuckle vector of the synthetic hand points up, so it crosses 180° after about 278° of turning.
    twist(rig, 0, 300);
    expect(rig.controller.twoHand!.angle).toBeCloseTo(300, 0);
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(295, 0);
    twist(rig, 300, -200);
    expect(rig.controller.twoHand!.angle).toBeCloseTo(-200, 0);
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(-195, 0);
  });

  it('reads the twist wherever the fist is and however close it is to the owner: the position moves nothing', () => {
    const rig = knobbing();
    // The span is measured from the owner's cursor (the pinch midpoint, above its palm) to the fist's palm: this place is about 46 px from it.
    const near: [number, number] = [240, 250];
    // Move the fist next to the owner in small steps (a jump beyond HAND_MATCH_PX is a new hand), then twist it there.
    for (let x = second[0] - 25; x >= near[0] + 10; x -= 25) rig.run([pinching(owner), knob([x, second[1]], 0)], 2);
    rig.run([pinching(owner), knob(near, 0)], 12);
    expect(rig.controller.twoHand!.gesture).toBe('rotate');
    expect(rig.controller.twoHand!.span).toBeLessThan(TWO_HAND_MIN_SPAN_PX);
    expect(rig.grabs[0]!.rotates).toEqual([]);
    twist(rig, 0, 30, near);
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(25, 0);
    // Carry it across the view at the same twist: the turn stays where it is, and nothing previews.
    const sent = rig.grabs[0]!.rotates.length;
    for (let x = near[0] + 25; x <= 900; x += 25) rig.run([pinching(owner), knob([x, near[1] + (x - near[0]) / 4], 30)], 2);
    rig.run([pinching(owner), knob([900, near[1] + (900 - near[0]) / 4], 30)], 12);
    // Floating-point noise may resend the same turn; no other angle is ever sent.
    for (const angle of rig.grabs[0]!.rotates.slice(sent)) expect(angle).toBeCloseTo(25, 6);
    expect(rig.grabs[0]!.previews).toEqual([]);
    expect(rig.controller.twoHand!.angle).toBeCloseTo(30, 0);
  });

  it('turns the same way for a hand drawn as a left hand', () => {
    const rig = knobbing({}, 'left');
    twist(rig, 0, 30, second, 'left');
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(25, 0);
    twist(rig, 30, -30, second, 'left');
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(-25, 0);
  });

  it('holds the part still while the fist turns: the owner moving does not preview', () => {
    const rig = knobbing();
    twist(rig, 0, 30);
    for (let x = owner[0] + 25; x <= owner[0] + 150; x += 25) rig.run([pinching([x, owner[1]]), knob(second, 30)], 3);
    rig.run([pinching([owner[0] + 150, owner[1]]), knob(second, 30)], 10);
    expect(rig.grabs[0]!.previews).toEqual([]);
    expect(rig.last.gesture).toBe('rotate');
  });

  it('keeps the rotation and re-bases the owner when the fist opens, then the owner moves the part on and its release commits once', () => {
    const rig = knobbing();
    twist(rig, 0, 30);
    const grab = rig.grabs[0]!;
    const sent = grab.rotates.length;
    rig.run([pinching(owner), open(second)], FIST_RELEASE_FRAMES + 1);
    expect(grab.rebases).toBe(1);
    expect(grab.rotates).toHaveLength(sent);
    expect(rig.last.gesture).toBe('grab');
    expect(rig.last.arc).toBeNull();
    expect(rig.view(1)!.state).not.toBe('join');
    for (let x = owner[0] + 25; x <= owner[0] + 100; x += 25) rig.run([pinching([x, owner[1]]), open(second)], 3);
    rig.run([pinching([owner[0] + 100, owner[1]]), open(second)], 20);
    expect(grab.previews.length).toBeGreaterThan(0);
    expect(grab.rotates).toHaveLength(sent);
    rig.run([open([owner[0] + 100, owner[1]]), open(second)], PINCH_RELEASE_FRAMES + 1);
    expect(grab.commits).toBe(1);
    expect(grab.cancels).toBe(0);
  });

  it('commits once when the owner lets go, although it never moved, and leaves the fist closed and inert', () => {
    const rig = knobbing();
    twist(rig, 0, 30);
    expect(rig.grabs[0]!.previews).toEqual([]);
    rig.run([open(owner), knob(second, 30)], PINCH_RELEASE_FRAMES + 1);
    expect(rig.grabs[0]!.commits).toBe(1);
    expect(rig.grabs[0]!.cancels).toBe(0);
    expect(rig.last.gesture).toBe('none');
    expect(rig.controller.twoHand).toBeNull();
    // The fist that is still closed holds nothing and turns nothing.
    rig.run([open(owner), knob(second, 90)], 10);
    expect(rig.grabs[0]!.rotates.at(-1)).toBeCloseTo(25, 0);
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1', 'grab.commit']);
  });

  it('cancels quietly, like a tap, when the fist only stayed inside the dead zone', () => {
    const rig = knobbing();
    twist(rig, 0, ROTATE_DEAD_ZONE_DEG - 2);
    rig.run([open(owner), knob(second, ROTATE_DEAD_ZONE_DEG - 2)], PINCH_RELEASE_FRAMES + 1);
    expect(rig.grabs[0]!.commits).toBe(0);
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.cancelled).toEqual([]);
  });

  it('cancels the grab and its turn when the owner is lost for longer than TRACKING_LOSS_MS, and when the gate leaves full control', () => {
    const lost = knobbing();
    twist(lost, 0, 30);
    lost.run([knob(second, 30)], Math.ceil(TRACKING_LOSS_MS / FRAME_MS) + 2);
    expect(lost.grabs[0]!.cancels).toBe(1);
    expect(lost.cancelled).toEqual(['loss']);
    expect(lost.last.gesture).toBe('none');

    const gated = knobbing();
    twist(gated, 0, 30);
    gated.controller.setGate(VIEW_ONLY);
    expect(gated.grabs[0]!.cancels).toBe(1);
    expect(gated.cancelled).toEqual(['gate']);
  });

  it('freezes the turn while the fist opens, keeps the shown turn on the release, and measures again from the re-base when the fist closes', () => {
    const rig = knobbing();
    twist(rig, 0, 30);
    const grab = rig.grabs[0]!;
    const sent = grab.rotates.length;
    expect(last(grab.rotates)).toBeCloseTo(25, 0);
    // The fingers open while the wrist keeps turning: nothing is applied.
    for (let degrees = 40; degrees <= 70; degrees += 10) rig.run([pinching(owner), opening(second, degrees)], 3);
    rig.run([pinching(owner), opening(second, 70)], 10);
    expect(grab.rotates).toHaveLength(sent);
    expect(grab.rebases).toBe(0);
    expect(rig.last.gesture).toBe('rotate');
    // Closing again resumes from the current angle: one re-base, nothing jumps.
    rig.run([pinching(owner), knob(second, 70)], 4);
    expect(grab.rebases).toBe(1);
    expect(grab.rotates).toHaveLength(sent);
    expect(rig.controller.twoHand!.angle).toBeCloseTo(0, 0);
    twist(rig, 70, 100);
    expect(last(grab.rotates)).toBeCloseTo(25, 0);
    // A fist that opens for good: the release leaves the shown turn as it was and the owner continues.
    const shown = grab.rotates.length;
    rig.run([pinching(owner), { ...knob(second, 100), curl: 1.4 }], FIST_RELEASE_FRAMES + 1);
    expect(grab.rotates).toHaveLength(shown);
    expect(rig.last.gesture).toBe('grab');
    expect(grab.commits).toBe(0);
  });

  it('is not a knob when the fist came first: a fist that holds an object and then a pinch is still the explode', () => {
    const rig = makeRig({ pick: onPart });
    rig.run([open(owner), open(second)], 4);
    rig.run([knob(owner), open(second)], FIST_ENGAGE_FRAMES);
    rig.run([knob(owner), pinching(second)], 4);
    expect(rig.last.gesture).toBe('explode');
    expect(rig.controller.stats.twoHand).toEqual({ explode: 1 });
    expect(rig.grabs).toHaveLength(0);
  });

  it('joins nothing when the fist was already closed before the grab began: it must open and close again', () => {
    const rig = makeRig({ pick: point => (point.x < 500 ? onPart() : EMPTY_TARGET) });
    rig.run([open(owner), open(second)], 4);
    rig.run([open(owner), knob(second)], FIST_ENGAGE_FRAMES + 1);
    expect(rig.view(1)!.state).toBe('fist');
    rig.run([pinching(owner), knob(second)], 3 + PINCH_ENGAGE_FRAMES);
    expect(rig.view(0)!.state).toBe('grab');
    twist(rig, 0, 40);
    expect(rig.controller.twoHand).toBeNull();
    expect(rig.view(1)!.state).toBe('fist');
    expect(rig.grabs[0]!.rotates).toEqual([]);
    // Open and close again over the same hand: now it joins.
    rig.run([pinching(owner), open(second)], FIST_RELEASE_FRAMES + 2);
    rig.run([pinching(owner), knob(second)], FIST_ENGAGE_FRAMES + 1);
    expect(rig.controller.twoHand).toMatchObject({ gesture: 'rotate' });
  });

  it('is not there without fists: with fistEnabled false a closed second hand joins nothing', () => {
    const rig = makeRig({ pick: onPart, fistEnabled: false });
    rig.run([open(owner), open(second)], 6);
    rig.run([pinching(owner), open(second)], 3);
    rig.run([pinching(owner), knob(second)], FIST_ENGAGE_FRAMES + 3);
    expect(rig.controller.twoHand).toBeNull();
    expect(rig.view(1)!.state).not.toBe('join');
  });

  it('does not exist below full control: at view-only the first pinch turns the view and a fist is inert', () => {
    const rig = makeRig({ pick: onPart });
    rig.controller.setGate(VIEW_ONLY);
    rig.run([open(owner), open(second)], 6);
    rig.run([pinching(owner), open(second)], 3);
    rig.run([pinching(owner), knob(second)], FIST_ENGAGE_FRAMES + 1);
    expect(rig.log).toEqual(['beginOrbit']);
    expect(rig.controller.twoHand).toBeNull();
    expect(rig.view(1)!.state).not.toBe('join');
  });
});

// ---- Task 12: a second-hand pinch with curled fingers must not turn into a fist -----------------------------------------------------

/**
 * A pinch with the other three fingers curled, placed by its pinch midpoint like `hand`. Without `indexRatio` the index finger stays
 * extended (curl ratio about 1.36, above the engage ratio); with it the index finger bends toward the thumb until its own ratio, and so
 * the hand's curl ratio, is that value (the number is chosen by the test, it is not a webcam measurement). `pinchM` defaults to a closed pinch.
 */
function curledPinch(x: number, y: number, indexRatio?: number, pinchM = CLOSED): HandSample {
  return handSample(syntheticHand({ cursor: clientToNormalized({ x, y }, VIEW, VIDEO), pinchM, curledFingers: true, indexRatio }), VIEW, VIDEO)!;
}

describe('HandController, a second-hand pinch with curled fingers (Task 12, the real joinGesture)', () => {
  const owner: [number, number] = [200, 300];
  const second: [number, number] = [700, 300];
  /** An index finger bent so far that the hand's curl ratio is below FIST_ENGAGE_RATIO although the thumb and index finger still touch. */
  const BENT = 0.95;
  /** Longer than FIST_ENGAGE_MS: the time a curled hand must stay unmoved to engage a fist. */
  const LONG = FIST_ENGAGE_FRAMES + 4;
  const PINCH_RELEASE_FRAMES = Math.ceil(PINCH_RELEASE_MS / FRAME_MS) + 1;
  const onPart = () => part('o1', 'p1', 'Arm');
  const ownerPinch = [owner[0], owner[1], true] as const;
  const ownerOpen = [owner[0], owner[1], false] as const;
  const secondOpen = [second[0], second[1], false] as const;
  const last = <T>(values: T[]): T => values[values.length - 1]!;

  /** The first hand pinches a part; then the second hand pinches with its other fingers curled (curl ratio about 1.36): they join as a rotate. */
  function rotatingWithCurledFingers() {
    const rig = makeRig({ pick: onPart });
    rig.run([ownerOpen, secondOpen], 6);
    rig.run([ownerPinch, secondOpen], PINCH_ENGAGE_FRAMES + 1);
    rig.run([ownerPinch, curledPinch(...second)], PINCH_ENGAGE_FRAMES + 1);
    return rig;
  }

  it('measures the synthetic pinch with curled fingers: about 1.36 with the index extended, below FIST_ENGAGE_RATIO only with a bent index', () => {
    expect(rotatingWithCurledFingers().controller.stats.hands[1].curl).toBeCloseTo(1.36, 2);
    const rig = rotatingWithCurledFingers();
    rig.run([ownerPinch, curledPinch(...second, BENT)], 2);
    expect(rig.controller.stats.hands[1].curl).toBeCloseTo(BENT, 2);
    expect(rig.controller.stats.hands[1].curl!).toBeLessThan(FIST_ENGAGE_RATIO);
  });

  it('keeps the second hand a pinch in the circle rotate when its index bends and its curl ratio stays below the engage ratio, unmoved, for longer than FIST_ENGAGE_MS', () => {
    const rig = rotatingWithCurledFingers();
    // The overlay marks only the fist knob with `input: 'fist'`; a joining pinch has no `input`.
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.view(1)!.input).toBeUndefined();
    expect(rig.controller.twoHand).toMatchObject({ gesture: 'rotate' });
    rig.run([ownerPinch, curledPinch(...second, BENT)], LONG);
    expect(rig.controller.stats.hands[1].curl!).toBeLessThan(FIST_ENGAGE_RATIO);
    // Still the pinch-and-circle rotate: not the fist knob, and nothing was let go.
    expect(rig.controller.stats.hands[1].fist).toBe(false);
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.view(1)!.input).toBeUndefined();
    expect(rig.last.gesture).toBe('rotate');
    expect(rig.controller.twoHand).toMatchObject({ gesture: 'rotate' });
    expect(rig.grabs[0]!.cancels).toBe(0);
    expect(rig.controller.stats.twoHand).toEqual({ rotate: 1 });
  });

  it('goes on turning the part by circling while the curl ratio is below the engage ratio, and the release of the pinch still ends the join', () => {
    const rig = rotatingWithCurledFingers();
    rig.run([ownerPinch, curledPinch(...second, BENT)], LONG);
    const centre = rig.view(0)!.cursor;
    const radius = Math.hypot(second[0] - centre.x, second[1] - centre.y);
    const base = Math.atan2(second[1] - centre.y, second[0] - centre.x);
    for (let degrees = 10; degrees <= 30; degrees += 10) {
      const radians = base + (degrees * Math.PI) / 180;
      rig.run([ownerPinch, curledPinch(centre.x + radius * Math.cos(radians), centre.y + radius * Math.sin(radians), BENT)], 6);
    }
    const end = base + (30 * Math.PI) / 180;
    rig.run([ownerPinch, curledPinch(centre.x + radius * Math.cos(end), centre.y + radius * Math.sin(end), BENT)], 30);
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.view(1)!.input).toBeUndefined();
    expect(last(rig.grabs[0]!.rotates)).toBeCloseTo(25, 0);
    // The thumb opens while the index finger stays bent: the pinch is released the normal way (the real distance counts, not a fist).
    rig.run([ownerPinch, curledPinch(centre.x + radius * Math.cos(end), centre.y + radius * Math.sin(end), BENT, OPEN)], PINCH_RELEASE_FRAMES + 2);
    expect(rig.controller.twoHand).toBeNull();
    expect(rig.last.gesture).toBe('grab');
    expect(rig.controller.stats.hands[1].fist).toBe(false);
    expect(rig.grabs[0]!.commits).toBe(0);
  });

  it('keeps a pinch that joined a two-hand zoom, too', () => {
    const rig = makeRig({ pick: () => EMPTY_TARGET });
    rig.run([ownerOpen, secondOpen], 6);
    rig.run([ownerPinch, secondOpen], PINCH_ENGAGE_FRAMES + 1);
    rig.run([ownerPinch, curledPinch(...second)], PINCH_ENGAGE_FRAMES + 1);
    expect(rig.last.gesture).toBe('zoom');
    rig.run([ownerPinch, curledPinch(...second, BENT)], LONG);
    expect(rig.controller.stats.hands[1].fist).toBe(false);
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.view(1)!.input).toBeUndefined();
    expect(rig.last.gesture).toBe('zoom');
    expect(rig.orbits[0]!.ends).toBe(0);
  });

  it('keeps a pinch that joined an explode, too, while the other hand holds with a fist', () => {
    const rig = makeRig({ pick: onPart });
    rig.run([ownerOpen, secondOpen], 6);
    rig.run([palmHand(owner[0], owner[1], 'fist'), secondOpen], FIST_ENGAGE_FRAMES + 1);
    expect(rig.view(0)!.state).toBe('hold');
    rig.run([palmHand(owner[0], owner[1], 'fist'), curledPinch(...second)], PINCH_ENGAGE_FRAMES + 1);
    expect(rig.last.gesture).toBe('explode');
    rig.run([palmHand(owner[0], owner[1], 'fist'), curledPinch(...second, BENT)], LONG);
    expect(rig.controller.stats.hands[1].fist).toBe(false);
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.view(1)!.input).toBeUndefined();
    expect(rig.last.gesture).toBe('explode');
    expect(rig.holds).toHaveLength(1);
    expect(rig.holds[0]!.cancels).toBe(0);
  });

  it('keeps the first hand a pinch as well while the second hand takes part: its curl ratio below the engage ratio does not drop the grab', () => {
    const rig = rotatingWithCurledFingers();
    rig.run([curledPinch(...owner, BENT), curledPinch(...second)], LONG);
    expect(rig.controller.stats.hands[0].curl!).toBeLessThan(FIST_ENGAGE_RATIO);
    expect(rig.controller.stats.hands[0].fist).toBe(false);
    expect(rig.view(0)!.state).toBe('grab');
    expect(rig.holds).toHaveLength(0);
    expect(rig.grabs[0]!.cancels).toBe(0);
    expect(rig.controller.twoHand).toMatchObject({ gesture: 'rotate' });
  });

  it('keeps an inert second pinch a pinch: another hand runs a gesture that nothing joins, and the curl ratio below the engage ratio does not make it a fist', () => {
    const rig = makeRig({ pick: onPart, join: () => null });
    rig.run([ownerOpen, secondOpen], 6);
    rig.run([ownerPinch, secondOpen], PINCH_ENGAGE_FRAMES + 1);
    rig.run([ownerPinch, curledPinch(...second)], PINCH_ENGAGE_FRAMES + 1);
    expect(rig.controller.stats.inert).toBe(1);
    rig.run([ownerPinch, curledPinch(...second, BENT)], LONG);
    expect(rig.controller.stats.hands[1].fist).toBe(false);
    expect(rig.controller.stats.hands[1].pinching).toBe(true);
    expect(rig.view(0)!.state).toBe('grab');
  });

  it('still starts the knob rotate for a fist made directly with the second hand: it never pinched', () => {
    const rig = makeRig({ pick: onPart });
    rig.run([ownerOpen, secondOpen], 6);
    rig.run([ownerPinch, secondOpen], PINCH_ENGAGE_FRAMES + 1);
    rig.run([ownerPinch, palmHand(second[0], second[1], 'fist')], FIST_ENGAGE_FRAMES + 1);
    expect(rig.controller.stats.hands[0].pinching).toBe(true);
    expect(rig.controller.stats.hands[1].pinching).toBe(false);
    expect(rig.view(1)!.state).toBe('join');
    expect(rig.view(1)!.input).toBe('fist');
    expect(rig.last.gesture).toBe('rotate');
    expect(rig.controller.stats.twoHand).toEqual({ rotate: 1 });
  });

  it('keeps the one-hand rule of requirement 90: a single pinch, unmoved, that closes further still becomes a fist hold', () => {
    const rig = makeRig({ pick: onPart });
    rig.run([ownerOpen], 6);
    rig.run([curledPinch(...owner)], PINCH_ENGAGE_FRAMES + 1);
    expect(rig.view(0)!.state).toBe('grab');
    rig.run([curledPinch(...owner, BENT)], LONG);
    expect(rig.controller.stats.hands[0].fist).toBe(true);
    expect(rig.view(0)!.state).toBe('hold');
    expect(rig.grabs[0]!.cancels).toBe(1);
    expect(rig.holds).toHaveLength(1);
  });

  it('lets the first hand give way to a fist after the second hand has left: the gesture is no longer a two-hand one', () => {
    const rig = rotatingWithCurledFingers();
    // The second hand opens: it leaves the rotate, and the owner is a plain one-hand grab again.
    rig.run([ownerPinch, hand(second[0], second[1], false)], PINCH_RELEASE_FRAMES + 2);
    expect(rig.controller.twoHand).toBeNull();
    rig.run([curledPinch(...owner, BENT), hand(second[0], second[1], false)], LONG);
    expect(rig.controller.stats.hands[0].fist).toBe(true);
    expect(rig.view(0)!.state).toBe('hold');
  });
});

describe('knobAngle (Task 11)', () => {
  const pointsOf = (roll: number, side: 'left' | 'right' = 'right') => handSample(
    syntheticHand({ cursor: { x: 0.5, y: 0.5 }, pinchM: 0.08, fist: true, roll, side, aspect: VIDEO.width / VIDEO.height }), VIEW, VIDEO)!.points;
  const turn = (from: number, to: number, side: 'left' | 'right' = 'right') => angleDelta(knobAngle(pointsOf(from, side))!, knobAngle(pointsOf(to, side))!);
  /** What a mirror does to the same frame: every x runs the other way. */
  const mirrored = (points: readonly Point[]): Point[] => points.map(point => ({ x: VIEW.width - point.x, y: point.y }));

  it('grows clockwise on screen, for either hand, and is the wrist-to-middle-knuckle direction', () => {
    expect(turn(0, 30)).toBeCloseTo(30, 6);
    expect(turn(0, -30)).toBeCloseTo(-30, 6);
    expect(turn(0, 30, 'left')).toBeCloseTo(30, 6);
    expect(turn(10, 100)).toBeCloseTo(90, 6);
    const points = pointsOf(0);
    expect(knobAngle(points)).toBeCloseTo(pairAngle(points[0]!, points[9]!), 9);
    // The synthetic hand points up on screen: the vector from the wrist to the knuckle has a negative y.
    expect(points[9]!.y).toBeLessThan(points[0]!.y);
  });

  it('wraps across ±180° one step at a time', () => {
    // The base vector points up (about -98°), so 270° and 290° of roll are on either side of the ±180° seam.
    expect(turn(270, 290)).toBeCloseTo(20, 6);
    expect(turn(290, 270)).toBeCloseTo(-20, 6);
    expect(turn(0, 190)).toBeCloseTo(-170, 6);
  });

  it('is read in display space: the frame that is flipped before tracking gives the turn the user sees, and a raw (unflipped) frame gives the opposite sign', () => {
    // The landmarks of the app are those of the flipped (display) frame: a clockwise turn on screen is positive.
    expect(turn(0, 30)).toBeCloseTo(30, 6);
    // The same hand in the unflipped camera frame turns the other way round, which is why the mirrored view must be read in display space.
    const raw = (roll: number) => knobAngle(mirrored(pointsOf(roll)))!;
    expect(angleDelta(raw(0), raw(30))).toBeCloseTo(-30, 6);
  });

  it('is null for fewer than 10 points and for a vector of zero length', () => {
    expect(knobAngle([])).toBeNull();
    expect(knobAngle(pointsOf(0).slice(0, 9))).toBeNull();
    expect(knobAngle(pointsOf(0).map(() => ({ x: 10, y: 10 })))).toBeNull();
  });
});
