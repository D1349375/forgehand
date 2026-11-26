import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { contentLang, differsFromUi, type ContentText } from '../../shared/i18n/content';
import { localized } from '../../shared/i18n/define';
import { colon, hasCjk, joinList, paren, plural, quote, seconds } from '../../shared/i18n/format';
import { HTML_LANG, LANGS, LangSchema, isLang, langFromHeader, langFromTag } from '../../shared/i18n/lang';
import { DOCUMENT_TEXT, LanguageProvider, applyDocumentLang, useLang } from '../../src/i18n/LanguageProvider';
import {
  ENGLISH_UI_READY, LANG_STORAGE_KEY, detectLang, initialLang, loadLang, saveLang, switchVisible,
} from '../../src/i18n/lang-store';
import { raw, renderUiText, ui } from '../../src/i18n/ui-text';

/** A `Storage`-like object in memory; a Map keeps nothing outside the test (no global state, R54). */
const memoryStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
};
const throwingStorage = {
  getItem: (): string | null => { throw new Error('blocked'); },
  setItem: (): void => { throw new Error('blocked'); },
};

describe('Lang and the header parser', () => {
  it('has exactly the two languages, and a schema and guard for them', () => {
    expect([...LANGS]).toEqual(['zh-TW', 'en']);
    expect(LangSchema.parse('en')).toBe('en');
    expect(LangSchema.safeParse('fr').success).toBe(false);
    expect(isLang('zh-TW')).toBe(true);
    expect(isLang('zh-CN')).toBe(false);
    expect(isLang(undefined)).toBe(false);
    expect(HTML_LANG).toEqual({ 'zh-TW': 'zh-Hant-TW', en: 'en' });
  });

  it('gives zh-TW for a missing, empty or non-English header (R19)', () => {
    for (const header of [undefined, '', '   ', 'zh-TW', 'zh-CN', 'zh-Hant-TW,zh;q=0.9', 'fr', 'fr-CA,en;q=0.5', '*', 'de', 'english', ';q=1']) {
      expect(langFromHeader(header)).toBe('zh-TW');
    }
  });

  it('gives en when the first tag is English', () => {
    for (const header of ['en', 'en-US', 'EN-gb', 'en-US,en;q=0.9', 'en;q=0.8', ' en , zh-TW', 'en_US']) {
      expect(langFromHeader(header)).toBe('en');
    }
  });

  it('never throws and reads only the first 100 characters', () => {
    expect(langFromHeader('x'.repeat(10_000))).toBe('zh-TW');
    expect(langFromHeader(`en,${'x'.repeat(10_000)}`)).toBe('en');
    expect(langFromHeader(`${' '.repeat(120)}en`)).toBe('zh-TW');
    expect(langFromHeader('\u0000\u0001<script>')).toBe('zh-TW');
    expect(langFromHeader(42 as unknown as string)).toBe('zh-TW');
    expect(langFromHeader(['en'] as unknown as string)).toBe('zh-TW');
  });

  it('classifies a single tag', () => {
    expect(langFromTag('zh')).toBe('zh-TW');
    expect(langFromTag('zh-CN')).toBe('zh-TW');
    expect(langFromTag('zh_Hant')).toBe('zh-TW');
    expect(langFromTag('en-US')).toBe('en');
    expect(langFromTag('fr')).toBeNull();
    expect(langFromTag('zhx')).toBeNull();
    expect(langFromTag('')).toBeNull();
    expect(langFromTag(undefined)).toBeNull();
    expect(langFromTag('en US')).toBeNull();
  });
});

