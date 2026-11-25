import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SNAP_SETTLE_MS } from '../../shared/joint-constants';
import { addJoint, addObject, emptyWorkspace, type ObjectTransform, type Workspace } from '../../shared/workspace';
import { DRAG_GAIN, FIST_ENGAGE_MS, FIST_ENGAGE_RATIO, FIST_RELEASE_MS, PINCH_ENGAGE_MS, PINCH_RELEASE_MS, TRACKING_LOSS_MS } from '../../src/hands/constants';
import {
  HandController, type AssemblePreview, type AssembleSession, type GrabSession, type HandPort, type HoldSession, type OrbitSession,
} from '../../src/hands/controller';
import type { Gate } from '../../src/hands/gate';
import { joinGesture } from '../../src/hands/join';
import { handSample } from '../../src/hands/mapping';
import { createStats } from '../../src/hands/stats';
import { overlayStyle } from '../../src/hands/style';
import { badgeText, debugLine } from '../../src/hands/text';
import { EMPTY_TARGET, type HandSample, type HandSlot, type OverlayFrame, type Point, type Target } from '../../src/hands/types';
import { createAssembleSession, createHoldSession, type AssembleResult, type LiveHold } from '../../src/scene/hand-sessions';
import { clientToNormalized, syntheticHand } from '../fixtures/synthetic-hand';
import { BOX, boxModel, fixtureJoint, fixtureObject, side } from '../fixtures/joint-workspace';

// The two-fist join (assembly-joints Task 6): the join row, the controller flow against a fake port, the multi-root hold and the
// assemble session on a small Three.js scene of two boxes. No MediaPipe, no model back end.

const FULL: Gate = { level: 'full', reason: null };
const EXPLODED: Gate = { level: 'view-only', reason: 'exploded' };
const AGENT: Gate = { level: 'view-only', reason: 'agent' };
const OFF: Gate = { level: 'off', reason: 'slow' };

describe('the assemble row of joinGesture', () => {
  const target = (objectId: string): Target => ({ kind: 'part', objectId, partId: 'p', label: 'p', hit: { x: 0, y: 0, z: 0 } });
  const context = (ownerObjectId: string | null, same: (a: string, b: string) => boolean = () => false) => ({ ownerObjectId, sameAssembly: same });

  it('is assemble for a fist on a part of another object, at full control', () => {
    expect(joinGesture('hold', { kind: 'fist', target: target('o2') }, FULL, context('o1'))).toBe('assemble');
  });

  it('is null for the same object, an object of the same assembly, empty space, a screen target and a pinch', () => {
    expect(joinGesture('hold', { kind: 'fist', target: target('o1') }, FULL, context('o1'))).toBeNull();
    expect(joinGesture('hold', { kind: 'fist', target: target('o2') }, FULL, context('o1', () => true))).toBeNull();
    expect(joinGesture('hold', { kind: 'fist', target: EMPTY_TARGET }, FULL, context('o1'))).toBeNull();
    expect(joinGesture('hold', { kind: 'fist', target: { kind: 'screen', id: 'x', label: 'x' } }, FULL, context('o1'))).toBeNull();
    // A pinch is the explode row, not an assemble.
    expect(joinGesture('hold', { kind: 'pinch', target: target('o2') }, FULL, context('o1'))).toBe('explode');
  });

  it('is null at every gate but full control, and for other owner gestures', () => {
    for (const gate of [EXPLODED, AGENT, OFF]) expect(joinGesture('hold', { kind: 'fist', target: target('o2') }, gate, context('o1'))).toBeNull();
    // A fist on a grab is the knob rotate since Task 11 (see the grab rows below), so only these two owners leave it inert.
    for (const owner of ['press', 'orbit'] as const) expect(joinGesture(owner, { kind: 'fist', target: target('o2') }, FULL, context('o1'))).toBeNull();
  });

  it('is null without a context or without a held object', () => {
    expect(joinGesture('hold', { kind: 'fist', target: target('o2') }, FULL)).toBeNull();
    expect(joinGesture('hold', { kind: 'fist', target: target('o2') }, FULL, context(null))).toBeNull();
  });
});

describe('the grab rows of joinGesture (Task 11)', () => {
  const target = (objectId: string): Target => ({ kind: 'part', objectId, partId: 'p', label: 'p', hit: { x: 0, y: 0, z: 0 } });
  const context = (ownerObjectId: string | null, same: (a: string, b: string) => boolean = () => false) => ({ ownerObjectId, sameAssembly: same });

  it('is assemble for a pinch on a part of another object while a part is grabbed, at full control', () => {
    expect(joinGesture('grab', { kind: 'pinch', target: target('o2') }, FULL, context('o1'))).toBe('assemble');
  });

  it('is a rotate by circling for a pinch on the same object, on an object of the same assembly, on empty space and on a screen target', () => {
    expect(joinGesture('grab', { kind: 'pinch', target: target('o1') }, FULL, context('o1'))).toBe('rotate');
    expect(joinGesture('grab', { kind: 'pinch', target: target('o2') }, FULL, context('o1', () => true))).toBe('rotate');
    expect(joinGesture('grab', { kind: 'pinch', target: EMPTY_TARGET }, FULL, context('o1'))).toBe('rotate');
    expect(joinGesture('grab', { kind: 'pinch', target: { kind: 'screen', id: 'x', label: 'x' } }, FULL, context('o1'))).toBe('rotate');
  });

  it('is a rotate without a context or without a grabbed object, as it was before Task 11', () => {
    expect(joinGesture('grab', { kind: 'pinch', target: target('o2') }, FULL)).toBe('rotate');
    expect(joinGesture('grab', { kind: 'pinch', target: target('o2') }, FULL, context(null))).toBe('rotate');
  });

  it('is the knob rotate for a fist anywhere, over another object too, and never an assemble', () => {
    for (const under of [target('o1'), target('o2'), EMPTY_TARGET]) expect(joinGesture('grab', { kind: 'fist', target: under }, FULL, context('o1'))).toBe('rotate');
  });

  it('is null at every gate but full control, for the grab rows', () => {
    for (const gate of [EXPLODED, AGENT, OFF]) {
      for (const kind of ['pinch', 'fist'] as const) expect(joinGesture('grab', { kind, target: target('o2') }, gate, context('o1'))).toBeNull();
    }
  });

  it('leaves a hold with a pinch the explode, and a hold with a fist on another object the assemble', () => {
    expect(joinGesture('hold', { kind: 'pinch', target: target('o2') }, FULL, context('o1'))).toBe('explode');
    expect(joinGesture('hold', { kind: 'fist', target: target('o2') }, FULL, context('o1'))).toBe('assemble');
    expect(joinGesture('orbit', { kind: 'pinch', target: target('o2') }, FULL, context('o1'))).toBe('zoom');
  });
});

describe('the assemble badge and debug line', () => {
  const view = { target: EMPTY_TARGET, value: null, objectName: 'Block B' } as const;
  it('says 捏住 for a hold that a pinch started, and shows a ring instead of the square', () => {
    expect(badgeText({ ...view, state: 'hold', gesture: 'assemble', ready: false, input: 'pinch' })).toBe('手勢：捏住 Block B');
    expect(badgeText({ ...view, state: 'hold', gesture: 'assemble', ready: true, input: 'pinch' })).toBe('手勢：可以接合');
    expect(badgeText({ ...view, state: 'hold', gesture: 'assemble', input: 'fist' })).toBe('手勢：握住 Block B');
    expect(overlayStyle({ state: 'hold', input: 'pinch' }).mark).toBe('ring-filled');
    expect(overlayStyle({ state: 'hold', input: 'fist' }).mark).toBe('square-filled');
    expect(overlayStyle({ state: 'hold' }).mark).toBe('square-filled');
    expect(overlayStyle({ state: 'join', input: 'fist' }).mark).toBe('square-filled');
    expect(overlayStyle({ state: 'join' }).mark).toBe('ring-filled');
  });

  it('shows the held object until the snap is ready, then 可以接合', () => {
    expect(badgeText({ ...view, state: 'hold', gesture: 'assemble', ready: false })).toBe('手勢：握住 Block B');
    expect(badgeText({ ...view, state: 'hold', gesture: 'assemble', ready: true })).toBe('手勢：可以接合');
    expect(badgeText({ ...view, state: 'hold', gesture: 'hold' })).toBe('手勢：握住 Block B');
  });

  it('adds the snap numbers once an assemble has started, and not before', () => {
    const tracking = { delegate: 'GPU' as const, fps: 30, inferenceMs: 8, hands: 2, pinchMm: [] as (number | null)[], gesture: 'assemble' as const };
    const stats = createStats();
    expect(debugLine(stats, tracking)).not.toContain('接合：');
    stats.assembles = 1;
    expect(debugLine(stats, tracking)).toContain('接合：間隙 — mm · 角度 —° · 重疊 — mm² · 偵測 — ms · 接合 0');
    stats.snap = { gapMm: 4.26, angleDeg: 1.04, overlapMm2: 1200.4, detectMs: 0.62 };
    stats.joins = 2;
    expect(debugLine(stats, tracking)).toContain('接合：間隙 4.3 mm · 角度 1.0° · 重疊 1200 mm² · 偵測 0.6 ms · 接合 2');
  });
});

