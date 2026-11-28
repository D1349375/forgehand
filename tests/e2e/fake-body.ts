import type { BrowserContext, Page } from '@playwright/test';
import { mmPerPx } from '../../src/fit/measure';
import type { HandLandmarks } from '../../src/try-on/arm-pose';
import { forearmMask } from '../fixtures/fit-mask';
import { clientToNormalized, syntheticHand } from '../fixtures/synthetic-hand';
import type { FakeHand } from './fake-hands';

/**
 * A scripted stand-in for the MediaPipe worker for body fit (spec body-fit, design 12.2), so no e2e test downloads a model.
 * It uses the same route pattern as `fake-hands.ts` (and `arm-try-on.spec.ts`), so a test installs either this or that,
 * never both. It answers every frame with the synthetic hands the test shows, and every frame that carries `segment` with
 * a luma and, once its pretend segmenter is ready, a synthetic mask of the forearm for exactly the crop the page asked
 * for: the mask is drawn inside the worker by `forearmMask` of `tests/fixtures/fit-mask.ts` (its source is embedded), so a
 * moving crop always gets a matching mask. The app has no test-only branch.
 *
 * Messages on `BroadcastChannel('forgehand-fake-body')`:
 *   page -> worker  { type: 'body', hands: HandLandmarks[], band: Band | null, luma: number }
 *   worker -> page  { type: 'ready' } | { type: 'frame', pose: boolean, segment: SegmentCrop | null }
 */
const CHANNEL = 'forgehand-fake-body';

/** A forearm in frame pixels (the pixels of the frame message): the axis runs from `point` toward the hand at `axisDeg`. */
export interface Band {
  point: { x: number; y: number };
  axisDeg: number;
  widthPx: number;
  blurMaskPx?: number;
  sleeve?: { fromPx: number; extraPx: number };
}

export interface FakeBodyOptions {
  delegate?: 'GPU' | 'CPU';
  replyDelayMs?: number;
  /** How the pretend segmenter ends up after the first `segment` frame: `ready` (default), or `error` (it fails to load). */
  segmenter?: 'ready' | 'error';
  /** Milliseconds between the `loading` and the final state message. Default 0. */
  segmenterDelayMs?: number;
  /** The first luma reported (0..1). Default 0.45. */
  luma?: number;
}

function workerSource(options: Required<FakeBodyOptions>): string {
  return `
    const forearmMask = ${forearmMask.toString()};
    const channel = new BroadcastChannel(${JSON.stringify(CHANNEL)});
    let hands = [];
    let band = null;
    let luma = ${JSON.stringify(options.luma)};
    let segmenter = 'idle';
    channel.onmessage = ({ data }) => {
      if (!data || data.type !== 'body') return;
      hands = Array.isArray(data.hands) ? data.hands : [];
      band = data.band || null;
      if (typeof data.luma === 'number') luma = data.luma;
    };
    const startSegmenter = () => {
      segmenter = 'loading';
      self.postMessage({ type: 'segmenter', state: 'loading' });
      setTimeout(() => {
        segmenter = ${JSON.stringify(options.segmenter)};
        self.postMessage({ type: 'segmenter', state: segmenter });
      }, ${options.segmenterDelayMs});
    };
    self.onmessage = ({ data }) => {
      const { bitmap, width, height, pose, segment, timestamp } = data;
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      const answer = () => {
        channel.postMessage({ type: 'frame', pose: pose !== false, segment: segment || null });
        const message = { type: 'frame', width, height, inferenceMs: 4, hands, body: [] };
        if (!segment) { self.postMessage(message); return; }
        if (segmenter === 'idle') startSegmenter();
        message.luma = luma;
        if (segmenter === 'ready' && band) {
          const planes = forearmMask({ crop: segment, point: band.point, axisDeg: band.axisDeg, widthPx: band.widthPx,
            blurMaskPx: band.blurMaskPx, sleeve: band.sleeve, size: 256 });
          message.mask = { size: 256, crop: segment, skin: planes.skin, clothes: planes.clothes, ms: 5, timestamp };
          self.postMessage(message, [planes.skin.buffer, planes.clothes.buffer]);
          return;
        }
        self.postMessage(message);
      };
      if (${options.replyDelayMs} > 0) setTimeout(answer, ${options.replyDelayMs}); else answer();
    };
    channel.postMessage({ type: 'ready' });
    self.postMessage({ type: 'ready', delegate: ${JSON.stringify(options.delegate)} });
  `;
}

declare global {
  interface Window {
    __fakeBody?: {
      ready: number; frames: number; segmentFrames: number; lastCrop: unknown;
      channel: BroadcastChannel; message: { type: 'body'; hands: unknown[]; band: Band | null; luma: number };
    };
  }
}

/**
 * Routes the tracking worker to the scripted one. Call it before `page.goto`; calling it again before `goto` changes the
 * options (the later route wins, and the page-side counters are created once).
 */
