import { localized } from '../../shared/i18n/define';

/**
 * The language slot of each model instruction text (english-ui R23, R25), in both languages.
 * The zh-TW values are the sentences the instructions have always carried, so the zh-TW
 * instructions stay byte-identical (R59). The English values add the clause that the answer
 * language is the UI language also when the user writes in another language (decision 4).
 * Everything else in the instructions is English and shared.
 */
export const LANGUAGE_LINE = {
  /** Second sentence of the design instructions (after "Return only the requested structured design."). */
  design: localized(
    'All user-facing names, summary, assumptions, and explanation use Traditional Chinese.',
    'All user-facing names, summary, assumptions, and explanation use English, also when the user describes the object in another language.',
  ),
  /** The language line of the edit instructions. */
  edit: localized(
    'All user-facing names, explanation, summary and assumptions use Traditional Chinese.',
    'All user-facing names, explanation, summary and assumptions use English, also when the user writes the request in another language.',
  ),
  /** The language rule of the agent instructions (a list item). */
  agent: localized(
    '- All user-facing text (notes, final replies, and any Traditional-Chinese content) must be in Traditional Chinese (繁體中文).',
    '- All user-facing text (notes and final replies) must be in English, also when the user writes in another language.',
  ),
} as const;

/**
 * Names of controls that the agent instructions quote, as the user reads them in each language,
 * so the agent tells the user the button that exists on screen.
 */
export const UI_NAMES = {
  downloadKit: localized('下載完整套件', 'Download full kit'),
  cameraImage: localized('隱藏或顯示鏡頭畫面', 'hide or show the camera image'),
} as const;
