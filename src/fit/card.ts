import {
  ASSUMED_HFOV_DEG, CARD_ASPECT_TOLERANCE, CARD_DEFAULT_THICKNESS_MM, CARD_EDGE_CONFIDENCE, CARD_K_MAX, CARD_K_MIN, CARD_LONG_MM,
  CARD_SEARCH_FRACTION, CARD_SHORT_MM,
} from '../../shared/fit-constants';

/**
 * Card calibration maths (body fit, design 6.3, R11 to R17). Pure: no DOM. Lengths in frame pixels unless a name says
 * millimetres. Frame pixels are the pixels of the (mirrored) camera frame, y down.
 *
 * The guide has its own axes: `u` along the card's long edge, `v` across it, both through the guide centre.
 * `u` is (cos a, sin a) and `v` is (-sin a, cos a) with a = `guide.angleDeg`, which is kept in (-90, 90] so that `u` points
 * to the right on the screen (down for a vertical arm) and `v` points down.
 */
export interface Point { x: number; y: number }

export interface CardGuide {
  centre: Point;
  angleDeg: number;
  /** Length of the long edge, in pixels, as the scale estimate expects it. */
  longPx: number;
  shortPx: number;
}

/** Positions of the four card edges in guide coordinates: the two short edges at `left` and `right` (along u), the two long edges at `top` and `bottom` (along v). */
export interface CardEdges { left: number; right: number; top: number; bottom: number }
export type CardEdge = keyof CardEdges;

const rad = (deg: number) => deg * Math.PI / 180;

/**
 * The guide frame: centred at `centre`, its long axis along the forearm (`distal` is a frame direction, any length),
 * sized for a card at `mmPerPx` (the current scale estimate).
 */
export function cardGuide(input: { centre: Point; distal: Point; mmPerPx: number }): CardGuide {
  let angle = Math.atan2(input.distal.y, input.distal.x) * 180 / Math.PI;
  if (angle > 90) angle -= 180;
  else if (angle <= -90) angle += 180;
  return { centre: input.centre, angleDeg: angle, longPx: CARD_LONG_MM / input.mmPerPx, shortPx: CARD_SHORT_MM / input.mmPerPx };
}

/** The edges of a card exactly as big as the guide. */
export const guideEdges = (guide: CardGuide): CardEdges => ({
  left: -guide.longPx / 2, right: guide.longPx / 2, top: -guide.shortPx / 2, bottom: guide.shortPx / 2,
});

/** The frame point of guide coordinates `(u, v)`. */
export function guideToFrame(guide: CardGuide, u: number, v: number): Point {
  const a = rad(guide.angleDeg);
  return { x: guide.centre.x + u * Math.cos(a) - v * Math.sin(a), y: guide.centre.y + u * Math.sin(a) + v * Math.cos(a) };
}

/** The guide coordinates of a frame point: the inverse of `guideToFrame`. */
export function frameToGuide(guide: CardGuide, point: Point): Point {
  const a = rad(guide.angleDeg);
  const dx = point.x - guide.centre.x;
  const dy = point.y - guide.centre.y;
  return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
}

/** The four corners of the card, clockwise from its top-left corner, in frame pixels. */
export function cardCorners(guide: CardGuide, edges: CardEdges): [Point, Point, Point, Point] {
  return [
    guideToFrame(guide, edges.left, edges.top), guideToFrame(guide, edges.right, edges.top),
    guideToFrame(guide, edges.right, edges.bottom), guideToFrame(guide, edges.left, edges.bottom),
  ];
}

/** Whether the whole guide lies inside a frame of `width` x `height` pixels. */
export function guideInsideFrame(guide: CardGuide, frame: { width: number; height: number }): boolean {
  return cardCorners(guide, guideEdges(guide)).every(point => point.x >= 0 && point.x <= frame.width && point.y >= 0 && point.y <= frame.height);
}

/**
 * The mapping of `object-fit: cover` between camera frame pixels and the pixels of the box that shows them (client pixels
 * of the layer): `scale` client pixels per frame pixel and the offset of the frame's top-left corner. The camera frame is
 * already mirrored like the display, so no flip is needed (see `clientToNormalized` in tests/fixtures/synthetic-hand.ts).
 */
export interface CoverMap { scale: number; offsetX: number; offsetY: number }
export function coverMap(view: { width: number; height: number }, frame: { width: number; height: number }): CoverMap {
  const scale = Math.max(view.width / frame.width, view.height / frame.height);
  return { scale, offsetX: (view.width - frame.width * scale) / 2, offsetY: (view.height - frame.height * scale) / 2 };
}
export const frameToView = (map: CoverMap, point: Point): Point => ({ x: map.offsetX + point.x * map.scale, y: map.offsetY + point.y * map.scale });
export const viewToFrame = (map: CoverMap, point: Point): Point => ({ x: (point.x - map.offsetX) / map.scale, y: (point.y - map.offsetY) / map.scale });

