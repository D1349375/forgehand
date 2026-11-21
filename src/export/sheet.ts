import { MATERIALS } from '../../shared/materials';
import { BOUGHT_NOTE, CONCEPT_NOTE, materialText, STANDARD_PROBLEM_NOTE, type Bom } from './bom';
import type { ExportFinding } from './findings';
import { base64, formatCm3, formatSize, htmlEscape } from './format';

/**
 * The assembly sheet (requirements 35 to 39, design 5.3): one self-contained HTML file with
 * inline CSS, the exploded image as a `data:` URL, no script and no external resource. Every
 * name in it comes from model output, so every text value goes through `htmlEscape`.
 */

export const STEP_PROBLEM_TEXT = '這個接合有問題，孔位沒有加工，請先修正後再匯出。';
export const NO_STEPS_TEXT = '這個套件沒有接合步驟。';
export const TOLERANCE_NOTE = '公差會因印表機與線材而不同。請先列印公差測試件，再依結果調整列印設定。';

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

// A4 portrait with 15 mm margins; nothing that has a border or a number is split across pages.
const STYLE = `
@page { size: A4 portrait; margin: 15mm; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 180mm; color: #1f2933; background: #ffffff; font: 11pt/1.55 "Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif; }
h1 { margin: 0 0 2mm; font-size: 20pt; }
h2 { margin: 7mm 0 2mm; padding-bottom: 1mm; border-bottom: 1px solid #9aa5b1; font-size: 14pt; break-after: avoid; }
h3 { margin: 4mm 0 1mm; font-size: 11.5pt; break-after: avoid; }
p { margin: 1mm 0; }
.date { color: #52606d; }
img { display: block; max-width: 100%; height: auto; margin: 4mm 0; }
table { width: 100%; border-collapse: collapse; margin: 1mm 0 3mm; }
th, td { border: 1px solid #9aa5b1; padding: 1mm 2mm; text-align: left; vertical-align: top; }
th { background: #e4e7eb; }
tr, li { break-inside: avoid; }
ol, ul { margin: 1mm 0; padding-left: 7mm; }
li { margin: 1.5mm 0; }
.problem { color: #b42318; font-weight: 700; }
.note { color: #52606d; font-size: 10pt; }
`.trim();

const cell = (value: string) => `<td>${htmlEscape(value)}</td>`;
const head = (...names: string[]) => `<tr>${names.map(name => `<th>${htmlEscape(name)}</th>`).join('')}</tr>`;

const SEVERITY_TEXT: Record<ExportFinding['severity'], string> = { error: '⛔ 錯誤', warning: '⚠ 警告', info: 'ℹ 提示' };

export interface SheetInput {
  title: string;
  date: string;
  /** The exploded image (PNG), or `null` when it could not be rendered. */
  image: Uint8Array | null;
  bom: Bom;
  steps: ReadonlyArray<{ number: number; text: string; problem: boolean }>;
  findings: readonly ExportFinding[];
}

export function assemblySheetHtml(input: SheetInput): string {
  const { bom } = input;
  const body: string[] = [`<h1>${htmlEscape(input.title)}</h1>`, `<p class="date">${htmlEscape(input.date)}</p>`];
  if (input.image) body.push(`<img src="data:image/png;base64,${base64(input.image)}" alt="爆炸圖">`);

  body.push('<h2>準備</h2>');
  if (bom.pieces.length > 0) {
    body.push('<h3>列印件</h3>', '<table>', head('編號', '名稱', '材料', '數量'));
    for (const piece of bom.pieces) body.push(`<tr>${cell(piece.number)}${cell(piece.name)}${cell(materialText(piece.material))}${cell(String(piece.count))}</tr>`);
    body.push('</table>');
  }
  if (bom.machined.length > 0) {
    body.push('<h3>需加工的金屬件</h3>', '<table>', head('名稱', '材料', '尺寸 (mm)', '加工'));
    for (const row of bom.machined) {
      body.push(`<tr>${cell(row.name)}${cell(MATERIALS[row.material].label)}${cell(formatSize(row.sizeMm))}${cell(row.features.join('、'))}</tr>`);
    }
    body.push('</table>');
  }
  if (bom.bought.length > 0 || bom.standard.length > 0) {
    body.push('<h3>需要購買</h3>', '<table>', head('名稱', '尺寸 (mm)', '數量', '備註'));
    for (const row of bom.bought) body.push(`<tr>${cell(row.name)}${cell(formatSize(row.sizeMm))}${cell(String(row.count))}${cell(BOUGHT_NOTE)}</tr>`);
    for (const row of bom.standard) body.push(`<tr>${cell(row.label)}${cell('')}${cell(String(row.quantity))}${cell(row.problem ? STANDARD_PROBLEM_NOTE : '')}</tr>`);
    body.push('</table>');
  }
  if (bom.pieces.length > 0) body.push(`<p class="note">列印總體積：${formatCm3(bom.totalVolumeMm3)} cm³</p>`);
  if (bom.pieces.length === 0 && bom.machined.length === 0 && bom.bought.length === 0 && bom.standard.length === 0) body.push('<p>沒有需要準備的零件。</p>');

  body.push('<h2>組裝步驟</h2>');
  if (input.steps.length === 0) {
    body.push(`<p>${NO_STEPS_TEXT}</p>`);
  } else {
    body.push('<ol>');
    for (const step of input.steps) {
      body.push(`<li value="${step.number}">${htmlEscape(step.text)}${step.problem ? `<p class="problem">${STEP_PROBLEM_TEXT}</p>` : ''}</li>`);
    }
    body.push('</ol>');
  }

  body.push('<h2>問題</h2>');
  const problems = input.findings.filter(finding => finding.severity !== 'info');
  if (problems.length === 0) body.push('<p>沒有錯誤或警告。</p>');
  else body.push('<ul>', ...problems.map(finding => `<li>${SEVERITY_TEXT[finding.severity]}：${htmlEscape(finding.message)}</li>`), '</ul>');
  const infos = input.findings.length - problems.length;
  if (infos > 0) body.push(`<p class="note">另有 ${infos} 則提示。</p>`);

  body.push(`<p class="note">${TOLERANCE_NOTE}</p>`, `<p class="note">${CONCEPT_NOTE}</p>`);

  return [
    '<!doctype html>',
    '<html lang="zh-Hant-TW">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${htmlEscape(`組裝說明：${input.title}`)}</title>`,
    `<style>\n${STYLE}\n</style>`,
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
