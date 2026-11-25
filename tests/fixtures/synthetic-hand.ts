import type { HandLandmarks, Landmark } from '../../src/try-on/arm-pose';

export interface SyntheticHandOptions {
  /** Midpoint of thumb tip (4) and index tip (8) in normalised display coordinates (0..1, y down). */
  cursor: { x: number; y: number };
  /** Metric distance between landmarks 4 and 8 in the world landmarks, in metres. */
  pinchM: number;
  /** Hand height as a fraction of the frame height. Default 0.25. */
  size?: number;
  side?: 'left' | 'right';
  /** `false` drops the world landmarks. */
  world?: boolean;
  /**
   * A closed fist: the four fingertips sit 35 % of the way from their knuckle to the wrist (curl ratio about 0.65) and the thumb tip
   * 6 cm from the index tip (no pinch). `cursor` then places the palm centre instead of the pinch midpoint, and `pinchM` is ignored.
   */
  fist?: boolean;
  /**
   * Turns the hand in the image plane about the point cursor places (the pinch midpoint of an open hand, the palm centre of a fist),
   * in degrees; positive is clockwise on screen (y grows down), like pairAngle. The world landmarks turn by the same angle, so
   * distances (pinch, curl) do not change. Default 0.
   */
  roll?: number;
  /**
   * A pinch with the other three fingers curled (Task 12): the middle, ring and little fingertips sit 35 % of the way from their
   * knuckle to the wrist, like a fist's, while the thumb and index finger make the pinch at `cursor`. Ignored with `fist`.
   */
  curledFingers?: boolean;
  /**
   * With `curledFingers`: the index fingertip is drawn in toward the wrist until its tip-to-wrist distance is this multiple of its
   * knuckle-to-wrist distance (the index finger bends toward the thumb in a tight pinch), and the thumb tip follows it. This is the
   * curl ratio of the index finger, which is the largest of the four while the other fingers are curled. Default: the index stays
   * extended (ratio about 1.37).
   */
  indexRatio?: number;
  /**
   * Width divided by height of the video frame, default 1. Normalised x and y are different lengths on a non-square frame, so the
   * `roll` is applied on a scale where they are equal, which makes it a true rotation on screen.
   */
  aspect?: number;
}

/** Hand height in metres (wrist to middle fingertip) in the local layout below. */
const LAYOUT_HEIGHT_M = 0.18;
/** Distance between the thumb tip and the index tip of the synthetic fist, in metres. */
const FIST_THUMB_GAP_M = 0.06;
type Pair = readonly [number, number];

const lerp = (a: Pair, b: Pair, t: number): Pair => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * A flat, open hand in metres relative to the pinch point (y down). The palm is
 * 8 cm wide (landmarks 5 to 17) and the wrist is 9.5 cm below the middle knuckle. Thumb tip and index tip sit `pinchM` apart,
 * centred on the origin. With `fist` the fingertips are curled to 35 % of the way from the knuckle to the wrist, and the thumb tip
 * sits 6 cm from the index tip.
 */
