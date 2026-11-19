import { emptyWorkspace, type Workspace, type WorkspaceSelection } from '../../shared/workspace';

/**
 * Browser workspace state and undo history. Pure: no React, no DOM.
 *
 * Undo steps are exactly the `commit` actions. Switching the active object,
 * selection and explode use `replace` and are not undo steps.
 */

export const HISTORY_LIMIT = 50;

/** What an undo step remembers. `objects` and `joints` are shared with the workspace they came from, never copied. */
export type Snapshot = Pick<Workspace, 'objects' | 'activeObjectId' | 'joints'>;

export interface WorkspaceState {
  workspace: Workspace;
  past: Snapshot[];
  future: Snapshot[];
}

export type WorkspaceAction =
  /** An undo step. `before` defaults to the current workspace. */
  | { type: 'commit'; next: Workspace; before?: Workspace }
  /** A change that is not an undo step: activation, selection, explode, render fallback. */
  | { type: 'replace'; next: Workspace }
  | { type: 'undo' }
  | { type: 'redo' };

export const initialWorkspaceState: WorkspaceState = { workspace: emptyWorkspace(), past: [], future: [] };

const EMPTY_SELECTION: WorkspaceSelection = { objectId: null, partIds: [] };

const snapshotOf = (ws: Workspace): Snapshot => ({ objects: ws.objects, activeObjectId: ws.activeObjectId, joints: ws.joints });

/**
 * The workspace for a snapshot, keeping the current selection and explode only
 * when the active object is the same. Kept selection holds only part ids that
 * still exist in the restored active object.
 */
export function restoreSnapshot(current: Workspace, snapshot: Snapshot): Workspace {
  const active = snapshot.activeObjectId === null ? null : snapshot.objects.find(object => object.id === snapshot.activeObjectId) ?? null;
  const sameActive = active !== null && current.activeObjectId === snapshot.activeObjectId;
  let selection: WorkspaceSelection = EMPTY_SELECTION;
  if (sameActive && active && current.selection.objectId === active.id) {
    const known = new Set(active.model.parts.map(part => part.id));
    const kept = current.selection.partIds.filter(id => known.has(id));
    if (kept.length === current.selection.partIds.length) selection = current.selection;
    else if (kept.length > 0) selection = { objectId: active.id, partIds: kept };
  }
  return {
    ...current,
    objects: snapshot.objects,
    activeObjectId: snapshot.activeObjectId,
    joints: snapshot.joints,
    selection,
    display: sameActive ? current.display : { explode: 0 },
  };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'commit': {
      if (action.next === state.workspace) return state;
      const before = action.before ?? state.workspace;
      const firstObject = before.objects.length === 0 && state.past.length === 0;
      return {
        workspace: action.next,
        past: firstObject ? state.past : [...state.past, snapshotOf(before)].slice(-HISTORY_LIMIT),
        future: [],
      };
    }
    case 'replace':
      return action.next === state.workspace ? state : { ...state, workspace: action.next };
    case 'undo': {
      const target = state.past.at(-1);
      if (!target) return state;
      return {
        workspace: restoreSnapshot(state.workspace, target),
        past: state.past.slice(0, -1),
        future: [snapshotOf(state.workspace), ...state.future].slice(0, HISTORY_LIMIT),
      };
    }
    case 'redo': {
      const target = state.future[0];
      if (!target) return state;
      return {
        workspace: restoreSnapshot(state.workspace, target),
        past: [...state.past, snapshotOf(state.workspace)].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
      };
    }
  }
}

export const canUndo = (state: WorkspaceState): boolean => state.past.length > 0;
export const canRedo = (state: WorkspaceState): boolean => state.future.length > 0;
