import { expect, test, type Page } from '@playwright/test';
import { serializeSseEvent, type StateChange, type ToolResult } from '../../shared/agent';
import { planJoin } from '../../shared/contact';
import { demoModel } from '../../shared/demo';
import type { Joint } from '../../shared/joint';
import { newJoint } from '../../shared/joint-rules';
import { validateModel, type ModelSpec } from '../../shared/model';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import { addObject, emptyWorkspace, setTransform } from '../../shared/workspace';
import { fixtureObject } from '../fixtures/joint-workspace';
// Assembly joints in the workbench, end to end: the mouse join, the joint card, undo and redo, assemblies,
// the 材料 select, the printer profile and the print preview. `/api/*` is never called for a model; the Three.js scene,
// raycasting and projection are real.
const canvas = (page: Page) => page.getByTestId('scene-canvas');
type Vector = { x: number; y: number; z: number };
type ObjectRow = [string, Vector, Vector];
const objectRows = async (page: Page): Promise<ObjectRow[]> => JSON.parse((await canvas(page).getAttribute('data-object-json'))!);
const jointList = async (page: Page): Promise<Joint[]> => JSON.parse((await canvas(page).getAttribute('data-joints-json'))!);
const undo = (page: Page) => page.getByRole('button', { name: '復原', exact: true });
const redo = (page: Page) => page.getByRole('button', { name: '重做', exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const card = (page: Page) => page.getByTestId('joint-card');
const status = (page: Page) => page.getByTestId('mouse-join-status');
/** A select or a number field by its exact accessible name. */
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const objectEntries = (page: Page) => page.getByRole('list', { name: '物件清單' }).getByRole('button');

/** Loads the demo model twice: the second object is placed beside the first, so A's 側邊電池 faces B's 外殼. */
async function loadTwoDemos(page: Page): Promise<{ a: string; b: string }> {
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await page.getByRole('button', { name: /^載入示範模型/ }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '2');
  await expect(canvas(page)).toHaveAttribute('data-model-name', demoModel.name);
  const [a, b] = await objectRows(page);
  return { a: a![0], b: b![0] };
}

/**
 * Client coordinates of a part's centre at the current scroll position. The page is never scrolled back: while a mouse
 * join runs the canvas is pinned in view (see `.mouse-join-status` in styles.css), and outside a join `offset` is used.
 */
function project(page: Page, partId: string, objectId: string) {
  return page.evaluate(([part, object]) => window.__forgehandScene?.projectPart(part!, object), [partId, objectId]);
}

/** Where B's 外殼 is on screen relative to A's 外殼. Both are read at the same scroll position, so the page position cancels out. */
async function offset(page: Page, ids: { a: string; b: string }) {
  const a = await project(page, 'housing', ids.a);
  const b = await project(page, 'housing', ids.b);
  expect(a && b).toBeTruthy();
  return { x: b!.x - a!.x, y: b!.y - a!.y };
}

async function clickPart(page: Page, partId: string, objectId: string) {
  const point = await project(page, partId, objectId);
  expect(point).toBeTruthy();
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** 新增接合, A's 側邊電池, B's 外殼; leaves the preview open. */
async function previewJoin(page: Page, ids: { a: string; b: string }) {
  await button(page, '新增接合').click();
  await expect(status(page)).toContainText('點選第一個要接合的零件。');
  await clickPart(page, 'battery', ids.a);
  await expect(status(page)).toContainText('點選另一個物件上要接合的零件。');
  // B's lens tube covers the middle of its housing in the scene, so B's housing is chosen from the part list (a click there joins as well).
  await objectEntries(page).nth(1).click();
  await page.getByRole('list', { name: '零件清單' }).getByRole('button', { name: /^外殼/ }).click();
  await expect(canvas(page)).toHaveAttribute('data-snap', 'ready');
  await expect(status(page)).toContainText('可以接合：按「確認接合」完成，或按 Esc 取消。');
}

/** The full mouse join, ending with the card open. */
async function joinDemos(page: Page) {
  const ids = await loadTwoDemos(page);
  await previewJoin(page, ids);
  await button(page, '確認接合').click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
  await expect(card(page)).toBeVisible();
  return ids;
}

test('滑鼠接合：預覽、確認接合為一步復原，卡片顯示待確認與建議', async ({ page }) => {
  const ids = await loadTwoDemos(page);
  const [, bBefore] = await objectRows(page);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect(canvas(page)).toHaveAttribute('data-snap', 'none');
  const housingBefore = await offset(page, ids);

  await previewJoin(page, ids);
  // The preview shows B's assembly at the aligned pose; the stored transform is untouched until 確認接合.
  await expect.poll(async () => (await objectRows(page))[1]![1]).toEqual(bBefore![1]);
  const housingPreview = await offset(page, ids);
  expect(Math.abs(housingPreview.x - housingBefore.x) + Math.abs(housingPreview.y - housingBefore.y)).toBeGreaterThan(1);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect(button(page, '確認接合')).toBeEnabled();
  await expect(button(page, '新增接合')).toHaveCount(0);

  await button(page, '確認接合').click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
  await expect(canvas(page)).toHaveAttribute('data-snap', 'none');
  const [joint] = await jointList(page);
  expect(joint!.a).toEqual({ objectId: ids.a, partId: 'battery', face: '+x' });
  expect(joint!.b).toEqual({ objectId: ids.b, partId: 'housing', face: '-x' });
  expect(joint!.confirmed).toBe(false);
  const bAfter = (await objectRows(page))[1]!;
  expect(bAfter[1].x).not.toBe(bBefore![1].x);
  await expect(page.getByText(/已接合「.+」與「.+」，請確認固定方式。/)).toBeVisible();
  await expect(card(page)).toContainText('待確認');
  await expect(card(page).getByTestId('joint-recommendation')).toContainText('尚未得知負重與拆裝需求');
  await expect(page.getByRole('list', { name: '接合清單' }).getByRole('button')).toHaveCount(1);

  // One undo step removes the joint and puts B back; redo brings both back.
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect.poll(async () => (await objectRows(page))[1]![1]).toEqual(bBefore![1]);
  await expect(card(page)).toHaveCount(0);
  await redo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
  await expect.poll(async () => (await objectRows(page))[1]![1].x).toBeCloseTo(bAfter[1].x, 5);
});

test('接合卡片：負重與拆裝改變建議，自選方式即確認，每項都是一步復原', async ({ page }) => {
  await joinDemos(page);
  const method = async () => (await jointList(page))[0]!;

  await field(page, '負重').selectOption({ label: '輕' });
  await field(page, '拆裝').selectOption({ label: '經常' });
  await expect.poll(async () => (await method()).method.kind).toBe('magnet');
  expect((await method()).confirmed).toBe(false);
  expect((await method()).needs).toEqual({ load: 'light', disassembly: 'often' });
  await expect(field(page, '固定方式')).toHaveValue('magnet');
  await expect(card(page)).toContainText('待確認');
  await expect(card(page).getByTestId('joint-derived')).toContainText('磁鐵');

  // Choosing a method is a decision: the joint is confirmed and the method is kept.
  await field(page, '固定方式').selectOption({ label: '熱壓螺母＋螺絲' });
  await expect.poll(async () => (await method()).method.kind).toBe('screw-insert');
  expect((await method()).confirmed).toBe(true);
  await expect(card(page)).toContainText('已確認');
  await expect(card(page).getByTestId('joint-derived')).toContainText('熱壓螺母');
  await expect(page.getByRole('list', { name: '接合清單' }).getByRole('button')).toContainText('已確認');
  await expect(button(page, '確認方式')).toHaveCount(0);

  // A parameter change keeps the method.
  await field(page, '規格').selectOption({ label: 'M2' });
  await expect.poll(async () => (await method()).method).toMatchObject({ kind: 'screw-insert', size: 'M2' });

  // 一次復原一個步驟。
  await undo(page).click();
  await expect.poll(async () => (await method()).method).toMatchObject({ kind: 'screw-insert', size: 'M3' });
  await undo(page).click();
  await expect.poll(async () => (await method()).method.kind).toBe('magnet');
  expect((await method()).confirmed).toBe(false);
  await expect(field(page, '固定方式')).toHaveValue('magnet');
  await redo(page).click();
  await expect.poll(async () => (await method()).method.kind).toBe('screw-insert');
  await expect(card(page)).toContainText('已確認');

  // 確認方式 on a fresh unconfirmed joint, and 刪除接合 as one undo step.
  await undo(page).click();
  await undo(page).click();
  await expect.poll(async () => (await method()).confirmed).toBe(false);
  await button(page, '確認方式').click();
  await expect.poll(async () => (await method()).confirmed).toBe(true);
  await button(page, '刪除接合').click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect(card(page)).toHaveCount(0);
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
});

test('取消接合與 Esc 讓一切回到原位，換一組面在只有一組時停用', async ({ page }) => {
  const ids = await loadTwoDemos(page);
  const before = await offset(page, ids);

  await previewJoin(page, ids);
  await expect(button(page, '換一組面')).toBeDisabled();
  await button(page, '取消接合').click();
  await expect(status(page)).toHaveCount(0);
  await expect(canvas(page)).toHaveAttribute('data-snap', 'none');
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  const afterCancel = await offset(page, ids);
  expect(afterCancel.x).toBeCloseTo(before.x, 1);
  expect(afterCancel.y).toBeCloseTo(before.y, 1);

  await previewJoin(page, ids);
  await page.keyboard.press('Escape');
  await expect(status(page)).toHaveCount(0);
  await expect(canvas(page)).toHaveAttribute('data-snap', 'none');
  const afterEscape = await offset(page, ids);
  expect(afterEscape.x).toBeCloseTo(before.x, 1);
  expect(afterEscape.y).toBeCloseTo(before.y, 1);

  // While a join runs a click chooses a part and never selects it.
  await button(page, '新增接合').click();
  await clickPart(page, 'battery', ids.a);
  await expect(canvas(page)).toHaveAttribute('data-selected-ids', '');
  await button(page, '取消接合').click();
});

test('新增接合不會讓頁面跳動，接合期間畫布固定在視窗內，可直接點選零件', async ({ page }) => {
  const ids = await loadTwoDemos(page);
  const start = button(page, '新增接合');
  // The 接合 panel is far below the canvas: reach the button the way a user does and check that the canvas is out of view there.
  await start.scrollIntoViewIfNeeded();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const away = (await canvas(page).boundingBox())!;
  expect(away.y + away.height).toBeLessThan(0);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  // A real mouse click: no Playwright scroll, so any change of the scroll position comes from the page itself.
  const box = (await start.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(status(page)).toContainText('點選第一個要接合的零件。');
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  const pinned = (await canvas(page).boundingBox())!;
  expect(pinned.y).toBeGreaterThanOrEqual(0);
  expect(pinned.y + pinned.height).toBeLessThanOrEqual(viewportHeight);
  // The first click on a part works without scrolling anywhere.
  await clickPart(page, 'battery', ids.a);
  await expect(status(page)).toContainText('點選另一個物件上要接合的零件。');
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await page.keyboard.press('Escape');
  await expect(status(page)).toHaveCount(0);
});

test('一個零件沒有平面（球）時給出提示，並留在第一步', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
  const ball: ModelSpec = validateModel({
    schemaVersion: '1.0', name: '測試：一顆球', summary: '只有一個球形零件。', units: 'm', assumptions: [],
    parts: [{ id: 'ball', name: '球', parentId: null, primitive: 'sphere', dimensions: { x: 0.05, y: 0.05, z: 0.05 },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#ff8800', role: 'exterior', tubeRatio: 0.3 }],
  });
  await page.route('**/api/generate', route => {
    const body = route.request().postDataJSON() as { requestId: string };
    return route.fulfill({ json: {
      design: { status: 'ready', explanation: '測試替身模型資料。', model: ball },
      source: 'codex', model: 'test-double-not-a-real-model', elapsedMs: 25, requestId: body.requestId,
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await page.getByRole('tab', { name: '生成新物件', exact: true }).click();
  await page.getByLabel('物件描述', { exact: true }).fill('一顆球');
  await page.getByRole('button', { name: '生成 3D 草案', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '2');
  const [, second] = await objectRows(page);

  await button(page, '新增接合').click();
  await clickPart(page, 'ball', second![0]);
  await expect(page.getByTestId('mouse-join-notice')).toHaveText('這個零件沒有平面可以接合。');
  await expect(status(page)).toContainText('點選第一個要接合的零件。');
  // A part with a flat face moves on to the second step, and the sphere then has no facing pair with it.
  const [first] = await objectRows(page);
  await clickPart(page, 'battery', first![0]);
  await expect(status(page)).toContainText('點選另一個物件上要接合的零件。');
  await clickPart(page, 'ball', second![0]);
  await expect(page.getByTestId('mouse-join-notice')).toHaveText('這兩個零件沒有可以接合的平面。');
  await expect(status(page)).toContainText('點選另一個物件上要接合的零件。');
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await button(page, '取消接合').click();
  await expect(status(page)).toHaveCount(0);
});

test('接合的物件一起移動，刪除物件連同接合一起移除，復原一次全部回來', async ({ page }) => {
  const ids = await joinDemos(page);
  const [aJoined, bJoined] = await objectRows(page);
  // 物件 panel: move A by 50 mm along X; B follows by the same offset.
  await objectEntries(page).first().click();
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', ids.a);
  const x = page.getByLabel('物件位置 X', { exact: true });
  await x.fill(String(Math.round(aJoined![1].x * 1000) + 50));
  await x.press('Enter');
  await expect.poll(async () => (await objectRows(page))[0]![1].x).toBeCloseTo(aJoined![1].x + 0.05, 5);
  await expect.poll(async () => (await objectRows(page))[1]![1].x).toBeCloseTo(bJoined![1].x + 0.05, 5);
  expect((await objectRows(page))[1]![1].y).toBeCloseTo(bJoined![1].y, 5);
  await expect(page.getByText('已調整物件位置（連同接合的 1 個物件），可按「復原」回到上一步。')).toBeVisible();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
  // One undo step moves both back.
  await undo(page).click();
  await expect.poll(async () => (await objectRows(page))[0]![1].x).toBeCloseTo(aJoined![1].x, 5);
  await expect.poll(async () => (await objectRows(page))[1]![1].x).toBeCloseTo(bJoined![1].x, 5);

  // Deleting an object removes its joints in the same step.
  await button(page, '刪除物件').click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect(page.getByText(/已一併移除 1 個接合。/)).toBeVisible();
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '2');
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
});

test('材料：預設未指定，選 PLA 為一步復原', async ({ page }) => {
  await loadTwoDemos(page);
  await expect(field(page, '材料')).toHaveValue('');
  await field(page, '材料').selectOption({ label: 'PLA' });
  await expect(field(page, '材料')).toHaveValue('pla');
  await expect(page.getByText('已設定材料，可按「復原」回到上一步。')).toBeVisible();
  await undo(page).click();
  await expect(field(page, '材料')).toHaveValue('');
  await redo(page).click();
  await expect(field(page, '材料')).toHaveValue('pla');
});

test('列印設定：數值存在瀏覽器，重新載入後仍在，恢復預設值', async ({ page }) => {
  await loadTwoDemos(page);
  const panel = page.getByTestId('printer-panel');
  await panel.getByText('列印設定', { exact: false }).first().click();
  const hole = field(page, '孔徑補償');
  await expect(hole).toHaveValue('0.2');
  await hole.fill('0.35');
  await hole.press('Enter');
  await expect(hole).toHaveValue('0.35');
  await page.reload();
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await page.getByTestId('printer-panel').getByText('列印設定', { exact: false }).first().click();
  await expect(field(page, '孔徑補償')).toHaveValue('0.35');
  await button(page, '恢復預設值').click();
  await expect(field(page, '孔徑補償')).toHaveValue('0.2');
  await page.reload();
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await page.getByTestId('printer-panel').getByText('列印設定', { exact: false }).first().click();
  await expect(field(page, '孔徑補償')).toHaveValue('0.2');
});

/**
 * The Vite dev server finds manifold-3d only when it is first imported and then reloads the page once to optimise it, which would wipe a
 * workspace in the middle of a test. Load the library once before the test (a fresh checkout needs two tries; later runs reuse Vite's cache).
 */
async function warmPrintLibrary(page: Page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto('/');
    const loaded = await page.evaluate(path => import(path).then(module => module.loadManifold()).then(() => true), '/src/print/manifold.ts').catch(() => false);
    if (loaded) return;
    await page.waitForLoadState('load');
  }
  throw new Error('manifold-3d did not load in the dev server');
}

test('列印件預覽：載入後顯示在零件上，再按一次關閉；改動工作區也會關閉', async ({ page }) => {
  test.setTimeout(180_000);
  await warmPrintLibrary(page);
  const ids = await joinDemos(page);
  await field(page, '固定方式').selectOption({ label: '熱壓螺母＋螺絲' });
  await expect(canvas(page)).toHaveAttribute('data-print-preview', '');
  await button(page, '預覽「外殼」列印件').click();
  await expect(canvas(page)).toHaveAttribute('data-print-preview', `${ids.b}:housing`, { timeout: 60_000 });
  await expect(button(page, '關閉預覽')).toBeVisible();
  await button(page, '關閉預覽').click();
  await expect(canvas(page)).toHaveAttribute('data-print-preview', '');
  await expect(button(page, '預覽「外殼」列印件')).toBeVisible();

  // A change of the workspace closes the preview.
  await button(page, '預覽「側邊電池」列印件').click();
  await expect(canvas(page)).toHaveAttribute('data-print-preview', `${ids.a}:battery`, { timeout: 60_000 });
  await field(page, '材料').selectOption({ label: 'PETG' });
  await expect(canvas(page)).toHaveAttribute('data-print-preview', '');
});

test('代理建立接合：state 框建立接合並開啟卡片，請求帶著列印設定，一次復原', async ({ page }) => {
  const ids = await loadTwoDemos(page);
  const before = await objectRows(page);
  // The server's plan, computed with the shared functions on the page's own placement: A's 側邊電池 to B's 外殼, B moved onto A.
  let ws = emptyWorkspace();
  for (const [id, position, rotation] of before) ws = addObject(ws, fixtureObject(id, demoModel, { position, rotation }));
  const plan = planJoin(ws, { objectId: ids.a, partId: 'battery' }, { objectId: ids.b, partId: 'housing' });
  if (!plan.ok || !plan.move) throw new Error('the demo pair should need a move to join');
  const moved = setTransform(ws, plan.move.objectId, plan.move.transform);
  const joint = newJoint(moved, { id: 'agent-joint', createdAt: '2026-11-25T10:00:00.000Z', a: plan.a, b: plan.b }, DEFAULT_PRINTER_PROFILE);
  const change: StateChange = {
    activeObjectId: null, object: { op: 'transform', objectId: plan.move.objectId, transform: plan.move.transform },
    joint: { op: 'add', joint }, selection: null, explode: null, tryOn: null,
  };
  const summary = '已建立接合，建議方式已選好，尚未確認。';
  const result: ToolResult = { tool: 'create_joint', ok: true, summary, detail: { jointId: joint.id }, stateChange: change };
  const reply = '已為兩個物件建立接合，請告訴我負重與拆裝需求。';
  const body = [
    serializeSseEvent('status', { note: '正在建立接合。' }),
    serializeSseEvent('tool', { tool: 'create_joint', label: '建立接合', argsJson: '{"a":{"objectId":"a"},"b":{"objectId":"b"}}' }),
    serializeSseEvent('result', result),
    serializeSseEvent('state', change),
    serializeSseEvent('final', { reply }),
    serializeSseEvent('done', {}),
  ].join('');
  let requestBody: { printer?: unknown; workspace?: { joints?: unknown[] } } | null = null;
  await page.route('**/api/agent', route => {
    requestBody = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.getByLabel('任務指示', { exact: true }).fill('把兩個物件接合起來');
  await button(page, '執行').click();
  await expect(page.getByTestId('agent-reply')).toContainText(reply);

  // The request carries the printer profile of the browser and a version-2 workspace without joints.
  expect(requestBody!.printer).toEqual(DEFAULT_PRINTER_PROFILE);
  expect(requestBody!.workspace!.joints).toEqual([]);
  // The joint exists, B moved onto A, and the card of the new joint is open.
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
  const [stored] = await jointList(page);
  expect(stored).toEqual(joint);
  expect(stored!.confirmed).toBe(false);
  await expect.poll(async () => (await objectRows(page))[1]![1]).toEqual(plan.move.transform.position);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute('data-joint-id', 'agent-joint');
  await expect(card(page)).toContainText('待確認');
  await expect(page.getByText('代理已建立接合，可按「復原」回到上一步。')).toBeVisible();

  // One 復原 removes the joint and puts B back.
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect.poll(async () => (await objectRows(page))[1]![1]).toEqual(before[1]![1]);
  await expect(card(page)).toHaveCount(0);
  await redo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
});