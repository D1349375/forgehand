import type { DetailMode } from '../../shared/edit';

/**
 * The detail mode as a browser setting (design-fidelity R23): it belongs to the user, not to one design, so
 * it is stored in `localStorage` and not in the workspace, and a change is not an undo step. Same pattern as
 * `src/joints/printer-store.ts`: the functions take a `Storage`-like object, so tests need no DOM.
 */
export const DETAIL_MODE_STORAGE_KEY = 'forgehand.detailMode';
export const DEFAULT_DETAIL_MODE: DetailMode = 'concept';

export type ReadableStorage = Pick<Storage, 'getItem'>;
export type WritableStorage = Pick<Storage, 'setItem'>;

/** True for the two valid values. */
export const isDetailMode = (value: unknown): value is DetailMode => value === 'concept' || value === 'detailed';

/** The stored mode, or concept when nothing valid is stored (missing, invalid, unreadable, no storage). */
export function loadDetailMode(storage: ReadableStorage | null | undefined): DetailMode {
  try {
    const value = storage?.getItem(DETAIL_MODE_STORAGE_KEY);
    return isDetailMode(value) ? value : DEFAULT_DETAIL_MODE;
  } catch {
    return DEFAULT_DETAIL_MODE;
  }
}

/** Stores the mode. A full or blocked storage is ignored: the choice then lasts for the page session only. */
export function saveDetailMode(storage: WritableStorage | null | undefined, mode: DetailMode): void {
  try {
    if (isDetailMode(mode)) storage?.setItem(DETAIL_MODE_STORAGE_KEY, mode);
  } catch {
    // Not persisted; the mode in memory still applies.
  }
}
