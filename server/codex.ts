import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { designTask, GenerationError, labelledInput, type ModelProvider, type ModelTask } from './provider';

interface CommandResult { code: number | null; stdout: string; stderr: string }
interface CommandOptions {
  cwd?: string; stdin?: string; stdinFile?: string; signal?: AbortSignal; timeoutMs: number;
  /** User-facing CLI name for error messages; defaults to Codex CLI. */
  label?: string;
  /** Extra environment variable names (case-insensitive) this CLI needs. */
  extraEnv?: readonly string[];
}
export type CommandRunner = (executable: string, args: string[], options: CommandOptions) => Promise<CommandResult>;

function subprocessEnvironment(extra: readonly string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set([...extra.map(name => name.toLowerCase()), 'path', 'pathext', 'systemroot', 'windir', 'comspec', 'userprofile', 'homedrive', 'homepath',
    'home', 'localappdata', 'appdata', 'programdata', 'temp', 'tmp', 'tmpdir', 'codex_home',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir']);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toLowerCase())));
}

// No shell is ever involved. User text is sent only on stdin, not in arguments.
export const runCommand: CommandRunner = (executable, args, options) => new Promise((resolve, reject) => {
  const started = Date.now();
  const label = options.label ?? 'Codex CLI';
  const debug = (event: string, fields: Record<string, unknown> = {}) => {
    if (process.env.MODEL_DEBUG === '1') console.info('[model-debug]', JSON.stringify({ event, elapsedMs: Date.now() - started, ...fields }));
  };
  if (options.signal?.aborted) { reject(new GenerationError('CANCELLED', '這次生成已取消。', 499)); return; }
  let child: ChildProcess;
  let inputDescriptor: number | undefined;
  try {
    if (options.stdinFile) inputDescriptor = openSync(options.stdinFile, 'r');
    child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, shell: false, env: subprocessEnvironment(options.extraEnv), detached: process.platform !== 'win32',
      stdio: [inputDescriptor ?? 'pipe', 'pipe', 'pipe'] });
  } catch {
    reject(new GenerationError('CLI_UNAVAILABLE', `無法啟動 ${label}。請確認安裝路徑與執行權限。`, 503));
    return;
  } finally {
    if (inputDescriptor !== undefined) closeSync(inputDescriptor);
  }
  let stdout = ''; let stderr = ''; let done = false;
  debug('spawned', { pid: child.pid, command: args[0] === 'exec' || args[0] === '-p' ? 'generate' : 'availability' });
  const reported = new Set<string>();
  let terminalError: Error | undefined;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  let finalKillTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (hard = false) => {
    if (process.platform === 'win32' && child.pid) {
      // Kill the owned process tree, including any CLI child helpers.
      try {
        const taskkill = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(); } catch { /* process may already have exited */ } });
      } catch { try { child.kill(); } catch { /* process may already have exited */ } }
    } else {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill(hard ? 'SIGKILL' : 'SIGTERM'); } catch { /* process may already have exited */ } }
    }
  };
  const finish = (error?: Error, code: number | null = null) => {
    if (done) return;
    done = true; clearTimeout(timer); clearTimeout(hardKillTimer); clearTimeout(finalKillTimer);
    options.signal?.removeEventListener('abort', abort);
    if (error) reject(error); else resolve({ code, stdout, stderr });
  };
  const terminate = (error: Error) => {
    if (done || terminalError) return;
    terminalError = error;
    debug('terminating', { code: error instanceof GenerationError ? error.code : 'PROCESS_ERROR' });
    clearTimeout(timer);
    kill();
    // The promise normally settles only from close, after stdio and the CLI
    // process are gone. A second hard kill bounds an unresponsive termination.
    hardKillTimer = setTimeout(() => {
      kill(true);
      finalKillTimer = setTimeout(() => finish(new GenerationError('CLI_TERMINATION_FAILED',
        `無法確認 ${label} 已停止。請先關閉殘留的 CLI 程序再重試。`, 503)), 10000);
    }, 10000);
  };
  const abort = () => terminate(new GenerationError('CANCELLED', '這次生成已取消。', 499));
  const timer = setTimeout(() => terminate(new GenerationError('TIMEOUT', `${label} 回應逾時，請稍後重試或減少零件。`, 504)), options.timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (!reported.has(stream)) { reported.add(stream); debug(`${stream}-received`, { bytes: chunk.length }); }
    if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    // Emit categories only; raw CLI diagnostics may contain private paths or
    // request contents and must never be logged by this application.
    for (const [category, pattern] of [
      ['network-retry', /stream disconnected|error sending request|failed to connect|connection refused/i],
      ['usage-limit', /usage.limit|rate.limit|quota.exceeded/i],
      ['permission-error', /permission denied|access is denied|operation not permitted/i],
      ['reading-stdin', /reading prompt from stdin/i],
      ['model-header', /^model:\s/m],
    ] as const) {
      if (!reported.has(category) && pattern.test(stderr)) { reported.add(category); debug(category); }
    }
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2_000_000) {
      terminate(new GenerationError('CLI_OUTPUT_LIMIT', `${label} 輸出過大，請減少描述後重試。`));
    }
  };
  child.stdout?.on('data', chunk => collect('stdout', chunk));
  child.stderr?.on('data', chunk => collect('stderr', chunk));
  child.once('error', () => {
    if (!child.pid) finish(new GenerationError('CLI_UNAVAILABLE', `無法啟動 ${label}。請確認已安裝並可從終端機執行。`, 503));
    else terminate(new GenerationError('CLI_FAILED', `${label} 程序發生錯誤，請稍後重試。`));
  });
  child.once('exit', code => debug('process-exit', { code }));
  child.once('close', code => { debug('process-close', { code }); finish(terminalError, code); });
  child.stdin?.on('error', () => { /* a failed startup may close stdin first */ });
  child.stdin?.end(options.stdin ?? '');
});

