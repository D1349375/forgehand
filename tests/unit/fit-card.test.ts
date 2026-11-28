import { afterAll, describe, expect, it } from 'vitest';
import {
  ASSUMED_HFOV_DEG, CARD_ASPECT_TOLERANCE, CARD_K_MAX, CARD_K_MIN, CARD_LONG_MM, CARD_SHORT_MM,
} from '../../shared/fit-constants';
import {
  calibrationDirection, cardCorners, cardFactor, cardGuide, coverMap, findCardEdges, frameToGuide, frameToView, guideEdges, guideInsideFrame,
  guideToFrame, viewToFrame, type CardEdges,
} from '../../src/fit/card';
import { renderCard } from '../fixtures/fit-card-image';
import { checkProperty, fc, printPropertyReport } from '../fixtures/fit-property';

afterAll(() => printPropertyReport('fit-card'));

describe('the guide frame (R11)', () => {
  it('is sized for a card at the estimated scale and lies along the arm', () => {
    const guide = cardGuide({ centre: { x: 300, y: 200 }, distal: { x: 0, y: -1 }, mmPerPx: 0.5 });
    expect(guide.longPx).toBeCloseTo(CARD_LONG_MM / 0.5, 9);
    expect(guide.shortPx).toBeCloseTo(CARD_SHORT_MM / 0.5, 9);
    // The long axis is vertical for a vertical arm; the direction toward the hand and away from it give the same guide.
    expect(Math.abs(guide.angleDeg)).toBeCloseTo(90, 9);
    const away = cardGuide({ centre: { x: 300, y: 200 }, distal: { x: 0, y: 1 }, mmPerPx: 0.5 });
    expect(Math.abs(away.angleDeg)).toBeCloseTo(90, 9);
  });

  it('keeps the angle in (-90, 90] for every arm direction, and maps guide to frame and back', () => {
    checkProperty('guide coordinates round-trip and the angle is normalised', fc.property(
      fc.double({ min: -180, max: 180, noNaN: true }), fc.double({ min: 0.3, max: 2, noNaN: true }),
      fc.double({ min: -200, max: 200, noNaN: true }), fc.double({ min: -200, max: 200, noNaN: true }),
      (angle, scale, u, v) => {
        const rad = angle * Math.PI / 180;
        const guide = cardGuide({ centre: { x: 320, y: 240 }, distal: { x: Math.cos(rad), y: Math.sin(rad) }, mmPerPx: scale });
        if (!(guide.angleDeg > -90 - 1e-9 && guide.angleDeg <= 90 + 1e-9)) return false;
        const back = frameToGuide(guide, guideToFrame(guide, u, v));
        return Math.abs(back.x - u) < 1e-6 && Math.abs(back.y - v) < 1e-6;
      }), 300);
  });

  it('knows whether the whole guide lies inside the frame', () => {
    const guide = cardGuide({ centre: { x: 320, y: 240 }, distal: { x: 1, y: 0 }, mmPerPx: 0.5 });
    expect(guideInsideFrame(guide, { width: 640, height: 480 })).toBe(true);
    expect(guideInsideFrame({ ...guide, centre: { x: 40, y: 240 } }, { width: 640, height: 480 })).toBe(false);
    expect(cardCorners(guide, guideEdges(guide))[0]).toEqual({ x: 320 - guide.longPx / 2, y: 240 - guide.shortPx / 2 });
  });

  it('maps frame pixels to the box of object-fit cover and back', () => {
    const map = coverMap({ width: 800, height: 450 }, { width: 640, height: 480 });
    expect(map.scale).toBeCloseTo(1.25, 9);
    const point = { x: 123, y: 321 };
    const back = viewToFrame(map, frameToView(map, point));
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
    // The video is cut at the top and bottom when the box is wider than the frame.
    expect(frameToView(map, { x: 0, y: 0 }).y).toBeLessThan(0);
  });
});

