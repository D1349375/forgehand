import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_LINES, buildContext, collectInput, parseTasks, sanitize } from '../../scripts/hooks/session-context.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'session-context-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('parseTasks: "## Task N" headings', () => {
  const md = [
    '# Export: a printable kit — Tasks',
    'Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.',
    '## Task 1 — File writers: STL, 3MF',
    '`[x]`',
    'Body text.',
    '## Task 2 — Kit plan and `documents`',
    '',
    '`[~]` · P0 · R1–R4',
    '## Task 4b — Tool registry',
    '`[ ]` · P1',
    '### Task 9 — a sub-heading is not a task',
    '## Task 10 - ASCII dash title',
    '`[X]`',
    '## Task 11 — no status line',
    'Just prose.',
  ].join('\n');

  it('reads id, title and status', () => {
    expect(parseTasks(md)).toEqual([
      { id: '1', title: 'File writers: STL, 3MF', status: 'done' },
      { id: '2', title: 'Kit plan and `documents`', status: 'doing' },
      { id: '4b', title: 'Tool registry', status: 'todo' },
      { id: '10', title: 'ASCII dash title', status: 'done' },
      { id: '11', title: 'no status line', status: 'todo' },
    ]);
  });

  it('ignores headings inside code fences and handles CRLF', () => {
    const fenced = ['```md', '## Task 1 — example', '`[x]`', '```', '## Task 2 — real', '`[ ]`'].join('\r\n');
    expect(parseTasks(fenced)).toEqual([{ id: '2', title: 'real', status: 'todo' }]);
  });
});

describe('parseTasks: Kiro native checklist', () => {
  it('reads checkbox items, sub-tasks and in-progress marks', () => {
    const md = [
      '# Implementation Plan',
      '',
      '- [x] 1. Set up the project',
      '  - Create folders',
      '  - _Requirements: 1.1_',
      '- [-] 2. Build the writer',
      '  - [ ] 2.1 Write the header',
      '  - [x] 2.2 Write the body',
      '- [ ]* 3. Optional property tests',
      '- [ ] Item without a number',
    ].join('\n');
    expect(parseTasks(md)).toEqual([
      { id: '1', title: 'Set up the project', status: 'done' },
      { id: '2', title: 'Build the writer', status: 'doing' },
      { id: '2.1', title: 'Write the header', status: 'todo' },
      { id: '2.2', title: 'Write the body', status: 'done' },
      { id: '3', title: 'Optional property tests', status: 'todo' },
      { id: '6', title: 'Item without a number', status: 'todo' },
    ]);
  });

  it('uses only the headings when a file has both (a pointer checklist on top)', () => {
    const md = [
      '# Tasks',
      '- [ ] 1. See Task 1 below',
      '- [ ] 2. See Task 2 below',
      '## Task 1 — First',
      '`[x]`',
      '## Task 2 — Second',
      '`[ ]`',
    ].join('\n');
    expect(parseTasks(md).map((t) => [t.id, t.status])).toEqual([
      ['1', 'done'],
      ['2', 'todo'],
    ]);
  });

  it('returns nothing for a file without tasks', () => {
    expect(parseTasks('# Just a title\n\nSome text.')).toEqual([]);
    expect(parseTasks('')).toEqual([]);
  });
});

describe('sanitize', () => {
  it('removes absolute paths and token-like strings', () => {
    expect(sanitize('see C:\\Users\\me\\repo\\file.ts now')).toBe('see <path> now');
    expect(sanitize('open /home/me/repo/file.ts')).toBe('open <path>');
    expect(sanitize('key sk-abcdefghijklmnop1234')).toBe('key <redacted>');
    expect(sanitize('src/App.tsx stays')).toBe('src/App.tsx stays');
  });
});

