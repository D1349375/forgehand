import { defineText } from '../../shared/i18n/define';
import { HTML_LANG, type Lang } from '../../shared/i18n/lang';
import { ENGLISH_UI_READY, switchVisible } from './lang-store';
import { useLang } from './LanguageProvider';

/** The switch's group name (english-ui R5). */
export const SWITCH_TEXT = defineText({
  'zh-TW': { group: '介面語言' },
  en: { group: 'Interface language' },
});

/** Each language is named in its own language, so a user who cannot read the current one can still find it (R5, N4). */
const OPTIONS: readonly { lang: Lang; label: string }[] = [
  { lang: 'zh-TW', label: '繁體中文' },
  { lang: 'en', label: 'English' },
];

/**
 * Two toggle buttons that choose the UI language (R5). Until English is ready it renders only when the
 * URL has a `lang` parameter (R9). `disabled` and `disabledReason` are for the busy state of R7; the
 * reason is the buttons' title, which is also their accessible description.
 */
export function LanguageSwitch({ disabled, disabledReason }: { disabled: boolean; disabledReason: string }) {
  const { lang, setLang } = useLang();
  if (!switchVisible(window.location.search, ENGLISH_UI_READY)) return null;
  return <div className="button-group" role="group" aria-label={SWITCH_TEXT[lang].group}>
    {OPTIONS.map(option => <button
      key={option.lang}
      type="button"
      className={`button ${lang === option.lang ? 'active' : ''}`}
      lang={HTML_LANG[option.lang]}
      aria-pressed={lang === option.lang}
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : undefined}
      onClick={() => { if (lang !== option.lang) setLang(option.lang); }}
    >{option.label}</button>)}
  </div>;
}
