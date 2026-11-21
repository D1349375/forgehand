import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { localFace } from '../../shared/contact';
import type { FaceId, Joint } from '../../shared/joint';
import type { ModelSpec } from '../../shared/model';
import type { ObjectTransform } from '../../shared/workspace';
import type { ArmSample } from '../try-on/arm-pose';
import { createArmPreview } from './arm-preview';
import { computeExplosion, groupProgress, worldMatrices } from './explode';
import type { GrabSession, HoldSession, OrbitSession } from '../hands/controller';
import type { Point } from '../hands/types';
import { buildModel, disposeObject, modelBounds, objectsBounds } from './geometry';
import { createGrabSession, createHoldSession, createOrbitSession, grabStillValid, type LiveGrab, type LiveHold } from './hand-sessions';
import { buildPartMarks, markId, markKey, type PartMarks } from './joint-marks';
import { planSceneSync, type SceneSyncPlan } from './scene-sync';
import { applyPartStyle, hologramPart } from './style';

export type TransformMode = 'translate' | 'rotate' | null;
export interface Vector { x: number; y: number; z: number }
export interface SceneObjectInput { id: string; model: ModelSpec; transform: ObjectTransform }
export interface SceneHandle {
  reset(): void; zoomIn(): void; zoomOut(): void;
  /** Viewport client coordinates of a part's centre (used by tests and tooling); `objectId` defaults to the active object. */
  projectPart(id: string, objectId?: string): { x: number; y: number } | null;
  /** Viewport client coordinates of the centre of a part's contact face (used by tests and tooling), or null for an unknown part or a face that is not a contact face. */
  projectFace(objectId: string, partId: string, face: FaceId): { x: number; y: number } | null;
  /** The nearest part under a client point, or null (also for a point outside the viewport). Used by hand control for hover and grabbing. */
  hitTest(point: Point): { objectId: string; partId: string; name: string; objectName: string; hit: Vector } | null;
  /** Starts moving a part by hand; null while the exploded view is shown, the mouse or the gizmo is busy, or the part is unknown. */
  beginPartGrab(objectId: string, partId: string, hit: Vector): GrabSession | null;
  /** Starts turning the view by hand; null while the mouse or the gizmo is busy, or with no objects. */
  beginOrbit(): OrbitSession | null;
  /**
   * Starts moving a whole object by hand (a fist); null for an unknown object, while the mouse or the gizmo is busy. It is not refused in
   * the exploded view (only the object's root moves) and not because another hold runs.
   */
  beginObjectHold(objectId: string, hit: Vector): HoldSession | null;
}
interface Props {
  objects: readonly SceneObjectInput[];
  activeObjectId: string | null;
  /** Selected parts of the active object. */
  selectedIds?: readonly string[];
  transformMode?: TransformMode;
  /** Exploded-view amount 0 (assembled) … 1 (fully exploded) of the active object; display only, animated toward this value. */
  explode?: number;
  tryOn?: { readonly current: ArmSample | null };
  onPick?: (objectId: string | null, partId: string | null, additive: boolean) => void;
  onTransform?: (objectId: string, partId: string, position: Vector, rotation: Vector, kind: 'translate' | 'rotate') => void;
  /** A hand hold moved a whole object: called once on release with the new position (the 物件 panel's path, one undo step). */
  onObjectMove?: (objectId: string, position: Vector) => void;
  onError?: (message: string) => void;
  onReady?: (info: { objects: number; parts: number; renderMs: number }) => void;
  /** The workspace's joints; only written to data attributes here (the drawings come from `marks`). */
  joints?: readonly Joint[];
  /** One entry per joint side: outline, features and state, attached to the part's scene node. */
  marks?: readonly PartMarks[];
  /** 顯示接合: false hides every joint drawing. */
  showJoints?: boolean;
  /** A mouse or hand join in progress: objects shown at these poses (stored transforms untouched), glowing faces, and the 可以接合 cue. */
  joinPreview?: JoinPreview | null;
  /** The printable solid of one part, in millimetres. The viewport owns the geometry from now on and disposes it when it is replaced or cleared. */
  printPreview?: PrintPreview | null;
}
export interface JoinPreview {
  transforms: ReadonlyArray<{ objectId: string; transform: ObjectTransform }>;
  glow: readonly PartMarks[];
  /** World position of the 可以接合 label, or null for none. */
  label: Vector | null;
  ready: boolean;
}
export interface PrintPreview { objectId: string; partId: string; geometry: THREE.BufferGeometry }
/** A joint drawing attached to a part node. */
interface MarkNode { key: string; parent: THREE.Object3D; group: THREE.Group }
/** Per-part exploded-view motion in the part's parent frame, rebuilt with each model. */
interface ExplosionNode { node: THREE.Object3D; base: THREE.Vector3; offset: THREE.Vector3; depth: number }
/** One object in the scene: `root` carries the object transform, `built` is the model's geometry inside it. */
interface Entry {
  id: string;
  root: THREE.Group;
  built: THREE.Group;
  model: ModelSpec;
  transform: ObjectTransform;
  parts: Map<string, THREE.Object3D>;
  /** Computed when the object first becomes active (or is built as the active one). */
  explosion: ExplosionNode[] | null;
  explosionDepth: number;
}
interface View {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  gizmo: TransformControls;
  renderer: THREE.WebGLRenderer;
  /** Container of every object root; the scene's lights and gizmo stay outside it. */
  objects: THREE.Group;
  entries: Map<string, Entry>;
  /** Every part surface mesh of every object, rebuilt in sync; the click handler and hitTest raycast against it. */
  surfaces: THREE.Object3D[];
  raycaster: THREE.Raycaster;
  /** A mouse orbit or zoom is in progress (OrbitControls start and end). */
  mouseBusy: boolean;
  /** The running hand grab, if any. */
  grab: LiveGrab | null;
  /** The running hand holds (whole objects), at most one per hand. */
  holds: Set<LiveHold>;
  activeId: string | null;
  /** True once the user rotates or zooms after the last automatic framing. */
  viewChanged: boolean;
  /** Amount currently shown on the active object; eases toward the `explode` prop. */
  explodeShown: number;
  /** Joint drawings and join-preview glows by mark id, with the part node each is attached to. */
  markNodes: Map<string, MarkNode>;
  /** Objects whose root is shown at a previewed pose. */
  previewed: Set<string>;
  /** The 可以接合 sprite, while shown. */
  cue: THREE.Sprite | null;
  /** The printable mesh of the print preview and the surface it hides. */
  printed: { objectId: string; partId: string; group: THREE.Group; hidden: THREE.Object3D | null } | null;
  reset: () => void;
  invalidate: () => void;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

function partTransforms(model: THREE.Object3D): Map<string, THREE.Object3D> {
  const transforms = new Map<string, THREE.Object3D>();
  model.traverse(object => { if (typeof object.userData.partId === 'string') transforms.set(object.userData.partId, object); });
  return transforms;
}

function placeRoot(root: THREE.Group, transform: ObjectTransform) {
  root.position.set(transform.position.x, transform.position.y, transform.position.z);
  root.rotation.set(THREE.MathUtils.degToRad(transform.rotation.x), THREE.MathUtils.degToRad(transform.rotation.y), THREE.MathUtils.degToRad(transform.rotation.z), 'XYZ');
  root.updateMatrixWorld(true);
}

/** Builds one object; the geometry is disposed here if anything fails. */
function createEntry(input: SceneObjectInput): Entry {
  const built = buildModel(input.model, hologramPart);
  const root = new THREE.Group();
  root.name = input.model.name;
  root.userData.objectId = input.id;
  root.add(built);
  placeRoot(root, input.transform);
  try { modelBounds(root); }
  catch (error) { disposeObject(root); throw error; }
  return { id: input.id, root, built, model: input.model, transform: input.transform, parts: partTransforms(built), explosion: null, explosionDepth: 0 };
}

function ensureExplosion(entry: Entry) {
  if (entry.explosion) return;
  const plan = computeExplosion(entry.model);
  const matrices = worldMatrices(entry.model);
  const parents = new Map(entry.model.parts.map(part => [part.id, part.parentId]));
  entry.explosion = [...plan.moves].flatMap(([id, move]) => {
    const node = entry.parts.get(id);
    if (!node) return [];
    // Offsets are world vectors of the model frame; a child node moves in its parent's (rotated) frame.
    const parentId = parents.get(id);
    const parentRotation = parentId ? new THREE.Quaternion().setFromRotationMatrix(matrices.get(parentId)!) : new THREE.Quaternion();
    return [{ node, base: node.position.clone(), offset: move.offset.clone().applyQuaternion(parentRotation.invert()), depth: move.depth }];
  });
  entry.explosionDepth = plan.maxDepth;
}

/** Places every part of one object at an exploded-view amount (outer groups first). */
function applyExplosion(entry: Entry, amount: number) {
  for (const item of entry.explosion ?? []) {
    item.node.position.copy(item.base).addScaledVector(item.offset, groupProgress(amount, item.depth, entry.explosionDepth));
  }
}

/** The object a scene node belongs to. */
function objectIdOf(node: THREE.Object3D | null): string | null {
  while (node && typeof node.userData.objectId !== 'string') node = node.parent;
  return node ? node.userData.objectId : null;
}

function collectSurfaces(entries: Iterable<Entry>): THREE.Object3D[] {
  const surfaces: THREE.Object3D[] = [];
  for (const entry of entries) {
    entry.root.traverse(object => { if (object instanceof THREE.Mesh && object.name.endsWith(':surface')) surfaces.push(object); });
  }
  return surfaces;
}

interface SurfaceHit { objectId: string; partId: string; point: THREE.Vector3 }

/** Every (object, part) pair under a client point, nearest first, each pair once. The click handler and hitTest share it. */
function hitsAt(current: View, point: Point): SurfaceHit[] {
  const rect = current.renderer.domElement.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return [];
  current.camera.updateMatrixWorld();
  current.raycaster.setFromCamera(new THREE.Vector2((point.x - rect.left) / rect.width * 2 - 1, -(point.y - rect.top) / rect.height * 2 + 1), current.camera);
  const hits: SurfaceHit[] = [];
  const seen = new Set<string>();
  for (const hit of current.raycaster.intersectObjects(current.surfaces, false)) {
    let node: THREE.Object3D | null = hit.object;
    while (node && typeof node.userData.partId !== 'string') node = node.parent;
    const objectId = objectIdOf(node);
    if (!node || !objectId) continue;
    const key = JSON.stringify([objectId, node.userData.partId]);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ objectId, partId: node.userData.partId, point: hit.point.clone() });
  }
  return hits;
}

