import type { BrowserContext, Page } from '@playwright/test';
import { clientToNormalized, syntheticHand } from '../fixtures/synthetic-hand';

/**
 * A scripted stand-in for the MediaPipe worker, so no e2e test that turns the
 * camera on downloads a model. It uses the same route pattern as
 * `arm-try-on.spec.ts`; the app has no test-only branch.
 *
 * Messages on `BroadcastChannel('forgehand-fake-hands')`:
 *   page -> worker  { type: 'hands', hands: HandLandmarks[] }       the hands to answer frames with, in order
 *                   { type: 'hand', hand: HandLandmarks | null }   the same for one hand (still accepted)
 *   worker -> page  { type: 'ready' } | { type: 'frame', pose: boolean }
 */
const CHANNEL = 'forgehand-fake-hands';

function workerSource(delegate: 'GPU' | 'CPU', replyDelayMs: number): string {
  return `
    const channel = new BroadcastChannel(${JSON.stringify(CHANNEL)});
    let hands = [];
    channel.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'hands') hands = Array.isArray(data.hands) ? data.hands : [];
      else if (data.type === 'hand') hands = data.hand ? [data.hand] : [];
    };
    self.onmessage = ({ data }) => {
      const { bitmap, width, height, pose } = data;
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      const answer = () => {
        channel.postMessage({ type: 'frame', pose: pose !== false });
        self.postMessage({ type: 'frame', width, height, inferenceMs: 4, hands, body: [] });
      };
      if (${replyDelayMs} > 0) setTimeout(answer, ${replyDelayMs}); else answer();
    };
    channel.postMessage({ type: 'ready' });
    self.postMessage({ type: 'ready', delegate: ${JSON.stringify(delegate)} });
  `;
}

declare global {
  interface Window {
    __fakeHands?: { ready: number; frames: number; poseFrames: number; channel: BroadcastChannel; hands: unknown[] };
  }
}

/**
 * `delegate` and `replyDelayMs` script the worker. A test may call this again before `page.goto` to
 * change them: the later route wins, and the page-side counters are created once.
 */
export async function installFakeHands(context: BrowserContext, options: { delegate?: 'GPU' | 'CPU'; replyDelayMs?: number } = {}): Promise<void> {
  const source = workerSource(options.delegate ?? 'GPU', options.replyDelayMs ?? 0);
  await context.route(/\/(?:src\/try-on\/arm\.worker\.ts|assets\/arm\.worker-[^/?]+\.js)(?:\?.*)?$/, route => route.fulfill({
    contentType: 'text/javascript',
    body: source,
  }));
  await context.addInitScript(name => {
    if (window.__fakeHands) return;
    const channel = new BroadcastChannel(name);
    const state = { ready: 0, frames: 0, poseFrames: 0, channel, hands: [] as unknown[] };
    window.__fakeHands = state;
    channel.onmessage = ({ data }) => {
      if (data?.type === 'ready') {
        state.ready++;
        // A worker that starts after showHands still answers with the current hands.
        channel.postMessage({ type: 'hands', hands: state.hands });
      } else if (data?.type === 'frame') {
        state.frames++;
        if (data.pose) state.poseFrames++;
      }
    };
  }, CHANNEL);
}

export interface FakeHand {
  /** Client pixels: the pinch midpoint of an open hand, the palm centre of a fist. */
  at: { x: number; y: number };
  /** Thumb-index distance in metres (ignored for a fist). */
  pinchM: number;
  /** A closed fist (Task 7); its curl ratio is about 0.65. */
  fist?: boolean;
}

/** Shows up to two synthetic hands, in slot order (the first is hand 0); an empty array hides all hands. */
export async function showHands(page: Page, hands: readonly FakeHand[]): Promise<void> {
  if (hands.length === 0) {
    await postHands(page, []);
    return;
  }
  const geometry = await page.evaluate(() => {
    const video = document.querySelector('video.camera-video') as HTMLVideoElement | null;
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return { view: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, video: { width: video.videoWidth, height: video.videoHeight } };
  });
  if (!geometry?.video.width || !geometry.video.height) throw new Error('showHands: the camera video has no frame yet');
  await postHands(page, hands.map((hand, index) => syntheticHand({
    cursor: clientToNormalized(hand.at, geometry.view, geometry.video), pinchM: hand.pinchM, side: index === 0 ? 'right' : 'left', fist: hand.fist,
  })));
}