export interface CodexOptions { executable?: string; model?: string; timeoutMs?: number; runner?: CommandRunner }
export interface CodexAvailability { installed: boolean; loggedIn: boolean; version: string | null }

export async function inspectCodex(options: CodexOptions = {}): Promise<CodexAvailability> {
  const executable = options.executable || (process.platform === 'win32' ? 'codex.exe' : 'codex');
  const runner = options.runner ?? runCommand;
  try {
    const version = await runner(executable, ['--version'], { timeoutMs: 30_000 });
    if (version.code !== 0) return { installed: false, loggedIn: false, version: null };
    const login = await runner(executable, ['login', 'status'], { timeoutMs: 30_000 });
    return { installed: true, loggedIn: login.code === 0 && /logged in/i.test(`${login.stdout}\n${login.stderr}`),
      version: version.stdout.trim().split('\n').find(line => /^codex-cli\s/.test(line)) ?? null };
  } catch { return { installed: false, loggedIn: false, version: null }; }
}

export async function createCodexProvider(options: CodexOptions = {}): Promise<ModelProvider> {
  const executable = options.executable || (process.platform === 'win32' ? 'codex.exe' : 'codex');
  const runner = options.runner ?? runCommand;
  const available = await inspectCodex({ ...options, executable, runner });
  let model = options.model?.trim() || 'CLI default';
  const run = async <T>(task: ModelTask<T>, signal: AbortSignal): Promise<T> => {
      if (!available.installed) throw new GenerationError('CLI_UNAVAILABLE', '找不到可用的 Codex CLI。請先安裝，或設定 CODEX_CLI_PATH 指向執行檔。', 503);
      if (!available.loggedIn) throw new GenerationError('CLI_NOT_LOGGED_IN', 'Codex CLI 尚未登入。請在終端機執行 codex login，再重新啟動工作台。', 503);
      const temporary = await mkdtemp(path.join(tmpdir(), 'forgehand-model-'));
      let cleanupSafe = true;
      try {
        const schemaFile = path.join(temporary, 'schema.json');
        const outputFile = path.join(temporary, 'result.json');
        const promptFile = path.join(temporary, 'prompt.txt');
        const input = `${task.instructions}\n\nDo not use tools. Return the final JSON directly.\n${labelledInput(task)}`;
        await writeFile(promptFile, input, { encoding: 'utf8', mode: 0o600 });
        await writeFile(schemaFile, JSON.stringify(task.schema), 'utf8');
        const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
          '--sandbox', 'read-only', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', outputFile,
          '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"'];
        for (const feature of ['shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'code_mode_host']) {
          args.push('--disable', feature);
        }
        if (options.model?.trim()) args.push('--model', options.model.trim());
        args.push('-');
        const result = await runner(executable, args, { cwd: temporary,
          stdin: input, stdinFile: promptFile,
          signal, timeoutMs: options.timeoutMs ?? 180_000 });
        // Retain only the non-secret model identifier from the CLI header.
        // No session IDs, raw diagnostics, working paths or auth text escape.
        const reportedModel = result.stderr.match(/^model:\s*([a-zA-Z0-9._:/-]+)\s*$/m)?.[1];
        if (reportedModel) model = reportedModel;
        if (result.code !== 0) throw new GenerationError('CLI_FAILED', 'Codex CLI 無法完成生成。請確認登入、網路與所選模型後重試。');
        const info = await stat(outputFile).catch(() => null);
        if (!info || info.size > 1_000_000) throw new GenerationError('INVALID_MODEL', 'Codex CLI 未提供可用的模型資料，請重試。');
        try { return task.parse(JSON.parse(await readFile(outputFile, 'utf8'))); }
        catch { throw new GenerationError('INVALID_MODEL', 'Codex CLI 模型資料未通過驗證，上一個成功模型會保留。'); }
      } catch (error) {
        // In the exceptional case where OS termination itself fails, preserve
        // the non-secret temporary directory until that process is stopped.
        if (error instanceof GenerationError && error.code === 'CLI_TERMINATION_FAILED') cleanupSafe = false;
        throw error;
      } finally {
        const resolved = path.resolve(temporary);
        const root = path.resolve(tmpdir());
        if (cleanupSafe && path.dirname(resolved) === root && path.basename(resolved).startsWith('forgehand-model-')) {
          await rm(resolved, { recursive: true, force: true }).catch(() => {});
        }
      }
  };
  return { name: 'codex', configured: available.installed && available.loggedIn, get model() { return model; },
    run, generate: (prompt, signal) => run(designTask(prompt), signal) };
}
