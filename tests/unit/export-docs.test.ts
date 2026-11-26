import { describe, expect, it } from 'vitest';
import { scopeWorkspace, stepNumbers } from '../../shared/export-plan';
import { jointFeatures } from '../../shared/features';
import { checkJoints, type Finding } from '../../shared/joint-rules';
import { assemblyNotes } from '../../shared/kit';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import { setMaterial, type Workspace } from '../../shared/workspace';
import { BOUGHT_NOTE, buildBom, bomCsv, bomMarkdown } from '../../src/export/bom';
import {
  EXPORT_MESSAGES, EXPORT_SEVERITY, classFindings, exportMessage, featuresSkippedJoints, jointFindings, sortFindings,
  unconfirmedFindings, type ExportFinding, type ExportFindingCode,
} from '../../src/export/findings';
import { problemBanner } from '../../src/export/dialog-model';
import { base64 } from '../../src/export/format';
import { NO_STEPS_TEXT, STEP_PROBLEM_TEXT, TOLERANCE_NOTE, assemblySheetHtml } from '../../src/export/sheet';
import {
  HOSTILE_NAME, demoPairWithScrew, demoPieces, hostileWorkspace, interiorPartWorkspace, metalPair, pieceInfo,
} from '../fixtures/export-workspace';

const PROFILE = DEFAULT_PRINTER_PROFILE;
const WHOLE = { scope: 'workspace', objectId: null } as const;

/** Everything the documents are built from, for a workspace. */
function kit(ws: Workspace, pieces = demoPieces()) {
  const scoped = scopeWorkspace(ws, WHOLE);
  const features = jointFeatures(scoped, PROFILE);
  const found = checkJoints(scoped, PROFILE, features);
  const steps = stepNumbers(scoped, PROFILE, features);
  const skipped = featuresSkippedJoints(found);
  const bom = buildBom(scoped, PROFILE, pieces, features, skipped, steps);
  const findings = sortFindings([...jointFindings(scoped, found, steps), ...unconfirmedFindings(scoped, steps), ...classFindings(scoped)]);
  return { scoped, features, found, steps, skipped, bom, findings };
}

const finding = (overrides: Partial<ExportFinding>): ExportFinding => ({
  severity: 'warning', code: 'LOOSE_PIECE', source: 'export', message: 'm', jointId: null, step: null, piece: null, ...overrides,
});