// ---- the controller against a fake port ----------------------------------------------------------------------------------------

const VIEW = { left: 0, top: 0, width: 1000, height: 800 };
const VIDEO = { width: 1000, height: 800 };
const FRAME_MS = 33;
/** Frames at FRAME_MS spacing that a fist needs to engage and to release. The first qualifying frame starts the clock, so one more than the time spans. */
const FIST_ENGAGE_FRAMES = Math.ceil(FIST_ENGAGE_MS / FRAME_MS) + 1;
const FIST_RELEASE_FRAMES = Math.ceil(FIST_RELEASE_MS / FRAME_MS) + 1;

/** A hand whose palm centre is at client point (x, y): an open hand, or a fist. */
function palmHand(x: number, y: number, mode: 'open' | 'fist'): HandSample {
  const sample = handSample(syntheticHand({ cursor: clientToNormalized({ x, y: 0 }, VIEW, VIDEO), pinchM: 0.08 }), VIEW, VIDEO)!;
  const palmDy = sample.palm.y - sample.cursor.y;
  const fist = mode === 'fist';
  const cursor = clientToNormalized({ x, y: fist ? y : y - palmDy }, VIEW, VIDEO);
  return handSample(syntheticHand({ cursor, pinchM: 0.08, fist }), VIEW, VIDEO)!;
}

const part = (objectId: string, partId: string, objectName: string): Target => ({ kind: 'part', objectId, partId, label: partId, hit: { x: 1, y: 2, z: 3 }, objectName });

class FakeHold implements HoldSession {
  previews: Point[] = [];
  commits = 0;
  cancels = 0;
  preview(offset: Point) { this.previews.push(offset); return true; }
  rebase() {}
  commit() { this.commits++; }
  cancel() { this.cancels++; }
}

class FakeAssemble implements AssembleSession {
  previews: Array<{ owner: Point; joiner: Point; now: number }> = [];
  commits: boolean[] = [];
  cancels = 0;
  ready = false;
  invalid = false;
  preview(owner: Point, joiner: Point, now: number): AssemblePreview | null {
    this.previews.push({ owner, joiner, now });
    if (this.invalid) return null;
    return { ready: this.ready, metrics: { gapMm: 4, angleDeg: 1, overlapMm2: 900 }, detectMs: 0.5 };
  }
  commit(allowJoin: boolean) { this.commits.push(allowJoin); }
  cancel() { this.cancels++; }
}

function makeRig(options: { fistEnabled?: boolean } = {}) {
  const log: string[] = [];
  const holds: FakeHold[] = [];
  const assembles: FakeAssemble[] = [];
  const cancelled: string[] = [];
  const state = { refuseAssemble: false, same: false };
  const pick = (point: Point): Target => (point.x < 500 ? part('o1', 'p1', 'Demo') : part('o2', 'p2', 'Other'));
  const port: HandPort = {
    pick,
    select: () => {},
    beginGrab: (): GrabSession | null => null,
    beginOrbit: (): OrbitSession | null => null,
    press: () => {},
    activate: objectId => { log.push(`activate ${objectId}`); },
    beginHold: objectId => {
      log.push(`beginHold ${objectId}`);
      const hold = new FakeHold();
      holds.push(hold);
      return hold;
    },
    beginAssemble: (owner, objectId, hit) => {
      log.push(`beginAssemble ${objectId}`);
      expect(owner).toBe(holds[0]);
      expect(hit).toEqual({ x: 1, y: 2, z: 3 });
      if (state.refuseAssemble) return null;
      const session = new FakeAssemble();
      assembles.push(session);
      return session;
    },
    sameAssembly: () => state.same,
  };
  const controller = new HandController(port, { fistEnabled: options.fistEnabled });
  controller.setObjectCount(2);
  controller.onCancelled = reason => cancelled.push(reason);
  let now = 1000;
  let last: OverlayFrame = { hands: [], gesture: 'none', link: null, arc: null };
  const run = (hands: readonly HandSample[], frames = 1) => {
    for (let index = 0; index < frames; index++) {
      now += FRAME_MS;
      last = controller.frame([...hands], now);
    }
    return last;
  };
  const view = (slot: HandSlot) => last.hands.find(item => item.slot === slot);
  return { controller, state, log, holds, assembles, cancelled, run, view, get last() { return last; } };
}
type Rig = ReturnType<typeof makeRig>;

const first: [number, number] = [200, 300];
const second: [number, number] = [700, 300];
const open = (at: readonly [number, number]) => palmHand(at[0], at[1], 'open');
const fist = (at: readonly [number, number]) => palmHand(at[0], at[1], 'fist');

/** The first fist holds the object on the left; the second fist then closes over the object on the right. */
function assembling(options: Parameters<typeof makeRig>[0] = {}): Rig {
  const rig = makeRig(options);
  rig.run([open(first), open(second)], 4);
  rig.run([fist(first), open(second)], FIST_ENGAGE_FRAMES);
  rig.run([fist(first), fist(second)], FIST_ENGAGE_FRAMES);
  return rig;
}

