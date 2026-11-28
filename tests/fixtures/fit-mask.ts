import type { SegmentCrop } from '../../src/try-on/arm-pose';
import type { SkinMask } from '../../src/fit/mask';

/**
 * Synthetic wrist masks for unit and e2e tests (body fit, design 12): a forearm band of a given width along an axis,
 * with anti-aliased edges, and an optional sleeve. They are drawn the way the worker's crop is cut: each mask pixel is
 * mapped into the frame through the crop (`maskToFrame` in src/fit/mask.ts), so the crop's centre, size and angle matter.
 */
export interface ForearmSpec {
  /** The crop the mask belongs to (frame pixels). */
  crop: SegmentCrop;
  /** A point on the forearm axis, in frame pixels. */
  point: { x: number; y: number };
  /** The direction of the axis in the frame, toward the hand, in degrees (y down, 0 along +x). */
  axisDeg: number;
  /** Width of the forearm in frame pixels. */
  widthPx: number;
  /** Width of the edge ramp in mask pixels: 0 is a hard step, 2 spreads the edge over two pixels. Default 1. */
  blurMaskPx?: number;
  /** Mask side. Default 256. */
  size?: number;
  /**
   * A sleeve from `fromPx` frame pixels past `point` toward the elbow: skin ends there and clothes (a sleeve `extraPx` wider
   * on each side) take over.
   */
  sleeve?: { fromPx: number; extraPx: number };
}

/**
 * The skin and clothes planes (bytes, rows from the top) of a forearm in a crop. This function reads nothing outside its
 * argument: the e2e fake worker (tests/e2e/fake-body.ts) embeds its source with `toString()`, so keep it self-contained.
 */
export function forearmMask(spec: ForearmSpec): { skin: Uint8Array; clothes: Uint8Array } {
  const size = spec.size ?? 256;
  const crop = spec.crop;
  const angle = crop.angleDeg * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const axis = spec.axisDeg * Math.PI / 180;
  const dirX = Math.cos(axis);
  const dirY = Math.sin(axis);
  const ramp = Math.max(spec.blurMaskPx ?? 1, 1e-6) * crop.size / size;
  const cover = (distance: number, half: number) => Math.min(1, Math.max(0, 0.5 + (half - distance) / ramp));
  const skin = new Uint8Array(size * size);
  const clothes = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const u = ((column + 0.5) / size - 0.5) * crop.size;
      const v = ((row + 0.5) / size - 0.5) * crop.size;
      const relX = crop.x + u * cos - v * sin - spec.point.x;
      const relY = crop.y + u * sin + v * cos - spec.point.y;
      const along = relX * dirX + relY * dirY;
      const across = Math.abs(relX * dirY - relY * dirX);
      const arm = cover(across, spec.widthPx / 2);
      let skinValue = arm;
      let clothesValue = 0;
      if (spec.sleeve) {
        const inside = Math.min(1, Math.max(0, 0.5 + (-along - spec.sleeve.fromPx) / ramp));
        skinValue = arm * (1 - inside);
        clothesValue = inside * cover(across, spec.widthPx / 2 + spec.sleeve.extraPx);
      }
      skin[row * size + column] = Math.round(skinValue * 255);
      clothes[row * size + column] = Math.round(clothesValue * 255);
    }
  }
  return { skin, clothes };
}

/** A complete mask result as the worker would send it. */
export function forearmSkinMask(spec: ForearmSpec, timestamp = 0): SkinMask {
  return { size: spec.size ?? 256, crop: spec.crop, ...forearmMask(spec), ms: 0, timestamp };
}
