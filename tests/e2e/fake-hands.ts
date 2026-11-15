import type { BrowserContext, Page } from '@playwright/test';
import { clientToNormalized, syntheticHand } from '../fixtures/synthetic-hand';

/**
 * A scripted stand-in for the MediaPipe worker, so no e2e test that turns the
 * camera on downloads a model. It uses the same route pattern as
 * `arm-try-on.spec.ts`; the app has no test-only branch.
 *
 * Messages on `BroadcastChannel('forgehand-fake-hands')`:
 *   page -> worker  { type: 'hand', hand: HandLandmarks | null }   the hand to answer frames with
 *   worker -> page  { type: 'ready' } | { type: 'frame', pose: boolean }
 */
const CHANNEL = 'forgehand-fake-hands';

function workerSource(delegate: 'GPU' | 'CPU', replyDelayMs: number): string {
  return `
    const channel = new BroadcastChannel(${JSON.stringify(CHANNEL)});
    let hand = null;
    channel.onmessage = ({ data }) => { if (data && data.type === 'hand') hand = data.hand; };
    self.onmessage = ({ data }) => {
      const { bitmap, width, height, pose } = data;
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      const answer = () => {
        channel.postMessage({ type: 'frame', pose: pose !== false });
        self.postMessage({ type: 'frame', width, height, inferenceMs: 4, hands: hand ? [hand] : [], body: [] });
      };
      if (${replyDelayMs} > 0) setTimeout(answer, ${replyDelayMs}); else answer();
    };
    channel.postMessage({ type: 'ready' });
    self.postMessage({ type: 'ready', delegate: ${JSON.stringify(delegate)} });
  `;
}

declare global {
  interface Window {
    __fakeHands?: { ready: number; frames: number; poseFrames: number; channel: BroadcastChannel; hand: unknown };
  }
}

export async function installFakeHands(context: BrowserContext, options: { delegate?: 'GPU' | 'CPU'; replyDelayMs?: number } = {}): Promise<void> {
  const source = workerSource(options.delegate ?? 'GPU', options.replyDelayMs ?? 0);
  await context.route(/\/(?:src\/try-on\/arm\.worker\.ts|assets\/arm\.worker-[^/?]+\.js)(?:\?.*)?$/, route => route.fulfill({
    contentType: 'text/javascript',
    body: source,
  }));
  await context.addInitScript(name => {
    const channel = new BroadcastChannel(name);
    const state = { ready: 0, frames: 0, poseFrames: 0, channel, hand: null as unknown };
    window.__fakeHands = state;
    channel.onmessage = ({ data }) => {
      if (data?.type === 'ready') {
        state.ready++;
        // A worker that starts after showHand still answers with the current hand.
        channel.postMessage({ type: 'hand', hand: state.hand });
      } else if (data?.type === 'frame') {
        state.frames++;
        if (data.pose) state.poseFrames++;
      }
    };
  }, CHANNEL);
}

/** Puts a synthetic hand at a client point (px) with the given thumb-index distance in metres. */
export async function showHand(page: Page, at: { x: number; y: number }, pinchM: number): Promise<void> {
  const geometry = await page.evaluate(() => {
    const video = document.querySelector('video.camera-video') as HTMLVideoElement | null;
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return { view: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, video: { width: video.videoWidth, height: video.videoHeight } };
  });
  if (!geometry?.video.width || !geometry.video.height) throw new Error('showHand: the camera video has no frame yet');
  const hand = syntheticHand({ cursor: clientToNormalized(at, geometry.view, geometry.video), pinchM });
  await postHand(page, hand);
}

export async function hideHand(page: Page): Promise<void> {
  await postHand(page, null);
}

async function postHand(page: Page, hand: unknown): Promise<void> {
  await page.evaluate(value => {
    const state = window.__fakeHands;
    if (!state) throw new Error('installFakeHands was not called');
    state.hand = value;
    state.channel.postMessage({ type: 'hand', hand: value });
  }, hand);
}

export async function fakeHandsLog(page: Page): Promise<{ ready: number; frames: number; poseFrames: number }> {
  return page.evaluate(() => {
    const state = window.__fakeHands;
    return state ? { ready: state.ready, frames: state.frames, poseFrames: state.poseFrames } : { ready: 0, frames: 0, poseFrames: 0 };
  });
}
