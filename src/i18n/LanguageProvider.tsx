import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { defineText } from '../../shared/i18n/define';
import { HTML_LANG, isLang, type Lang } from '../../shared/i18n/lang';
import { saveLang, type WritableStorage } from './lang-store';

/** R8: the document title in each language. */
export const DOCUMENT_TEXT = defineText({
  'zh-TW': { title: 'Forgehand｜3D 概念工作台' },
  en: { title: 'Forgehand | 3D concept workbench' },
});

export interface LangState {
  lang: Lang;
  setLang(lang: Lang): void;
}

/** What `applyDocumentLang` writes to; a real `Document` fits, and a test can pass a plain object. */
export interface LangDocument {
  documentElement: { lang: string };
  title: string;
}

/** R8: `<html lang>` and the title follow the language. */
export function applyDocumentLang(doc: LangDocument, lang: Lang): void {
  doc.documentElement.lang = HTML_LANG[lang];
  doc.title = DOCUMENT_TEXT[lang].title;
}

/** `localStorage`, or null when the browser blocks it (reading the property can throw). */
function browserStorage(): WritableStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const LangContext = createContext<LangState | null>(null);

/**
 * Holds the current language. `initial` comes from `initialLang(...)` (R2 to R4). `setLang` is for a
 * choice the user makes: it is stored (R3) and re-renders the tree; an effect keeps `<html lang>` and
 * the title in step, also once on mount. There is no module-level "current language" (R54).
 */
export function LanguageProvider({ children, initial }: { children: ReactNode; initial: Lang }) {
  const [lang, setLangState] = useState<Lang>(initial);
  useEffect(() => {
    if (typeof document !== 'undefined') applyDocumentLang(document, lang);
  }, [lang]);
  const setLang = useCallback((next: Lang) => {
    if (!isLang(next)) return;
    saveLang(browserStorage(), next);
    setLangState(next);
  }, []);
  const value = useMemo<LangState>(() => ({ lang, setLang }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

/** The current language and its setter. Throws outside the provider: that is a wiring bug. */
export function useLang(): LangState {
  const state = useContext(LangContext);
  if (!state) throw new Error('useLang must be used inside LanguageProvider.');
  return state;
}
