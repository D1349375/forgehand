import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { serializeSseEvent, type StateChange, type ToolResult } from '../../shared/agent';
import { demoModel } from '../../shared/demo';
import { validateModel } from '../../shared/model';

// Agent panel: `/api/agent` is always routed (a scripted SSE body, a held
// request, or a JSON error), so no real model back end is involved. The
// Three.js scene is real.
const canvas = (page: Page) => page.getByTestId('scene-canvas');

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
}

// Differs from `demoModel` in both name and part count, and is a valid model.
const testModel = validateModel({
  ...structuredClone(demoModel),
  name: '測試手環',
  parts: demoModel.parts.filter(part => part.id === 'housing' || part.id === 'battery'),
});

const instructionBox = (page: Page) => page.getByLabel('任務指示', { exact: true });
const runButton = (page: Page) => page.getByRole('button', { name: /^執行/ });
const agentStatus = (page: Page) => page.getByTestId('agent-panel').getByRole('status');
const partListButtons = (page: Page) => page.getByRole('list', { name: '零件清單' }).getByRole('button');

async function expectAllDisabled(locator: Locator, disabled: boolean) {
  const count = await locator.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    if (disabled) await expect(locator.nth(index)).toBeDisabled();
    else await expect(locator.nth(index)).toBeEnabled();
  }
}

async function startRun(page: Page, text: string) {
  await instructionBox(page).fill(text);
  await runButton(page).click();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'claude', model: 'test-double-not-a-real-model' } }));
});

test('代理串流更新模型、進度與回覆，並可復原', async ({ page }) => {
  expect(testModel.name).not.toBe(demoModel.name);
  expect(testModel.parts.length).not.toBe(demoModel.parts.length);
  const note = '正在規劃手環外形。';
  const summary = '已建立「測試手環」，共 2 個零件。';
  const reply = '已為你生成測試手環，並把爆炸圖拉開一半。';
  const result: ToolResult = {
    tool: 'generate_design', ok: true, summary,
    detail: { source: 'claude', providerModel: 'test-double', status: 'ready' },
    stateChange: { model: null, selection: null, explode: 0.5, tryOn: null },
  };
  const state: StateChange = {
    model: { kind: 'generated', model: testModel, source: 'claude', providerModel: 'test-double' },
    selection: null, explode: 0.5, tryOn: null,
  };
  const body = [
    serializeSseEvent('status', { note }),
    serializeSseEvent('tool', { tool: 'generate_design', argsJson: '{"prompt":"手環"}' }),
    serializeSseEvent('result', result),
    serializeSseEvent('state', state),
    serializeSseEvent('final', { reply }),
    serializeSseEvent('done', {}),
  ].join('');
  let requestBody: { instruction?: string; model?: { name?: string } | null } | null = null;
  await page.route('**/api/agent', route => {
    requestBody = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await loadDemo(page);
  await startRun(page, '生成一個手環');

  await expect(page.getByTestId('agent-reply')).toContainText(reply);
  const log = page.getByTestId('agent-log');
  await expect(log).toContainText(note);
  await expect(log).toContainText('生成設計');
  await expect(log).toContainText(summary);
  await expect(agentStatus(page)).toHaveText('已完成。');
  expect(requestBody).toMatchObject({ instruction: '生成一個手環', model: { name: demoModel.name } });

  await expect(canvas(page)).toHaveAttribute('data-model-name', testModel.name);
  await expect(canvas(page)).toHaveAttribute('data-part-count', String(testModel.parts.length));
  await expect(page.getByLabel('拆開程度', { exact: true })).toHaveValue('50');

  await page.getByRole('button', { name: '復原', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
  await expect(canvas(page)).toHaveAttribute('data-part-count', String(demoModel.parts.length));
});

test('執行中停用手動控制，取消後恢復', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/agent', async (route: Route) => {
    await gate;
    try { await route.abort(); } catch { /* the client already closed the request */ }
  });

  await loadDemo(page);
  // Make one manual edit first so 復原 has history, and keep the part selected.
  await page.getByRole('button', { name: /側邊電池/ }).click();
  const height = page.getByLabel('尺寸 Y', { exact: true });
  await height.fill('120');
  await height.press('Enter');
  const undo = page.getByRole('button', { name: '復原', exact: true });
  const editBox = page.getByLabel('修改指示', { exact: true });
  const explodeButton = page.getByRole('button', { name: '爆炸圖', exact: true });
  const slider = page.getByLabel('拆開程度', { exact: true });
  await expect(undo).toBeEnabled();
  await expect(editBox).toBeEnabled();
  await expect(explodeButton).toBeEnabled();
  await expect(slider).toBeEnabled();
  await expect(height).toBeEnabled();
  await expectAllDisabled(partListButtons(page), false);

  await startRun(page, '把電池改成橘色');
  await expect(agentStatus(page)).toHaveText('代理正在處理，可隨時取消。');
  await expect(runButton(page)).toBeDisabled();
  await expect(editBox).toBeDisabled();
  await expect(undo).toBeDisabled();
  await expect(explodeButton).toBeDisabled();
  await expect(slider).toBeDisabled();
  await expect(height).toBeDisabled();
  await expectAllDisabled(partListButtons(page), true);

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(agentStatus(page)).toHaveText(/^已取消/);
  await expect(editBox).toBeEnabled();
  await expect(undo).toBeEnabled();
  await expect(explodeButton).toBeEnabled();
  await expect(slider).toBeEnabled();
  await expect(height).toBeEnabled();
  await expectAllDisabled(partListButtons(page), false);
  // Submit buttons also need text before they can be enabled.
  await editBox.fill('把電池加長');
  await expect(page.getByRole('button', { name: '套用修改', exact: true })).toBeEnabled();
  await instructionBox(page).fill('再試一次');
  await expect(runButton(page)).toBeEnabled();

  release();
});

for (const [status, code, message] of [
  [400, 'INVALID_REQUEST', '請求內容不正確，請調整後再試。'],
  [429, 'BUSY', '目前已有多個請求，請稍後重試（測試）。'],
] as const) {
  test(`伺服器回傳 ${status} 時顯示錯誤並恢復控制`, async ({ page }) => {
    await page.route('**/api/agent', route => route.fulfill({ status, json: { error: { code, message } } }));

    await loadDemo(page);
    await startRun(page, '把外殼改成藍色');

    await expect(page.getByTestId('agent-error')).toHaveText(message);
    await expect(agentStatus(page)).toHaveText('執行未完成。');
    await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
    await expect(page.getByLabel('修改指示', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('拆開程度', { exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '爆炸圖', exact: true })).toBeEnabled();
    await expectAllDisabled(partListButtons(page), false);
    await instructionBox(page).fill('再試一次');
    await expect(runButton(page)).toBeEnabled();
  });
}
