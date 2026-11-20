import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DRAG_GAIN, ORBIT_DEG_PER_PX } from '../../src/hands/constants';
import { createGrabSession, createOrbitSession, grabStillValid } from '../../src/scene/hand-sessions';

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
});
