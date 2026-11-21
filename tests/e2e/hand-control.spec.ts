import { expect, test, type Page, type Route } from '@playwright/test';
import { demoModel } from '../../shared/demo';
import type { ModelSpec } from '../../shared/model';
import { fakeHandsLog, hideHand, installFakeHands, palmOffset, showHand, showHands, handsUrl, type FakeHand } from './fake-hands';

// Hand control is tested against a scripted worker (fake-hands.ts); the camera
// stream, the capture loop and the app are real.

test.beforeEach(async ({ context, page }) => {
  test.setTimeout(150_000);
  await installFakeHands(context);
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
  // The speed gate is off here (?hands-min-fps=0); the speed test below opens the app with the default threshold.
  await page.goto(handsUrl());
});

const openCamera = (page: Page) => page.getByRole('button', { name: '開啟攝影機', exact: true }).click();
const handsButton = (page: Page) => page.getByRole('button', { name: '手勢', exact: true });

async function frames(page: Page) {
  return (await fakeHandsLog(page)).frames;
}

/** Software WebGL makes the fake camera slow, so wait for a few frames instead of counting on a rate. */
async function framesAbove(page: Page, count: number) {
  await expect.poll(() => frames(page), { timeout: 45_000 }).toBeGreaterThan(count);
}