// ---------------------------------------------------------------------------
// Edge finding

/** RGBA pixels, like `ImageData`. */
export interface PixelImage { data: ArrayLike<number>; width: number; height: number }

export interface CardDetection {
  edges: CardEdges;
  /** Every edge had a gradient peak of at least `CARD_EDGE_CONFIDENCE` times the median gradient. When false, the edges that fell short sit on the guide line (R14). */
  found: boolean;
  /** Peak over median gradient, per edge. */
  confidence: Record<CardEdge, number>;
}

/** Grey level at a continuous frame point, bilinear between pixel centres; points outside the image take the nearest border pixel. */
function greyAt(image: PixelImage, x: number, y: number): number {
  const fx = Math.min(Math.max(x - 0.5, 0), image.width - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), image.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, image.width - 1);
  const y1 = Math.min(y0 + 1, image.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const grey = (px: number, py: number) => {
    const i = (py * image.width + px) * 4;
    return 0.299 * image.data[i]! + 0.587 * image.data[i + 1]! + 0.114 * image.data[i + 2]!;
  };
  return (grey(x0, y0) * (1 - tx) + grey(x1, y0) * tx) * (1 - ty) + (grey(x0, y1) * (1 - tx) + grey(x1, y1) * tx) * ty;
}

const medianOf = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The peak of `profile` (indices `from` to `to`) refined with a parabola through its neighbours, and its height. */
function peakOf(profile: readonly number[], from: number, to: number): { index: number; height: number } {
  let best = Math.max(from, 1);
  for (let i = best; i <= Math.min(to, profile.length - 2); i++) if (profile[i]! > profile[best]!) best = i;
  const before = profile[best - 1]!, here = profile[best]!, after = profile[best + 1]!;
  const denominator = before - 2 * here + after;
  const shift = denominator < -1e-9 ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator)) : 0;
  return { index: best + shift, height: here };
}

/**
 * Finds the four edges of a card inside the guide on a frozen frame (design 6.3): the frame around the guide is resampled
 * into guide coordinates, Sobel gradients are taken along `u` (for the two short edges) and along `v` (for the two long
 * edges), the gradient magnitude is averaged along each edge over the middle 80 % of the card's other side, and for each edge
 * the position of the largest average within `CARD_SEARCH_FRACTION` of the card's side around the guide line is the edge.
 * Its confidence is the peak over the median of the average over the whole patch; below `CARD_EDGE_CONFIDENCE` the edge
 * is the guide line.
 */
export function findCardEdges(image: PixelImage, guide: CardGuide): CardDetection {
  const half = { u: guide.longPx / 2, v: guide.shortPx / 2 };
  const reach = { u: half.u + CARD_SEARCH_FRACTION * guide.longPx + 3, v: half.v + CARD_SEARCH_FRACTION * guide.shortPx + 3 };
  const columns = Math.ceil(2 * reach.u) + 1;
  const rows = Math.ceil(2 * reach.v) + 1;
  const originU = -(columns - 1) / 2;
  const originV = -(rows - 1) / 2;
  const grey = new Float32Array(columns * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const point = guideToFrame(guide, originU + i, originV + j);
      grey[j * columns + i] = greyAt(image, point.x, point.y);
    }
  }
  const at = (i: number, j: number) => grey[Math.min(rows - 1, Math.max(0, j)) * columns + Math.min(columns - 1, Math.max(0, i))]!;
  const gradU = (i: number, j: number) => Math.abs((at(i + 1, j - 1) + 2 * at(i + 1, j) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1))) / 8;
  const gradV = (i: number, j: number) => Math.abs((at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1))) / 8;

  // Mean gradient along u (one value per column) over the middle of the card's height, and along v (one per row) over the middle of its length.
  const profileU = Array.from({ length: columns }, (_, i) => {
    let sum = 0, count = 0;
    for (let j = 0; j < rows; j++) if (Math.abs(originV + j) <= 0.8 * half.v) { sum += gradU(i, j); count++; }
    return count ? sum / count : 0;
  });
  const profileV = Array.from({ length: rows }, (_, j) => {
    let sum = 0, count = 0;
    for (let i = 0; i < columns; i++) if (Math.abs(originU + i) <= 0.8 * half.u) { sum += gradV(i, j); count++; }
    return count ? sum / count : 0;
  });
  const medianU = Math.max(medianOf(profileU), 1);
  const medianV = Math.max(medianOf(profileV), 1);

  const search = (profile: readonly number[], origin: number, line: number, side: number, median: number) => {
    const from = Math.max(1, Math.floor(line - CARD_SEARCH_FRACTION * side - origin));
    const to = Math.min(profile.length - 2, Math.ceil(line + CARD_SEARCH_FRACTION * side - origin));
    const peak = peakOf(profile, from, to);
    const confidence = peak.height / median;
    return { position: origin + peak.index, confidence };
  };
  const left = search(profileU, originU, -half.u, guide.longPx, medianU);
  const right = search(profileU, originU, half.u, guide.longPx, medianU);
  const top = search(profileV, originV, -half.v, guide.shortPx, medianV);
  const bottom = search(profileV, originV, half.v, guide.shortPx, medianV);
  const line = guideEdges(guide);
  const pick = (found: { position: number; confidence: number }, fallback: number) => (found.confidence >= CARD_EDGE_CONFIDENCE ? found.position : fallback);
  const edges: CardEdges = { left: pick(left, line.left), right: pick(right, line.right), top: pick(top, line.top), bottom: pick(bottom, line.bottom) };
  const confidence = { left: left.confidence, right: right.confidence, top: top.confidence, bottom: bottom.confidence };
  return { edges, found: Object.values(confidence).every(value => value >= CARD_EDGE_CONFIDENCE), confidence };
}