describe('language store', () => {
  it('detects the browser language from the first entry (R2)', () => {
    expect(detectLang(['zh-TW'])).toBe('zh-TW');
    expect(detectLang(['zh-CN', 'en'])).toBe('zh-TW');
    expect(detectLang(['zh'])).toBe('zh-TW');
    expect(detectLang(['en-US', 'zh-TW'])).toBe('en');
    expect(detectLang(['fr-FR'])).toBe('en');
    expect(detectLang([''])).toBe('en');
    expect(detectLang([])).toBe('en');
  });

  it('loads only a valid stored choice (R3)', () => {
    expect(loadLang(memoryStorage({ [LANG_STORAGE_KEY]: 'en' }))).toBe('en');
    expect(loadLang(memoryStorage({ [LANG_STORAGE_KEY]: 'zh-TW' }))).toBe('zh-TW');
    for (const value of ['', 'fr', 'EN', 'zh-CN', '"en"', '{}']) expect(loadLang(memoryStorage({ [LANG_STORAGE_KEY]: value }))).toBeNull();
    expect(loadLang(memoryStorage())).toBeNull();
    expect(loadLang(null)).toBeNull();
    expect(loadLang(undefined)).toBeNull();
    expect(loadLang(throwingStorage)).toBeNull();
  });

  it('saves the choice as a plain tag, and ignores a storage that refuses to write', () => {
    const storage = memoryStorage();
    saveLang(storage, 'en');
    expect(storage.map.get(LANG_STORAGE_KEY)).toBe('en');
    expect(loadLang(storage)).toBe('en');
    saveLang(storage, 'zh-TW');
    expect(loadLang(storage)).toBe('zh-TW');
    expect(() => saveLang(throwingStorage, 'en')).not.toThrow();
    expect(() => saveLang(null, 'en')).not.toThrow();
    saveLang(storage, 'fr' as never);
    expect(loadLang(storage)).toBe('zh-TW');
  });

  it('stays gated until English is ready (R9)', () => {
    expect(ENGLISH_UI_READY).toBe(false);
    const stored = memoryStorage({ [LANG_STORAGE_KEY]: 'en' });
    // Default `ready` is the constant: everyone gets zh-TW, also with an English browser and a stored choice.
    expect(initialLang({ search: '', storage: stored, languages: ['en-US'] })).toBe('zh-TW');
    expect(initialLang({ search: '', storage: stored, languages: ['en-US'], ready: false })).toBe('zh-TW');
  });

  it('picks the initial language from the URL, then the stored choice, then the browser (R2 to R4)', () => {
    const none = memoryStorage();
    const storedEn = memoryStorage({ [LANG_STORAGE_KEY]: 'en' });
    const storedZh = memoryStorage({ [LANG_STORAGE_KEY]: 'zh-TW' });
    const input = (search: string, storage: typeof none | null, languages: string[]) => ({ search, storage, languages, ready: true });
    expect(initialLang(input('?lang=en', storedZh, ['zh-TW']))).toBe('en');
    expect(initialLang(input('?lang=zh-TW', storedEn, ['en-US']))).toBe('zh-TW');
    expect(initialLang(input('?a=1&lang=en', none, ['zh-TW']))).toBe('en');
    expect(initialLang(input('?lang=fr', storedEn, ['zh-TW']))).toBe('en'); // unknown value ignored
    expect(initialLang(input('?lang=fr', none, ['zh-TW']))).toBe('zh-TW');
    expect(initialLang(input('', storedEn, ['zh-TW']))).toBe('en');
    expect(initialLang(input('', storedZh, ['en-US']))).toBe('zh-TW');
    expect(initialLang(input('', none, ['zh-CN']))).toBe('zh-TW');
    expect(initialLang(input('', none, ['en-US']))).toBe('en');
    expect(initialLang(input('', none, []))).toBe('en');
    expect(initialLang(input('', null, ['fr']))).toBe('en');
    expect(initialLang({ search: '', storage: throwingStorage, languages: ['zh-TW'], ready: true })).toBe('zh-TW');
  });

  it('does not store the URL override (R4)', () => {
    const storage = memoryStorage();
    initialLang({ search: '?lang=en', storage, languages: ['zh-TW'], ready: true });
    expect(storage.map.size).toBe(0);
  });

  it('shows the switch when English is ready or the URL has ?lang= (R9)', () => {
    expect(switchVisible('?lang=en', false)).toBe(true);
    expect(switchVisible('?lang=zh-TW', false)).toBe(true);
    expect(switchVisible('', false)).toBe(false);
    expect(switchVisible('?hands=debug', false)).toBe(false);
    expect(switchVisible('', true)).toBe(true);
    expect(switchVisible('')).toBe(ENGLISH_UI_READY);
  });
});