test.describe('T1 shared hand tracking and the 手勢 switch', () => {
  test('camera on starts hand-only tracking (no pose)', async ({ page }) => {
    await expect(handsButton(page)).toHaveCount(0);
    await openCamera(page);
    await expect(handsButton(page)).toHaveAttribute('aria-pressed', 'true');
    await framesAbove(page, 0);
    const log = await fakeHandsLog(page);
    expect(log.poseFrames).toBe(0);
    expect(log.ready).toBe(1);
  });

  test('手勢 off stops frames and on resumes them without a reload', async ({ page }) => {
    await openCamera(page);
    await framesAbove(page, 0);
    await handsButton(page).click();
    await expect(handsButton(page)).toHaveAttribute('aria-pressed', 'false');
    // One frame may still be in flight; then the count must stand still.
    await page.waitForTimeout(400);
    const stopped = await frames(page);
    await page.waitForTimeout(800);
    expect(await frames(page)).toBe(stopped);
    await handsButton(page).click();
    await framesAbove(page, stopped);
    expect((await fakeHandsLog(page)).ready).toBe(1);
  });

  test('try-on works with 手勢 off and asks for pose frames', async ({ page }) => {
    await openCamera(page);
    await expect(handsButton(page)).toBeVisible();
    await handsButton(page).click();
    await page.getByRole('button', { name: '護臂試戴', exact: true }).click();
    await showHand(page, { x: 720, y: 500 }, 0.1);
    await expect(page.getByTestId('try-on-status')).toHaveAttribute('data-state', 'tracking', { timeout: 45_000 });
    expect((await fakeHandsLog(page)).poseFrames).toBeGreaterThan(0);
    await expect(handsButton(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('toggling try-on does not start a second worker', async ({ page }) => {
    await openCamera(page);
    await framesAbove(page, 0);
    await page.getByRole('button', { name: '護臂試戴', exact: true }).click();
    await expect(page.getByTestId('try-on-status')).toBeVisible();
    await expect.poll(async () => (await fakeHandsLog(page)).poseFrames, { timeout: 45_000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: '結束護臂試戴', exact: true }).click();
    await expect(page.getByTestId('try-on-status')).toHaveCount(0);
    const before = await frames(page);
    await framesAbove(page, before);
    expect((await fakeHandsLog(page)).ready).toBe(1);
  });

  test('camera off and on again presses 手勢 again', async ({ page }) => {
    await openCamera(page);
    await handsButton(page).click();
    await expect(handsButton(page)).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: '關閉攝影機', exact: true }).click();
    await expect(handsButton(page)).toHaveCount(0);
    await openCamera(page);
    await expect(handsButton(page)).toHaveAttribute('aria-pressed', 'true');
    await framesAbove(page, 0);
  });
});

/** How many pixels of the hand overlay inside the square around `centre` (client px, half-width `radius`) are drawn on. */
async function overlayInk(page: Page, centre: { x: number; y: number }, radius: number) {
  return page.getByTestId('hand-overlay').evaluate((element, area) => {
    const canvas = element as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    const ratio = canvas.width / box.width;
    const x = Math.max(0, Math.round((area.centre.x - box.left - area.radius) * ratio));
    const y = Math.max(0, Math.round((area.centre.y - box.top - area.radius) * ratio));
    const size = Math.round(area.radius * 2 * ratio);
    const data = canvas.getContext('2d')!.getImageData(x, y, Math.min(size, canvas.width - x), Math.min(size, canvas.height - y)).data;
    let ink = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) ink++;
    return ink;
  }, { centre, radius });
}

test.describe('T2 hand overlay', () => {
  // One camera start covers the whole life of the overlay: it is drawn on the hand,
  // follows the hand and the 手勢 switch, and goes away with the camera.
  test('the skeleton lies on the hand and goes with the hand, the 手勢 switch and the camera', async ({ page }) => {
    await openCamera(page);
    await framesAbove(page, 0);
    const overlay = page.getByTestId('hand-overlay');
    await expect(overlay).toHaveAttribute('data-hand-state', 'none');
    await expect(overlay).toHaveAttribute('aria-hidden', 'true');

    const box = (await page.getByTestId('viewport').boundingBox())!;
    const hand = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const corner = { x: box.x + 40, y: box.y + 40 };
    await showHand(page, hand, 0.1);
    await expect(overlay).toHaveAttribute('data-hand-state', 'tracked');
    await expect(overlay).toHaveAttribute('data-hand-target', '');
    // Poll: under load a slow frame can leave the overlay cleared for a moment (HAND_LOST_MS) before the next draw.
    await expect.poll(() => overlayInk(page, hand, 90), { timeout: 45_000, intervals: [50, 100, 200] }).toBeGreaterThan(100);
    expect(await overlayInk(page, corner, 30)).toBe(0);

    await hideHand(page);
    await expect(overlay).toHaveAttribute('data-hand-state', 'none');
    expect(await overlayInk(page, hand, 90)).toBe(0);

    await handsButton(page).click();
    await expect(overlay).toHaveCount(0);
    await handsButton(page).click();
    await expect(overlay).toHaveCount(1);
    await showHand(page, hand, 0.1);
    await expect(overlay).toHaveAttribute('data-hand-state', 'tracked');

    await page.getByRole('button', { name: '關閉攝影機', exact: true }).click();
    await expect(overlay).toHaveCount(0);
  });
});

const hideImageButton = (page: Page) => page.getByRole('button', { name: '隱藏鏡頭畫面', exact: true });
const handStatus = (page: Page) => page.getByTestId('hand-status');
async function viewportCentre(page: Page) {
  const box = (await page.getByTestId('viewport').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('T3 both hands, the hidden camera image and the status line', () => {
  test('two hands are drawn, one hidden leaves one, and the hint follows the 手勢 switch', async ({ page }) => {
    await openCamera(page);
    // Before the first hand: the hint, and nothing at all with 手勢 off.
    await page.waitForFunction(text => {
      const line = document.querySelector('[data-testid="hand-status"]');
      return line?.getAttribute('data-state') === 'hint' && line.textContent === text;
    }, '把手舉到鏡頭前：捏住零件可移動，捏住空白處可轉動視角。', { timeout: 45_000 });
    await handsButton(page).click();
    await expect(handStatus(page)).toHaveCount(0);
    await handsButton(page).click();
    await expect(handStatus(page)).toHaveAttribute('data-state', 'hint');
    const centre = await viewportCentre(page);
    const left = { x: centre.x - 300, y: centre.y };
    const right = { x: centre.x + 300, y: centre.y };
    const overlay = page.getByTestId('hand-overlay');
    await showHands(page, [{ at: left, pinchM: 0.1 }, { at: right, pinchM: 0.1 }]);
    await expect(overlay).toHaveAttribute('data-hand-count', '2');
    await expect(overlay).toHaveAttribute('data-hand-state', 'tracked');
    await expect(overlay).toHaveAttribute('data-hand2-state', 'tracked');
    await expect(overlay).toHaveAttribute('data-gesture', 'none');
    await expect.poll(async () => Math.min(await overlayInk(page, left, 90), await overlayInk(page, right, 90)), { timeout: 45_000, intervals: [50, 100, 200] }).toBeGreaterThan(100);
    // Once a hand has been seen, the hint is gone.
    await expect(page.locator('[data-testid="hand-status"][data-state="hint"]')).toHaveCount(0);
    // Hands keep their slots (design §4.7): the right hand stays in slot 1, and slot 0 empties once its loss window ends.
    await showHands(page, [{ at: right, pinchM: 0.1 }]);
    await expect(overlay).toHaveAttribute('data-hand-count', '1');
    await expect(overlay).toHaveAttribute('data-hand-state', 'none');
    await expect(overlay).toHaveAttribute('data-hand2-state', 'tracked');
    await hideHand(page);
    await expect(overlay).toHaveAttribute('data-hand-count', '0');
    await expect(overlay).toHaveAttribute('data-hand2-state', 'none');
  });

  test('the camera image can be hidden while the video, the tracking and the skeleton go on', async ({ page }) => {
    await expect(hideImageButton(page)).toHaveCount(0);
    await openCamera(page);
    await framesAbove(page, 0);
    const video = page.getByLabel('即時攝影機背景');
    await expect(hideImageButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(video).toHaveCSS('opacity', '1');
    await hideImageButton(page).click();
    await expect(hideImageButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(video).toHaveAttribute('data-image-hidden', 'true');
    await expect(video).toHaveCSS('opacity', '0');
    const playback = () => video.evaluate((element: HTMLVideoElement) => ({ paused: element.paused, time: element.currentTime, attached: element.srcObject !== null }));
    const before = await playback();
    expect(before).toMatchObject({ paused: false, attached: true });
    await expect.poll(async () => (await playback()).time, { timeout: 30_000 }).toBeGreaterThan(before.time);
    // Tracking keeps going: frames keep growing and the skeleton is still drawn on the hand.
    const counted = await frames(page);
    await framesAbove(page, counted);
    const hand = await viewportCentre(page);
    await showHand(page, hand, 0.1);
    await expect.poll(() => overlayInk(page, hand, 90), { timeout: 45_000, intervals: [50, 100, 200] }).toBeGreaterThan(100);
    // Try-on still tracks with the image hidden.
    await page.getByRole('button', { name: '護臂試戴', exact: true }).click();
    await expect(page.getByTestId('try-on-status')).toHaveAttribute('data-state', 'tracking', { timeout: 45_000 });
    await expect(video).toHaveCSS('opacity', '0');
    // Camera off and on: the image is shown again and the button is not pressed.
    await page.getByRole('button', { name: '關閉攝影機', exact: true }).click();
    await expect(hideImageButton(page)).toHaveCount(0);
    await openCamera(page);
    await expect(hideImageButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(video).toHaveAttribute('data-image-hidden', 'false');
    await expect(video).toHaveCSS('opacity', '1');
  });
});

test.describe('T3 tracking speed', () => {
  test('a slow tracker locks hand control with the 太慢 line and locked skeletons', async ({ context, page }) => {
    // Registered after the default fake, so this one answers the worker URL.
    await installFakeHands(context, { replyDelayMs: 150 });
    await page.goto(handsUrl({ minFps: null }));
    await openCamera(page);
    const hand = await viewportCentre(page);
    await expect.poll(async () => { try { await showHand(page, hand, 0.1); return true; } catch { return false; } }, { timeout: 45_000 }).toBe(true);
    await expect(handStatus(page)).toHaveAttribute('data-state', 'slow', { timeout: 60_000 });
    await expect(handStatus(page)).toContainText('太慢');
    await expect(page.getByTestId('hand-overlay')).toHaveAttribute('data-hand-state', 'locked');
  });

  test('a CPU tracker at a good rate gives no 太慢 line, and ?hands=debug shows the delegate, the hand count and the threshold', async ({ context, page }) => {
    await installFakeHands(context, { delegate: 'CPU' });
    await page.goto(handsUrl({ debug: true }));
    await expect(page.getByTestId('hand-debug')).toHaveCount(0);
    await openCamera(page);
    await expect(page.getByTestId('hand-debug')).toBeVisible();
    const hand = await viewportCentre(page);
    await expect.poll(async () => { try { await showHand(page, hand, 0.1); return true; } catch { return false; } }, { timeout: 45_000 }).toBe(true);
    await expect(page.getByTestId('hand-debug')).toContainText('CPU', { timeout: 45_000 });
    await expect(page.getByTestId('hand-debug')).toContainText('1 隻手', { timeout: 45_000 });
    await expect(page.getByTestId('hand-debug')).toContainText('速度門檻 0 幀');
    // The delegate is not a gate input: a CPU tracker with the speed gate off stays tracked and is never called too slow.
    await expect(page.getByTestId('hand-overlay')).toHaveAttribute('data-hand-state', 'tracked');
    await expect(page.locator('[data-testid="hand-status"][data-state="slow"]')).toHaveCount(0);
  });
});// ---- Task 5: pinch-move, orbit and the rest of the P0 core ------------------------------------------------------------------------
type Pt = { x: number; y: number };
type Row = [string, { x: number; y: number; z: number }, { x: number; y: number; z: number }, { x: number; y: number; z: number }, string];
const OPEN = 0.1;
const PINCH = 0.012;
const sceneCanvas = (page: Page) => page.getByTestId('scene-canvas');
const overlay = (page: Page) => page.getByTestId('hand-overlay');
const undoButton = (page: Page) => page.getByRole('button', { name: '復原', exact: true });
const modelRows = async (page: Page): Promise<Row[]> => JSON.parse((await sceneCanvas(page).getAttribute('data-model-json'))!);
const rowOf = async (page: Page, id: string) => (await modelRows(page)).find(entry => entry[0] === id)!;
const projectOf = (page: Page, id: string, objectId: string | null = null) =>
  page.evaluate(([part, object]) => window.__forgehandScene?.projectPart(part!, object ?? undefined) ?? null, [id, objectId] as const);
const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const shift = (point: Pt, dx: number, dy = 0): Pt => ({ x: point.x + dx, y: point.y + dy });

/** The client point, near the part's centre, where the scene's own raycast finds `partId` (of `objectId`) as the nearest surface. */
async function pointOn(page: Page, partId: string, objectId: string | null = null): Promise<Pt> {
  const found = await page.evaluate(([part, object]) => {
    const scene = window.__forgehandScene!;
    const centre = scene.projectPart(part!, object ?? undefined);
    if (!centre) return null;
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = centre.y - 100; y <= centre.y + 100; y += 5) {
      for (let x = centre.x - 100; x <= centre.x + 100; x += 5) {
        const hit = scene.hitTest({ x, y });
        const d = Math.hypot(x - centre.x, y - centre.y);
        if (hit && hit.partId === part && (!object || hit.objectId === object) && (!best || d < best.d)) best = { x, y, d };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }, [partId, objectId] as const);
  expect(found, `no point on ${partId} found`).not.toBeNull();
  return found!;
}
/** Any part point, found by scanning the whole canvas (the exploded view moves every part). */
async function anyPartPoint(page: Page): Promise<Pt> {
  const found = await page.evaluate(() => {
    const scene = window.__forgehandScene!;
    const rect = document.querySelector('[data-testid="scene-canvas"]')!.getBoundingClientRect();
    for (let y = rect.top + 60; y < rect.bottom - 60; y += 15) {
      for (let x = rect.left + 60; x < rect.right - 60; x += 15) if (scene.hitTest({ x, y })) return { x, y };
    }
    return null;
  });
  expect(found, 'no part found on the canvas').not.toBeNull();
  return found!;
}
/** A point inside the canvas where the scene's raycast finds nothing, near its right edge. */
async function emptyPoint(page: Page): Promise<Pt> {
  const found = await page.evaluate(() => {
    const scene = window.__forgehandScene!;
    const rect = document.querySelector('[data-testid="scene-canvas"]')!.getBoundingClientRect();
    for (let x = rect.right - 80; x > rect.left + 200; x -= 20) if (!scene.hitTest({ x, y: rect.top + rect.height / 2 })) return { x, y: rect.top + rect.height / 2 };
    return null;
  });
  expect(found, 'no empty point found').not.toBeNull();
  return found!;
}
async function demoAndCamera(page: Page) {
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(sceneCanvas(page)).toHaveAttribute('data-model-name', demoModel.name);
  await openCamera(page);
  await framesAbove(page, 0);
}
/** Requests to the model back end; hand gestures never make one. */
function modelCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', request => { const match = /\/api\/(generate|edit|agent)\b/.exec(request.url()); if (match) calls.push(match[1]!); });
  return calls;
}

// A hand that is not seen for TRACKING_LOSS_MS ends or restarts its gesture, and on a busy machine the fake camera can stall that
// long. These helpers repeat a whole attempt (hover, pinch, move) up to three times; what they wait for is the behaviour under test.
interface Aim {
  /** The target key the hand must have settled on before it pinches; null when only the state matters. */
  key: string | null;
  /** What the hand shows while it hovers there. */
  hover: 'hover' | 'tracked' | 'locked';
  /** What the pinch must become. */
  state: 'grab' | 'orbit';
}
const MOUSE_ONLY: readonly FakeHand[] = [];
async function openHands(page: Page, at: Pt, others: readonly FakeHand[]) {
  await showHands(page, [{ at, pinchM: OPEN }, ...others.map(hand => ({ ...hand, pinchM: OPEN }))]);
  await expect(overlay(page)).toHaveAttribute('data-gesture', 'none', { timeout: 45_000 });
}
async function attempts(page: Page, at: Pt, others: readonly FakeHand[], attempt: () => Promise<void>) {
  for (let count = 1; ; count++) {
    try { await attempt(); return; } catch (error) {
      if (count === 3) throw error;
      await openHands(page, at, others);
    }
  }
}
/**
 * Hover until the target has settled, then pinch and wait for the state. The fake hand jumps between far points, which
 * a real hand cannot do: a jump beyond HAND_MATCH_PX counts as a new hand and takes slot 1 while slot 0 waits out its
 * loss window. So every attempt starts with no hand in either slot, and the hands then take their slots in order.
 */
async function pinchOnce(page: Page, at: Pt, aim: Aim, others: readonly FakeHand[]) {
  await hideHand(page);
  await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
  await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'none', { timeout: 45_000 });
  await showHands(page, [{ at, pinchM: OPEN }, ...others]);
  await expect(overlay(page)).toHaveAttribute('data-hand-state', aim.hover, { timeout: 45_000 });
  if (aim.key !== null) await expect(overlay(page)).toHaveAttribute('data-hand-target', aim.key);
  await showHands(page, [{ at, pinchM: PINCH }, ...others]);
  await expect(overlay(page)).toHaveAttribute('data-hand-state', aim.state, { timeout: 10_000 });
}
const pinchOn = (page: Page, at: Pt, aim: Aim, others: readonly FakeHand[] = MOUSE_ONLY) =>
  attempts(page, at, others, () => pinchOnce(page, at, aim, others));
/** Pinch at `at`, move the hand by `by` and wait until `progressed` is true; `during` runs once the move shows. Returns where the hand ended. */
async function dragBy(page: Page, at: Pt, aim: Aim, by: Pt, progressed: () => Promise<boolean>, options: { others?: readonly FakeHand[]; during?: () => Promise<void> } = {}) {
  const others = options.others ?? MOUSE_ONLY;
  const to = shift(at, by.x, by.y);
  await attempts(page, at, others, async () => {
    await pinchOnce(page, at, aim, others);
    await showHands(page, [{ at: to, pinchM: PINCH }, ...others]);
    await expect.poll(progressed, { timeout: 20_000 }).toBe(true);
    await options.during?.();
  });
  return to;
}

test.describe('T5 pinch-move, orbit and the rest of the P0 core', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(handsUrl({ debug: true }));
  });

  test('a tap selects, a drag moves one part in one undo step, and a pinch on empty space turns only the view', async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const objectId = (await sceneCanvas(page).getAttribute('data-active-object-id'))!;
    const before = await modelRows(page);
    const objects = await sceneCanvas(page).getAttribute('data-object-json');
    await expect(undoButton(page)).toBeDisabled();
    // Tap: the part is selected, nothing is moved and nothing joins the undo history.
    const battery = await pointOn(page, 'battery');
    await pinchOn(page, battery, { key: `${objectId}:battery`, hover: 'hover', state: 'grab' });
    await expect(sceneCanvas(page)).toHaveAttribute('data-selected-ids', 'battery');
    await openHands(page, battery, MOUSE_ONLY);
    await expect(page.getByTestId('hand-debug')).toContainText('拖曳 0／完成 0／');
    await expect(undoButton(page)).toBeDisabled();
    expect(await modelRows(page)).toEqual(before);
    // Drag 外殼: the preview moves it and its children, and nothing is written until the fingers open.
    const housing = await pointOn(page, 'housing');
    const batteryBefore = (await projectOf(page, 'battery'))!;
    const dragged = await dragBy(page, housing, { key: `${objectId}:housing`, hover: 'hover', state: 'grab' }, { x: 90, y: 0 },
      async () => (await projectOf(page, 'battery'))!.x > batteryBefore.x + 30);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'grab');
    expect(await modelRows(page)).toEqual(before);
    await showHand(page, dragged, OPEN);
    await expect.poll(async () => distance((await rowOf(page, 'housing'))[1], before.find(entry => entry[0] === 'housing')![1]), { timeout: 45_000 }).toBeGreaterThan(0.02);
    // Only 外殼 changed; its children keep their local positions and follow it. The object itself did not move.
    const after = await modelRows(page);
    expect(after.filter(entry => entry[0] !== 'housing')).toEqual(before.filter(entry => entry[0] !== 'housing'));
    expect(after.find(entry => entry[0] === 'housing')![2]).toEqual(before.find(entry => entry[0] === 'housing')![2]);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    expect((await projectOf(page, 'battery'))!.x).toBeGreaterThan(batteryBefore.x + 30);
    await expect(page.getByTestId('hand-debug')).toContainText(/完成 [1-9]/);
    await undoButton(page).click();
    await expect.poll(() => modelRows(page)).toEqual(before);
    await expect(undoButton(page)).toBeDisabled();
    // Empty space: the view turns, the data does not change.
    const empty = await emptyPoint(page);
    const camera = await sceneCanvas(page).getAttribute('data-camera-position');
    await dragBy(page, empty, { key: '', hover: 'tracked', state: 'orbit' }, { x: -120, y: 0 },
      async () => (await sceneCanvas(page).getAttribute('data-camera-position')) !== camera);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'orbit');
    await openHands(page, shift(empty, -120), MOUSE_ONLY);
    expect(await modelRows(page)).toEqual(before);
    await expect(undoButton(page)).toBeDisabled();
    expect(calls).toEqual([]);
  });

  test('a pinch on a part of an inactive object activates the object, selects the part and moves it', async ({ page }) => {
    const calls = modelCalls(page);
    const second: ModelSpec = { ...structuredClone(demoModel), name: '測試：第二個物件' };
    await page.route('**/api/generate', route => {
      const body = route.request().postDataJSON() as { requestId: string };
      return route.fulfill({ json: {
        design: { status: 'ready', explanation: '測試替身模型資料。', model: second },
        source: 'codex', model: 'test-double-not-a-real-model', elapsedMs: 25, requestId: body.requestId,
      } });
    });
    await demoAndCamera(page);
    await page.getByRole('tab', { name: '生成新物件', exact: true }).click();
    await page.getByLabel('物件描述', { exact: true }).fill('再做一個物件');
    await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
    await expect(sceneCanvas(page)).toHaveAttribute('data-object-count', '2');
    await expect(sceneCanvas(page)).toHaveAttribute('data-model-name', second.name);
    const objects = JSON.parse((await sceneCanvas(page).getAttribute('data-object-json'))!) as Array<[string, unknown, unknown]>;
    const firstId = objects[0]![0];
    expect(await sceneCanvas(page).getAttribute('data-active-object-id')).not.toBe(firstId);
    const objectJson = await sceneCanvas(page).getAttribute('data-object-json');
    await sceneCanvas(page).scrollIntoViewIfNeeded();
    const housing = await pointOn(page, 'housing', firstId);
    const housingBefore = (await projectOf(page, 'housing', firstId))!;
    // The first object is still inactive here: its first pinch activates it and the drag then moves the part.
    const dragged = await dragBy(page, housing, { key: `${firstId}:housing`, hover: 'hover', state: 'grab' }, { x: 0, y: 80 },
      async () => (await projectOf(page, 'housing', firstId))!.y > housingBefore.y + 20);
    await expect(sceneCanvas(page)).toHaveAttribute('data-active-object-id', firstId);
    await expect(sceneCanvas(page)).toHaveAttribute('data-selected-ids', 'housing');
    await expect(sceneCanvas(page)).toHaveAttribute('data-model-name', demoModel.name);
    const start = await rowOf(page, 'housing');
    await showHand(page, dragged, OPEN);
    await expect.poll(async () => distance((await rowOf(page, 'housing'))[1], start[1]), { timeout: 45_000 }).toBeGreaterThan(0.02);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objectJson);
    await expect(sceneCanvas(page)).toHaveAttribute('data-active-object-id', firstId);
    expect(calls).toEqual(['generate']);
  });

  // A second pinch while the first hand grabs is a rotate since Task 8 (see "T8 two-hand rotate"); a second hand that makes a fist
  // has no row in the join rule, so it is the inert case that stays.
  test("a second hand's fist is inert while the first hand drags", async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const offset = await palmOffset(page);
    const objectId = (await sceneCanvas(page).getAttribute('data-active-object-id'))!;
    const before = await modelRows(page);
    const housing = await pointOn(page, 'housing');
    const battery = await pointOn(page, 'battery');
    expect(Math.hypot(housing.x - battery.x, housing.y - battery.y)).toBeGreaterThan(60);
    const batteryBefore = (await projectOf(page, 'battery'))!;
    // The open hand and the fist share one palm, so the hand keeps its slot when it closes.
    const second = (fist: boolean, at: Pt = battery): FakeHand => (fist ? fistAt(at) : openFor(at, offset));
    // Both hands hover; the first grabs 外殼 and drags; the second hand then makes a fist over 側邊電池.
    const first = await dragBy(page, housing, { key: `${objectId}:housing`, hover: 'hover', state: 'grab' }, { x: 0, y: 70 },
      async () => (await projectOf(page, 'battery'))!.y > batteryBefore.y + 20, {
        others: [second(false)],
        during: async () => {
          await showHands(page, [{ at: shift(housing, 0, 70), pinchM: PINCH }, second(true)]);
          await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'locked');
          await showHands(page, [{ at: shift(housing, 0, 70), pinchM: PINCH }, second(true, shift(battery, 60))]);
          await expect(sceneCanvas(page)).toHaveAttribute('data-selected-ids', 'housing');
          await expect(overlay(page)).toHaveAttribute('data-gesture', 'grab');
          await expect(overlay(page)).toHaveAttribute('data-hand-state', 'grab');
        },
      });
    await showHands(page, [{ at: first, pinchM: OPEN }, second(true, shift(battery, 60))]);
    await expect.poll(async () => distance((await rowOf(page, 'housing'))[1], before.find(entry => entry[0] === 'housing')![1]), { timeout: 45_000 }).toBeGreaterThan(0.02);
    // Only the first hand's move was committed; the second hand is free again once it opens.
    const after = await modelRows(page);
    expect(after.filter(entry => entry[0] !== 'housing')).toEqual(before.filter(entry => entry[0] !== 'housing'));
    await showHands(page, [{ at: first, pinchM: OPEN }, second(false, shift(battery, 60))]);
    await expect(overlay(page)).not.toHaveAttribute('data-hand2-state', 'locked');
    expect(calls).toEqual([]);
  });

  test('a hand lost mid-drag puts the part back and shows the cancel notice', async ({ page }) => {
    await demoAndCamera(page);
    const objectId = (await sceneCanvas(page).getAttribute('data-active-object-id'))!;
    const before = await modelRows(page);
    const housing = await pointOn(page, 'housing');
    const batteryBefore = (await projectOf(page, 'battery'))!;
    await dragBy(page, housing, { key: `${objectId}:housing`, hover: 'hover', state: 'grab' }, { x: 90, y: 0 },
      async () => (await projectOf(page, 'battery'))!.x > batteryBefore.x + 30);
    await hideHand(page);
    await expect(handStatus(page)).toHaveAttribute('data-state', 'cancelled', { timeout: 45_000 });
    await expect(handStatus(page)).toContainText('已取消這次移動');
    await expect.poll(async () => Math.abs((await projectOf(page, 'battery'))!.x - batteryBefore.x), { timeout: 45_000 }).toBeLessThan(1);
    expect(await modelRows(page)).toEqual(before);
    await expect(undoButton(page)).toBeDisabled();
    await expect(page.getByTestId('hand-debug')).toContainText(/取消 [1-9]/);
  });

  test('with 手勢 off a pinch does nothing and a mouse click still selects', async ({ page }) => {
    await demoAndCamera(page);
    const before = await modelRows(page);
    const housing = await pointOn(page, 'housing');
    await handsButton(page).click();
    await expect(handsButton(page)).toHaveAttribute('aria-pressed', 'false');
    await showHand(page, housing, PINCH);
    await showHand(page, shift(housing, 90), PINCH);
    // Proving that something stays unchanged takes a wait.
    await page.waitForTimeout(600);
    expect(await modelRows(page)).toEqual(before);
    await expect(sceneCanvas(page)).toHaveAttribute('data-selected-ids', '');
    await page.mouse.click(housing.x, housing.y);
    await expect(sceneCanvas(page)).toHaveAttribute('data-selected-ids', 'housing');
  });

  test('the exploded view and a running agent make a pinch on a part turn the view, with their notices', async ({ page }) => {
    const calls = modelCalls(page);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/agent', async (route: Route) => {
      await held;
      try { await route.abort(); } catch { /* the client already closed the request */ }
    });
    await demoAndCamera(page);
    const before = await modelRows(page);
    /** A pinch on any part turns the view and never grabs. */
    async function pinchTurnsView() {
      const point = await anyPartPoint(page);
      const camera = await sceneCanvas(page).getAttribute('data-camera-position');
      const to = await dragBy(page, point, { key: null, hover: 'locked', state: 'orbit' }, { x: -100, y: 0 },
        async () => sceneCanvas(page).getAttribute('data-camera-position').then(value => value !== camera));
      await openHands(page, to, MOUSE_ONLY);
      expect(await modelRows(page)).toEqual(before);
    }
    try {
      await page.getByRole('button', { name: '爆炸圖', exact: true }).click();
      await expect(sceneCanvas(page)).toHaveAttribute('data-explode', '1.000');
      await expect(handStatus(page)).toHaveAttribute('data-state', 'exploded');
      await expect(handStatus(page)).toContainText('爆炸圖開啟中');
      await pinchTurnsView();
      await page.getByRole('button', { name: '收回爆炸圖', exact: true }).click();
      await expect(sceneCanvas(page)).toHaveAttribute('data-explode', '0.000');
      await expect(page.locator('[data-testid="hand-status"][data-state="exploded"]')).toHaveCount(0);
      await page.getByLabel('任務指示', { exact: true }).fill('把電池改成橘色');
      await page.getByRole('button', { name: /^執行/ }).click();
      await expect(handStatus(page)).toHaveAttribute('data-state', 'agent');
      await expect(handStatus(page)).toContainText('代理執行中');
      await pinchTurnsView();
    } finally {
      release();
    }
    expect(calls).toEqual(['agent']);
  });
});