/** Puts one synthetic hand at a client point (px) with the given thumb-index distance in metres. */
export async function showHand(page: Page, at: { x: number; y: number }, pinchM: number): Promise<void> {
  await showHands(page, [{ at, pinchM }]);
}

export async function hideHand(page: Page): Promise<void> {
  await showHands(page, []);
}

/**
 * Where the palm centre of a synthetic open hand lies relative to its pinch midpoint, in client pixels (the palm is below the cursor).
 * A fist is placed by its palm centre, so `at` of an open hand `palmOffset` above a fist's `at` has the same palm: a hand can go from
 * open to pinching to fist without its palm moving, as a real one does.
 */
export async function palmOffset(page: Page): Promise<{ x: number; y: number }> {
  const geometry = await page.evaluate(() => {
    const video = document.querySelector('video.camera-video') as HTMLVideoElement | null;
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return { view: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, video: { width: video.videoWidth, height: video.videoHeight } };
  });
  if (!geometry?.video.width || !geometry.video.height) throw new Error('palmOffset: the camera video has no frame yet');
  const cursor = { x: 0.5, y: 0.5 };
  const hand = syntheticHand({ cursor, pinchM: 0.1 });
  const palm = [0, 5, 9, 13, 17].map(index => hand.points[index]!);
  const centre = { x: palm.reduce((sum, point) => sum + point.x, 0) / palm.length, y: palm.reduce((sum, point) => sum + point.y, 0) / palm.length };
  const scale = Math.max(geometry.view.width / geometry.video.width, geometry.view.height / geometry.video.height);
  return { x: (centre.x - cursor.x) * geometry.video.width * scale, y: (centre.y - cursor.y) * geometry.video.height * scale };
}

async function postHands(page: Page, hands: unknown[]): Promise<void> {
  await page.evaluate(value => {
    const state = window.__fakeHands;
    if (!state) throw new Error('installFakeHands was not called');
    state.hands = value;
    state.channel.postMessage({ type: 'hands', hands: value });
  }, hands);
}
export async function fakeHandsLog(page: Page): Promise<{ ready: number; frames: number; poseFrames: number }> {
  return page.evaluate(() => {
    const state = window.__fakeHands;
    return state ? { ready: state.ready, frames: state.frames, poseFrames: state.poseFrames } : { ready: 0, frames: 0, poseFrames: 0 };
  });
}

/** The hand-loss window the e2e specs use unless a test says otherwise (ms); a hidden hand must stay hidden clearly longer than this. */
export const E2E_LOSS_MS = 2000;

/**
 * The app URL for hand-control specs.
 * - `?hands-min-fps=0` (default here) switches the speed gate off: a loaded machine delivers few fake-camera
 *   frames per second, which the gate would rightly call too slow. `minFps: null` keeps the app's default threshold.
 * - `?hands-loss-ms=2000` (default here, see E2E_LOSS_MS) widens the hand-loss windows for the same reason: at 1 to 20
 *   frames per second the 300 ms defaults expire between frames. `lossMs: null` keeps the app's defaults.
 */
export function handsUrl(options: { minFps?: number | null; lossMs?: number | null; debug?: boolean } = {}): string {
  const params: string[] = [];
  if (options.debug) params.push('hands=debug');
  const minFps = options.minFps === undefined ? 0 : options.minFps;
  if (minFps !== null) params.push(`hands-min-fps=${minFps}`);
  const lossMs = options.lossMs === undefined ? E2E_LOSS_MS : options.lossMs;
  if (lossMs !== null) params.push(`hands-loss-ms=${lossMs}`);
  return params.length > 0 ? `/?${params.join('&')}` : '/';
}