describe('finding the card edges (R13, R14)', () => {
  it('finds the edges of a card drawn at a random size, offset, angle and contrast', () => {
    checkProperty('card edges are found within 1.5 px', fc.property(
      fc.double({ min: -85, max: 85, noNaN: true }), fc.double({ min: 0.5, max: 0.9, noNaN: true }),
      fc.double({ min: 0.9, max: 1.1, noNaN: true }), fc.double({ min: -0.08, max: 0.08, noNaN: true }), fc.double({ min: -0.08, max: 0.08, noNaN: true }),
      fc.double({ min: 40, max: 120, noNaN: true }), fc.integer({ min: 1, max: 1e6 }),
      (angle, scale, size, shiftU, shiftV, contrast, seed) => {
        const rad = angle * Math.PI / 180;
        const guide = cardGuide({ centre: { x: 320, y: 240 }, distal: { x: Math.cos(rad), y: Math.sin(rad) }, mmPerPx: scale });
        const truth: CardEdges = {
          left: -guide.longPx / 2 * size + shiftU * guide.longPx, right: guide.longPx / 2 * size + shiftU * guide.longPx,
          top: -guide.shortPx / 2 * size + shiftV * guide.shortPx, bottom: guide.shortPx / 2 * size + shiftV * guide.shortPx,
        };
        const found = findCardEdges(renderCard(guide, truth, { contrast, seed }), guide);
        return found.found && (['left', 'right', 'top', 'bottom'] as const).every(edge => Math.abs(found.edges[edge] - truth[edge]) < 1.5);
      }), 40);
  });

  it('finds a darker card on a light background too', () => {
    const guide = cardGuide({ centre: { x: 320, y: 240 }, distal: { x: 1, y: 0 }, mmPerPx: 0.6 });
    const found = findCardEdges(renderCard(guide, guideEdges(guide), { background: 200, contrast: -90 }), guide);
    expect(found.found).toBe(true);
    expect(found.edges.left).toBeCloseTo(-guide.longPx / 2, 0);
    expect(found.edges.bottom).toBeCloseTo(guide.shortPx / 2, 0);
  });

  it('puts the edges on the guide line and says so when there is no card', () => {
    const guide = cardGuide({ centre: { x: 320, y: 240 }, distal: { x: 1, y: 0.3 }, mmPerPx: 0.6 });
    const found = findCardEdges(renderCard(guide, null, { noise: 6 }), guide);
    expect(found.found).toBe(false);
    expect(found.edges).toEqual(guideEdges(guide));
  });

  it('keeps an edge on the guide line when the contrast is too low', () => {
    const guide = cardGuide({ centre: { x: 320, y: 240 }, distal: { x: 1, y: 0 }, mmPerPx: 0.6 });
    const found = findCardEdges(renderCard(guide, guideEdges(guide), { contrast: 2, noise: 6 }), guide);
    expect(found.found).toBe(false);
  });

  it('does not read outside the image when the guide reaches the border', () => {
    const guide = cardGuide({ centre: { x: 30, y: 20 }, distal: { x: 1, y: 0 }, mmPerPx: 0.6 });
    expect(() => findCardEdges(renderCard(guide, guideEdges(guide)), guide)).not.toThrow();
  });
});

