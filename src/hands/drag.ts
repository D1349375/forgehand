import { Euler, Matrix4, Quaternion, Spherical, Vector3 } from 'three';
import { DRAG_GAIN } from './constants';
import { beyondDeadZone } from './pair';
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

/**
 * The factor for the camera's distance to the orbit target in a two-hand zoom (requirement 87): its
 * distance when the second hand joined, times this ratio. `startSpan` and `span` are the distances
 * between the two cursors at join and now. The change is reduced by `deadZonePx` (so leaving the
 * dead zone does not jump) and neither distance is taken below `minSpanPx`. Spreading the hands
 * gives a ratio below 1 (a nearer camera), bringing them together a ratio above 1.
 */
export function zoomRatio(input: { startSpan: number; span: number; deadZonePx: number; minSpanPx: number }): number {
  const { startSpan, span, deadZonePx, minSpanPx } = input;
  const effective = startSpan + beyondDeadZone(span - startSpan, deadZonePx);
  return Math.max(startSpan, minSpanPx) / Math.max(effective, minSpanPx);
}
/**
 * The explode amount while a fist holds an object and the other hand pinches (requirement 93): the amount when the pinch joined,
 * plus the change in the distance between the fist's palm centre and the pinch cursor (reduced by `deadZonePx`) divided by
 * `fullFraction` of the viewport height. Spreading explodes, bringing together closes. Clamped to 0..1 and rounded to 0.01.
 */
export function explodeAmount(input: { start: number; startSpan: number; span: number; deadZonePx: number; viewportHeight: number; fullFraction: number }): number {
  const { start, startSpan, span, deadZonePx, viewportHeight, fullFraction } = input;
  const change = beyondDeadZone(span - startSpan, deadZonePx) / Math.max(fullFraction * viewportHeight, 1e-6);
  return Math.min(1, Math.max(0, Math.round((start + change) * 100) / 100)) || 0;
}
const round2 = (value: number) => Number(value.toFixed(2)) || 0;
const RAD_TO_DEG = 180 / Math.PI;
/**
 * The new local rotation of a part turned about the camera's view axis through its own origin (requirement 96), in XYZ Euler degrees
 * rounded to 2 decimals. `start` is the part's local rotation (radians) when the turn began, `parentWorld` the live world matrix of its
 * parent and `cameraWorld` the camera's. The axis is the camera's forward direction; a positive angle turns the part clockwise on
 * screen, the way a positive change of `pairAngle` (screen y grows down) turns the vector between the hands. The result is
 * `parentQ⁻¹ · turn · parentQ · startQ`, so it lies within ±180° and the ±360° limit of a part always holds. The position is not touched.
 */
export function rotateAboutView(input: { parentWorld: Matrix4; start: Euler; cameraWorld: Matrix4; angleDeg: number }): Vector {
  const parentQ = new Quaternion();
  input.parentWorld.decompose(new Vector3(), parentQ, new Vector3());
  const right = new Vector3();
  const up = new Vector3();
  const back = new Vector3();
  input.cameraWorld.extractBasis(right, up, back);
  const forward = back.normalize().negate();
  const turn = new Quaternion().setFromAxisAngle(forward, (input.angleDeg * Math.PI) / 180);
  const world = parentQ.clone().multiply(new Quaternion().setFromEuler(input.start));
  const local = parentQ.clone().invert().multiply(turn).multiply(world);
  const euler = new Euler().setFromQuaternion(local, 'XYZ');
  return { x: round2(euler.x * RAD_TO_DEG), y: round2(euler.y * RAD_TO_DEG), z: round2(euler.z * RAD_TO_DEG) };
}