// ---- Task 6: two-hand zoom -------------------------------------------------------------------------------------------------------
/** The camera relative to its orbit target, read from the two data attributes the scene writes. */
async function cameraOf(page: Page) {
  const read = await sceneCanvas(page).evaluate(element => ({ position: element.getAttribute('data-camera-position'), target: element.getAttribute('data-camera-target') }));
  const numbers = (text: string | null) => (text ?? '').split(',').map(Number);
  const position = numbers(read.position);
  const target = numbers(read.target);
  expect([...position, ...target], 'the scene writes data-camera-position and data-camera-target').toHaveLength(6);
  const offset = position.map((value, index) => value - target[index]!);
  return {
    target,
    distance: Math.hypot(offset[0]!, offset[1]!, offset[2]!),
    azimuth: (Math.atan2(offset[0]!, offset[2]!) * 180) / Math.PI,
    polar: (Math.acos(offset[1]! / Math.hypot(offset[0]!, offset[1]!, offset[2]!)) * 180) / Math.PI,
  };
}
type Camera = Awaited<ReturnType<typeof cameraOf>>;
/** The turn between two azimuths in degrees, wrapped to (−180, 180]. */
const turned = (from: Camera, to: Camera) => ((((to.azimuth - from.azimuth) % 360) + 540) % 360) - 180;
const pair = (owner: Pt, ownerPinch: number, second: Pt, secondPinch: number): FakeHand[] => [{ at: owner, pinchM: ownerPinch }, { at: second, pinchM: secondPinch }];

