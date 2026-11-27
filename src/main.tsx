import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ENGLISH_UI_READY, initialLang } from './i18n/lang-store';
import { LanguageProvider } from './i18n/LanguageProvider';
import './styles.css';

/** `localStorage`, or null where the browser refuses access (the choice then lasts for the page session). */
function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

// english-ui R2 to R4, R9: the URL, the stored choice, then the browser decide the first language.
const initial = initialLang({
  search: window.location.search,
  storage: browserStorage(),
  languages: navigator.languages?.length ? navigator.languages : [navigator.language ?? ''],
  ready: ENGLISH_UI_READY,
});

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LanguageProvider initial={initial}><App /></LanguageProvider></React.StrictMode>);