describe('format helpers', () => {
  it('quotes, joins, adds colons and parentheses in each language (R18)', () => {
    expect(quote('zh-TW', '外殼')).toBe('「外殼」');
    expect(quote('en', 'Housing')).toBe('\u201cHousing\u201d');
    expect(joinList('zh-TW', ['甲', '乙', '丙'])).toBe('甲、乙、丙');
    expect(joinList('en', ['a', 'b', 'c'])).toBe('a, b, c');
    expect(joinList('en', [])).toBe('');
    expect(joinList('en', ['a'])).toBe('a');
    expect(`手勢${colon('zh-TW')}待命`).toBe('手勢：待命');
    expect(`Hand${colon('en')}ready`).toBe('Hand: ready');
    expect(`外殼${paren('zh-TW', '雙鏡頭')}`).toBe('外殼（雙鏡頭）');
    expect(`Housing${paren('en', 'dual lens')}`).toBe('Housing (dual lens)');
  });

  it('picks English singular and plural with Intl.PluralRules, and never pluralises Chinese', () => {
    expect(plural('en', 0, 'part', 'parts')).toBe('0 parts');
    expect(plural('en', 1, 'part', 'parts')).toBe('1 part');
    expect(plural('en', 2, 'part', 'parts')).toBe('2 parts');
    expect(plural('en', 1.5, 'part', 'parts')).toBe('1.5 parts');
    expect(plural('zh-TW', 1, '個零件', '個零件')).toBe('1 個零件');
    expect(plural('zh-TW', 3, '個零件', '個零件')).toBe('3 個零件');
  });

  it('writes seconds in each language', () => {
    expect(seconds('zh-TW', 12)).toBe('12 秒');
    expect(seconds('en', 12)).toBe('12 s');
    expect(seconds('en', '3.5')).toBe('3.5 s');
  });

  it('finds CJK characters, CJK punctuation and full-width forms', () => {
    expect(hasCjk('外殼')).toBe(true);
    expect(hasCjk('USB-C 插座')).toBe(true);
    expect(hasCjk('Housing，')).toBe(true);
    expect(hasCjk('「Housing」')).toBe(true);
    expect(hasCjk('Ａ')).toBe(true);
    expect(hasCjk('Housing 1.5 mm')).toBe(false);
    expect(hasCjk('')).toBe(false);
    expect(hasCjk('\u201cHousing\u201d – ok')).toBe(false);
  });

  it('builds a Localized pair', () => {
    expect(localized('準備匯出', 'Prepare export')).toEqual({ 'zh-TW': '準備匯出', en: 'Prepare export' });
  });
});

