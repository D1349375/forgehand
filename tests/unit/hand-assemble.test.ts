import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SNAP_SETTLE_MS } from '../../shared/joint-constants';
import { addJoint, addObject, emptyWorkspace, type ObjectTransform, type Workspace } from '../../shared/workspace';
import { DRAG_GAIN, FIST_ENGAGE_MS, FIST_RELEASE_MS, TRACKING_LOSS_MS } from '../../src/hands/constants';
import {
  HandController, type AssemblePreview, type AssembleSession, type GrabSession, type HandPort, type HoldSession, type OrbitSession,
} from '../../src/hands/controller';
import type { Gate } from '../../src/hands/gate';
import { joinGesture } from '../../src/hands/join';
import { handSample } from '../../src/hands/mapping';
import { createStats } from '../../src/hands/stats';
import { badgeText, debugLine } from '../../src/hands/text';
import { EMPTY_TARGET, type HandSample, type HandSlot, type OverlayFrame, type Point, type Target } from '../../src/hands/types';
import { createAssembleSession, createHoldSession, type AssembleResult } from '../../src/scene/hand-sessions';
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
    for (const owner of ['press', 'grab', 'orbit'] as const) expect(joinGesture(owner, { kind: 'fist', target: target('o2') }, FULL, context('o1'))).toBeNull();
  });

  it('is null without a context or without a held object', () => {
    expect(joinGesture('hold', { kind: 'fist', target: target('o2') }, FULL)).toBeNull();
    expect(joinGesture('hold', { kind: 'fist', target: target('o2') }, FULL, context(null))).toBeNull();
  });
});

describe('the assemble badge and debug line', () => {
  const view = { target: EMPTY_TARGET, value: null, objectName: 'Block B' } as const;
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