function localLayout(pinchM: number, fist: boolean, curledFingers = false, indexRatio?: number): Pair[] {
  const half = pinchM / 2;
  const points: Pair[] = Array.from({ length: 21 }, () => [0, 0] as Pair);
  points[0] = [0, 0.14];
  points[1] = [-0.04, 0.1];
  points[2] = [-0.055, 0.065];
  points[4] = [-half, 0];
  points[3] = lerp(points[2]!, points[4]!, 0.5);
  const wrist = points[0]!;
  const fingers: Array<[number, Pair, Pair]> = [
    [5, [-0.04, 0.045], [half, 0]],
    [9, [-0.013, 0.045], [-0.013, -0.04]],
    [13, [0.013, 0.045], [0.013, -0.035]],
    [17, [0.04, 0.05], [0.04, -0.01]],
  ];
  for (const [base, knuckle, open] of fingers) {
    const tip = fist || (curledFingers && base !== 5) ? lerp(knuckle, wrist, 0.35) : open;
    points[base] = knuckle;
    points[base + 1] = lerp(knuckle, tip, 1 / 3);
    points[base + 2] = lerp(knuckle, tip, 2 / 3);
    points[base + 3] = tip;
  }
  if (fist) {
    // The thumb tip stays away from the index tip: a fist is not a pinch.
    const index = points[8]!;
    points[4] = [index[0] - FIST_THUMB_GAP_M, index[1]];
    points[3] = lerp(points[2]!, points[4]!, 0.5);
  }
  if (!fist && curledFingers && indexRatio !== undefined) {
    // Draw the index tip in along the line from the wrist until its tip-to-wrist distance is `indexRatio` times the knuckle-to-wrist
    // distance, put the thumb tip `pinchM` to its left, and move everything so that the pinch midpoint is the origin again.
    const knuckle = points[5]!;
    const tip = points[8]!;
    const base = Math.hypot(knuckle[0] - wrist[0], knuckle[1] - wrist[1]);
    const length = Math.hypot(tip[0] - wrist[0], tip[1] - wrist[1]);
    const bent: Pair = [wrist[0] + ((tip[0] - wrist[0]) / length) * indexRatio * base, wrist[1] + ((tip[1] - wrist[1]) / length) * indexRatio * base];
    points[8] = bent;
    points[7] = lerp(knuckle, bent, 2 / 3);
    points[6] = lerp(knuckle, bent, 1 / 3);
    points[4] = [bent[0] - pinchM, bent[1]];
    points[3] = lerp(points[2]!, points[4]!, 0.5);
    const mid: Pair = [(points[4]![0] + bent[0]) / 2, (points[4]![1] + bent[1]) / 2];
    return points.map(([x, y]) => [x - mid[0], y - mid[1]] as Pair);
  }
  return points;
}

/** 21 image landmarks, and 21 world landmarks unless `world: false`. Used by unit tests and the e2e fake worker. */
export function syntheticHand({
  cursor, pinchM, size = 0.25, side = 'right', world = true, fist = false, roll = 0, aspect = 1, curledFingers = false, indexRatio,
}: SyntheticHandOptions): HandLandmarks {
  const flip = side === 'left' ? -1 : 1;
  const local = localLayout(pinchM, fist, curledFingers, indexRatio).map(([x, y]) => [x * flip, y] as Pair);
  const palm = [0, 5, 9, 13, 17].map(index => local[index]!);
  const centre: Pair = [palm.reduce((sum, p) => sum + p[0], 0) / palm.length, palm.reduce((sum, p) => sum + p[1], 0) / palm.length];
  // The cursor is the pinch midpoint of an open hand and the palm centre of a fist.
  const origin: Pair = fist ? centre : [0, 0];
  const scale = size / LAYOUT_HEIGHT_M;
  const angle = (roll * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const points: Landmark[] = local.map(([x, y]) => {
    // On a scale where normalised x and y are equal, so the roll is a true rotation on screen.
    const dx = (x - origin[0]) * scale * aspect;
    const dy = (y - origin[1]) * scale;
    return { x: cursor.x + (dx * cos - dy * sin) / aspect, y: cursor.y + dx * sin + dy * cos, z: 0, visibility: 1 };
  });
  const result: HandLandmarks = { points, side };
  if (!world) return result;
  return {
    ...result,
    world: local.map(([x, y]) => {
      const dx = x - centre[0];
      const dy = y - centre[1];
      return { x: dx * cos - dy * sin, y: dx * sin + dy * cos, z: 0, visibility: 1 };
    }),
  };
}

/**
 * The inverse of the `object-fit: cover` mapping of the camera video: a client
 * point in `view` (the video element's rectangle) to normalised coordinates of
 * the video frame. The frame is already mirrored for display, so no flip.
 */
export function clientToNormalized(point: { x: number; y: number },
  view: { left: number; top: number; width: number; height: number }, video: { width: number; height: number }): { x: number; y: number } {
  const scale = Math.max(view.width / video.width, view.height / video.height);
  const shownWidth = video.width * scale;
  const shownHeight = video.height * scale;
  return {
    x: (point.x - view.left - (view.width - shownWidth) / 2) / shownWidth,
    y: (point.y - view.top - (view.height - shownHeight) / 2) / shownHeight,
  };
}
