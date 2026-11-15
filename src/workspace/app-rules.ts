import { findObject, selectParts, type Workspace } from '../../shared/workspace';

/**
 * App's own interaction rules as pure functions, so they can be unit-tested
 * without React. No DOM, no state.
 */

/**
 * The workspace after a click on a part (requirement 24).
 *
 * - A part of the active object: without Shift, select only that part (a click
 *   on the only selected part keeps it); with Shift, add or remove it.
 * - A part of another object: activate that object and select only that part,
 *   with or without Shift.
 * - Empty space (`objectId` or `partId` null): without Shift, clear the
 *   selection and keep the active object; with Shift, no change.
 *
 * An object or part that does not exist (a stale click) changes nothing.
 * Returns the same reference when nothing changes.
 */
export function pickPart(workspace: Workspace, objectId: string | null, partId: string | null, additive: boolean): Workspace {
  if (objectId === null || partId === null) {
    if (additive || workspace.activeObjectId === null) return workspace;
    return selectParts(workspace, workspace.activeObjectId, []);
  }
  const object = findObject(workspace, objectId);
  if (!object || !object.model.parts.some(part => part.id === partId)) return workspace;
  if (objectId !== workspace.activeObjectId) return selectParts(workspace, objectId, [partId]);
  const selected = workspace.selection.partIds;
  if (additive) {
    return selectParts(workspace, objectId, selected.includes(partId) ? selected.filter(id => id !== partId) : [...selected, partId]);
  }
  if (selected.length === 1 && selected[0] === partId) return workspace;
  return selectParts(workspace, objectId, [partId]);
}

/** The moment an AI edit is about to be applied: its answer arrived, or the user chose 套用 AI 修改 in the conflict dialog. */
export type EditMoment = 'answer' | 'conflict';

export type EditCheck = { ok: true } | { ok: false; message: string };

const EDIT_MESSAGES: Record<EditMoment, string> = {
  answer: '等待期間已換成另一個模型，這次修改沒有套用。',
  conflict: '目前顯示的已是另一個物件，這次 AI 修改沒有套用。',
};

/**
 * Whether an AI edit made for `targetObjectId` may still be applied
 * (requirement 32): the object must still exist and be the active one.
 */
export function canApplyEdit(workspace: Workspace, targetObjectId: string, when: EditMoment): EditCheck {
  if (findObject(workspace, targetObjectId) && workspace.activeObjectId === targetObjectId) return { ok: true };
  return { ok: false, message: EDIT_MESSAGES[when] };
}
