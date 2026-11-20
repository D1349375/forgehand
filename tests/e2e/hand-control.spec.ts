import { expect, test, type Page, type Route } from '@playwright/test';
import { demoModel } from '../../shared/demo';
import type { ModelSpec } from '../../shared/model';
import { fakeHandsLog, hideHand, installFakeHands, showHand, showHands, handsUrl, type FakeHand } from './fake-hands';

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

  test("a second hand's pinch is inert while the first hand drags", async ({ page }) => {
    const calls = modelCalls(page);
    await demoAndCamera(page);
    const objectId = (await sceneCanvas(page).getAttribute('data-active-object-id'))!;
    const before = await modelRows(page);
    const housing = await pointOn(page, 'housing');
    const battery = await pointOn(page, 'battery');
    expect(Math.hypot(housing.x - battery.x, housing.y - battery.y)).toBeGreaterThan(60);
    const batteryBefore = (await projectOf(page, 'battery'))!;
    const second = (pinchM: number): FakeHand => ({ at: battery, pinchM });
    // Both hands hover; the first grabs 外殼 and drags; the second hand then pinches 側邊電池 and drags too.
    const first = await dragBy(page, housing, { key: `${objectId}:housing`, hover: 'hover', state: 'grab' }, { x: 0, y: 70 },
      async () => (await projectOf(page, 'battery'))!.y > batteryBefore.y + 20, {
        others: [second(OPEN)],
        during: async () => {
          await showHands(page, [{ at: shift(housing, 0, 70), pinchM: PINCH }, second(PINCH)]);
          await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'locked');
          await showHands(page, [{ at: shift(housing, 0, 70), pinchM: PINCH }, { at: shift(battery, 60), pinchM: PINCH }]);
          await expect(sceneCanvas(page)).toHaveAttribute('data-selected-ids', 'housing');
          await expect(overlay(page)).toHaveAttribute('data-gesture', 'grab');
          await expect(overlay(page)).toHaveAttribute('data-hand-state', 'grab');
        },
      });
    await showHands(page, [{ at: first, pinchM: OPEN }, { at: shift(battery, 60), pinchM: PINCH }]);
    await expect.poll(async () => distance((await rowOf(page, 'housing'))[1], before.find(entry => entry[0] === 'housing')![1]), { timeout: 45_000 }).toBeGreaterThan(0.02);
    // Only the first hand's move was committed; the second hand is free again once it opens.
    const after = await modelRows(page);
    expect(after.filter(entry => entry[0] !== 'housing')).toEqual(before.filter(entry => entry[0] !== 'housing'));
    await showHands(page, [{ at: first, pinchM: OPEN }, { at: shift(battery, 60), pinchM: OPEN }]);
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
