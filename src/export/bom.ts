import { boughtRows, machinedRows, type BoughtRow, type MachinedRow } from '../../shared/export-plan';
import type { FeatureSet } from '../../shared/features';
import { MATERIALS, type MaterialId } from '../../shared/materials';
import type { PrinterProfile } from '../../shared/printer';
import { jointBom, type BomItem } from '../../shared/kit';
import type { Workspace } from '../../shared/workspace';
import type { ExportFinding } from './findings';
import { csvRow, formatCm3, formatSize, mdCell } from './format';

/**
 * The bill of materials (requirements 29 to 34, design 5.2): printed pieces, bought
 * components, machined parts and standard parts, as CSV and as Markdown. Pure code, runs in Node.
 */

type Vector = { x: number; y: number; z: number };

/** One unique print piece, as the BOM and the sheet need it (built by `buildPieces` in Task 3). */
export interface PieceInfo {
  /** `P01`. */
  number: string;
  name: string;
  objectId: string;
  objectName: string;
  material: MaterialId | null;
  count: number;
  /** Width, depth and height in the print frame, millimetres. */
  sizeMm: Vector;
  /** Volume of one copy, mm³. */
  volumeMm3: number;
  /** `stl/P01-housing.stl`. */
  file: string;
  /** Names of the parts fused into the piece. */
  partNames: string[];
}

export interface StandardRow extends BomItem {
  /** Step numbers of the joints that use the item, ascending. */
  steps: number[];
  /** A joint that uses the item has an error, so its features were not cut. */
  problem: boolean;
}

export interface Bom {
  pieces: PieceInfo[];
  bought: BoughtRow[];
  machined: MachinedRow[];
  standard: StandardRow[];
  totalVolumeMm3: number;
}

export const NO_MATERIAL_TEXT = '未指定（以 PLA 估）';
export const BOUGHT_NOTE = '概念尺寸，購買前請確認型號與尺寸。';
export const STANDARD_PROBLEM_NOTE = '接合有問題，請先修正。';
export const CONCEPT_NOTE = '概念設計：尺寸與數量請在列印與購買前確認。';

export const materialText = (material: MaterialId | null): string => (material === null ? NO_MATERIAL_TEXT : MATERIALS[material].label);

/**
 * Collects the BOM. `standard` is `jointBom` unchanged, with the steps of the joints that use
 * each item and a `problem` flag when one of them is in `skipped` (requirement 32). `scoped` is
 * the scoped workspace; `pieces` come from `buildPieces`.
 */
export function buildBom(
  scoped: Workspace, profile: PrinterProfile, pieces: readonly PieceInfo[], features: FeatureSet,
  skipped: ReadonlySet<string>, steps: ReadonlyMap<string, number>,
): Bom {
  const standard = jointBom(scoped, profile, features).map<StandardRow>(item => ({
    ...item,
    steps: item.jointIds.flatMap(id => steps.get(id) ?? []).sort((x, y) => x - y),
    problem: item.jointIds.some(id => skipped.has(id)),
  }));
  return {
    pieces: [...pieces],
    bought: boughtRows(scoped),
    machined: machinedRows(scoped, features),
    standard,
    totalVolumeMm3: pieces.reduce((sum, piece) => sum + piece.volumeMm3 * piece.count, 0),
  };
}

const LIST_SEPARATOR = '、';

const CSV_HEADER = ['類別', '編號', '名稱', '物件', '材料', '尺寸 (mm)', '數量', '單件體積 (cm³)', '檔案', '包含零件', '用於步驟', '備註'] as const;

/**
 * `bom.csv` (requirement 33): a byte-order mark, a header row and one row per entry, CRLF line
 * ends. `csvField` quotes fields and keeps spreadsheets from reading names as formulas.
 */