/** The 可以接合 cue of a join preview: a text sprite that is always drawn on top. */
function createCue(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = 'rgba(8, 21, 32, 0.88)';
    context.fillRect(4, 4, 504, 120);
    context.strokeStyle = '#e6c2ff';
    context.lineWidth = 6;
    context.strokeRect(4, 4, 504, 120);
    context.fillStyle = '#f2dcff';
    context.font = 'bold 68px "Microsoft JhengHei", "Noto Sans TC", "PingFang TC", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('可以接合', 256, 68);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  sprite.name = 'join-cue';
  sprite.renderOrder = 10;
  sprite.raycast = () => {};
  return sprite;
}

function disposeCue(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
  sprite.removeFromParent();
}

const NO_CHANGES: Pick<SceneSyncPlan, 'build' | 'rebuild' | 'move' | 'remove'> = { build: [], rebuild: [], move: [], remove: [] };

export const SceneViewport = forwardRef<SceneHandle, Props>(function SceneViewport(props, ref) {
  const { objects, activeObjectId, selectedIds = [], transformMode = null, explode = 0 } = props;
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<View | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const selection = useRef({ selectedIds, transformMode });
  selection.current = { selectedIds, transformMode };
  const explodeTarget = useRef(explode);
  explodeTarget.current = THREE.MathUtils.clamp(explode, 0, 1);

  useImperativeHandle(ref, () => ({
    reset: () => view.current?.reset(),
    zoomIn: () => zoom(0.8),
    zoomOut: () => zoom(1.25),
    projectPart(id, objectId) {
      const current = view.current;
      const target = current?.entries.get(objectId ?? current.activeId ?? '')?.parts.get(id);
      if (!current || !target) return null;
      const surface = target.children.find(child => typeof child.userData.partId !== 'string');
      // Exploded-view moves update node positions between frames; refresh before measuring.
      (surface ?? target).updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(surface ?? target);
      const point = box.getCenter(new THREE.Vector3()).project(current.camera);
      const rect = current.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + (point.x + 1) / 2 * rect.width, y: rect.top + (1 - point.y) / 2 * rect.height };
    },
    projectFace(objectId, partId, face) {
      const current = view.current;
      const entry = current?.entries.get(objectId);
      const node = entry?.parts.get(partId);
      const part = entry?.model.parts.find(candidate => candidate.id === partId);
      const local = part ? localFace(part, face) : null;
      if (!current || !node || !local) return null;
      node.updateWorldMatrix(true, false);
      const point = node.localToWorld(local.centre.clone()).project(current.camera);
      const rect = current.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + (point.x + 1) / 2 * rect.width, y: rect.top + (1 - point.y) / 2 * rect.height };
    },
    hitTest(point) {
      const current = view.current;
      if (!current) return null;
      const rect = current.renderer.domElement.getBoundingClientRect();
      if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return null;
      const hit = hitsAt(current, point)[0];
      const entry = hit ? current.entries.get(hit.objectId) : undefined;
      const part = entry?.model.parts.find(candidate => candidate.id === hit?.partId);
      if (!hit || !entry || !part) return null;
      return { objectId: hit.objectId, partId: hit.partId, name: part.name, objectName: entry.model.name, hit: { x: hit.point.x, y: hit.point.y, z: hit.point.z } };
    },
    beginPartGrab(objectId, partId, hit) {
      const current = view.current;
      const entry = current?.entries.get(objectId);
      const node = entry?.parts.get(partId);
      const part = entry?.model.parts.find(candidate => candidate.id === partId);
      if (!current || !entry || !node || !part) return null;
      // A part shown at an exploded offset would write the display offset into the data; the mouse and the gizmo own the view while they drag.
      if (current.mouseBusy || current.gizmo.dragging || explodeTarget.current > 0 || current.explodeShown > 0) return null;
      current.grab?.cancel();
      // Explosion bases are captured from the node positions: do it before the preview moves this node.
      ensureExplosion(entry);
      current.gizmo.enabled = false;
      const session: LiveGrab = createGrabSession({
        objectId, node, camera: current.camera,
        viewportHeight: () => current.renderer.domElement.getBoundingClientRect().height,
        stored: { position: { ...part.position }, rotation: { ...part.rotation } },
        hit,
        onCommit: (position, rotation, kind) => callbacks.current.onTransform?.(objectId, partId, position, rotation, kind),
        onChange: current.invalidate,
        onEnd: () => {
          if (current.grab === session) current.grab = null;
          current.gizmo.enabled = true;
        },
      });
      current.grab = session;
      return session;
    },
    beginOrbit() {
      const current = view.current;
      if (!current || current.mouseBusy || current.gizmo.dragging || current.entries.size === 0) return null;
      current.viewChanged = true;
      return createOrbitSession({ camera: current.camera, controls: current.controls, onChange: current.invalidate });
    },
    beginObjectHold(objectId, hit) {
      const current = view.current;
      const entry = current?.entries.get(objectId);
      if (!current || !entry) return null;
      // Unlike a part grab, a hold is allowed in the exploded view: it moves only the object's root, which the explode animation never
      // touches. Another hold may run too (a second hand can hold a second object).
      if (current.mouseBusy || current.gizmo.dragging) return null;
      current.gizmo.enabled = false;
      const session: LiveHold = createHoldSession({
        objectId, root: entry.root, camera: current.camera,
        viewportHeight: () => current.renderer.domElement.getBoundingClientRect().height,
        stored: { ...entry.transform.position },
        storedNow: () => ({ ...(current.entries.get(objectId)?.transform.position ?? entry.transform.position) }),
        hit,
        onCommit: position => callbacks.current.onObjectMove?.(objectId, position),
        onChange: current.invalidate,
        onEnd: () => {
          current.holds.delete(session);
          current.gizmo.enabled = current.holds.size === 0 && current.grab === null;
        },
      });
      current.holds.add(session);
      return session;
    },
  }), []);

  function zoom(factor: number) {
    const current = view.current;
    if (!current) return;
    const offset = current.camera.position.clone().sub(current.controls.target);
    offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, current.controls.minDistance, current.controls.maxDistance));
    current.camera.position.copy(current.controls.target).add(offset);
    current.controls.update();
    current.viewChanged = true;
  }

  /** Frames the union of all objects. With one object at the origin this is the single-model framing. */
  function fit() {
    const current = view.current;
    if (!current || !current.entries.size) return;
    const { center, radius } = objectsBounds([...current.entries.values()].map(entry => entry.root));
    const damping = current.controls.enableDamping;
    current.controls.enableDamping = false;
    current.controls.update();
    const verticalFov = THREE.MathUtils.degToRad(current.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * current.camera.aspect);
    const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.18;
    current.camera.near = Math.max(radius / 1000, 0.00001);
    current.camera.far = radius * 200;
    current.camera.position.copy(center).add(new THREE.Vector3(1.35, 0.85, 1.7).normalize().multiplyScalar(distance));
    current.camera.updateProjectionMatrix();
    current.controls.target.copy(center);
    current.controls.minDistance = radius * 1.12;
    current.controls.maxDistance = radius * 18;
    current.controls.update();
    current.controls.saveState();
    current.controls.enableDamping = damping;
    current.viewChanged = false;
  }

  /** Highlights selected parts of the active object, dims the other objects and attaches the gizmo, without rebuilding geometry. */
  function syncSelection() {
    const current = view.current;
    if (!current) return;
    const { selectedIds: ids, transformMode: mode } = selection.current;
    const active = current.entries.get(current.activeId ?? '');
    for (const entry of current.entries.values()) {
      for (const [id, transform] of entry.parts) {
        const surface = transform.children.find(child => typeof child.userData.partId !== 'string');
        if (surface) applyPartStyle(surface, { selected: entry === active && ids.includes(id), dimmed: entry !== active });
      }
    }
    // Dragging an exploded part would write its display offset into the data.
    const exploded = explodeTarget.current > 0 || current.explodeShown > 0;
    const target = active && ids.length === 1 && mode && !exploded ? active.parts.get(ids[0]!) : undefined;
    if (target) {
      if (current.gizmo.object !== target) current.gizmo.attach(target);
      current.gizmo.setMode(mode!);
      current.gizmo.setSpace(mode === 'rotate' ? 'local' : 'world');
    } else if (current.gizmo.object) current.gizmo.detach();
    current.renderer.domElement.dataset.selectedIds = (active ? ids : []).join(',');
    current.invalidate();
  }

  /** Shows the exploded-view amount on the active object only. */
  function applyExplosionShown() {
    const current = view.current;
    if (!current) return;
    const active = current.entries.get(current.activeId ?? '');
    if (active) {
      ensureExplosion(active);
      applyExplosion(active, current.explodeShown);
    }
    current.renderer.domElement.dataset.explode = current.explodeShown.toFixed(3);
    // Activation and the explosion bases reset node positions; a running hand grab puts its last preview back.
    current.grab?.reapply();
    current.invalidate();
  }

  function writeAttributes() {
    const current = view.current;
    if (!current) return;
    const data = current.renderer.domElement.dataset;
    const active = current.entries.get(current.activeId ?? '');
    if (active) {
      data.modelName = active.model.name;
      data.partCount = String(active.model.parts.length);
      data.modelJson = JSON.stringify(active.model.parts.map(part => [part.id, part.position, part.rotation, part.dimensions, part.color]));
    } else {
      delete data.modelName; delete data.partCount; delete data.modelJson;
    }
    data.objectCount = String(current.entries.size);
    data.activeObjectId = active ? active.id : '';
    data.objectJson = JSON.stringify([...current.entries.values()].map(entry => [entry.id, entry.transform.position, entry.transform.rotation]));
  }

  function writeJointAttributes() {
    const current = view.current;
    if (!current) return;
    const joints = callbacks.current.joints ?? [];
    current.renderer.domElement.dataset.jointCount = String(joints.length);
    current.renderer.domElement.dataset.jointsJson = JSON.stringify(joints);
  }

  /** Brings the joint drawings and the join-preview glows to the requested marks: builds, replaces and removes only what changed. */
  function syncMarks() {
    const current = view.current;
    if (!current) return;
    const { marks = [], showJoints = true, joinPreview } = callbacks.current;
    const wanted = new Map<string, PartMarks>();
    if (showJoints) for (const item of marks) wanted.set(markId(item), item);
    for (const glow of joinPreview?.glow ?? []) wanted.set(markId(glow), glow);
    for (const [id, node] of current.markNodes) {
      const item = wanted.get(id);
      const part = item ? current.entries.get(item.objectId)?.parts.get(item.partId) : undefined;
      if (item && part && node.parent === part && node.key === markKey(item)) continue;
      disposeObject(node.group);
      current.markNodes.delete(id);
    }
    for (const [id, item] of wanted) {
      if (current.markNodes.has(id)) continue;
      const part = current.entries.get(item.objectId)?.parts.get(item.partId);
      if (!part) continue;
      const group = buildPartMarks(item);
      part.add(group);
      current.markNodes.set(id, { key: markKey(item), parent: part, group });
    }
    current.invalidate();
  }

  /** Shows the objects of a join preview at their previewed poses and the cue; puts every other root back at its stored transform. */
  function applyJoinPreview() {
    const current = view.current;
    if (!current) return;
    const preview = callbacks.current.joinPreview ?? null;
    const poses = new Map((preview?.transforms ?? []).map(item => [item.objectId, item.transform] as const));
    for (const id of [...current.previewed]) {
      if (poses.has(id)) continue;
      const entry = current.entries.get(id);
      if (entry) placeRoot(entry.root, entry.transform);
      current.previewed.delete(id);
    }
    for (const [id, transform] of poses) {
      const entry = current.entries.get(id);
      if (!entry) continue;
      placeRoot(entry.root, transform);
      current.previewed.add(id);
    }
    const label = preview?.ready ? preview.label : null;
    if (label && current.entries.size > 0) {
      const cue = current.cue ?? (current.cue = createCue());
      const { radius } = objectsBounds([...current.entries.values()].map(entry => entry.root));
      cue.position.set(label.x, label.y, label.z);
      cue.scale.set(radius * 0.9, radius * 0.225, 1);
      if (!cue.parent) current.scene.add(cue);
    } else if (current.cue) {
      disposeCue(current.cue);
      current.cue = null;
    }
    current.renderer.domElement.dataset.snap = preview?.ready ? 'ready' : 'none';
    current.invalidate();
  }

  /** Replaces a part's display with its printable solid while a print preview is set. */
  function applyPrintPreview() {
    const current = view.current;
    if (!current) return;
    const wanted = callbacks.current.printPreview ?? null;
    const entry = wanted ? current.entries.get(wanted.objectId) : undefined;
    const node = wanted ? entry?.parts.get(wanted.partId) : undefined;
    const shown = current.printed;
    if (shown && wanted && node && shown.group.parent === node && shown.group.userData.source === wanted.geometry) return;
    if (shown) {
      if (shown.hidden) shown.hidden.visible = true;
      disposeObject(shown.group);
      current.printed = null;
    }
    const part = entry?.model.parts.find(candidate => candidate.id === wanted?.partId);
    if (wanted && node && part) {
      // The hologram style takes the geometry over; it is disposed with the group.
      const group = hologramPart(wanted.geometry, part);
      group.name = 'print-preview';
      group.userData.source = wanted.geometry;
      group.scale.setScalar(0.001);
      group.traverse(object => {
        object.raycast = () => {};
        if (object.name.endsWith(':surface')) object.name = 'print-preview:body';
      });
      const hidden = node.children.find(child => typeof child.userData.partId !== 'string' && child !== group && !child.userData.jointMarks) ?? null;
      if (hidden) hidden.visible = false;
      node.add(group);
      current.printed = { objectId: wanted.objectId, partId: wanted.partId, group, hidden };
    } else if (wanted) {
      wanted.geometry.dispose();
    }
    current.renderer.domElement.dataset.printPreview = current.printed ? `${current.printed.objectId}:${current.printed.partId}` : '';
    current.invalidate();
  }

  /** Brings the scene to the requested list: builds, rebuilds, moves and removes only what changed. */
  function sync(next: readonly SceneObjectInput[], activeId: string | null) {
    const current = view.current;
    if (!current) return;
    const wanted = new Map<string, SceneObjectInput>();
    for (const object of next) if (!wanted.has(object.id)) wanted.set(object.id, object);
    const plan = planSceneSync(current.entries, [...wanted.values()]);
    const start = performance.now();
    const fresh = new Map<string, Entry>();
    let failed = false;
    let ready: { objects: number; parts: number; renderMs: number } | null = null;
    // Build and compile every new geometry before anything old is removed.
    try {
      for (const id of [...plan.build, ...plan.rebuild]) {
        const entry = createEntry(wanted.get(id)!);
        fresh.set(id, entry);
        current.objects.add(entry.root);
        if (id === activeId) ensureExplosion(entry);
      }
      if (fresh.size) current.renderer.compile(current.scene, current.camera);
    } catch {
      failed = true;
      for (const entry of fresh.values()) disposeObject(entry.root);
      fresh.clear();
      callbacks.current.onError?.(`無法建立這份 3D 模型，請調整描述後重試。${current.entries.size ? '上一個成功模型仍保留。' : '目前沒有可展示的模型。'}`);
    }
    // A running hand grab survives only a sync that changes nothing but the active id, to its own object (requirement 39).
    if (current.grab) {
      const applied = failed ? { plan: NO_CHANGES, activeId: current.entries.has(activeId ?? '') ? activeId : current.activeId } : { plan, activeId };
      if (!grabStillValid(applied.plan, applied.activeId, current.grab.objectId)) current.grab.invalidate();
    }
    // The same rule for a hold (requirement 91 and 39): activating the held object is fine, anything else under it cancels it.
    if (current.holds.size > 0) {
      const applied = failed ? { plan: NO_CHANGES, activeId: current.entries.has(activeId ?? '') ? activeId : current.activeId } : { plan, activeId };
      for (const hold of current.holds) if (!grabStillValid(applied.plan, applied.activeId, hold.objectId)) hold.invalidate();
    }
    if (!failed) {
      const retired: Entry[] = [];
      if (plan.rebuild.length || plan.remove.length) current.gizmo.detach();
      for (const id of [...plan.rebuild, ...plan.remove]) {
        const old = current.entries.get(id)!;
        old.root.visible = false;
        retired.push(old);
      }
      const entries = new Map<string, Entry>();
      for (const [id, object] of wanted) {
        const entry = fresh.get(id) ?? current.entries.get(id)!;
        if (!fresh.has(id)) {
          if (plan.move.includes(id)) placeRoot(entry.root, object.transform);
          entry.transform = object.transform;
        }
        entries.set(id, entry);
      }
      const previousActive = current.entries.get(current.activeId ?? '');
      current.entries = entries;
      current.surfaces = collectSurfaces(entries.values());
      // The previously active object snaps back to assembled when another one becomes active.
      if (current.activeId !== activeId) {
        if (previousActive && entries.get(previousActive.id) === previousActive) { applyExplosion(previousActive, 0); }
        current.explodeShown = 0;
      }
      current.activeId = activeId;
      if (plan.refit) fit();
      else if (fresh.size || plan.move.length) {
        // Editing or moving keeps the user's viewpoint; only the limits grow with the scene.
        const { radius } = objectsBounds([...entries.values()].map(entry => entry.root));
        current.camera.far = Math.max(current.camera.far, radius * 200);
        current.camera.updateProjectionMatrix();
        current.controls.maxDistance = Math.max(current.controls.maxDistance, radius * 18);
      }
      applyExplosionShown();
      if (fresh.size) current.renderer.render(current.scene, current.camera);
      for (const old of retired) disposeObject(old.root);
      if (fresh.size) ready = { objects: entries.size, parts: [...entries.values()].reduce((sum, entry) => sum + entry.model.parts.length, 0), renderMs: performance.now() - start };
    } else if (current.activeId !== activeId && current.entries.has(activeId ?? '')) {
      // The build failed, but switching between objects that exist still applies.
      const previousActive = current.entries.get(current.activeId ?? '');
      if (previousActive) applyExplosion(previousActive, 0);
      current.explodeShown = 0;
      current.activeId = activeId;
      applyExplosionShown();
    }
    writeAttributes();
    syncSelection();
    // Rebuilt nodes lose their drawings, previews and hidden surfaces: put them back.
    syncMarks();
    applyJoinPreview();
    applyPrintPreview();
    if (ready) callbacks.current.onReady?.(ready);
  }

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    } catch {
      callbacks.current.onError?.('此瀏覽器無法啟用 3D 顯示。請使用支援 WebGL 2 的最新版瀏覽器並開啟硬體加速。');
      return;
    }
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute('aria-label', '3D 概念模型，可拖曳旋轉、滾輪縮放，點擊零件即可選取');
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.dataset.testid = 'scene-canvas';
    renderer.domElement.dataset.selectedIds = '';
    renderer.domElement.dataset.armPreview = 'hidden';
    renderer.domElement.dataset.objectCount = '0';
    renderer.domElement.dataset.activeObjectId = '';
    renderer.domElement.dataset.objectJson = '[]';
    renderer.domElement.dataset.jointCount = '0';
    renderer.domElement.dataset.jointsJson = '[]';
    renderer.domElement.dataset.snap = 'none';
    renderer.domElement.dataset.printPreview = '';
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;outline:none';
    renderer.domElement.tabIndex = 0;
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xd5f7ff, 0x192a42, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x50dfff, 1.3);
    rim.position.set(-3, 2, -4);
    scene.add(rim);
    const objectsGroup = new THREE.Group();
    objectsGroup.name = 'objects';
    scene.add(objectsGroup);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.001, 1000);
    camera.position.set(3, 2, 4);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.enablePan = false;
    let needsRender = true;
    const invalidate = () => { needsRender = true; };
    controls.addEventListener('change', invalidate);
    const userMoved = () => { current.viewChanged = true; current.mouseBusy = true; };
    const userDone = () => { current.mouseBusy = false; };
    controls.addEventListener('start', userMoved);
    controls.addEventListener('end', userDone);
    // Direct manipulation runs entirely in the browser; the model data is
    // updated once, when the drag ends.
    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSize(0.85);
    scene.add(gizmo.getHelper());
    gizmo.addEventListener('change', invalidate);
    gizmo.addEventListener('dragging-changed', event => {
      controls.enabled = !event.value;
      const object = gizmo.object;
      if (event.value || !object || typeof object.userData.partId !== 'string') return;
      const objectId = objectIdOf(object);
      if (!objectId) return;
      const position = { x: round(object.position.x, 5), y: round(object.position.y, 5), z: round(object.position.z, 5) };
      const rotation = { x: round(THREE.MathUtils.radToDeg(object.rotation.x), 2), y: round(THREE.MathUtils.radToDeg(object.rotation.y), 2),
        z: round(THREE.MathUtils.radToDeg(object.rotation.z), 2) };
      callbacks.current.onTransform?.(objectId, object.userData.partId, position, rotation, gizmo.mode === 'rotate' ? 'rotate' : 'translate');
    });
    const current: View = { scene, camera, controls, gizmo, renderer, objects: objectsGroup, entries: new Map(), surfaces: [], raycaster: new THREE.Raycaster(),
      mouseBusy: false, grab: null, holds: new Set(), activeId: null, viewChanged: false, explodeShown: 0,
      markNodes: new Map(), previewed: new Set(), cue: null, printed: null, reset: () => fit(), invalidate };
    renderer.domElement.dataset.explode = '0.000';
    view.current = current;
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      renderer.setSize(Math.max(width, 1), Math.max(height, 1), false);
      camera.aspect = Math.max(width, 1) / Math.max(height, 1);
      camera.updateProjectionMatrix();
      // Re-frame only while the automatic framing is still in effect; a view
      // the user rotated or zoomed is kept (「重設視角」 frames again).
      if (current.entries.size && !current.viewChanged) current.reset();
      invalidate();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const lost = (event: Event) => {
      event.preventDefault();
      callbacks.current.onError?.('3D 顯示暫時中斷。請重新整理頁面以恢復；可先保留目前的文字描述。');
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    const keyboard = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(0.8); }
      else if (event.key === '-') { event.preventDefault(); zoom(1.25); }
      else if (event.key.toLowerCase() === 'r') { event.preventDefault(); current.reset(); }
    };
    renderer.domElement.addEventListener('keydown', keyboard);
    // A click (not a drag) selects the part under the pointer. Repeated clicks
    // on the same spot step through every (object, part) pair under it, so
    // interior parts behind a translucent shell remain selectable.
    let press: { x: number; y: number } | null = null;
    let cycle: { x: number; y: number; keys: string[]; index: number } | null = null;
    const pointerDown = (event: PointerEvent) => { press = event.button === 0 ? { x: event.clientX, y: event.clientY } : null; };
    const pointerUp = (event: PointerEvent) => {
      const start = press; press = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || gizmo.dragging || gizmo.axis !== null) return;
      const pairs = hitsAt(current, { x: event.clientX, y: event.clientY });
      const keys = pairs.map(pair => JSON.stringify([pair.objectId, pair.partId]));
      const repeat = cycle && Math.hypot(event.clientX - cycle.x, event.clientY - cycle.y) < 6 && cycle.keys.join() === keys.join();
      const index = repeat ? (cycle!.index + 1) % Math.max(pairs.length, 1) : 0;
      cycle = { x: event.clientX, y: event.clientY, keys, index };
      const picked = pairs[index];
      callbacks.current.onPick?.(picked?.objectId ?? null, picked?.partId ?? null, event.shiftKey);
    };
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    let armPreview: ReturnType<typeof createArmPreview> | undefined;
    let lastFrame = performance.now();
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      const step = Math.min((now - lastFrame) / 1000, 0.1) / 0.7; // full expand ≈ 0.7 s
      lastFrame = now;
      const goal = explodeTarget.current;
      if (current.explodeShown !== goal) {
        const wasAssembled = current.explodeShown === 0;
        current.explodeShown = goal > current.explodeShown ? Math.min(goal, current.explodeShown + step) : Math.max(goal, current.explodeShown - step);
        applyExplosionShown();
        if (wasAssembled || current.explodeShown === 0) syncSelection();
      }
      const changed = controls.update();
      const tryOn = callbacks.current.tryOn;
      if (!armPreview && tryOn?.current) {
        // `?armBack=0..1` compares how much of the cuff's far side shows through the arm.
        const back = Number(new URLSearchParams(window.location.search).get('armBack'));
        armPreview = createArmPreview(Number.isFinite(back) && new URLSearchParams(window.location.search).has('armBack') ? { backOpacity: THREE.MathUtils.clamp(back, 0, 1) } : {});
      }
      const armChanged = armPreview?.update(tryOn?.current ?? null, Boolean(tryOn), now);
      if (!needsRender && !changed && !armChanged) return;
      renderer.domElement.dataset.cameraPosition = camera.position.toArray().map((value) => value.toFixed(4)).join(',');
      renderer.domElement.dataset.cameraTarget = controls.target.toArray().map((value) => value.toFixed(4)).join(',');
      renderer.render(scene, camera);
      armPreview?.render(renderer);
      renderer.domElement.dataset.armPreview = armPreview?.opacity ? 'visible' : 'hidden';
      needsRender = false;
    });
    return () => {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.removeEventListener('keydown', keyboard);
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      controls.removeEventListener('change', invalidate);
      controls.removeEventListener('start', userMoved);
      controls.removeEventListener('end', userDone);
      current.grab?.cancel();
      for (const hold of [...current.holds]) hold.cancel();
      gizmo.detach();
      gizmo.dispose();
      controls.dispose();
      armPreview?.dispose();
      if (current.cue) disposeCue(current.cue);
      disposeObject(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      view.current = null;
    };
  }, []);

  useEffect(() => { sync(objects, activeObjectId); }, [objects, activeObjectId]);
  useEffect(() => { syncSelection(); }, [selectedIds.join(','), transformMode, explode > 0]);
  useEffect(() => { writeJointAttributes(); }, [props.joints]);
  useEffect(() => { syncMarks(); }, [props.marks, props.showJoints, props.joinPreview]);
  useEffect(() => { applyJoinPreview(); }, [props.joinPreview]);
  useEffect(() => { applyPrintPreview(); }, [props.printPreview]);

  return <div ref={container} data-testid="scene-viewport" style={{ position: 'absolute', inset: 0 }} />;
});
