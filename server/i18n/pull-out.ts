import { defineText } from '../../shared/i18n/define';

/**
 * Text of the pull_out_part tool and of the pull-out line that create_joint adds to its summary
 * (workbench-ui requirements 56 and 75). The zh-TW refusals are the same sentences as the
 * `WorkspaceError` messages of shared/workspace.ts, so a refusal reads the same wherever it comes from.
 * The tool picks the language with `langOf(state)`.
 */
export const PULL_OUT_TEXT = defineText({
  'zh-TW': {
    /** The tool label the user sees in the agent log. */
    label: '拉出零件',
    /** The result summary; the new object stays beside the original. */
    beside: (p: { part: string; count: number; name: string; original: string }) =>
      `已把「${p.part}」（含 ${p.count} 個子零件）拉出成新物件「${p.name}」，放在「${p.original}」旁邊。`,
    /** The result summary; a joint keeps the new object where the part was. */
    inPlace: (p: { part: string; count: number; name: string }) =>
      `已把「${p.part}」（含 ${p.count} 個子零件）拉出成新物件「${p.name}」，原位保留並與原接合相連。`,
    /** What create_joint adds to its summary when it first pulled a part out. */
    joinPulled: (p: { part: string }) => `「${p.part}」已拉出成新物件。`,
    errors: {
      unknownObject: '找不到指定的物件。',
      unknownPart: '找不到指定的零件。',
      wholeObject: '這個零件連同子零件就是整個物件，不需要拉出。',
      objectLimit: (p: { max: number }) => `工作區最多 ${p.max} 個物件，請先刪除一個物件。`,
    },
  },
  en: {
    label: 'Pull out part',
    beside: p => `Pulled "${p.part}" (with ${p.count} child parts) out as the new object "${p.name}", placed next to "${p.original}".`,
    inPlace: p => `Pulled "${p.part}" (with ${p.count} child parts) out as the new object "${p.name}". It stays in place and is still joined to what it was joined to.`,
    joinPulled: p => `"${p.part}" was pulled out as a new object.`,
    errors: {
      unknownObject: 'The object was not found.',
      unknownPart: 'The part was not found.',
      wholeObject: 'This part and its child parts are the whole object, so there is nothing to pull out.',
      objectLimit: p => `The workspace holds at most ${p.max} objects. Remove one first.`,
    },
  },
});
