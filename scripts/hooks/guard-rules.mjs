#!/usr/bin/env node
// Kiro "guard-rules" hook (trigger: PreToolUse).
//
// Reads the hook event JSON from STDIN, applies the six project rules and
// denies a tool call by exiting with code 2 and writing the reason to STDERR
// (Kiro blocks the call and shows STDERR to the agent).
//
// Plain Node, no dependencies, so it starts fast on every tool call.
// The decision logic is the pure function `evaluate()`; everything else is I/O.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const PREFIX = 'Blocked by the guard-rules hook';

const RULES = {
  'gitignore-kiro': `${PREFIX} (rule 1): adding .kiro to a .gitignore disqualifies the Kiroween entry, so the .kiro folder must stay tracked.`,
  'prior-work': `${PREFIX} (rule 2): docs/PRIOR_WORK.md is the pre-Kiro work disclosure and only the user may edit or delete it.`,
  'env-file': `${PREFIX} (rule 3): .env files hold secrets and must not be read or written, so use .env.example for documentation.`,
  'model-quota': `${PREFIX} (rule 4): verify:real and verify:edit spend real model quota, so ask the user to run them personally.`,
  install: `${PREFIX} (rule 5): downloading browsers or adding packages needs the user's approval, so ask first (plain npm install and npm ci are allowed).`,
  'git-guard': `${PREFIX} (rule 6): this git command is run by the reviewer or can destroy work, so do not run it (git status, diff, log and show are allowed).`,
};

export const RULE_IDS = Object.keys(RULES);

const ALLOW = Object.freeze({ decision: 'allow' });
const deny = (rule) => ({ decision: 'deny', rule, reason: RULES[rule] });

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Lower-cased last path component; handles both separators and Windows quirks. */
function baseName(p) {
  const s = String(p).trim().replace(/::\$data$/i, '');
  const last = s.split(/[\\/]/).pop() ?? '';
  return last.replace(/[. ]+$/, '').toLowerCase(); // Windows ignores trailing dots and spaces
}

function isEnvFile(p) {
  const n = baseName(p);
  return /^\.env(\..+)?$/.test(n) && n !== '.env.example';
}

const isPriorWork = (p) => baseName(p) === 'prior_work.md';
const isGitignore = (p) => baseName(p) === '.gitignore';

// ---------------------------------------------------------------------------
// .gitignore content check (rule 1)
// ---------------------------------------------------------------------------

