import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasCjk } from '../../shared/i18n/format';
import { ROOT, TABLE_FILES, filesUnder } from './i18n-files';

/**
 * english-ui R48 (design 3.7, decision 9): finds Chinese text that sits outside the string tables.
 * Report mode until the last english-ui task: the test prints the list and passes. Task 6 sets STRICT to true.
 */
const STRICT: boolean = false;

/**
 * Lines that may keep Chinese text, as exact `file` + `substring` pairs, each with a one-line reason.
 * Expected to stay empty: internal texts are English (R57).
 */
export const SCAN_ALLOWED: readonly { file: string; substring: string; reason: string }[] = [];

export interface StrayLine { file: string; line: number; text: string }

const isCommentOnly = (trimmed: string): boolean =>
  trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('/**');

/**
 * The lines of one file that have a CJK character and are not comment-only lines. A code line with a
 * trailing Chinese comment counts: move the comment to its own line.
 */
export function strayLines(file: string, source: string): StrayLine[] {
  const found: StrayLine[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    const trimmed = text.trim();
    if (!hasCjk(trimmed) || isCommentOnly(trimmed)) return;
    if (SCAN_ALLOWED.some(allowed => allowed.file === file && trimmed.includes(allowed.substring))) return;
    found.push({ file, line: index + 1, text: trimmed });
  });
  return found;
}

/** The files to scan: every .ts, .tsx and .html file under src/, shared/ and server/, and index.html, except the table files. */
export function scanFiles(): string[] {
  const tables = new Set(TABLE_FILES);
  return [
    ...['src', 'shared', 'server'].flatMap(folder => filesUnder(folder, ['.ts', '.tsx', '.html'])),
    ...(existsSync(join(ROOT, 'index.html')) ? ['index.html'] : []),
  ].filter(file => !tables.has(file));
}

const layerOf = (file: string): string => (file.startsWith('src/') ? 'src/' : file.startsWith('shared/') ? 'shared/' : file.startsWith('server/') ? 'server/' : 'root');

describe('stray-string scan (R48, report mode until task 6)', () => {
  it('reads comment-only lines as comments and everything else as code', () => {
    const source = [
      '// 這是註解',
      '  /* 這也是註解 */',
      '/**',
      ' * 說明文字',
      ' */',
      "const a = '外殼';",
      "const b = 1; // 後面的註解算一行",
      'const c = "plain";',
      '<h1>標題</h1>',
    ].join('\n');
    expect(strayLines('x.ts', source).map(line => [line.line, line.text])).toEqual([
      [6, "const a = '外殼';"],
      [7, 'const b = 1; // 後面的註解算一行'],
      [9, '<h1>標題</h1>'],
    ]);
    expect(strayLines('x.ts', 'a\r\nb 外\r\n')).toEqual([{ file: 'x.ts', line: 2, text: 'b 外' }]);
  });

  it('skips the table files and picks up files of the three layers', () => {
    const files = scanFiles();
    for (const table of TABLE_FILES) expect(files).not.toContain(table);
    expect(files.some(file => file.startsWith('src/'))).toBe(true);
    expect(files.some(file => file.startsWith('shared/'))).toBe(true);
    expect(files.some(file => file.startsWith('server/'))).toBe(true);
    expect(files).toContain('index.html');
    expect(files.some(file => file.startsWith('node_modules/') || file.startsWith('tests/'))).toBe(false);
  });

  it('lists every file that still has Chinese text outside the tables', () => {
    const strays = scanFiles().flatMap(file => strayLines(file, readFileSync(join(ROOT, file), 'utf8')));
    const perFile = new Map<string, number>();
    for (const stray of strays) perFile.set(stray.file, (perFile.get(stray.file) ?? 0) + 1);
    const perLayer = new Map<string, { lines: number; files: number }>();
    for (const [file, lines] of perFile) {
      const layer = layerOf(file);
      const entry = perLayer.get(layer) ?? { lines: 0, files: 0 };
      perLayer.set(layer, { lines: entry.lines + lines, files: entry.files + 1 });
    }
    const report = [
      `i18n stray-string scan (${STRICT ? 'strict' : 'report mode'}): ${strays.length} lines in ${perFile.size} files`,
      ...[...perLayer].sort().map(([layer, entry]) => `  ${layer} ${entry.lines} lines in ${entry.files} files`),
      ...[...perFile].sort().map(([file, lines]) => `  ${file}: ${lines}`),
    ].join('\n');
    console.info(report);
    if (STRICT) expect(strays.map(stray => `${stray.file}:${stray.line}`)).toEqual([]);
    else expect(strays.length).toBeGreaterThanOrEqual(0);
  });
});
