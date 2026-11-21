import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { expect, test, type Download, type Page } from '@playwright/test';
import { serializeSseEvent, type StateChange, type ToolResult } from '../../shared/agent';
import { planJoin } from '../../shared/contact';
import { demoModel } from '../../shared/demo';
import { newJoint } from '../../shared/joint-rules';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import { addObject, emptyWorkspace, setTransform } from '../../shared/workspace';
import { fixtureObject } from '../fixtures/joint-workspace';
// The export dialog, end to end: two demo objects joined by an agent-created joint (a routed `/api/agent` stream whose
// `state` frame carries a `joint` change), the findings, the zip and one single file unpacked in the test, a change of
// the workspace while the dialog is open, and the escaping of a hostile name. `/api/*` is never called for a model; the
// Three.js scene, the CSG module, the GLB writer and the off-screen render are real.
const canvas = (page: Page) => page.getByTestId('scene-canvas');
const dialog = (page: Page) => page.getByTestId('export-dialog');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
type Vector = { x: number; y: number; z: number };
type ObjectRow = [string, Vector, Vector];
const objectRows = async (page: Page): Promise<ObjectRow[]> => JSON.parse((await canvas(page).getAttribute('data-object-json'))!);
const HOSTILE_NAME = `=cmd|' /C calc'!A0 <script>alert(1)</script>|`;
const KIT_NAME = /^forgehand-kit-\d{8}-\d{4}\.zip$/;
/** Loads the demo model twice (the second object is placed beside the first). */
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
/** The agent joins A's 側邊電池 to B's 外殼 (B is moved onto A): a routed stream, no model back end. */
async function joinByAgent(page: Page, ids: { a: string; b: string }) {
  const before = await objectRows(page);
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
  const result: ToolResult = { tool: 'create_joint', ok: true, summary: '已建立接合，尚未確認。', detail: { jointId: joint.id }, stateChange: change };
  const reply = '已為兩個物件建立接合。';
  const body = [
    serializeSseEvent('status', { note: '正在建立接合。' }),
    serializeSseEvent('tool', { tool: 'create_joint', label: '建立接合', argsJson: '{}' }),
    serializeSseEvent('result', result),
    serializeSseEvent('state', change),
    serializeSseEvent('final', { reply }),
    serializeSseEvent('done', {}),
  ].join('');
  await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body }));
  await page.getByLabel('任務指示', { exact: true }).fill('把兩個物件接合起來');
  await button(page, '執行').click();
  await expect(page.getByTestId('agent-reply')).toContainText(reply);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
}
/** Opens the dialog and waits until the kit is ready; returns the milliseconds that took. */
async function openExport(page: Page): Promise<number> {
  const started = Date.now();
  await button(page, '匯出套件').click();
  await expect(dialog(page)).toHaveAttribute('data-export-state', 'ready', { timeout: 120_000 });
  return Date.now() - started;
}
const filesOf = async (page: Page): Promise<Array<{ path: string; bytes: number }>> => JSON.parse((await dialog(page).getAttribute('data-export-files'))!);
const findingsOf = async (page: Page): Promise<string[]> => JSON.parse((await dialog(page).getAttribute('data-export-findings'))!);
async function bytesOf(download: Download): Promise<Uint8Array> {
  return new Uint8Array(readFileSync((await download.path())!));
}
async function downloadFile(page: Page, label: string): Promise<{ name: string; bytes: Uint8Array }> {
  const pending = page.waitForEvent('download');
  await button(page, label).click();
  const download = await pending;
  return { name: download.suggestedFilename(), bytes: await bytesOf(download) };
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
/** The JSON chunk of a binary glTF. */
function glbJson(bytes: Uint8Array): { nodes: Array<{ name?: string; extras?: Record<string, unknown> }> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('glTF');
  const length = view.getUint32(12, true);
  expect(String.fromCharCode(...bytes.subarray(16, 20))).toBe('JSON');
  return JSON.parse(text(bytes.subarray(20, 20 + length)));
}
/** Records every state the dialog shows and whether the changed-workspace notice appeared. */
async function watchDialog(page: Page) {
  await page.evaluate(() => {
    const element = document.querySelector('[data-testid="export-dialog"]')!;
    const record = { states: [element.getAttribute('data-export-state')], notice: false };
    (window as unknown as { __exportWatch: typeof record }).__exportWatch = record;
    new MutationObserver(() => {
      const state = element.getAttribute('data-export-state');
      if (record.states[record.states.length - 1] !== state) record.states.push(state);
      if (element.textContent?.includes('工作區已變更，正在重新準備匯出內容…')) record.notice = true;
    }).observe(element, { attributes: true, childList: true, subtree: true, characterData: true });
  });
}
const watched = (page: Page) => page.evaluate(() => (window as unknown as { __exportWatch: { states: string[]; notice: boolean } }).__exportWatch);
const partButtons = (page: Page) => page.getByRole('list', { name: '零件清單' }).getByRole('button');
async function renamePart(page: Page, name: string) {
  const field = page.getByLabel('零件名稱', { exact: true });
  await field.fill(name);
  await field.press('Enter');
}
test.describe('匯出套件', () => {
  test('兩個示範物件加一個代理接合：對話框、檢查結果、整包 zip 與單一檔案', async ({ page }) => {
    const ids = await loadTwoDemos(page);
    await joinByAgent(page, ids);
    const objectsBefore = await objectRows(page);
    // The button is not gated by the agent and the export changes nothing in the workspace.
    const cold = await openExport(page);
    console.log(`export preparation, first open (loads the CSG module): ${cold} ms`);
    await expect(dialog(page)).toHaveAttribute('role', 'dialog');
    expect(await objectRows(page)).toEqual(objectsBefore);
    const files = await filesOf(page);
    const paths = files.map(file => file.path);
    for (const path of ['assembly.html', 'exploded.png', 'bom.csv', 'bom.md', 'kit.3mf', 'workspace.glb']) expect(paths).toContain(path);
    expect(paths.filter(path => /^stl\/P\d\d-[A-Za-z0-9._-]+\.stl$/.test(path)).length).toBeGreaterThan(0);
    expect(paths.every(path => /^[A-Za-z0-9._/-]+$/.test(path))).toBe(true);
    expect(files.every(file => file.bytes > 0)).toBe(true);
    await expect(dialog(page)).toHaveAttribute('data-export-image', 'ok');
    // The agent's joint is not confirmed; the demo housing is a solid box around the board.
    const findings = await findingsOf(page);
    expect(findings).toContain('JOINT_UNCONFIRMED');
    await expect(dialog(page)).toContainText(/有 \d+ 個問題，仍可繼續匯出。/);
    await expect(dialog(page)).toContainText('列印件');
    // Close, then open again: the CSG module is loaded already.
    await button(page, '關閉匯出').click();
    await expect(dialog(page)).toHaveCount(0);
    const warm = await openExport(page);
    console.log(`export preparation, second open: ${warm} ms`);
    // The whole kit.
    const pending = page.waitForEvent('download');
    await button(page, '下載完整套件').click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(KIT_NAME);
    const zip = unzipSync(await bytesOf(download));
    expect(Object.keys(zip).sort()).toEqual([...paths].sort());
    expect(String.fromCharCode(...zip['kit.3mf']!.subarray(0, 2))).toBe('PK');
    const glb = glbJson(zip['workspace.glb']!);
    const names = glb.nodes.map(node => node.name);
    expect(names).toContain(demoModel.name);
    expect(names).toContain('外殼');
    expect(glb.nodes.some(node => node.extras?.partId === 'housing')).toBe(true);
    const png = zip['exploded.png']!;
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1600, 1200]);
    expect([...zip['bom.csv']!.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const sheet = text(zip['assembly.html']!);
    expect(sheet).toContain('data:image/png;base64,');
    expect(sheet).not.toMatch(/<script/i);
    // One file equals its entry in the zip.
    const single = await downloadFile(page, '下載 kit.3mf');
    expect(single.name).toBe('kit.3mf');
    expect(single.bytes).toEqual(zip['kit.3mf']);
    const stl = paths.find(path => path.startsWith('stl/'))!;
    const oneStl = await downloadFile(page, `下載 ${stl}`);
    expect(oneStl.name).toBe(stl.slice(4));
    expect(oneStl.bytes).toEqual(zip[stl]);
    expect(text(oneStl.bytes.subarray(0, 80))).toContain('Forgehand');
    // Nothing the export did is an undo step or a model change.
    expect(await objectRows(page)).toEqual(objectsBefore);
    await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
  });
  test('工作區改變時重新準備；惡意名稱在每個檔案中被跳脫', async ({ page }) => {
    const ids = await loadTwoDemos(page);
    await joinByAgent(page, ids);
    await openExport(page);
    await watchDialog(page);
    // Selecting a part is not a change of what is exported.
    await partButtons(page).first().click();
    await expect(page.getByLabel('零件名稱', { exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    expect((await watched(page)).states).toEqual(['ready']);
    // Renaming a part is: the dialog prepares again and the new name reaches the files.
    await renamePart(page, '新外殼名稱');
    await expect(dialog(page)).toHaveAttribute('data-export-state', 'ready', { timeout: 120_000 });
    await expect.poll(async () => (await watched(page)).states, { timeout: 120_000 }).toEqual(['ready', 'preparing', 'ready']);
    expect((await watched(page)).notice).toBe(true);
    const markdown = await downloadFile(page, '下載 bom.md');
    expect(markdown.name).toBe('bom.md');
    expect(text(markdown.bytes)).toContain('新外殼名稱');
    // A hostile name is escaped in every format.
    await renamePart(page, HOSTILE_NAME);
    await expect.poll(async () => (await watched(page)).states, { timeout: 120_000 }).toEqual(['ready', 'preparing', 'ready', 'preparing', 'ready']);
    const sheet = text((await downloadFile(page, '下載 assembly.html')).bytes);
    expect(sheet).not.toMatch(/<script/i);
    expect(sheet).toContain('&lt;script&gt;');
    const csv = text((await downloadFile(page, '下載 bom.csv')).bytes);
    expect(csv).toContain("'=cmd|' /C calc'!A0");
    expect(text((await downloadFile(page, '下載 bom.md')).bytes)).not.toMatch(/<script/i);
  });
  test('按鈕在沒有物件時停用；Esc 與 關閉匯出 關閉對話框；視角方向可讀取', async ({ page }) => {
    await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
    await page.goto('/');
    await expect(button(page, '匯出套件')).toBeDisabled();
    await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
    await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
    await expect(button(page, '匯出套件')).toBeEnabled();
    const direction = await page.evaluate(() => window.__forgehandScene?.viewDirection() ?? null);
    expect(direction).not.toBeNull();
    expect(Math.hypot(direction!.x, direction!.y, direction!.z)).toBeCloseTo(1, 5);
    await openExport(page);
    // A kit with one object has no scope choice; it has no joints, so no joint findings, and the housing blocks the board.
    await expect(page.getByLabel('匯出範圍', { exact: true })).toHaveCount(0);
    expect(await findingsOf(page)).toContain('COMPONENT_BLOCKED');
    await expect(dialog(page)).toHaveAttribute('data-export-image', 'ok');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    // 關閉匯出 closes it as well, also while it prepares.
    await button(page, '匯出套件').click();
    await expect(dialog(page)).toBeVisible();
    await button(page, '關閉匯出').click();
    await expect(dialog(page)).toHaveCount(0);
  });
  test('代理的 prepare_export 以指定範圍開啟匯出對話框，不是復原步驟，也不自動下載', async ({ page }) => {
    const ids = await loadTwoDemos(page);
    // Loading a demo model is an undo step, so 復原 is enabled here; the export must not add another one.
    const undo = button(page, '復原');
    await expect(undo).toBeEnabled();
    const objectsBefore = await objectRows(page);
    // A routed stream like the server's: tool, result and a `state` frame that only carries `exportDialog`.
    const change: StateChange = {
      activeObjectId: null, object: null, selection: null, explode: null, tryOn: null,
      exportDialog: { scope: 'assembly', objectId: ids.b },
    };
    const result: ToolResult = {
      tool: 'prepare_export', ok: true,
      summary: '已開啟匯出視窗：列印零件 1 個（相連的零件會合併成一個列印件，實際數量以匯出視窗為準），外購件 1 個，標準件 0 項。請使用者按「下載完整套件」。',
      detail: null, stateChange: change,
    };
    const reply = '匯出視窗已開啟，請按「下載完整套件」。';
    const body = [
      serializeSseEvent('status', { note: '正在準備匯出。' }),
      serializeSseEvent('tool', { tool: 'prepare_export', label: '準備匯出', argsJson: JSON.stringify({ scope: 'assembly', objectId: ids.b }) }),
      serializeSseEvent('result', result),
      serializeSseEvent('state', change),
      serializeSseEvent('final', { reply }),
      serializeSseEvent('done', {}),
    ].join('');
    await page.route('**/api/agent', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body }));
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    await page.getByLabel('任務指示', { exact: true }).fill('幫我匯出可以列印的套件');
    await button(page, '執行').click();
    await expect(page.getByTestId('agent-reply')).toContainText(reply);
    // The dialog opened with the scope the agent chose, and prepared as usual.
    await expect(dialog(page)).toHaveAttribute('data-export-state', 'ready', { timeout: 120_000 });
    await expect(page.getByLabel('匯出範圍', { exact: true })).toHaveValue('assembly');
    expect(await filesOf(page)).not.toHaveLength(0);
    // Not an undo step, no workspace change, and nothing downloaded without the user's click.
    expect(await objectRows(page)).toEqual(objectsBefore);
    expect(downloads).toBe(0);
    await button(page, '關閉匯出').click();
    await expect(dialog(page)).toHaveCount(0);
    // One 復原 undoes the second demo load, so the export left no step of its own on top of it.
    await undo.click();
    await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  });
});
