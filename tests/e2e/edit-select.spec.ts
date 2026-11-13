import { expect, test, type Page, type Route } from '@playwright/test';
import { demoModel } from '../../shared/demo';
import type { EditPlan } from '../../shared/edit';
import type { Part } from '../../shared/model';

// Phase two: selection, direct adjustment, AI edits (model service simulated
// by route fixtures; Three.js rendering and raycasting are real).
const canvas = (page: Page) => page.getByTestId('scene-canvas');
const part = (id: string) => structuredClone(demoModel.parts.find(entry => entry.id === id)!);
type Row = [string, Part['position'], Part['rotation'], Part['dimensions'], string];
const rows = async (page: Page): Promise<Row[]> => JSON.parse((await canvas(page).getAttribute('data-model-json'))!);
const row = async (page: Page, id: string) => (await rows(page)).find(entry => entry[0] === id)!;
const plan = (values: Partial<EditPlan>): EditPlan => ({ status: 'applied', explanation: '測試替身修改。', operations: [], name: null, summary: null, assumptions: null, ...values });

async function fulfillEdit(route: Route, value: EditPlan) {
  const body = route.request().postDataJSON() as { requestId: string };
  await route.fulfill({ json: { plan: value, source: 'claude', model: 'test-double-not-a-real-model', elapsedMs: 12, requestId: body.requestId } });
}
async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
}
async function clickPart(page: Page, id: string, modifiers: Array<'Shift'> = []) {
  const point = await page.evaluate(partId => window.__forgehandScene?.projectPart(partId), id);
  expect(point).toBeTruthy();
  await page.mouse.move(point!.x, point!.y);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.down(); await page.mouse.up();
  for (const key of modifiers) await page.keyboard.up(key);
}
async function requestEdit(page: Page, text: string) {
  await page.getByLabel('修改指示', { exact: true }).fill(text);
  await page.getByRole('button', { name: '套用修改', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'claude', model: 'test-double-not-a-real-model' } }));
});

test('點擊畫面選取零件，與清單同步；Shift 加選，點空白取消', async ({ page }) => {
  await loadDemo(page);
  await clickPart(page, 'battery');
  await expect(canvas(page)).toHaveAttribute('data-selected-ids', 'battery');
  await expect(page.getByRole('button', { name: /側邊電池/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('part-editor')).toBeVisible();
  await page.getByRole('button', { name: /展示支架/ }).click({ modifiers: ['Shift'] });
  await expect(canvas(page)).toHaveAttribute('data-selected-ids', 'battery,support');
  await expect(page.getByTestId('part-editor')).toHaveCount(0);
  // Clicking the part list may have scrolled the page; measure the canvas where it is now.
  await canvas(page).scrollIntoViewIfNeeded();
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.93, box.y + box.height * 0.5);
  await expect(canvas(page)).toHaveAttribute('data-selected-ids', '');
});

test('數值欄直接調整、保留視角，可復原與重做', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('button', { name: /側邊電池/ }).click();
  const camera = await canvas(page).getAttribute('data-camera-position');
  const height = page.getByLabel('尺寸 Y', { exact: true });
  await height.fill('120');
  await height.press('Enter');
  await expect.poll(async () => (await row(page, 'battery'))[3].y).toBeCloseTo(0.12, 6);
  expect(await canvas(page).getAttribute('data-camera-position')).toBe(camera);
  await expect(page.getByTestId('model-name')).toHaveText(demoModel.name);
  await expect(page.getByText(/已修改/).first()).toBeVisible();
  await height.fill('-5');
  await height.press('Enter');
  await expect(height).toHaveAttribute('aria-invalid', 'true');
  expect((await row(page, 'battery'))[3].y).toBeCloseTo(0.12, 6);
  await page.getByRole('button', { name: '復原', exact: true }).click();
  await expect.poll(async () => (await row(page, 'battery'))[3].y).toBeCloseTo(0.068, 6);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await row(page, 'battery'))[3].y).toBeCloseTo(0.12, 6);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await row(page, 'battery'))[3].y).toBeCloseTo(0.068, 6);
});