describe('content language (R35)', () => {
  const model = (name: string, partNames: string[], extra: Partial<ContentText> = {}): ContentText => ({
    name, summary: 'A device.', assumptions: [], parts: partNames.map(part => ({ name: part })), ...extra,
  });

  it('is zh-TW for Chinese demo names and en for English names', () => {
    expect(contentLang(model('雙鏡頭概念裝置', ['外殼', '鏡頭']))).toBe('zh-TW');
    expect(contentLang(model('Dual-lens concept device', ['Housing', 'Lens']))).toBe('en');
    expect(contentLang(model('', []))).toBe('en');
  });

  it('is zh-TW when only one part name is mixed', () => {
    expect(contentLang(model('Case', ['Housing', 'USB-C 插座']))).toBe('zh-TW');
    expect(contentLang(model('Case 蓋', ['Housing']))).toBe('zh-TW');
  });

  it('looks at the summary and assumptions for contentLang: an English name with a Chinese assumption is zh-TW', () => {
    expect(contentLang(model('Case', ['Housing'], { assumptions: ['外殼厚度為 2 mm。'] }))).toBe('zh-TW');
    expect(contentLang(model('Case', ['Housing'], { summary: '一個外殼。' }))).toBe('zh-TW');
  });

  it('differsFromUi(en) is true for any CJK in the text', () => {
    expect(differsFromUi(model('雙鏡頭概念裝置', ['外殼']), 'en')).toBe(true);
    expect(differsFromUi(model('Case', ['Housing', 'USB-C 插座']), 'en')).toBe(true);
    expect(differsFromUi(model('Case', ['Housing'], { assumptions: ['外殼厚度為 2 mm。'] }), 'en')).toBe(true);
    expect(differsFromUi(model('Dual-lens concept device', ['Housing']), 'en')).toBe(false);
  });

  it('differsFromUi(zh-TW) is false only when the name or a part name has CJK', () => {
    expect(differsFromUi(model('Dual-lens concept device', ['Housing', 'Lens']), 'zh-TW')).toBe(true);
    expect(differsFromUi(model('雙鏡頭概念裝置', ['Housing']), 'zh-TW')).toBe(false);
    expect(differsFromUi(model('Case', ['Housing', 'USB-C 插座']), 'zh-TW')).toBe(false);
    // A Chinese summary or assumption alone does not make the content Chinese for this test.
    expect(differsFromUi(model('Case', ['Housing'], { assumptions: ['外殼厚度為 2 mm。'] }), 'zh-TW')).toBe(true);
    expect(differsFromUi(model('Case', ['Housing'], { summary: '一個外殼。' }), 'zh-TW')).toBe(true);
    expect(differsFromUi(model('雙鏡頭概念裝置', ['外殼']), 'zh-TW')).toBe(false);
  });
});

describe('notice descriptors (R38)', () => {
  it('renders a table notice in whichever language is asked', () => {
    const notice = ui(lang => (lang === 'en' ? 'Loaded.' : '已載入。'));
    expect(notice.lang).toBeNull();
    expect(renderUiText(notice, 'zh-TW')).toBe('已載入。');
    expect(renderUiText(notice, 'en')).toBe('Loaded.');
  });

  it('keeps raw server text as it came, with the language it was written in', () => {
    const notice = raw('服務忙碌中。', 'zh-TW');
    expect(notice.lang).toBe('zh-TW');
    expect(renderUiText(notice, 'en')).toBe('服務忙碌中。');
  });

  it('renders no notice as an empty string', () => {
    expect(renderUiText(null, 'en')).toBe('');
    expect(renderUiText(undefined, 'zh-TW')).toBe('');
  });
});

describe('document language and the provider', () => {
  it('sets <html lang> and the title (R8)', () => {
    const doc = { documentElement: { lang: '' }, title: '' };
    applyDocumentLang(doc, 'en');
    expect(doc).toEqual({ documentElement: { lang: 'en' }, title: 'Forgehand | 3D concept workbench' });
    applyDocumentLang(doc, 'zh-TW');
    expect(doc).toEqual({ documentElement: { lang: 'zh-Hant-TW' }, title: 'Forgehand｜3D 概念工作台' });
    expect(DOCUMENT_TEXT.en.title).not.toBe(DOCUMENT_TEXT['zh-TW'].title);
  });

  it('gives the initial language to every component below it, and keeps two providers apart (R54)', () => {
    const Show = () => createElement('span', null, useLang().lang);
    const render = (initial: 'zh-TW' | 'en') => renderToString(createElement(LanguageProvider, { initial, children: createElement(Show) }));
    expect(render('en')).toContain('>en<');
    expect(render('zh-TW')).toContain('>zh-TW<');
    expect(render('en')).toContain('>en<');
  });

  it('throws when useLang is used outside the provider', () => {
    const Show = () => createElement('span', null, useLang().lang);
    expect(() => renderToString(createElement(Show))).toThrow(/LanguageProvider/);
  });
});
