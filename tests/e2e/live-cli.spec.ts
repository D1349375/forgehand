import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { validateGenerationResult } from '../../shared/model';

// Opt in deliberately: this sends a REAL request using the logged-in CLI.
// The camera is the Chromium fake device; no physical-camera claim is made.
if (process.env.RUN_LIVE_CLI === '1') {
  test('文字到真 CLI 到瀏覽器 3D 的完整流程', async ({ page, request }) => {
    test.setTimeout(360_000);
    await page.setViewportSize({ width: 1100, height: 800 });
    // Keep this resource-sensitive integration test separate from the 720p
    // camera rendering cases; no physical-camera performance is inferred.
    await page.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = () => original({ audio: false,
        video: { width: { ideal: 640, max: 640 }, height: { ideal: 480, max: 480 }, frameRate: { ideal: 5, max: 5 } } });
    });
    const status = await (await request.get('/api/status')).json();
    expect(['codex', 'claude']).toContain(status.provider);
    expect(status.configured).toBe(true);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '開啟攝影機', exact: true }).click();
    await expect(page.getByRole('button', { name: '關閉攝影機', exact: true })).toBeVisible({ timeout: 30_000 });
    const cameraSettings = await page.locator('video').evaluate((element: HTMLVideoElement) => {
      const settings = (element.srcObject as MediaStream).getVideoTracks()[0].getSettings();
      return { width: settings.width, height: settings.height, frameRate: settings.frameRate };
    });
    const prompt = '一個橘色圓形底座，上面立兩根藍色短柱，共同托住一個綠色球體；請把每根柱子獨立成零件。';
    await page.getByLabel('物件描述', { exact: true }).fill(prompt);
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/generate') && r.request().method() === 'POST', { timeout: 240_000 });
    const started = performance.now();
    const observation: Record<string, unknown> = { testedAt: new Date().toISOString(), timezone: 'Asia/Taipei', prompt,
      provider: status.provider, selectedModel: status.model, browser: page.context().browser()?.version(),
      physicalCamera: false, camera: 'Chromium fake device', outcome: 'failed', result: null,
      cameraSettings,
      observedSubmitToCanvasCommitMs: null,
      measurement: '真實文字送出→CLI→HTTP→模型驗證→canvas模型名稱提交；包含瀏覽器等待，不等同人工辨認或GPU完成。' };
    try {
    await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
    const response = await responsePromise;
    observation.httpStatus = response.status();
    const responseBody = await response.json();
    if (response.status() !== 200) observation.serviceError = responseBody;
    expect(response.status()).toBe(200);
    const result = validateGenerationResult(responseBody);
    observation.result = result;
    expect(result.source).toBe(status.provider);
    expect(result.design.status).toBe('ready');
    await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-model-name', result.design.model!.name, { timeout: 30_000 });
    await expect(page.getByRole('status')).toContainText('3D 草案已建立');
    const observedMs = Math.round(performance.now() - started);
    observation.observedSubmitToCanvasCommitMs = observedMs;
    observation.outcome = 'passed';
    const directory = path.resolve('artifacts/local');
    await mkdir(directory, { recursive: true });
    await page.getByTestId('viewport').screenshot({ path: path.join(directory, 'live-cli-camera-overlay.png') });
    await page.getByRole('button', { name: '關閉攝影機', exact: true }).click();
    await page.screenshot({ path: path.join(directory, 'live-cli-workbench.png'), fullPage: true });
    } catch (error) {
      observation.failure = error instanceof Error ? error.message.slice(0, 600) : 'Live UI verification failed';
      throw error;
    } finally {
      const file = path.resolve('artifacts/live-ui-2026-11-10.json');
      let runs: unknown[] = [];
      try { runs = JSON.parse(await readFile(file, 'utf8')).runs ?? []; } catch { /* first run */ }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ schemaVersion: 1, runs: [...runs, observation] }, null, 2) + '\n');
    }
  });
}
