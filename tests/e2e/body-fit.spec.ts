import { expect, test, type Page } from '@playwright/test';
import { ellipsePerimeter } from '../../shared/ellipse';
import { CARD_LONG_MM, CARD_SHORT_MM, DEFAULT_BAND_OFFSET_MM } from '../../shared/fit-constants';
import { installFakeBody, showBody, type ShownBody } from './fake-body';

/**
 * Body fit, Task 3 (spec body-fit): the fit panel, the guided wrist measurement, the tape input and the card calibration,
 * with the scripted worker of `fake-body.ts` (synthetic hands and masks, no model download) and a camera that is a square
 * canvas, so the synthetic hand has the same pixels per metre in x and y. Nothing here calls a model service.
 */

declare global {
  interface Window { __fakeCard?: { x: number; y: number }[] | null; __shake?: number }
}

const FRAME = 480;
const PINCH_M = 0.04;

test.beforeEach(async ({ context, page }) => {
  await installFakeBody(context);
  await page.addInitScript(({ size }) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context2d = canvas.getContext('2d')!;
      const stream = canvas.captureStream(20);
      const track = stream.getVideoTracks()[0]!;
      const paint = () => {
        if (track.readyState === 'ended') return;
        context2d.fillStyle = '#5a5a5a';
        context2d.fillRect(0, 0, size, size);
        // The tracking frame is mirrored like the display, so a card at frame point x is painted at size - x in the source.
        const card = window.__fakeCard;
        if (card) {
          context2d.fillStyle = '#f2f2f2';
          context2d.beginPath();
          card.forEach((point, index) => (index ? context2d.lineTo(size - point.x, point.y) : context2d.moveTo(size - point.x, point.y)));
          context2d.closePath();
          context2d.fill();
        }
        requestAnimationFrame(paint);
      };
      paint();
      return stream;
    };
  }, { size: FRAME });
});

/** Every request to the local server after fitting started: body fit must make none (R108). */
const apiRequests: string[] = [];

