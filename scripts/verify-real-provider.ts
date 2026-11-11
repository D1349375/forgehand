import 'dotenv/config';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { Box3, Color, LineSegments, Mesh, Vector3 } from 'three';
import { inspectCodex } from '../server/codex';
import { createModelHost } from '../server/model-host';
import { GENERATOR_VERSION, GenerationError } from '../server/provider';
import { validateDesign, type ModelSpec, type Part } from '../shared/model';
import { buildModel, disposeObject, modelBounds } from '../src/scene/geometry';
import { hologramPart } from '../src/scene/style';
import { representativePrompts } from '../tests/e2e/representative-prompts';

type Check = { label: string; passed: boolean; evidence: string };
type RecordEntry = { id: string; prompt: string; requestedHumanChecks: readonly string[]; status: string;
  source: string; model: string; elapsedMs: number; [key: string]: unknown };

function hasColor(part: Part, color: string): boolean {
  const c = new Color(part.color);
  const maximum = Math.max(c.r, c.g, c.b), minimum = Math.min(c.r, c.g, c.b);
  if (color === 'red') return c.r > 0.1 && c.r > c.g * 1.5 && c.r > c.b * 1.5;
  if (color === 'blue') return c.b > 0.1 && c.b > c.r * 1.3 && c.b >= c.g * 0.9;
  if (color === 'green') return c.g > 0.1 && c.g > c.r * 1.2 && c.g > c.b * 1.1;
  if (color === 'yellow') return c.r > 0.15 && c.g > 0.15 && c.b < Math.min(c.r, c.g) * 0.5;
  if (color === 'orange') return c.r > 0.2 && c.g > 0.02 && c.r > c.g * 1.25 && c.g > c.b * 1.3;
  if (color === 'purple') return c.r > 0.02 && c.b > 0.05 && c.g < Math.max(c.r, c.b) * 0.5;
  if (color === 'white') return minimum > 0.5 && maximum - minimum < 0.15;
  if (color === 'black') return maximum < 0.05;
  if (color === 'cyan') return c.g > 0.1 && c.b > 0.1 && c.r < Math.min(c.g, c.b) * 0.6;
  return false;
}

