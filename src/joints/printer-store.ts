import { DEFAULT_PRINTER_PROFILE, PrinterProfileSchema, type PrinterProfile } from '../../shared/printer';

/**
 * The printer profile as a browser setting (assembly-joints requirement 19): it belongs to the
 * user's printer, not to one design, so it is stored in `localStorage` and not in the
 * workspace, and a change is not an undo step. Takes a `Storage`-like object so tests need no DOM.
 */

export const PRINTER_STORAGE_KEY = 'forgehand.printer.v1';

export type ReadableStorage = Pick<Storage, 'getItem'>;
export type WritableStorage = Pick<Storage, 'setItem'>;

/** The stored profile, or the defaults when nothing valid is stored (missing, not JSON, wrong shape, out of range, no storage). */
export function loadPrinterProfile(storage: ReadableStorage | null | undefined): PrinterProfile {
  try {
    const text = storage?.getItem(PRINTER_STORAGE_KEY);
    if (!text) return DEFAULT_PRINTER_PROFILE;
    const parsed = PrinterProfileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : DEFAULT_PRINTER_PROFILE;
  } catch {
    return DEFAULT_PRINTER_PROFILE;
  }
}

/** Stores the profile. A full or blocked storage is ignored: the setting then lasts for the session only. */
export function savePrinterProfile(storage: WritableStorage | null | undefined, profile: PrinterProfile): void {
  try {
    storage?.setItem(PRINTER_STORAGE_KEY, JSON.stringify(PrinterProfileSchema.parse(profile)));
  } catch {
    // Not persisted; the profile in memory still applies.
  }
}
