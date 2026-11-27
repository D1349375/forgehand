import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeProvider, DEFAULT_CLAUDE_MODEL, inspectClaude, resolveClaudeExecutable } from '../../server/claude';
import { EDIT_INSTRUCTIONS, editTask } from '../../server/provider';
import { editJsonSchema } from '../../shared/schema';
import type { CommandRunner } from '../../server/codex';
import { createModelHost } from '../../server/model-host';
import { demoModel } from '../../shared/demo';

const design = { status: 'ready', explanation: 'Claude adapter 測試替身', model: demoModel };
const probe = (args: string[]) => args[0] === '--version'
  ? { code: 0, stdout: '2.1.312 (Claude Code)\n', stderr: '' }
  : { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '' };
const success = (output: unknown, extra: Record<string, unknown> = {}) => ({ code: 0, stderr: '', stdout: JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, session_id: 'private-session', total_cost_usd: 0.01,
  structured_output: output, modelUsage: { 'claude-sonnet-5-5': { outputTokens: 10 } }, ...extra }) });

describe('Claude Code CLI provider (subprocess adapter test doubles)', () => {
  it('checks executable availability and JSON login status', async () => {
    const runner: CommandRunner = async (_exe, args) => probe(args);
    expect(await inspectClaude({ executable: 'claude-test', runner })).toEqual({ installed: true, loggedIn: true, version: 'claude-code 2.1.312' });
    const loggedOut: CommandRunner = async (_exe, args) => args[0] === '--version' ? probe(args) : { code: 0, stdout: '{"loggedIn":false}', stderr: '' };
    expect((await inspectClaude({ executable: 'claude-test', runner: loggedOut })).loggedIn).toBe(false);
    const garbage: CommandRunner = async (_exe, args) => args[0] === '--version' ? probe(args) : { code: 0, stdout: 'Logged in', stderr: '' };
    expect((await inspectClaude({ executable: 'claude-test', runner: garbage })).loggedIn).toBe(false);
  });

  it('resolves the native executable behind the Windows npm shim', () => {
    const files = new Set(['C:\\npm\\claude.cmd', 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe']);
    expect(resolveClaudeExecutable(undefined, { PATH: 'C:\\other;C:\\npm' }, 'win32', file => files.has(file)))
      .toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
    expect(resolveClaudeExecutable(undefined, { PATH: 'C:\\bin' }, 'win32', file => file === 'C:\\bin\\claude.exe')).toBe('C:\\bin\\claude.exe');
    expect(resolveClaudeExecutable('D:\\custom\\claude.exe', {}, 'win32', () => false)).toBe('D:\\custom\\claude.exe');
    expect(resolveClaudeExecutable(undefined, {}, 'linux', () => false)).toBe('claude');
  });

  it('sends text only on stdin with tools, MCP, settings and persistence disabled; cleans up', async () => {
    let workingDirectory = '';
    const runner: CommandRunner = async (executable, args, options) => {
      if (args[0] !== '-p') return probe(args);
      expect(executable).toBe('claude-test');
      expect(args[args.indexOf('--model') + 1]).toBe(DEFAULT_CLAUDE_MODEL);
      expect(args[args.indexOf('--tools') + 1]).toBe('');
      expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
      expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']));
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toHaveProperty('properties.model');
      expect(args.join(' ')).not.toContain('UNIQUE_USER_DESCRIPTION');
      expect(options.stdin).toContain('UNIQUE_USER_DESCRIPTION');
      expect(options.label).toBe('Claude Code CLI');
      workingDirectory = options.cwd!;
      expect(path.basename(workingDirectory)).toMatch(/^forgehand-model-/);
      return success(design);
    };
    const provider = await createClaudeCodeProvider({ executable: 'claude-test', runner });
    expect(provider).toMatchObject({ name: 'claude', transport: 'print', configured: true, cliVersion: 'claude-code 2.1.312' });
    expect(await provider.generate('UNIQUE_USER_DESCRIPTION', new AbortController().signal)).toEqual(design);
    expect(provider.model).toBe('claude-sonnet-5-5');
    expect(JSON.stringify(provider)).not.toContain('private-session');
    await expect(access(workingDirectory)).rejects.toThrow();
  });

  it('maps CLI errors and invalid output to safe errors', async () => {
    const make = (result: ReturnType<typeof success>) => createClaudeCodeProvider({ executable: 'claude-test',
      runner: async (_exe, args) => args[0] === '-p' ? result : probe(args) });
    const signal = new AbortController().signal;
    await expect((await make(success({ bad: 'data' }))).generate('桌子', signal)).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    await expect((await make(success(null, { is_error: true, subtype: 'error_during_execution', api_error_status: 429 }))).generate('桌子', signal))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    await expect((await make({ code: 1, stdout: 'not json', stderr: 'private details' })).generate('桌子', signal))
      .rejects.toMatchObject({ code: 'CLI_FAILED' });
  });

  it('does not generate when the CLI is missing or logged out', async () => {
    const missing = await createClaudeCodeProvider({ executable: 'claude-test', runner: async () => { throw new Error('not installed'); } });
    expect(missing.configured).toBe(false);
    await expect(missing.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code: 'CLI_UNAVAILABLE' });
    const loggedOut = await createClaudeCodeProvider({ executable: 'claude-test',
      runner: async (_exe, args) => args[0] === '--version' ? probe(args) : { code: 1, stdout: '{"loggedIn":false}', stderr: '' } });
    await expect(loggedOut.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code: 'CLI_NOT_LOGGED_IN' });
  });

  it('is selectable through the shared model host', async () => {
    await expect(createModelHost({ MODEL_PROVIDER: 'other' })).rejects.toThrow(/codex、claude 或 openai/);
    const host = await createModelHost({ MODEL_PROVIDER: 'claude', CLAUDE_CLI_PATH: path.join('missing-dir', 'claude-missing.exe'), CLAUDE_MODEL: 'claude-test-model' });
    expect(host).toMatchObject({ name: 'claude', configured: false, model: 'claude-test-model' });
  });
});

describe('Claude Code CLI provider: edit task', () => {
  it('passes the edit instructions and schema, and returns the parsed plan', async () => {
    const plan = { status: 'unsupported', explanation: '無法挖孔', operations: [], name: null, summary: null, assumptions: null };
    const runner: CommandRunner = async (_exe, args, options) => {
      if (args[0] !== '-p') return probe(args);
      expect(args[args.indexOf('--system-prompt') + 1]).toBe(EDIT_INSTRUCTIONS);
      expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(editJsonSchema());
      expect(options.stdin).toContain('EDIT_REQUEST:');
      expect(options.stdin).not.toContain('User object description');
      return success(plan);
    };
    const provider = await createClaudeCodeProvider({ executable: 'claude-test', runner });
    expect(await provider.run!(editTask(demoModel, '在外殼挖一個孔', [], 'zh-TW'), new AbortController().signal)).toEqual(plan);
  });
});