function structuralChecks(id: string, spec: ModelSpec, group: ReturnType<typeof buildModel>): Check[] {
  const checks: Check[] = [];
  const add = (label: string, passed: boolean, evidence: unknown) => checks.push({ label, passed, evidence: JSON.stringify(evidence) });
  const named = (pattern: RegExp) => spec.parts.filter(part => pattern.test(part.name));
  const colored = (color: string) => spec.parts.filter(part => hasColor(part, color));
  const position = (part: Part) => group.getObjectByName(part.id)!.getWorldPosition(new Vector3());
  const legs = named(/腳|腿/);
  if (id === 'P01') {
    const tops = named(/桌面/);
    add('四條獨立桌腿', legs.length === 4, legs.map(p => p.name));
    add('紅色桌面', tops.some(p => hasColor(p, 'red')), tops.map(p => ({ name: p.name, color: p.color })));
    add('桌面中心高於桌腿中心', tops.length > 0 && legs.length === 4 && legs.every(p => position(p).y < position(tops[0]!).y), [...tops, ...legs].map(p => ({ name: p.name, y: position(p).y })));
  } else if (id === 'P02') {
    add('三條獨立腳', legs.length === 3, legs.map(p => p.name));
    const seats = named(/座|凳面/);
    add('藍色圓座面', seats.some(p => p.primitive === 'cylinder' && hasColor(p, 'blue')), seats.map(p => ({ name: p.name, primitive: p.primitive, color: p.color })));
  } else if (id === 'P03') {
    // One lens may contain a barrel plus a rim. Count the axial barrel, not
    // every part whose name contains 鏡頭. Original P03 evidence is retained.
    const lenses = named(/鏡筒|鏡頭/).filter(p => ['cylinder', 'tube'].includes(p.primitive) && !/鏡片/.test(p.name));
    const batteries = named(/電池/);
    add('兩個鏡頭主件（依名稱初篩）', lenses.length === 2, lenses.map(p => p.name));
    add('側邊電池有橫向偏移', batteries.some(p => Math.abs(position(p).x) > 0.001), batteries.map(p => ({ name: p.name, x: position(p).x })));
  } else if (id === 'P04') {
    add('以真正中空tube建立綠色筒壁', spec.parts.some(p => p.primitive === 'tube' && hasColor(p, 'green')), spec.parts.map(p => ({ name: p.name, primitive: p.primitive, color: p.color })));
    add('有額外底部幾何', named(/底/).some(p => ['cylinder', 'box'].includes(p.primitive)), named(/底/).map(p => p.name));
  } else if (id === 'P05') {
    const rods = colored('white').filter(p => /桿|臂/.test(p.name));
    add('橘底與紫球', colored('orange').length > 0 && colored('purple').some(p => p.primitive === 'sphere'), spec.parts.map(p => ({ name: p.name, color: p.color, primitive: p.primitive })));
    add('兩根白色短桿分居左右', rods.length === 2 && rods.some(p => position(p).x < 0) && rods.some(p => position(p).x > 0), rods.map(p => ({ name: p.name, x: position(p).x })));
  } else if (id === 'P06') {
    const knobs = named(/旋鈕/).filter(p => hasColor(p, 'yellow'));
    add('兩個黃色旋鈕上下排列', knobs.length === 2 && Math.abs(position(knobs[0]!).y - position(knobs[1]!).y) > 0.001, knobs.map(p => ({ name: p.name, y: position(p).y })));
    add('左側藍色把手', named(/提把|把手/).some(p => hasColor(p, 'blue') && position(p).x < 0), named(/提把|把手/).map(p => ({ name: p.name, color: p.color, x: position(p).x })));
  } else if (id === 'P07') {
    const shelves = colored('white').filter(p => p.primitive === 'box' && p.dimensions.y < Math.min(p.dimensions.x, p.dimensions.z) * 0.25);
    add('至少兩片分離白色水平板（儲物層解釋另需人工核對）', shelves.length >= 2 && Math.abs(position(shelves[0]!).y - position(shelves[1]!).y) > 0.001, shelves.map(p => ({ name: p.name, y: position(p).y })));
  } else if (id === 'P08') {
    const rings = spec.parts.filter(p => p.primitive === 'torus' && hasColor(p, 'cyan'));
    const vertical = rings.some(p => Math.abs(new Vector3(0, 0, 1).applyQuaternion(group.getObjectByName(p.id)!.getWorldQuaternion(group.quaternion.clone())).y) < 0.2);
    add('青色圓環豎直', vertical, rings.map(p => ({ name: p.name, rotation: p.rotation })));
    add('黑色方底與紅球', colored('black').some(p => p.primitive === 'box') && colored('red').some(p => p.primitive === 'sphere'), spec.parts.map(p => ({ name: p.name, color: p.color, primitive: p.primitive })));
  } else if (id === 'P09') {
    const wheels = named(/輪/);
    add('四個黑色輪子', wheels.length === 4 && wheels.every(p => hasColor(p, 'black')), wheels.map(p => ({ name: p.name, color: p.color })));
    add('黃色長方車身', colored('yellow').some(p => p.primitive === 'box'), colored('yellow').map(p => p.name));
  } else if (id === 'P10') {
    add('綠色內部電路板', named(/電路板|板/).some(p => p.role === 'interior' && hasColor(p, 'green')), named(/板/).map(p => ({ name: p.name, role: p.role, color: p.color })));
    const redCylinders = colored('red').filter(p => p.primitive === 'cylinder');
    add('兩顆紅色圓柱', redCylinders.length === 2, redCylinders.map(p => p.name));
    add('右側藍色電池盒', named(/電池/).some(p => hasColor(p, 'blue') && position(p).x > 0), named(/電池/).map(p => ({ name: p.name, color: p.color, x: position(p).x })));
  }
  return checks;
}

