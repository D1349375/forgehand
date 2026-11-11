import { expect, test, type Page } from '@playwright/test';
import { demoModel } from '../../shared/demo';

// Phase three: the exploded view is computed in the browser from the part
// hierarchy. No model service may be called and the model data never changes.
const canvas = (page: Page) => page.getByTestId('scene-canvas');
// Canvas-relative, so page scrolling (e.g. clicking the parts list) does not count as movement.
const project = (page: Page, id: string) => page.evaluate(partId => {
  const point = window.__forgehandScene?.projectPart(partId);
  const rect = document.querySelector('[data-testid="scene-canvas"]')!.getBoundingClientRect();
  return point ? { x: point.x - rect.left, y: point.y - rect.top } : null;
}, id);

test('爆炸圖在本機拆開與收回，不改模型資料、不呼叫模型服務、不進復原紀錄', async ({ page }) => {
  const modelCalls: string[] = [];
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'claude', model: 'test-double-not-a-real-model' } }));
  await page.route(/\/api\/(edit|generate)/, route => { modelCalls.push(route.request().url()); return route.abort(); });
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
  const data = await canvas(page).getAttribute('data-model-json');
  const assembled = await project(page, 'battery');
  const undo = page.getByRole('button', { name: '復原', exact: true });
  await expect(undo).toBeDisabled();

  await page.getByRole('button', { name: '爆炸圖', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-explode', '1.000');
  const exploded = await project(page, 'battery');
  expect(Math.hypot(exploded!.x - assembled!.x, exploded!.y - assembled!.y)).toBeGreaterThan(10);
  await expect(canvas(page)).toHaveAttribute('data-model-json', data!);
  await expect(undo).toBeDisabled();

  // Exploded parts stay selectable; fields still edit, the drag gizmo is off.
  await page.getByRole('button', { name: /側邊電池/ }).click();
  await expect(page.getByRole('button', { name: '拖曳移動', exact: true })).toBeDisabled();
  const width = page.getByLabel('尺寸 X', { exact: true });
  await width.fill('45');
  await width.press('Enter');
  await expect.poll(async () => JSON.parse((await canvas(page).getAttribute('data-model-json'))!).find((row: [string]) => row[0] === 'battery')[3].x).toBeCloseTo(0.045, 6);
  await expect(canvas(page)).toHaveAttribute('data-explode', '1.000');
  const stillExploded = await project(page, 'battery');
  expect(Math.hypot(stillExploded!.x - assembled!.x, stillExploded!.y - assembled!.y)).toBeGreaterThan(10);

  // Half-way slider, then collapse back to the assembled position.
  await page.getByLabel('拆開程度', { exact: true }).fill('50');
  await expect(canvas(page)).toHaveAttribute('data-explode', '0.500');
  await page.getByRole('button', { name: '收回爆炸圖', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-explode', '0.000');
  const collapsed = await project(page, 'battery');
  expect(Math.hypot(collapsed!.x - assembled!.x, collapsed!.y - assembled!.y)).toBeLessThan(1);
  await expect(page.getByRole('button', { name: '拖曳移動', exact: true })).toBeEnabled();
  expect(modelCalls).toEqual([]);
});
