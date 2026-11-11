import * as THREE from 'three';
import { ARM_HOLD_MS, coverFrameBounds, type ArmSample } from '../try-on/arm-pose';
import { disposeObject } from './geometry';

const FADE_MS = 180;
/** Predict at most this far past the captured frame (covers recognition delay, never a long guess). */
const MAX_PREDICT_MS = 120;
/** Position smoothing time constant: steady when still, close-following when moving fast. */
const STILL_TAU_MS = 60;
const FAST_TAU_MS = 12;
/** Rotation smoothing: steady for small (noise-sized) turns, close-following for large ones. */
const ROTATE_STILL_TAU_MS = 90;
const ROTATE_FAST_TAU_MS = 25;
/**
 * Opacity of the cuff's far side behind the arm, relative to the near side.
 * 0 hides it like a real opaque arm; a faint far side keeps the ring's
 * volume readable (user feedback 2026-11-12: a fully hidden back looked fake).
 */
export const DEFAULT_BACK_OPACITY = 0.3;
const SCALE_TAU_MS = 80;

export function createArmPreview({ backOpacity = DEFAULT_BACK_OPACITY }: { backOpacity?: number } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.01, 12);
  camera.position.z = 4;
  const arm = new THREE.Group();
  scene.add(arm);

  const translucent = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({ color, opacity, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const shell = translucent(0x3dc4ed, 0.23);
  const bands = translucent(0x70ecff, 0.86);
  const braces = translucent(0x1cacc8, 0.64);
  const depth = new THREE.MeshBasicMaterial({ colorWrite: false });
  const fades = [shell, bands, braces].map(material => ({ material, opacity: material.opacity }));

  // Units are knuckle widths. An adult wrist is ~0.7 and the mid-forearm
  // ~0.9–1.0 knuckle widths across, so the cuff runs 0.8 → 1.0 (it was
  // 0.96 → 1.26 and looked about twice the arm's thickness on 2026-11-12).
  // The depth-only tapered proxy approximates the forearm. It masks the far
  // side of the shell while the video remains visible through the near side.
  const occluder = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.45, 0.70, 24), depth);
  occluder.position.y = -0.33;
  occluder.scale.z = 0.84;
  arm.add(occluder);

  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.40, 0.50, 0.51, 28, 1, true), shell);
  tube.position.y = -0.31;
  tube.scale.z = 0.84;
  arm.add(tube);

  for (const { radius, y } of [{ radius: 0.41, y: -0.055 }, { radius: 0.50, y: -0.565 }, { radius: 0.48, y: -0.49 }]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.026, 8, 40), bands);
    band.rotation.x = Math.PI / 2;
    band.scale.y = 0.84;
    band.position.y = y;
    arm.add(band);
  }

  const braceGeometry = new THREE.BoxGeometry(0.095, 0.40, 0.05);
  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI / 2 + Math.PI / 4;
    const brace = new THREE.Mesh(braceGeometry, braces);
    brace.position.set(Math.sin(angle) * 0.45, -0.30, Math.cos(angle) * 0.38);
    brace.rotation.y = angle;
    arm.add(brace);
  }

  // Far side: the back faces, drawn first and through the arm proxy, faintly.
  const fadeLayers = [...fades];
  if (backOpacity > 0) {
    const ghosts = new Map<THREE.Material, THREE.MeshBasicMaterial>();
    for (const mesh of arm.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh && child !== occluder)) {
      const source = mesh.material as THREE.MeshBasicMaterial;
      let ghost = ghosts.get(source);
      if (!ghost) {
        ghost = new THREE.MeshBasicMaterial({ color: source.color, opacity: source.opacity * backOpacity, transparent: true,
          depthWrite: false, depthTest: false, side: THREE.BackSide });
        ghosts.set(source, ghost);
        fadeLayers.push({ material: ghost, opacity: ghost.opacity });
      }
      const copy = new THREE.Mesh(mesh.geometry, ghost);
      copy.position.copy(mesh.position);
      copy.rotation.copy(mesh.rotation);
      copy.scale.copy(mesh.scale);
      copy.renderOrder = -1;
      arm.add(copy);
    }
  }

  let last: ArmSample | null = null;
  let lostAt: number | null = null;
  let opacity = 0;
  let canvasAspect = 0;
  let sourceAspect = 0;
  const size = new THREE.Vector2();
  const scale = new THREE.Vector3();
  const targetPosition = new THREE.Vector3();
  const targetRotation = new THREE.Quaternion();
  const velocity = new THREE.Vector3();
  const measured = new THREE.Vector3();
  const before = new THREE.Vector3();
  const beforeRotation = new THREE.Quaternion();
  let lastUpdate = 0;
  const capturedAt = (sample: ArmSample) => sample.capturedAt ?? sample.seenAt;

  function update(sample: ArmSample | null, enabled: boolean, now: number): boolean {
    let changed = false;
    const elapsed = THREE.MathUtils.clamp(now - lastUpdate, 0, 100);
    lastUpdate = now;
    if (!enabled) {
      last = null;
      lostAt = null;
      velocity.set(0, 0, 0);
    } else if (sample && sample !== last) {
      scale.set(sample.palmWidth, sample.forearmLength, sample.palmWidth);
      if (last?.side === sample.side && last.sourceAspect === sample.sourceAspect && opacity > 0) {
        const dt = capturedAt(sample) - capturedAt(last);
        if (dt > 0) velocity.lerp(measured.copy(sample.wrist).sub(last.wrist).divideScalar(dt), 0.6);
      } else {
        velocity.set(0, 0, 0);
        arm.position.copy(sample.wrist);
        arm.quaternion.copy(sample.orientation);
        arm.scale.copy(scale);
      }
      targetRotation.copy(sample.orientation);
      last = sample;
      lostAt = null;
      changed = true;
    } else if (!sample && last && lostAt === null) {
      lostAt = now;
    }

    // Results arrive a recognition delay after capture and only a few times a
    // second on slow machines, so ease toward a velocity-predicted wrist on
    // every rendered frame instead of jumping once per result.
    if (last) {
      const ahead = THREE.MathUtils.clamp(now - capturedAt(last), 0, MAX_PREDICT_MS);
      targetPosition.copy(last.wrist).addScaledVector(velocity, ahead);
      // Speed in frame heights per ms; ~0.001 is a brisk hand motion.
      const tau = FAST_TAU_MS + (STILL_TAU_MS - FAST_TAU_MS) / (1 + velocity.length() * 4000);
      before.copy(arm.position);
      beforeRotation.copy(arm.quaternion);
      arm.position.lerp(targetPosition, 1 - Math.exp(-elapsed / tau));
      const turn = THREE.MathUtils.radToDeg(arm.quaternion.angleTo(targetRotation));
      const rotateTau = ROTATE_FAST_TAU_MS + (ROTATE_STILL_TAU_MS - ROTATE_FAST_TAU_MS) / (1 + (turn / 10) ** 2);
      arm.quaternion.slerp(targetRotation, 1 - Math.exp(-elapsed / rotateTau));
      arm.scale.lerp(scale, 1 - Math.exp(-elapsed / SCALE_TAU_MS));
      if (before.distanceToSquared(arm.position) > 1e-10 || beforeRotation.angleTo(arm.quaternion) > 1e-4) changed = true;
    }

    const holdUntil = last ? Math.min(last.validUntil, lostAt === null ? Infinity : lostAt + ARM_HOLD_MS) : 0;
    const nextOpacity = last ? THREE.MathUtils.clamp(1 - (now - holdUntil) / FADE_MS, 0, 1) : 0;
    if (nextOpacity !== opacity) {
      opacity = nextOpacity;
      for (const layer of fadeLayers) layer.material.opacity = layer.opacity * opacity;
      changed = true;
    }
    return changed;
  }

  function render(renderer: THREE.WebGLRenderer) {
    if (opacity === 0 || !last) return;
    renderer.getSize(size);
    const aspect = size.x / size.y;
    if (canvasAspect !== aspect || sourceAspect !== last.sourceAspect) {
      canvasAspect = aspect;
      sourceAspect = last.sourceAspect;
      const bounds = coverFrameBounds(sourceAspect, canvasAspect);
      camera.left = -bounds.width / 2;
      camera.right = bounds.width / 2;
      camera.top = bounds.height / 2;
      camera.bottom = -bounds.height / 2;
      camera.updateProjectionMatrix();
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.clearDepth();
      renderer.render(scene, camera);
    } finally {
      renderer.autoClear = autoClear;
    }
  }

  return { update, render, get opacity() { return opacity; }, get position() { return arm.position; }, dispose: () => disposeObject(scene) };
}