describe('the correction factor (R15, R16, design 6.3)', () => {
  const card = (longPx: number, shortPx: number): CardEdges => ({ left: -longPx / 2, right: longPx / 2, top: -shortPx / 2, bottom: shortPx / 2 });
  const depthFactor = (longPx: number, frameWidthPx: number, thicknessMm: number) => {
    const focal = (frameWidthPx / 2) / Math.tan(ASSUMED_HFOV_DEG * Math.PI / 360);
    const distance = focal * CARD_LONG_MM / longPx;
    return (distance + thicknessMm / 2) / distance;
  };

  it('is the card scale with the depth correction over the estimate', () => {
    const longPx = 160;
    const shortPx = longPx * CARD_SHORT_MM / CARD_LONG_MM;
    const result = cardFactor(card(longPx, shortPx), { mmPerPxEstimate: 0.5, frameWidthPx: 640, thicknessMm: 40 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mmPerPxCard).toBeCloseTo(CARD_LONG_MM / longPx, 9);
    expect(result.mmPerPxCorrected).toBeCloseTo(CARD_LONG_MM / longPx * depthFactor(longPx, 640, 40), 9);
    expect(result.k).toBeCloseTo(result.mmPerPxCorrected / 0.5, 9);
    expect(result.spreadPct).toBeCloseTo(0, 6);
  });

  it('is larger for a thicker wrist, because the card is nearer to the camera than the arm centre', () => {
    const edges = card(150, 150 * CARD_SHORT_MM / CARD_LONG_MM);
    const thin = cardFactor(edges, { mmPerPxEstimate: 0.6, frameWidthPx: 640, thicknessMm: 30 });
    const thick = cardFactor(edges, { mmPerPxEstimate: 0.6, frameWidthPx: 640, thicknessMm: 50 });
    expect(thin.ok && thick.ok && thick.k > thin.k).toBe(true);
    // Without a measured thickness it uses 40 mm.
    const assumed = cardFactor(edges, { mmPerPxEstimate: 0.6, frameWidthPx: 640, thicknessMm: null });
    const forty = cardFactor(edges, { mmPerPxEstimate: 0.6, frameWidthPx: 640, thicknessMm: 40 });
    expect(assumed).toEqual(forty);
  });

  it('is 1 when the estimate already agrees with the card and the card is flat on the arm centre line', () => {
    const longPx = 170;
    const edges = card(longPx, longPx * CARD_SHORT_MM / CARD_LONG_MM);
    const result = cardFactor(edges, { mmPerPxEstimate: CARD_LONG_MM / longPx * depthFactor(longPx, 640, 0.0001), frameWidthPx: 640, thicknessMm: 0.0001 });
    expect(result.ok && Math.abs(result.k - 1) < 1e-6).toBe(true);
  });

  it('rejects an aspect ratio that is not the card (R16)', () => {
    const wide = cardFactor(card(160, 160 * CARD_SHORT_MM / CARD_LONG_MM * (1 + 2 * CARD_ASPECT_TOLERANCE)), { mmPerPxEstimate: 0.5, frameWidthPx: 640, thicknessMm: 40 });
    expect(wide).toEqual({ ok: false, reason: 'aspect', k: null });
    const nearly = cardFactor(card(160, 160 * CARD_SHORT_MM / CARD_LONG_MM * (1 + CARD_ASPECT_TOLERANCE / 2)), { mmPerPxEstimate: 0.5, frameWidthPx: 640, thicknessMm: 40 });
    expect(nearly.ok).toBe(true);
  });

  it('rejects a factor outside 0.75 to 1.33 and keeps the number for the report (R16)', () => {
    const edges = card(160, 160 * CARD_SHORT_MM / CARD_LONG_MM);
    const small = cardFactor(edges, { mmPerPxEstimate: 1.2, frameWidthPx: 640, thicknessMm: 40 });
    expect(small.ok).toBe(false);
    if (!small.ok) { expect(small.reason).toBe('range'); expect(small.k!).toBeLessThan(CARD_K_MIN); }
    const large = cardFactor(edges, { mmPerPxEstimate: 0.3, frameWidthPx: 640, thicknessMm: 40 });
    expect(large.ok).toBe(false);
    if (!large.ok) expect(large.k!).toBeGreaterThan(CARD_K_MAX);
  });

  it('rejects degenerate edges and inputs', () => {
    expect(cardFactor(card(2, 1), { mmPerPxEstimate: 0.5, frameWidthPx: 640, thicknessMm: 40 })).toEqual({ ok: false, reason: 'degenerate', k: null });
    expect(cardFactor({ left: 10, right: -10, top: -5, bottom: 5 }, { mmPerPxEstimate: 0.5, frameWidthPx: 640, thicknessMm: 40 }).ok).toBe(false);
    expect(cardFactor(card(160, 100), { mmPerPxEstimate: 0, frameWidthPx: 640, thicknessMm: 40 }).ok).toBe(false);
  });

  it('reports a card whose two sides disagree on the scale as a spread', () => {
    const result = cardFactor(card(160, 160 * CARD_SHORT_MM / CARD_LONG_MM * 1.03), { mmPerPxEstimate: 0.5, frameWidthPx: 640, thicknessMm: 40 });
    expect(result.ok && result.spreadPct > 2.5 && result.spreadPct < 3.5).toBe(true);
  });

  it('says in plain words how far off the estimate was (R17)', () => {
    expect(calibrationDirection(0.96)).toEqual({ direction: 'bigger', percent: 4 });
    expect(calibrationDirection(1.1)).toEqual({ direction: 'smaller', percent: 9 });
    expect(calibrationDirection(1.004)).toEqual({ direction: 'same', percent: 0 });
    expect(calibrationDirection(1)).toEqual({ direction: 'same', percent: 0 });
  });
});