/**
 * The owner hand turns the view on empty space, then the second hand pinches and joins as a zoom. Hands keep their slots, so the
 * owner is shown alone first and settles in slot 0; the second hand then appears in slot 1, more than HAND_MATCH_PX away.
 * `hover` is what the owner shows over empty space: `tracked` at full control, `locked` while view-only.
 */
async function startZoom(page: Page, owner: Pt, second: Pt, hover: 'tracked' | 'locked') {
  await attempts(page, owner, [{ at: second, pinchM: OPEN }], async () => {
    await hideHand(page);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'none', { timeout: 45_000 });
    await showHands(page, [{ at: owner, pinchM: OPEN }]);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', hover, { timeout: 45_000 });
    await showHands(page, pair(owner, OPEN, second, OPEN));
    await expect(overlay(page)).toHaveAttribute('data-hand-count', '2', { timeout: 45_000 });
    await showHands(page, pair(owner, PINCH, second, OPEN));
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'orbit', { timeout: 10_000 });
    await showHands(page, pair(owner, PINCH, second, PINCH));
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'zoom', { timeout: 10_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'join');
  });
}
/** Waits until the camera distance is within 8 % of `expected` (the filters and the frame rate decide how long a move takes). */
const distanceNear = (page: Page, expected: number) =>
  expect.poll(async () => Math.abs((await cameraOf(page)).distance / expected - 1), { timeout: 30_000 }).toBeLessThan(0.08);
