import { expect, test, type Page, type Route } from '@playwright/test';
import { serializeSseEvent, type StateChange, type ToolResult } from '../../shared/agent';
import { demoModel } from '../../shared/demo';
import type { ModelSpec } from '../../shared/model';
import { MAX_OBJECTS, type SceneObject } from '../../shared/workspace';
// Multi-object workspace end to end. `/api/*` is always routed (no real model
// back end); the Three.js scene, raycasting and projection are real.
const canvas = (page: Page) => page.getByTestId('scene-canvas');
const SECOND_NAME = '測試：第二個物件';
const AGENT_NAME = '測試：代理新增物件';
type Vector = { x: number; y: number; z: number };
type ObjectRow = [string, Vector, Vector];
const objectRows = async (page: Page): Promise<ObjectRow[]> => JSON.parse((await canvas(page).getAttribute('data-object-json'))!);
const objectCount = async (page: Page) => Number(await canvas(page).getAttribute('data-object-count'));
const copyModel = (name: string): ModelSpec => ({ ...structuredClone(demoModel), name });
const undo = (page: Page) => page.getByRole('button', { name: '復原', exact: true });
const objectEntries = (page: Page) => page.getByRole('list', { name: '物件清單' }).getByRole('button');
const objectEntry = (page: Page, name: string) => page.getByRole('list', { name: '物件清單' }).getByRole('button', { name: new RegExp(`^${name}`) });
async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
}
async function generateSecond(page: Page) {
  await page.route('**/api/generate', route => {
    const body = route.request().postDataJSON() as { requestId: string };
    return route.fulfill({ json: {
      design: { status: 'ready', explanation: '測試替身模型資料。', model: copyModel(SECOND_NAME) },
      source: 'codex', model: 'test-double-not-a-real-model', elapsedMs: 25, requestId: body.requestId,
    } });
  });
  await page.getByRole('tab', { name: '生成新物件', exact: true }).click();
  await page.getByLabel('物件描述', { exact: true }).fill('再做一個物件');
  await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '2');
  await expect(canvas(page)).toHaveAttribute('data-model-name', SECOND_NAME);
}
const project = (page: Page, partId: string, objectId: string) =>
  page.evaluate(([part, object]) => window.__forgehandScene?.projectPart(part!, object), [partId, objectId]);
