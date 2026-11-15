import { expect, test, type Page } from '@playwright/test';
import { fakeHandsLog, installFakeHands, showHand } from './fake-hands';

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
