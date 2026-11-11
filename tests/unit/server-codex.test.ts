import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexProvider, inspectCodex, runCommand, type CommandRunner } from '../../server/codex';
import { EDIT_INSTRUCTIONS, editTask } from '../../server/provider';
import { editJsonSchema } from '../../shared/schema';
import { demoModel } from '../../shared/demo';

const design = { status: 'ready', explanation: 'Codex adapter 測試替身', model: demoModel };
const probe = (args: string[]) => ({ code: 0, stdout: args[0] === '--version' ? 'codex-cli test-version\n' : 'Logged in using ChatGPT\n', stderr: '' });

describe('Codex CLI provider (subprocess adapter test doubles)', () => {
  it('checks both executable availability and login status', async () => {
    const runner: CommandRunner = async (_exe, args) => probe(args);
    expect(await inspectCodex({ runner })).toEqual({ installed: true, loggedIn: true, version: 'codex-cli test-version' });
    const unlogged: CommandRunner = async (_exe, args) => args[0] === '--version' ? probe(args) : { code: 1, stdout: '', stderr: 'Not logged in' };
    expect((await inspectCodex({ runner: unlogged })).loggedIn).toBe(false);
  });
  it('uses stdin, isolated temporary working directory and read-only flags; cleans output files', async () => {
    let workingDirectory = '';
    const runner: CommandRunner = async (executable, args, options) => {
      if (args[0] !== 'exec') return probe(args);
      expect(executable).toBe('native-codex');
      expect(args).toContain('--ignore-user-config');
      expect(args).toContain('--ephemeral');
      expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
      expect(args).toContain('shell_tool');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args.join(' ')).not.toContain('UNIQUE_USER_DESCRIPTION');
      expect(options.stdin).toContain('UNIQUE_USER_DESCRIPTION');
      workingDirectory = options.cwd!;
      expect(path.basename(workingDirectory)).toMatch(/^forgehand-model-/);
      const output = args[args.indexOf('--output-last-message') + 1]!;
      expect(path.dirname(output)).toBe(workingDirectory);
      await writeFile(output, JSON.stringify(design));
      return { code: 0, stdout: '', stderr: 'model: resolved-cli-model\nsession id: private-session\n' };
    };
    const provider = await createCodexProvider({ executable: 'native-codex', runner });
    expect(provider).toMatchObject({ name: 'codex', configured: true });
    expect(await provider.generate('UNIQUE_USER_DESCRIPTION', new AbortController().signal)).toEqual(design);
    expect(provider.model).toBe('resolved-cli-model');
    expect(JSON.stringify(provider)).not.toContain('private-session');
    await expect(access(workingDirectory)).rejects.toThrow();
  });
  it('does not run generation when CLI is missing or logged out', async () => {
    const missing = await createCodexProvider({ runner: async () => { throw new Error('not installed'); } });
    expect(missing.configured).toBe(false);
    await expect(missing.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code: 'CLI_UNAVAILABLE' });
    const loggedOut = await createCodexProvider({ runner: async (_exe, args) => args[0] === '--version' ? probe(args) : { code: 1, stdout: '', stderr: 'Not logged in' } });
    await expect(loggedOut.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code: 'CLI_NOT_LOGGED_IN' });
  });
  it('rejects invalid generated output and cleans temporary directory', async () => {
    let directory = '';
    const provider = await createCodexProvider({ runner: async (_exe, args, options) => {
      if (args[0] !== 'exec') return probe(args);
      directory = options.cwd!;
      await writeFile(args[args.indexOf('--output-last-message') + 1]!, '{"bad":"data"}');
      return { code: 0, stdout: '', stderr: '' };
    } });
    await expect(provider.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    await expect(access(directory)).rejects.toThrow();
  });
  it('hides raw CLI stderr on a failed process', async () => {
    const provider = await createCodexProvider({ runner: async (_exe, args) => args[0] !== 'exec' ? probe(args) : { code: 1, stdout: '', stderr: 'secret-auth-data' } });
    await expect(provider.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code: 'CLI_FAILED' });
  });
});

describe('safe subprocess lifecycle (real Node process, no model service)', () => {
  it('pipes data without a shell', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdin.on("data", d => process.stdout.write(d))'],
      { timeoutMs: 30_000, stdin: 'literal $(echo test) & no execution' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('literal $(echo test) & no execution');
  });
  it('terminates on timeout and abort', async () => {
    await expect(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController();
    const running = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30_000, signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('waits for the child to stop before rejecting cancellation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'forgehand-process-test-'));
    const pidFile = path.join(directory, 'owned-pid.txt');
    const controller = new AbortController();
    const running = runCommand(process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidFile],
      { timeoutMs: 30_000, signal: controller.signal });
    // Attach the rejection expectation immediately so test runner scheduling
    // cannot turn the deliberate cancellation into an unhandled rejection.
    const outcome = running.then(() => ({ code: 'UNEXPECTED_SUCCESS' }), (error: unknown) => error);
    try {
      let pid = 0;
      for (let attempt = 0; attempt < 500; attempt++) {
        try { pid = Number(await readFile(pidFile, 'utf8')); } catch { /* wait for startup */ }
        if (pid) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(pid).toBeGreaterThan(0);
      controller.abort();
      expect(await outcome).toMatchObject({ code: 'CANCELLED' });
      let absent = false;
      try { process.kill(pid, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      expect(absent).toBe(true);
    } finally {
      controller.abort();
      await running.catch(() => {});
      if (path.dirname(path.resolve(directory)) === path.resolve(tmpdir()) && path.basename(directory).startsWith('forgehand-process-test-')) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});

describe('Codex CLI exec provider: edit task', () => {
  it('writes the edit schema and instructions and parses the plan', async () => {
    const plan = { status: 'clarify', explanation: '要改哪個零件？', operations: [], name: null, summary: null, assumptions: null };
    const provider = await createCodexProvider({ runner: async (_exe, args, options) => {
      if (args[0] !== 'exec') return probe(args);
      const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1]!, 'utf8'));
      expect(schema).toEqual(editJsonSchema());
      expect(options.stdin!.startsWith(EDIT_INSTRUCTIONS)).toBe(true);
      expect(options.stdin).not.toContain('User object description');
      await writeFile(args[args.indexOf('--output-last-message') + 1]!, JSON.stringify(plan));
      return { code: 0, stdout: '', stderr: '' };
    } });
    expect(await provider.run!(editTask(demoModel, '改一下', []), new AbortController().signal)).toEqual(plan);
  });
});
