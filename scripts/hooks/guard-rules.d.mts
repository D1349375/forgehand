export type GuardDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; rule: string; reason: string };

export const RULE_IDS: string[];

/** Decide whether one tool call may run. Pure: no I/O. */
export function evaluate(call: { toolName?: string; toolInput?: unknown }): GuardDecision;

/** Check a shell command line. Returns a deny decision or null. */
export function checkShell(command: string, depth?: number): GuardDecision | null;

/** True if the .gitignore text would ignore `.kiro` or a path inside it. */
export function ignoresKiro(text: string): boolean;
