import { expect, test, type Page } from '@playwright/test';
import { fakeHandsLog, hideHand, installFakeHands, showHand } from './fake-hands';

// Hand control is tested against a scripted worker (fake-hands.ts); the camera
// stream, the capture loop and the app are real.

test.beforeEach(async ({ context, page }) => {
  test.setTimeout(150_000);
  await installFakeHands(context);
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
  await page.goto('/');
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
    await expect(overlay).toHaveAttribute('data-hand-mode', 'translate');
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