describe('export findings', () => {
  it('has the exact messages and severities of requirement 16', () => {
    const params = { piece: 'P01 外殼', a: '電池', b: '外殼', method: '磁鐵', part: '主板', n: 42 };
    const expected: Record<ExportFindingCode, [string, string]> = {
      PIECE_FAILED: ['error', '「P01 外殼」無法產生列印檔，已略過。'],
      FEATURES_SKIPPED: ['warning', '接合「電池」↔「外殼」有問題，孔位沒有加工。'],
      JOINT_UNCONFIRMED: ['warning', '接合「電池」↔「外殼」尚未確認，先以「磁鐵」匯出。'],
      JOINT_FUSED: ['warning', '接合「電池」↔「外殼」的兩個零件會連成同一個列印件，孔位沒有加工。'],
      JOINT_OVERLAP: ['warning', '接合「電池」↔「外殼」的兩個零件重疊 42 mm³，印出後無法組合。'],
      COMPONENT_BLOCKED: ['warning', '外購件「主板」和「P01 外殼」重疊，印出後放不進去。'],
      COMPONENT_SEALED: ['warning', '外購件「主板」被封在「P01 外殼」裡面，需要在列印中途放入，或把外殼分成殼體和上蓋。'],
      LOOSE_PIECE: ['warning', '「P01 外殼」沒有和其他零件相連或接合，組裝時需要另外固定。'],
      TOO_LARGE: ['warning', '「P01 外殼」最長 42 mm，可能超過一般印表機的列印範圍。'],
      BOUGHT: ['info', '「主板」是外購件，不會產生列印檔。'],
      MACHINED: ['info', '「主板」是金屬件，需另行加工，不會產生列印檔。'],
      FUSED: ['info', '「P01 外殼」由 42 個相連的零件合併而成。'],
    };
    expect(Object.keys(EXPORT_MESSAGES).sort()).toEqual(Object.keys(expected).sort());
    for (const [code, [severity, message]] of Object.entries(expected) as Array<[ExportFindingCode, [string, string]]>) {
      expect(EXPORT_SEVERITY[code], code).toBe(severity);
      expect(exportMessage(code, params), code).toBe(message);
    }
  });

  it('turns checkJoints output into findings with a step prefix', () => {
    const { scoped, found, steps } = kit(demoPairWithScrew({ touching: false }));
    const list = jointFindings(scoped, found, steps);
    expect(list).toEqual([
      { severity: 'error', code: 'APART', source: 'joint', message: '步驟 1：已分開，可按「重新對齊」。', jointId: 'joint-1', step: 1, piece: null },
      { severity: 'info', code: 'NO_MATERIAL', source: 'joint', message: '步驟 1：未指定材料，先以一般 FDM 塑膠估算。', jointId: 'joint-1', step: 1, piece: null },
    ]);
  });

  it('prefixes a joint without a step with its label', () => {
    const { scoped } = kit(demoPairWithScrew());
    const map = new Map<string, Finding[]>([['joint-1', [{ jointId: 'joint-1', severity: 'error', code: 'NO_FACE', message: 'x' }]]]);
    expect(jointFindings(scoped, map, new Map())[0]!.message).toBe('「雙鏡頭概念裝置・外殼」↔「雙鏡頭概念裝置・外殼」：x');
  });

  it('reports every unconfirmed joint with its method', () => {
    const { scoped, steps } = kit(demoPairWithScrew({ confirmed: false }));
    expect(unconfirmedFindings(scoped, steps)).toEqual([{
      severity: 'warning', code: 'JOINT_UNCONFIRMED', source: 'export', jointId: 'joint-1', step: 1, piece: null,
      message: '接合「雙鏡頭概念裝置・外殼」↔「雙鏡頭概念裝置・外殼」尚未確認，先以「熱壓螺母＋螺絲」匯出。',
    }]);
    expect(unconfirmedFindings(kit(demoPairWithScrew()).scoped, steps)).toEqual([]);
  });

  it('reports bought and machined parts, qualified by object only when there are several', () => {
    const single = classFindings(scopeWorkspace(interiorPartWorkspace(), WHOLE));
    expect(single.map(item => [item.code, item.severity, item.message])).toEqual([['BOUGHT', 'info', '「cell」是外購件，不會產生列印檔。']]);
    const metal = classFindings(scopeWorkspace(setMaterial(interiorPartWorkspace(), 'casing', 'steel'), WHOLE));
    expect(metal.map(item => item.code)).toEqual(['MACHINED', 'BOUGHT']);
    expect(metal[0]!.message).toBe('「shell」是金屬件，需另行加工，不會產生列印檔。');
    const pair = classFindings(kit(demoPairWithScrew()).scoped);
    expect(pair.map(item => item.message)).toEqual([
      '「雙鏡頭概念裝置・內部電路概念件」是外購件，不會產生列印檔。',
      '「雙鏡頭概念裝置・內部電路概念件」是外購件，不會產生列印檔。',
    ]);
  });

  it('skips the features of joints with an error finding only', () => {
    const apart = kit(demoPairWithScrew({ touching: false }));
    expect([...featuresSkippedJoints(apart.found)]).toEqual(['joint-1']);
    expect(featuresSkippedJoints(kit(demoPairWithScrew()).found).size).toBe(0);
  });

  it('sorts by severity, code, step and piece, with null last, whatever the input order', () => {
    const list = [
      finding({ severity: 'info', code: 'FUSED', piece: 'P01' }),
      finding({ severity: 'warning', code: 'TOO_LARGE', piece: 'P02' }),
      finding({ severity: 'warning', code: 'TOO_LARGE', piece: 'P01' }),
      finding({ severity: 'warning', code: 'TOO_LARGE', piece: null }),
      finding({ severity: 'warning', code: 'JOINT_FUSED', step: 2 }),
      finding({ severity: 'warning', code: 'JOINT_FUSED', step: 1 }),
      finding({ severity: 'warning', code: 'JOINT_FUSED', step: null }),
      finding({ severity: 'error', code: 'PIECE_FAILED', piece: 'P03' }),
      finding({ severity: 'error', code: 'APART', source: 'joint', step: 1 }),
    ];
    const key = (item: ExportFinding) => `${item.severity}/${item.code}/${item.step ?? '-'}/${item.piece ?? '-'}`;
    const expected = [
      'error/APART/1/-', 'error/PIECE_FAILED/-/P03',
      'warning/JOINT_FUSED/1/-', 'warning/JOINT_FUSED/2/-', 'warning/JOINT_FUSED/-/-',
      'warning/TOO_LARGE/-/P01', 'warning/TOO_LARGE/-/P02', 'warning/TOO_LARGE/-/-',
      'info/FUSED/-/P01',
    ];
    expect(sortFindings(list).map(key)).toEqual(expected);
    expect(sortFindings([...list].reverse()).map(key)).toEqual(expected);
    expect(list).toHaveLength(9); // the input is not changed
  });
});