function globToRegExp(glob) {
  let re = '';
  for (const c of glob) {
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** True if any pattern line in `text` would make git ignore `.kiro` or something under it. */
export function ignoresKiro(text) {
  for (const rawLine of String(text).split(/\r?\n/)) {
    for (const candidate of [rawLine, rawLine.replace(/^\+/, '')]) {
      const line = candidate.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const segments = line.replace(/^\/+/, '').split('/').filter(Boolean);
      if (segments.some((s) => s.toLowerCase() === '.kiro')) return true;
      // A single-segment wildcard such as `.k*` or `*` also matches `.kiro`.
      if (segments.length === 1 && /[*?]/.test(segments[0]) && globToRegExp(segments[0]).test('.kiro')) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shell command parsing
// ---------------------------------------------------------------------------

/** Split a command line on unquoted ; | & newline ( ) { } and backticks. */
function splitSegments(cmd) {
  const segments = [];
  let cur = '';
  let quote = null;
  const flush = () => {
    if (cur.trim()) segments.push(cur);
    cur = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (';|\n\r(){}`'.includes(c)) {
      flush();
    } else if (c === '&') {
      if (cmd[i - 1] === '>' || cmd[i + 1] === '>') cur += c; // 2>&1, &>
      else flush();
    } else {
      cur += c;
    }
  }
  flush();
  return segments;
}

/** Whitespace tokenizer that removes quotes. Backslashes are literal (Windows paths). */
function tokenize(segment) {
  const out = [];
  let cur = '';
  let has = false;
  let quote = null;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const cmdName = (tok) =>
  String(tok)
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1|com)$/, '');

const WRAPPERS = new Set(['sudo', 'env', 'call', 'command', 'time', 'nohup', 'exec', 'cross-env', 'start']);

/** Drop leading `VAR=value` words and transparent wrapper commands (and their flags). */
function skipWrappers(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++;
    else if (WRAPPERS.has(cmdName(t))) {
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
    } else break;
  }
  return tokens.slice(i);
}

const stripRedirect = (t) => t.replace(/^[\d&*]*[<>]+/, '');

/** Candidate path strings inside one shell token (`--env-file=.env`, `-Path:.env`, `>.env`). */
function tokenPaths(t) {
  const s = stripRedirect(t);
  const parts = [s, s.split(/[=:]/).pop() ?? s];
  return parts;
}

// ---- write detection (rules 1 and 2 in shell commands) ---------------------

const MUTATORS = new Set([
  'rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri',
  'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni',
  'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc',
  'out-file', 'tee', 'tee-object', 'new-item', 'ni', 'truncate', 'sponge',
]);
const COPIERS = new Set(['cp', 'copy', 'copy-item', 'cpi']);

/** Does this single shell segment write to / delete a file for which `pred(path)` is true? */
function segmentWrites(rawSegment, tokens, target) {
  // Redirections: `> file`, `>> file`, `2> file`, `>file`.
  for (let i = 0; i < tokens.length; i++) {
    const m = /^[\d&*]*>>?(.*)$/.exec(tokens[i]);
    if (m) {
      const tgt = m[1] || tokens[i + 1] || '';
      if (target.pred(tgt)) return true;
    }
  }
  const t = skipWrappers(tokens);
  if (!t.length) return false;
  const name = cmdName(t[0]);
  const args = t.slice(1).map(stripRedirect);
  const positional = args.filter((a) => !a.startsWith('-'));
  if (MUTATORS.has(name)) return args.some((a) => target.pred(a));
  if (COPIERS.has(name)) return positional.length > 0 && target.pred(positional[positional.length - 1]);
  if ((name === 'sed' || name === 'perl') && args.some((a) => /^-[a-z]*i/i.test(a))) return args.some((a) => target.pred(a));
  if (name === 'git' && args.some((a) => a === 'rm' || a === 'mv')) return args.some((a) => target.pred(a));
  return false;
}

/** PowerShell / .NET static calls such as [IO.File]::WriteAllText('...'). Tested on the whole line because `(` splits segments. */
const STATIC_WRITE_RE = /\b(WriteAll\w*|AppendAll\w*|Delete|Move|Copy|Replace)\s*\(/i;
const staticWrite = (command, target) => target.rawRe.test(command) && STATIC_WRITE_RE.test(command);

const GITIGNORE_TARGET = { pred: isGitignore, rawRe: /\.gitignore/i };
const PRIOR_WORK_TARGET = { pred: isPriorWork, rawRe: /prior_work\.md/i };

// ---- package managers / runners -------------------------------------------

const NPM_VALUE_FLAGS = new Set([
  '--prefix', '--workspace', '-w', '--registry', '--loglevel', '--cache', '--userconfig',
  '--omit', '--include', '--tag', '--otp', '--scope', '--install-strategy', '--save-prefix',
]);
const VALUE_FLAGS = {
  npm: NPM_VALUE_FLAGS,
  pnpm: new Set(['-C', '--dir', '--filter', '-F', '--registry', '--loglevel', '--reporter', '--workspace-concurrency']),
  yarn: new Set(['--cwd', '--registry', '--modules-folder', '--network-timeout']),
  bun: new Set(['--cwd', '--registry', '-c', '--config']),
};
const INSTALL_ALIASES = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isntall', 'isntal']);
const EXEC_SUBS = {
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['exec', 'dlx', 'x']),
  yarn: new Set(['dlx', 'exec']),
  bun: new Set(['x']),
};
const PACKAGE_MANAGERS = new Set(Object.keys(VALUE_FLAGS));
const EXEC_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const SCRIPT_RUNNERS = new Set([
  'tsx', 'node', 'ts-node', 'ts-node-esm', 'bun', 'deno', 'vite-node', 'esno', 'tsm', 'nodemon', 'jiti',
]);
const VERIFY_SCRIPT_RE = /(^|[\\/])verify-real-[\w.-]*\.(ts|mts|cts|js|mjs|cjs)$/i;

/** First non-flag token (skipping flags that take a value) and everything after it. */
function firstPositional(args, valueFlags) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return args[i + 1] === undefined ? null : { sub: args[i + 1], rest: args.slice(i + 2) };
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    return { sub: a, rest: args.slice(i + 1) };
  }
  return null;
}

function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** For `npx ...`, `npm exec ...`, `pnpm dlx ...`: find the program being run. */
function unwrapExec(rest) {
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-c' || a === '--call') return { inner: rest.slice(i + 1).join(' ') };
    if (['-p', '--package', '-w', '--workspace', '--prefix', '--cwd', '--filter', '-F'].includes(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    break;
  }
  const first = rest[i];
  if (first === undefined) return { tokens: [] };
  const pkg = first.replace(/(?<=.)@[^/@]*$/, ''); // drop a trailing @version
  return { tokens: [pkg, ...rest.slice(i + 1)] };
}

function runUnwrapped(u, depth) {
  if (u.inner !== undefined) return checkShell(u.inner, depth + 1);
  return checkTokens(u.tokens, depth + 1);
}

function isPlaywright(first) {
  const f = String(first).toLowerCase();
  return f === '@playwright/test' || f === 'playwright-core' || cmdName(f) === 'playwright';
}

function gitSubcommand(args) {
  const withValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (withValue.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    return { sub: a.toLowerCase(), rest: args.slice(i + 1) };
  }
  return null;
}

const GIT_BLOCKED = new Set(['commit', 'push', 'reset', 'restore', 'stash', 'clean', 'rebase']);

// ---- core checks ------------------------------------------------------------

/** Check one tokenized simple command. Returns a deny result or null. */
function checkTokens(tokensIn, depth) {
  if (depth > 4) return null;
  const tokens = skipWrappers(tokensIn);
  if (!tokens.length) return null;
  const name = cmdName(tokens[0]);
  const args = tokens.slice(1);

  // Shells that run a command string: check the string itself.
  if (name === 'cmd') {
    const i = args.findIndex((a) => /^\/[ckr]$/i.test(a));
    if (i >= 0) return checkShell(args.slice(i + 1).join(' '), depth + 1);
  }
  if (name === 'powershell' || name === 'pwsh') {
    const i = args.findIndex((a) => /^-c(ommand)?$/i.test(a));
    if (i >= 0) return checkShell(args.slice(i + 1).join(' '), depth + 1);
    const firstFree = args.findIndex((a) => !a.startsWith('-'));
    if (firstFree >= 0) return checkShell(args.slice(firstFree).join(' '), depth + 1);
  }
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(name)) {
    const i = args.findIndex((a) => /^-[a-z]*c$/i.test(a));
    if (i >= 0) return checkShell(args.slice(i + 1).join(' '), depth + 1);
  }
  if (name === 'wsl') return checkTokens(args.filter((a, i) => !(a.startsWith('-') && i === 0)), depth + 1);
  if (name === 'invoke-expression' || name === 'iex' || name === 'eval') return checkShell(args.join(' '), depth + 1);

  if (name === 'git') {
    const g = gitSubcommand(args);
    if (!g) return null;
    if (GIT_BLOCKED.has(g.sub)) return deny('git-guard');
    if (g.sub === 'checkout') {
      const createsBranch = ['-b', '-B', '--orphan'].includes(g.rest[0]) && !g.rest.includes('--');
      if (!createsBranch) return deny('git-guard');
    }
    return null;
  }

  if (EXEC_RUNNERS.has(name)) return runUnwrapped(unwrapExec(args), depth);

  if (isPlaywright(tokens[0])) {
    const p = firstPositional(args, new Set());
    if (p && p.sub.toLowerCase().startsWith('install')) return deny('install');
    return null;
  }

  if (PACKAGE_MANAGERS.has(name)) {
    if (args.some((a) => /^verify:(real|edit)$/i.test(a))) return deny('model-quota');
    if (args.some((a) => VERIFY_SCRIPT_RE.test(a))) return deny('model-quota');
    const vf = VALUE_FLAGS[name];
    const p = firstPositional(args, vf);
    if (!p) return null;
    let sub = p.sub.toLowerCase();
    let rest = p.rest;
    if (name === 'yarn' && sub === 'global') {
      const q = firstPositional(rest, vf);
      if (q) {
        sub = q.sub.toLowerCase();
        rest = q.rest;
      }
    }
    if (sub === 'add' || (name === 'bun' && sub === 'a')) return deny('install');
    if (INSTALL_ALIASES.has(sub) && positionals(rest, vf).length > 0) return deny('install');
    if (EXEC_SUBS[name]?.has(sub)) return runUnwrapped(unwrapExec(rest), depth);
    if (name !== 'npm' && isPlaywright(sub)) return checkTokens([sub, ...rest], depth + 1);
    return null;
  }

  if (SCRIPT_RUNNERS.has(name)) {
    if (args.some((a) => VERIFY_SCRIPT_RE.test(a))) return deny('model-quota');
    const i = args.findIndex((a) => /^(-e|-p|--eval|--print)$/.test(a));
    if (i >= 0 && /verify-real-/i.test(args.slice(i + 1).join(' '))) return deny('model-quota');
  }
  return null;
}

/** Check one segment against rule 3 (env), rule 2 (prior work) and the command rules. */
function checkSegment(raw, tokens, depth) {
  if (tokens.some((t) => tokenPaths(t).some(isEnvFile))) return deny('env-file');
  if (segmentWrites(raw, tokens, PRIOR_WORK_TARGET)) return deny('prior-work');
  return checkTokens(tokens, depth);
}

/** Check a whole shell command line. Returns a deny result or null. */
export function checkShell(command, depth = 0) {
  if (depth > 4 || typeof command !== 'string') return null;
  let gitignoreWritten = false;
  for (const seg of splitSegments(command)) {
    const tokens = tokenize(seg);
    if (!tokens.length) continue;
    const r = checkSegment(seg, tokens, depth);
    if (r) return r;
    if (segmentWrites(seg, tokens, GITIGNORE_TARGET)) gitignoreWritten = true;
  }
  // `$(...)` inside double quotes is not split above.
  for (const m of command.matchAll(/\$\(([^()]*)\)/g)) {
    const r = checkShell(m[1], depth + 1);
    if (r) return r;
  }
  // The text being appended may sit in an earlier pipeline segment, so test the whole line.
  if (staticWrite(command, PRIOR_WORK_TARGET)) return deny('prior-work');
  if ((gitignoreWritten || staticWrite(command, GITIGNORE_TARGET)) && /\.kiro/i.test(command)) return deny('gitignore-kiro');
  return null;
}

// ---------------------------------------------------------------------------
// Tool input inspection (non-shell tools)
// ---------------------------------------------------------------------------

const PATH_KEY_RE =
  /^(path|paths|file|files|filepath|filepaths|file_path|filename|target|targetfile|targetpath|dest|destination|source|src|from|to|oldpath|newpath|old_path|new_path|uri)$/i;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Strings found under path-like keys, at any depth. */
function collectPaths(value, underPathKey = false, depth = 0, out = []) {
  if (depth > 6) return out;
  if (typeof value === 'string') {
    if (underPathKey) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, underPathKey, depth + 1, out);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) collectPaths(v, PATH_KEY_RE.test(k), depth + 1, out);
  }
  return out;
}