test.beforeEach(async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
});
test('生成第二個物件：排在第一個旁邊並成為作用中物件，復原後移除', async ({ page }) => {
  await loadDemo(page);
  const [first] = await objectRows(page);
  await generateSecond(page);
  const rows = await objectRows(page);
  expect(rows).toHaveLength(2);
  expect(rows[0]![0]).toBe(first![0]);
  const second = rows[1]!;
  expect(second[1].x).toBeGreaterThan(rows[0]![1].x);
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', second[0]);
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', first![0]);
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
});
test('點擊非作用中物件的零件：該物件成為作用中並選取該零件', async ({ page }) => {
  await loadDemo(page);
  const [first] = await objectRows(page);
  await generateSecond(page);
  await expect(canvas(page)).not.toHaveAttribute('data-active-object-id', first![0]);
  const point = await project(page, 'battery', first![0]);
  expect(point).toBeTruthy();
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down(); await page.mouse.up();
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', first![0]);
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
  await expect(canvas(page)).toHaveAttribute('data-selected-ids', 'battery');
});
test('爆炸圖只作用於作用中物件，其他物件的零件位置不變', async ({ page }) => {
  await loadDemo(page);
  const [first] = await objectRows(page);
  await generateSecond(page);
  const [, second] = await objectRows(page);
  const otherBefore = await project(page, 'battery', first![0]);
  const activeBefore = await project(page, 'battery', second![0]);
  expect(otherBefore && activeBefore).toBeTruthy();
  await page.getByRole('button', { name: '爆炸圖', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-explode', '1.000');
  const otherAfter = await project(page, 'battery', first![0]);
  const activeAfter = await project(page, 'battery', second![0]);
  expect(otherAfter!.x).toBeCloseTo(otherBefore!.x, 3);
  expect(otherAfter!.y).toBeCloseTo(otherBefore!.y, 3);
  // The active object really exploded, so the check above is not vacuous.
  expect(Math.hypot(activeAfter!.x - activeBefore!.x, activeAfter!.y - activeBefore!.y)).toBeGreaterThan(1);
});
test('物件面板：切換、重新命名、移動與刪除，每項都可復原', async ({ page }) => {
  await loadDemo(page);
  const [first] = await objectRows(page);
  await generateSecond(page);
  const [, second] = await objectRows(page);
  await expect(objectEntries(page)).toHaveCount(2);
  // Switching is not an undo step.
  await objectEntry(page, demoModel.name).click();
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', first![0]);
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
  await objectEntry(page, SECOND_NAME).click();
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', second![0]);
  // Rename.
  const name = page.getByLabel('物件名稱', { exact: true });
  await name.fill('改名後的物件');
  await name.press('Enter');
  await expect(canvas(page)).toHaveAttribute('data-model-name', '改名後的物件');
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-model-name', SECOND_NAME);
  // Move with 物件位置 X (millimetres).
  const x = page.getByLabel('物件位置 X', { exact: true });
  await x.fill('1234');
  await x.press('Enter');
  await expect.poll(async () => (await objectRows(page))[1]![1].x).toBeCloseTo(1.234, 5);
  await undo(page).click();
  await expect.poll(async () => (await objectRows(page))[1]![1].x).toBeCloseTo(second![1].x, 5);
  // Delete, then undo brings it back.
  await page.getByRole('button', { name: '刪除物件', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await expect(objectEntries(page)).toHaveCount(1);
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '2');
  await expect(objectEntry(page, SECOND_NAME)).toBeVisible();
});
test('物件數量達上限：生成與載入示範停用並顯示提示', async ({ page }) => {
  await loadDemo(page);
  // Once a model is on screen only the small link remains; its name also carries the 非 AI 生成 note.
  const demo = page.getByRole('button', { name: /^載入示範模型/ }).first();
  for (let count = 1; count < MAX_OBJECTS; count += 1) {
    await expect(demo).toBeEnabled();
    await demo.click();
    await expect(canvas(page)).toHaveAttribute('data-object-count', String(count + 1));
  }
  expect(await objectCount(page)).toBe(MAX_OBJECTS);
  await page.getByRole('tab', { name: '生成新物件', exact: true }).click();
  await page.getByLabel('物件描述', { exact: true }).fill('第九個物件');
  await expect(page.getByRole('button', { name: '生成 3D 草案', exact: true })).toBeDisabled();
  await expect(demo).toBeDisabled();
  await expect(page.getByTestId('object-limit')).toBeVisible();
  await expect(page.getByTestId('object-limit')).toContainText(String(MAX_OBJECTS));
});
test('代理新增的物件：瀏覽器採用伺服器給的 id 與位置，並可復原', async ({ page }) => {
  const created: SceneObject = {
    id: 'agent-made-object',
    model: copyModel(AGENT_NAME),
    transform: { position: { x: 0.4, y: 0, z: 0 }, rotation: { x: 0, y: 20, z: 0 } },
    source: 'claude', providerModel: 'test-double', edited: false, createdAt: '2026-11-21T09:30:00.000Z',
  };
  const summary = `已建立「${AGENT_NAME}」。`;
  const result: ToolResult = {
    tool: 'generate_design', ok: true, summary,
    detail: { source: 'claude', providerModel: 'test-double', status: 'ready', objectId: created.id },
    stateChange: { activeObjectId: null, object: null, selection: null, explode: null, tryOn: null },
  };
  const state: StateChange = {
    activeObjectId: null, object: { op: 'add', object: created }, selection: null, explode: null, tryOn: null,
  };
  const body = [
    serializeSseEvent('tool', { tool: 'generate_design', label: '生成設計', argsJson: '{"prompt":"新物件"}' }),
    serializeSseEvent('result', result),
    serializeSseEvent('state', state),
    serializeSseEvent('final', { reply: '已新增一個物件。' }),
    serializeSseEvent('done', {}),
  ].join('');
  await page.route('**/api/agent', (route: Route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body }));
  await loadDemo(page);
  const [first] = await objectRows(page);
  await page.getByLabel('任務指示', { exact: true }).fill('新增一個物件');
  await page.getByRole('button', { name: /^執行/ }).click();
  await expect(page.getByTestId('agent-reply')).toContainText('已新增一個物件。');
  await expect(canvas(page)).toHaveAttribute('data-object-count', '2');
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', created.id);
  await expect(canvas(page)).toHaveAttribute('data-model-name', AGENT_NAME);
  const rows = await objectRows(page);
  expect(rows[1]).toEqual([created.id, created.transform.position, created.transform.rotation]);
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', first![0]);
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
});
