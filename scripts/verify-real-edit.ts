import 'dotenv/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { Box3, Color, Mesh, type Object3D } from 'three';
import { createModelHost } from '../server/model-host';
import { editTask, GenerationError } from '../server/provider';
import { applyEditPlan, type AppliedEdit, type EditPlan } from '../shared/edit';
import { validateModel, type ModelSpec } from '../shared/model';
import { buildModel, disposeObject } from '../src/scene/geometry';

// Real-provider edit verification (phase two). Each case starts from the same
// captured real model so results are independent and comparable.
const source = path.resolve('artifacts/real-provider-2026-11-11.json');
const base: ModelSpec = validateModel((JSON.parse(await readFile(source, 'utf8')) as { runs: Array<{ results: Array<{ id: string; design: { model: unknown } }> }> })
  .runs.at(-1)!.results.find(result => result.id === 'P01')!.design.model);

type Boxes = Map<string, Box3>;
function worldBoxes(model: ModelSpec): Boxes {
  const group = buildModel(model, geometry => new Mesh(geometry));
  const boxes: Boxes = new Map();
  group.traverse((object: Object3D) => {
    if (typeof object.userData.partId !== 'string') return;
    const surface = object.children.find(child => child instanceof Mesh);
    if (surface) boxes.set(object.userData.partId, new Box3().setFromObject(surface));
  });
  disposeObject(group);
  return boxes;
}
const hue = (hex: string) => { const color = new Color(hex); const hsl = { h: 0, s: 0, l: 0 }; color.getHSL(hsl); return { ...hsl, h: hsl.h * 360 }; };
const legs = (model: ModelSpec) => model.parts.filter(part => /腿|腳/.test(part.name));
const top = (model: ModelSpec) => model.parts.find(part => /桌面/.test(part.name));

interface Case { id: string; kind: string; instruction: string; selected: string[]; expect: 'applied' | 'clarify';
  check?: (before: ModelSpec, result: AppliedEdit) => Array<{ name: string; passed: boolean; detail?: unknown }> }
const cases: Case[] = [
  { id: 'E1', kind: '改尺寸＋連動', instruction: '四條桌腳都加長到 50 公分，桌面跟著升高，桌腳仍要碰到地面', selected: [], expect: 'applied',
    check: (_before, { model }) => {
      const boxes = worldBoxes(model); const tableTop = top(model)!; const legParts = legs(model);
      const legHeights = legParts.map(part => boxes.get(part.id)!.max.y - boxes.get(part.id)!.min.y);
      const gap = Math.max(...legParts.map(part => Math.abs(boxes.get(tableTop.id)!.min.y - boxes.get(part.id)!.max.y)));
      const floor = Math.max(...legParts.map(part => Math.abs(boxes.get(part.id)!.min.y)));
      return [{ name: '四條桌腳高約 500 mm（±10）', passed: legParts.length === 4 && legHeights.every(h => Math.abs(h - 0.5) <= 0.01), detail: legHeights },
        { name: '桌面底與桌腳頂相接（≤5 mm）', passed: gap <= 0.005, detail: gap },
        { name: '桌腳底仍在地面（≤5 mm）', passed: floor <= 0.005, detail: floor }];
    } },
  { id: 'E2', kind: '改顏色（選取）', instruction: '把這個改成藍色', selected: ['top'], expect: 'applied',
    check: (before, { model, changes }) => {
      const color = hue(model.parts.find(part => part.id === 'top')!.color);
      return [{ name: '只變更桌面', passed: changes.updated.join() === 'top' && !changes.added.length && !changes.removed.length, detail: changes },
        { name: '桌面為藍色（色相 200–250°）', passed: color.h >= 200 && color.h <= 250 && color.s > 0.3, detail: color },
        { name: '桌腳顏色未變', passed: legs(model).every(part => part.color === before.parts.find(entry => entry.id === part.id)!.color) }];
    } },
  { id: 'E3', kind: '新增零件', instruction: '在桌面中央放一個綠色杯子', selected: [], expect: 'applied',
    // A cup may reasonably be built from several parts (body, base, handle);
    // the whole added assembly is checked. (Revised after the first Codex run,
    // whose 3-part cup failed an over-strict "exactly one part" check.)
    check: (_before, { model, changes }) => {
      const boxes = worldBoxes(model); const added = model.parts.filter(part => changes.added.includes(part.id));
      const tableBox = boxes.get(top(model)!.id)!;
      const assembly = added.length ? added.map(part => boxes.get(part.id)!).reduce((all, box) => all.union(box), new Box3()) : null;
      const center = assembly ? assembly.getCenter(assembly.min.clone()) : null;
      return [{ name: '新增零件且原零件未變更', passed: added.length >= 1 && !changes.updated.length && !changes.removed.length, detail: changes },
        { name: '新零件皆為綠色（色相 90–160°）', passed: added.length >= 1 && added.every(part => hue(part.color).h >= 90 && hue(part.color).h <= 160), detail: added.map(part => part.color) },
        { name: '放在桌面上（組件最低點與桌面頂差 ≤5 mm）', passed: Boolean(assembly) && Math.abs(assembly!.min.y - tableBox.max.y) <= 0.005, detail: assembly && { bottom: assembly.min.y, tableTop: tableBox.max.y } },
        { name: '靠近桌面中央（水平 ≤30 mm）', passed: Boolean(center) && Math.hypot(center!.x, center!.z) <= 0.03, detail: center }];
    } },
  { id: 'E4', kind: '刪除零件', instruction: '把右前桌腿刪掉', selected: [], expect: 'applied',
    check: (_before, { changes }) => [{ name: '只刪除右前桌腿', passed: changes.removed.join() === 'leg2' && !changes.added.length && !changes.updated.length, detail: changes }] },
  { id: 'E5', kind: '相對調整＋連動', instruction: '桌面再寬一點，四條桌腳跟著往外移，仍然撐在桌面四角下方', selected: [], expect: 'applied',
    check: (before, { model }) => {
      const boxes = worldBoxes(model); const tableBox = boxes.get(top(model)!.id)!;
      const wider = top(model)!.dimensions.x > top(before)!.dimensions.x + 0.001;
      const outward = legs(model).every(part => Math.abs(part.position.x) > Math.abs(before.parts.find(entry => entry.id === part.id)!.position.x) + 0.001);
      const under = legs(model).every(part => { const box = boxes.get(part.id)!; return box.min.x >= tableBox.min.x - 0.001 && box.max.x <= tableBox.max.x + 0.001; });
      return [{ name: '桌面變寬', passed: wider, detail: { before: top(before)!.dimensions.x, after: top(model)!.dimensions.x } },
        { name: '四條桌腳都往外移', passed: outward }, { name: '桌腳仍在桌面範圍內', passed: under }];
    } },
  { id: 'E6', kind: '模糊指令', instruction: '把它變大', selected: [], expect: 'clarify' },
];

