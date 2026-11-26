import { z } from 'zod';

/** The two UI languages (english-ui R1). This file is the only definition; every layer imports it. */
export const LANGS = ['zh-TW', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const LangSchema = z.enum(LANGS);

/** The value of `<html lang>` for each language (R8, N4). */
export const HTML_LANG: Readonly<Record<Lang, string>> = { 'zh-TW': 'zh-Hant-TW', en: 'en' };

export const isLang = (value: unknown): value is Lang => LangSchema.safeParse(value).success;

/** A language tag is letters and digits in groups of at most 8, joined by `-` or `_` (for example `en-US`, `zh-Hant-TW`). */
const TAG_PATTERN = /^[A-Za-z]{1,8}(?:[-_][A-Za-z0-9]{1,8})*$/;
/** How much of an `Accept-Language` header is read (R19, N5). */
const HEADER_LIMIT = 100;

/**
 * The language a single tag asks for: `zh*` (any region or script, because only Traditional Chinese
 * exists) gives `zh-TW`, `en*` gives `en`. Any other, empty or malformed tag gives null, so the caller
 * decides its own fallback (the browser falls back to `en`, the server to `zh-TW`). Never throws.
 */
export function langFromTag(tag: string | null | undefined): Lang | null {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!TAG_PATTERN.test(trimmed)) return null;
  const primary = trimmed.split(/[-_]/, 1)[0]!.toLowerCase();
  if (primary === 'en') return 'en';
  if (primary === 'zh') return 'zh-TW';
  return null;
}

/**
 * R19: the first language tag of an `Accept-Language` header decides. `en*` gives `en`; anything else,
 * and a missing or unreadable header, gives `zh-TW` (today's behaviour). Reads at most the first 100
 * characters and never throws. This is the only header parser.
 */
export function langFromHeader(header: string | undefined): Lang {
  if (typeof header !== 'string') return 'zh-TW';
  const first = header.slice(0, HEADER_LIMIT).split(',', 1)[0] ?? '';
  const tag = first.split(';', 1)[0] ?? '';
  return langFromTag(tag) === 'en' ? 'en' : 'zh-TW';
}
