import { describe, expect, it } from 'vitest';
import { compareTaskIds, parseLog, renderLedger, totals } from '../../scripts/hooks/ledger.mjs';

const SEP = '\x1f';
const line = (hash: string, iso: string, subject: string) => [hash, iso, subject].join(SEP);
const log = (...lines: string[]) => lines.join('\n');

const SAMPLE = log(
  line('ccc3333', '2026-11-21T22:10:15+08:00', 'feat(export): add the export dialog (spec export, task 4)'),
  line('aaa1111', '2026-11-20T22:59:24+08:00', 'docs(spec): add the export spec (printable kit)'),
  line('bbb2222', '2026-11-21T01:46:29+08:00', 'chore(deps): list fflate (spec export, task 1)'),
  line('ddd4444', '2026-11-21T01:46:58+08:00', 'fix(export): follow-up (spec export, task 1)'),
  line('eee5555', '2026-11-22T10:00:00+08:00', 'feat(agent): two tasks at once (spec agent-harness, tasks 6 and 7a)'),
  line('fff6666', '2026-11-22T11:00:00+08:00', 'feat(hands): half done (spec hand-manipulation, task 5, in progress)'),
  line('111aaaa', '2026-11-23T09:00:00+08:00', 'docs(kiro): plan the registry (spec agent-harness)'),
  line('222bbbb', '2026-11-24T09:00:00+08:00', 'docs(specs): add the body-fit spec (millimetre fit | fit map)'),
  line('333cccc', '2026-11-24T10:00:00+08:00', 'docs(specs): update the body-fit spec'),
  line('444dddd', '2026-11-25T10:00:00+08:00', 'feat(agent): add the tool registry (spec agent-harness, task 4b)'),
  line('555eeee', '2026-11-25T11:00:00+08:00', 'chore: nothing to see'),
);

describe('parseLog', () => {
  const parsed = parseLog(SAMPLE);

  it('keeps only commits that name a spec task, sorted by date', () => {
    expect(parsed.taskCommits.map((c) => c.hash)).toEqual(['bbb2222', 'ddd4444', 'ccc3333', 'eee5555', 'fff6666', '444dddd']);
  });

  it('reads the spec, the task ids and the in-progress flag', () => {
    const by = Object.fromEntries(parsed.taskCommits.map((c) => [c.hash, c]));
    expect(by.bbb2222).toMatchObject({ spec: 'export', tasks: ['1'], inProgress: false, date: '2026-11-21' });
    expect(by.eee5555).toMatchObject({ spec: 'agent-harness', tasks: ['6', '7a'] });
    expect(by.fff6666).toMatchObject({ spec: 'hand-manipulation', tasks: ['5'], inProgress: true });
    expect(by['444dddd']).toMatchObject({ tasks: ['4b'] });
  });

  it('skips a commit that names a spec but no task', () => {
    expect(parsed.taskCommits.some((c) => c.hash === '111aaaa')).toBe(false);
  });

  it('finds the commits that add a spec, not the ones that only update it', () => {
    expect(parsed.specCommits.map((c) => [c.spec, c.hash])).toEqual([
      ['export', 'aaa1111'],
      ['body-fit', '222bbbb'],
    ]);
  });

  it('expands a range of tasks', () => {
    const r = parseLog(line('abc1234', '2026-11-26T00:00:00+08:00', 'docs: mark done (spec x, tasks 1-3)'));
    expect(r.taskCommits[0].tasks).toEqual(['1', '2', '3']);
  });

  it('uses the author calendar date from the ISO string, whatever the machine time zone', () => {
    const r = parseLog(line('abc1234', '2026-11-26T00:30:00+08:00', 'feat: x (spec s, task 1)'));
    expect(r.taskCommits[0].date).toBe('2026-11-26');
  });

  it('ignores blank and malformed lines', () => {
    expect(parseLog('\n\nnot a record\n' + line('abc', 'not a date', 'x (spec s, task 1)'))).toEqual({ taskCommits: [], specCommits: [] });
    expect(parseLog('')).toEqual({ taskCommits: [], specCommits: [] });
  });

  it('breaks time ties by hash', () => {
    const r = parseLog(log(line('bbb', '2026-11-26T00:00:00+08:00', 'a (spec s, task 2)'), line('aaa', '2026-11-26T00:00:00+08:00', 'b (spec s, task 1)')));
    expect(r.taskCommits.map((c) => c.hash)).toEqual(['aaa', 'bbb']);
  });
});