describe('HandController, two fists (the real joinGesture)', () => {
  it('starts an assemble on the second fist: beginAssemble, both hands in the hold state, gesture assemble, a link between the palms', () => {
    const rig = assembling();
    expect(rig.log).toEqual(['activate o1', 'beginHold o1', 'beginAssemble o2']);
    expect(rig.last.gesture).toBe('assemble');
    expect(rig.view(0)!.state).toBe('hold');
    expect(rig.view(0)!.badge).toBe('手勢：握住 Demo');
    expect(rig.view(1)!.state).toBe('hold');
    expect(rig.view(1)!.badge).toBe('手勢：握住 Other');
    expect(rig.last.link).toEqual({ from: rig.view(0)!.palm, to: rig.view(1)!.palm });
    expect(rig.controller.stats).toMatchObject({ assembles: 1, joins: 0, inert: 0, twoHand: { assemble: 1 } });
  });

  it('passes both palm offsets to preview each frame and does not freeze the owner', () => {
    const rig = assembling();
    const session = rig.assembles[0]!;
    expect(session.previews.at(-1)).toMatchObject({ owner: { x: 0, y: 0 }, joiner: { x: 0, y: 0 } });
    // Both fists move in small steps (a jump beyond HAND_MATCH_PX would count as a new hand).
    for (let step = 1; step <= 6; step++) rig.run([fist([first[0] + 20 * step, first[1]]), fist([second[0] - 25 * step, second[1] + 5 * step])]);
    rig.run([fist([first[0] + 120, first[1]]), fist([second[0] - 150, second[1] + 30])], 8);
    const latest = session.previews.at(-1)!;
    expect(latest.owner.x).toBeCloseTo(120, 0);
    expect(latest.owner.y).toBeCloseTo(0, 0);
    expect(latest.joiner.x).toBeCloseTo(-150, 0);
    // The palm filter lags a little behind the hand.
    expect(Math.abs(latest.joiner.y - 30)).toBeLessThan(3);
    // The owner's own hold is not previewed by the controller: the assemble session moves it.
    expect(rig.holds[0]!.previews).toEqual([]);
    expect(latest.now).toBeGreaterThan(session.previews[0]!.now);
    expect(rig.controller.stats.snap).toMatchObject({ gapMm: 4, angleDeg: 1, overlapMm2: 900, detectMs: 0.5 });
  });

  it('shows 手勢：可以接合 on the joining fist and no link while the snap is ready', () => {
    const rig = assembling();
    rig.assembles[0]!.ready = true;
    rig.run([fist(first), fist(second)], 2);
    expect(rig.view(1)!.badge).toBe('手勢：可以接合');
    expect(rig.view(0)!.badge).toBe('手勢：握住 Demo');
    expect(rig.last.link).toBeNull();
    expect(rig.last.gesture).toBe('assemble');
    rig.assembles[0]!.ready = false;
    rig.run([fist(first), fist(second)], 2);
    expect(rig.view(1)!.badge).toBe('手勢：握住 Other');
    expect(rig.last.link).not.toBeNull();
  });

  it('commits with allowJoin on the joining fist opening, counts the join when ready, and leaves the other fist closed and inert', () => {
    const rig = assembling();
    rig.assembles[0]!.ready = true;
    rig.run([fist(first), fist(second)], 2);
    rig.run([fist(first), open(second)], FIST_RELEASE_FRAMES + 1);
    expect(rig.assembles[0]!.commits).toEqual([true]);
    expect(rig.assembles[0]!.cancels).toBe(0);
    expect(rig.controller.stats).toMatchObject({ commits: 1, cancels: 0, joins: 1 });
    expect(rig.last.gesture).toBe('none');
    expect(rig.view(0)!.state).toBe('fist');
    // Nothing starts again while the first fist stays closed.
    rig.run([fist(first), open(second)], 10);
    expect(rig.log).toEqual(['activate o1', 'beginHold o1', 'beginAssemble o2']);
    expect(rig.assembles[0]!.commits).toEqual([true]);
  });

  it('commits when the owner opens first, and counts no join when the snap was not ready', () => {
    const rig = assembling();
    rig.run([open(first), fist(second)], FIST_RELEASE_FRAMES + 1);
    expect(rig.assembles[0]!.commits).toEqual([true]);
    expect(rig.controller.stats).toMatchObject({ commits: 1, joins: 0 });
    expect(rig.holds[0]!.commits).toBe(0);
    expect(rig.holds[0]!.cancels).toBe(0);
    expect(rig.last.gesture).toBe('none');
  });

  it('follows ON_TRACKING_LOSS when either hand is lost (cancel), and never creates a joint', () => {
    for (const lost of ['owner', 'joiner'] as const) {
      const rig = assembling();
      rig.assembles[0]!.ready = true;
      rig.run([fist(first), fist(second)], 2);
      const frames = Math.ceil(TRACKING_LOSS_MS / FRAME_MS) + 2;
      rig.run(lost === 'owner' ? [fist(second)] : [fist(first)], frames);
      expect(rig.assembles[0]!.cancels).toBe(1);
      expect(rig.assembles[0]!.commits).toEqual([]);
      expect(rig.cancelled).toEqual(['loss']);
      expect(rig.controller.stats).toMatchObject({ cancels: 1, joins: 0 });
      expect(rig.last.gesture).toBe('none');
    }
  });

  it('cancels both holds and reports external when the scene says the session is no longer valid', () => {
    const rig = assembling();
    rig.assembles[0]!.invalid = true;
    rig.run([fist(first), fist(second)], 2);
    expect(rig.assembles[0]!.cancels).toBe(1);
    expect(rig.cancelled).toEqual(['external']);
    expect(rig.last.gesture).toBe('none');
    expect(rig.view(0)!.state).toBe('locked');
    expect(rig.view(1)!.state).toBe('locked');
    rig.run([open(first), open(second)], FIST_RELEASE_FRAMES + 1);
    expect(rig.view(0)!.state).not.toBe('locked');
  });

  it('cancels on a gate change away from full control, and on reset without reporting', () => {
    const exploded = assembling();
    exploded.controller.setGate(EXPLODED);
    expect(exploded.assembles[0]!.cancels).toBe(1);
    expect(exploded.cancelled).toEqual(['gate']);
    expect(exploded.holds[0]!.cancels).toBe(0);
    const agent = assembling();
    agent.controller.setGate(AGENT);
    expect(agent.assembles[0]!.cancels).toBe(1);
    const reset = assembling();
    reset.controller.reset();
    expect(reset.assembles[0]!.cancels).toBe(1);
    expect(reset.cancelled).toEqual([]);
  });

  it('is inert when the scene refuses (beginAssemble returns null): locked, 另一手操作中, the owner keeps holding', () => {
    const rig = makeRig();
    rig.state.refuseAssemble = true;
    rig.run([open(first), open(second)], 4);
    rig.run([fist(first), open(second)], FIST_ENGAGE_FRAMES);
    rig.run([fist(first), fist(second)], FIST_ENGAGE_FRAMES + 1);
    expect(rig.log).toContain('beginAssemble o2');
    expect(rig.view(1)!.state).toBe('locked');
    expect(rig.view(1)!.badge).toBe('手勢：另一手操作中');
    expect(rig.controller.stats).toMatchObject({ inert: 1, assembles: 0 });
    expect(rig.last.gesture).toBe('hold');
  });

  it('is inert on an object of the same assembly and never asks the scene', () => {
    const rig = makeRig();
    rig.state.same = true;
    rig.run([open(first), open(second)], 4);
    rig.run([fist(first), open(second)], FIST_ENGAGE_FRAMES);
    rig.run([fist(first), fist(second)], FIST_ENGAGE_FRAMES + 1);
    expect(rig.log).toEqual(['activate o1', 'beginHold o1']);
    expect(rig.view(1)!.badge).toBe('手勢：另一手操作中');
    expect(rig.controller.stats.inert).toBe(1);
  });

  it('is inert on the held object itself and over empty space', () => {
    const same = makeRig();
    same.run([open(first), open([260, 300])], 4);
    same.run([fist(first), open([260, 300])], FIST_ENGAGE_FRAMES);
    same.run([fist(first), fist([260, 300])], FIST_ENGAGE_FRAMES + 1);
    expect(same.log).toEqual(['activate o1', 'beginHold o1']);
    expect(same.view(1)!.state).toBe('locked');
  });

  it('with fistEnabled false has no assemble at all', () => {
    const rig = makeRig({ fistEnabled: false });
    rig.run([open(first), open(second)], 4);
    rig.run([fist(first), fist(second)], FIST_ENGAGE_FRAMES + 2);
    expect(rig.log.filter(line => line.startsWith('beginAssemble'))).toEqual([]);
  });
});

// ---- the hold over several roots ------------------------------------------------------------------------------------------------

const VIEWPORT_HEIGHT = 800;
const vec = (x: number, y: number, z: number) => ({ x, y, z });
const noRotation = vec(0, 0, 0);
const at = (x: number): ObjectTransform => ({ position: vec(x, 0, 0), rotation: noRotation });

/** World size of one screen pixel at depth 2 (the camera stands at z = 2), times the gain. */
const PIXEL = (2 * 2 * Math.tan(THREE.MathUtils.degToRad(20))) / VIEWPORT_HEIGHT * DRAG_GAIN;

function camera() {
  const value = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  value.position.set(0, 0, 2);
  value.lookAt(0, 0, 0);
  value.updateMatrixWorld(true);
  return value;
}

function root(x: number): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, 0, 0);
  group.updateMatrixWorld(true);
  return group;
}

describe('createHoldSession over several roots', () => {
  function rig() {
    const held = root(0);
    const near = root(0.1);
    const far = root(-0.2);
    const onCommit = vi.fn();
    const onEnd = vi.fn();
    const session = createHoldSession({
      objectId: 'a', root: held, camera: camera(), viewportHeight: () => VIEWPORT_HEIGHT, stored: vec(0, 0, 0), hit: vec(0, 0, 0),
      followers: [{ root: near, stored: vec(0.1, 0, 0) }, { root: far, stored: vec(-0.2, 0, 0), storedNow: () => vec(-0.25, 0, 0) }],
      onCommit, onChange: vi.fn(), onEnd,
    });
    return { held, near, far, session, onCommit, onEnd };
  }

  it('moves the followers by the same offset as the held root', () => {
    const { held, near, far, session } = rig();
    const px = 0.05 / PIXEL;
    expect(session.preview({ x: px, y: 0 })).toBe(true);
    expect(held.position.x).toBeCloseTo(0.05, 4);
    expect(near.position.x).toBeCloseTo(0.15, 4);
    expect(far.position.x).toBeCloseTo(-0.15, 4);
    expect(session.position.x).toBeCloseTo(0.05, 4);
  });

  it('commits only the held object, once, and puts every root back on cancel (followers to their own stored position)', () => {
    const first = rig();
    first.session.preview({ x: 40, y: 0 });
    first.session.commit();
    expect(first.onCommit).toHaveBeenCalledTimes(1);
    expect(first.onEnd).toHaveBeenCalledTimes(1);

    const second = rig();
    second.session.preview({ x: 40, y: 0 });
    second.session.cancel();
    expect(second.held.position.x).toBe(0);
    expect(second.near.position.x).toBeCloseTo(0.1, 6);
    expect(second.far.position.x).toBeCloseTo(-0.25, 6);
    expect(second.onCommit).not.toHaveBeenCalled();
  });

  it('release ends the session without committing or moving anything', () => {
    const { held, near, session, onCommit, onEnd } = rig();
    session.preview({ x: 40, y: 0 });
    const x = held.position.x;
    session.release();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(held.position.x).toBe(x);
    expect(near.position.x).toBeCloseTo(0.1 + x, 6);
    expect(session.preview({ x: 80, y: 0 })).toBe(false);
  });
});

