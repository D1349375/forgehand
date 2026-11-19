import type { OverlayStyle } from './style';
import type { Point } from './types';

/** The 21 connections of the MediaPipe hand model: palm, then thumb, index, middle, ring and little finger. */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 5], [9, 13], [13, 17], [5, 9], [0, 17],
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];

const OUTLINE_COLOUR = 'rgba(4, 12, 18, 0.85)';
/** The dark outline is 1 px wider on each side so the lines read on skin and on bright video. */
const OUTLINE_EXTRA = 2;
const DASH = [6, 5];

/** Draws the skeleton with `ctx` already set up for the points' coordinates. */
export function drawHand(ctx: CanvasRenderingContext2D, points: readonly Point[], style: OverlayStyle): void {
  if (points.length < 21) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(style.dashed ? DASH : []);
  ctx.beginPath();
  for (const [from, to] of HAND_CONNECTIONS) {
    ctx.moveTo(points[from]!.x, points[from]!.y);
    ctx.lineTo(points[to]!.x, points[to]!.y);
  }
  ctx.strokeStyle = OUTLINE_COLOUR;
  ctx.lineWidth = style.lineWidth + OUTLINE_EXTRA;
  ctx.stroke();
  ctx.strokeStyle = style.colour;
  ctx.lineWidth = style.lineWidth;
  ctx.stroke();

  ctx.setLineDash([]);
  const radius = style.lineWidth + 1;
  ctx.beginPath();
  for (const point of points) {
    ctx.moveTo(point.x + radius, point.y);
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  }
  ctx.fillStyle = style.colour;
  ctx.strokeStyle = OUTLINE_COLOUR;
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
