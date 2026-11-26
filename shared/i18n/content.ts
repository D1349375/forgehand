import { hasCjk } from './format';
import type { Lang } from './lang';

/**
 * The text fields of a `ModelSpec` that decide which language its content is in. Written as a
 * structural type so a full `ModelSpec` fits and a test needs no geometry.
 */
export interface ContentText {
  readonly name: string;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly parts: readonly { readonly name: string }[];
}

const partNames = (model: ContentText): string[] => model.parts.map(part => part.name);

/** R35: `zh-TW` when the name, summary, assumptions or any part name has a CJK character, otherwise `en`. */
export function contentLang(model: ContentText): Lang {
  return [model.name, model.summary, ...model.assumptions, ...partNames(model)].some(hasCjk) ? 'zh-TW' : 'en';
}

/**
 * R35: whether the object's text looks like the other language than the UI's.
 * For `en`: any CJK character anywhere in the text. For `zh-TW`: no CJK character at all in the
 * object name and every part name together (a Chinese summary or assumption alone does not count as Chinese content here).
 */
export function differsFromUi(model: ContentText, lang: Lang): boolean {
  if (lang === 'en') return contentLang(model) === 'zh-TW';
  return ![model.name, ...partNames(model)].some(hasCjk);
}