// ---- the assemble session on two boxes ------------------------------------------------------------------------------------------

describe('createAssembleSession on two boxes', () => {
  /**
   * Block A at the origin, block B 30 mm beyond A's +x face, and block C joined to B's +x face (so B's assembly has two objects).
   * A's +x face is at x = 20 mm and B's -x face at 50 mm; moving B by -25 mm leaves a 5 mm gap, inside the engage limit.
   */
  function rig(options: { withC?: boolean } = {}) {
    let workspace: Workspace = emptyWorkspace();
    workspace = addObject(workspace, fixtureObject('a', boxModel('Block A'), at(0)));
    workspace = addObject(workspace, fixtureObject('b', boxModel('Block B'), at(0.07)));
    if (options.withC) {
      workspace = addObject(workspace, fixtureObject('c', boxModel('Block C'), at(0.07 + BOX.x)));
      workspace = addJoint(workspace, fixtureJoint(side('b', 'body', '+x'), side('c', 'body', '-x'), { id: 'bc' }));
    }
    const roots = new Map(workspace.objects.map(object => [object.id, root(object.transform.position.x)] as const));
    const stored = (id: string) => workspace.objects.find(object => object.id === id)?.transform ?? null;
    const view = camera();
    const hold = (id: string, followers: string[] = []) => createHoldSession({
      objectId: id, root: roots.get(id)!, camera: view, viewportHeight: () => VIEWPORT_HEIGHT, stored: { ...stored(id)!.position }, hit: vec(stored(id)!.position.x, 0, 0),
      followers: followers.map(follower => ({ root: roots.get(follower)!, stored: { ...stored(follower)!.position } })),
      onCommit: vi.fn(), onChange: vi.fn(), onEnd: vi.fn(),
    });
    const owner = hold('a');
    const joiner = hold('b', options.withC ? ['c'] : []);
    const cues: Array<{ a: unknown; b: unknown; label: { x: number; y: number; z: number } } | null> = [];
    const results: AssembleResult[] = [];
    const applied = { value: true };
    const session = createAssembleSession({
      workspace, owner, joiner, roots, stored,
      onCue: cue => cues.push(cue),
      onAssemble: result => { results.push(result); return applied.value; },
      onChange: vi.fn(),
    });
    return { workspace, roots, owner, joiner, session, cues, results, applied };
  }
  /** B's palm offset in pixels for a move of `metres` along x. */
  const px = (metres: number) => ({ x: metres / PIXEL, y: 0 });
  const NONE = { x: 0, y: 0 };

  it('becomes ready after SNAP_SETTLE_MS near a face and shows b at the aligned pose', () => {
    const { roots, session, cues } = rig();
    const t = 5000;
    expect(session.preview(NONE, px(-0.025), t)).toMatchObject({ ready: false });
    expect(session.preview(NONE, px(-0.025), t + SNAP_SETTLE_MS - 50)!.ready).toBe(false);
    expect(roots.get('b')!.position.x).toBeCloseTo(0.045, 4);
    const result = session.preview(NONE, px(-0.025), t + SNAP_SETTLE_MS)!;
    expect(result.ready).toBe(true);
    expect(result.metrics!.gapMm).toBeCloseTo(5, 0);
    expect(result.detectMs).toBeGreaterThanOrEqual(0);
    // Block B snaps against A's +x face: its centre goes to 20 mm + half its width, 40 mm.
    expect(roots.get('b')!.position.x).toBeCloseTo(0.04, 4);
    expect(roots.get('b')!.rotation.y).toBeCloseTo(0, 6);
    expect(roots.get('a')!.position.x).toBe(0);
    const cue = cues.at(-1)!;
    expect(cue.a).toEqual(side('a', 'body', '+x'));
    expect(cue.b).toEqual(side('b', 'body', '-x'));
    expect(cue.label.x).toBeCloseTo(0.02, 4);
  });

  it('moves the rest of b\'s assembly with the snap', () => {
    const { roots, session } = rig({ withC: true });
    const t = 5000;
    session.preview(NONE, px(-0.025), t);
    expect(roots.get('c')!.position.x).toBeCloseTo(0.07 + BOX.x - 0.025, 4);
    expect(session.preview(NONE, px(-0.025), t + SNAP_SETTLE_MS)!.ready).toBe(true);
    // B moved from 70 mm to 40 mm, so C moves 30 mm too.
    expect(roots.get('c')!.position.x).toBeCloseTo(0.07 + BOX.x - 0.03, 4);
  });

  it('lets go when the hands move away, and puts b back at the hand pose', () => {
    const { roots, session, cues } = rig();
    session.preview(NONE, px(-0.025), 5000);
    expect(session.preview(NONE, px(-0.025), 5000 + SNAP_SETTLE_MS)!.ready).toBe(true);
    const far = session.preview(NONE, px(0), 5400)!;
    expect(far.ready).toBe(false);
    expect(roots.get('b')!.position.x).toBeCloseTo(0.07, 4);
    expect(cues.at(-1)).toBeNull();
  });

  it('commit(true) with a ready snap gives one join result: b\'s aligned transform and the pair; a did not move', () => {
    const { session, results, owner, cues } = rig();
    session.preview(NONE, px(-0.025), 5000);
    session.preview(NONE, px(-0.025), 5000 + SNAP_SETTLE_MS);
    session.commit(true);
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.kind).toBe('join');
    if (result.kind !== 'join') return;
    expect(result.aId).toBe('a');
    expect(result.aPosition).toBeNull();
    expect(result.bId).toBe('b');
    expect(result.bTransform.position.x).toBeCloseTo(0.04, 4);
    expect(result.bTransform.rotation).toEqual(noRotation);
    expect(result.a).toEqual(side('a', 'body', '+x'));
    expect(result.b).toEqual(side('b', 'body', '-x'));
    expect(cues.at(-1)).toBeNull();
    expect(owner.preview(NONE)).toBe(false);
  });

  it('commit(true) without a snap commits the moves; commit(false) never joins even with a ready snap', () => {
    const moved = rig();
    moved.session.preview(px(0.01), px(-0.015), 5000);
    moved.session.commit(true);
    expect(moved.results).toEqual([{ kind: 'moves', aId: 'a', aPosition: { x: expect.closeTo(0.01, 4), y: 0, z: 0 }, bId: 'b', bPosition: { x: expect.closeTo(0.055, 4), y: 0, z: 0 } }]);

    const kept = rig();
    kept.session.preview(NONE, px(-0.025), 5000);
    kept.session.preview(NONE, px(-0.025), 5000 + SNAP_SETTLE_MS);
    kept.session.commit(false);
    expect(kept.results).toHaveLength(1);
    expect(kept.results[0]!.kind).toBe('moves');
    // The roots stand at the hand pose, not the snapped one, while the app applies the moves.
    expect(kept.roots.get('b')!.position.x).toBeCloseTo(0.045, 4);
  });

  it('commits nothing when neither object moved, and puts the roots back when the app does not apply a result', () => {
    const still = rig();
    still.session.preview(NONE, NONE, 5000);
    still.session.commit(true);
    expect(still.results).toEqual([]);
    expect(still.roots.get('b')!.position.x).toBe(0.07);

    const refused = rig();
    refused.applied.value = false;
    refused.session.preview(NONE, px(-0.025), 5000);
    refused.session.preview(NONE, px(-0.025), 5000 + SNAP_SETTLE_MS);
    refused.session.commit(true);
    expect(refused.results).toHaveLength(1);
    expect(refused.roots.get('b')!.position.x).toBe(0.07);
    expect(refused.roots.get('b')!.rotation.y).toBe(0);
  });

  it('cancel puts both objects and every rotation back, and clears the cue', () => {
    const { roots, session, results, cues } = rig({ withC: true });
    session.preview(px(0.01), px(-0.025), 5000);
    session.preview(px(0.01), px(-0.025), 5000 + SNAP_SETTLE_MS);
    session.cancel();
    expect(roots.get('a')!.position.x).toBe(0);
    expect(roots.get('b')!.position.x).toBeCloseTo(0.07, 6);
    expect(roots.get('c')!.position.x).toBeCloseTo(0.07 + BOX.x, 6);
    expect(results).toEqual([]);
    expect(cues.at(-1)).toBeNull();
  });

  it('returns null from preview when a hold is no longer valid', () => {
    const { session, joiner } = rig();
    joiner.invalidate();
    expect(session.preview(NONE, NONE, 5000)).toBeNull();
  });
});

// ---- Task 10: the snap stays latched while a hand opens ---------------------------------------------------------------------------

