import { defineText } from '../../shared/i18n/define';

/**
 * The browser message for a pull-out the agent made (workbench-ui requirement 56). App.tsx uses
 * the zh-TW entry until the language switch reaches this message.
 */
export const PULL_OUT_MESSAGE = defineText({
  'zh-TW': {
    agentPulledOut: (p: { name: string }) => `代理已把「${p.name}」拉出成新物件，可按「復原」回到上一步。`,
    /** create_joint on two parts of one object: one part is pulled out in place and joined (requirement 50); the joint card opens. */
    agentPulledAndJoined: (p: { name: string; a: string; b: string }) =>
      `代理已把「${p.name}」拉出成新物件，並接合「${p.a}」與「${p.b}」，請確認固定方式。`,
  },
  en: {
    agentPulledOut: p => `The agent pulled "${p.name}" out as a new object. Press Undo to go back one step.`,
    agentPulledAndJoined: p => `The agent pulled "${p.name}" out as a new object and joined "${p.a}" and "${p.b}". Please confirm how they are fixed.`,
  },
});
