import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { GeneratedDesign } from '../../shared/model';

// Opt-in visual replay of captured REAL CLI data. No new model requests are
// made here; this is not a generation latency or physical-camera benchmark.
const enabled = process.env.REVIEW_CAPTURED_MODELS === '1';
const artifact = path.resolve('artifacts/real-provider-2026-11-10.json');
type Captured = { id: string; prompt: string; model: string; elapsedMs: number; design: GeneratedDesign };
const cases: Captured[] = enabled && existsSync(artifact)
  ? JSON.parse(readFileSync(artifact, 'utf8')).runs.at(-1).results : [];

for (const captured of cases) {
  test(`真 CLI 資料重播 ${captured.id}`, async ({ page }, testInfo) => {
    await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: captured.model } }));
    await page.route('**/api/generate', route => route.fulfill({ json: {
      design: captured.design, source: 'codex', model: captured.model, elapsedMs: captured.elapsedMs,
      requestId: route.request().postDataJSON().requestId,
    } }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('物件描述', { exact: true }).fill(captured.prompt);
    await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
    if (captured.design.status === 'approximation') await page.getByRole('button', { name: '接受近似並建立', exact: true }).click();
    const canvas = page.getByTestId('scene-canvas');
    await expect(canvas).toHaveAttribute('data-model-name', captured.design.model!.name);
    await expect(canvas).toHaveAttribute('data-part-count', String(captured.design.model!.parts.length));
    await page.waitForTimeout(400);
    const directory = path.resolve('artifacts/local/captured');
    const image = await page.getByTestId('viewport').screenshot({ path: path.join(directory, `${captured.id}.png`) });
    await testInfo.attach(`${captured.id}-captured-real-data`, { body: image, contentType: 'image/png' });
    if (['P01', 'P03', 'P10'].includes(captured.id)) {
      const box = (await canvas.boundingBox())!;
      for (const angle of ['side', 'back']) {
        await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        await page.getByTestId('viewport').screenshot({ path: path.join(directory, `${captured.id}-${angle}.png`) });
      }
    }
  });
}