describe('COMPONENT_SEALED (design-fidelity requirement 10)', () => {
  const sealed = finding({
    code: 'COMPONENT_SEALED', piece: 'P01', message: exportMessage('COMPONENT_SEALED', { part: '主板', piece: '外殼' }),
  });
  it('is a warning that sorts right after COMPONENT_BLOCKED', () => {
    const list = [
      finding({ code: 'LOOSE_PIECE', piece: 'P01' }), sealed, finding({ code: 'COMPONENT_BLOCKED', piece: 'P01' }),
      finding({ code: 'FEATURES_SKIPPED' }),
    ];
    expect(sortFindings(list).map(item => item.code)).toEqual(['COMPONENT_BLOCKED', 'COMPONENT_SEALED', 'FEATURES_SKIPPED', 'LOOSE_PIECE']);
    expect(EXPORT_SEVERITY.COMPONENT_SEALED).toBe('warning');
  });
  it('shows in bom.md and the assembly sheet like every finding', () => {
    const { bom } = kit(demoPairWithScrew());
    const message = '外購件「主板」被封在「外殼」裡面，需要在列印中途放入，或把外殼分成殼體和上蓋。';
    expect(bomMarkdown(bom, [sealed], META)).toContain(`- ⚠ 警告：${message}`);
    expect(assemblySheetHtml({ title: META.title, date: META.date, image: null, bom, steps: [], findings: [sealed] })).toContain(message);
  });
  it('never blocks: the dialog counts it as a problem and still lets the export go on', () => {
    expect(problemBanner([sealed])).toBe('有 1 個問題，仍可繼續匯出。');
  });
});
describe('buildBom', () => {
  it('reads the standard parts from jointBom with their steps, and totals the volume over copies', () => {
    const { bom } = kit(demoPairWithScrew());
    expect(bom.standard.map(row => [row.label, row.quantity, row.steps, row.problem])).toEqual([
      ['M3×8 內六角螺絲（ISO 4762）', 1, [1], false],
      ['M3×5.7 熱壓螺母（CNC Kitchen）', 1, [1], false],
    ]);
    expect(bom.pieces).toEqual(demoPieces());
    expect(bom.totalVolumeMm3).toBeCloseTo(2 * 412_300 + 2 * 118_900, 6);
    expect(bom.bought.map(row => [row.name, row.count])).toEqual([['內部電路概念件', 2]]);
    expect(bom.machined).toEqual([]);
  });

  it('flags the items of a joint whose features were skipped', () => {
    const { bom } = kit(demoPairWithScrew({ touching: false }));
    expect(bom.standard.length).toBeGreaterThan(0);
    expect(bom.standard.every(row => row.problem)).toBe(true);
  });

  it('lists machined parts with their features', () => {
    const { bom } = kit(metalPair(), []);
    expect(bom.machined.map(row => [row.name, row.features])).toEqual([['body', ['M3 攻牙孔 ×2']]]);
    expect(bom.totalVolumeMm3).toBe(0);
  });
});

