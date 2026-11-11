import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand, type CommandRunner } from './codex';
import { designTask, GenerationError, labelledInput, type ModelProvider, type ModelTask } from './provider';

/** Claude Code CLI default for this project (user-selected: Sonnet 5.5). */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
const LABEL = 'Claude Code CLI';
// Only what the CLI needs to find its own login/config. ANTHROPIC_API_KEY is
// passed through solely for users who authenticate the CLI with an API key.
const CLAUDE_ENV = ['claude_config_dir', 'anthropic_api_key'] as const;

export interface ClaudeOptions {
  executable?: string; model?: string; timeoutMs?: number; runner?: CommandRunner;
  /** Safety cap passed to --max-budget-usd for each generation. */
  maxBudgetUsd?: number;
}
export interface ClaudeAvailability { installed: boolean; loggedIn: boolean; version: string | null }

/**
 * Windows npm installs expose only `claude.cmd`, which cannot be spawned
 * without a shell. Resolve the native executable that the shim points to.
 */
export function resolveClaudeExecutable(explicit?: string, env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): string {
  if (explicit?.trim()) return explicit.trim();
  if (platform !== 'win32') return 'claude';
  const directories = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const directory of directories) {
    const native = path.win32.join(directory, 'claude.exe');
    if (exists(native)) return native;
    if (exists(path.win32.join(directory, 'claude.cmd'))) {
      const bundled = path.win32.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (exists(bundled)) return bundled;
    }
  }
  return 'claude.exe';
}

export async function inspectClaude(options: ClaudeOptions = {}): Promise<ClaudeAvailability> {
  const executable = resolveClaudeExecutable(options.executable);
  const runner = options.runner ?? runCommand;
  const common = { timeoutMs: 30_000, label: LABEL, extraEnv: CLAUDE_ENV };
  try {
    const version = await runner(executable, ['--version'], common);
    if (version.code !== 0) return { installed: false, loggedIn: false, version: null };
    const status = await runner(executable, ['auth', 'status'], common);
    let loggedIn = false;
    try { loggedIn = status.code === 0 && (JSON.parse(status.stdout) as { loggedIn?: unknown }).loggedIn === true; }
    catch { loggedIn = false; }
    const line = version.stdout.trim().split('\n').find(text => /claude code/i.test(text))?.trim();
    return { installed: true, loggedIn, version: line ? `claude-code ${line.replace(/\s*\(claude code\)\s*/i, '')}` : null };
  } catch { return { installed: false, loggedIn: false, version: null }; }
}

interface ClaudeResult {
  type?: string; subtype?: string; is_error?: boolean; api_error_status?: number | null;
  structured_output?: unknown; modelUsage?: Record<string, unknown>;
}

export async function createClaudeCodeProvider(options: ClaudeOptions = {}): Promise<ModelProvider & { cliVersion: string | null }> {
  const executable = resolveClaudeExecutable(options.executable);
  const runner = options.runner ?? runCommand;
  const available = await inspectClaude({ ...options, executable, runner });
  const requested = options.model?.trim() || DEFAULT_CLAUDE_MODEL;
  let model = requested;
  const run = async <T>(task: ModelTask<T>, signal: AbortSignal): Promise<T> => {
      if (!available.installed) throw new GenerationError('CLI_UNAVAILABLE', '找不到可用的 Claude Code CLI。請先安裝，或設定 CLAUDE_CLI_PATH 指向 claude.exe。', 503);
      if (!available.loggedIn) throw new GenerationError('CLI_NOT_LOGGED_IN', 'Claude Code CLI 尚未登入。請在終端機執行 claude auth login，再重新啟動工作台。', 503);
      // An empty, isolated working directory: no project CLAUDE.md, settings or
      // files are visible to the model, and nothing is left behind afterwards.
      const temporary = await mkdtemp(path.join(tmpdir(), 'forgehand-model-'));
      let cleanupSafe = true;
      try {
        const promptFile = path.join(temporary, 'prompt.txt');
        const input = `Return the structured ${task.kind === 'edit' ? 'edit plan' : 'design'} directly. Do not use tools.\n${labelledInput(task)}`;
        await writeFile(promptFile, input, { encoding: 'utf8', mode: 0o600 });
        const args = ['-p', '--output-format', 'json', '--model', requested,
          // No built-in tools, no MCP servers, no user/project settings, hooks
          // or slash commands, and no session saved to disk.
          '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
          '--no-session-persistence', '--max-budget-usd', String(options.maxBudgetUsd ?? 1),
          '--system-prompt', task.instructions, '--json-schema', JSON.stringify(task.schema)];
        const result = await runner(executable, args, { cwd: temporary, stdin: input, stdinFile: promptFile,
          signal, timeoutMs: options.timeoutMs ?? 180_000, label: LABEL, extraEnv: CLAUDE_ENV });
        let parsed: ClaudeResult | undefined;
        try { parsed = JSON.parse(result.stdout) as ClaudeResult; } catch { parsed = undefined; }
        // Keep only the non-secret model identifier; session IDs, costs and raw
        // diagnostics never leave this function.
        const reported = parsed?.modelUsage ? Object.keys(parsed.modelUsage).find(name => /^[a-zA-Z0-9._:/-]{1,100}$/.test(name)) : undefined;
        if (reported) model = reported;
        if (!parsed || parsed.type !== 'result') throw new GenerationError('CLI_FAILED', 'Claude Code CLI 無法完成生成。請確認登入、網路與所選模型後重試。');
        if (parsed.is_error || parsed.subtype !== 'success') {
          if (parsed.api_error_status === 429) throw new GenerationError('RATE_LIMITED', 'Claude Code CLI 暫時達到用量或頻率限制，請稍後重試。', 429);
          if (parsed.api_error_status === 401 || parsed.api_error_status === 403) throw new GenerationError('AUTH_FAILED', 'Claude Code CLI 驗證失敗。請重新登入後重試。');
          if (parsed.subtype === 'error_max_budget_usd') throw new GenerationError('BUDGET_LIMIT', '這次生成超過單次費用上限，請簡化描述後重試。');
          throw new GenerationError('CLI_FAILED', 'Claude Code CLI 無法完成生成。請確認登入、網路與所選模型後重試。');
        }
        try { return task.parse(parsed.structured_output); }
        catch { throw new GenerationError('INVALID_MODEL', 'Claude Code CLI 模型資料未通過驗證，上一個成功模型會保留。'); }
      } catch (error) {
        if (error instanceof GenerationError && error.code === 'CLI_TERMINATION_FAILED') cleanupSafe = false;
        throw error;
      } finally {
        const resolved = path.resolve(temporary);
        if (cleanupSafe && path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('forgehand-model-')) {
          await rm(resolved, { recursive: true, force: true }).catch(() => {});
        }
      }
  };
  return {
    name: 'claude', transport: 'print', configured: available.installed && available.loggedIn,
    cliVersion: available.version, get model() { return model; },
    run, generate: (prompt, signal) => run(designTask(prompt), signal),
  };
}