async function openFit(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-model-json', /battery/);
  await page.getByRole('button', { name: '護臂試戴', exact: true }).click();
  await expect(page.getByTestId('fit-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (document.querySelector('video.camera-video') as HTMLVideoElement | null)?.videoWidth ?? 0)).toBeGreaterThan(0);
  apiRequests.length = 0;
  page.on('request', request => { if (/\/api\//.test(request.url())) apiRequests.push(request.url()); });
}

test.afterEach(() => {
  expect(apiRequests).toEqual([]);
});

/** Shows a right hand with a forearm of `widthMm` and returns what a correct measurement sees. */
async function showArm(page: Page, widthMm: number, extra: { luma?: number } = {}): Promise<ShownBody> {
  const rect = await page.evaluate(() => {
    const box = (document.querySelector('video.camera-video') as HTMLVideoElement).getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  });
  return showBody(page, { hands: [{ at: { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.4 }, pinchM: PINCH_M }], maskWidthMm: widthMm, ...extra });
}

/** Turns the shown hands about the vertical axis through their wrists, in the image and the world landmarks, like a wrist turned to thumb up. */
async function turnHands(page: Page, degrees: number): Promise<void> {
  await page.evaluate(deg => {
    const state = window.__fakeBody!;
    const cos = Math.cos(deg * Math.PI / 180), sin = Math.sin(deg * Math.PI / 180);
    type Point = { x: number; y: number; z: number };
    state.message = {
      ...state.message,
      hands: (state.message.hands as { points: Point[]; world: Point[] }[]).map(hand => {
        const wrist = hand.points[0]!;
        return {
          ...hand,
          points: hand.points.map(point => ({ ...point, x: wrist.x + (point.x - wrist.x) * cos, z: -(point.x - wrist.x) * sin })),
          world: hand.world.map(point => ({ ...point, x: point.x * cos, z: -point.x * sin })),
        };
      }),
    };
    state.channel.postMessage(state.message);
  }, degrees);
}

const numberIn = (text: string, pattern: RegExp): number => Number(pattern.exec(text)?.[1] ?? Number.NaN);

async function measureWidth(page: Page): Promise<void> {
  await page.getByRole('button', { name: '量寬度' }).click();
  await expect(page.getByTestId('fit-step-width')).toHaveAttribute('data-done', 'true', { timeout: 30_000 });
}

test('step 1 records the width of a palm-facing hand and shows it with its source', async ({ page }) => {
  await openFit(page);
  const panel = page.getByTestId('fit-panel');
  await showArm(page, 58);
  await expect(panel).toHaveAttribute('data-fit-state', 'worn');
  await expect(panel).toHaveAttribute('data-fit-step', 'idle');
  await page.getByRole('button', { name: '量寬度' }).click();
  await expect(panel).toHaveAttribute('data-fit-step', 'width');
  await expect(page.getByTestId('fit-step-status')).toContainText('手掌朝向鏡頭，手腕放鬆，保持不動。');
  const result = page.getByTestId('fit-result');
  await expect(result).toContainText('相機估計', { timeout: 30_000 });
  const text = await result.innerText();
  expect(numberIn(text, /寬 ([\d.]+) mm/)).toBeGreaterThan(56.5);
  expect(numberIn(text, /寬 ([\d.]+) mm/)).toBeLessThan(59.5);
  expect(text).toMatch(/± [\d.]+ mm/);
  expect(text).toContain('厚度依一般比例估計');
  await expect(panel).toHaveAttribute('data-fit-source', 'estimate');
  await expect(panel).toHaveAttribute('data-fit-step', 'idle');
  // The segmenter state of the fake worker reached the panel without a note on screen (it is ready).
  await expect(page.getByText('量測模型無法載入')).toHaveCount(0);
});

test('step 2 with a turned wrist shows the thickness and the circumference', async ({ page }) => {
  await openFit(page);
  const panel = page.getByTestId('fit-panel');
  await showArm(page, 58);
  await measureWidth(page);
  await showArm(page, 39);
  await page.getByRole('button', { name: '量厚度' }).click();
  // The palm still faces the camera, so the step says what to change.
  await expect(page.locator('[data-testid="fit-step-status"] [data-reason="thumb-up"]')).toHaveText('請把手腕轉成拇指朝上');
  await turnHands(page, 90);
  await expect(panel).toHaveAttribute('data-fit-step', 'done', { timeout: 30_000 });
  const text = await page.getByTestId('fit-result').innerText();
  expect(numberIn(text, /厚 ([\d.]+) mm/)).toBeGreaterThan(37.5);
  expect(numberIn(text, /厚 ([\d.]+) mm/)).toBeLessThan(40.5);
  const circumference = numberIn(text, /周長 ([\d.]+) mm/);
  expect(Math.abs(circumference - ellipsePerimeter(29, 19.5))).toBeLessThan(3);
  expect(text).toContain('（相機估計）');
  expect(text).not.toContain('厚度依一般比例估計');
});

test('a hand that moves keeps the step waiting with 請保持不動', async ({ page }) => {
  await openFit(page);
  await showArm(page, 58);
  await page.evaluate(() => {
    const state = window.__fakeBody!;
    const base = state.message.hands as { points: { x: number }[] }[];
    let toggle = 0;
    window.__shake = window.setInterval(() => {
      const dx = toggle++ % 2 ? 0.06 : -0.06;
      state.message = { ...state.message, hands: base.map(hand => ({ ...hand, points: hand.points.map(point => ({ ...point, x: point.x + dx })) })) };
      state.channel.postMessage(state.message);
    }, 70);
  });
  await page.getByRole('button', { name: '量寬度' }).click();
  const reason = page.locator('[data-testid="fit-step-status"] [data-reason="still"]');
  await expect(reason).toHaveText('請保持不動');
  await expect(page.getByTestId('fit-step-width')).toHaveAttribute('data-done', 'false');
  // Held still again, the same step completes.
  await page.evaluate(() => {
    window.clearInterval(window.__shake);
    const state = window.__fakeBody!;
    state.message = { ...state.message, hands: (state.message.hands as { points: { x: number }[] }[]).map(hand => ({ ...hand, points: hand.points.map(point => ({ ...point, x: point.x + 0 })) })) };
  });
  await showArm(page, 58);
  await expect(page.getByTestId('fit-step-width')).toHaveAttribute('data-done', 'true', { timeout: 30_000 });
});

test('a typed tape value becomes the source, with the error line of the camera against it', async ({ page }) => {
  await openFit(page);
  const panel = page.getByTestId('fit-panel');
  await showArm(page, 58);
  await measureWidth(page);
  const field = page.getByTestId('fit-tape-circumferenceMm');
  await field.fill('165');
  await field.press('Enter');
  await expect(panel).toHaveAttribute('data-fit-source', 'tape');
  await expect(page.getByTestId('fit-result')).toContainText('165 mm（捲尺）');
  const error = page.getByTestId('fit-camera-error');
  await expect(error).toHaveText(/^相機估計 [\d.]+ mm，捲尺 165 mm，相機偏小 [\d.]+ mm（[\d.]+%）$/);
  await page.getByTestId('fit-panel').screenshot({ path: 'artifacts/local/body-fit-task3-panel.png' });
  // Clearing the tape value goes back to the camera.
  await page.getByRole('button', { name: '清除捲尺值' }).click();
  await expect(panel).toHaveAttribute('data-fit-source', 'estimate');
  await expect(error).toHaveCount(0);
});

test('refuses tape values outside their range and reads centimetres', async ({ page }) => {
  await openFit(page);
  const panel = page.getByTestId('fit-panel');
  const circumference = page.getByTestId('fit-tape-circumferenceMm');
  await circumference.fill('50');
  await circumference.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: '請輸入 100–300 mm 之間的數值。' })).toBeVisible();
  await expect(circumference).toHaveAttribute('aria-invalid', 'true');
  await expect(panel).toHaveAttribute('data-fit-source', 'estimate');
  const width = page.getByTestId('fit-tape-widthMm');
  await width.fill('20');
  await width.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: '請輸入 30–120 mm 之間的數值。' })).toBeVisible();
  await expect(panel).toHaveAttribute('data-fit-source', 'estimate');
  // A valid value clears its message; the unit switch reads centimetres.
  await circumference.fill('16.5');
  await page.getByLabel('單位').selectOption('cm');
  await circumference.fill('16.5');
  await circumference.press('Enter');
  await expect(panel).toHaveAttribute('data-fit-source', 'tape');
  await expect(page.getByTestId('fit-result')).toContainText('165 mm（捲尺）');
  await expect(circumference).toHaveAttribute('aria-invalid', 'false');
  // Tape alone: the thickness comes from the usual ratio and says so.
  await expect(page.getByTestId('fit-result')).toContainText('厚度依一般比例估計');
});