/** A small RFC 4180 reader for the tests. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += char;
  }
  expect(field).toBe('');
  expect(row).toEqual([]);
  return rows;
}

describe('bomCsv', () => {
  const HEADER = ['類別', '編號', '名稱', '物件', '材料', '尺寸 (mm)', '數量', '單件體積 (cm³)', '檔案', '包含零件', '用於步驟', '備註'];

  it('starts with the byte-order mark and the header, uses CRLF, and has one row per entry', () => {
    const csv = bomCsv(kit(demoPairWithScrew()).bom);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const rows = parseCsv(csv.slice(1));
    expect(rows[0]).toEqual(HEADER);
    expect(rows.every(row => row.length === HEADER.length)).toBe(true);
    expect(rows.slice(1)).toEqual([
      ['列印件', 'P01', '外殼（含 6 個零件）', '雙鏡頭概念裝置', 'PLA', '160.0 × 70.0 × 90.0', '2', '412.3', 'stl/P01-housing.stl', '外殼、鏡筒 1、鏡片 1、鏡筒 2、鏡片 2、側邊電池', '', ''],
      ['列印件', 'P02', '展示底座（含 2 個零件）', '雙鏡頭概念裝置', 'PLA', '130.0 × 100.0 × 87.0', '2', '118.9', 'stl/P02-base.stl', '展示底座、展示支架', '', ''],
      ['外購件', '', '內部電路概念件', '雙鏡頭概念裝置', '', '120.0 × 4.0 × 45.0', '2', '', '', '', '', BOUGHT_NOTE],
      ['標準件', '', 'M3×8 內六角螺絲（ISO 4762）', '', '', '', '1', '', '', '', '1', ''],
      ['標準件', '', 'M3×5.7 熱壓螺母（CNC Kitchen）', '', '', '', '1', '', '', '', '1', ''],
    ]);
  });

  it('writes machined parts, the unset material text and the problem note', () => {
    const rows = parseCsv(bomCsv(kit(metalPair(), [pieceInfo({ material: null })]).bom).slice(1));
    expect(rows[1]![4]).toBe('未指定（以 PLA 估）');
    expect(rows.find(row => row[0] === '加工件')).toEqual(['加工件', '', 'body', 'Block A', '鋁', '40.0 × 20.0 × 30.0', '1', '', '', '', '', 'M3 攻牙孔 ×2']);
    const apart = parseCsv(bomCsv(kit(demoPairWithScrew({ touching: false })).bom).slice(1)).filter(row => row[0] === '標準件');
    expect(apart.length).toBeGreaterThan(0);
    expect(apart.every(row => row[11] === '接合有問題，請先修正。')).toBe(true);
  });

  it('quotes fields and guards formulas, so a hostile name never runs as a formula', () => {
    const pieces = [
      pieceInfo({ name: HOSTILE_NAME, objectName: 'a, "b"\nc', partNames: ['=1+1', '+x', '-x', '@x', '\tx'] }),
      pieceInfo({ number: 'P02', name: '-5', file: 'stl/P02-x.stl' }),
    ];
    const csv = bomCsv(kit(hostileWorkspace(), pieces).bom);
    const rows = parseCsv(csv.slice(1));
    expect(rows[1]![2]).toBe(`'${HOSTILE_NAME}`);
    expect(rows[1]![3]).toBe('a, "b"\nc');
    expect(rows[1]![9]).toBe("'=1+1、+x、-x、@x、\tx");
    expect(rows[2]![2]).toBe("'-5");
    // Every name field in the table is guarded, wherever it came from.
    for (const row of rows.slice(1)) for (const value of row) expect(value, value).not.toMatch(/^[=+\-@\t\r]/);
    // The separator between list items is not a formula start, but each item inside a list stays readable.
    expect(csv).toContain(`'${HOSTILE_NAME}`);
  });

  it('is deterministic', () => {
    expect(bomCsv(kit(demoPairWithScrew()).bom)).toBe(bomCsv(kit(demoPairWithScrew()).bom));
  });
});

const META = { title: '雙鏡頭概念裝置、雙鏡頭概念裝置', date: '2026-11-21 10:00' };

describe('bomMarkdown', () => {
  it('has a title, the date, the concept note, a table per non-empty category and the total volume', () => {
    const { bom, findings } = kit(demoPairWithScrew());
    const md = bomMarkdown(bom, findings, META);
    expect(md.split('\n').slice(0, 8)).toEqual([
      '# 材料清單（BOM）', '', '雙鏡頭概念裝置、雙鏡頭概念裝置', '', '日期：2026-11-21 10:00', '', '> 概念設計：尺寸與數量請在列印與購買前確認。', '',
    ]);
    expect(md).toContain('## 列印件');
    expect(md).toContain('## 外購件');
    expect(md).toContain('## 標準件');
    expect(md).not.toContain('## 加工件');
    expect(md).toContain('| P01 | 外殼（含 6 個零件） | 雙鏡頭概念裝置 | PLA | 160.0 × 70.0 × 90.0 | 2 | 412.3 | stl/P01-housing.stl |');
    expect(md).toContain('列印總體積：1062.4 cm³');
    expect(md).toContain('## 問題\n\n沒有錯誤或警告。\n\n另有 3 則提示。');
  });

  it('leaves out the printed category when nothing is printed, and lists machined parts', () => {
    const { bom, findings } = kit(metalPair(), []);
    const md = bomMarkdown(bom, findings, META);
    expect(md).not.toContain('## 列印件');
    expect(md).not.toContain('列印總體積');
    expect(md).toContain('## 加工件');
    expect(md).toContain('| body | Block A | 鋁 | 40.0 × 20.0 × 30.0 | M3 攻牙孔 ×2 |');
  });

  it('lists errors and warnings under 問題 with their severity word', () => {
    const { bom, findings } = kit(demoPairWithScrew({ touching: false, confirmed: false }));
    const md = bomMarkdown(bom, findings, META);
    expect(md).toContain('- ⛔ 錯誤：步驟 1：已分開，可按「重新對齊」。');
    expect(md).toContain('- ⚠ 警告：接合「雙鏡頭概念裝置・外殼」↔「雙鏡頭概念裝置・外殼」尚未確認，先以「熱壓螺母＋螺絲」匯出。');
    expect(md).not.toContain('沒有錯誤或警告。');
  });

  it('escapes names so a table row keeps its columns and no markup gets through', () => {
    const pieces = [pieceInfo({ name: HOSTILE_NAME, objectName: '<b>x</b>\nline', partNames: ['a|b', '[x](http://evil)', '*bold*', '`code`'] })];
    const { bom, findings } = kit(hostileWorkspace(), pieces);
    const md = bomMarkdown(bom, findings, { title: HOSTILE_NAME, date: '2026-11-21 10:00' });
    const unescapedPipes = (line: string) => (line.match(/(?<!\\)\|/g) ?? []).length;
    const tableLines = md.split('\n').filter(line => line.startsWith('|'));
    expect(tableLines.length).toBeGreaterThan(0);
    // Each table has a constant number of cell separators on every line.
    const byTable = new Map<number, number[]>();
    let table = 0;
    for (const line of md.split('\n')) {
      if (!line.startsWith('|')) { table++; continue; }
      byTable.set(table, [...(byTable.get(table) ?? []), unescapedPipes(line)]);
    }
    for (const counts of byTable.values()) expect(new Set(counts).size).toBe(1);
    expect(md).not.toContain('<script');
    expect(md).not.toContain('<b>');
    expect(md).toContain('\\[x\\](http://evil)'); // the brackets are escaped, so it renders as plain text
    expect(md).toContain('&lt;script&gt;');
    // No raw line break from a name splits a row.
    expect(md).toContain('&lt;b&gt;x&lt;/b&gt; line');
  });
});

const IMAGE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function sheet(ws: Workspace, image: Uint8Array | null = IMAGE, pieces = demoPieces(), title = META.title): string {
  const { bom, findings, scoped, features, steps, found } = kit(ws, pieces);
  const problems = featuresSkippedJoints(found);
  const list = assemblyNotes(scoped, PROFILE, features).map(note => ({
    number: steps.get(note.jointId)!, text: note.text, problem: problems.has(note.jointId),
  }));
  return assemblySheetHtml({ title, date: META.date, image, bom, steps: list, findings });
}

describe('assemblySheetHtml', () => {
  it('is self-contained: a CSP, inline style, no script and no external resource', () => {
    const html = sheet(demoPairWithScrew());
    expect(html.startsWith('<!doctype html>\n<html lang="zh-Hant-TW">')).toBe(true);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*"(?!data:)/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('@page { size: A4 portrait; margin: 15mm; }');
    expect(html).toContain('<title>組裝說明：雙鏡頭概念裝置、雙鏡頭概念裝置</title>');
  });

  it('embeds the image as a data URL, or leaves it out', () => {
    expect(sheet(demoPairWithScrew())).toContain(`<img src="data:image/png;base64,${base64(IMAGE)}" alt="爆炸圖">`);
    expect(sheet(demoPairWithScrew(), null)).not.toContain('<img');
  });

  it('lists the preparation, the numbered steps in order, the problems and the two notes', () => {
    const html = sheet(demoPairWithScrew());
    const order = ['<h1>', '<img', '<h2>準備</h2>', '<h2>組裝步驟</h2>', '<h2>問題</h2>', TOLERANCE_NOTE, '概念設計：尺寸與數量請在列印與購買前確認。']
      .map(part => html.indexOf(part));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html).toContain('<tr><td>P01</td><td>外殼（含 6 個零件）</td><td>PLA</td><td>2</td></tr>');
    expect(html).toContain('<tr><td>內部電路概念件</td><td>120.0 × 4.0 × 45.0</td><td>2</td><td>概念尺寸，購買前請確認型號與尺寸。</td></tr>');
    expect(html).toContain('M3×8 內六角螺絲（ISO 4762）');
    expect(html).toMatch(/<li value="1">先用烙鐵把 1 顆 M3 熱壓螺母壓入「雙鏡頭概念裝置・外殼」，再用 1 支 M3×8 螺絲從「雙鏡頭概念裝置・外殼」鎖上。<\/li>/);
    expect(html).not.toContain(STEP_PROBLEM_TEXT);
    expect(html).toContain('<p>沒有錯誤或警告。</p>');
    expect(html).toContain('<p class="note">另有 3 則提示。</p>');
    expect(html).toContain('列印總體積：1062.4 cm³');
  });

  it('adds the problem line to a step whose joint has an error, and lists the finding', () => {
    const html = sheet(demoPairWithScrew({ touching: false }));
    expect(html).toContain(`<p class="problem">${STEP_PROBLEM_TEXT}</p>`);
    expect(html).toContain('<li>⛔ 錯誤：步驟 1：已分開，可按「重新對齊」。</li>');
  });

  it('says there are no steps for a kit without joints, and lists machined parts', () => {
    const html = sheet(setMaterial(interiorPartWorkspace(), 'casing', 'aluminium'), IMAGE, []);
    expect(html).toContain(`<p>${NO_STEPS_TEXT}</p>`);
    expect(html).not.toContain('<ol>');
    expect(html).toContain('<h3>需加工的金屬件</h3>');
    expect(html).not.toContain('<h3>列印件</h3>');
  });

  it('escapes every name, so a hostile part name injects nothing', () => {
    const pieces = [pieceInfo({ name: HOSTILE_NAME, objectName: HOSTILE_NAME, partNames: [HOSTILE_NAME] })];
    const html = sheet(hostileWorkspace(), IMAGE, pieces, HOSTILE_NAME);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#39;');
    // Hostile text appears as the title, a table cell, the step text and the findings, all escaped.
    expect(html.match(/&lt;script&gt;/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic', () => {
    expect(sheet(demoPairWithScrew())).toBe(sheet(demoPairWithScrew()));
  });
});