describe('HandController, two fists: the freeze while a fist opens (Task 10)', () => {
  /** A fist whose fingers have begun to open: the curl ratio is above the engage ratio and below the release ratio. */
  const halfOpen = (at: readonly [number, number]): HandSample => ({ ...fist(at), curl: 1.1 });

  it('keeps a ready snap latched while the joining fist opens: nothing is asked of the scene, and the confirmed release commits the join', () => {
    const rig = assembling();
    const session = rig.assembles[0]!;
    session.ready = true;
    rig.run([fist(first), fist(second)], 2);
    expect(rig.view(1)!.badge).toBe('手勢：可以接合');
    const previews = session.previews.length;
    // The opening hand drifts, and the scene would now say "not ready"; the controller does not ask while a hand opens.
    session.ready = false;
    rig.run([fist(first), halfOpen([second[0] + 20, second[1]])], 3);
    rig.run([fist(first), halfOpen([second[0] + 45, second[1] + 10])], 3);
    expect(session.previews).toHaveLength(previews);
    expect(rig.view(1)!.badge).toBe('手勢：可以接合');
    expect(rig.last.link).toBeNull();
    expect(session.commits).toEqual([]);
    rig.run([fist(first), open([second[0] + 60, second[1] + 10])], FIST_RELEASE_FRAMES);
    expect(session.commits).toEqual([true]);
    expect(session.cancels).toBe(0);
    expect(session.previews).toHaveLength(previews);
    expect(rig.controller.stats).toMatchObject({ commits: 1, cancels: 0, joins: 1 });
  });

  it('latches the snap the same way when the first fist is the one that opens', () => {
    const rig = assembling();
    const session = rig.assembles[0]!;
    session.ready = true;
    rig.run([fist(first), fist(second)], 2);
    const previews = session.previews.length;
    session.ready = false;
    rig.run([halfOpen([first[0] - 30, first[1]]), fist(second)], 6);
    expect(session.previews).toHaveLength(previews);
    rig.run([open([first[0] - 40, first[1]]), fist(second)], FIST_RELEASE_FRAMES);
    expect(session.commits).toEqual([true]);
    expect(rig.controller.stats.joins).toBe(1);
  });

  it('asks the scene again when the hands close before the release, so the existing rules can release the snap', () => {
    const rig = assembling();
    const session = rig.assembles[0]!;
    session.ready = true;
    rig.run([fist(first), fist(second)], 2);
    const previews = session.previews.length;
    rig.run([fist(first), halfOpen(second)], 4);
    expect(session.previews).toHaveLength(previews);
    session.ready = false;
    rig.run([fist(first), fist(second)], 2);
    expect(session.previews.length).toBeGreaterThan(previews);
    expect(rig.view(1)!.badge).toBe('手勢：握住 Other');
    rig.run([fist(first), open(second)], FIST_RELEASE_FRAMES);
    expect(session.commits).toEqual([true]);
    expect(rig.controller.stats.joins).toBe(0);
  });

  it('resumes the two holds without a jump: the offsets after closing again equal the last offsets before the freeze', () => {
    const rig = assembling();
    const session = rig.assembles[0]!;
    for (let step = 1; step <= 4; step++) rig.run([fist([first[0] + 10 * step, first[1]]), fist([second[0] - 15 * step, second[1]])], 2);
    rig.run([fist([first[0] + 40, first[1]]), fist([second[0] - 60, second[1]])], 10);
    const before = session.previews.at(-1)!;
    expect(before.owner.x).toBeGreaterThan(30);
    expect(before.joiner.x).toBeLessThan(-50);
    const count = session.previews.length;
    // Both hands travel on while the joining fist opens.
    for (let step = 1; step <= 4; step++) rig.run([fist([first[0] + 40 + 20 * step, first[1] + 10 * step]), halfOpen([second[0] - 60 - 25 * step, second[1] + 10 * step])], 2);
    expect(session.previews).toHaveLength(count);
    rig.run([fist([first[0] + 120, first[1] + 40]), fist([second[0] - 160, second[1] + 40])], 1);
    expect(session.previews).toHaveLength(count + 1);
    const after = session.previews.at(-1)!;
    expect(after.owner.x).toBeCloseTo(before.owner.x, 6);
    expect(after.owner.y).toBeCloseTo(before.owner.y, 6);
    expect(after.joiner.x).toBeCloseTo(before.joiner.x, 6);
    expect(after.joiner.y).toBeCloseTo(before.joiner.y, 6);
    // And they follow again from there: the owner offset grows by what the (filtered) palm travelled since the resume.
    const palmAtResume = rig.view(0)!.palm.x;
    rig.run([fist([first[0] + 160, first[1] + 40]), fist([second[0] - 160, second[1] + 40])], 30);
    expect(rig.view(0)!.palm.x - palmAtResume).toBeGreaterThan(30);
    expect(session.previews.at(-1)!.owner.x).toBeCloseTo(before.owner.x + (rig.view(0)!.palm.x - palmAtResume), 3);
  });

  it('freezes a plain fist hold while the fist opens too, in the same rig', () => {
    const rig = makeRig();
    rig.run([open(first), open(second)], 4);
    rig.run([fist(first), open(second)], FIST_ENGAGE_FRAMES);
    rig.run([fist([first[0] + 60, first[1]]), open(second)], 30);
    const hold = rig.holds[0]!;
    const count = hold.previews.length;
    rig.run([halfOpen([first[0] + 120, first[1]]), open(second)], 6);
    expect(hold.previews).toHaveLength(count);
    rig.run([open([first[0] + 140, first[1]]), open(second)], FIST_RELEASE_FRAMES);
    expect(hold.commits).toBe(1);
    expect(hold.previews).toHaveLength(count);
  });
});

// ---- Task 11: the join with two pinches ----------------------------------------------------------------------------------------------

const PINCH_CLOSED_M = 0.015;
const PINCH_OPEN_M = 0.08;
/** Between the engage (40 mm) and the release (55 mm) distance: a pinch that has begun to open. */
const PINCH_OPENING_M = 0.045;
/** Frames at FRAME_MS spacing that a pinch needs to engage and to release (the first qualifying frame starts the clock). */
const PINCH_ENGAGE_FRAMES = Math.ceil(PINCH_ENGAGE_MS / FRAME_MS) + 1;
const PINCH_RELEASE_FRAMES = Math.ceil(PINCH_RELEASE_MS / FRAME_MS) + 1;

/** A hand with its pinch midpoint at client point (x, y): open, or pinching (`opening`: a pinch that has begun to open). */
function pinchHand(at: readonly [number, number], state: 'open' | 'closed' | 'opening'): HandSample {
  const pinchM = state === 'open' ? PINCH_OPEN_M : state === 'closed' ? PINCH_CLOSED_M : PINCH_OPENING_M;
  return handSample(syntheticHand({ cursor: clientToNormalized({ x: at[0], y: at[1] }, VIEW, VIDEO), pinchM }), VIEW, VIDEO)!;
}

class PinchGrab implements GrabSession {
  previews: Point[] = [];
  rotates: number[] = [];
  commits = 0;
  cancels = 0;
  constructor(private readonly log: string[]) {}
  preview(offset: Point) { this.previews.push(offset); return true; }
  rotate(angleDeg: number) { this.rotates.push(angleDeg); return true; }
  rebase() {}
  commit() { this.commits++; this.log.push('grab.commit'); }
  cancel() { this.cancels++; this.log.push('grab.cancel'); }
}

/** The first hand's part is in object o1 (left of x = 500); the second hand's target is `state.right` (a part of o2 unless a test says otherwise). */
function makePinchRig() {
  const log: string[] = [];
  const grabs: PinchGrab[] = [];
  const holds: FakeHold[] = [];
  const assembles: FakeAssemble[] = [];
  const cancelled: string[] = [];
  const state = { refuseAssemble: false, refuseHold: false, same: false, right: part('o2', 'p2', 'Other') as Target };
  const port: HandPort = {
    pick: point => (point.x < 500 ? part('o1', 'p1', 'Demo') : state.right),
    select: (objectId, partId) => { log.push(`select ${objectId}:${partId}`); },
    beginGrab: (objectId, partId) => {
      log.push(`beginGrab ${objectId}:${partId}`);
      const grab = new PinchGrab(log);
      grabs.push(grab);
      return grab;
    },
    beginOrbit: (): OrbitSession | null => null,
    press: () => {},
    activate: objectId => { log.push(`activate ${objectId}`); },
    beginHold: (objectId, hit) => {
      log.push(`beginHold ${objectId}`);
      expect(hit).toEqual({ x: 1, y: 2, z: 3 });
      if (state.refuseHold) return null;
      const hold = new FakeHold();
      holds.push(hold);
      return hold;
    },
    beginAssemble: (owner, objectId, hit) => {
      log.push(`beginAssemble ${objectId}`);
      expect(owner).toBe(holds[0]);
      expect(hit).toEqual({ x: 1, y: 2, z: 3 });
      if (state.refuseAssemble) return null;
      const session = new FakeAssemble();
      assembles.push(session);
      return session;
    },
    sameAssembly: () => state.same,
  };
  const controller = new HandController(port);
  controller.setObjectCount(2);
  controller.onCancelled = reason => cancelled.push(reason);
  let now = 1000;
  let last: OverlayFrame = { hands: [], gesture: 'none', link: null, arc: null };
  const run = (hands: readonly HandSample[], frames = 1) => {
    for (let index = 0; index < frames; index++) {
      now += FRAME_MS;
      last = controller.frame([...hands], now);
    }
    return last;
  };
  const view = (slot: HandSlot) => last.hands.find(item => item.slot === slot);
  return { controller, state, log, grabs, holds, assembles, cancelled, run, view, get last() { return last; } };
}
type PinchRig = ReturnType<typeof makePinchRig>;

