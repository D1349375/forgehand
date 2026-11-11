import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { ModelSpec } from '../../shared/model';
import type { ArmSample } from '../try-on/arm-pose';
import { createArmPreview } from './arm-preview';
import { computeExplosion, groupProgress, worldMatrices } from './explode';
import { buildModel, disposeObject, modelBounds } from './geometry';
import { applySelectionStyle, hologramPart } from './style';

export type TransformMode = 'translate' | 'rotate' | null;
export interface Vector { x: number; y: number; z: number }
export interface SceneHandle {
  reset(): void; zoomIn(): void; zoomOut(): void;
  /** Viewport client coordinates of a part's centre (used by tests and tooling). */
  projectPart(id: string): { x: number; y: number } | null;
}
interface Props {
  model: ModelSpec | null;
  /** The camera re-frames only when this key changes (a different object). */
  fitKey?: string | null;
  selectedIds?: readonly string[];
  transformMode?: TransformMode;
  /** Exploded-view amount 0 (assembled) … 1 (fully exploded); display only, animated toward this value. */
  explode?: number;
  tryOn?: { readonly current: ArmSample | null };
  onPick?: (partId: string | null, additive: boolean) => void;
  onTransform?: (partId: string, position: Vector, rotation: Vector) => void;
  onError?: (message: string) => void;
  onReady?: (info: { parts: number; renderMs: number }) => void;
}
interface View {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  gizmo: TransformControls;
  renderer: THREE.WebGLRenderer;
  model: THREE.Group | null;
  fitKey: string | null | undefined;
  /** True once the user rotates or zooms after the last automatic framing. */
  viewChanged: boolean;
  /** Per-part exploded-view motion in the part's parent frame, rebuilt with each model. */
  explosion: Array<{ node: THREE.Object3D; base: THREE.Vector3; offset: THREE.Vector3; depth: number }>;
  explosionDepth: number;
  /** Amount currently shown; eases toward the `explode` prop. */
  explodeShown: number;
  reset: () => void;
  invalidate: () => void;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

function partTransforms(model: THREE.Object3D | null): Map<string, THREE.Object3D> {
  const transforms = new Map<string, THREE.Object3D>();
  model?.traverse(object => { if (typeof object.userData.partId === 'string') transforms.set(object.userData.partId, object); });
  return transforms;
}

export const SceneViewport = forwardRef<SceneHandle, Props>(function SceneViewport(props, ref) {
  const { model, fitKey, selectedIds = [], transformMode = null, explode = 0 } = props;
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
    projectPart(id) {
      const current = view.current;
      const target = partTransforms(current?.model ?? null).get(id);
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

  /** Highlights selected parts and attaches the gizmo without rebuilding geometry. */
  function syncSelection() {
    const current = view.current;
    if (!current) return;
    const { selectedIds: ids, transformMode: mode } = selection.current;
    const transforms = partTransforms(current.model);
    for (const [id, transform] of transforms) {
      const surface = transform.children.find(child => typeof child.userData.partId !== 'string');
      if (surface) applySelectionStyle(surface, ids.includes(id));
    }
    // Dragging an exploded part would write its display offset into the data.
    const exploded = explodeTarget.current > 0 || current.explodeShown > 0;
    const target = ids.length === 1 && mode && !exploded ? transforms.get(ids[0]!) : undefined;
    if (target) {
      if (current.gizmo.object !== target) current.gizmo.attach(target);
      current.gizmo.setMode(mode!);
      current.gizmo.setSpace(mode === 'rotate' ? 'local' : 'world');
    } else if (current.gizmo.object) current.gizmo.detach();
    current.renderer.domElement.dataset.selectedIds = ids.join(',');
    current.invalidate();
  }

  /** Places every part at the shown exploded-view amount (outer groups first). */
  function applyExplosion() {
    const current = view.current;
    if (!current) return;
    for (const entry of current.explosion) {
      entry.node.position.copy(entry.base).addScaledVector(entry.offset, groupProgress(current.explodeShown, entry.depth, current.explosionDepth));
    }
    current.renderer.domElement.dataset.explode = current.explodeShown.toFixed(3);
    current.invalidate();
  }

  function prepareExplosion(next: ModelSpec, built: THREE.Group) {
    const current = view.current!;
    const plan = computeExplosion(next);
    const matrices = worldMatrices(next);
    const parents = new Map(next.parts.map(part => [part.id, part.parentId]));
    const transforms = partTransforms(built);
    current.explosion = [...plan.moves].flatMap(([id, move]) => {
      const node = transforms.get(id);
      if (!node) return [];
      // Offsets are world vectors; a child node moves in its parent's (rotated) frame.
      const parentId = parents.get(id);
      const parentRotation = parentId ? new THREE.Quaternion().setFromRotationMatrix(matrices.get(parentId)!) : new THREE.Quaternion();
      return [{ node, base: node.position.clone(), offset: move.offset.clone().applyQuaternion(parentRotation.invert()), depth: move.depth }];
    });
    current.explosionDepth = plan.maxDepth;
  }

  function replace(next: ModelSpec | null, nextFitKey: string | null | undefined) {
    const current = view.current;
    if (!current) return;
    current.gizmo.detach();
    if (!next) {
      if (current.model) disposeObject(current.model);
      current.model = null;
      current.explosion = [];
      current.fitKey = nextFitKey;
      current.invalidate();
      return;
    }
    let candidate: THREE.Group | null = null;
    const oldPosition = current.camera.position.clone();
    const oldTarget = current.controls.target.clone();
    const oldProjection = { near: current.camera.near, far: current.camera.far };
    const oldLimits = { min: current.controls.minDistance, max: current.controls.maxDistance };
    let ready: { parts: number; renderMs: number } | null = null;
    const start = performance.now();
    try {
      candidate = buildModel(next, hologramPart);
      const { center, radius } = modelBounds(candidate);
      // Build, bound and compile the candidate before removing the previous model.
      current.scene.add(candidate);
      current.renderer.compile(current.scene, current.camera);
      const previous = current.model;
      const fit = () => {
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
      };
      // Editing the same object keeps the user's viewpoint; only a different
      // object (or the first one) is framed automatically.
      const refit = !previous || current.fitKey !== nextFitKey;
      if (refit) fit();
      else {
        current.camera.far = Math.max(current.camera.far, radius * 200);
        current.camera.updateProjectionMatrix();
        current.controls.maxDistance = Math.max(current.controls.maxDistance, radius * 18);
      }
      if (previous) previous.visible = false;
      current.renderer.render(current.scene, current.camera);
      current.model = candidate;
      current.fitKey = nextFitKey;
      current.reset = fit;
      prepareExplosion(next, candidate);
      applyExplosion();
      if (previous) disposeObject(previous);
      current.renderer.domElement.dataset.modelName = next.name;
      current.renderer.domElement.dataset.partCount = String(next.parts.length);
      current.renderer.domElement.dataset.modelJson = JSON.stringify(next.parts.map(part => [part.id, part.position, part.rotation, part.dimensions, part.color]));
      ready = { parts: next.parts.length, renderMs: performance.now() - start };
    } catch {
      if (candidate && current.model !== candidate) disposeObject(candidate);
      if (current.model) current.model.visible = true;
      current.camera.position.copy(oldPosition);
      current.camera.near = oldProjection.near;
      current.camera.far = oldProjection.far;
      current.camera.updateProjectionMatrix();
      current.controls.target.copy(oldTarget);
      current.controls.minDistance = oldLimits.min;
      current.controls.maxDistance = oldLimits.max;
      current.controls.update();
      callbacks.current.onError?.(`無法建立這份 3D 模型，請調整描述後重試。${current.model ? '上一個成功模型仍保留。' : '目前沒有可展示的模型。'}`);
    }
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
      const position = { x: round(object.position.x, 5), y: round(object.position.y, 5), z: round(object.position.z, 5) };
      const rotation = { x: round(THREE.MathUtils.radToDeg(object.rotation.x), 2), y: round(THREE.MathUtils.radToDeg(object.rotation.y), 2),
        z: round(THREE.MathUtils.radToDeg(object.rotation.z), 2) };
      callbacks.current.onTransform?.(object.userData.partId, position, rotation);
    });
    const current: View = { scene, camera, controls, gizmo, renderer, model: null, fitKey: undefined, viewChanged: false,
      explosion: [], explosionDepth: 0, explodeShown: 0, reset: () => {}, invalidate };
    renderer.domElement.dataset.explode = '0.000';
    view.current = current;
    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      renderer.setSize(Math.max(width, 1), Math.max(height, 1), false);
      camera.aspect = Math.max(width, 1) / Math.max(height, 1);
      camera.updateProjectionMatrix();
      // Re-frame only while the automatic framing is still in effect; a view
      // the user rotated or zoomed is kept (「重設視角」 frames again).
      if (current.model && !current.viewChanged) current.reset();
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
    // on the same spot step through every part under it, so interior parts
    // behind a translucent shell remain selectable.
    const raycaster = new THREE.Raycaster();
    let press: { x: number; y: number } | null = null;
    let cycle: { x: number; y: number; ids: string[]; index: number } | null = null;
    const pointerDown = (event: PointerEvent) => { press = event.button === 0 ? { x: event.clientX, y: event.clientY } : null; };
    const pointerUp = (event: PointerEvent) => {
      const start = press; press = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || gizmo.dragging || gizmo.axis !== null) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const surfaces: THREE.Object3D[] = [];
      current.model?.traverse(object => { if (object instanceof THREE.Mesh && object.name.endsWith(':surface')) surfaces.push(object); });
      const ids: string[] = [];
      for (const hit of raycaster.intersectObjects(surfaces, false)) {
        let node: THREE.Object3D | null = hit.object;
        while (node && typeof node.userData.partId !== 'string') node = node.parent;
        if (node && !ids.includes(node.userData.partId)) ids.push(node.userData.partId);
      }
      const repeat = cycle && Math.hypot(event.clientX - cycle.x, event.clientY - cycle.y) < 6 && cycle.ids.join() === ids.join();
      const index = repeat ? (cycle!.index + 1) % Math.max(ids.length, 1) : 0;
      cycle = { x: event.clientX, y: event.clientY, ids, index };
      callbacks.current.onPick?.(ids[index] ?? null, event.shiftKey);
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
        applyExplosion();
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

  useEffect(() => { replace(model, fitKey); }, [model]);
  useEffect(() => { syncSelection(); }, [selectedIds.join(','), transformMode, explode > 0]);

  return <div ref={container} data-testid="scene-viewport" style={{ position: 'absolute', inset: 0 }} />;
});
