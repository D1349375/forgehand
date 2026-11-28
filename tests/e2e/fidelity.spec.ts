import { expect, test, type Page, type Route } from '@playwright/test';
import { serializeSseEvent } from '../../shared/agent';
import { demoModel } from '../../shared/demo';
import { DETAIL_MODE_TEXT } from '../../shared/i18n/fidelity';

// Design fidelity, task 2: the detail switch (細節程度) above the prompt, its persistence after a reload, and the
// `detail` field of the routed /api/agent, /api/generate and /api/edit request bodies. Every /api call is routed, so
// no real model back end is involved. The Three.js scene is real.

const text = DETAIL_MODE_TEXT['zh-TW'];
const group = (page: Page) => page.getByRole('radiogroup', { name: text.label, exact: true });
const concept = (page: Page) => page.getByRole('radio', { name: text.concept, exact: true });
const detailed = (page: Page) => page.getByRole('radio', { name: text.detailed, exact: true });

async function fulfillModel(route: Route) {
  const request = route.request().postDataJSON() as { requestId: string };
  await route.fulfill({
    json: {
      design: { status: 'ready', explanation: '測試替身模型資料。', model: structuredClone(demoModel) },
      source: 'codex', model: 'test-double-not-a-real-model', elapsedMs: 25, requestId: request.requestId,
    },
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'claude', model: 'test-double-not-a-real-model' } }));
});

test('開關預設為概念，說明文字可見，選擇會在重新整理後保留', async ({ page }) => {
  await page.goto('/');
  await expect(group(page)).toBeVisible();
  await expect(group(page)).toHaveAttribute('data-detail-mode', 'concept');
  await expect(concept(page)).toHaveAttribute('aria-checked', 'true');
  await expect(detailed(page)).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(text.help, { exact: true })).toBeVisible();
  // The group sits above the description field.
  const switchBox = await group(page).boundingBox();
  const fieldBox = await page.getByLabel('物件描述', { exact: true }).boundingBox();
  expect(switchBox!.y).toBeLessThan(fieldBox!.y);

  await detailed(page).click();
  await expect(group(page)).toHaveAttribute('data-detail-mode', 'detailed');
  await expect(detailed(page)).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => window.localStorage.getItem('forgehand.detailMode'))).toBe('detailed');

  await page.reload();
  await expect(group(page)).toHaveAttribute('data-detail-mode', 'detailed');
  await expect(detailed(page)).toHaveAttribute('aria-checked', 'true');

  await concept(page).click();
  await page.reload();
  await expect(group(page)).toHaveAttribute('data-detail-mode', 'concept');
});

test('方向鍵可以切換選項', async ({ page }) => {
  await page.goto('/');
  await concept(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(group(page)).toHaveAttribute('data-detail-mode', 'detailed');
  await page.keyboard.press('ArrowLeft');
  await expect(group(page)).toHaveAttribute('data-detail-mode', 'concept');
});

test('生成請求帶著目前的細節程度', async ({ page }) => {
  const bodies: Array<{ prompt: string; detail?: string }> = [];
  await page.route('**/api/generate', route => { bodies.push(route.request().postDataJSON()); return fulfillModel(route); });
  await page.goto('/');
  await page.getByLabel('物件描述', { exact: true }).fill('一個手持裝置');
  await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
  await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-model-name', demoModel.name);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ prompt: '一個手持裝置', detail: 'concept' });

  await detailed(page).click();
  await page.getByRole('tab', { name: '生成新物件', exact: true }).click();
  await page.getByLabel('物件描述', { exact: true }).fill('一個詳細的手持裝置');
  await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({ prompt: '一個詳細的手持裝置', detail: 'detailed' });
});

test('修改請求帶著目前的細節程度', async ({ page }) => {
  let sent: { instruction?: string; detail?: string } | null = null;
  await page.route('**/api/edit', route => {
    sent = route.request().postDataJSON();
    const { requestId } = sent as unknown as { requestId: string };
    return route.fulfill({ json: {
      plan: { status: 'clarify', explanation: '要改哪一個零件？', operations: [], name: null, summary: null, assumptions: null },
      source: 'claude', model: 'test-double-not-a-real-model', elapsedMs: 5, requestId,
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await detailed(page).click();
  await page.getByLabel('修改指示', { exact: true }).fill('加上典型內部零件');
  await page.getByRole('button', { name: /^套用修改/ }).click();
  await expect(page.getByTestId('clarify')).toBeVisible();
  expect(sent).toMatchObject({ instruction: '加上典型內部零件', detail: 'detailed' });
});

test('代理請求帶著目前的細節程度，執行中開關停用', async ({ page }) => {
  const bodies: Array<{ detail?: string }> = [];
  const final = [serializeSseEvent('final', { reply: '好了。' }), serializeSseEvent('done', {})].join('');
  await page.route('**/api/agent', route => { bodies.push(route.request().postDataJSON()); return route.fulfill({ status: 200, contentType: 'text/event-stream', body: final }); });
  await page.goto('/');
  await page.getByLabel('任務指示', { exact: true }).fill('生成一個手環');
  await page.getByRole('button', { name: /^執行/ }).click();
  await expect(page.getByTestId('agent-reply')).toContainText('好了。');
  expect(bodies[0]).toMatchObject({ detail: 'concept' });

  await detailed(page).click();
  await page.getByLabel('任務指示', { exact: true }).fill('生成一個詳細的手環');
  await page.getByRole('button', { name: /^執行/ }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({ detail: 'detailed' });
});

test('代理執行中不能切換細節程度，取消後恢復', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/agent', async route => {
    await gate;
    try { await route.abort(); } catch { /* the client already closed the request */ }
  });
  await page.goto('/');
  await page.getByLabel('任務指示', { exact: true }).fill('生成一個手環');
  await page.getByRole('button', { name: /^執行/ }).click();
  await expect(concept(page)).toBeDisabled();
  await expect(detailed(page)).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(concept(page)).toBeEnabled();
  await expect(detailed(page)).toBeEnabled();
  release();
});