/** The first hand pinches the part of o1 and grabs it; then the second hand pinches the part under it. */
function pinchJoining(): PinchRig {
  const rig = makePinchRig();
  rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], 6);
  rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], PINCH_ENGAGE_FRAMES);
  rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], PINCH_ENGAGE_FRAMES);
  return rig;
}

describe('HandController, two pinches (the real joinGesture)', () => {
  it('switches from a part grab to two holds: the grab is cancelled first, then both objects are held, and nothing is committed or counted as a cancel', () => {
    const rig = pinchJoining();
    expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1', 'grab.cancel', 'beginHold o1', 'beginAssemble o2']);
    expect(rig.grabs[0]).toMatchObject({ cancels: 1, commits: 0 });
    expect(rig.holds).toHaveLength(1);
    expect(rig.cancelled).toEqual([]);
    expect(rig.controller.stats).toMatchObject({ assembles: 1, joins: 0, inert: 0, commits: 0, cancels: 0, twoHand: { assemble: 1 } });
    expect(rig.last.gesture).toBe('assemble');
    expect(rig.last.link).toEqual({ from: rig.view(0)!.cursor, to: rig.view(1)!.cursor });
  });

  it('shows both hands as holds with a ring at the cursor and the badge 手勢：捏住 {object name}', () => {
    const rig = pinchJoining();
    for (const slot of [0, 1] as const) {
      expect(rig.view(slot)!.state).toBe('hold');
      expect(rig.view(slot)!.input).toBe('pinch');
      expect(overlayStyle(rig.view(slot)!).mark).toBe('ring-filled');
    }
    expect(rig.view(0)!.badge).toBe('手勢：捏住 Demo');
    expect(rig.view(1)!.badge).toBe('手勢：捏住 Other');
    rig.assembles[0]!.ready = true;
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], 2);
    expect(rig.view(1)!.badge).toBe('手勢：可以接合');
    expect(rig.view(0)!.badge).toBe('手勢：捏住 Demo');
    expect(rig.last.link).toBeNull();
  });

  it('starts the holds from where each hand is: the first offsets are zero although the part had been dragged, and the drag does not carry over', () => {
    const rig = makePinchRig();
    rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], 6);
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], PINCH_ENGAGE_FRAMES);
    for (let step = 1; step <= 6; step++) rig.run([pinchHand([first[0] + 25 * step, first[1] + 10 * step], 'closed'), pinchHand(second, 'open')], 2);
    const dragged: [number, number] = [first[0] + 150, first[1] + 60];
    rig.run([pinchHand(dragged, 'closed'), pinchHand(second, 'open')], 30);
    const grab = rig.grabs[0]!;
    expect(grab.previews.length).toBeGreaterThan(0);
    expect(grab.previews.at(-1)!.x).toBeGreaterThan(100);
    rig.run([pinchHand(dragged, 'closed'), pinchHand(second, 'closed')], PINCH_ENGAGE_FRAMES);
    const previews = grab.previews.length;
    const session = rig.assembles[0]!;
    expect(session.previews.length).toBeGreaterThan(0);
    for (const preview of session.previews.slice(0, 2)) {
      expect(Math.hypot(preview.owner.x, preview.owner.y)).toBeLessThan(2);
      expect(preview.joiner).toEqual({ x: 0, y: 0 });
    }
    // The first hand moves on: the offset follows it from where it was at the switch, and the grab hears nothing more.
    for (let step = 1; step <= 4; step++) rig.run([pinchHand([dragged[0] + 10 * step, dragged[1]], 'closed'), pinchHand(second, 'closed')], 2);
    rig.run([pinchHand([dragged[0] + 40, dragged[1]], 'closed'), pinchHand(second, 'closed')], 30);
    expect(session.previews.at(-1)!.owner.x).toBeCloseTo(40, -1);
    expect(grab.previews).toHaveLength(previews);
    expect(rig.holds[0]!.previews).toEqual([]);
  });

  it('passes the offsets of both pinches to the assemble; a pinch inside its dead zone offsets nothing', () => {
    const rig = pinchJoining();
    const session = rig.assembles[0]!;
    rig.run([pinchHand(first, 'closed'), pinchHand([second[0] - 4, second[1]], 'closed')], 10);
    expect(session.previews.at(-1)!.joiner).toEqual({ x: 0, y: 0 });
    for (let step = 1; step <= 6; step++) rig.run([pinchHand(first, 'closed'), pinchHand([second[0] - 15 * step, second[1]], 'closed')], 2);
    rig.run([pinchHand(first, 'closed'), pinchHand([second[0] - 90, second[1]], 'closed')], 30);
    expect(session.previews.at(-1)!.joiner.x).toBeCloseTo(-90, -1);
    expect(session.previews.at(-1)!.owner).toEqual({ x: 0, y: 0 });
  });

  it('commits through the assemble when the second pinch opens, counts a join when the snap is ready, and leaves the first pinch inert', () => {
    const rig = pinchJoining();
    rig.assembles[0]!.ready = true;
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], 2);
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], PINCH_RELEASE_FRAMES);
    expect(rig.assembles[0]!.commits).toEqual([true]);
    expect(rig.assembles[0]!.cancels).toBe(0);
    expect(rig.controller.stats).toMatchObject({ commits: 1, cancels: 0, joins: 1 });
    expect(rig.last.gesture).toBe('none');
    expect(rig.view(0)!.state).toBe('locked');
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], 10);
    expect(rig.log).toHaveLength(5);
    expect(rig.assembles[0]!.commits).toEqual([true]);
    // It acts again after it has opened.
    rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], PINCH_RELEASE_FRAMES + 1);
    expect(rig.view(0)!.state).not.toBe('locked');
  });

  it('commits the same way when the first pinch opens, and counts no join without a ready snap', () => {
    const rig = pinchJoining();
    rig.run([pinchHand(first, 'open'), pinchHand(second, 'closed')], PINCH_RELEASE_FRAMES);
    expect(rig.assembles[0]!.commits).toEqual([true]);
    expect(rig.controller.stats).toMatchObject({ commits: 1, joins: 0 });
    expect(rig.holds[0]!.commits).toBe(0);
    expect(rig.holds[0]!.cancels).toBe(0);
    expect(rig.last.gesture).toBe('none');
    expect(rig.view(1)!.state).toBe('locked');
  });

  it('keeps a ready snap latched while a pinch opens: nothing is asked of the scene, and the confirmed release commits the join', () => {
    for (const opener of ['joiner', 'owner'] as const) {
      const rig = pinchJoining();
      const session = rig.assembles[0]!;
      session.ready = true;
      rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], 2);
      const previews = session.previews.length;
      session.ready = false;
      const opening = (at: readonly [number, number], drift: number): HandSample => pinchHand([at[0] + drift, at[1] + drift / 2], 'opening');
      for (let step = 1; step <= 3; step++) {
        rig.run(opener === 'joiner' ? [pinchHand(first, 'closed'), opening(second, 15 * step)] : [opening(first, 15 * step), pinchHand(second, 'closed')], 3);
      }
      expect(session.previews).toHaveLength(previews);
      expect(rig.view(1)!.badge).toBe('手勢：可以接合');
      expect(session.commits).toEqual([]);
      rig.run(opener === 'joiner' ? [pinchHand(first, 'closed'), pinchHand([second[0] + 50, second[1]], 'open')] : [pinchHand([first[0] + 50, first[1]], 'open'), pinchHand(second, 'closed')], PINCH_RELEASE_FRAMES);
      expect(session.commits).toEqual([true]);
      expect(session.previews).toHaveLength(previews);
      expect(rig.controller.stats).toMatchObject({ commits: 1, cancels: 0, joins: 1 });
    }
  });

  it('follows ON_TRACKING_LOSS when either hand is lost (cancel), and never creates a joint', () => {
    for (const lost of ['owner', 'joiner'] as const) {
      const rig = pinchJoining();
      rig.assembles[0]!.ready = true;
      rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], 2);
      rig.run(lost === 'owner' ? [pinchHand(second, 'closed')] : [pinchHand(first, 'closed')], Math.ceil(TRACKING_LOSS_MS / FRAME_MS) + 2);
      expect(rig.assembles[0]!.cancels).toBe(1);
      expect(rig.assembles[0]!.commits).toEqual([]);
      expect(rig.cancelled).toEqual(['loss']);
      expect(rig.controller.stats).toMatchObject({ cancels: 1, joins: 0 });
      expect(rig.last.gesture).toBe('none');
    }
  });

  it('cancels on a gate change away from full control, but not when full control is set again', () => {
    const same = pinchJoining();
    same.controller.setGate(FULL);
    expect(same.assembles[0]!.cancels).toBe(0);
    expect(same.last.gesture).toBe('assemble');
    for (const gate of [EXPLODED, AGENT, OFF]) {
      const rig = pinchJoining();
      rig.controller.setGate(gate);
      expect(rig.assembles[0]!.cancels).toBe(1);
      expect(rig.cancelled).toEqual(['gate']);
      rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], 2);
      expect(rig.view(0)!.state).toBe('locked');
      expect(rig.view(1)!.state).toBe('locked');
      expect(rig.last.gesture).toBe('none');
    }
    const reset = pinchJoining();
    reset.controller.reset();
    expect(reset.assembles[0]!.cancels).toBe(1);
    expect(reset.cancelled).toEqual([]);
  });

  it('cancels both holds and reports external when the scene says the session is no longer valid, and keeps both pinches inert until they open', () => {
    const rig = pinchJoining();
    rig.assembles[0]!.invalid = true;
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], 2);
    expect(rig.assembles[0]!.cancels).toBe(1);
    expect(rig.cancelled).toEqual(['external']);
    expect(rig.view(0)!.state).toBe('locked');
    expect(rig.view(1)!.state).toBe('locked');
    rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], PINCH_RELEASE_FRAMES + 1);
    expect(rig.view(0)!.state).not.toBe('locked');
  });

  it('ends the gesture, with both pinches inert, when the scene refuses the holds after the grab was cancelled', () => {
    for (const refuse of ['refuseHold', 'refuseAssemble'] as const) {
      const rig = makePinchRig();
      rig.state[refuse] = true;
      rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], 6);
      rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], PINCH_ENGAGE_FRAMES);
      rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], PINCH_ENGAGE_FRAMES + 1);
      expect(rig.grabs[0]!.cancels).toBe(1);
      expect(rig.holds.map(hold => hold.cancels)).toEqual(refuse === 'refuseAssemble' ? [1] : []);
      expect(rig.last.gesture).toBe('none');
      expect(rig.view(0)!.state).toBe('locked');
      expect(rig.view(1)!.state).toBe('locked');
      expect(rig.view(1)!.badge).toBe('手勢：另一手操作中');
      expect(rig.controller.stats).toMatchObject({ inert: 1, assembles: 0, cancels: 0 });
      expect(rig.cancelled).toEqual([]);
      rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], PINCH_RELEASE_FRAMES + 1);
      expect(rig.view(0)!.state).not.toBe('locked');
    }
  });

  it('keeps the rotate by circling for a pinch on the same object, on the same assembly and on empty space: the grab is not cancelled and nothing is held', () => {
    const cases: Array<[string, (rig: PinchRig) => void]> = [
      ['the same object', rig => { rig.state.right = part('o1', 'p2', 'Demo'); }],
      ['the same assembly', rig => { rig.state.same = true; }],
      ['empty space', rig => { rig.state.right = EMPTY_TARGET; }],
    ];
    for (const [, setup] of cases) {
      const rig = makePinchRig();
      setup(rig);
      rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], 6);
      rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], PINCH_ENGAGE_FRAMES);
      rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], PINCH_ENGAGE_FRAMES);
      expect(rig.last.gesture).toBe('rotate');
      expect(rig.view(1)!.state).toBe('join');
      expect(rig.log).toEqual(['select o1:p1', 'beginGrab o1:p1']);
      expect(rig.grabs[0]!.cancels).toBe(0);
      expect(rig.controller.stats.twoHand).toEqual({ rotate: 1 });
    }
  });

  it('is inert, as a fist is, when the port has no holds or assembles', () => {
    const rig = makePinchRig();
    const port = (rig.controller as unknown as { port: HandPort }).port;
    port.beginAssemble = undefined;
    rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], 6);
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], PINCH_ENGAGE_FRAMES);
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], PINCH_ENGAGE_FRAMES + 1);
    expect(rig.view(1)!.badge).toBe('手勢：另一手操作中');
    expect(rig.view(0)!.state).toBe('grab');
    expect(rig.grabs[0]!.cancels).toBe(0);
    expect(rig.controller.stats.inert).toBe(1);
  });

  it('leaves a fist that holds an object and then a pinch the explode, with no assemble', () => {
    const rig = makePinchRig();
    rig.run([open(first), pinchHand(second, 'open')], 4);
    rig.run([fist(first), pinchHand(second, 'open')], FIST_ENGAGE_FRAMES);
    rig.run([fist(first), pinchHand(second, 'closed')], PINCH_ENGAGE_FRAMES);
    expect(rig.log.filter(line => line.startsWith('beginAssemble'))).toEqual([]);
    expect(rig.last.gesture).toBe('explode');
    expect(rig.controller.stats.twoHand).toEqual({ explode: 1 });
    expect(rig.grabs).toHaveLength(0);
  });

  // Changed in Task 12: this test used to say that a joining pinch which closes into a fist gives way to the fist and the assemble is
  // dropped. A pinch that took part in a two-hand gesture now keeps being a pinch until it is released.
  it('does not turn the joining pinch into a fist when the hand closes: the pinch ends the normal way (the fist\'s thumb is far from the index finger, so it opens)', () => {
    const rig = pinchJoining();
    rig.run([pinchHand(first, 'closed'), fist(second)], 1);
    // The fist is not looked at while the pinch is part of the gesture: the assemble still runs and no fist holds anything.
    expect(rig.assembles[0]!.cancels).toBe(0);
    expect(rig.last.gesture).toBe('assemble');
    expect(rig.view(1)!.input).toBe('pinch');
    rig.run([pinchHand(first, 'closed'), fist(second)], PINCH_RELEASE_FRAMES);
    // The distance between thumb and index finger of that fist is long, so the pinch is released and the assemble ends with its commit.
    expect(rig.assembles[0]!.commits).toEqual([true]);
    expect(rig.assembles[0]!.cancels).toBe(0);
    expect(rig.cancelled).toEqual([]);
    expect(rig.log.filter(line => line.startsWith('beginHold'))).toEqual(['beginHold o1']);
  });
});

