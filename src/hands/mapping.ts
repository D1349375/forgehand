import type { HandLandmarks } from '../try-on/arm-pose';
import { CURSOR_POINT, type CursorPoint } from './constants';
import type { HandSample, Point } from './types';

export interface ViewBox { left: number; top: number; width: number; height: number }
export interface VideoSize { width: number; height: number }

const LANDMARKS = 21;
const THUMB_TIP = 4;
const INDEX_KNUCKLE = 5;
const INDEX_TIP = 8;

/**
 * Normalised landmark (display space) to client pixels. Landmarks are already
 * flipped when the video is mirrored, so this only undoes `object-fit: cover`:
 * the video is scaled to cover `view` and centred, and the overflow is cropped.
 */
export function landmarkToClient(point: { x: number; y: number }, view: ViewBox, video: VideoSize): Point {
  const scale = Math.max(view.width / video.width, view.height / video.height);
  const offsetX = (view.width - video.width * scale) / 2;
  const offsetY = (view.height - video.height * scale) / 2;
  return { x: view.left + offsetX + point.x * video.width * scale, y: view.top + offsetY + point.y * video.height * scale };
}

function finite(point: { x: number; y: number } | undefined): point is { x: number; y: number } {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

/** The distance between world landmarks 4 and 8 in metres, or null when either is missing. */
function pinchDistance(hand: HandLandmarks): number | null {
  const a = hand.world?.[THUMB_TIP];
  const b = hand.world?.[INDEX_TIP];
  if (!a || !b) return null;
  const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return Number.isFinite(distance) ? distance : null;
}

/**
 * One hand as screen points, cursor and pinch distance. Null for a hand with
 * fewer than 21 finite points or a view or video without a size.
 */
export function handSample(hand: HandLandmarks, view: ViewBox, video: VideoSize, cursorPoint: CursorPoint = CURSOR_POINT): HandSample | null {
  if (hand.points.length < LANDMARKS || !(view.width > 0 && view.height > 0 && video.width > 0 && video.height > 0)) return null;
  const points: Point[] = [];
  for (let index = 0; index < LANDMARKS; index++) {
    const landmark = hand.points[index];
    if (!finite(landmark)) return null;
    points.push(landmarkToClient(landmark, view, video));
  }
  const cursor = cursorPoint === 'index-knuckle'
    ? points[INDEX_KNUCKLE]!
    : { x: (points[THUMB_TIP]!.x + points[INDEX_TIP]!.x) / 2, y: (points[THUMB_TIP]!.y + points[INDEX_TIP]!.y) / 2 };
  return { points, cursor: { x: cursor.x, y: cursor.y }, pinchM: pinchDistance(hand) };
}
