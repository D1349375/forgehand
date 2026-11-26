import { WorkspaceError, findObject, replaceModel, type Workspace } from '../../shared/workspace';

/**
 * Pure helpers for the 物件 panel. No DOM, no state.
 */

/** Longest object name; the same limit as every model and part name. */
export const OBJECT_NAME_MAX = 500;

export interface ObjectRow { id: string; name: string; partCount: number; active: boolean }

/** One row per object, in workspace order (the order of `workspace.objects`). */
export function objectRows(workspace: Pick<Workspace, 'objects' | 'activeObjectId'>): ObjectRow[] {
  return workspace.objects.map(object => ({
    id: object.id,
    name: object.model.name,
    partCount: object.model.parts.length,
    active: object.id === workspace.activeObjectId,
  }));
}

/**
 * Renames an object by changing `model.name` (nothing else). The text is
 * trimmed; empty or over-long names throw an `Error` with a Traditional Chinese
 * message. An unchanged name returns the same workspace, so it is no undo step.
 */
export function renameObject(workspace: Workspace, id: string, text: string): Workspace {
  const name = text.trim();
  if (!name) throw new Error('物件名稱不能是空的。');
  if (name.length > OBJECT_NAME_MAX) throw new Error(`物件名稱最多 ${OBJECT_NAME_MAX} 個字。`);
  const object = findObject(workspace, id);
  if (!object) throw new WorkspaceError('UNKNOWN_OBJECT');
  if (object.model.name === name) return workspace;
  return replaceModel(workspace, id, { ...object.model, name });
}
