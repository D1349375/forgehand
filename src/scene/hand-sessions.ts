import * as THREE from 'three';
import { assemblyOf, moveRigid } from '../../shared/assembly';
import { alignTransform, initialSnapState, measurePair, snapCandidates, snapStep, worldFace, type PairMetrics, type SnapState } from '../../shared/contact';
import type { JointSide } from '../../shared/joint';
import { findObject, type ObjectTransform, type Workspace } from '../../shared/workspace';
import { ORBIT_DEG_PER_PX } from '../hands/constants';
import type { AssemblePreview, AssembleSession, GrabSession, HoldSession, OrbitSession } from '../hands/controller';
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

export interface HoldInput {
  objectId: string;
  /** The object's root node: the only node a hold moves, so the explode animation (which moves part nodes) never touches it. */
  root: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  /** Height of the viewport in client pixels. */
  viewportHeight: () => number;
  /** The object's stored position (`transform.position`) when the hold began; a commit only differs from it by the move. */
  stored: Vector;
  /** The stored position now, where a cancel puts the root back: a scene sync may have moved the object since the hold began. Defaults to `stored`. */
  storedNow?: () => Vector;
  /** The world point under the palm centre at engage. */
  hit: Vector;
  gain?: number;
  /**
   * The other roots of the held object's assembly (assembly-joints requirement 87). Each moves by the same offset as the held root, so
   * the assembly shows as one body; a commit still writes only the held object, and `setTransform` moves the rest of the assembly.
   */
  followers?: readonly HoldFollower[];
  /** Called once, and only when the rounded position differs from the stored one. */
  onCommit(position: Vector): void;
  /** The scene needs a new frame. */
  onChange(): void;
  /** The session is over, whichever way. */
  onEnd(): void;
}

/** A root that moves with the held one. `stored` is where the object stands when the hold begins; `storedNow` is where a cancel puts it back. */
export interface HoldFollower {
  root: THREE.Object3D;
  stored: Vector;
  storedNow?: () => Vector;
}

/** A hold the scene can also invalidate from `sync`. */
export interface LiveHold extends HoldSession {
  readonly objectId: string;
  readonly valid: boolean;
  /** The held object's previewed position, rounded as a commit would write it. */
  readonly position: Vector;
  /** The scene changed under the session: the next `preview` returns false and a commit does nothing. */
  invalidate(): void;
  /** Ends the session without committing and without putting anything back: the caller commits the final pose itself (an assemble). */
  release(): void;
}

/**
 * Moves a whole object through the camera plane (design §7.4, requirement 92): the palm offset since the last re-base, times
 * `gain`, becomes a world offset at the held point's depth, as for a part, with the objects group as the parent frame. Only the
 * object's root moves; its parts follow, and the workspace changes only on `commit`.
 */
export function createHoldSession(input: HoldInput): LiveHold {
  const { root, camera, stored } = input;
  const storedRounded = rounded(stored);
  let start: Vector = { ...stored };
  let current: Vector = { ...stored };
  let hit: Vector = { ...input.hit };
  let valid = true;
  let done = false;
  const followers = input.followers ?? [];
  const parentWorld = (): THREE.Matrix4 => {
    root.parent?.updateWorldMatrix(true, false);
    return root.parent ? root.parent.matrixWorld : new THREE.Matrix4();
  };
  /** Shows the held root at `position`; the followers move by the same offset from their own stored positions, or go back to where they stand (`back`). */
  const show = (position: Vector, back = false) => {
    root.position.set(position.x, position.y, position.z);
    root.updateMatrixWorld(true);
    for (const follower of followers) {
      const at = back
        ? (follower.storedNow?.() ?? follower.stored)
        : { x: follower.stored.x + (position.x - stored.x), y: follower.stored.y + (position.y - stored.y), z: follower.stored.z + (position.z - stored.z) };
      follower.root.position.set(at.x, at.y, at.z);
      follower.root.updateMatrixWorld(true);
    }
    input.onChange();
  };
  const finish = () => {
    done = true;
    input.onEnd();
  };
  return {
    objectId: input.objectId,
    get valid() { return valid; },
    get position() { return rounded(current); },
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
    release() {
      if (!done) finish();
    },
    rebase() {
      if (done) return;
      // The held point moved with the object, so the depth of the next offsets follows it.
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
        if (valid && !same(position, storedRounded)) input.onCommit(position);
      } finally {
        finish();
      }
    },
    cancel() {
      if (done) return;
      show(input.storedNow?.() ?? stored, true);
      finish();
    },
    invalidate() {
      valid = false;
    },
  };
}

