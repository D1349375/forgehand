import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { ModelSpec } from '../../shared/model';
import type { ObjectTransform } from '../../shared/workspace';
import type { ArmSample } from '../try-on/arm-pose';
import { createArmPreview } from './arm-preview';
import { computeExplosion, groupProgress, worldMatrices } from './explode';
import { buildModel, disposeObject, modelBounds, objectsBounds } from './geometry';
import { planSceneSync } from './scene-sync';
import { applyPartStyle, hologramPart } from './style';

export type TransformMode = 'translate' | 'rotate' | null;
export interface Vector { x: number; y: number; z: number }
export interface SceneObjectInput { id: string; model: ModelSpec; transform: ObjectTransform }
export interface SceneHandle {
  reset(): void; zoomIn(): void; zoomOut(): void;
  /** Viewport client coordinates of a part's centre (used by tests and tooling); `objectId` defaults to the active object. */
  projectPart(id: string, objectId?: string): { x: number; y: number } | null;
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
  onTransform?: (objectId: string, partId: string, position: Vector, rotation: Vector) => void;
  onError?: (message: string) => void;
  onReady?: (info: { objects: number; parts: number; renderMs: number }) => void;
}
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
  activeId: string | null;
  /** True once the user rotates or zooms after the last automatic framing. */
  viewChanged: boolean;
  /** Amount currently shown on the active object; eases toward the `explode` prop. */
  explodeShown: number;
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
    const userMoved = () => { current.viewChanged = true; };
    controls.addEventListener('start', userMoved);
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
      callbacks.current.onTransform?.(objectId, object.userData.partId, position, rotation);
    });
    const current: View = { scene, camera, controls, gizmo, renderer, objects: objectsGroup, entries: new Map(), activeId: null, viewChanged: false,
      explodeShown: 0, reset: () => fit(), invalidate };
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
    const raycaster = new THREE.Raycaster();
    let press: { x: number; y: number } | null = null;
    let cycle: { x: number; y: number; keys: string[]; index: number } | null = null;
    const pointerDown = (event: PointerEvent) => { press = event.button === 0 ? { x: event.clientX, y: event.clientY } : null; };
    const pointerUp = (event: PointerEvent) => {
      const start = press; press = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || gizmo.dragging || gizmo.axis !== null) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const surfaces: THREE.Object3D[] = [];
      for (const entry of current.entries.values()) {
        entry.root.traverse(object => { if (object instanceof THREE.Mesh && object.name.endsWith(':surface')) surfaces.push(object); });
      }
      const pairs: Array<{ objectId: string; partId: string }> = [];
      const keys: string[] = [];
      for (const hit of raycaster.intersectObjects(surfaces, false)) {
        let node: THREE.Object3D | null = hit.object;
        while (node && typeof node.userData.partId !== 'string') node = node.parent;
        const objectId = objectIdOf(node);
        if (!node || !objectId) continue;
        const keyOf = JSON.stringify([objectId, node.userData.partId]);
        if (keys.includes(keyOf)) continue;
        keys.push(keyOf);
        pairs.push({ objectId, partId: node.userData.partId });
      }
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
      gizmo.detach();
      gizmo.dispose();
      controls.dispose();
      armPreview?.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      view.current = null;
    };
  }, []);

  useEffect(() => { sync(objects, activeObjectId); }, [objects, activeObjectId]);
  useEffect(() => { syncSelection(); }, [selectedIds.join(','), transformMode, explode > 0]);

  return <div ref={container} data-testid="scene-viewport" style={{ position: 'absolute', inset: 0 }} />;
});