/** Strings that are not paths and not the "old" side of a replacement: the content being written. */
function collectContent(value, depth = 0, out = []) {
  if (depth > 6) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectContent(v, depth + 1, out);
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (PATH_KEY_RE.test(k) || /^old/i.test(k)) continue;
      collectContent(v, depth + 1, out);
    }
  }
  return out;
}

/** Read-only tools may mention protected files; everything else is treated as a write. */
function isReadOnlyTool(toolName) {
  const n = String(toolName).toLowerCase().replace(/[^a-z]/g, '');
  return /^(fs)?(read|grep|search|filesearch|list|get|find|view|open)/.test(n);
}

// ---------------------------------------------------------------------------
// Public decision function
// ---------------------------------------------------------------------------

/**
 * @param {{ toolName?: string, toolInput?: unknown }} call
 * @returns {{ decision: 'allow' } | { decision: 'deny', rule: string, reason: string }}
 */
export function evaluate(call) {
  const toolName = String(call?.toolName ?? '');
  const input = isObject(call?.toolInput) ? call.toolInput : {};
  const paths = collectPaths(input);

  // Rule 3: .env files, any tool, read or write.
  if (paths.some(isEnvFile)) return deny('env-file');

  // Rules 1, 2, 4, 5, 6: shell commands.
  if (typeof input.command === 'string') {
    const r = checkShell(input.command);
    if (r) return r;
  }

  // Rules 1 and 2: file tools that write.
  if (!isReadOnlyTool(toolName)) {
    if (paths.some(isPriorWork)) return deny('prior-work');
    if (paths.some(isGitignore) && collectContent(input).some(ignoresKiro)) return deny('gitignore-kiro');
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// GUARD_RULES_LOG overrides the log path (used by the unit tests).
const LOG_FILE = process.env.GUARD_RULES_LOG || path.join(REPO_ROOT, 'artifacts', 'local', 'hook-log.jsonl');

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
  let parseError = false;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    parseError = true;
  }

  let result = ALLOW;
  let failure;
  try {
    if (isObject(payload)) {
      result = evaluate({
        toolName: payload.tool_name ?? payload.toolName,
        toolInput: payload.tool_input ?? payload.toolInput,
      });
    }
  } catch (err) {
    // Fail open on a bug in the guard itself; the log records it.
    failure = err instanceof Error ? err.name : 'error';
  }

  // Keys only, never values: no file contents, commands or secrets in the log.
  writeLog({
    time: new Date().toISOString(),
    event: isObject(payload) ? payload.hook_event_name ?? null : null,
    tool: isObject(payload) ? payload.tool_name ?? payload.toolName ?? null : null,
    decision: result.decision,
    rule: result.rule ?? null,
    payloadKeys: isObject(payload) ? Object.keys(payload) : [],
    inputKeys: isObject(payload) && isObject(payload.tool_input) ? Object.keys(payload.tool_input) : [],
    ...(parseError ? { parseError: true } : {}),
    ...(failure ? { failure } : {}),
  });

  if (result.decision === 'deny') {
    process.stderr.write(`${result.reason}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