// ---------------------------------------------------------------------------
// The correction factor

export interface CardFactorInput {
  /** The scale estimate on the frozen frame, millimetres per frame pixel, without any earlier calibration (`k` = 1). */
  mmPerPxEstimate: number;
  /** Width of the video frame in pixels, for the focal length of the depth correction. */
  frameWidthPx: number;
  /** The wrist thickness in millimetres, or null before a measurement: `CARD_DEFAULT_THICKNESS_MM`. */
  thicknessMm: number | null;
}

export type CardFactor =
  | { ok: true; k: number; mmPerPxCard: number; mmPerPxCorrected: number; spreadPct: number }
  | { ok: false; reason: 'degenerate' | 'aspect' | 'range'; k: number | null };

/**
 * The correction factor `k` of a card (R15, R16, design 6.3). The card's millimetres per pixel is the mean of what its long
 * edge (85.60 mm) and its short edge (53.98 mm) say. The card lies on the back of the wrist, about half the wrist's
 * thickness nearer to the camera than the line through the arm's centre where the width is read, so the scale at that line is
 * larger by `(z + t / 2) / z`, `z` being the card's distance, from the pinhole model with `ASSUMED_HFOV_DEG`.
 * `k` is that corrected scale over the estimate. Rejected: an aspect ratio more than `CARD_ASPECT_TOLERANCE` away from the card's,
 * or `k` outside `CARD_K_MIN`..`CARD_K_MAX`.
 */
export function cardFactor(edges: CardEdges, input: CardFactorInput): CardFactor {
  const longPx = edges.right - edges.left;
  const shortPx = edges.bottom - edges.top;
  if (!(longPx > 4 && shortPx > 4) || !(input.mmPerPxEstimate > 0) || !(input.frameWidthPx > 0)) return { ok: false, reason: 'degenerate', k: null };
  const aspect = longPx / shortPx / (CARD_LONG_MM / CARD_SHORT_MM);
  if (Math.abs(aspect - 1) > CARD_ASPECT_TOLERANCE) return { ok: false, reason: 'aspect', k: null };
  const mmFromLong = CARD_LONG_MM / longPx;
  const mmFromShort = CARD_SHORT_MM / shortPx;
  const mmPerPxCard = (mmFromLong + mmFromShort) / 2;
  const focalPx = (input.frameWidthPx / 2) / Math.tan(rad(ASSUMED_HFOV_DEG) / 2);
  const distanceMm = focalPx * CARD_LONG_MM / longPx;
  const thickness = input.thicknessMm ?? CARD_DEFAULT_THICKNESS_MM;
  const mmPerPxCorrected = mmPerPxCard * (distanceMm + thickness / 2) / distanceMm;
  const k = mmPerPxCorrected / input.mmPerPxEstimate;
  if (!(k >= CARD_K_MIN && k <= CARD_K_MAX)) return { ok: false, reason: 'range', k };
  return { ok: true, k, mmPerPxCard, mmPerPxCorrected, spreadPct: Math.abs(mmFromLong - mmFromShort) / mmPerPxCard * 100 };
}

/**
 * How far off the estimate was, as the user reads it (R17): the estimate was `percent` too large when `k` < 1 and too
 * small when `k` > 1, measured against the true value. Under 1 % counts as the same.
 */
export function calibrationDirection(k: number): { direction: 'bigger' | 'smaller' | 'same'; percent: number } {
  const percent = k < 1 ? (1 / k - 1) * 100 : (1 - 1 / k) * 100;
  const rounded = Math.round(percent);
  if (rounded < 1) return { direction: 'same', percent: 0 };
  return { direction: k < 1 ? 'bigger' : 'smaller', percent: rounded };
}