export async function installFakeBody(context: BrowserContext, options: FakeBodyOptions = {}): Promise<void> {
  const resolved: Required<FakeBodyOptions> = {
    delegate: options.delegate ?? 'GPU', replyDelayMs: options.replyDelayMs ?? 0, segmenter: options.segmenter ?? 'ready',
    segmenterDelayMs: options.segmenterDelayMs ?? 0, luma: options.luma ?? 0.45,
  };
  const source = workerSource(resolved);
  await context.route(/\/(?:src\/try-on\/arm\.worker\.ts|assets\/arm\.worker-[^/?]+\.js)(?:\?.*)?$/, route => route.fulfill({
    contentType: 'text/javascript',
    body: source,
  }));
  await context.addInitScript(({ name, luma }) => {
    if (window.__fakeBody) return;
    const channel = new BroadcastChannel(name);
    const state = {
      ready: 0, frames: 0, segmentFrames: 0, lastCrop: null as unknown, channel,
      message: { type: 'body' as const, hands: [] as unknown[], band: null as Band | null, luma },
    };
    window.__fakeBody = state;
    channel.onmessage = ({ data }) => {
      if (data?.type === 'ready') {
        state.ready++;
        // A worker that starts after showBody still answers with the current body.
        channel.postMessage(state.message);
      } else if (data?.type === 'frame') {
        state.frames++;
        if (data.segment) { state.segmentFrames++; state.lastCrop = data.segment; }
      }
    };
  }, { name: CHANNEL, luma: resolved.luma });
}

export interface ShowBodyOptions {
  /** Up to two synthetic hands, in slot order (as `showHands` in fake-hands.ts). An empty array hides every hand and the forearm. */
  hands: readonly FakeHand[];
  /** Width of the forearm in millimetres at the scale of the first hand. Default 58. Omit `hands` content to show no forearm. */
  maskWidthMm?: number;
  /** Clothes from `fromMm` past the wrist toward the elbow, `extraMm` wider on each side; the skin ends there. */
  sleeve?: { fromMm: number; extraMm?: number };
  /** The crop luma (0..1) the worker reports from now on. */
  luma?: number;
  /** Edge ramp of the mask in mask pixels. Default 1. */
  blurMaskPx?: number;
}
export interface ShownBody {
  /** What a correct measurement sees: the scale at the first hand, the forearm in frame pixels, the wrist and the hand direction. */
  mmPerPx: number | null;
  widthPx: number | null;
  wristPx: { x: number; y: number } | null;
  /** Unit vector in the frame from the wrist toward the hand. */
  distal: { x: number; y: number } | null;
  frame: { width: number; height: number };
}

/**
 * Shows synthetic hands and, under the first one, a forearm of `maskWidthMm` that runs from its wrist away from the hand
 * (and, being a mask of the whole body, also under the hand). The forearm is drawn at the first hand's own scale
 * (`mmPerPx` of src/fit/measure.ts), so a measurement of it returns `maskWidthMm`.
 */
export async function showBody(page: Page, options: ShowBodyOptions): Promise<ShownBody> {
  const geometry = await page.evaluate(() => {
    const video = document.querySelector('video.camera-video') as HTMLVideoElement | null;
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return { view: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, video: { width: video.videoWidth, height: video.videoHeight } };
  });
  if (!geometry?.video.width || !geometry.video.height) throw new Error('showBody: the camera video has no frame yet');
  const frame = { width: geometry.video.width, height: geometry.video.height };
  const hands: HandLandmarks[] = options.hands.map((hand, index) => syntheticHand({
    cursor: clientToNormalized(hand.at, geometry.view, geometry.video), pinchM: hand.pinchM, side: index === 0 ? 'right' : 'left', fist: hand.fist,
    roll: hand.roll, aspect: geometry.video.width / geometry.video.height, curledFingers: hand.curledFingers, indexRatio: hand.indexRatio,
  }));
  let band: Band | null = null;
  let shown: ShownBody = { mmPerPx: null, widthPx: null, wristPx: null, distal: null, frame };
  const first = hands[0];
  if (first) {
    const scale = mmPerPx(first, frame);
    const wrist = { x: first.points[0]!.x * frame.width, y: first.points[0]!.y * frame.height };
    const knuckle = { x: first.points[9]!.x * frame.width, y: first.points[9]!.y * frame.height };
    const length = Math.hypot(knuckle.x - wrist.x, knuckle.y - wrist.y);
    if (scale && length > 0) {
      const distal = { x: (knuckle.x - wrist.x) / length, y: (knuckle.y - wrist.y) / length };
      const widthPx = (options.maskWidthMm ?? 58) / scale;
      band = {
        point: wrist, axisDeg: Math.atan2(distal.y, distal.x) * 180 / Math.PI, widthPx, blurMaskPx: options.blurMaskPx,
        sleeve: options.sleeve ? { fromPx: options.sleeve.fromMm / scale, extraPx: (options.sleeve.extraMm ?? 6) / scale } : undefined,
      };
      shown = { mmPerPx: scale, widthPx, wristPx: wrist, distal, frame };
    }
  }
  await page.evaluate(value => {
    const state = window.__fakeBody;
    if (!state) throw new Error('installFakeBody was not called');
    state.message = { type: 'body', hands: value.hands, band: value.band, luma: value.luma ?? state.message.luma };
    state.channel.postMessage(state.message);
  }, { hands, band, luma: options.luma });
  return shown;
}

export async function hideBody(page: Page): Promise<void> {
  await showBody(page, { hands: [] });
}

/** What the fake worker has seen so far: frames, frames that asked for a mask, and the last crop asked for. */
export async function fakeBodyLog(page: Page): Promise<{ ready: number; frames: number; segmentFrames: number; lastCrop: unknown }> {
  return page.evaluate(() => {
    const state = window.__fakeBody;
    return state ? { ready: state.ready, frames: state.frames, segmentFrames: state.segmentFrames, lastCrop: state.lastCrop } : { ready: 0, frames: 0, segmentFrames: 0, lastCrop: null };
  });
}