/** The result of a two-fist assemble, for the app to commit as one undo step (positions are null for an object that did not move). */
export type AssembleResult =
  | { kind: 'join'; aId: string; aPosition: Vector | null; bId: string; bTransform: ObjectTransform; a: JointSide; b: JointSide }
  | { kind: 'moves'; aId: string; aPosition: Vector | null; bId: string; bPosition: Vector | null };

/** What the viewport draws while a snap is ready: the two glowing faces and the 可以接合 label at side a's face. */
export interface AssembleCue { a: JointSide; b: JointSide; label: Vector }

export interface AssembleInput {
  /** Model data, stored transforms and joints as they were when the gesture began. */
  workspace: Workspace;
  /** Side a: the first fist's hold. It moves the assembly of its object. */
  owner: LiveHold;
  /** Side b: the second fist's hold of an object that is not in side a's assembly. */
  joiner: LiveHold;
  /** The scene root of every object of both assemblies. */
  roots: ReadonlyMap<string, THREE.Object3D>;
  /** The transform an object has in the workspace now, where a cancel puts its root back. */
  stored(objectId: string): ObjectTransform | null;
  /** The cue changed: the snapped pair, or null when the snap is not ready. */
  onCue(cue: AssembleCue | null): void;
  /** Called once on release: whether the app applied the result. When it did not, every root goes back to its stored transform. */
  onAssemble(result: AssembleResult): boolean;
  /** The scene needs a new frame. */
  onChange(): void;
}

function setPose(root: THREE.Object3D, transform: ObjectTransform): void {
  root.position.set(transform.position.x, transform.position.y, transform.position.z);
  root.rotation.set(
    THREE.MathUtils.degToRad(transform.rotation.x), THREE.MathUtils.degToRad(transform.rotation.y), THREE.MathUtils.degToRad(transform.rotation.z), 'XYZ');
  root.updateMatrixWorld(true);
}

const samePosition = (p: Vector, q: Vector) => p.x === q.x && p.y === q.y && p.z === q.z;

/**
 * Two holds and the snap between them (assembly-joints design 10.3, requirements 58 to 62). Each frame both holds preview their palm
 * offsets (each moves its whole assembly), then the previewed poses of the two objects go through `snapCandidates` and `measurePair`
 * and `snapStep`. While the snap is ready, side b's assembly is shown at the aligned pose instead of the hand pose; the hands keep
 * moving and the snap is released when they leave it (the hysteresis of `snapStep`). On release a ready snap becomes one `join`
 * result; otherwise the moves are committed, or nothing when neither object moved. Neither hold ever commits by itself.
 */