export function bomCsv(bom: Bom): string {
  const blank = '';
  let out = '\uFEFF' + csvRow(CSV_HEADER);
  for (const piece of bom.pieces) {
    out += csvRow([
      '列印件', piece.number, piece.name, piece.objectName, materialText(piece.material), formatSize(piece.sizeMm),
      String(piece.count), formatCm3(piece.volumeMm3), piece.file, piece.partNames.join(LIST_SEPARATOR), blank, blank,
    ]);
  }
  for (const row of bom.bought) {
    out += csvRow(['外購件', blank, row.name, row.objectNames.join(LIST_SEPARATOR), blank, formatSize(row.sizeMm), String(row.count), blank, blank, blank, blank, BOUGHT_NOTE]);
  }
  for (const row of bom.machined) {
    out += csvRow([
      '加工件', blank, row.name, row.objectName, MATERIALS[row.material].label, formatSize(row.sizeMm), '1', blank, blank, blank, blank,
      row.features.join(LIST_SEPARATOR),
    ]);
  }
  for (const row of bom.standard) {
    out += csvRow([
      '標準件', blank, row.label, blank, blank, blank, String(row.quantity), blank, blank, blank, row.steps.join(LIST_SEPARATOR),
      row.problem ? STANDARD_PROBLEM_NOTE : blank,
    ]);
  }
  return out;
}

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  `| ${headers.map(mdCell).join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(mdCell).join(' | ')} |`),
  '',
];

const SEVERITY_LINE: Record<ExportFinding['severity'], string> = { error: '⛔ 錯誤', warning: '⚠ 警告', info: 'ℹ 提示' };

/**
 * `bom.md` (requirement 34): title, date, the concept note, one table per category (an empty
 * category is left out), the total printed volume and the problems. Each table lists the
 * columns of `bom.csv` that its category uses. Every cell goes through `mdCell`.
 */
export function bomMarkdown(bom: Bom, findings: readonly ExportFinding[], meta: { title: string; date: string }): string {
  const lines: string[] = ['# 材料清單（BOM）', '', mdCell(meta.title), '', `日期：${mdCell(meta.date)}`, '', `> ${CONCEPT_NOTE}`, ''];
  if (bom.pieces.length > 0) {
    lines.push('## 列印件', '');
    lines.push(...table(
      ['編號', '名稱', '物件', '材料', '尺寸 (mm)', '數量', '單件體積 (cm³)', '檔案', '包含零件'],
      bom.pieces.map(piece => [
        piece.number, piece.name, piece.objectName, materialText(piece.material), formatSize(piece.sizeMm), String(piece.count),
        formatCm3(piece.volumeMm3), piece.file, piece.partNames.join(LIST_SEPARATOR),
      ]),
    ));
    lines.push(`列印總體積：${formatCm3(bom.totalVolumeMm3)} cm³`, '');
  }
  if (bom.bought.length > 0) {
    lines.push('## 外購件', '');
    lines.push(...table(
      ['名稱', '物件', '尺寸 (mm)', '數量', '備註'],
      bom.bought.map(row => [row.name, row.objectNames.join(LIST_SEPARATOR), formatSize(row.sizeMm), String(row.count), BOUGHT_NOTE]),
    ));
  }
  if (bom.machined.length > 0) {
    lines.push('## 加工件', '');
    lines.push(...table(
      ['名稱', '物件', '材料', '尺寸 (mm)', '加工'],
      bom.machined.map(row => [row.name, row.objectName, MATERIALS[row.material].label, formatSize(row.sizeMm), row.features.join(LIST_SEPARATOR)]),
    ));
  }
  if (bom.standard.length > 0) {
    lines.push('## 標準件', '');
    lines.push(...table(
      ['名稱', '數量', '用於步驟', '備註'],
      bom.standard.map(row => [row.label, String(row.quantity), row.steps.join(LIST_SEPARATOR), row.problem ? STANDARD_PROBLEM_NOTE : '']),
    ));
  }
  lines.push('## 問題', '');
  const problems = findings.filter(finding => finding.severity !== 'info');
  if (problems.length === 0) lines.push('沒有錯誤或警告。');
  for (const finding of problems) lines.push(`- ${SEVERITY_LINE[finding.severity]}：${mdCell(finding.message)}`);
  const infos = findings.length - problems.length;
  if (infos > 0) lines.push('', `另有 ${infos} 則提示。`);
  lines.push('');
  return lines.join('\n');
}
