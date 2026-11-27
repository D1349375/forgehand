import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasCjk } from '../../shared/i18n/format';
import { ROOT, TABLE_FILES, filesUnder } from './i18n-files';
import { SCAN_BASELINE } from './i18n-scan-baseline';

/**
 * english-ui R48 (design 3.7, decision 9): finds Chinese text that sits outside the string tables.
 * Until the last english-ui task the scan is strict for NEW Chinese text only (decision 9 (b)): each file may keep the number of
 * stray lines in `SCAN_BASELINE` (tests/unit/i18n-scan-baseline.ts) and no more, and a file that is not listed may have none.
 * Tasks 3 to 5 lower the entries as they move strings into tables. Task 6 sets STRICT to true: every count must then be 0,
 * and the baseline file is deleted. The test always prints the report.
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

/** What the comparison with the baseline found: `failures` fail the test, `reminders` are printed. Both are sorted by file path. */
export interface BaselineCheck { failures: string[]; reminders: string[] }

const BASELINE_FILE = 'tests/unit/i18n-scan-baseline.ts';

/**
 * Compares the stray-line count of each file with its baseline. A file above its baseline fails; so does a file that is not
 * in the baseline (baseline 0) and has any stray line. A count below the baseline passes with a reminder to lower the entry.
 */
export function checkAgainstBaseline(counts: ReadonlyMap<string, number>, baseline: Readonly<Record<string, number>>): BaselineCheck {
  const baselineOf = (file: string): number => (Object.hasOwn(baseline, file) ? baseline[file]! : 0);
  const files = [...new Set([...counts.keys(), ...Object.keys(baseline)])].sort();
  const failures: string[] = [];
  const reminders: string[] = [];
  for (const file of files) {
    const count = counts.get(file) ?? 0;
    const allowed = baselineOf(file);
    const listed = Object.hasOwn(baseline, file);
    if (count > allowed) {
      failures.push(`${file}: ${count} stray lines, baseline ${allowed}${listed ? '' : ' (not in the baseline)'}`);
    } else if (count < allowed) {
      reminders.push(`${file}: ${count} stray lines now, baseline ${allowed}. Lower the entry in ${BASELINE_FILE}${count === 0 ? ' (or delete it)' : ''}.`);
    }
  }
  return { failures, reminders };
}

const layerOf = (file: string): string => (file.startsWith('src/') ? 'src/' : file.startsWith('shared/') ? 'shared/' : file.startsWith('server/') ? 'server/' : 'root');

describe('stray-string scan (R48, per-file baseline until task 6)', () => {
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

  it('allows no more Chinese text outside the tables than the baseline, and lists what is left', () => {
    const strays = scanFiles().flatMap(file => strayLines(file, readFileSync(join(ROOT, file), 'utf8')));
    const perFile = new Map<string, number>();
    for (const stray of strays) perFile.set(stray.file, (perFile.get(stray.file) ?? 0) + 1);
    const perLayer = new Map<string, { lines: number; files: number }>();
    for (const [file, lines] of perFile) {
      const layer = layerOf(file);
      const entry = perLayer.get(layer) ?? { lines: 0, files: 0 };
      perLayer.set(layer, { lines: entry.lines + lines, files: entry.files + 1 });
    }
    const baseline: Readonly<Record<string, number>> = STRICT ? {} : SCAN_BASELINE;
    const { failures, reminders } = checkAgainstBaseline(perFile, baseline);
    const baselineLines = Object.values(baseline).reduce((sum, count) => sum + count, 0);
    const report = [
      `i18n stray-string scan (${STRICT ? 'strict' : 'baseline mode'}): ${strays.length} lines in ${perFile.size} files; baseline ${baselineLines} lines in ${Object.keys(baseline).length} files`,
      ...[...perLayer].sort().map(([layer, entry]) => `  ${layer} ${entry.lines} lines in ${entry.files} files`),
      ...[...perFile].sort().map(([file, lines]) => `  ${file}: ${lines}`),
      ...(reminders.length ? ['Reminders (a count went down; lower the baseline entry):', ...reminders.map(reminder => `  ${reminder}`)] : []),
    ].join('\n');
    console.info(report);
    const where = (file: string) => strays.filter(stray => stray.file === file).map(stray => `${stray.file}:${stray.line}`).join(', ');
    const message = failures.map(failure => `${failure}\n    at ${where(failure.slice(0, failure.indexOf(':')))}`).join('\n');
    expect(failures, `New Chinese text outside the string tables. Put it into the area's table with both languages (english-ui R58); do not raise the baseline.\n${message}`).toEqual([]);
  });

  it('keeps the baseline sorted by path, with positive whole numbers, frozen', () => {
    const files = Object.keys(SCAN_BASELINE);
    expect(files).toEqual([...files].sort());
    for (const file of files) {
      expect(Number.isInteger(SCAN_BASELINE[file])).toBe(true);
      expect(SCAN_BASELINE[file]).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(SCAN_BASELINE)).toBe(true);
    expect(files.every(file => !file.includes('\\'))).toBe(true);
  });
});