test('刪除零件：仍有子零件時阻止，刪除後可復原', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('button', { name: /^外殼/ }).click();
  await page.getByRole('button', { name: '刪除零件', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('仍依附在要刪除的零件上');
  await expect(canvas(page)).toHaveAttribute('data-part-count', String(demoModel.parts.length));
  await page.getByRole('button', { name: /側邊電池/ }).click();
  await page.getByRole('button', { name: '刪除零件', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-part-count', String(demoModel.parts.length - 1));
  await page.getByRole('button', { name: '復原', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-part-count', String(demoModel.parts.length));
});

test('文字修改只變更回傳的零件，送出目前模型與選取，可復原', async ({ page }) => {
  let sent: { instruction: string; selectedPartIds: string[]; model: { parts: Part[] } } | undefined;
  await page.route('**/api/edit', route => { sent = route.request().postDataJSON(); return fulfillEdit(route, plan({
    explanation: '把側邊電池改成藍色 #2563eb。', operations: [{ op: 'upsert', partId: 'battery', part: { ...part('battery'), color: '#2563eb' } }] })); });
  await loadDemo(page);
  await expect(page.getByRole('tab', { name: '修改目前模型', exact: true })).toHaveAttribute('aria-selected', 'true');
  await clickPart(page, 'battery');
  const before = await rows(page);
  const camera = await canvas(page).getAttribute('data-camera-position');
  await requestEdit(page, '把這個改成藍色');
  await expect(page.getByTestId('edit-summary')).toContainText('調整 側邊電池');
  expect(sent).toMatchObject({ instruction: '把這個改成藍色', selectedPartIds: ['battery'] });
  expect(sent!.model.parts).toHaveLength(demoModel.parts.length);
  const after = await rows(page);
  expect(after.find(entry => entry[0] === 'battery')![4]).toBe('#2563eb');
  expect(after.filter(entry => entry[0] !== 'battery')).toEqual(before.filter(entry => entry[0] !== 'battery'));
  expect(await canvas(page).getAttribute('data-camera-position')).toBe(camera);
  await expect(canvas(page)).toHaveAttribute('data-selected-ids', 'battery');
  await page.getByRole('button', { name: '復原', exact: true }).click();
  await expect.poll(async () => (await row(page, 'battery'))[4]).toBe('#f27562');
});

test('文字修改新增與刪除零件', async ({ page }) => {
  const cup: Part = { ...part('support'), id: 'cup', name: '綠色杯子', primitive: 'tube', color: '#22c55e', position: { x: 0, y: 0.08, z: 0 }, parentId: 'housing' };
  const answers = [plan({ operations: [{ op: 'upsert', partId: 'cup', part: cup }] }), plan({ operations: [{ op: 'remove', partId: 'cup', part: null }] })];
  await page.route('**/api/edit', route => fulfillEdit(route, answers.shift()!));
  await loadDemo(page);
  await requestEdit(page, '在外殼上面放一個綠色杯子');
  await expect(page.getByTestId('edit-summary')).toContainText('新增 綠色杯子');
  await expect(canvas(page)).toHaveAttribute('data-part-count', String(demoModel.parts.length + 1));
  await requestEdit(page, '把杯子刪掉');
  await expect(page.getByTestId('edit-summary')).toContainText('刪除 綠色杯子');
  await expect(canvas(page)).toHaveAttribute('data-part-count', String(demoModel.parts.length));
});

test('需要確認與無法處理的回覆不修改模型', async ({ page }) => {
  const answers: EditPlan[] = [plan({ status: 'clarify', explanation: '要放大哪一個零件？' }), plan({ status: 'unsupported', explanation: '目前無法挖孔，可改用環形零件示意。' })];
  await page.route('**/api/edit', route => fulfillEdit(route, answers.shift()!));
  await loadDemo(page);
  const before = await rows(page);
  await requestEdit(page, '把它放大');
  await expect(page.getByTestId('clarify')).toContainText('要放大哪一個零件？');
  await requestEdit(page, '在外殼挖一個孔');
  await expect(page.getByRole('alert')).toContainText('目前無法挖孔');
  expect(await rows(page)).toEqual(before);
  await expect(page.getByRole('button', { name: '復原', exact: true })).toBeDisabled();
});

test('無法套用或服務失敗的修改保留目前模型', async ({ page }) => {
  const answers: Array<(route: Route) => Promise<void>> = [
    route => fulfillEdit(route, plan({ operations: [{ op: 'remove', partId: 'housing', part: null }] })),
    route => route.fulfill({ status: 504, json: { error: { code: 'TIMEOUT', message: '模型服務回應逾時，請稍後重試或減少零件。' }, requestId: 'x' } }),
  ];
  await page.route('**/api/edit', route => answers.shift()!(route));
  await loadDemo(page);
  const before = await rows(page);
  await requestEdit(page, '刪掉外殼');
  await expect(page.getByRole('alert')).toContainText('依附在被刪除的零件上');
  await requestEdit(page, '把電池改大');
  await expect(page.getByRole('alert')).toContainText('逾時');
  await expect(page.getByRole('button', { name: '重試修改', exact: true })).toBeVisible();
  expect(await rows(page)).toEqual(before);
});

test('等待期間手動改了同一零件：詢問保留哪個版本', async ({ page }) => {
  const releases: Array<() => void> = [];
  await page.route('**/api/edit', async route => {
    await new Promise<void>(resolve => releases.push(resolve));
    await fulfillEdit(route, plan({ operations: [{ op: 'upsert', partId: 'battery', part: { ...part('battery'), color: '#000000' } }] }));
  });
  await loadDemo(page);
  await page.getByRole('button', { name: /側邊電池/ }).click();
  for (const choice of ['保留手動調整', '套用 AI 修改'] as const) {
    await requestEdit(page, '把電池改成黑色');
    await expect.poll(() => releases.length).toBe(1);
    const width = page.getByLabel('尺寸 X', { exact: true });
    const next = choice === '保留手動調整' ? '40' : '45';
    await width.fill(next);
    await width.press('Enter');
    await expect.poll(async () => (await row(page, 'battery'))[3].x).toBeCloseTo(Number(next) / 1000, 6);
    releases.shift()!();
    await expect(page.getByTestId('edit-conflict')).toContainText('側邊電池');
    await page.getByRole('button', { name: choice, exact: true }).click();
    await expect(page.getByTestId('edit-conflict')).toHaveCount(0);
    const battery = await row(page, 'battery');
    if (choice === '保留手動調整') { expect(battery[4]).toBe('#f27562'); expect(battery[3].x).toBeCloseTo(0.04, 6); }
    else { expect(battery[4]).toBe('#000000'); expect(battery[3].x).toBeCloseTo(0.035, 6); }
  }
});

test('修改等待中改為生成新物件，舊修改不會套到新物件', async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route('**/api/edit', async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await fulfillEdit(route, plan({ operations: [{ op: 'upsert', partId: 'battery', part: { ...part('battery'), color: '#000000' } }] })).catch(() => {});
  });
  await page.route('**/api/generate', route => route.fulfill({ json: { design: { status: 'ready', explanation: '測試替身', model: { ...structuredClone(demoModel), name: '新物件' } },
    source: 'claude', model: 'test-double-not-a-real-model', elapsedMs: 5, requestId: route.request().postDataJSON().requestId } }));
  await loadDemo(page);
  await requestEdit(page, '把電池改成黑色');
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('tab', { name: '生成新物件', exact: true }).click();
  await page.getByLabel('物件描述', { exact: true }).fill('另一個物件');
  await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-model-name', '新物件');
  release!();
  await page.waitForTimeout(300);
  expect((await row(page, 'battery'))[4]).toBe('#f27562');
  await expect(page.getByTestId('edit-conflict')).toHaveCount(0);
});

test('衝突對話框開著時復原到另一個物件，AI 修改不會套到那個物件', async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route('**/api/edit', async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await fulfillEdit(route, plan({ operations: [{ op: 'upsert', partId: 'battery', part: { ...part('battery'), color: '#000000' } }] }));
  });
  // Two separate objects with identical part ids: the worst case for a stale answer.
  await loadDemo(page);
  await page.getByRole('button', { name: /載入示範模型/ }).first().click();
  await expect(page.getByRole('button', { name: '復原', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: /側邊電池/ }).click();
  await requestEdit(page, '把電池改成黑色');
  await expect.poll(() => Boolean(release)).toBe(true);
  const width = page.getByLabel('尺寸 X', { exact: true });
  await width.fill('40');
  await width.press('Enter');
  await expect.poll(async () => (await row(page, 'battery'))[3].x).toBeCloseTo(0.04, 6);
  release!();
  await expect(page.getByTestId('edit-conflict')).toBeVisible();
  const undo = page.getByRole('button', { name: '復原', exact: true });
  await undo.click(); // undo the manual width change (same object)
  await undo.click(); // back to the first demo object
  await page.getByRole('button', { name: '套用 AI 修改', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('已是另一個物件');
  await expect(page.getByTestId('edit-conflict')).toHaveCount(0);
  const battery = await row(page, 'battery');
  expect(battery[4]).toBe('#f27562');
  expect(battery[3].x).toBeCloseTo(0.035, 6);
});

test('使用者轉過視角後改變視窗大小，不會被重新取景', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loadDemo(page);
  const position = async () => (await canvas(page).getAttribute('data-camera-position'))!.split(',').map(Number);
  const near = (a: number[], b: number[], tolerance = 0.002) => a.every((value, index) => Math.abs(value - b[index]!) < tolerance);
  // The orbit controls keep coasting for a while after a drag, and slowly enough on a software
  // renderer that two close samples do not mean the camera has stopped: wait for three in a row.
  const settled = async () => {
    let previous = await position();
    let steady = 0;
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(150);
      const next = await position();
      steady = near(next, previous, 0.0003) ? steady + 1 : 0;
      if (steady >= 3) return next;
      previous = next;
    }
    return previous;
  };
  const framed = await settled();
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4 + 160, box.y + box.height * 0.6 - 40, { steps: 8 });
  await page.mouse.up();
  const rotated = await settled();
  expect(near(rotated, framed)).toBe(false);
  await page.setViewportSize({ width: 1100, height: 760 });
  expect(near(await settled(), rotated)).toBe(true);
  await page.getByRole('button', { name: '重設視角', exact: true }).click();
  expect(near(await settled(), rotated)).toBe(false);
});
