import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DRAG_GAIN, ORBIT_DEG_PER_PX } from '../../src/hands/constants';
import { createGrabSession, createHoldSession, createOrbitSession, grabStillValid } from '../../src/scene/hand-sessions';

const VIEWPORT_HEIGHT = 800;

/** root (object, rotated and placed) -> built -> A (rotated part) -> B (the grabbed part) -> C (child of B). */
function tree() {
  const root = new THREE.Group();
  root.position.set(0.3, 0, -0.2);
  root.rotation.set(0, THREE.MathUtils.degToRad(30), 0);
  const built = new THREE.Group();
  const a = new THREE.Object3D();
  a.position.set(0.1, 0, 0);
  a.rotation.set(0, 0, THREE.MathUtils.degToRad(45));
  const b = new THREE.Object3D();
  b.position.set(0.05, 0.02, 0);
  const c = new THREE.Object3D();
  c.position.set(0, 0.04, 0);
  root.add(built);
  built.add(a);
  a.add(b);
  b.add(c);
  root.updateMatrixWorld(true);
  return { root, a, b, c };
}

function camera() {
  const value = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  value.position.set(0, 0, 2);
  value.lookAt(0, 0, 0);
  value.updateMatrixWorld(true);
  return value;
}

const world = (node: THREE.Object3D) => node.getWorldPosition(new THREE.Vector3());

function grab(overrides: { storedPosition?: { x: number; y: number; z: number } } = {}) {
  const nodes = tree();
  const view = camera();
  const hit = world(nodes.b);
  const stored = { position: overrides.storedPosition ?? { x: nodes.b.position.x, y: nodes.b.position.y, z: nodes.b.position.z }, rotation: { x: 0, y: 12.5, z: 0 } };
  const onCommit = vi.fn();
  const onChange = vi.fn();
  const onEnd = vi.fn();
  const session = createGrabSession({
    objectId: 'object-1', node: nodes.b, camera: view, viewportHeight: () => VIEWPORT_HEIGHT,
    stored, hit: { x: hit.x, y: hit.y, z: hit.z }, onCommit, onChange, onEnd,
  });
  return { ...nodes, view, session, stored, hit, onCommit, onChange, onEnd };
}

/** World size of one screen pixel at the grabbed point's depth, times the gain. */
function pixelWorld(hitZ: number) {
  return 2 * (2 - hitZ) * Math.tan(THREE.MathUtils.degToRad(20)) / VIEWPORT_HEIGHT * DRAG_GAIN;
}

describe('grab session', () => {
  it('moves only the grabbed node; its children follow in world space', () => {
    const rig = grab();
    const aBefore = rig.a.position.clone();
    const cLocalBefore = rig.c.position.clone();
    const bWorld = world(rig.b);
    const cWorld = world(rig.c);
    expect(rig.session.preview({ x: 100, y: 0 })).toBe(true);
    const bDelta = world(rig.b).sub(bWorld);
    const cDelta = world(rig.c).sub(cWorld);
    const expected = 100 * pixelWorld(rig.hit.z);
    // The camera looks down -Z, so a rightward offset is a move along world +X, through the rotated object root and the rotated parent.
    expect(bDelta.x).toBeCloseTo(expected, 4);
    expect(bDelta.y).toBeCloseTo(0, 4);
    expect(bDelta.z).toBeCloseTo(0, 4);
    expect(cDelta.distanceTo(bDelta)).toBeLessThan(1e-4);
    expect(rig.a.position.equals(aBefore)).toBe(true);
    expect(rig.c.position.equals(cLocalBefore)).toBe(true);
    expect(rig.b.position.toArray()).not.toEqual([rig.stored.position.x, rig.stored.position.y, rig.stored.position.z]);
    expect(rig.onChange).toHaveBeenCalled();
  });

  it('rebase makes the next offset start from the current preview', () => {
    const rig = grab();
    rig.session.preview({ x: 60, y: -20 });
    const previewed = rig.b.position.clone();
    rig.session.rebase();
    expect(rig.session.preview({ x: 0, y: 0 })).toBe(true);
    expect(rig.b.position.distanceTo(previewed)).toBeLessThan(1e-5);
    rig.session.preview({ x: 40, y: 0 });
    expect(rig.b.position.distanceTo(previewed)).toBeGreaterThan(1e-3);
  });

  it('commits once with the position rounded to 5 decimals and the stored rotation', () => {
    const rig = grab();
    rig.session.preview({ x: 37, y: 11 });
    rig.session.commit();
    expect(rig.onCommit).toHaveBeenCalledTimes(1);
    const [position, rotation, kind] = rig.onCommit.mock.calls[0]!;
    for (const value of [position.x, position.y, position.z]) expect(Number(value.toFixed(5))).toBe(value);
    expect(position).not.toEqual(rig.stored.position);
    expect(rotation).toEqual(rig.stored.rotation);
    expect(kind).toBe('translate');
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
    rig.session.commit();
    expect(rig.onCommit).toHaveBeenCalledTimes(1);
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
  });

  it('a commit at the start position calls nothing', () => {
    const rig = grab();
    rig.session.commit();
    expect(rig.onCommit).not.toHaveBeenCalled();
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
    const moved = grab();
    moved.session.preview({ x: 30, y: 0 });
    moved.session.preview({ x: 0, y: 0 });
    moved.session.commit();
    expect(moved.onCommit).not.toHaveBeenCalled();
  });

  it('cancel puts the stored position back and commits nothing', () => {
    const rig = grab();
    rig.session.preview({ x: 80, y: 30 });
    rig.session.cancel();
    expect(rig.b.position.toArray()).toEqual([rig.stored.position.x, rig.stored.position.y, rig.stored.position.z]);
    expect(rig.onCommit).not.toHaveBeenCalled();
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
    expect(rig.session.preview({ x: 1, y: 1 })).toBe(false);
  });

  it('an invalidated session stops previewing, commits nothing and can be cancelled', () => {
    const rig = grab();
    rig.session.preview({ x: 50, y: 0 });
    rig.session.invalidate();
    expect(rig.session.valid).toBe(false);
    expect(rig.session.preview({ x: 60, y: 0 })).toBe(false);
    rig.session.commit();
    expect(rig.onCommit).not.toHaveBeenCalled();
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
  });

  it('reapply puts the last preview back after the scene reset the node', () => {
    const rig = grab();
    rig.session.preview({ x: 50, y: 0 });
    const previewed = rig.b.position.clone();
    rig.b.position.set(rig.stored.position.x, rig.stored.position.y, rig.stored.position.z);
    rig.session.reapply();
    expect(rig.b.position.distanceTo(previewed)).toBeLessThan(1e-9);
  });
});

