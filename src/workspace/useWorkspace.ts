import { useCallback, useRef, useState } from 'react';
import type { Workspace } from '../../shared/workspace';
import { canRedo, canUndo, initialWorkspaceState, workspaceReducer, type WorkspaceAction, type WorkspaceState } from './store';

/**
 * The workspace store as a hook. The state lives in a ref so async code (an AI
 * answer, an agent event) reads and writes the latest value synchronously; the
 * state setter only triggers the render.
 */
export function useWorkspace() {
  const stateRef = useRef<WorkspaceState>(initialWorkspaceState);
  const [state, setState] = useState<WorkspaceState>(initialWorkspaceState);

  /** Runs the reducer and returns the new workspace at once. */
  const dispatch = useCallback((action: WorkspaceAction): Workspace => {
    const next = workspaceReducer(stateRef.current, action);
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
    return next.workspace;
  }, []);
  /** The latest workspace, for async callbacks. */
  const current = useCallback((): Workspace => stateRef.current.workspace, []);

  return { workspace: state.workspace, canUndo: canUndo(state), canRedo: canRedo(state), dispatch, current };
}
