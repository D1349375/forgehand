import type { Lang } from './lang';

/** A leaf is a string, or a function of one flat params object (strings, numbers or booleans). */
// `never` accepts any one-parameter function. The flat-params rule is checked by review and by the sample test in i18n-tables.test.ts.
type Leaf = string | ((params: never) => string);
type Tree = { readonly [key: string]: Leaf | Tree };

/**
 * The English side's type, derived from the Chinese side: the same keys, literal strings widened to
 * `string`, and functions keep their parameter type. A missing or extra key, a string where the other
 * side has a function, or a different parameter type is therefore a compile error (R47).
 */
export type Shape<T> = T extends string
  ? string
  : T extends (params: infer P) => string
    ? (params: P) => string
    : { readonly [K in keyof T]: Shape<T[K]> };

/**
 * Declares one area's text in both languages side by side. The Chinese side defines the shape; the
 * English side is checked against it. Returns the table unchanged, indexed by language:
 * `TEXT[lang].some.key` or `TEXT[lang].some.fn({ name })`.
 */
export function defineText<const T extends Tree>(table: {
  readonly 'zh-TW': T;
  readonly en: NoInfer<Shape<T>>;
}): Readonly<Record<Lang, Shape<T>>> {
  return table as unknown as Readonly<Record<Lang, Shape<T>>>;
}

/** A pair for a single value, for example a tool display name. */
export type Localized = Readonly<Record<Lang, string>>;
export const localized = (zh: string, en: string): Localized => ({ 'zh-TW': zh, en });