/** Lets a few tracking frames pass, for proving that something stays unchanged. */
async function someFrames(page: Page, count = 8) {
  await framesAbove(page, (await frames(page)) + count);
}

test.describe('T6 two-hand zoom', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(handsUrl({ debug: true }));
  });

  test('spreading the hands zooms in with the view held still, and letting go of the second hand turns the view on from there', async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const before = await modelRows(page);
    const objects = await sceneCanvas(page).getAttribute('data-object-json');
    const owner = await emptyPoint(page);
    const second = shift(owner, -200);
    const spread = shift(second, -120);
    const start = await cameraOf(page);
    await startZoom(page, owner, second, 'tracked');
    await expect(undoButton(page)).toBeDisabled();
    // Joining alone changes nothing: the hands are inside the dead zone.
    await someFrames(page);
    expect((await cameraOf(page)).distance).toBeCloseTo(start.distance, 3);

    // Span 200 px at join, 320 px now; the dead zone takes 12 px off the change.
    await showHands(page, pair(owner, PINCH, spread, PINCH));
    const expected = (start.distance * 200) / (320 - 12);
    await distanceNear(page, expected);
    await someFrames(page, 15);
    const zoomed = await cameraOf(page);
    expect(zoomed.distance).toBeLessThan(start.distance * 0.8);
    expect(zoomed.target).toEqual(start.target);
    expect(Math.abs(turned(start, zoomed))).toBeLessThan(0.5);
    expect(Math.abs(zoomed.polar - start.polar)).toBeLessThan(0.5);
    // Display only: no data change, no undo step, no model request.
    expect(await modelRows(page)).toEqual(before);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(undoButton(page)).toBeDisabled();

    // Both hands move left together, so the span stays and the zoom with it. The first hand's move does not turn the view.
    const moved = shift(owner, -60);
    const spreadMoved = shift(spread, -60);
    await showHands(page, pair(moved, PINCH, spreadMoved, PINCH));
    await someFrames(page, 12);
    const held = await cameraOf(page);
    expect(Math.abs(turned(zoomed, held))).toBeLessThan(0.5);
    expect(held.distance).toBeCloseTo(zoomed.distance, 2);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'zoom');

    // The second hand lets go: the view stays where it is (no jump to the first hand's new place), at the zoomed distance.
    await showHands(page, pair(moved, PINCH, spreadMoved, OPEN));
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'orbit', { timeout: 20_000 });
    await someFrames(page);
    const released = await cameraOf(page);
    expect(Math.abs(turned(held, released))).toBeLessThan(3);
    expect(released.distance).toBeCloseTo(held.distance, 2);
    // The first hand goes on turning from there: 50 px at ORBIT_DEG_PER_PX (0.4) is 20 degrees, not the 44 of its whole path.
    await showHands(page, pair(shift(moved, -50), PINCH, spreadMoved, OPEN));
    await expect.poll(async () => Math.abs(turned(released, await cameraOf(page))), { timeout: 20_000 }).toBeGreaterThan(12);
    await someFrames(page);
    const turnedView = await cameraOf(page);
    expect(Math.abs(turned(released, turnedView))).toBeLessThan(28);
    expect(turnedView.distance).toBeCloseTo(released.distance, 2);

    await showHands(page, pair(shift(moved, -50), OPEN, spreadMoved, OPEN));
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'none', { timeout: 20_000 });
    expect(await modelRows(page)).toEqual(before);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(undoButton(page)).toBeDisabled();
    await expect(page.getByTestId('hand-debug')).toContainText('雙手 1');
    expect(calls).toEqual([]);
  });

  test('bringing the hands together zooms out', async ({ page }) => {
    await demoAndCamera(page);
    const before = await modelRows(page);
    const owner = await emptyPoint(page);
    const second = shift(owner, -300);
    const start = await cameraOf(page);
    await startZoom(page, owner, second, 'tracked');
    // Span 300 px at join, 200 px now: the camera backs away by 300 / (200 + 12).
    await showHands(page, pair(owner, PINCH, shift(second, 100), PINCH));
    const expected = (start.distance * 300) / (200 + 12);
    await distanceNear(page, expected);
    await someFrames(page, 15);
    const zoomed = await cameraOf(page);
    expect(zoomed.distance).toBeGreaterThan(start.distance * 1.2);
    expect(zoomed.target).toEqual(start.target);
    expect(Math.abs(turned(start, zoomed))).toBeLessThan(0.5);
    expect(await modelRows(page)).toEqual(before);
    await expect(undoButton(page)).toBeDisabled();
  });

  test('works with the exploded view open', async ({ page }) => {
    await demoAndCamera(page);
    await page.getByRole('button', { name: '爆炸圖', exact: true }).click();
    await expect(sceneCanvas(page)).toHaveAttribute('data-explode', '1.000');
    await expect(handStatus(page)).toHaveAttribute('data-state', 'exploded');
    const before = await modelRows(page);
    const objects = await sceneCanvas(page).getAttribute('data-object-json');
    const owner = await emptyPoint(page);
    const second = shift(owner, -200);
    const start = await cameraOf(page);
    await startZoom(page, owner, second, 'locked');
    await showHands(page, pair(owner, PINCH, shift(second, -120), PINCH));
    await distanceNear(page, (start.distance * 200) / (320 - 12));
    await someFrames(page, 15);
    const zoomed = await cameraOf(page);
    expect(zoomed.distance).toBeLessThan(start.distance * 0.8);
    expect(Math.abs(turned(start, zoomed))).toBeLessThan(0.5);
    // The second hand lets go and the first goes on turning the view; nothing in the data changes.
    await showHands(page, pair(owner, PINCH, shift(second, -120), OPEN));
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'orbit', { timeout: 20_000 });
    await showHands(page, pair(shift(owner, -60), PINCH, shift(second, -120), OPEN));
    await expect.poll(async () => Math.abs(turned(zoomed, await cameraOf(page))), { timeout: 20_000 }).toBeGreaterThan(10);
    expect(await modelRows(page)).toEqual(before);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(sceneCanvas(page)).toHaveAttribute('data-explode', '1.000');
    await expect(undoButton(page)).toBeDisabled();
  });
});

// ---- Task 7: fist to hold, move and explode an object ---------------------------------------------------------------------------
/** A fist placed by its palm centre (see `palmOffset`); the thumb-index distance is ignored. */
const fistAt = (at: Pt): FakeHand => ({ at, pinchM: OPEN, fist: true });
/** The cursor an open hand needs for its palm to be where a fist's palm is at `palm`. */
const openFor = (palm: Pt, offset: Pt): FakeHand => ({ at: shift(palm, -offset.x, -offset.y), pinchM: OPEN });
/** The explode amount the scene shows now (0..1). */
const explodeShown = async (page: Page) => Number(await sceneCanvas(page).getAttribute('data-explode'));

