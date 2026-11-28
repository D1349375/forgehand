import { CROP_SIDE_MM, SEGMENT_SIZE } from '../../shared/fit-constants';
import type { SegmentCrop, SegmentMask } from '../try-on/arm-pose';

/**
 * The wrist crop and its mask (body fit, design 4.1, 4.2). Pure functions: the worker and the page both use them,
 * so the crop that is drawn and the crop that is read back can never disagree.
 *
 * Mask coordinates are continuous: the crop covers [0, size] in x and y, pixel (i, j) covers [i, i + 1] x [j, j + 1],
 * and its centre is (i + 0.5, j + 0.5). The crop centre (size / 2, size / 2) is frame point (crop.x, crop.y). The
 * mask x axis points along (cos a, sin a) in the frame and the mask y axis along (-sin a, cos a), a = crop.angleDeg,
 * so a crop with angle 0 is an upright cut-out and a positive angle turns the cut-out clockwise on screen (y is down).
 */
export type SkinMask = SegmentMask;
export interface Point { x: number; y: number }

const rad = (deg: number) => deg * Math.PI / 180;

/** The frame point (frame pixels) of a mask point. */
export function maskToFrame(crop: SegmentCrop, mx: number, my: number, size = SEGMENT_SIZE): Point {
  const u = (mx / size - 0.5) * crop.size;
  const v = (my / size - 0.5) * crop.size;
  const cos = Math.cos(rad(crop.angleDeg));
  const sin = Math.sin(rad(crop.angleDeg));
  return { x: crop.x + u * cos - v * sin, y: crop.y + u * sin + v * cos };
}

/** The mask point of a frame point: the inverse of `maskToFrame`. */
export function frameToMask(crop: SegmentCrop, fx: number, fy: number, size = SEGMENT_SIZE): Point {
  const dx = fx - crop.x;
  const dy = fy - crop.y;
  const cos = Math.cos(rad(crop.angleDeg));
  const sin = Math.sin(rad(crop.angleDeg));
  return { x: (( dx * cos + dy * sin) / crop.size + 0.5) * size, y: ((-dx * sin + dy * cos) / crop.size + 0.5) * size };
}

/**
 * The arguments of `CanvasRenderingContext2D.setTransform(a, b, c, d, e, f)` that draw the frame (in frame pixels)
 * into a `size` x `size` canvas so that the canvas shows the crop. It is the inverse of `maskToFrame`.
 */
export function cropTransform(crop: SegmentCrop, size = SEGMENT_SIZE): [number, number, number, number, number, number] {
  const k = size / crop.size;
  const cos = Math.cos(rad(crop.angleDeg));
  const sin = Math.sin(rad(crop.angleDeg));
  return [k * cos, -k * sin, k * sin, k * cos, size / 2 - k * (cos * crop.x + sin * crop.y), size / 2 - k * (-sin * crop.x + cos * crop.y)];
}

/** The crop for a band position: side `CROP_SIDE_MM` at the scale, turned so that `distal` (a frame direction, toward the hand) points up in the crop. */
export function wristCrop(centre: Point, distal: Point, mmPerPx: number): SegmentCrop {
  return { x: centre.x, y: centre.y, size: CROP_SIDE_MM / mmPerPx, angleDeg: Math.atan2(distal.x, -distal.y) * 180 / Math.PI };
}

/** Confidence at a mask point (0..1), bilinear between pixel centres. Outside the mask: 0. */
export function sample(plane: Uint8Array, size: number, mx: number, my: number): number {
  if (!(mx >= 0 && mx <= size && my >= 0 && my <= size)) return 0;
  const fx = Math.min(Math.max(mx - 0.5, 0), size - 1);
  const fy = Math.min(Math.max(my - 0.5, 0), size - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number) => plane[y * size + x]! / 255;
  const x1 = Math.min(x0 + 1, size - 1);
  const y1 = Math.min(y0 + 1, size - 1);
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}

/** Confidences (0..1) to bytes, clamped and rounded. */
export function quantize(values: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    bytes[i] = value >= 1 ? 255 : value > 0 ? Math.round(value * 255) : 0;
  }
  return bytes;
}

/** Mean luma (0..1) of RGBA pixels: 0.2126 R + 0.7152 G + 0.0722 B on the sRGB values, no linearisation (design 4.2). */
export function lumaOf(rgba: ArrayLike<number>): number {
  const pixels = Math.floor(rgba.length / 4);
  if (!pixels) return 0;
  let sum = 0;
  for (let i = 0; i < pixels; i++) sum += 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
  return sum / (pixels * 255);
}
