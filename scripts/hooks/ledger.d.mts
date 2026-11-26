export const LOG_FORMAT: string;
export type TaskCommit = {
  hash: string;
  /** YYYY-MM-DD, the author's own calendar date. */
  date: string;
  time: number;
  spec: string;
  tasks: string[];
  inProgress: boolean;
  subject: string;
};
export type SpecCommit = { hash: string; date: string; time: number; spec: string; subject: string };
export type ParsedLog = { taskCommits: TaskCommit[]; specCommits: SpecCommit[] };
export type LedgerTotals = {
  rows: { spec: string; commits: number; tasks: string[]; added: SpecCommit | null }[];
  taskCommits: number;
  distinctTasks: number;
  specsWithTasks: number;
  specsAdded: number;
};
/** Parse `git log --format=%h%x1f%aI%x1f%s` into task commits and spec commits, sorted by date. */
export function parseLog(logText: string): ParsedLog;
/** Natural order for task ids such as 1, 4, 4b, 10. */
export function compareTaskIds(a: string, b: string): number;
export function totals(parsed: ParsedLog): LedgerTotals;
/** The text of .kiro/ledger/README.md. Deterministic for a given log. */
export function renderLedger(parsed: ParsedLog): string;