/**
 * Starts every attempt with no hand in either slot (see `pinchOnce`), then shows a fist at `at` and waits for its state: `hold`
 * when it is over an object, `fist` over empty space. A fist shown from the start has nothing to settle, so it engages after three frames.
 */
async function fistOnce(page: Page, at: Pt, others: readonly FakeHand[], state: 'hold' | 'fist') {
  await hideHand(page);
  await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
  await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'none', { timeout: 45_000 });
  await showHands(page, [fistAt(at), ...others]);
  await expect(overlay(page)).toHaveAttribute('data-hand-state', state, { timeout: 15_000 });
}
const fistOn = (page: Page, at: Pt, state: 'hold' | 'fist' = 'hold', others: readonly FakeHand[] = MOUSE_ONLY) =>
  attempts(page, at, others, () => fistOnce(page, at, others, state));
/** Fist at `at`, then move it by `by` and wait until `progressed` is true. Returns where the fist ended. */
async function fistDragBy(page: Page, at: Pt, by: Pt, progressed: () => Promise<boolean>) {
  const to = shift(at, by.x, by.y);
  await attempts(page, at, MOUSE_ONLY, async () => {
    await fistOnce(page, at, MOUSE_ONLY, 'hold');
    await showHands(page, [fistAt(to)]);
    await expect.poll(progressed, { timeout: 20_000 }).toBe(true);
  });
  return to;
}
/** A point on `partId` whose palm-mirror, `offset` above it, is on the same part too (so an open hand and a fist can share one palm over it). */
async function pointWithPalmOn(page: Page, partId: string, offset: Pt): Promise<Pt> {
  const found = await page.evaluate(([part, shiftBy]) => {
    const scene = window.__forgehandScene!;
    const centre = scene.projectPart(part!);
    if (!centre) return null;
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = centre.y - 120; y <= centre.y + 120; y += 5) {
      for (let x = centre.x - 120; x <= centre.x + 120; x += 5) {
        const here = scene.hitTest({ x, y });
        const there = scene.hitTest({ x: x - shiftBy!.x, y: y - shiftBy!.y });
        const d = Math.hypot(x - centre.x, y - centre.y);
        if (here?.partId === part && there?.partId === part && (!best || d < best.d)) best = { x, y, d };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }, [partId, offset] as const);
  expect(found, `no point on ${partId} with its palm-mirror on ${partId} found`).not.toBeNull();
  return found!;
}
const objectRows = async (page: Page): Promise<Array<[string, { x: number; y: number; z: number }, { x: number; y: number; z: number }]>> =>
  JSON.parse((await sceneCanvas(page).getAttribute('data-object-json'))!);

test.describe('T7 fist to hold, move and explode an object', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(handsUrl({ debug: true }));
  });

  test('a fist on the demo object moves the whole object, writes the object transform once on release, and one 復原 restores it', async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const offset = await palmOffset(page);
    const before = await modelRows(page);
    const objects = (await sceneCanvas(page).getAttribute('data-object-json'))!;
    const housing = await pointOn(page, 'housing');
    const batteryBefore = (await projectOf(page, 'battery'))!;
    await expect(undoButton(page)).toBeDisabled();
    const to = await fistDragBy(page, housing, { x: 100, y: 0 }, async () => (await projectOf(page, 'battery'))!.x > batteryBefore.x + 30);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'hold');
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'hold');
    await expect(page.getByTestId('hand-debug')).toContainText('握拳 是');
    // The preview moves the object; nothing is written until the fist opens.
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    expect(await modelRows(page)).toEqual(before);
    await expect(undoButton(page)).toBeDisabled();
    await showHands(page, [openFor(to, offset)]);
    await expect.poll(async () => sceneCanvas(page).getAttribute('data-object-json'), { timeout: 45_000 }).not.toBe(objects);
    // The whole object moved: its transform changed, its rotation and every part stayed as they were.
    const [movedObject] = await objectRows(page);
    const [startObject] = JSON.parse(objects) as Array<[string, { x: number; y: number; z: number }, { x: number; y: number; z: number }]>;
    expect(movedObject![0]).toBe(startObject![0]);
    expect(distance(movedObject![1], startObject![1])).toBeGreaterThan(0.02);
    expect(movedObject![2]).toEqual(startObject![2]);
    expect(await modelRows(page)).toEqual(before);
    expect((await projectOf(page, 'battery'))!.x).toBeGreaterThan(batteryBefore.x + 30);
    await expect(page.getByText('已調整物件位置，可按「復原」回到上一步。').first()).toBeVisible();
    await expect(page.getByTestId('hand-debug')).toContainText(/完成 [1-9]/);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'none');
    // One undo step puts it back.
    await undoButton(page).click();
    await expect.poll(async () => sceneCanvas(page).getAttribute('data-object-json'), { timeout: 20_000 }).toBe(objects);
    await expect(undoButton(page)).toBeDisabled();
    expect(await modelRows(page)).toEqual(before);
    expect(calls).toEqual([]);
  });

  test('a fist on a part of an inactive object makes the object active and moves it', async ({ page }) => {
    const calls = modelCalls(page);
    const second: ModelSpec = { ...structuredClone(demoModel), name: '測試：第二個物件' };
    await page.route('**/api/generate', route => {
      const body = route.request().postDataJSON() as { requestId: string };
      return route.fulfill({ json: {
        design: { status: 'ready', explanation: '測試替身模型資料。', model: second },
        source: 'codex', model: 'test-double-not-a-real-model', elapsedMs: 25, requestId: body.requestId,
      } });
    });
    await demoAndCamera(page);
    const offset = await palmOffset(page);
    await page.getByRole('tab', { name: '生成新物件', exact: true }).click();
    await page.getByLabel('物件描述', { exact: true }).fill('再做一個物件');
    await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
    await expect(sceneCanvas(page)).toHaveAttribute('data-object-count', '2');
    await expect(sceneCanvas(page)).toHaveAttribute('data-model-name', second.name);
    const start = await objectRows(page);
    const firstId = start[0]![0];
    const secondId = start[1]![0];
    expect(await sceneCanvas(page).getAttribute('data-active-object-id')).toBe(secondId);
    await sceneCanvas(page).scrollIntoViewIfNeeded();
    const housing = await pointOn(page, 'housing', firstId);
    const housingBefore = (await projectOf(page, 'housing', firstId))!;
    const to = await fistDragBy(page, housing, { x: 0, y: 90 }, async () => (await projectOf(page, 'housing', firstId))!.y > housingBefore.y + 20);
    // The first object became the active one, as a click on its part would have made it.
    await expect(sceneCanvas(page)).toHaveAttribute('data-active-object-id', firstId);
    await expect(sceneCanvas(page)).toHaveAttribute('data-model-name', demoModel.name);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'hold');
    await showHands(page, [openFor(to, offset)]);
    await expect.poll(async () => distance((await objectRows(page))[0]![1], start[0]![1]), { timeout: 45_000 }).toBeGreaterThan(0.02);
    // Only the held object moved; the other one stayed.
    expect((await objectRows(page))[1]).toEqual(start[1]);
    await expect(sceneCanvas(page)).toHaveAttribute('data-active-object-id', firstId);
    expect(calls).toEqual(['generate']);
  });

  test('a fist plus a pinch moving away raises the explode amount without an undo step, and moving back lowers it', async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const before = await modelRows(page);
    const objects = await sceneCanvas(page).getAttribute('data-object-json');
    const housing = await pointOn(page, 'housing');
    const box = (await page.getByTestId('viewport').boundingBox())!;
    // The pinch hand starts to one side of the fist, where the view has room to spread the hands apart.
    const dir = box.x + box.width - housing.x > 560 ? 1 : -1;
    const start = shift(housing, dir * 200, 30);
    const far = shift(start, dir * 150);
    const near = shift(start, -dir * 90);
    await expect(undoButton(page)).toBeDisabled();
    await expect(sceneCanvas(page)).toHaveAttribute('data-explode', '0.000');
    await attempts(page, housing, [], async () => {
      await fistOnce(page, housing, MOUSE_ONLY, 'hold');
      await showHands(page, [fistAt(housing), { at: start, pinchM: OPEN }]);
      await expect(overlay(page)).toHaveAttribute('data-hand-count', '2', { timeout: 45_000 });
      await showHands(page, [fistAt(housing), { at: start, pinchM: PINCH }]);
      await expect(overlay(page)).toHaveAttribute('data-gesture', 'explode', { timeout: 10_000 });
      await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'join');
    });
    // Joining alone does not explode: the hands are inside the dead zone.
    await someFrames(page);
    expect(await explodeShown(page)).toBe(0);
    await showHands(page, [fistAt(housing), { at: far, pinchM: PINCH }]);
    await expect.poll(() => explodeShown(page), { timeout: 30_000 }).toBeGreaterThan(0.2);
    // The explode amount is display state: the button and the slider follow it; no data change, no undo step.
    await expect(page.getByRole('button', { name: '收回爆炸圖', exact: true })).toBeVisible();
    await expect.poll(async () => Number(await page.getByLabel('拆開程度', { exact: true }).inputValue()), { timeout: 20_000 }).toBeGreaterThan(20);
    expect(await modelRows(page)).toEqual(before);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(undoButton(page)).toBeDisabled();
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'explode');
    // Moving the pinch toward the fist closes it again.
    const peak = await explodeShown(page);
    // In two steps: a hand that jumps farther than HAND_MATCH_PX between two frames would count as a new hand.
    await showHands(page, [fistAt(housing), { at: shift(start, dir * 30), pinchM: PINCH }]);
    await someFrames(page, 6);
    await showHands(page, [fistAt(housing), { at: near, pinchM: PINCH }]);
    await expect.poll(() => explodeShown(page), { timeout: 30_000 }).toBeLessThan(peak - 0.15);
    await expect(undoButton(page)).toBeDisabled();
    await expect(page.getByTestId('hand-debug')).toContainText('雙手 1');
    // The pinch lets go: the fist goes on holding, and nothing was committed.
    await showHands(page, [fistAt(housing), { at: near, pinchM: OPEN }]);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'hold', { timeout: 20_000 });
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    expect(calls).toEqual([]);
  });

  test('a fist in the exploded view still moves the object, and the status line says so', async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const offset = await palmOffset(page);
    await page.getByRole('button', { name: '爆炸圖', exact: true }).click();
    await expect(sceneCanvas(page)).toHaveAttribute('data-explode', '1.000');
    await expect(handStatus(page)).toHaveAttribute('data-state', 'exploded');
    await expect(handStatus(page)).toContainText('握拳仍可移動整個物件');
    const before = await modelRows(page);
    const objects = (await sceneCanvas(page).getAttribute('data-object-json'))!;
    const point = await anyPartPoint(page);
    const batteryBefore = (await projectOf(page, 'battery'))!;
    const to = await fistDragBy(page, point, { x: 100, y: 0 }, async () => (await projectOf(page, 'battery'))!.x > batteryBefore.x + 30);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'hold');
    await expect(sceneCanvas(page)).toHaveAttribute('data-explode', '1.000');
    await showHands(page, [openFor(to, offset)]);
    await expect.poll(async () => sceneCanvas(page).getAttribute('data-object-json'), { timeout: 45_000 }).not.toBe(objects);
    // The parts stay at their stored positions, and the view stays exploded.
    expect(await modelRows(page)).toEqual(before);
    await expect(sceneCanvas(page)).toHaveAttribute('data-explode', '1.000');
    await undoButton(page).click();
    await expect.poll(async () => sceneCanvas(page).getAttribute('data-object-json'), { timeout: 20_000 }).toBe(objects);
    await expect(sceneCanvas(page)).toHaveAttribute('data-explode', '1.000');
    expect(calls).toEqual([]);
  });

  test('a pinch that closes into a fist on a part does not move the part: the fist takes over and nothing is committed', async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const offset = await palmOffset(page);
    const before = await modelRows(page);
    const objects = await sceneCanvas(page).getAttribute('data-object-json');
    const objectId = (await sceneCanvas(page).getAttribute('data-active-object-id'))!;
    // The palm stays where it is while the fingers curl: the open hand, the pinch and the fist share one palm over the housing.
    const palm = await pointWithPalmOn(page, 'housing', offset);
    const cursor = shift(palm, -offset.x, -offset.y);
    const batteryBefore = (await projectOf(page, 'battery'))!;
    // A failed attempt on a slow camera ends with the hand hidden, which rightly cancels its half-made grab; the counters are
    // therefore compared with their values at the start of the attempt that succeeded.
    const counters = async () => {
      const text = (await page.getByTestId('hand-debug').textContent()) ?? '';
      const match = /拖曳 (\d+)／完成 (\d+)／取消 (\d+)/.exec(text);
      return match ? match.slice(1, 4).join('/') : text;
    };
    let countersAtStart = '';
    await attempts(page, cursor, MOUSE_ONLY, async () => {
      await hideHand(page);
      await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
      countersAtStart = await counters();
      await showHands(page, [{ at: cursor, pinchM: OPEN }]);
      await expect(overlay(page)).toHaveAttribute('data-hand-target', `${objectId}:housing`, { timeout: 45_000 });
      await showHands(page, [{ at: cursor, pinchM: PINCH }]);
      await expect(overlay(page)).toHaveAttribute('data-hand-state', 'grab', { timeout: 10_000 });
      await showHands(page, [fistAt(palm)]);
      await expect(overlay(page)).toHaveAttribute('data-hand-state', 'hold', { timeout: 15_000 });
    });
    // The grab was given up; the part and the object stay where they were, and no undo step exists.
    await someFrames(page, 12);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'hold');
    expect(Math.abs((await projectOf(page, 'battery'))!.x - batteryBefore.x)).toBeLessThan(1);
    expect(await modelRows(page)).toEqual(before);
    await showHands(page, [{ at: cursor, pinchM: OPEN }]);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'none', { timeout: 20_000 });
    await someFrames(page);
    expect(await modelRows(page)).toEqual(before);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(undoButton(page)).toBeDisabled();
    await expect(page.getByTestId('hand-debug')).toContainText('完成 0／');
    expect(await counters()).toBe(countersAtStart);
    expect(calls).toEqual([]);
  });

  test('a fist over empty space holds nothing: a hollow fist that changes no data', async ({ page }) => {
    await demoAndCamera(page);
    const before = await modelRows(page);
    const objects = await sceneCanvas(page).getAttribute('data-object-json');
    const empty = await emptyPoint(page);
    await fistOn(page, empty, 'fist');
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'none');
    await showHands(page, [fistAt(shift(empty, -90))]);
    await someFrames(page, 12);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'fist');
    expect(await modelRows(page)).toEqual(before);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(undoButton(page)).toBeDisabled();
  });
});

