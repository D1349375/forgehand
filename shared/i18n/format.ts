import type { Lang } from './lang';

/** Per-language punctuation and number phrasing (R18). Numbers and units are formatted by the caller, identically in both languages. */

/** `「s」` in zh-TW, `“s”` in en. */
export const quote = (lang: Lang, s: string): string => (lang === 'en' ? `\u201c${s}\u201d` : `「${s}」`);

/** `a、b、c` in zh-TW, `a, b, c` in en. */
export const joinList = (lang: Lang, items: readonly string[]): string => items.join(lang === 'en' ? ', ' : '、');

/** `：` in zh-TW, `: ` in en. Append it directly after a label. */
export const colon = (lang: Lang): string => (lang === 'en' ? ': ' : '：');

/** `（s）` in zh-TW, ` (s)` in en. Append it directly after the text it explains. */
export const paren = (lang: Lang, s: string): string => (lang === 'en' ? ` (${s})` : `（${s}）`);

/**
 * A count with its noun. English picks `one` or `other` with `Intl.PluralRules` (`1 part`, `2 parts`);
 * Chinese has no plural, so it always uses `other` (`3 個零件`). The number and the word are separated by a space.
 */
export function plural(lang: Lang, n: number, one: string, other: string): string {
  if (lang === 'en') return `${n} ${new Intl.PluralRules('en').select(n) === 'one' ? one : other}`;
  return `${n} ${other}`;
}

/** `{n} 秒` in zh-TW, `{n} s` in en. */
export const seconds = (lang: Lang, n: number | string): string => (lang === 'en' ? `${n} s` : `${n} 秒`);

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** True when the text has a CJK character, CJK punctuation or a full-width form (R35, R47, R48). */
export const hasCjk = (s: string): boolean => CJK.test(s);