const startedAt = new Date().toISOString();
const selectedIds = process.env.VERIFY_CASES?.split(',').map(value => value.trim()).filter(Boolean);
if (selectedIds?.some(id => !representativePrompts.some(scenario => scenario.id === id))) throw new Error('VERIFY_CASES 包含未知案例 ID');
const scenarios = selectedIds?.length ? representativePrompts.filter(scenario => selectedIds.includes(scenario.id)) : representativePrompts;
const concurrency = Math.min(2, scenarios.length);
const timeoutMs = 180_000;
const startup = performance.now();
const provider = await createModelHost({ ...process.env, MODEL_TIMEOUT_MS: String(timeoutMs) });
const startupMs = Math.round(performance.now() - startup);
const cli = provider.name === 'codex' && provider.transport === 'exec' ? await inspectCodex({ executable: process.env.CODEX_CLI_PATH }) : null;
if (!provider.configured) throw new Error('真實模型服務尚未設定或登入；本測試不使用示範資料替代。');
const artifactDirectory = path.resolve('artifacts');
await mkdir(artifactDirectory, { recursive: true });
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const outputName = `real-provider-${localDate}.json`;
const outputFile = path.join(artifactDirectory, outputName);
let priorRuns: unknown[] = [];
try { const prior = JSON.parse(await readFile(outputFile, 'utf8')) as { runs?: unknown[] }; priorRuns = prior.runs ?? []; } catch { /* first run */ }
const results: RecordEntry[] = [];
const version = async (pkg: string) => { try { return (JSON.parse(await readFile(path.resolve('node_modules', pkg, 'package.json'), 'utf8')) as { version: string }).version; } catch { return 'unknown'; } };
const run: Record<string, unknown> = {
  startedAt, timezone: 'Asia/Taipei', provider: provider.name, selectedModel: provider.model,
  transport: provider.transport ?? 'responses', startupMs,
  cliVersion: cli?.version ?? ('cliVersion' in provider ? provider.cliVersion : null),
  timeoutMs, concurrency, cases: scenarios.map(scenario => scenario.id), generatorVersion: GENERATOR_VERSION,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, memoryGiB: Math.round(totalmem() / 1024 ** 3),
    zod: await version('zod'), three: await version('three') },
  measurement: 'provider就緒後的真實呼叫→完整schema/階層驗證→Node中建立科技透視幾何；啟動另記startupMs，不包含瀏覽器、GPU、攝影機或首幀。',
  limitations: ['自動名稱/顏色/配置初篩不能代替人工外形判讀。', 'approximation資料在此僅離線驗證；實際UI仍須使用者先確認。',
    '首個可辨識草案與完整首稿的瀏覽器時間未在本腳本量測，因此不能用此數據宣稱5秒/15秒目標通過。',
    'CLI default只代表未指定--model；未從私密使用者設定推斷實際模型。'],
  results,
};
let persistChain = Promise.resolve();
function persist() {
  persistChain = persistChain.then(async () => {
    const temporary = `${outputFile}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, runs: [...priorRuns, run] }, null, 2) + '\n');
    await rename(temporary, outputFile);
  });
  return persistChain;
}

let next = 0;
async function worker() {
  while (next < scenarios.length) {
    const scenario = scenarios[next++]!;
    const start = performance.now();
    let entry: RecordEntry;
    try {
      const design = validateDesign(await provider.generate(scenario.prompt, AbortSignal.timeout(timeoutMs)));
      if (!design.model) {
        entry = { ...scenario, requestedHumanChecks: scenario.checks, status: design.status, source: provider.name, model: provider.model,
          elapsedMs: Math.round(performance.now() - start), schemaValid: true, geometryValid: false, design };
      } else {
        const group = buildModel(design.model, hologramPart);
        try {
          group.updateMatrixWorld(true);
          const { bounds, radius } = modelBounds(group);
          const size = bounds.getSize(new Vector3());
          let meshes = 0, edges = 0, triangles = 0;
          group.traverse(object => { if (object instanceof Mesh) { meshes++; triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3; }
            if (object instanceof LineSegments) edges++; });
          const geometryValid = !new Box3().copy(bounds).isEmpty() && Number.isFinite(radius) && radius > 0 && [size.x, size.y, size.z].every(v => Number.isFinite(v) && v > 0);
          const automaticChecks = structuralChecks(scenario.id, design.model, group);
          entry = { id: scenario.id, prompt: scenario.prompt, requestedHumanChecks: scenario.checks, status: design.status,
            source: provider.name, model: provider.model, elapsedMs: Math.round(performance.now() - start), schemaValid: true,
            geometryValid, partCount: design.model.parts.length, meshes, edgeObjects: edges, triangles,
            dimensionsMetres: { x: size.x, y: size.y, z: size.z }, automaticChecks,
            automaticChecksPassed: automaticChecks.every(check => check.passed), humanSemanticReview: 'pending-browser-review',
            firstRecognizableDraftMs: null, completeBrowserDraftMs: null, requiresUserApproval: design.status === 'approximation', design };
        } finally { disposeObject(group); }
      }
    } catch (error) {
      entry = { id: scenario.id, prompt: scenario.prompt, requestedHumanChecks: scenario.checks, status: 'failed', source: provider.name,
        model: provider.model, elapsedMs: Math.round(performance.now() - start), schemaValid: false, geometryValid: false,
        error: error instanceof GenerationError ? { code: error.code, message: error.message } : { code: 'VALIDATION_OR_BUILD_FAILED', message: '資料驗證或受控幾何建立失敗；未記錄私密程序資訊。' } };
    }
    results.push(entry); results.sort((a, b) => a.id.localeCompare(b.id));
    await persist();
    console.log(JSON.stringify({ id: entry.id, status: entry.status, elapsedMs: entry.elapsedMs, parts: entry.partCount ?? 0,
      geometryValid: entry.geometryValid, automaticChecksPassed: entry.automaticChecksPassed ?? false }));
  }
}
try {
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const durations = results.filter(result => result.geometryValid === true).map(result => result.elapsedMs).sort((a, b) => a - b);
run.completedAt = new Date().toISOString();
run.summary = { attempts: results.length, validSchemaAndGeometry: durations.length, failures: results.filter(result => result.status === 'failed').length,
  observedModels: [...new Set(results.map(result => result.model))],
  automaticStructuralChecksPassed: results.filter(result => result.automaticChecksPassed === true).length,
  p95RenderableDataMs: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
  humanSemanticReview: 'pending-browser-review', firstRecognizableDraftP95Ms: null, completeBrowserDraftP95Ms: null };
await persist();
console.log(JSON.stringify({ artifact: `artifacts/${outputName}`, summary: run.summary }));
} finally { await provider.dispose?.(); }