describe('compareTaskIds', () => {
  it('sorts 1, 4, 4b, 5, 10 naturally', () => {
    expect(['10', '4b', '5', '1', '4'].sort(compareTaskIds)).toEqual(['1', '4', '4b', '5', '10']);
  });
});

describe('totals', () => {
  const t = totals(parseLog(SAMPLE));

  it('counts task commits and distinct tasks separately', () => {
    expect(t.taskCommits).toBe(6);
    // export: 1, 4 | agent-harness: 4b, 6, 7a | hand-manipulation: 5
    expect(t.distinctTasks).toBe(6);
    expect(t.specsWithTasks).toBe(3);
    expect(t.specsAdded).toBe(2);
  });

  it('gives per-spec rows in alphabetical order', () => {
    expect(t.rows.map((r) => [r.spec, r.commits, r.tasks])).toEqual([
      ['agent-harness', 2, ['4b', '6', '7a']],
      ['body-fit', 0, []],
      ['export', 3, ['1', '4']],
      ['hand-manipulation', 1, ['5']],
    ]);
    expect(t.rows.find((r) => r.spec === 'export')?.added?.hash).toBe('aaa1111');
    expect(t.rows.find((r) => r.spec === 'agent-harness')?.added).toBeNull();
  });
});

describe('renderLedger', () => {
  const text = renderLedger(parseLog(SAMPLE));

  it('is deterministic and does not depend on the order of the log', () => {
    const reversed = SAMPLE.split('\n').reverse().join('\n');
    expect(renderLedger(parseLog(reversed))).toBe(text);
    expect(renderLedger(parseLog(SAMPLE))).toBe(text);
  });

  it('has the totals, one task row per commit and one spec row per spec commit', () => {
    expect(text).toContain('- Task commits: 6');
    expect(text).toContain('- Distinct spec tasks committed: 6');
    expect(text).toContain('- Specs added by `docs(spec)` / `docs(specs)` commits: 2');
    expect(text).toContain('| 2026-11-21 | export | 1 | `bbb2222` | chore(deps): list fflate (spec export, task 1) |');
    expect(text).toContain('| 2026-11-22 | agent-harness | 6, 7a | `eee5555` |');
    expect(text).toContain('| 2026-11-22 | hand-manipulation | 5 (in progress) | `fff6666` |');
    expect(text).toContain('| agent-harness | 2 | 3 | 4b, 6, 7a | - |');
    expect(text).toContain('| export | 3 | 2 | 1, 4 | 2026-11-20 `aaa1111` |');
    const taskRows = text.split('\n').filter((l) => /^\| \d{4}-\d{2}-\d{2} \| [\w-]+ \| [^|]+ \| `[0-9a-f]+` \|/.test(l) && l.includes('(spec '));
    expect(taskRows).toHaveLength(6);
  });

  it('lists task rows oldest first', () => {
    const order = ['bbb2222', 'ddd4444', 'ccc3333', 'eee5555', 'fff6666', '444dddd'].map((h) => text.indexOf(`\`${h}\``));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > 0)).toBe(true);
  });

  it('escapes pipes in subjects and ends with a single newline', () => {
    expect(text).toContain('millimetre fit \\| fit map');
    expect(text.endsWith('|\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toContain('\r');
  });

  it('renders an empty log without failing', () => {
    const empty = renderLedger(parseLog(''));
    expect(empty).toContain('- Task commits: 0');
    expect(empty).toContain('- Specs added by `docs(spec)` / `docs(specs)` commits: 0');
  });
});
