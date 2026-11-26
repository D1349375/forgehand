import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, from this file's place (tests/unit). */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Source files under a folder, as paths relative to the root with forward slashes, sorted. A missing folder gives []. */
export function filesUnder(folder: string, extensions: readonly string[]): string[] {
  const start = join(ROOT, folder);
  if (!existsSync(start)) return [];
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some(extension => entry.name.endsWith(extension))) found.push(relative(ROOT, full).split('\\').join('/'));
    }
  };
  walk(start);
  return found.sort();
}

/**
 * Area text modules that other specs created and a later english-ui task converted in place
 * (`src/workbench/text.ts`, `shared/fidelity-text.ts`, `shared/fit-text.ts`, the `TEXT` constant of a
 * tool file; english-ui R53). The task that converts a module adds its path here.
 */
export const CONVERTED_TABLE_FILES: readonly string[] = [];

/**
 * Every file whose Chinese text is allowed and checked as a table: all of `src/i18n/`, `shared/i18n/`
 * and `server/i18n/`, plus the converted modules above. The stray-string scan skips these files;
 * the table test imports them and checks every table they export.
 */
export const TABLE_FILES: readonly string[] = [
  ...['src/i18n', 'shared/i18n', 'server/i18n'].flatMap(folder => filesUnder(folder, ['.ts', '.tsx'])),
  ...CONVERTED_TABLE_FILES,
].sort();