// ---- Task 12: a second-hand pinch with curled fingers on another object -------------------------------------------------------------

/**
 * A pinch with the other three fingers curled, placed by its pinch midpoint. Without `indexRatio` the index finger stays extended
 * (curl ratio about 1.36); with it the index finger bends toward the thumb until that is the hand's curl ratio (chosen by the test, not measured).
 */
function curledPinch(at: readonly [number, number], indexRatio?: number): HandSample {
  const cursor = clientToNormalized({ x: at[0], y: at[1] }, VIEW, VIDEO);
  return handSample(syntheticHand({ cursor, pinchM: PINCH_CLOSED_M, curledFingers: true, indexRatio }), VIEW, VIDEO)!;
}

describe('HandController, the second pinch on another object with curled fingers (Task 12)', () => {
  const LONG = FIST_ENGAGE_FRAMES + 4;

  /** The first hand grabs the part of o1; the second hand pinches the part of o2 with its other fingers curled (curl ratio about 1.36): the two-pinch join. */
  function joiningWithCurledFingers(): PinchRig {
    const rig = makePinchRig();
    rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], 6);
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], PINCH_ENGAGE_FRAMES);
    rig.run([pinchHand(first, 'closed'), curledPinch(second)], PINCH_ENGAGE_FRAMES);
    return rig;
  }

  it('keeps the two-pinch join when the index finger of the second hand bends and its curl ratio stays below FIST_ENGAGE_RATIO, unmoved, for longer than FIST_ENGAGE_MS', () => {
    const rig = joiningWithCurledFingers();
    expect(rig.last.gesture).toBe('assemble');
    expect(rig.assembles).toHaveLength(1);
    rig.run([pinchHand(first, 'closed'), curledPinch(second, 0.95)], LONG);
    expect(rig.controller.stats.hands[1].curl!).toBeLessThan(FIST_ENGAGE_RATIO);
    expect(rig.controller.stats.hands[1].fist).toBe(false);
    // Neither the assemble nor the second pinch was given up, and no fist holds anything.
    expect(rig.last.gesture).toBe('assemble');
    expect(rig.view(1)!.input).toBe('pinch');
    expect(rig.view(1)!.state).toBe('hold');
    expect(rig.assembles[0]!.cancels).toBe(0);
    expect(rig.holds).toHaveLength(1);
    expect(rig.log.filter(line => line.startsWith('beginHold'))).toEqual(['beginHold o1']);
  });

  it('keeps the join while the bent index finger moves the pinch to a ready snap, and releasing the pinch (the real distance) ends the assemble the normal way', () => {
    const rig = joiningWithCurledFingers();
    rig.run([pinchHand(first, 'closed'), curledPinch(second, 0.95)], LONG);
    rig.assembles[0]!.ready = true;
    rig.run([pinchHand(first, 'closed'), curledPinch(second, 0.95)], 2);
    expect(rig.view(1)!.badge).toBe('手勢：可以接合');
    // The thumb opens while the index finger stays bent: the pinch releases, the assemble is committed with its joint.
    const releasing = handSample(syntheticHand({ cursor: clientToNormalized({ x: second[0], y: second[1] }, VIEW, VIDEO), pinchM: PINCH_OPEN_M, curledFingers: true, indexRatio: 0.95 }), VIEW, VIDEO)!;
    rig.run([pinchHand(first, 'closed'), releasing], PINCH_RELEASE_FRAMES + 2);
    expect(rig.assembles[0]!.commits).toEqual([true]);
    expect(rig.assembles[0]!.cancels).toBe(0);
  });
});

