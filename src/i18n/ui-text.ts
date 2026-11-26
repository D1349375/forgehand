import type { Lang } from '../../shared/i18n/lang';

/**
 * A notice kept in React state (english-ui R38). It holds how to render the text, not the finished
 * text, so it re-renders in the new language after a switch. `lang` is null for text built from a
 * table (any language), or the language that raw server text was written in (R39 clears those on a switch).
 *
 * State always holds a `UiText` object. `setMessage(lang => ...)` would be taken by React as an updater
 * function, so write `setMessage(ui(lang => TEXT[lang].demoLoaded))`.
 */
export interface UiText {
  readonly lang: Lang | null;
  readonly render: (lang: Lang) => string;
}

/** Text rendered from a table in whatever language is current. */
export const ui = (render: (lang: Lang) => string): UiText => ({ lang: null, render });

/** Text that arrived finished, in the language it was written in (for example an error from a response body). */
export const raw = (text: string, lang: Lang): UiText => ({ lang, render: () => text });

/** The text to show, or an empty string for no notice. */
export const renderUiText = (text: UiText | null | undefined, lang: Lang): string => (text ? text.render(lang) : '');