export function createAssembleSession(input: AssembleInput): AssembleSession {
  const { workspace, owner, joiner } = input;
  const ownerId = owner.objectId;
  const joinerId = joiner.objectId;
  const ownerMembers = assemblyOf(workspace, ownerId);
  const joinerMembers = assemblyOf(workspace, joinerId);
  let snap: SnapState = initialSnapState;
  let keySides: { a: JointSide; b: JointSide } | null = null;
  /** The aligned pose of side b's assembly, and the pair, while the snap is shown. */
  let shown: { a: JointSide; b: JointSide; transforms: Map<string, ObjectTransform> } | null = null;
  let done = false;

  /** Every object of both assemblies at its hand pose: the hold position, the stored rotation (what a commit without a join writes). */
  function handPoses(): Map<string, ObjectTransform> | null {
    const a = findObject(workspace, ownerId);
    const b = findObject(workspace, joinerId);
    if (!a || !b) return null;
    const movedA = moveRigid(workspace, ownerMembers, ownerId, { position: owner.position, rotation: a.transform.rotation });
    const movedB = moveRigid(workspace, joinerMembers, joinerId, { position: joiner.position, rotation: b.transform.rotation });
    return movedA && movedB ? new Map([...movedA, ...movedB]) : null;
  }
  const withPoses = (poses: ReadonlyMap<string, ObjectTransform>): Workspace => ({
    ...workspace, objects: workspace.objects.map(object => { const pose = poses.get(object.id); return pose ? { ...object, transform: pose } : object; }),
  });
  const place = (id: string, transform: ObjectTransform | null | undefined) => {
    const root = input.roots.get(id);
    if (root && transform) setPose(root, transform);
  };
  const restoreStored = () => {
    for (const id of [...ownerMembers, ...joinerMembers]) place(id, input.stored(id));
    input.onChange();
  };

  return {
    preview(ownerOffset, joinerOffset, now): AssemblePreview | null {
      if (done) return null;
      if (!owner.preview(ownerOffset) || !joiner.preview(joinerOffset)) return null;
      const started = performance.now();
      const poses = handPoses();
      const best = poses ? snapCandidates(workspace, ownerId, joinerId, poses) : null;
      const held = poses && snap.key !== null && keySides ? measurePair(workspace, keySides.a, keySides.b, poses) : null;
      snap = snapStep(snap, best, held, now);
      if (snap.key === null) keySides = null;
      else if (best && best.key === snap.key) keySides = { a: best.a, b: best.b };
      const metrics: PairMetrics | null = snap.key === null ? null : best && best.key === snap.key ? best : held;

      // Where side b's assembly stands while the snap is ready: the alignment of the pair, applied to the whole assembly.
      let aligned: Map<string, ObjectTransform> | null = null;
      if (poses && snap.ready && keySides) {
        const target = alignTransform(workspace, keySides.a, keySides.b, poses);
        aligned = target ? moveRigid(withPoses(poses), joinerMembers, joinerId, target) : null;
      }
      if (poses && aligned && keySides) {
        for (const [id, transform] of aligned) place(id, transform);
        shown = { a: keySides.a, b: keySides.b, transforms: aligned };
        const objectA = findObject(workspace, keySides.a.objectId);
        const partA = objectA?.model.parts.find(part => part.id === keySides!.a.partId);
        const face = objectA && partA ? worldFace(objectA, partA, keySides.a.face, poses.get(ownerId)) : null;
        const label = face ? { x: face.centre.x, y: face.centre.y, z: face.centre.z } : { x: 0, y: 0, z: 0 };
        input.onCue({ a: keySides.a, b: keySides.b, label });
      } else if (shown) {
        // The snap let go: side b's assembly goes back to the hand pose (the hold put the positions back, not the rotations).
        if (poses) for (const id of joinerMembers) place(id, poses.get(id));
        shown = null;
        input.onCue(null);
      }
      input.onChange();
      return {
        ready: shown !== null,
        metrics: metrics ? { gapMm: metrics.gapMm, angleDeg: metrics.angleDeg, overlapMm2: metrics.overlapMm2 } : null,
        detectMs: performance.now() - started,
      };
    },

    commit(allowJoin) {
      if (done) return;
      done = true;
      const valid = owner.valid && joiner.valid;
      const aStored = findObject(workspace, ownerId)?.transform.position;
      const bStored = findObject(workspace, joinerId)?.transform.position;
      let result: AssembleResult | null = null;
      if (valid && aStored && bStored) {
        const aPosition = samePosition(owner.position, aStored) ? null : owner.position;
        const bPosition = samePosition(joiner.position, bStored) ? null : joiner.position;
        const bTransform = shown?.transforms.get(joinerId);
        if (allowJoin && shown && bTransform) result = { kind: 'join', aId: ownerId, aPosition, bId: joinerId, bTransform, a: shown.a, b: shown.b };
        else if (aPosition || bPosition) result = { kind: 'moves', aId: ownerId, aPosition, bId: joinerId, bPosition };
      }
      if (!result) {
        owner.cancel();
        joiner.cancel();
        shown = null;
        input.onCue(null);
        restoreStored();
        return;
      }
      owner.release();
      joiner.release();
      input.onCue(null);
      if (result.kind === 'moves' && shown) {
        // Not joining: side b's assembly stands at the hand pose, with its stored rotation, when the app applies the moves.
        const poses = handPoses();
        if (poses) for (const id of joinerMembers) place(id, poses.get(id));
      }
      shown = null;
      if (!input.onAssemble(result)) restoreStored();
      else input.onChange();
    },

    cancel() {
      if (done) return;
      done = true;
      owner.cancel();
      joiner.cancel();
      shown = null;
      input.onCue(null);
      restoreStored();
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
