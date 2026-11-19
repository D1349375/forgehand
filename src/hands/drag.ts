import { Matrix4, Spherical, Vector3 } from 'three';
import { DRAG_GAIN } from './constants';
import type { Point, Vector } from './types';

/** The `Part` position limit of `shared/model.ts`, per axis. */
const POSITION_LIMIT = 100;
/** The same margin OrbitControls keeps from the poles. */
const EPSILON = 1e-6;

const round5 = (value: number) => Math.min(POSITION_LIMIT, Math.max(-POSITION_LIMIT, Number(value.toFixed(5)))) || 0;

/**
 * The new local position of a grabbed part (requirements 30, 31, 33). The part moves in the plane
 * through the grabbed point that faces the camera: the cursor offset since engage, times `gain`,
 * becomes a world offset at the grabbed point's depth (a closer camera moves less per pixel), and
 * is converted into the parent's frame. `parentWorld` is rigid (parents never scale children), so
 * its inverse is exact. The result is rounded to 5 decimals like the gizmo and clamped to ±100.
 */
export function dragPosition(input: {
  camera: { matrixWorld: Matrix4; fovDeg: number };
  viewportHeight: number;
  parentWorld: Matrix4;
  start: Vector;
  hit: Vector;
  offset: Point;
  gain?: number;
}): Vector {
  const { camera, viewportHeight, parentWorld, offset, gain = DRAG_GAIN } = input;
  const origin = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  const back = new Vector3();
  camera.matrixWorld.extractBasis(right, up, back);
  origin.setFromMatrixPosition(camera.matrixWorld);
  right.normalize();
  up.normalize();
  const forward = back.normalize().negate();
  const depth = Math.max(new Vector3(input.hit.x, input.hit.y, input.hit.z).sub(origin).dot(forward), 1e-3);
  const pixel = (2 * depth * Math.tan((camera.fovDeg * Math.PI) / 360)) / Math.max(viewportHeight, 1);
  const delta = right.multiplyScalar(offset.x * gain * pixel).addScaledVector(up, -offset.y * gain * pixel);
  const world = new Vector3(input.start.x, input.start.y, input.start.z).applyMatrix4(parentWorld).add(delta);
  const local = world.applyMatrix4(new Matrix4().copy(parentWorld).invert());
  return { x: round5(local.x), y: round5(local.y), z: round5(local.z) };
}

/**
 * The camera-minus-target vector after turning the view (requirement 35): `start` turned by the
 * cursor offset since engage. Horizontal movement changes the azimuth, vertical movement the polar
 * angle, within `limits` (radians, as OrbitControls) and away from the poles.
 */
export function orbitOffset(start: Vector3, offset: Point, degPerPx: number,
  limits: { minPolar: number; maxPolar: number; minAzimuth: number; maxAzimuth: number }): Vector3 {
  const spherical = new Spherical().setFromVector3(start);
  const step = (degPerPx * Math.PI) / 180;
  spherical.theta = Math.min(limits.maxAzimuth, Math.max(limits.minAzimuth, spherical.theta - offset.x * step));
  spherical.phi = spherical.phi - offset.y * step;
  spherical.phi = Math.max(Math.max(limits.minPolar, EPSILON), Math.min(Math.min(limits.maxPolar, Math.PI - EPSILON), spherical.phi));
  return new Vector3().setFromSpherical(spherical);
}