// ---- Task 8: two-hand rotate ----------------------------------------------------------------------------------------------------
const screenAngle = (from: Pt, to: Pt) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
const wrapDegrees = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;
/** Where the child 側邊電池 lies on screen as seen from 外殼, in degrees: it turns with 外殼 when 外殼 turns. */
async function childAngle(page: Page) {
  const housing = (await projectOf(page, 'housing'))!;
  const battery = (await projectOf(page, 'battery'))!;
  return screenAngle(housing, battery);
}
/**
 * Where the hands go: the first hand on 外殼, the second hand 200 px to its side on a circle around it, and which way the second
 * hand swings (clockwise or not) so that its path stays inside the view. `second(degrees)` is its place after a swing of `degrees`
 * in that direction, so a positive swing turns the vector between the hands clockwise on screen if `sign` is 1.
 */
async function rotateRig(page: Page) {
  const owner = await pointOn(page, 'housing');
  const box = (await page.getByTestId('viewport').boundingBox())!;
  const dir = box.x + box.width - owner.x > 400 ? 1 : -1;
  const middle = box.y + box.height / 2;
  // With the second hand on the right, a clockwise swing moves it down; on the left, up.
  const sign = (dir === 1) === (owner.y < middle) ? 1 : -1;
  const base = dir === 1 ? 0 : 180;
  const second = (degrees: number): Pt => ({
    x: owner.x + 200 * Math.cos(((base + sign * degrees) * Math.PI) / 180),
    y: owner.y + 200 * Math.sin(((base + sign * degrees) * Math.PI) / 180),
  });
  return { owner, sign, second };
}
/**
 * The first hand grabs 外殼, then the second hand pinches and joins as a rotate. Hands keep their slots, so the first hand is shown
 * alone and settles in slot 0; the second hand then appears in slot 1, more than HAND_MATCH_PX away.
 */