describe('grabStillValid', () => {
  const none = { build: [], rebuild: [], move: [], remove: [] };
  it('an empty plan with the same active id is valid', () => {
    expect(grabStillValid(none, 'a', 'a')).toBe(true);
  });
  it('a plan that builds, rebuilds, moves or removes anything is invalid', () => {
    expect(grabStillValid({ ...none, build: ['b'] }, 'a', 'a')).toBe(false);
    expect(grabStillValid({ ...none, rebuild: ['a'] }, 'a', 'a')).toBe(false);
    expect(grabStillValid({ ...none, move: ['b'] }, 'a', 'a')).toBe(false);
    expect(grabStillValid({ ...none, remove: ['b'] }, 'a', 'a')).toBe(false);
  });
  it('another active id is invalid', () => {
    expect(grabStillValid(none, 'b', 'a')).toBe(false);
    expect(grabStillValid(none, null, 'a')).toBe(false);
  });
});

describe('orbit session', () => {
  function orbit() {
    const view = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    view.position.set(0, 0, 5);
    const controls = {
      target: new THREE.Vector3(), minPolarAngle: 0, maxPolarAngle: Math.PI, minAzimuthAngle: -Infinity, maxAzimuthAngle: Infinity,
      minDistance: 2, maxDistance: 20,
      update: vi.fn(),
    };
    const onChange = vi.fn();
    return { view, controls, onChange, session: createOrbitSession({ camera: view, controls, onChange }) };
  }
  it('turns the camera around the target and keeps its distance', () => {
    const rig = orbit();
    rig.session.preview({ x: 100, y: 0 });
    const turn = THREE.MathUtils.degToRad(-100 * ORBIT_DEG_PER_PX);
    expect(rig.view.position.length()).toBeCloseTo(5, 6);
    expect(rig.view.position.x).toBeCloseTo(5 * Math.sin(turn), 6);
    expect(rig.view.position.z).toBeCloseTo(5 * Math.cos(turn), 6);
    expect(rig.controls.update).toHaveBeenCalled();
    expect(rig.onChange).toHaveBeenCalled();
  });
  it('rebase starts the next offsets from the current view, and end leaves it where it is', () => {
    const rig = orbit();
    rig.session.preview({ x: 50, y: 10 });
    const turned = rig.view.position.clone();
    rig.session.rebase();
    rig.session.preview({ x: 0, y: 0 });
    expect(rig.view.position.distanceTo(turned)).toBeLessThan(1e-9);
    rig.session.end();
    expect(rig.view.position.distanceTo(turned)).toBeLessThan(1e-9);
  });

  describe('zoom', () => {
    const direction = (view: THREE.PerspectiveCamera, target = new THREE.Vector3()) => view.position.clone().sub(target).normalize();

    it('scales the distance by the ratio and keeps the viewing direction', () => {
      const rig = orbit();
      rig.session.preview({ x: 80, y: 30 });
      const before = direction(rig.view);
      const distance = rig.view.position.length();
      rig.controls.update.mockClear();
      rig.onChange.mockClear();
      rig.session.zoom!(0.5);
      expect(rig.view.position.length()).toBeCloseTo(distance * 0.5, 6);
      expect(direction(rig.view).distanceTo(before)).toBeLessThan(1e-9);
      expect(rig.controls.update).toHaveBeenCalled();
      expect(rig.onChange).toHaveBeenCalled();
    });

    it('is relative to the distance when the zoom began, not to the last zoom', () => {
      const rig = orbit();
      rig.session.zoom!(0.5);
      rig.session.zoom!(0.8);
      expect(rig.view.position.length()).toBeCloseTo(5 * 0.8, 6);
      rig.session.zoom!(1);
      expect(rig.view.position.length()).toBeCloseTo(5, 6);
    });

    it('works around a non-zero orbit target', () => {
      const rig = orbit();
      rig.controls.target.set(1, 2, -1);
      rig.view.position.set(1, 2, 4);
      const fresh = createOrbitSession({ camera: rig.view, controls: rig.controls, onChange: rig.onChange });
      fresh.zoom!(0.4);
      expect(rig.view.position.clone().sub(rig.controls.target).length()).toBeCloseTo(2, 6);
      expect(rig.view.position.x).toBeCloseTo(1, 6);
      expect(rig.view.position.y).toBeCloseTo(2, 6);
    });

    it('clamps to the distance limits without accumulating the clamp', () => {
      const rig = orbit();
      rig.session.zoom!(0.01);
      expect(rig.view.position.length()).toBeCloseTo(rig.controls.minDistance, 6);
      rig.session.zoom!(100);
      expect(rig.view.position.length()).toBeCloseTo(rig.controls.maxDistance, 6);
      // Coming back to the starting ratio returns to the starting distance, not to a clamped one.
      rig.session.zoom!(1);
      expect(rig.view.position.length()).toBeCloseTo(5, 6);
    });

    it('rebase after a zoom keeps the zoomed distance, and the next turn starts from it', () => {
      const rig = orbit();
      rig.session.zoom!(0.5);
      rig.session.rebase();
      rig.session.preview({ x: 0, y: 0 });
      expect(rig.view.position.length()).toBeCloseTo(2.5, 6);
      rig.session.preview({ x: 60, y: 0 });
      expect(rig.view.position.length()).toBeCloseTo(2.5, 6);
    });

    it('a zoom after a re-base starts from the distance at that time', () => {
      const rig = orbit();
      rig.session.zoom!(0.5);
      rig.session.rebase();
      rig.session.zoom!(0.8);
      expect(rig.view.position.length()).toBeCloseTo(2.5 * 0.8, 6);
    });
  });
});

