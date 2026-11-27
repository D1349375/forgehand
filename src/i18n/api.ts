import type { Lang } from '../../shared/i18n/lang';

/**
 * The request header that tells the server which language to answer in (english-ui R19). Every
 * `/api/*` request from the browser spreads this into its headers; the server reads only the first
 * tag, and a request without it gets zh-TW.
 */
export function apiHeaders(lang: Lang): Record<string, string> {
  return { 'Accept-Language': lang };
}
