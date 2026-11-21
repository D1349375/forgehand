import { StateChangeSchema } from '../../shared/agent';
import type { ExportScope } from '../../shared/export-plan';
import { WorkspaceError, applyWorkspaceChange, type Workspace } from '../../shared/workspace';

/** What the caller should apply for one `state` event. */
export interface StateEffects {
  /** The workspace after the event's activation step: the undo snapshot when `recordUndo` is true. */
  before: Workspace;
  /** The workspace the event leads to. */
  after: Workspace;
  /** True only when the event changed an object (add, model, transform, material or remove) or a joint (add, update or remove); selection, explode and activation are not undo steps. */
  recordUndo: boolean;
  /** Present only when the event sets the try-on flag. */
  tryOn?: boolean;
  /** Present only when the event asks to open the export dialog. Session state like `tryOn`: never an undo step. */
  exportDialog?: ExportScope;
  /** Present only when the event hides (true) or shows (false) the camera image. Session state like `tryOn`: never an undo step. */
  cameraHidden?: boolean;
}

/**
 * Turns a `state` event payload into the workspaces to apply. The server builds
 * the whole change, so an `add` adds exactly the received object: nothing here
 * creates ids, timestamps or placement. Returns `null` when the payload does
 * not parse or the workspace rejects the change (the change is dropped).
 */
export function applyStateEvent(payload: unknown, workspace: Workspace): StateEffects | null {
  const parsed = StateChangeSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { tryOn, exportDialog, cameraHidden, ...change } = parsed.data;
  try {
    const { before, after } = applyWorkspaceChange(workspace, change);
    const effects: StateEffects = { before, after, recordUndo: change.object !== null || (change.joint ?? null) !== null };
    if (tryOn !== null) effects.tryOn = tryOn;
    if (exportDialog) effects.exportDialog = exportDialog;
    if (typeof cameraHidden === 'boolean') effects.cameraHidden = cameraHidden;
    return effects;
  } catch (cause) {
    if (cause instanceof WorkspaceError) return null;
    throw cause;
  }
}
