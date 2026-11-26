#!/usr/bin/env node
// Kiro "session-context" hook (trigger: SessionStart).
//
// Prints a short block (about 40 lines at most) that Kiro adds to the agent's
// context when a session starts: the last 5 commits, the open tasks of every
// spec, and how many files are uncommitted. It prints no file contents, no
// file names of uncommitted work and no absolute paths.
//
// Plain Node, no dependencies. The formatting is pure (`parseTasks`,
// `buildContext`); the git and file reads are in `collectInput`.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_LINES = 40;
const MAX_TITLE = 48;
const MAX_TASKS_PER_SPEC = 10;
const MAX_SUBJECT = 110;

// ---------------------------------------------------------------------------
// Text cleanup
// ---------------------------------------------------------------------------

/** Remove absolute paths and token-like strings so nothing sensitive reaches the agent. */
export function sanitize(text) {
  return String(text)
    .replace(/\b[A-Za-z]:[\\/][^\s"'`)\]]*/g, '<path>')
    .replace(/(^|[\s(])\/(?:home|Users|root|mnt)\/[^\s"'`)\]]*/g, '$1<path>')
    .replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '<redacted>');
}

function shorten(text, max) {
  const t = sanitize(text).replace(/`/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// ---------------------------------------------------------------------------
// tasks.md parsing
// ---------------------------------------------------------------------------

/** @typedef {{ id: string, title: string, status: 'todo' | 'doing' | 'done' }} SpecTask */

const HEADING_RE = /^##\s+Task\s+(\d+[A-Za-z]?)\b\s*(?:[—–:]|-+)?\s*(.*?)\s*$/;
// Status line right under a heading: `[ ]`, `[~]` or `[x]`, with optional backticks.
const STATUS_RE = /^[`*_\s]*\[( |~|-|x|X)\]/;
// Kiro's native checklist: "- [ ] 1. Title", "  - [x] 1.1 Title", "- [-] in progress", "- [ ]* optional".
const CHECKBOX_RE = /^\s*[-*]\s+\[( |~|-|x|X)\]\*?\s+(.*)$/;
const NUMBERED_RE = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/;

const statusOf = (mark) => (mark === 'x' || mark === 'X' ? 'done' : mark === '~' || mark === '-' ? 'doing' : 'todo');

/** Lines outside fenced code blocks, with their original index. */
function proseLines(markdown) {
  const out = [];
  let fence = null;
  String(markdown)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const m = /^\s*(```+|~~~+)/.exec(line);
      if (m) {
        if (!fence) fence = m[1][0];
        else if (m[1][0] === fence) fence = null;
        return;
      }
      if (!fence) out.push({ line, index });
    });
  return out;
}

/**
 * Tasks of one tasks.md. Two formats are understood:
 *  - this repo's "## Task N — title" headings followed by a `[ ]` / `[~]` / `[x]` status line;
 *  - Kiro's native checklist ("- [ ] 1. title").
 * When a file has Task headings, only the headings count (a native checklist at the
 * top of such a file is a pointer list, not a second set of tasks).
 * @returns {SpecTask[]}
 */
export function parseTasks(markdown) {
  const lines = proseLines(markdown);
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i].line);
    if (!h) continue;
    let status = 'todo';
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].line.trim()) continue;
      const s = STATUS_RE.exec(lines[j].line);
      if (s) status = statusOf(s[1]);
      break;
    }
    tasks.push({ id: h[1], title: h[2], status });
  }
  if (tasks.length) return tasks;

  let counter = 0;
  for (const { line } of lines) {
    const c = CHECKBOX_RE.exec(line);
    if (!c) continue;
    counter += 1;
    const n = NUMBERED_RE.exec(c[2].trim());
    tasks.push({ id: n ? n[1] : String(counter), title: n ? n[2] : c[2].trim(), status: statusOf(c[1]) });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * @param {{ commits: string[], specs: { name: string, tasks: SpecTask[] }[], uncommitted: number | null }} input
 * @returns {string}
 */
export function buildContext({ commits, specs, uncommitted }) {
  const lines = ['Forgehand session context (summary printed by the session-context hook):'];

  lines.push(commits.length ? `Last ${commits.length} commits:` : 'Last commits: not available.');
  for (const c of commits) lines.push(`  ${shorten(c, MAX_SUBJECT)}`);

  lines.push(
    uncommitted === null
      ? 'Uncommitted files: unknown (git not available).'
      : `Uncommitted files: ${uncommitted}. Other sessions may be working in the same tree, so check git status before editing a file.`,
  );

  const open = [];
  const finished = [];
  for (const spec of specs) {
    const notDone = spec.tasks.filter((t) => t.status !== 'done');
    if (spec.tasks.length && !notDone.length) finished.push(spec.name);
    else open.push({ spec, notDone });
  }

  lines.push('Spec tasks not done (T<n> = task number; "[~]" = in progress):');
  if (!open.length) lines.push('  none');
  const room = MAX_LINES - lines.length - (finished.length ? 1 : 0);
  const visible = open.length <= room ? open : open.slice(0, Math.max(room - 1, 0));
  for (const { spec, notDone } of visible) {
    if (!spec.tasks.length) {
      lines.push(`  ${spec.name}: no tasks listed yet`);
    } else {
      const shown = notDone
        .slice(0, MAX_TASKS_PER_SPEC)
        .map((t) => `T${t.id} ${t.status === 'doing' ? '[~] ' : ''}${shorten(t.title, MAX_TITLE)}`);
      const more = notDone.length > shown.length ? `; +${notDone.length - shown.length} more` : '';
      lines.push(`  ${spec.name} (${spec.tasks.length - notDone.length}/${spec.tasks.length} done): ${shown.join('; ')}${more}`);
    }
  }
  if (visible.length < open.length) lines.push(`  … and ${open.length - visible.length} more specs with open tasks`);
  if (finished.length) lines.push(`Specs with every task done: ${finished.join(', ')}`);

  return lines.slice(0, MAX_LINES).join('\n');
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG_FILE = process.env.SESSION_CONTEXT_LOG || path.join(REPO_ROOT, 'artifacts', 'local', 'hook-log.jsonl');

function git(args, root) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Read git and the specs folder. Returns the input of `buildContext`. */
export function collectInput(root = REPO_ROOT) {
  const log = git(['log', '-5', '--format=%h %s'], root);
  const status = git(['status', '--porcelain', '--untracked-files=all'], root);
  const specsDir = path.join(root, '.kiro', 'specs');
  const specs = [];
  if (existsSync(specsDir)) {
    const names = readdirSync(specsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const name of names) {
      const file = path.join(specsDir, name, 'tasks.md');
      let tasks = [];
      try {
        tasks = parseTasks(readFileSync(file, 'utf8'));
      } catch {
        // No tasks.md yet: the spec is listed as having no tasks.
      }
      specs.push({ name, tasks });
    }
  }
  return {
    commits: log ? log.split(/\r?\n/).filter(Boolean) : [],
    specs,
    uncommitted: status === null ? null : status.split(/\r?\n/).filter(Boolean).length,
  };
}

function writeLog(entry) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never break the hook.
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = null;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    // The payload is only logged (keys), never needed.
  }
  const isObject = payload !== null && typeof payload === 'object' && !Array.isArray(payload);

  let text = '';
  let failure;
  let input = { commits: [], specs: [], uncommitted: null };
  try {
    input = collectInput();
    text = buildContext(input);
  } catch (err) {
    failure = err instanceof Error ? err.name : 'error';
  }

  // Counts and key names only: no commit subjects, file names or contents.
  writeLog({
    time: new Date().toISOString(),
    hook: 'session-context',
    event: isObject ? payload.hook_event_name ?? null : null,
    payloadKeys: isObject ? Object.keys(payload) : [],
    lines: text ? text.split('\n').length : 0,
    commits: input.commits.length,
    specs: input.specs.length,
    uncommitted: input.uncommitted,
    ...(failure ? { failure } : {}),
  });

  // Exit 0 always: a failure here must not disturb the session.
  if (text) process.stdout.write(`${text}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
