#!/usr/bin/env node
// Rebuilds .kiro/ledger/README.md from `git log`.
// Usage (no npm needed):  node scripts/kiro-ledger.mjs
// Only reads git; the only file it writes is .kiro/ledger/README.md.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_FORMAT, parseLog, renderLedger } from './hooks/ledger.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let log;
try {
  log = execFileSync('git', ['-c', 'core.quotepath=off', 'log', `--format=${LOG_FORMAT}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch {
  console.error('kiro-ledger: could not read git log (is this a git checkout with at least one commit?).');
  process.exit(1);
}

const parsed = parseLog(log);
const file = path.join(root, '.kiro', 'ledger', 'README.md');
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, renderLedger(parsed), 'utf8');
console.log(`kiro-ledger: wrote .kiro/ledger/README.md (${parsed.taskCommits.length} task commits, ${parsed.specCommits.length} spec commits).`);
