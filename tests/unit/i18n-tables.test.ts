import { describe, expect, it } from 'vitest';
import { defineText } from '../../shared/i18n/define';
import { hasCjk } from '../../shared/i18n/format';
import { TABLE_FILES, ROOT } from './i18n-files';

/** English text may keep these Chinese words: the language name and the instruction words of english-ui R23. */
export const EN_CJK_ALLOWED = ['繁體中文', '這個', '它', '這些'];

/** Every key of a parameter object answers 1, so a function leaf can run without knowing its parameters. Works because parameters are flat (design 3.2). */
const sampleParams = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? 1 : undefined) });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A table made by `defineText` has exactly the keys `zh-TW` and `en`. */
export const isLangTable = (value: unknown): value is { 'zh-TW': unknown; en: unknown } => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === 'en' && keys[1] === 'zh-TW';
};

const withoutAllowed = (text: string): string => EN_CJK_ALLOWED.reduce((rest, word) => rest.split(word).join(''), text);

function checkLeaf(path: string, lang: 'zh-TW' | 'en', text: string, problems: string[]): void {
  if (text.trim() === '') problems.push(`${path} [${lang}]: empty text`);
  if (/undefined|NaN|\[object /.test(text)) problems.push(`${path} [${lang}]: has undefined, NaN or [object]`);
  if (lang === 'en' && hasCjk(withoutAllowed(text))) problems.push(`${path} [en]: has a CJK character`);
}

function walk(path: string, zh: unknown, en: unknown, problems: string[]): void {
  if (typeof zh === 'string' && typeof en === 'string') {
    checkLeaf(path, 'zh-TW', zh, problems);
    checkLeaf(path, 'en', en, problems);
  } else if (typeof zh === 'function' && typeof en === 'function') {
    for (const [lang, fn] of [['zh-TW', zh], ['en', en]] as const) {
      try {
        const result: unknown = (fn as (params: unknown) => unknown)(sampleParams);
        if (typeof result !== 'string') problems.push(`${path} [${lang}]: function did not return a string`);
        else checkLeaf(path, lang, result, problems);
      } catch (error) {
        problems.push(`${path} [${lang}]: function threw ${error instanceof Error ? error.message : 'an error'}`);
      }
    }
  } else if (isRecord(zh) && isRecord(en)) {
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    for (const key of zhKeys) if (!enKeys.includes(key)) problems.push(`${path}.${key}: missing in en`);
    for (const key of enKeys) if (!zhKeys.includes(key)) problems.push(`${path}.${key}: missing in zh-TW`);
    for (const key of zhKeys) if (enKeys.includes(key)) walk(`${path}.${key}`, zh[key], en[key], problems);
  } else {
    problems.push(`${path}: the two languages differ in kind (string, function or group)`);
  }
}

/** The list of problems in one table; empty when the table is sound (design 3.7). */
export function checkTable(name: string, table: { 'zh-TW': unknown; en: unknown }): string[] {
  const problems: string[] = [];
  walk(name, table['zh-TW'], table.en, problems);
  return problems;
}

/** The example table of this test file: the shape every area table follows (design 3.2). */
const EXAMPLE = defineText({
  'zh-TW': {
    title: '外殼',
    status: { loading: '正在載入。', done: '完成。' },
    badge: (p: { name: string }) => `手勢：對準 ${p.name}`,
    count: (p: { n: number; flag: boolean }) => `${p.n} 個零件${p.flag ? '。' : ''}`,
  },
  en: {
    title: 'Housing',
    status: { loading: 'Loading.', done: 'Done.' },
    badge: p => `Hand: pointing at ${p.name}`,
    count: p => `${p.n} parts${p.flag ? '.' : ''}`,
  },
});

describe('defineText', () => {
  it('indexes the table by language and keeps function parameters', () => {
    expect(EXAMPLE['zh-TW'].title).toBe('外殼');
    expect(EXAMPLE.en.status.loading).toBe('Loading.');
    expect(EXAMPLE['zh-TW'].badge({ name: '外殼' })).toBe('手勢：對準 外殼');
    expect(EXAMPLE.en.badge({ name: 'Housing' })).toBe('Hand: pointing at Housing');
    expect(EXAMPLE.en.count({ n: 2, flag: true })).toBe('2 parts.');
  });

  it('accepts the example table', () => {
    expect(checkTable('EXAMPLE', EXAMPLE)).toEqual([]);
  });

  // Each `@ts-expect-error` below is the compile-time guarantee (R47): `npm run build` fails when one
  // of these lines stops being a type error. The run-time check then also reports the same defect.
  it('rejects an English side with a missing key', () => {
    const table = defineText({
      'zh-TW': { a: '甲', b: '乙' },
      // @ts-expect-error property 'b' is missing in the English side
      en: { a: 'A' },
    });
    expect(checkTable('missing', table)).toEqual(['missing.b: missing in en']);
  });

  it('rejects an English side with an extra key', () => {
    const table = defineText({
      'zh-TW': { a: '甲' },
      // @ts-expect-error 'extra' does not exist in the Chinese side
      en: { a: 'A', extra: 'Extra' },
    });
    expect(checkTable('extra', table)).toEqual(['extra.extra: missing in zh-TW']);
  });

  it('rejects an English side that has a different parameter type', () => {
    const table = defineText({
      'zh-TW': { greet: (p: { name: string }) => `你好 ${p.name}` },
      // @ts-expect-error the English function expects a number where the Chinese one has a string
      en: { greet: (p: { name: number }) => `Hello ${p.name}` },
    });
    expect(checkTable('param', table)).toEqual([]); // the sample object answers 1 for every key; only the compiler sees this
  });

  it('rejects an English function that reads a parameter the Chinese side does not have', () => {
    const table = defineText({
      'zh-TW': { greet: (p: { name: string }) => `你好 ${p.name}` },
      en: {
        // @ts-expect-error 'title' is not a parameter of the Chinese function
        greet: p => `Hello ${p.title}`,
      },
    });
    expect(checkTable('unknown', table)).toEqual([]); // the sample object answers 1 for every key
  });

  it('rejects an English side that needs more parameters than the Chinese side gives', () => {
    const table = defineText({
      'zh-TW': { greet: (p: { name: string }) => `你好 ${p.name}` },
      // @ts-expect-error the English function needs `age`, which callers do not pass
      en: { greet: (p: { name: string; age: number }) => `Hello ${p.name}, ${p.age}` },
    });
    expect(checkTable('more', table)).toEqual([]);
  });

  it('rejects a string on one side and a function on the other', () => {
    const table = defineText({
      'zh-TW': { a: '甲', b: (p: { n: number }) => `${p.n}` },
      // @ts-expect-error the English side has a function where the Chinese side has a string, and the reverse
      en: { a: (p: { n: number }) => `${p.n}`, b: 'B' },
    });
    expect(checkTable('kind', table)).toHaveLength(2);
  });
});

describe('table checker (run time)', () => {
  const make = (zh: unknown, en: unknown) => ({ 'zh-TW': zh, en });

  it('reports an empty text', () => {
    expect(checkTable('t', make({ a: '甲' }, { a: '  ' }))).toEqual(['t.a [en]: empty text']);
    expect(checkTable('t', make({ a: '' }, { a: 'A' }))).toEqual(['t.a [zh-TW]: empty text']);
  });

  it('reports a CJK character in English, except the allowed words', () => {
    expect(checkTable('t', make({ a: '甲' }, { a: 'Part 甲' }))).toEqual(['t.a [en]: has a CJK character']);
    expect(checkTable('t', make({ a: '甲' }, { a: 'Part “A”.' }))).toEqual([]);
    expect(checkTable('t', make({ a: '甲' }, { a: 'Use 繁體中文 for 這個, 它 and 這些.' }))).toEqual([]);
    expect(checkTable('t', make({ a: '甲' }, { a: 'Use 繁體 here' }))).toEqual(['t.a [en]: has a CJK character']);
  });

  it('reports a function that returns undefined, NaN, a non-string or throws', () => {
    const bad = checkTable('t', make(
      { a: (p: { n: number }) => `${p.n}`, b: (p: { x: number }) => `${p.x}`, c: () => 'ok' },
      { a: (p: { n: number }) => `${p.n} ${undefined}`, b: () => `${Number.NaN}`, c: () => 5 },
    ));
    expect(bad).toEqual([
      't.a [en]: has undefined, NaN or [object]',
      't.b [en]: has undefined, NaN or [object]',
      't.c [en]: function did not return a string',
    ]);
    const throws = checkTable('t', make({ a: () => 'ok' }, { a: (p: { items: string[] }) => p.items.join(',') }));
    expect(throws).toHaveLength(1);
    expect(throws[0]).toContain('function threw');
  });

  it('reports a leaf that is a string on one side and a group on the other', () => {
    expect(checkTable('t', make({ a: '甲' }, { a: { b: 'B' } }))).toEqual(['t.a: the two languages differ in kind (string, function or group)']);
  });

  it('recognises a table by its two keys', () => {
    expect(isLangTable({ 'zh-TW': 1, en: 2 })).toBe(true);
    expect(isLangTable({ 'zh-TW': 1 })).toBe(false);
    expect(isLangTable({ 'zh-TW': 1, en: 2, fr: 3 })).toBe(false);
    expect(isLangTable(['en', 'zh-TW'])).toBe(false);
    expect(isLangTable(null)).toBe(false);
    expect(isLangTable('en')).toBe(false);
  });
});

describe('every table file of the project', () => {
  it('lists the three i18n folders', () => {
    expect(TABLE_FILES).toContain('shared/i18n/lang.ts');
    expect(TABLE_FILES).toContain('shared/i18n/define.ts');
    expect(TABLE_FILES).toContain('src/i18n/lang-store.ts');
    expect(TABLE_FILES).toContain('src/i18n/LanguageProvider.tsx');
    expect(TABLE_FILES.every(file => !file.includes('\\'))).toBe(true);
    expect(ROOT.length).toBeGreaterThan(0);
  });

  it('has sound tables in every file (same keys, no empty text, no CJK in English, functions return text)', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of TABLE_FILES) {
      const exported = (await import(/* @vite-ignore */ new URL(`../../${file}`, import.meta.url).href)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(exported)) {
        if (!isLangTable(value)) continue;
        checked += 1;
        problems.push(...checkTable(`${file}#${name}`, value));
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });
});