const file = path.resolve('artifacts', `real-edit-${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })}.json`);

// VERIFY_REPLAY=1 re-runs the current checks on the saved answers of the
// latest run without calling any model; nothing is written.
if (process.env.VERIFY_REPLAY === '1') {
  const saved = (JSON.parse(await readFile(file, 'utf8')) as { runs: Array<{ provider: string; results: Array<{ id: string; plan?: EditPlan; passed?: boolean }> }> }).runs.at(-1)!;
  for (const result of saved.results) {
    const scenario = cases.find(entry => entry.id === result.id)!;
    if (!result.plan) { console.log(JSON.stringify({ id: result.id, replay: 'no saved plan' })); continue; }
    const checks = result.plan.status === 'applied' ? scenario.check?.(base, applyEditPlan(base, result.plan)) ?? [] : [];
    console.log(JSON.stringify({ id: result.id, provider: saved.provider, originalPassed: result.passed,
      replayPassed: result.plan.status === scenario.expect && checks.every(check => check.passed), checks }));
  }
  process.exit(0);
}

const startedAt = new Date().toISOString();
const timeoutMs = 180_000;
const startup = performance.now();
const provider = await createModelHost({ ...process.env, MODEL_TIMEOUT_MS: String(timeoutMs) });
const startupMs = Math.round(performance.now() - startup);
if (!provider.configured || !provider.run) throw new Error('真實模型服務尚未設定、未登入或不支援修改；不使用替身。');
const results: Array<Record<string, unknown>> = [];
const run: Record<string, unknown> = { startedAt, timezone: 'Asia/Taipei', provider: provider.name, transport: provider.transport ?? 'responses', selectedModel: provider.model, startupMs, timeoutMs,
  baseModel: { source: 'artifacts/real-provider-2026-11-11.json P01', name: base.name, parts: base.parts.length },
  runtime: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, memoryGiB: Math.round(totalmem() / 1024 ** 3) },
  measurement: '修改請求送出→provider 回覆→schema 驗證→套用到基準模型並驗證；序列執行、不含瀏覽器繪製。', results };
let prior: unknown[] = [];
try { prior = (JSON.parse(await readFile(file, 'utf8')) as { runs?: unknown[] }).runs ?? []; } catch { /* first run */ }
const persist = async () => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify({ schemaVersion: 1, runs: [...prior, run] }, null, 2) + '\n'); await rename(`${file}.tmp`, file); };
try {
  const only = process.env.VERIFY_EDIT_CASES?.split(",").map(value => value.trim()).filter(Boolean);
  for (const scenario of only?.length ? cases.filter(entry => only.includes(entry.id)) : cases) {
    const start = performance.now();
    const entry: Record<string, unknown> = { id: scenario.id, kind: scenario.kind, instruction: scenario.instruction, selected: scenario.selected };
    try {
      const plan: EditPlan = await provider.run(editTask(base, scenario.instruction, scenario.selected), AbortSignal.timeout(timeoutMs));
      entry.elapsedMs = Math.round(performance.now() - start);
      entry.plan = plan; entry.status = plan.status; entry.operationCount = plan.operations.length;
      if (plan.status === 'applied') {
        const applied = applyEditPlan(base, plan);
        entry.changes = applied.changes;
        entry.checks = scenario.check?.(base, applied) ?? [];
      }
      entry.expectedStatus = scenario.expect;
      entry.passed = plan.status === scenario.expect && ((entry.checks as Array<{ passed: boolean }> | undefined) ?? []).every(check => check.passed);
    } catch (error) {
      entry.elapsedMs = Math.round(performance.now() - start);
      entry.status = 'failed'; entry.passed = false;
      entry.error = error instanceof GenerationError ? { code: error.code, message: error.message } : { message: error instanceof Error ? error.message.slice(0, 300) : 'unknown' };
    }
    results.push(entry);
    await persist();
    console.log(JSON.stringify({ id: entry.id, status: entry.status, passed: entry.passed, elapsedMs: entry.elapsedMs, ops: entry.operationCount ?? null }));
  }
  const times = results.map(result => result.elapsedMs as number).sort((a, b) => a - b);
  run.completedAt = new Date().toISOString();
  run.summary = { cases: results.length, passed: results.filter(result => result.passed).length, failed: results.filter(result => result.status === 'failed').length,
    minMs: times[0], maxMs: times.at(-1), medianMs: times[Math.floor(times.length / 2)], observedModel: provider.model };
  await persist();
  console.log(JSON.stringify({ artifact: path.relative(process.cwd(), file), summary: run.summary }));
} finally { await provider.dispose?.(); }