describe('buildContext', () => {
  const task = (id: string, status: 'todo' | 'doing' | 'done' = 'todo') => ({ id, title: `Title ${id}`, status });
  const base = {
    commits: ['aaaaaaa feat: one', 'bbbbbbb fix: two'],
    uncommitted: 3,
    specs: [
      { name: 'alpha', tasks: [task('1', 'done'), task('2', 'doing'), task('3')] },
      { name: 'beta', tasks: [task('1', 'done')] },
      { name: 'gamma', tasks: [] },
    ],
  };

  it('prints commits, the uncommitted count, open tasks and finished specs', () => {
    const text = buildContext(base);
    expect(text).toContain('Last 2 commits:');
    expect(text).toContain('aaaaaaa feat: one');
    expect(text).toContain('Uncommitted files: 3.');
    expect(text).toContain('alpha (1/3 done): T2 [~] Title 2; T3 Title 3');
    expect(text).toContain('gamma: no tasks listed yet');
    expect(text).toContain('Specs with every task done: beta');
    expect(text).not.toContain('T1 Title 1');
  });

  it('is deterministic', () => {
    expect(buildContext(base)).toBe(buildContext(structuredClone(base)));
  });

  it('says so when git is not available', () => {
    const text = buildContext({ commits: [], specs: [], uncommitted: null });
    expect(text).toContain('not available');
    expect(text).toContain('unknown');
    expect(text).toContain('none');
  });

  it('never exceeds the line limit, however many specs there are', () => {
    const specs = Array.from({ length: 80 }, (_, i) => ({ name: `spec-${i}`, tasks: [task('1')] }));
    const lines = buildContext({ ...base, specs }).split('\n');
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(lines.some((l) => /more specs with open tasks/.test(l))).toBe(true);
  });

  it('shortens long titles and caps tasks per spec', () => {
    const tasks = Array.from({ length: 14 }, (_, i) => ({ id: String(i + 1), title: 'x'.repeat(200), status: 'todo' as const }));
    const line = buildContext({ ...base, specs: [{ name: 'long', tasks }] })
      .split('\n')
      .find((l) => l.includes('long (0/14 done)'))!;
    expect(line).toContain('+4 more');
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(700);
  });

  it('removes absolute paths from commit subjects and task titles', () => {
    const text = buildContext({
      commits: ['abc1234 fix: read C:\\Users\\someone\\secret.txt'],
      uncommitted: 0,
      specs: [{ name: 's', tasks: [{ id: '1', title: 'open C:\\Users\\someone\\x.ts', status: 'todo' }] }],
    });
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(text).toContain('<path>');
  });
});

describe('collectInput', () => {
  it('reads specs from a folder and falls back when git is not available', () => {
    const root = path.join(tmp, 'no-git');
    mkdirSync(path.join(root, '.kiro', 'specs', 'one'), { recursive: true });
    mkdirSync(path.join(root, '.kiro', 'specs', 'empty'), { recursive: true });
    writeFileSync(path.join(root, '.kiro', 'specs', 'one', 'tasks.md'), '## Task 1 — A\n`[ ]`\n## Task 2 — B\n`[x]`\n');
    const input = collectInput(root);
    expect(input.specs).toEqual([
      { name: 'empty', tasks: [] },
      { name: 'one', tasks: [{ id: '1', title: 'A', status: 'todo' }, { id: '2', title: 'B', status: 'done' }] },
    ]);
    expect(input.commits).toEqual([]);
    expect(input.uncommitted).toBeNull();
  });

  it('works without a .kiro/specs folder', () => {
    expect(collectInput(path.join(tmp, 'missing')).specs).toEqual([]);
  });
});

describe('the hook script', () => {
  it('prints the block on stdout, exits 0 and logs counts and key names only', () => {
    const log = path.join(tmp, 'hook-log.jsonl');
    const result = spawnSync(process.execPath, ['scripts/hooks/session-context.mjs'], {
      input: JSON.stringify({ hook_event_name: 'agentSpawn', cwd: 'somewhere', session_id: 'abc' }),
      encoding: 'utf8',
      env: { ...process.env, SESSION_CONTEXT_LOG: log },
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toContain('session context');
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(result.stdout).not.toMatch(/[A-Za-z]:\\/);
    expect(result.stdout).not.toContain(process.cwd());

    const entry = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()!);
    expect(entry).toMatchObject({ hook: 'session-context', event: 'agentSpawn', payloadKeys: ['hook_event_name', 'cwd', 'session_id'] });
    expect(Object.keys(entry).sort()).toEqual(['commits', 'event', 'hook', 'lines', 'payloadKeys', 'specs', 'time', 'uncommitted']);
  });

  it('still exits 0 on an empty or broken STDIN', () => {
    const log = path.join(tmp, 'hook-log-2.jsonl');
    const result = spawnSync(process.execPath, ['scripts/hooks/session-context.mjs'], {
      input: 'not json',
      encoding: 'utf8',
      env: { ...process.env, SESSION_CONTEXT_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
