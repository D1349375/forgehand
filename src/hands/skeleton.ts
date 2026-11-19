import { LINK_COLOUR, type OverlayStyle } from './style';
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
const RING_RADIUS = 14;
/** A ring at the cursor: hollow over a target, filled while a gesture acts. Other marks draw nothing here. */
export function drawRing(ctx: CanvasRenderingContext2D, cursor: Point, style: OverlayStyle): void {
  if (style.mark !== 'ring-hollow' && style.mark !== 'ring-filled') return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, RING_RADIUS, 0, Math.PI * 2);
  if (style.mark === 'ring-filled') {
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = style.colour;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = OUTLINE_COLOUR;
  ctx.lineWidth = style.lineWidth + OUTLINE_EXTRA;
  ctx.stroke();
  ctx.strokeStyle = style.colour;
  ctx.lineWidth = style.lineWidth;
  ctx.stroke();
  ctx.restore();
}

export interface Box { x: number; y: number; width: number; height: number }
const BADGE_FONT = '13px sans-serif';
const BADGE_PADDING_X = 8;
const BADGE_HEIGHT = 22;
/** The badge sits this far right of and above the cursor. */
const BADGE_OFFSET = 16;

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Where a badge goes: 16 px right of and above the cursor, moved to the left of or below the cursor
 * when it would leave the canvas, and always clamped inside it. When it would overlap `avoid`
 * (the other hand's badge) it goes below the cursor instead.
 */
export function badgeBox(cursor: Point, textWidth: number, canvas: { width: number; height: number }, avoid?: Box | null): Box {
  const width = textWidth + BADGE_PADDING_X * 2;
  const height = BADGE_HEIGHT;
  const place = (below: boolean): Box => {
    let x = cursor.x + BADGE_OFFSET;
    let y = below ? cursor.y + BADGE_OFFSET : cursor.y - BADGE_OFFSET - height;
    if (x + width > canvas.width) x = cursor.x - BADGE_OFFSET - width;
    if (y < 0) y = cursor.y + BADGE_OFFSET;
    if (y + height > canvas.height) y = cursor.y - BADGE_OFFSET - height;
    return {
      x: Math.max(0, Math.min(x, canvas.width - width)),
      y: Math.max(0, Math.min(y, canvas.height - height)),
      width,
      height,
    };
  };
  const box = place(false);
  return avoid && overlaps(box, avoid) ? place(true) : box;
}

/** Draws a badge for `cursor` and returns its box, which the second hand's badge passes as `avoid`. */
export function drawBadge(ctx: CanvasRenderingContext2D, text: string, cursor: Point, canvas: { width: number; height: number }, avoid?: Box | null): Box {
  ctx.save();
  ctx.font = BADGE_FONT;
  const box = badgeBox(cursor, ctx.measureText(text).width, canvas, avoid);
  ctx.fillStyle = 'rgba(8, 16, 22, 0.82)';
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.width, box.height, 6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, box.x + BADGE_PADDING_X, box.y + box.height / 2);
  ctx.restore();
  return box;
}

/** The line between the two hands while a two-hand gesture runs. */
export function drawLink(ctx: CanvasRenderingContext2D, link: { from: Point; to: Point }, colour: string = LINK_COLOUR): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(link.from.x, link.from.y);
  ctx.lineTo(link.to.x, link.to.y);
  ctx.strokeStyle = OUTLINE_COLOUR;
  ctx.lineWidth = 3 + OUTLINE_EXTRA;
  ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}
