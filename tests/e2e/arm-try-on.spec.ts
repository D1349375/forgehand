import { expect, test } from '@playwright/test';

declare global {
  interface Window { setArmFixturePresent?: (present: boolean) => void }
}

test('camera try-on renders, loses and reacquires an arm without editing the model', async ({ context, page }) => {
  // A deterministic landmark worker keeps the default suite independent of
  // external model downloads. Video capture, lifecycle and WebGL are real.
  await context.route(/\/(?:src\/try-on\/arm\.worker\.ts|assets\/arm\.worker-[^/?]+\.js)(?:\?.*)?$/, route => route.fulfill({
    contentType: 'text/javascript',
    body: `
      const point = (x, y) => ({ x, y, z: 0, visibility: 1 });
      const hand = Array.from({ length: 21 }, () => point(0.5, 0.48));
      hand[0] = point(0.5, 0.52);
      hand[5] = point(0.55, 0.47);
      hand[17] = point(0.45, 0.47);
      const body = Array.from({ length: 33 }, () => point(0.12, 0.4));
      body[13] = point(0.55, 0.79);
      body[15] = point(0.5, 0.52);
      const pixel = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      self.onmessage = ({ data: { bitmap, width, height } }) => {
        pixel.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1);
        const present = pixel.getImageData(0, 0, 1, 1).data[1] > 128;
        bitmap.close();
        self.postMessage({ type: 'frame', width, height, inferenceMs: 4,
          hands: present ? [{ points: hand, side: 'left' }] : [], body: present ? body : [] });
      };
      self.postMessage({ type: 'ready', delegate: 'GPU' });
    `,
  }));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext('2d')!;
      let present = true;
      window.setArmFixturePresent = value => { present = value; };
      const stream = canvas.captureStream(20);
      const track = stream.getVideoTracks()[0];
      const paint = () => {
        if (track.readyState === 'ended') return;
        context.fillStyle = present ? '#00ff00' : '#000000';
        context.fillRect(0, 0, canvas.width, canvas.height);
        requestAnimationFrame(paint);
      };
      paint();
      return stream;
    };
  });

  const modelRequests: string[] = [];
  page.on('request', request => {
    if (/\/api\/(generate|edit)$/.test(request.url())) modelRequests.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).click();
  const canvas = page.getByTestId('scene-canvas');
  await expect(canvas).toHaveAttribute('data-model-json', /battery/);
  const model = await canvas.getAttribute('data-model-json');
  await page.getByRole('button', { name: '護臂試戴', exact: true }).click();
  const status = page.getByTestId('try-on-status');
  await expect(status).toHaveAttribute('data-state', 'tracking');
  // A front camera is shown like a mirror; tracking runs on the same mirrored frame.
  const video = page.getByLabel('即時攝影機背景');
  await expect(video).toHaveAttribute('data-mirrored', 'true');
  expect(await video.evaluate(element => getComputedStyle(element).transform)).toBe('matrix(-1, 0, 0, 1, 0, 0)');
  await expect(canvas).toHaveAttribute('data-arm-preview', 'visible');
  await expect(page.getByTestId('try-on-stats')).toContainText(/GPU · 每秒 \d+ 幀 · 辨識 4 ms/);
  await expect(page.getByRole('button', { name: '復原' })).toBeDisabled();

  await page.evaluate(() => window.setArmFixturePresent?.(false));
  await expect(status).toHaveAttribute('data-state', 'searching');
  await expect(canvas).toHaveAttribute('data-arm-preview', 'hidden');
  await page.evaluate(() => window.setArmFixturePresent?.(true));
  await expect(canvas).toHaveAttribute('data-arm-preview', 'visible');

  await page.getByRole('button', { name: '關閉攝影機' }).click();
  await expect(status).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-arm-preview', 'hidden');
  await expect(canvas).toHaveAttribute('data-model-json', model!);
  expect(modelRequests).toEqual([]);
});
