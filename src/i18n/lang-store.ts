import { isLang, langFromTag, type Lang } from '../../shared/i18n/lang';

/**
 * The language as a browser setting (english-ui R2 to R4, R9). Same pattern as `src/joints/printer-store.ts`:
 * the functions take a `Storage`-like object, so tests need no DOM.
 */

/** R9: false until the last english-ui task. While false, everyone gets zh-TW and the switch shows only with `?lang=`. */
export const ENGLISH_UI_READY = false;
export const LANG_STORAGE_KEY = 'forgehand.lang.v1';

export type ReadableStorage = Pick<Storage, 'getItem'>;
export type WritableStorage = Pick<Storage, 'setItem'>;

/** R2: the first browser language decides. `zh*` (any region) gives zh-TW, anything else en, no language en. */
export function detectLang(languages: readonly string[]): Lang {
  return langFromTag(languages[0]) ?? 'en';
}

/** The stored choice, or null when nothing valid is stored (missing, invalid, unreadable, no storage). */
export function loadLang(storage: ReadableStorage | null | undefined): Lang | null {
  try {
    const value = storage?.getItem(LANG_STORAGE_KEY);
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stores the choice. A full or blocked storage is ignored: the choice then lasts for the page session only. */
export function saveLang(storage: WritableStorage | null | undefined, lang: Lang): void {
  try {
    if (isLang(lang)) storage?.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // Not persisted; the language in memory still applies.
  }
}

function urlLang(search: string): Lang | null {
  try {
    const value = new URLSearchParams(search).get('lang');
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * R2 to R4, R9. `?lang=` wins for this page load and is never stored; an unknown value is ignored.
 * Otherwise, only when `ready`, the stored choice, then the browser's language. Otherwise zh-TW.
 */
export function initialLang(input: {
  search: string;
  storage: ReadableStorage | null | undefined;
  languages: readonly string[];
  ready?: boolean;
}): Lang {
  const fromUrl = urlLang(input.search);
  if (fromUrl) return fromUrl;
  if (!(input.ready ?? ENGLISH_UI_READY)) return 'zh-TW';
  return loadLang(input.storage) ?? detectLang(input.languages);
}

/** R9: the switch shows when English is ready or the URL has a `lang` parameter. */
export function switchVisible(search: string, ready: boolean = ENGLISH_UI_READY): boolean {
  if (ready) return true;
  try {
    return new URLSearchParams(search).has('lang');
  } catch {
    return false;
  }
}
