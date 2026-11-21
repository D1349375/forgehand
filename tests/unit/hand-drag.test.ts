import { describe, expect, it } from 'vitest';
import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { EXPLODE_DEAD_ZONE_PX, EXPLODE_FULL_FRACTION, TWO_HAND_MIN_SPAN_PX, ZOOM_DEAD_ZONE_PX } from '../../src/hands/constants';
import { dragPosition, explodeAmount, orbitOffset, zoomRatio } from '../../src/hands/drag';
import type { Point, Vector } from '../../src/hands/types';

const VIEWPORT_HEIGHT = 800;
const FOV = 38;

/** A camera at `position` looking at `target`, with its world matrix up to date. */
function cameraAt(position: Vector3, target = new Vector3(0, 0, 0)) {
  const camera = new PerspectiveCamera(FOV, 1.5, 0.01, 1000);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

const asVector3 = (vector: Vector) => new Vector3(vector.x, vector.y, vector.z);
const rigid = (position: Vector3, degrees: [number, number, number]) =>
  new Matrix4().compose(position, new Quaternion().setFromEuler(new Euler(...degrees.map(value => (value * Math.PI) / 180) as [number, number, number], 'XYZ')), new Vector3(1, 1, 1));

function move(camera: PerspectiveCamera, options: { parentWorld?: Matrix4; start?: Vector; hit?: Vector; offset: Point; gain?: number }) {
  return dragPosition({
    camera: { matrixWorld: camera.matrixWorld, fovDeg: camera.fov },
    viewportHeight: VIEWPORT_HEIGHT,
    parentWorld: options.parentWorld ?? new Matrix4(),
    start: options.start ?? { x: 0, y: 0, z: 0 },
    hit: options.hit ?? { x: 0, y: 0, z: 0 },
    offset: options.offset,
    gain: options.gain,
  });
}

/** The world position of a local position under `parentWorld`. */
const toWorld = (local: Vector, parentWorld: Matrix4) => asVector3(local).applyMatrix4(parentWorld);

describe('dragPosition', () => {
  it('does not jump at offset 0', () => {
    const camera = cameraAt(new Vector3(3, 2, 4));
    const parent = rigid(new Vector3(1, 0.5, -2), [10, 35, -20]);
    const start = { x: 0.25, y: -0.5, z: 1.125 };
    expect(move(camera, { parentWorld: parent, start, hit: { x: 0, y: 0, z: 0 }, offset: { x: 0, y: 0 } })).toEqual(start);
  });

  it('moves +X for a rightward offset with a camera looking down −Z, and −Y for a downward one', () => {
    const camera = cameraAt(new Vector3(0, 0, 5));
    const right = move(camera, { offset: { x: 100, y: 0 } });
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBeCloseTo(0, 5);
    expect(right.z).toBeCloseTo(0, 5);
    const down = move(camera, { offset: { x: 0, y: 100 } });
    expect(down.y).toBeLessThan(0);
    expect(down.x).toBeCloseTo(0, 5);
  });

  it('converts pixels to metres at the depth of the grabbed point, times the gain', () => {
    const camera = cameraAt(new Vector3(0, 0, 5));
    const metresPerPixel = (2 * 5 * Math.tan((FOV * Math.PI) / 360)) / VIEWPORT_HEIGHT;
    expect(move(camera, { offset: { x: 100, y: 0 }, gain: 1 }).x).toBeCloseTo(100 * metresPerPixel, 4);
    expect(move(camera, { offset: { x: 100, y: 0 } }).x).toBeCloseTo(100 * 1.5 * metresPerPixel, 4);
  });

  it('moves in the camera plane for a rotated camera', () => {
    const camera = cameraAt(new Vector3(4, 3, 2));
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    const result = asVector3(move(camera, { offset: { x: 80, y: -40 } }));
    expect(result.length()).toBeGreaterThan(0);
    expect(result.dot(forward)).toBeCloseTo(0, 4);
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    expect(result.dot(right)).toBeGreaterThan(0);
    expect(result.dot(up)).toBeGreaterThan(0);
  });

  it('lands a child under a rotated parent and a rotated object root on the expected local position', () => {
    const camera = cameraAt(new Vector3(3, 2, 6));
    const objectRoot = rigid(new Vector3(0.5, 0, -1), [0, 40, 0]);
    const parentPart = rigid(new Vector3(0.2, 0.7, 0.1), [25, -10, 60]);
    const parentWorld = objectRoot.clone().multiply(parentPart);
    const start = { x: 0.3, y: 0.1, z: -0.2 };
    const hit = toWorld(start, parentWorld);
    const offset = { x: 60, y: 30 };
    const result = move(camera, { parentWorld, start, hit, offset });
    // Transform back to world: the part moved by exactly the camera-plane offset.
    const delta = toWorld(result, parentWorld).sub(toWorld(start, parentWorld));
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    expect(delta.dot(forward)).toBeCloseTo(0, 4);
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const depth = hit.clone().sub(camera.position).dot(forward);
    const metresPerPixel = (2 * depth * Math.tan((FOV * Math.PI) / 360)) / VIEWPORT_HEIGHT;
    expect(delta.dot(right)).toBeCloseTo(60 * 1.5 * metresPerPixel, 3);
    expect(delta.dot(up)).toBeCloseTo(-30 * 1.5 * metresPerPixel, 3);
  });

  it('moves half as far per pixel with the camera half as far from the grabbed point', () => {
    const far = move(cameraAt(new Vector3(0, 0, 8)), { offset: { x: 100, y: 0 } });
    const near = move(cameraAt(new Vector3(0, 0, 4)), { offset: { x: 100, y: 0 } });
    expect(near.x).toBeCloseTo(far.x / 2, 4);
  });

  it('measures depth along the camera axis, not the distance to the hit', () => {
    const camera = cameraAt(new Vector3(0, 0, 5));
    const onAxis = move(camera, { offset: { x: 100, y: 0 }, hit: { x: 0, y: 0, z: 0 } });
    const offAxis = move(camera, { offset: { x: 100, y: 0 }, hit: { x: 2, y: 1, z: 0 } });
    expect(offAxis.x).toBeCloseTo(onAxis.x, 5);
  });

  it('rounds to 5 decimals and clamps to ±100 per axis', () => {
    const camera = cameraAt(new Vector3(0, 0, 5));
    const rounded = move(camera, { offset: { x: 37, y: 11 } });
    for (const value of [rounded.x, rounded.y, rounded.z]) expect(Number(value.toFixed(5))).toBe(value);
    const far = move(camera, { offset: { x: 1e7, y: 1e7 } });
    expect(far.x).toBe(100);
    expect(far.y).toBe(-100);
    expect(Object.is(move(camera, { offset: { x: 0, y: 0 } }).z, 0)).toBe(true);
  });
});

describe('orbitOffset', () => {
  const free = { minPolar: 0, maxPolar: Math.PI, minAzimuth: -Infinity, maxAzimuth: Infinity };
  const start = new Vector3(3, 2, 4);

  it('keeps the distance and the polar angle for a horizontal offset, and turns the azimuth', () => {
    const result = orbitOffset(start, { x: 100, y: 0 }, 0.4, free);
    expect(result.length()).toBeCloseTo(start.length(), 5);
    expect(result.y).toBeCloseTo(start.y, 5);
    const before = Math.atan2(start.x, start.z);
    const after = Math.atan2(result.x, result.z);
    // 100 px at 0.4 deg per px is 40 degrees; a rightward offset turns the azimuth down.
    expect(((before - after) * 180) / Math.PI).toBeCloseTo(40, 3);
  });

  it('does not move at offset 0', () => {
    const result = orbitOffset(start, { x: 0, y: 0 }, 0.4, free);
    expect(result.x).toBeCloseTo(start.x, 5);
    expect(result.y).toBeCloseTo(start.y, 5);
    expect(result.z).toBeCloseTo(start.z, 5);
  });

  it('changes the polar angle for a vertical offset, keeping the distance', () => {
    const result = orbitOffset(start, { x: 0, y: 50 }, 0.4, free);
    expect(result.length()).toBeCloseTo(start.length(), 5);
    expect(result.y).toBeGreaterThan(start.y);
  });

  it('clamps the polar angle to the limits and away from the poles', () => {
    const limited = orbitOffset(start, { x: 0, y: -5000 }, 0.4, { ...free, maxPolar: Math.PI / 2 });
    expect(limited.y).toBeCloseTo(0, 5);
    const top = orbitOffset(start, { x: 0, y: 100000 }, 0.4, free);
    expect(top.y).toBeLessThan(top.length());
    expect(top.y / top.length()).toBeGreaterThan(0.999999);
    const bottom = orbitOffset(start, { x: 0, y: -100000 }, 0.4, free);
    expect(bottom.y).toBeLessThan(0);
    expect(Number.isFinite(bottom.x) && Number.isFinite(bottom.z)).toBe(true);
  });

  it('clamps the azimuth to the limits', () => {
    const result = orbitOffset(start, { x: 10000, y: 0 }, 0.4, { ...free, minAzimuth: -0.5, maxAzimuth: 0.5 });
    expect(Math.atan2(result.x, result.z)).toBeCloseTo(-0.5, 5);
  });
});

describe('zoomRatio', () => {
  const ratio = (startSpan: number, span: number) => zoomRatio({ startSpan, span, deadZonePx: ZOOM_DEAD_ZONE_PX, minSpanPx: TWO_HAND_MIN_SPAN_PX });

  it('is 1 at the start span', () => {
    expect(ratio(300, 300)).toBe(1);
  });

  it('is below 1 when the hands spread (a nearer camera) and above 1 when they come together', () => {
    expect(ratio(300, 400)).toBeLessThan(1);
    expect(ratio(300, 200)).toBeGreaterThan(1);
  });

  it('subtracts the dead zone from the change, so leaving it does not jump', () => {
    expect(ratio(300, 300 + ZOOM_DEAD_ZONE_PX)).toBe(1);
    expect(ratio(300, 300 - ZOOM_DEAD_ZONE_PX)).toBe(1);
    expect(ratio(300, 300 + ZOOM_DEAD_ZONE_PX + 1)).toBeCloseTo(300 / 301, 10);
    expect(ratio(300, 400)).toBeCloseTo(300 / (400 - ZOOM_DEAD_ZONE_PX), 10);
    expect(ratio(300, 200)).toBeCloseTo(300 / (200 + ZOOM_DEAD_ZONE_PX), 10);
  });

  it('never takes either span below the minimum span', () => {
    // Together to nothing: the effective span stops at the minimum, so the ratio is bounded.
    expect(ratio(300, 0)).toBeCloseTo(300 / TWO_HAND_MIN_SPAN_PX, 10);
    expect(ratio(300, 10)).toBe(ratio(300, 0));
    // Starting closer than the minimum counts as the minimum.
    expect(ratio(20, 20)).toBe(1);
    expect(ratio(20, 200)).toBeCloseTo(TWO_HAND_MIN_SPAN_PX / (20 + 200 - 20 - ZOOM_DEAD_ZONE_PX), 10);
    expect(ratio(0, 0)).toBe(1);
  });
});
describe('moving a whole object (Task 7, requirement 92)', () => {
  const world = new Matrix4();
  it('moves the stored position in the world frame, in the camera plane, at the depth of the held point', () => {
    const camera = cameraAt(new Vector3(0, 0, 5));
    const start = { x: 0.2, y: 0.1, z: -0.3 };
    const metresPerPixel = (2 * 5 * Math.tan((FOV * Math.PI) / 360)) / VIEWPORT_HEIGHT;
    const moved = move(camera, { parentWorld: world, start, hit: { x: 0, y: 0, z: 0 }, offset: { x: 100, y: -40 } });
    expect(moved.x).toBeCloseTo(0.2 + 100 * 1.5 * metresPerPixel, 4);
    expect(moved.y).toBeCloseTo(0.1 + 40 * 1.5 * metresPerPixel, 4);
    expect(moved.z).toBeCloseTo(-0.3, 5);
  });
  it('does not jump at offset 0 and moves finer with the camera closer to the held point', () => {
    const start = { x: 1.25, y: -2, z: 0.5 };
    expect(move(cameraAt(new Vector3(0, 0, 5)), { parentWorld: world, start, offset: { x: 0, y: 0 } })).toEqual(start);
    const far = move(cameraAt(new Vector3(0, 0, 8)), { parentWorld: world, offset: { x: 100, y: 0 } }).x;
    const near = move(cameraAt(new Vector3(0, 0, 4)), { parentWorld: world, offset: { x: 100, y: 0 } }).x;
    expect(near).toBeCloseTo(far / 2, 5);
  });
  it('moves in the camera plane of a rotated camera, whatever the object\'s own rotation (the position is a world position)', () => {
    const camera = cameraAt(new Vector3(4, 3, 4));
    const moved = move(camera, { parentWorld: world, offset: { x: 80, y: 30 } });
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(asVector3(moved).dot(forward)).toBeCloseTo(0, 5);
    expect(asVector3(moved).length()).toBeGreaterThan(0.01);
  });
  it('rounds to 5 decimals and clamps to ±100 m per axis', () => {
    const camera = cameraAt(new Vector3(0, 0, 5));
    const moved = move(camera, { parentWorld: world, start: { x: 0.123456789, y: 0, z: 0 }, offset: { x: 33.3, y: 0 } });
    for (const value of [moved.x, moved.y, moved.z]) expect(Number(value.toFixed(5))).toBe(value);
    const far = move(camera, { parentWorld: world, start: { x: 99.9, y: -99.9, z: 0 }, offset: { x: 100000, y: 100000 } });
    expect(far.x).toBe(100);
    expect(far.y).toBe(-100);
  });
});

describe('explodeAmount', () => {
  const amount = (start: number, startSpan: number, span: number, viewportHeight = 800) =>
    explodeAmount({ start, startSpan, span, deadZonePx: EXPLODE_DEAD_ZONE_PX, viewportHeight, fullFraction: EXPLODE_FULL_FRACTION });
  it('is the start amount at the start span, and inside the dead zone', () => {
    expect(amount(0, 300, 300)).toBe(0);
    expect(amount(0.4, 300, 300 + EXPLODE_DEAD_ZONE_PX)).toBe(0.4);
    expect(amount(0.4, 300, 300 - EXPLODE_DEAD_ZONE_PX)).toBe(0.4);
  });
  it('rises when the hands spread and falls when they come together, by the change beyond the dead zone over half the viewport height', () => {
    // Half the viewport height is 400 px: 112 px beyond the dead zone is 0.28.
    expect(amount(0, 300, 300 + EXPLODE_DEAD_ZONE_PX + 112)).toBe(0.28);
    expect(amount(0.5, 300, 300 - EXPLODE_DEAD_ZONE_PX - 100)).toBe(0.25);
    expect(amount(0.5, 300, 400)).toBeGreaterThan(0.5);
    expect(amount(0.5, 300, 200)).toBeLessThan(0.5);
  });
  it('goes from assembled to fully exploded over EXPLODE_FULL_FRACTION of the viewport height', () => {
    expect(amount(0, 300, 300 + EXPLODE_DEAD_ZONE_PX + EXPLODE_FULL_FRACTION * 800)).toBe(1);
    expect(amount(0, 300, 300 + EXPLODE_DEAD_ZONE_PX + EXPLODE_FULL_FRACTION * 400, 400)).toBe(1);
  });
  it('clamps to 0..1', () => {
    expect(amount(0.9, 300, 3000)).toBe(1);
    expect(amount(0.1, 300, 0)).toBe(0);
    expect(amount(0, 300, 0)).toBe(0);
  });
  it('rounds to 0.01', () => {
    const value = amount(0, 300, 300 + EXPLODE_DEAD_ZONE_PX + 123);
    expect(value).toBe(0.31);
    expect(Math.round(value * 100)).toBeCloseTo(value * 100, 10);
    expect(amount(0.333, 300, 300)).toBe(0.33);
  });
});