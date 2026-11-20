import { zipSync, type Zippable } from 'fflate';
import { formatStamp } from './format';

export interface KitFile {
  path: string;
  bytes: Uint8Array;
  mime: string;
}

const KIT_PATH = /^[A-Za-z0-9._/-]+$/;

function checkEntryPath(path: string): void {
  if (path === '') throw new Error('Zip entry path is empty.');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Zip entry path is not a plain relative path: ${JSON.stringify(path)}`);
  }
  // fflate flattens the entries into plain objects, where this key would replace the prototype instead of adding an entry.
  if (segments.includes('__proto__')) throw new Error(`Zip entry path is not allowed: ${JSON.stringify(path)}`);
  // An all-digit name is an array index, and object keys with that shape are enumerated first, which would change the entry order.
  if (/^\d+$/.test(path)) throw new Error(`Zip entry path must not be only digits: ${JSON.stringify(path)}`);
}

/**
 * Writes entries in the given order with a fixed modification time. Paths are not restricted to the kit's ASCII set
 * (the 3MF package needs `[Content_Types].xml`); use `zipFiles` for kit files. Entries are deflated, except
 * `stored` ones (level 0). The same input gives the same bytes.
 */
export function zipEntries(entries: ReadonlyArray<{ path: string; bytes: Uint8Array; stored?: boolean }>, mtime: Date): Uint8Array {
  const zippable: Zippable = {};
  for (const entry of entries) {
    checkEntryPath(entry.path);
    if (Object.hasOwn(zippable, entry.path)) throw new Error(`Duplicate zip entry: ${JSON.stringify(entry.path)}`);
    zippable[entry.path] = [entry.bytes, entry.stored ? { level: 0, mtime } : { mtime }];
  }
  return zipSync(zippable);
}

/** Zips kit files. Paths must be ASCII (`A-Za-z0-9._/-`) so no file name depends on a text encoding; PNG entries are stored. */
export function zipFiles(files: readonly KitFile[], mtime: Date): Uint8Array {
  for (const file of files) {
    if (!KIT_PATH.test(file.path)) throw new Error(`Kit file path must be ASCII: ${JSON.stringify(file.path)}`);
  }
  return zipEntries(files.map((file) => ({ path: file.path, bytes: file.bytes, stored: file.mime === 'image/png' })), mtime);
}

/** `forgehand-kit-yyyyMMdd-HHmm.zip` in local time. */
export function kitZipName(exportedAt: Date): string {
  return `forgehand-kit-${formatStamp(exportedAt)}.zip`;
}
