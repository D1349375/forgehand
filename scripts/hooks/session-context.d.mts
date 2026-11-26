export const MAX_LINES: number;
export type SpecTask = { id: string; title: string; status: 'todo' | 'doing' | 'done' };
export type SpecSummary = { name: string; tasks: SpecTask[] };
export type ContextInput = { commits: string[]; specs: SpecSummary[]; uncommitted: number | null };
/** Replace absolute paths and token-like strings. */
export function sanitize(text: string): string;
/** Tasks of one tasks.md, in either the "## Task N" heading format or Kiro's native checklist. */
export function parseTasks(markdown: string): SpecTask[];
/** The text printed at session start (at most MAX_LINES lines). Pure: no I/O. */
export function buildContext(input: ContextInput): string;
/** Read git and .kiro/specs under `root`. */
export function collectInput(root?: string): ContextInput;