// ---- the two-pinch join against the real scene sessions -------------------------------------------------------------------------

describe('HandController, two pinches with the real hold and assemble sessions', () => {
  /** Block A at the origin and block B 30 mm beyond A's +x face; a pinch at the left of the view picks A, a pinch at the right picks B. */
  function sceneRig() {
    let workspace: Workspace = emptyWorkspace();
    workspace = addObject(workspace, fixtureObject('a', boxModel('Block A'), at(0)));
    workspace = addObject(workspace, fixtureObject('b', boxModel('Block B'), at(0.07)));
    const roots = new Map(workspace.objects.map(object => [object.id, root(object.transform.position.x)] as const));
    const stored = (id: string) => workspace.objects.find(object => object.id === id)?.transform ?? null;
    const view = camera();
    const results: AssembleResult[] = [];
    const grabCancels = { count: 0 };
    const hold = (id: string, hit: { x: number; y: number; z: number }) => createHoldSession({
      objectId: id, root: roots.get(id)!, camera: view, viewportHeight: () => VIEWPORT_HEIGHT, stored: { ...stored(id)!.position }, hit,
      onCommit: vi.fn(), onChange: vi.fn(), onEnd: vi.fn(),
    });
    const port: HandPort = {
      pick: point => ({ kind: 'part', objectId: point.x < 500 ? 'a' : 'b', partId: 'body', label: 'body', hit: { x: point.x < 500 ? 0 : 0.07, y: 0, z: 0 }, objectName: point.x < 500 ? 'Block A' : 'Block B' }),
      select: () => {},
      beginGrab: () => ({ preview: () => true, rebase: () => {}, commit: () => {}, cancel: () => { grabCancels.count++; } }),
      beginOrbit: (): OrbitSession | null => null,
      press: () => {},
      beginHold: (id, hit) => hold(id, hit),
      beginAssemble: (owner, id, hit) => createAssembleSession({
        workspace, owner: owner as LiveHold, joiner: hold(id, hit), roots, stored,
        onCue: () => {}, onAssemble: result => { results.push(result); return true; }, onChange: () => {},
      }),
      sameAssembly: () => false,
    };
    const controller = new HandController(port);
    controller.setObjectCount(2);
    let now = 1000;
    let last: OverlayFrame = { hands: [], gesture: 'none', link: null, arc: null };
    const run = (hands: readonly HandSample[], frames = 1) => {
      for (let index = 0; index < frames; index++) {
        now += FRAME_MS;
        last = controller.frame([...hands], now);
      }
      return last;
    };
    return { controller, roots, results, grabCancels, run, view: (slot: HandSlot) => last.hands.find(item => item.slot === slot) };
  }
  type SceneRig = ReturnType<typeof sceneRig>;

  function joined(): SceneRig {
    const rig = sceneRig();
    rig.run([pinchHand(first, 'open'), pinchHand(second, 'open')], 6);
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], PINCH_ENGAGE_FRAMES);
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'closed')], PINCH_ENGAGE_FRAMES);
    return rig;
  }
  /** Block B's pinch moves by `dx` pixels in steps, then settles. One pixel is 2.7 mm of the scene here. */
  function moveSecond(rig: SceneRig, dx: number, settle = 40) {
    const steps = Math.max(1, Math.ceil(Math.abs(dx) / 20));
    for (let step = 1; step <= steps; step++) rig.run([pinchHand(first, 'closed'), pinchHand([second[0] + (dx * step) / steps, second[1]], 'closed')], 2);
    rig.run([pinchHand(first, 'closed'), pinchHand([second[0] + dx, second[1]], 'closed')], settle);
  }

  it('snaps B to A, shows 可以接合 and commits one join when a pinch opens', () => {
    const rig = joined();
    expect(rig.grabCancels.count).toBe(1);
    expect(rig.results).toEqual([]);
    // B stands 30 mm from A's face; about 27 mm of pinch movement brings it to a 3 mm gap, inside the snap distance.
    moveSecond(rig, -10);
    expect(rig.view(1)!.badge).toBe('手勢：可以接合');
    expect(rig.roots.get('b')!.position.x).toBeCloseTo(0.04, 4);
    expect(rig.roots.get('a')!.position.x).toBe(0);
    rig.run([pinchHand(first, 'closed'), pinchHand([second[0] - 10, second[1]], 'open')], PINCH_RELEASE_FRAMES);
    expect(rig.results).toHaveLength(1);
    const result = rig.results[0]!;
    expect(result.kind).toBe('join');
    if (result.kind !== 'join') return;
    expect(result.aId).toBe('a');
    expect(result.aPosition).toBeNull();
    expect(result.bId).toBe('b');
    expect(result.bTransform.position.x).toBeCloseTo(0.04, 4);
    expect(result.a).toEqual(side('a', 'body', '+x'));
    expect(result.b).toEqual(side('b', 'body', '-x'));
    expect(rig.controller.stats).toMatchObject({ commits: 1, cancels: 0, joins: 1 });
  });

  it('keeps the snap through the opening of the pinch: it still commits the join', () => {
    const rig = joined();
    moveSecond(rig, -10);
    expect(rig.view(1)!.badge).toBe('手勢：可以接合');
    // The opening pinch drifts far away from the snap; the controller does not ask the scene while it opens.
    for (let step = 1; step <= 4; step++) rig.run([pinchHand(first, 'closed'), pinchHand([second[0] - 10 + 30 * step, second[1]], 'opening')], 3);
    expect(rig.view(1)!.badge).toBe('手勢：可以接合');
    rig.run([pinchHand(first, 'closed'), pinchHand([second[0] + 120, second[1]], 'open')], PINCH_RELEASE_FRAMES);
    expect(rig.results).toHaveLength(1);
    expect(rig.results[0]!.kind).toBe('join');
  });

  it('commits both moves, with no joint, when the objects are not close enough to snap', () => {
    const rig = joined();
    moveSecond(rig, 40);
    expect(rig.view(1)!.badge).toBe('手勢：捏住 Block B');
    rig.run([pinchHand([first[0] - 20, first[1]], 'closed'), pinchHand([second[0] + 40, second[1]], 'open')], PINCH_RELEASE_FRAMES);
    expect(rig.results).toHaveLength(1);
    const result = rig.results[0]!;
    expect(result.kind).toBe('moves');
    if (result.kind !== 'moves') return;
    expect(result.aPosition).toBeNull();
    expect(result.bPosition!.x).toBeGreaterThan(0.07 + 0.08);
    expect(rig.controller.stats).toMatchObject({ commits: 1, joins: 0 });
  });

  it('commits nothing when neither object moved', () => {
    const rig = joined();
    rig.run([pinchHand(first, 'closed'), pinchHand(second, 'open')], PINCH_RELEASE_FRAMES);
    expect(rig.results).toEqual([]);
    expect(rig.roots.get('a')!.position.x).toBe(0);
    expect(rig.roots.get('b')!.position.x).toBe(0.07);
  });
});
