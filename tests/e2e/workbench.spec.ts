import { createHash } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import { demoModel } from '../../shared/demo';
import { installFakeHands } from './fake-hands';
import type { ModelSpec } from '../../shared/model';

const generationButton = (page: Page) => page.getByRole('button', { name: '生成 3D 草案', exact: true });
const modelName = (page: Page) => page.getByTestId('model-name');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function copyModel(name: string): ModelSpec {
  return { ...structuredClone(demoModel), name };
}

async function fulfillModel(route: Route, model: ModelSpec, status: 'ready' | 'approximation' = 'ready') {
  const request = route.request().postDataJSON() as { requestId: string };
  await route.fulfill({
    json: {
      design: { status, explanation: status === 'approximation' ? '自由曲面將用規則幾何近似，請先確認。' : '測試替身模型資料。', model },
      source: 'codex',
      model: 'test-double-not-a-real-model',
      elapsedMs: 25,
      requestId: request.requestId,
    },
  });
}

async function submit(page: Page, prompt: string) {
  // With a model on screen the text box defaults to editing it (phase two).
  const create = page.getByRole('tab', { name: '生成新物件', exact: true });
  if (await create.count()) await create.click();
  await page.getByLabel('物件描述', { exact: true }).fill(prompt);
  await generationButton(page).click();
}

test.beforeEach(async ({ context, page }) => {
  await installFakeHands(context);
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
});

test('示範資料明確標示，真實 WebGL 畫布可旋轉、縮放、重設', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await expect(modelName(page)).toHaveText(demoModel.name);
  await expect(page.getByText('這是預先建立的示範資料，並非 AI 生成。', { exact: true })).toBeVisible();
  const canvas = page.getByTestId('scene-canvas');
  await expect(canvas).toBeVisible();
  // Wait for OrbitControls damping to settle before comparing actual rendered pixels.
  await page.waitForTimeout(700);
  const initial = await canvas.screenshot();
  const initialCamera = await canvas.getAttribute('data-camera-position');
  expect(initialCamera).toBeTruthy();
  expect(initial.length).toBeGreaterThan(5_000);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.45, box!.y + box!.height * 0.50);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.70, box!.y + box!.height * 0.60, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const rotated = await canvas.screenshot();
  const rotatedCamera = await canvas.getAttribute('data-camera-position');
  expect(hash(rotated)).not.toBe(hash(initial));
  expect(rotatedCamera).not.toBe(initialCamera);
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.waitForTimeout(700);
  const zoomed = await canvas.screenshot();
  expect(hash(zoomed)).not.toBe(hash(rotated));
  expect(await canvas.getAttribute('data-camera-position')).not.toBe(rotatedCamera);
  await page.getByRole('button', { name: '縮小', exact: true }).click();
  await page.getByRole('button', { name: '重設視角', exact: true }).click();
  await page.waitForTimeout(700);
  const reset = await canvas.screenshot();
  expect(hash(reset)).not.toBe(hash(zoomed));
  // Reset restores the fitted camera, rather than merely redrawing a different image.
  expect(await canvas.getAttribute('data-camera-position')).toBe(initialCamera);
  expect(errors).toEqual([]);
  await testInfo.attach('科技透視示範模型', { body: reset, contentType: 'image/png' });
});

test('模擬攝影機可開啟、關閉、重新開啟並保持 3D 疊圖', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await page.getByRole('button', { name: '開啟攝影機', exact: true }).click();
  const video = page.getByTestId('viewport').locator('video');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
  await expect(page.getByTestId('scene-canvas')).toBeVisible();
  // Retain references to the actual mock device tracks to verify release.
  await video.evaluate((element: HTMLVideoElement) => { (window as unknown as { testTracks: MediaStreamTrack[] }).testTracks = (element.srcObject as MediaStream).getTracks(); });
  await page.getByRole('button', { name: '關閉攝影機', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { testTracks: MediaStreamTrack[] }).testTracks.every(track => track.readyState === 'ended'))).toBe(true);
  await expect(modelName(page)).toHaveText(demoModel.name);
  await page.getByRole('button', { name: '開啟攝影機', exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
});

test('拒絕攝影機權限後可恢復，模型仍可檢視', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let calls = 0;
    navigator.mediaDevices.getUserMedia = constraints => ++calls === 1
      ? Promise.reject(new DOMException('test denial', 'NotAllowedError'))
      : original(constraints);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await page.getByRole('button', { name: '開啟攝影機', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/攝影機|權限|授權/);
  await expect(modelName(page)).toHaveText(demoModel.name);
  await page.getByRole('button', { name: '開啟攝影機', exact: true }).click();
  await expect(page.getByRole('button', { name: '關閉攝影機', exact: true })).toBeVisible();
});

