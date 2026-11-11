import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { demoModel } from '../../shared/demo';

// These are synthetic video streams, not recordings from a physical camera.
// Camera controls, media attachment, Three.js geometry, and WebGL rendering run normally.
for (const background of ['bright', 'dark', 'cluttered'] as const) {
  test(`合成 ${background} 視訊：預設與提高背景對比`, async ({ page }, testInfo) => {
    await page.addInitScript((variant: string) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const cameraCanvas = document.createElement('canvas');
        cameraCanvas.width = 1280;
        cameraCanvas.height = 720;
        const context = cameraCanvas.getContext('2d')!;
        const draw = () => {
          context.fillStyle = variant === 'bright' ? '#eef2f4' : '#071118';
          context.fillRect(0, 0, 1280, 720);
          if (variant === 'cluttered') {
            for (let row = 0; row < 15; row++) {
              for (let column = 0; column < 26; column++) {
                context.fillStyle = (row + column) % 2 ? '#ddd3bf' : '#1c3040';
                context.fillRect(column * 50, row * 50, 50, 50);
              }
            }
            const colors = ['#c46b49', '#628964', '#44699b', '#d3af46', '#b078a0'];
            for (let index = 0; index < 18; index++) {
              context.fillStyle = colors[index % colors.length];
              context.fillRect((index * 173 + 37) % 1100, (index * 97 + 23) % 600, 100 + index * 3, 50 + index * 2);
            }
            context.strokeStyle = '#e8dfd2';
            context.lineWidth = 3;
            for (let index = -5; index < 20; index++) {
              context.beginPath();
              context.moveTo(index * 90, 0);
              context.lineTo(index * 90 + 320, 720);
              context.stroke();
            }
          }
        };
        draw();
        // Repaint to feed real video frames even when the pattern stays unchanged.
        const interval = window.setInterval(draw, 100);
        const stream = cameraCanvas.captureStream(10);
        const track = stream.getVideoTracks()[0];
        const originalStop = track.stop.bind(track);
        track.stop = () => { clearInterval(interval); originalStop(); };
        return stream;
      };
    }, background);
    await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
    await page.route('**/api/generate', async route => {
      const redModel = structuredClone(demoModel);
      redModel.name = '合成背景驗證：紅色外殼雙鏡頭裝置';
      redModel.parts.find(part => part.id === 'housing')!.color = '#ef4545';
      await route.fulfill({ json: {
        design: { status: 'ready', explanation: '視覺測試替身；不代表 AI 生成品質。', model: redModel },
        source: 'codex', model: 'test-double-not-a-real-model', elapsedMs: 25,
        requestId: route.request().postDataJSON().requestId,
      } });
    });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: '開啟攝影機', exact: true }).click();
    const viewport = page.getByTestId('viewport');
    const video = viewport.locator('video');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(1280);
    await page.getByLabel('物件描述', { exact: true }).fill('紅色外殼、雙鏡頭、側電池與內部綠色板件');
    await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
    await expect(page.getByTestId('model-name')).toHaveText('合成背景驗證：紅色外殼雙鏡頭裝置');
    const canvas = viewport.locator('canvas');
    await expect(canvas).toHaveAttribute('data-part-count', '9');
    await page.waitForTimeout(700);
    const defaultImage = await viewport.screenshot();
    await testInfo.attach(`${background}-default`, { body: defaultImage, contentType: 'image/png' });
    await page.getByLabel('提高背景對比', { exact: true }).check();
    await expect(viewport).toHaveClass(/high-contrast/);
    await page.waitForTimeout(150);
    const contrastImage = await viewport.screenshot();
    await testInfo.attach(`${background}-high-contrast`, { body: contrastImage, contentType: 'image/png' });
    expect(createHash('sha256').update(defaultImage).digest('hex')).not.toBe(createHash('sha256').update(contrastImage).digest('hex'));
    expect(pageErrors).toEqual([]);
  });
}