/** The corners of a card, `scale` times the size the guide expects, centred on the guide, along the arm (frame pixels). */
function cardAt(shown: ShownBody, scale: number, longScale = scale): { x: number; y: number }[] {
  const { mmPerPx, wristPx, distal } = shown;
  const centre = { x: wristPx!.x - distal!.x * DEFAULT_BAND_OFFSET_MM / mmPerPx!, y: wristPx!.y - distal!.y * DEFAULT_BAND_OFFSET_MM / mmPerPx! };
  const across = { x: -distal!.y, y: distal!.x };
  const long = CARD_LONG_MM / mmPerPx! * longScale / 2;
  const short = CARD_SHORT_MM / mmPerPx! * scale / 2;
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]) => ({
    x: centre.x + distal!.x * a * long + across.x * b * short, y: centre.y + distal!.y * a * long + across.y * b * short,
  }));
}

test('the card guide freezes the frame, finds the card, takes keyboard edge moves, and calibrates', async ({ page }) => {
  await openFit(page);
  const panel = page.getByTestId('fit-panel');
  const shown = await showArm(page, 58);
  await expect(panel).toHaveAttribute('data-fit-state', 'worn');
  // A card 4 % smaller than the guide expects, so the camera estimate was too small.
  await page.evaluate(corners => { window.__fakeCard = corners; }, cardAt(shown, 0.96));
  await page.getByRole('button', { name: '開始校正' }).click();
  const guide = page.getByTestId('card-guide');
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute('data-phase', 'aiming');
  await expect(panel).toHaveAttribute('data-fit-step', 'card');
  // The hand stays still for a second: the frame freezes and the edges are found by themselves.
  const frozen = page.getByTestId('card-frozen');
  await expect(frozen).toBeVisible({ timeout: 20_000 });
  await expect(frozen).toHaveAttribute('data-found', 'true');
  await expect(page.getByTestId('card-no-edges')).toHaveCount(0);
  // Retake unfreezes and aims again, then it freezes once more.
  await page.getByRole('button', { name: '重拍', exact: true }).click();
  await expect(guide).toHaveAttribute('data-phase', 'aiming');
  await expect(frozen).toBeVisible({ timeout: 20_000 });
  // The four edges are keyboard sliders; the arrow along an edge's normal moves it by 1 px and the opposite arrow moves it back.
  const edge = page.getByRole('slider', { name: '卡片右緣' });
  await edge.focus();
  const readEdge = async () => Number(await edge.getAttribute('aria-valuenow'));
  const start = await readEdge();
  let moved = 0;
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
    const before = await readEdge();
    await page.keyboard.press(key);
    moved += Math.abs(await readEdge() - before);
  }
  expect(moved).toBeCloseTo(2, 5);
  expect(await readEdge()).toBeCloseTo(start, 5);
  for (const name of ['卡片左緣', '卡片上緣', '卡片下緣']) await expect(page.getByRole('slider', { name })).toBeVisible();
  await page.getByRole('button', { name: '確認', exact: true }).click();
  await expect(guide).toHaveCount(0);
  await expect(panel).toHaveAttribute('data-fit-source', 'card');
  await expect(page.getByTestId('fit-calibration')).toContainText(/校正完成：相機估計原本(偏大|偏小) \d+%。|校正完成：相機估計與卡片相符。/);
  // The card made the estimate bigger or smaller by a few percent, never absurdly.
  const percent = Number(/(\d+)%/.exec(await page.getByTestId('fit-calibration').innerText())?.[1] ?? 0);
  expect(percent).toBeLessThan(15);
  // Clearing the calibration returns to the camera estimate.
  await page.getByRole('button', { name: '清除校正' }).click();
  await expect(panel).toHaveAttribute('data-fit-source', 'estimate');
});