describe('comparison with the baseline (synthetic inputs)', () => {
  const counts = (entries: Record<string, number>) => new Map(Object.entries(entries));

  it('passes when every count equals its baseline', () => {
    expect(checkAgainstBaseline(counts({ 'src/a.ts': 3, 'server/b.ts': 1 }), { 'src/a.ts': 3, 'server/b.ts': 1 }))
      .toEqual({ failures: [], reminders: [] });
  });

  it('fails a file above its baseline and names the file, the count and the baseline', () => {
    const result = checkAgainstBaseline(counts({ 'src/a.ts': 4 }), { 'src/a.ts': 3 });
    expect(result.failures).toEqual(['src/a.ts: 4 stray lines, baseline 3']);
    expect(result.reminders).toEqual([]);
  });

  it('fails a file that is not in the baseline and has any stray line', () => {
    const result = checkAgainstBaseline(counts({ 'src/new.ts': 1 }), { 'src/a.ts': 3 });
    expect(result.failures).toEqual(['src/new.ts: 1 stray lines, baseline 0 (not in the baseline)']);
  });

  it('passes a count below its baseline and reminds to lower the entry', () => {
    const result = checkAgainstBaseline(counts({ 'src/a.ts': 1 }), { 'src/a.ts': 3 });
    expect(result.failures).toEqual([]);
    expect(result.reminders).toEqual([`src/a.ts: 1 stray lines now, baseline 3. Lower the entry in ${BASELINE_FILE}.`]);
  });

  it('reminds to delete an entry whose count reached 0 (the file may be gone as well)', () => {
    const result = checkAgainstBaseline(counts({}), { 'src/gone.ts': 2 });
    expect(result.failures).toEqual([]);
    expect(result.reminders).toEqual([`src/gone.ts: 0 stray lines now, baseline 2. Lower the entry in ${BASELINE_FILE} (or delete it).`]);
  });

  it('reports failures and reminders together, sorted by path', () => {
    const result = checkAgainstBaseline(
      counts({ 'src/z.ts': 2, 'src/a.ts': 5, 'server/m.ts': 1 }),
      { 'src/z.ts': 4, 'src/a.ts': 2, 'server/m.ts': 1 },
    );
    expect(result.failures).toEqual(['src/a.ts: 5 stray lines, baseline 2']);
    expect(result.reminders).toHaveLength(1);
    expect(result.reminders[0]).toContain('src/z.ts');
    const two = checkAgainstBaseline(counts({ 'b.ts': 1, 'a.ts': 1 }), {});
    expect(two.failures.map(failure => failure.split(':')[0])).toEqual(['a.ts', 'b.ts']);
  });

  it('with an empty baseline (strict mode) every stray line fails', () => {
    const result = checkAgainstBaseline(counts({ 'src/a.ts': 1 }), {});
    expect(result.failures).toEqual(['src/a.ts: 1 stray lines, baseline 0 (not in the baseline)']);
  });

  it('does not take a file name from the prototype of the baseline object', () => {
    const result = checkAgainstBaseline(counts({ constructor: 1, toString: 2 }), {});
    expect(result.failures).toHaveLength(2);
  });

  it('ignores a file with 0 stray lines that is not in the baseline', () => {
    expect(checkAgainstBaseline(counts({ 'src/clean.ts': 0 }), {})).toEqual({ failures: [], reminders: [] });
  });
});
