import * as THREE from 'three';
import { ORBIT_DEG_PER_PX } from '../hands/constants';
import type { GrabSession, OrbitSession } from '../hands/controller';
import { dragPosition, orbitOffset } from '../hands/drag';
import type { Vector } from '../hands/types';
import type { SceneSyncPlan } from './scene-sync';

/**
 * Whether a running grab survives a scene sync (requirement 39): nothing is built, rebuilt, moved or
 * removed, and the active object is the grabbed part's own object. Activating that object (a grab on
 * an inactive object does this) changes only the active id, to the session's own object.
 */
export function grabStillValid(plan: Pick<SceneSyncPlan, 'build' | 'rebuild' | 'move' | 'remove'>, nextActiveId: string | null, objectId: string): boolean {
  return plan.build.length === 0 && plan.rebuild.length === 0 && plan.move.length === 0 && plan.remove.length === 0 && nextActiveId === objectId;
}

export interface GrabInput {
  objectId: string;
  /** The grabbed part's scene node. */
  node: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  /** Height of the viewport in client pixels. */
  viewportHeight: () => number;
  /** The part as the model stores it; a move commits this rotation unchanged. Rotation is in degrees. */
  stored: { position: Vector; rotation: Vector };
  /** The world point under the cursor at engage. */
  hit: Vector;
  gain?: number;
  /** Called once, and only when the rounded position differs from the stored one. */
  onCommit(position: Vector, rotation: Vector, kind: 'translate' | 'rotate'): void;
  /** The scene needs a new frame. */
  onChange(): void;
  /** The session is over, whichever way. */
  onEnd(): void;
}

/** A grab the scene can also re-apply or invalidate from `sync`. */
export interface LiveGrab extends GrabSession {
  readonly objectId: string;
  readonly valid: boolean;
  /** Puts the last preview back after the scene reset the node (activation, explode base). */
  reapply(): void;
  /** The scene changed under the session: the next `preview` returns false and a commit does nothing. */
  invalidate(): void;
}

const round5 = (value: number) => Number(value.toFixed(5));
const rounded = (v: Vector): Vector => ({ x: round5(v.x), y: round5(v.y), z: round5(v.z) });
const same = (a: Vector, b: Vector) => a.x === b.x && a.y === b.y && a.z === b.z;

/** Moves one part node through the camera plane (design §7.2). Only this node moves; its children follow in world space. */
export function createGrabSession(input: GrabInput): LiveGrab {
  const { node, camera, stored } = input;
  const storedRounded = rounded(stored.position);
  let start: Vector = { ...stored.position };
  let current: Vector = { ...stored.position };
  let hit: Vector = { ...input.hit };
  let valid = true;
  let done = false;

  const parentWorld = (): THREE.Matrix4 => {
    node.parent?.updateWorldMatrix(true, false);
    return node.parent ? node.parent.matrixWorld : new THREE.Matrix4();
  };
  const show = (position: Vector) => {
    node.position.set(position.x, position.y, position.z);
    node.updateMatrixWorld(true);
    input.onChange();
  };
  const finish = () => {
    done = true;
    input.onEnd();
  };

  return {
    objectId: input.objectId,
    get valid() { return valid; },
    preview(offset) {
      if (done || !valid) return false;
      camera.updateMatrixWorld();
      current = dragPosition({
        camera: { matrixWorld: camera.matrixWorld, fovDeg: camera.fov }, viewportHeight: input.viewportHeight(),
        parentWorld: parentWorld(), start, hit, offset, gain: input.gain,
      });
      show(current);
      return true;
    },
    rebase() {
      if (done) return;
      // The grabbed point moved with the part, so the depth of the next offsets follows it.
      const world = parentWorld();
      const before = new THREE.Vector3(start.x, start.y, start.z).applyMatrix4(world);
      const after = new THREE.Vector3(current.x, current.y, current.z).applyMatrix4(world);
      hit = { x: hit.x + after.x - before.x, y: hit.y + after.y - before.y, z: hit.z + after.z - before.z };
      start = { ...current };
    },
    commit() {
      if (done) return;
      const position = rounded(current);
      try {
        if (valid && !same(position, storedRounded)) input.onCommit(position, { ...stored.rotation }, 'translate');
      } finally {
        finish();
      }
    },
    cancel() {
      if (done) return;
      show(stored.position);
      finish();
    },
    reapply() {
      if (!done && valid) show(current);
    },
    invalidate() {
      valid = false;
    },
  };
}

export interface OrbitInput {
  camera: THREE.PerspectiveCamera;
  controls: {
    target: THREE.Vector3;
    minPolarAngle: number; maxPolarAngle: number; minAzimuthAngle: number; maxAzimuthAngle: number;
    minDistance: number; maxDistance: number;
    update(): unknown;
  };
  /** The scene needs a new frame. */
  onChange(): void;
}

/**
 * Turns the view around the orbit target (design §7.3): the camera keeps its distance while it turns.
 * `zoom` changes only the distance, from where it was when the zoom began (the first `zoom` call after
 * the session started or was re-based), so the ratio is always relative to that distance and a limit
 * that clamps the view does not accumulate.
 */
export function createOrbitSession(input: OrbitInput): OrbitSession {
  const { camera, controls } = input;
  const offsetNow = () => camera.position.clone().sub(controls.target);
  let start = offsetNow();
  let zoomFrom: number | null = null;
  return {
    zoom(ratio) {
      const offset = offsetNow();
      zoomFrom ??= offset.length();
      offset.setLength(THREE.MathUtils.clamp(zoomFrom * ratio, controls.minDistance, controls.maxDistance));
      camera.position.copy(controls.target).add(offset);
      camera.lookAt(controls.target);
      controls.update();
      input.onChange();
    },
    preview(offset) {
      const next = orbitOffset(start, offset, ORBIT_DEG_PER_PX, {
        minPolar: controls.minPolarAngle, maxPolar: controls.maxPolarAngle, minAzimuth: controls.minAzimuthAngle, maxAzimuth: controls.maxAzimuthAngle,
      });
      camera.position.copy(controls.target).add(next);
      camera.lookAt(controls.target);
      controls.update();
      input.onChange();
    },
    rebase() {
      // The next offsets turn the view from where it is now, at the zoomed distance; a later zoom starts from there.
      start = offsetNow();
      zoomFrom = null;
    },
    end() { /* the view stays where it is (requirement 38) */ },
  };
}