async function startRotateOnce(page: Page, objectId: string, owner: Pt, second: Pt) {
  await hideHand(page);
  await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
  await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'none', { timeout: 45_000 });
  await showHands(page, [{ at: owner, pinchM: OPEN }]);
  await expect(overlay(page)).toHaveAttribute('data-hand-target', `${objectId}:housing`, { timeout: 45_000 });
  await showHands(page, pair(owner, OPEN, second, OPEN));
  await expect(overlay(page)).toHaveAttribute('data-hand-count', '2', { timeout: 45_000 });
  await showHands(page, pair(owner, PINCH, second, OPEN));
  await expect(overlay(page)).toHaveAttribute('data-hand-state', 'grab', { timeout: 10_000 });
  await showHands(page, pair(owner, PINCH, second, PINCH));
  await expect(overlay(page)).toHaveAttribute('data-gesture', 'rotate', { timeout: 10_000 });
  await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'join');
}
const startRotate = (page: Page, objectId: string, owner: Pt, second: Pt) =>
  attempts(page, owner, [{ at: second, pinchM: OPEN }], () => startRotateOnce(page, objectId, owner, second));
const withoutHousing = (rows: Row[]) => rows.filter(entry => entry[0] !== 'housing');
const housingOf = (rows: Row[]) => rows.find(entry => entry[0] === 'housing')!;

test.describe('T8 two-hand rotate', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(handsUrl({ debug: true }));
  });

  test('swinging the second hand around the first turns only that part, in one undo step, and its position stays', async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const objectId = (await sceneCanvas(page).getAttribute('data-active-object-id'))!;
    const before = await modelRows(page);
    const objects = await sceneCanvas(page).getAttribute('data-object-json');
    const { owner, sign, second } = await rotateRig(page);
    const start = await childAngle(page);
    await startRotate(page, objectId, owner, second(0));
    await expect(undoButton(page)).toBeDisabled();
    // Joining alone changes nothing: the hands are inside the dead zone.
    await someFrames(page);
    expect(Math.abs(wrapDegrees((await childAngle(page)) - start))).toBeLessThan(2);

    // 40° of swing, less the 5° dead zone, turns the part about 35° the way the hands turned: the child follows the part on screen.
    await showHands(page, pair(owner, PINCH, second(20), PINCH));
    await someFrames(page, 6);
    await showHands(page, pair(owner, PINCH, second(40), PINCH));
    await expect.poll(async () => sign * wrapDegrees((await childAngle(page)) - start), { timeout: 30_000 }).toBeGreaterThan(12);
    await someFrames(page, 10);
    const turned = sign * wrapDegrees((await childAngle(page)) - start);
    expect(turned).toBeLessThan(60);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'rotate');
    await expect(page.getByTestId('hand-debug')).toContainText('雙手 1');
    // A preview only: no data change, no undo step.
    expect(await modelRows(page)).toEqual(before);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(undoButton(page)).toBeDisabled();

    // The second hand lets go: the turn stays, and the first hand carries on with the part (it has not moved).
    await showHands(page, pair(owner, PINCH, second(40), OPEN));
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'grab', { timeout: 20_000 });
    await someFrames(page);
    expect(Math.abs(sign * wrapDegrees((await childAngle(page)) - start) - turned)).toBeLessThan(3);
    expect(await modelRows(page)).toEqual(before);
    await expect(undoButton(page)).toBeDisabled();

    // The first hand lets go: one commit, which turns 外殼 and nothing else.
    await showHands(page, pair(owner, OPEN, second(40), OPEN));
    await expect.poll(async () => JSON.stringify(housingOf(await modelRows(page))[2]), { timeout: 45_000 }).not.toBe(JSON.stringify(housingOf(before)[2]));
    const after = await modelRows(page);
    expect(housingOf(after)[1]).toEqual(housingOf(before)[1]);
    expect(housingOf(after)[3]).toEqual(housingOf(before)[3]);
    expect(withoutHousing(after)).toEqual(withoutHousing(before));
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(page.getByText('已旋轉零件，可按「復原」回到上一步。').first()).toBeVisible();
    await expect(page.getByTestId('hand-debug')).toContainText(/完成 [1-9]/);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'none');
    // One undo step puts the turn back.
    await undoButton(page).click();
    await expect.poll(() => modelRows(page), { timeout: 20_000 }).toEqual(before);
    await expect(undoButton(page)).toBeDisabled();
    expect(calls).toEqual([]);
  });

  test('a swing smaller than the dead zone changes nothing: no turn, no commit, no undo step', async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const objectId = (await sceneCanvas(page).getAttribute('data-active-object-id'))!;
    const before = await modelRows(page);
    const objects = await sceneCanvas(page).getAttribute('data-object-json');
    const { owner, second } = await rotateRig(page);
    const start = await childAngle(page);
    await startRotate(page, objectId, owner, second(0));
    // 3° of swing is inside the 5° dead zone.
    await showHands(page, pair(owner, PINCH, second(3), PINCH));
    await someFrames(page, 15);
    expect(Math.abs(wrapDegrees((await childAngle(page)) - start))).toBeLessThan(2);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'rotate');
    await showHands(page, pair(owner, PINCH, second(3), OPEN));
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'grab', { timeout: 20_000 });
    await showHands(page, pair(owner, OPEN, second(3), OPEN));
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'none', { timeout: 20_000 });
    await someFrames(page);
    expect(await modelRows(page)).toEqual(before);
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(undoButton(page)).toBeDisabled();
    expect(calls).toEqual([]);
  });

  test('a turn and then a move of the first hand are committed together: one notice, one undo step', async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const objectId = (await sceneCanvas(page).getAttribute('data-active-object-id'))!;
    const before = await modelRows(page);
    const objects = await sceneCanvas(page).getAttribute('data-object-json');
    const { owner, sign, second } = await rotateRig(page);
    const start = await childAngle(page);
    const moved = shift(owner, 0, owner.y < 300 ? 80 : -80);
    // This test holds the gesture for a long time (turn, let go, move), so a stall of the fake camera longer than the loss window can
    // cancel it (and put the part back). Like the helpers above, the whole sequence is repeated up to three times; a turn that is
    // really lost after the move fails all three.
    await attempts(page, owner, [{ at: second(0), pinchM: OPEN }], async () => {
      await startRotateOnce(page, objectId, owner, second(0));
      await showHands(page, pair(owner, PINCH, second(20), PINCH));
      await someFrames(page, 6);
      await showHands(page, pair(owner, PINCH, second(40), PINCH));
      await expect.poll(async () => sign * wrapDegrees((await childAngle(page)) - start), { timeout: 30_000 }).toBeGreaterThan(12);
      await someFrames(page, 10);
      const turned = sign * wrapDegrees((await childAngle(page)) - start);
      // Let go with the second hand, then move the first one: the part keeps its turn and moves, without a jump.
      await showHands(page, pair(owner, PINCH, second(40), OPEN));
      await expect(overlay(page)).toHaveAttribute('data-gesture', 'grab', { timeout: 20_000 });
      const batteryBefore = (await projectOf(page, 'battery'))!;
      await showHands(page, pair(moved, PINCH, second(40), OPEN));
      await expect.poll(async () => Math.abs((await projectOf(page, 'battery'))!.y - batteryBefore.y), { timeout: 30_000 }).toBeGreaterThan(30);
      await someFrames(page, 8);
      // Moving the part across the view changes the perspective a few degrees, so the bound is loose (a lost turn is 30 or more).
      expect(Math.abs(sign * wrapDegrees((await childAngle(page)) - start) - turned)).toBeLessThan(8);
    });
    expect(await modelRows(page)).toEqual(before);
    await showHands(page, pair(moved, OPEN, second(40), OPEN));
    await expect.poll(async () => distance(housingOf(await modelRows(page))[1], housingOf(before)[1]), { timeout: 45_000 }).toBeGreaterThan(0.02);
    const after = await modelRows(page);
    expect(JSON.stringify(housingOf(after)[2])).not.toBe(JSON.stringify(housingOf(before)[2]));
    expect(withoutHousing(after)).toEqual(withoutHousing(before));
    expect(await sceneCanvas(page).getAttribute('data-object-json')).toBe(objects);
    await expect(page.getByText('已移動並旋轉零件，可按「復原」回到上一步。').first()).toBeVisible();
    await undoButton(page).click();
    await expect.poll(() => modelRows(page), { timeout: 20_000 }).toEqual(before);
    await expect(undoButton(page)).toBeDisabled();
    expect(calls).toEqual([]);
  });
});