/** The objects group (identity) -> the object's root (placed and rotated) -> an exploded part -> its child part. */
function objectTree() {
  const objects = new THREE.Group();
  const root = new THREE.Group();
  root.position.set(0.3, 0.1, -0.2);
  root.rotation.set(0, THREE.MathUtils.degToRad(30), 0);
  const part = new THREE.Object3D();
  // An exploded part: its local position already carries the display offset.
  part.position.set(0.4, 0.2, 0);
  const child = new THREE.Object3D();
  child.position.set(0, 0.05, 0);
  objects.add(root);
  root.add(part);
  part.add(child);
  objects.updateMatrixWorld(true);
  return { objects, root, part, child };
}

function hold(overrides: { storedNow?: () => { x: number; y: number; z: number } } = {}) {
  const nodes = objectTree();
  const view = camera();
  const stored = { x: nodes.root.position.x, y: nodes.root.position.y, z: nodes.root.position.z };
  const hit = world(nodes.part);
  const onCommit = vi.fn();
  const onChange = vi.fn();
  const onEnd = vi.fn();
  const session = createHoldSession({
    objectId: 'object-1', root: nodes.root, camera: view, viewportHeight: () => VIEWPORT_HEIGHT,
    stored, hit: { x: hit.x, y: hit.y, z: hit.z }, onCommit, onChange, onEnd, ...overrides,
  });
  return { ...nodes, view, session, stored, hit, onCommit, onChange, onEnd };
}

