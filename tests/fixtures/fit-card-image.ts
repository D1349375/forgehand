import { frameToGuide, type CardEdges, type CardGuide, type PixelImage } from '../../src/fit/card';

/**
 * Synthetic camera pictures with a card for unit tests of the card calibration (body fit, Task 3).
 */
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** A seeded pseudo-random generator (mulberry32), so a failing case can be replayed. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A grey frame with a lighter card drawn into it: the card's edges are given in the guide's coordinates, the edges are
 * anti-aliased over one pixel, and every pixel gets noise of +-`noise` grey levels.
 */
export function renderCard(guide: CardGuide, card: CardEdges | null, options: { width?: number; height?: number; background?: number; contrast?: number; noise?: number; seed?: number } = {}): PixelImage {
  const { width = 640, height = 480, background = 90, contrast = 80, noise = 3, seed = 1 } = options;
  const next = random(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let cover = 0;
      if (card) {
        const local = frameToGuide(guide, { x: x + 0.5, y: y + 0.5 });
        cover = clamp01(0.5 + local.x - card.left) * clamp01(0.5 + card.right - local.x) * clamp01(0.5 + local.y - card.top) * clamp01(0.5 + card.bottom - local.y);
      }
      const value = background + contrast * cover + (next() * 2 - 1) * noise;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