test('measuring after a calibration reports the card as the source of the camera lengths', async ({ page }) => {
  await openFit(page);
  const panel = page.getByTestId('fit-panel');
  const shown = await showArm(page, 58);
  await page.evaluate(corners => { window.__fakeCard = corners; }, cardAt(shown, 0.96));
  await page.getByRole('button', { name: '開始校正' }).click();
  await expect(page.getByTestId('card-frozen')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '確認', exact: true }).click();
  await page.evaluate(() => { window.__fakeCard = null; });
  await measureWidth(page);
  await expect(panel).toHaveAttribute('data-fit-source', 'card');
  await expect(page.getByTestId('fit-result')).toContainText('（卡片校正）');
});

test('cancelling the calibration leaves the source unchanged, and a card of the wrong shape is refused', async ({ page }) => {
  await openFit(page);
  const panel = page.getByTestId('fit-panel');
  const shown = await showArm(page, 58);
  // A card a fifth too short along the arm: its edges are found, but its aspect ratio is not a card's.
  await page.evaluate(corners => { window.__fakeCard = corners; }, cardAt(shown, 1, 0.8));
  await page.getByRole('button', { name: '開始校正' }).click();
  await expect(page.getByTestId('card-frozen')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '確認', exact: true }).click();
  await expect(page.getByTestId('card-rejected')).toHaveText('卡片尺寸量起來不合理，請讓卡片平貼並正對鏡頭後重拍。');
  await expect(panel).toHaveAttribute('data-fit-source', 'estimate');
  await page.getByRole('button', { name: '取消校正' }).click();
  await expect(page.getByTestId('card-guide')).toHaveCount(0);
  await expect(panel).toHaveAttribute('data-fit-source', 'estimate');
  await expect(page.getByTestId('fit-calibration')).toHaveCount(0);
});

test('without a card in the picture the guide says the edges were not found and keeps them on the guide line', async ({ page }) => {
  await openFit(page);
  await showArm(page, 58);
  await page.getByRole('button', { name: '開始校正' }).click();
  await expect(page.getByTestId('card-frozen')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('card-frozen')).toHaveAttribute('data-found', 'false');
  await expect(page.getByTestId('card-no-edges')).toHaveText('沒有自動找到卡片邊緣，請手動拖曳四條邊對齊卡片。');
  // The guide sits at the expected card size, so confirming gives a plausible factor.
  await page.getByRole('button', { name: '確認', exact: true }).click();
  await expect(page.getByTestId('fit-panel')).toHaveAttribute('data-fit-source', 'card');
});

test('the panel and the steps switch to English with the language switch', async ({ page }) => {
  // Until english-ui turns English on, the switch shows only with a lang parameter.
  await openFit(page, '?lang=zh-TW');
  const panel = page.getByTestId('fit-panel');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  // Switching the language asks the local server for its status again; that is not body fit.
  await page.waitForTimeout(500);
  apiRequests.length = 0;
  await showArm(page, 58);
  await page.getByRole('button', { name: 'Measure width' }).click();
  await expect(page.getByTestId('fit-result')).toContainText('(Camera estimate)', { timeout: 30_000 });
  await expect(page.getByTestId('fit-result')).toContainText('Thickness assumed from a typical ratio');
  await expect(panel.getByRole('heading', { name: 'Try-on and measuring' })).toBeVisible();
  for (const section of ['fit-source', 'fit-measure', 'fit-card', 'fit-tape', 'fit-clearance']) {
    await expect(page.getByTestId(section)).not.toContainText(/[\u4e00-\u9fff]/);
  }
});