describe('hold session', () => {
  it('moves only the object root through the camera plane, and the parts follow it without being touched', () => {
    const rig = hold();
    const partLocal = rig.part.position.clone();
    const childLocal = rig.child.position.clone();
    const partWorld = world(rig.part);
    const childWorld = world(rig.child);
    expect(rig.session.preview({ x: 100, y: -50 })).toBe(true);
    const expected = 100 * pixelWorld(rig.hit.z);
    const rootDelta = rig.root.position.clone().sub(new THREE.Vector3(rig.stored.x, rig.stored.y, rig.stored.z));
    // The camera looks down -Z: a rightward offset is +X and an upward one +Y, in the world frame of the objects group.
    expect(rootDelta.x).toBeCloseTo(expected, 4);
    expect(rootDelta.y).toBeCloseTo(50 * pixelWorld(rig.hit.z), 4);
    expect(rootDelta.z).toBeCloseTo(0, 4);
    expect(world(rig.part).sub(partWorld).distanceTo(rootDelta)).toBeLessThan(1e-4);
    expect(world(rig.child).sub(childWorld).distanceTo(rootDelta)).toBeLessThan(1e-4);
    // Part nodes keep their local positions (the exploded display offset), and the root keeps its rotation.
    expect(rig.part.position.equals(partLocal)).toBe(true);
    expect(rig.child.position.equals(childLocal)).toBe(true);
    expect(rig.root.rotation.y).toBeCloseTo(THREE.MathUtils.degToRad(30), 8);
    expect(rig.onChange).toHaveBeenCalled();
  });

  it('rebase makes the next offset start from the current preview', () => {
    const rig = hold();
    rig.session.preview({ x: 60, y: -20 });
    const previewed = rig.root.position.clone();
    rig.session.rebase();
    expect(rig.session.preview({ x: 0, y: 0 })).toBe(true);
    expect(rig.root.position.distanceTo(previewed)).toBeLessThan(1e-5);
    rig.session.preview({ x: 40, y: 0 });
    expect(rig.root.position.distanceTo(previewed)).toBeGreaterThan(1e-3);
  });

  it('commits once with the position rounded to 5 decimals, and ends the session', () => {
    const rig = hold();
    rig.session.preview({ x: 37, y: 11 });
    rig.session.commit();
    expect(rig.onCommit).toHaveBeenCalledTimes(1);
    const [position] = rig.onCommit.mock.calls[0]!;
    for (const value of [position.x, position.y, position.z]) expect(Number(value.toFixed(5))).toBe(value);
    expect(position).not.toEqual(rig.stored);
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
    rig.session.commit();
    expect(rig.onCommit).toHaveBeenCalledTimes(1);
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
  });

  it('a commit at the start position calls nothing', () => {
    const rig = hold();
    rig.session.commit();
    expect(rig.onCommit).not.toHaveBeenCalled();
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
    const moved = hold();
    moved.session.preview({ x: 30, y: 0 });
    moved.session.preview({ x: 0, y: 0 });
    moved.session.commit();
    expect(moved.onCommit).not.toHaveBeenCalled();
  });

  it('cancel puts the root back and commits nothing', () => {
    const rig = hold();
    rig.session.preview({ x: 80, y: 20 });
    rig.session.cancel();
    expect(rig.root.position.toArray()).toEqual([rig.stored.x, rig.stored.y, rig.stored.z]);
    expect(rig.onCommit).not.toHaveBeenCalled();
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
    expect(rig.session.preview({ x: 5, y: 5 })).toBe(false);
    rig.session.cancel();
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
  });

  it('cancel puts the root where the scene stores the object now, when a sync moved it meanwhile', () => {
    const now = { x: 1, y: 2, z: 3 };
    const rig = hold({ storedNow: () => now });
    rig.session.preview({ x: 80, y: 20 });
    rig.session.cancel();
    expect(rig.root.position.toArray()).toEqual([1, 2, 3]);
  });

  it('an invalidated session previews false and commits nothing', () => {
    const rig = hold();
    rig.session.preview({ x: 50, y: 0 });
    rig.session.invalidate();
    expect(rig.session.valid).toBe(false);
    expect(rig.session.preview({ x: 60, y: 0 })).toBe(false);
    rig.session.commit();
    expect(rig.onCommit).not.toHaveBeenCalled();
    expect(rig.onEnd).toHaveBeenCalledTimes(1);
  });

  it('is kept by the same rule as a grab: only activating its own object leaves it valid', () => {
    const none = { build: [], rebuild: [], move: [], remove: [] };
    expect(grabStillValid(none, 'object-1', 'object-1')).toBe(true);
    expect(grabStillValid(none, 'object-2', 'object-1')).toBe(false);
    expect(grabStillValid({ ...none, move: ['object-1'] }, 'object-1', 'object-1')).toBe(false);
  });
});