test('自由描述透過服務端請求，驗證成功後才替換模型', async ({ page }) => {
  let receivedPrompt = '';
  await page.route('**/api/generate', async route => {
    receivedPrompt = route.request().postDataJSON().prompt;
    await fulfillModel(route, copyModel('測試：未預編排的雙鏡頭與電池組件'));
  });
  await page.goto('/');
  const prompt = '請做一個帶兩個鏡頭的藍色小裝置，右側另外接一個紅色電池';
  await submit(page, prompt);
  await expect(modelName(page)).toHaveText('測試：未預編排的雙鏡頭與電池組件');
  expect(receivedPrompt).toBe(prompt);
  await expect(page.getByTestId('scene-canvas')).toBeVisible();
});

test('模型服務失敗保留上一個成功模型，可重試', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/generate', async route => {
    if (++attempts === 1) await route.fulfill({ status: 502, json: { error: { code: 'PROVIDER_ERROR', message: '模型服務暫時無法使用，請重試。' } } });
    else await fulfillModel(route, copyModel('重試成功模型'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await submit(page, '一個紅色四腳小桌');
  await expect(page.getByRole('alert')).toContainText(/模型服務|重試/);
  await expect(modelName(page)).toHaveText(demoModel.name);
  await generationButton(page).click();
  await expect(modelName(page)).toHaveText('重試成功模型');
});

test('無效模型資料不能進入場景或清除舊模型', async ({ page }) => {
  await page.route('**/api/generate', async route => {
    const invalid = copyModel('無效資料');
    invalid.parts[0].dimensions.x = -1;
    await fulfillModel(route, invalid);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await submit(page, '測試無效資料');
  await expect(page.getByRole('alert')).toContainText(/資料|驗證|格式/);
  await expect(modelName(page)).toHaveText(demoModel.name);
});

test('非 JSON 服務錯誤提供可理解訊息，保留上一個模型', async ({ page }) => {
  await page.route('**/api/generate', route => route.fulfill({ status: 502, contentType: 'text/plain', body: 'unavailable' }));
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await submit(page, '一張新的小桌');
  await expect(page.getByRole('alert')).toContainText('模型服務回覆資料無法讀取');
  await expect(modelName(page)).toHaveText(demoModel.name);
});

test('連續請求以最新請求為準，舊回應不能覆蓋', async ({ page }) => {
  let releaseFirst: (() => void) | undefined;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  let requests = 0;
  await page.route('**/api/generate', async route => {
    const index = ++requests;
    if (index === 1) {
      await firstHeld;
      // The browser may have aborted this obsolete request. Either outcome is valid.
      await fulfillModel(route, copyModel('過期的第一個模型')).catch(() => undefined);
    } else await fulfillModel(route, copyModel('最新的第二個模型'));
  });
  await page.goto('/');
  await submit(page, '第一個慢請求');
  await expect.poll(() => requests).toBe(1);
  await submit(page, '第二個較快請求');
  await expect(modelName(page)).toHaveText('最新的第二個模型');
  releaseFirst!();
  await page.waitForTimeout(300);
  await expect(modelName(page)).toHaveText('最新的第二個模型');
  expect(requests).toBe(2);
});

test('近似模型先取得選擇，取消保留舊模型，接受後才建立', async ({ page }) => {
  await page.route('**/api/generate', route => fulfillModel(route, copyModel('使用者接受的近似模型'), 'approximation'));
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await submit(page, '用精細曲面做一隻動物');
  await expect(page.getByText('自由曲面將用規則幾何近似，請先確認。', { exact: true })).toBeVisible();
  await expect(modelName(page)).toHaveText(demoModel.name);
  await page.getByRole('button', { name: '取消近似', exact: true }).click();
  await expect(modelName(page)).toHaveText(demoModel.name);
  await generationButton(page).click();
  await page.getByRole('button', { name: '接受近似並建立', exact: true }).click();
  await expect(modelName(page)).toHaveText('使用者接受的近似模型');
});

test('不支援的描述提供說明並保留上一模型', async ({ page }) => {
  await page.route('**/api/generate', route => route.fulfill({ json: {
    design: { status: 'unsupported', explanation: '此描述無法建立可辨識的規則幾何草案，請描述主要形狀與組件。', model: null },
    source: 'codex', model: 'test-double-not-a-real-model', elapsedMs: 25,
    requestId: route.request().postDataJSON().requestId,
  } }));
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await submit(page, '請讓時間倒流');
  await expect(page.getByRole('alert')).toContainText('主要形狀與組件');
  await expect(modelName(page)).toHaveText(demoModel.name);
});

test('未設定金鑰時提供設定狀態，示範功能仍可使用', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { configured: false, provider: 'openai', model: 'gpt-4.1-mini' } }));
  await page.goto('/');
  await expect(page.getByText(/未設定|尚未設定/).first()).toBeVisible();
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await expect(modelName(page)).toHaveText(demoModel.name);
});

test('窄螢幕仍可操作文字與展示區', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByLabel('物件描述', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  await expect(modelName(page)).toHaveText(demoModel.name);
  await expect(page.getByTestId('scene-canvas')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
