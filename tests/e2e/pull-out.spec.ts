import { expect, test, type Page, type Route } from '@playwright/test';
import { serializeSseEvent, type StateChange, type ToolResult } from '../../shared/agent';
import { demoModel } from '../../shared/demo';
// Workbench-ui Task 2: the agent pulls a part out. `/api/*` is routed (no real model back end);
// the page applies the `state` frame with the real workspace code and the real Three.js scene.
const canvas = (page: Page) => page.getByTestId('scene-canvas');
type Vector = { x: number; y: number; z: number };
type ObjectRow = [string, Vector, Vector];
const objectRows = async (page: Page): Promise<ObjectRow[]> => JSON.parse((await canvas(page).getAttribute('data-object-json'))!);
const undo = (page: Page) => page.getByRole('button', { name: '復原', exact: true });
const NEW_ID = 'pulled-battery';
const PART_NAME = demoModel.parts.find(part => part.id === 'battery')!.name;
const MESSAGE = `代理已把「${PART_NAME}」拉出成新物件，可按「復原」回到上一步。`;
test.beforeEach(async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
});
test('代理拉出零件：多出一個物件放在原物件右側，訊息點名零件，復原回到一個物件', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  const [first] = await objectRows(page);
  const objectId = first![0];

  const summary = `已把「${PART_NAME}」（含 0 個子零件）拉出成新物件「${PART_NAME}」，放在「${demoModel.name}」旁邊。`;
  const change: StateChange = {
    activeObjectId: null,
    object: { op: 'pull-out', objectId, partId: 'battery', newObjectId: NEW_ID, createdAt: '2026-11-28T10:00:00.000Z' },
    selection: null, explode: null, tryOn: null,
  };
  const result: ToolResult = {
    tool: 'pull_out_part', ok: true, summary,
    detail: { objectId, partId: 'battery', newObjectId: NEW_ID, partIds: ['battery'], inPlace: false, jointsMoved: 0 },
    stateChange: change,
  };
  const body = [
    serializeSseEvent('tool', { tool: 'pull_out_part', label: '拉出零件', argsJson: '{"partId":"battery"}' }),
    serializeSseEvent('result', result),
    serializeSseEvent('state', change),
    serializeSseEvent('final', { reply: '已把電池拉出成新物件。' }),
    serializeSseEvent('done', {}),
  ].join('');
  await page.route('**/api/agent', (route: Route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body }));

  await page.getByLabel('任務指示', { exact: true }).fill('把電池拉出來');
  await page.getByRole('button', { name: /^執行/ }).click();
  await expect(page.getByTestId('agent-reply')).toContainText('已把電池拉出成新物件。');
  await expect(canvas(page)).toHaveAttribute('data-object-count', '2');
  await expect(page.getByText(MESSAGE, { exact: true })).toBeVisible();

  // The original stays active and the new object sits to its right.
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', objectId);
  const rows = await objectRows(page);
  expect(rows.map(row => row[0])).toEqual([objectId, NEW_ID]);
  expect(rows[1]![1].x).toBeGreaterThan(rows[0]![1].x);

  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', objectId);
  expect((await objectRows(page)).map(row => row[0])).toEqual([objectId]);
});

test('代理在同一物件內建立接合：先把零件原位拉出，再接合兩個物件，接合卡片打開', async ({ page }) => {
  // Requirement 50 (decision 5): create_joint on two parts of one object pulls one of them out in place and joins
  // the two objects in one state event; the browser opens the new joint's card and names both objects.
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  const [first] = await objectRows(page);
  const objectId = first![0];

  const createdAt = '2026-11-28T10:00:00.000Z';
  const change: StateChange = {
    activeObjectId: null,
    object: { op: 'pull-out', objectId, partId: 'battery', newObjectId: NEW_ID, createdAt, inPlace: true },
    joint: {
      op: 'add',
      joint: {
        id: 'joint-pulled', createdAt, confirmed: false,
        a: { objectId, partId: 'housing', face: '+x' },
        b: { objectId: NEW_ID, partId: 'battery', face: '-x' },
        method: { kind: 'glue', glue: 'ca' },
        needs: { load: null, disassembly: null },
      },
    },
    selection: null, explode: null, tryOn: null,
  };
  const body = [
    serializeSseEvent('tool', { tool: 'create_joint', label: '建立接合', argsJson: '{"a":{"objectId":"x","partId":"housing"},"b":{"objectId":"x","partId":"battery"}}' }),
    serializeSseEvent('state', change),
    serializeSseEvent('final', { reply: '已拉出電池並建立接合。' }),
    serializeSseEvent('done', {}),
  ].join('');
  await page.route('**/api/agent', (route: Route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body }));

  await page.getByLabel('任務指示', { exact: true }).fill('把電池接到外殼上');
  await page.getByRole('button', { name: /^執行/ }).click();
  await expect(page.getByTestId('agent-reply')).toContainText('已拉出電池並建立接合。');
  await expect(canvas(page)).toHaveAttribute('data-object-count', '2');
  await expect(page.getByText(`代理已把「${PART_NAME}」拉出成新物件，並接合「${demoModel.name}」與「${PART_NAME}」，請確認固定方式。`, { exact: true })).toBeVisible();
  await expect(page.getByTestId('joint-card')).toHaveAttribute('data-joint-id', 'joint-pulled');

  expect((await objectRows(page)).map(row => row[0])).toEqual([objectId, NEW_ID]);

  // One undo step removes the pull-out and the joint together.
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await expect(page.getByTestId('joint-card')).toHaveCount(0);
});
