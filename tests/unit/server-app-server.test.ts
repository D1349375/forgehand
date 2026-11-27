import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCodexAppServerProvider, type AppServerProcess, type AppServerSpawner } from '../../server/app-server';
import { EDIT_INSTRUCTIONS, editTask } from '../../server/provider';
import { demoModel } from '../../shared/demo';
import { editJsonSchema } from '../../shared/schema';

type Frame = { id?: string | number; method?: string; params?: Record<string, any>; result?: unknown; error?: unknown };
const design = (name = '測試替身模型') => ({ status: 'ready', explanation: '測試替身，並非真實模型生成', model: { ...structuredClone(demoModel), name } });
const safeFeatures = Object.fromEntries(['shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use',
  'browser_use_external', 'computer_use', 'in_app_browser', 'code_mode_host', 'memories', 'skill_search'].map(key => [key, false]));

class FakeServer extends EventEmitter implements AppServerProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  frames: Frame[] = [];
  args: string[] = [];
  spawnCount = 0;
  threads = 0;
  closed = false;
  config = { features: safeFeatures, mcp_servers: {}, project_doc_max_bytes: 0, web_search: 'disabled',
    sandbox_mode: 'read-only', approval_policy: 'never', model: 'configured-model' };
  inventory: unknown[] = [];
  threadInventory: unknown[] = [];
  account: unknown = { type: 'chatgpt', email: 'private-test-address' };
  onTurn?: (frame: Frame) => void;
  onThread?: (frame: Frame) => void;
  onInterrupt?: (frame: Frame) => void;
  threadOverrides: Record<string, unknown> = {};

  constructor() {
    super();
    let buffer = '';
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      buffer += chunk.toString();
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, boundary)) as Frame; buffer = buffer.slice(boundary + 1);
        this.frames.push(frame); this.route(frame);
      }
      callback();
    }, final: callback => { callback(); queueMicrotask(() => this.close()); } });
  }
  spawn: AppServerSpawner = (_executable, args, options) => {
    this.spawnCount++; this.args = args;
    expect(options.shell).toBe(false);
    expect(options.cwd).toMatch(/forgehand-app-server-/);
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
    return this;
  };
  send(frame: Frame) { this.stdout.write(JSON.stringify(frame) + '\n'); }
  reply(frame: Frame, result: unknown) { this.send({ id: frame.id, result }); }
  notify(method: string, params: Record<string, unknown>) { this.send({ method, params }); }
  close() { if (!this.closed) { this.closed = true; this.emit('close', 0); } }
  kill() { this.close(); return true; }
  startThread(frame: Frame) {
    const threadId = `thread-${++this.threads}`;
    this.reply(frame, { thread: { id: threadId, ephemeral: true }, model: 'reported-model', approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false }, instructionSources: [], ...this.threadOverrides });
  }
  finish(frame: Frame, value: unknown = design(), status = 'completed') {
    const threadId = frame.params!.threadId as string;
    const turnId = `turn-${threadId}`;
    if (status === 'completed') this.notify('item/completed', { threadId, turnId,
      item: { type: 'agentMessage', id: `message-${threadId}`, phase: 'final_answer', text: JSON.stringify(value) } });
    this.notify('turn/completed', { threadId, turn: { id: turnId, status, items: [] } });
  }
  startTurn(frame: Frame, complete = false) {
    const threadId = frame.params!.threadId as string;
    this.notify('turn/started', { threadId, turn: { id: `turn-${threadId}`, status: 'inProgress' } });
    if (complete) this.finish(frame, design(String((frame.params!.input as Array<{ text: string }>)[0]!.text)));
    this.reply(frame, { turn: { id: `turn-${threadId}`, status: 'inProgress' } });
  }
  private route(frame: Frame) {
    if (!frame.method) return; // A denied server request response is not another request.
    if (frame.method === 'initialize') this.reply(frame, { userAgent: 'codex-app-server/0.166.0-alpha.5.1' });
    else if (frame.method === 'initialized') return;
    else if (frame.method === 'config/read') this.reply(frame, { config: this.config });
    else if (frame.method === 'mcpServerStatus/list') this.reply(frame, { data: frame.params?.threadId ? this.threadInventory : this.inventory, nextCursor: null });
    else if (frame.method === 'account/read') this.reply(frame, { account: this.account, requiresOpenaiAuth: true });
    else if (frame.method === 'thread/start') this.onThread ? this.onThread(frame) : this.startThread(frame);
    else if (frame.method === 'thread/unsubscribe') this.reply(frame, { status: 'unsubscribed' });
    else if (frame.method === 'turn/start') this.onTurn ? this.onTurn(frame) : this.startTurn(frame, true);
    else if (frame.method === 'turn/interrupt') {
      if (this.onInterrupt) this.onInterrupt(frame);
      else {
        this.reply(frame, {});
        queueMicrotask(() => this.notify('turn/completed', { threadId: frame.params!.threadId,
          turn: { id: frame.params!.turnId, status: 'interrupted', items: [] } }));
      }
    }
  }
  async waitFor(method: string, count = 1) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const matching = this.frames.filter(frame => frame.method === method);
      if (matching.length >= count) return matching;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error(`test server did not receive ${method}`);
  }
}

const create = (server: FakeServer, options: Parameters<typeof createCodexAppServerProvider>[0] = {}) =>
  createCodexAppServerProvider({ spawnProcess: server.spawn, startupTimeoutMs: 5000, ...options });

describe('persistent Codex app-server provider (fake JSON-RPC only, no native CLI or model)', () => {
  it('initializes once, verifies isolation and login, and reuses one process for independent threads', async () => {
    const server = new FakeServer();
    const provider = await create(server);
    try {
      const prompt = '任意新組合物件；字面 $(echo test) & 不執行命令';
      expect((await provider.generate(prompt, new AbortController().signal)).model?.name).toBe(prompt);
      expect((await provider.generate('第二件物品', new AbortController().signal)).model?.name).toBe('第二件物品');
      expect(server.spawnCount).toBe(1);
      expect(server.frames.filter(frame => frame.method === 'initialize')).toHaveLength(1);
      expect(server.frames.filter(frame => frame.method === 'thread/start')).toHaveLength(2);
      expect(server.frames.filter(frame => frame.method === 'thread/unsubscribe')).toHaveLength(2);
      expect(server.args.join(' ')).not.toContain(prompt);
      expect(server.args).toContain('mcp_servers={}');
      expect(server.args).not.toContain('--ignore-user-config');
      const started = server.frames.find(frame => frame.method === 'thread/start')!;
      expect(started.params).toMatchObject({ ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [], dynamicTools: [] });
      const turn = server.frames.find(frame => frame.method === 'turn/start')!;
      expect(turn.params).toMatchObject({ outputSchema: { type: 'object', additionalProperties: false },
        sandboxPolicy: { type: 'readOnly', networkAccess: false } });
      expect(provider.model).toBe('reported-model');
      expect(provider.cliVersion).toBe('0.166.0-alpha.5.1');
      expect(JSON.stringify(provider)).not.toContain('private-test-address');
    } finally { await provider.dispose(); }
    expect(server.closed).toBe(true);
    expect(provider.configured).toBe(false);
  });

  it('keeps final item and turn completion notifications that arrive before the start response', async () => {
    const server = new FakeServer(); // Default fake emits completion before RPC reply.
    const provider = await create(server);
    try { expect((await provider.generate('先收到完成通知', new AbortController().signal)).model?.name).toBe('先收到完成通知'); }
    finally { await provider.dispose(); }
  });

  it.each(['hooks', 'shell_tool', 'apps', 'plugins'])('rejects an effective config with %s enabled', async feature => {
    const server = new FakeServer(); server.config = { ...server.config, features: { ...safeFeatures, [feature]: true } };
    await expect(create(server)).rejects.toMatchObject({ code: 'APP_SERVER_ISOLATION_FAILED' });
    expect(server.closed).toBe(true);
    expect(server.frames.some(frame => frame.method === 'thread/start')).toBe(false);
  });

  it('discovers safe MCP names only in memory and restarts once with bare-key disabling overrides', async () => {
    const first = new FakeServer(), second = new FakeServer();
    const name = 'private_server-1';
    first.config = { ...first.config, mcp_servers: { [name]: { enabled: true } } };
    second.config = { ...second.config, mcp_servers: { [name]: { enabled: false } } };
    let spawns = 0;
    const provider = await createCodexAppServerProvider({ startupTimeoutMs: 5000, spawnProcess: (exe, args, options) => {
      spawns++; return spawns === 1 ? first.spawn(exe, args, options) : second.spawn(exe, args, options);
    } });
    try {
      expect(spawns).toBe(2);
      expect(first.closed).toBe(true);
      expect(first.frames.some(frame => frame.method === 'thread/start' || frame.method === 'mcpServerStatus/list')).toBe(false);
      expect(second.args).toContain(`mcp_servers.${name}.enabled=false`);
      expect(first.config.mcp_servers).toEqual({ [name]: { enabled: true } });
      expect((await provider.generate('隔離後生成', new AbortController().signal)).model?.name).toBe('隔離後生成');
      expect(second.frames.find(frame => frame.method === 'thread/start')!.params!.config.mcp_servers).toEqual({ [name]: { enabled: false } });
    } finally { await provider.dispose(); }
  });

  it.each(['dotted.name', 'quoted"name', 'name with spaces', 'path/name'])('fails closed for an MCP name outside the verified safe key syntax: %s', async name => {
    const server = new FakeServer(); server.config = { ...server.config, mcp_servers: { [name]: { enabled: true } } };
    await expect(create(server)).rejects.toMatchObject({ code: 'APP_SERVER_ISOLATION_FAILED' });
    expect(server.spawnCount).toBe(1);
    expect(server.frames.some(frame => frame.method === 'thread/start')).toBe(false);
  });

  it('fails closed instead of retrying forever if an enabled MCP entry remains after one restart', async () => {
    const servers = [new FakeServer(), new FakeServer()];
    servers.forEach(server => { server.config = { ...server.config, mcp_servers: { changed_server: { enabled: true } } }; });
    let spawns = 0;
    await expect(createCodexAppServerProvider({ startupTimeoutMs: 5000, spawnProcess: (exe, args, options) => {
      const server = servers[spawns++]!; return server.spawn(exe, args, options);
    } })).rejects.toMatchObject({ code: 'APP_SERVER_ISOLATION_FAILED' });
    expect(spawns).toBe(2);
    expect(servers.every(server => server.closed && !server.frames.some(frame => frame.method === 'thread/start'))).toBe(true);
  });

  it('requires an actually empty MCP inventory at startup and on every thread', async () => {
    const startup = new FakeServer(); startup.inventory = [{ private: 'not-exposed' }];
    await expect(create(startup)).rejects.toMatchObject({ code: 'APP_SERVER_ISOLATION_FAILED' });
    const server = new FakeServer(); const provider = await create(server); server.threadInventory = [{}];
    await expect(provider.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code: 'APP_SERVER_ISOLATION_FAILED' });
    expect(server.frames.some(frame => frame.method === 'turn/start')).toBe(false);
    expect(provider.configured).toBe(false);
    await provider.dispose();
  });

  it('allows only known disabled metadata with no active runtime or catalog entries', async () => {
    const server = new FakeServer(); server.config = { ...server.config, mcp_servers: { disabled_server: { enabled: false } } };
    const metadata = { name: 'disabled_server', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [] };
    server.inventory = [metadata]; server.threadInventory = [{ ...metadata, runtimeStatus: null }];
    const provider = await create(server);
    try { expect((await provider.generate('只有disabled metadata', new AbortController().signal)).status).toBe('ready'); }
    finally { await provider.dispose(); }
  });

  it.each(['unknown', 'connected', 'catalog', 'missing-status'])('rejects %s MCP metadata instead of treating it as disabled', async kind => {
    const server = new FakeServer(); server.config = { ...server.config, mcp_servers: { disabled_server: { enabled: false } } };
    const metadata: Record<string, unknown> = { name: 'disabled_server', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [] };
    if (kind === 'unknown') metadata.name = 'unconfigured_server';
    if (kind === 'connected') metadata.runtimeStatus = 'connected';
    if (kind === 'catalog') metadata.tools = { forbidden: {} };
    if (kind === 'missing-status') delete metadata.runtimeStatus;
    server.inventory = [metadata];
    await expect(create(server)).rejects.toMatchObject({ code: 'APP_SERVER_ISOLATION_FAILED' });
    expect(server.frames.some(frame => frame.method === 'thread/start')).toBe(false);
  });

  it('does not claim configured when the native account is logged out', async () => {
    const server = new FakeServer(); server.account = null;
    await expect(create(server)).rejects.toMatchObject({ code: 'CLI_NOT_LOGGED_IN' });
    expect(server.closed).toBe(true);
  });

  it('verifies the returned read-only ephemeral environment before any inference', async () => {
    const server = new FakeServer(); server.threadOverrides = { sandbox: { type: 'workspaceWrite' } };
    const provider = await create(server);
    await expect(provider.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code: 'APP_SERVER_ISOLATION_FAILED' });
    expect(server.frames.some(frame => frame.method === 'turn/start')).toBe(false);
    expect(provider.configured).toBe(false);
    await provider.dispose();
  });

  it('routes out-of-order thread responses and concurrent completion to the matching request', async () => {
    const server = new FakeServer(); const held: Frame[] = [];
    server.onThread = frame => {
      held.push(frame);
      if (held.length === 2) { server.startThread(held[1]!); server.startThread(held[0]!); }
    };
    const provider = await create(server);
    try {
      const result = await Promise.all(['甲物件', '乙物件'].map(prompt => provider.generate(prompt, new AbortController().signal)));
      expect(result.map(value => value.model?.name)).toEqual(['甲物件', '乙物件']);
    } finally { await provider.dispose(); }
  });

  it('waits for interrupted completion after cancellation; an interrupt acknowledgement is insufficient', async () => {
    const server = new FakeServer(); server.onTurn = frame => server.startTurn(frame); server.onInterrupt = frame => server.reply(frame, {});
    const provider = await create(server); const controller = new AbortController();
    let settled = false;
    const outcome = provider.generate('等待取消', controller.signal).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    const [turn] = await server.waitFor('turn/start'); controller.abort();
    const [interrupt] = await server.waitFor('turn/interrupt');
    expect(settled).toBe(false);
    server.notify('turn/completed', { threadId: turn!.params!.threadId, turn: { id: interrupt!.params!.turnId, status: 'interrupted', items: [] } });
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    expect(provider.configured).toBe(true);
    await provider.dispose();
  });

  it.each(['error', 'timeout'])('keeps other threads usable when completion precedes an interrupt RPC %s', async mode => {
    const server = new FakeServer(); server.onTurn = frame => server.startTurn(frame);
    server.onInterrupt = frame => {
      server.notify('turn/completed', { threadId: frame.params!.threadId, turn: { id: frame.params!.turnId, status: 'completed', items: [] } });
      if (mode === 'error') server.send({ id: frame.id, error: { code: -32600, message: 'No active turn' } });
    };
    const provider = await create(server, { cancellationTimeoutMs: 10 });
    const controller = new AbortController();
    const outcome = provider.generate('完成與取消同時發生', controller.signal).catch(error => error);
    await server.waitFor('turn/start'); controller.abort();
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(provider.configured).toBe(true);
    server.onTurn = undefined;
    expect((await provider.generate('後續物件仍可生成', new AbortController().signal)).model?.name).toBe('後續物件仍可生成');
    await provider.dispose();
  });

  it('interrupts and awaits a known active turn when its start RPC fails after turn/started', async () => {
    const server = new FakeServer(); server.onTurn = frame => {
      server.notify('turn/started', { threadId: frame.params!.threadId, turn: { id: `turn-${frame.params!.threadId}`, status: 'inProgress' } });
      server.send({ id: frame.id, error: { code: -32603, message: 'simulated start failure' } });
    };
    const provider = await create(server);
    await expect(provider.generate('啟動回覆出錯', new AbortController().signal)).rejects.toMatchObject({ code: 'APP_SERVER_RPC_FAILED' });
    expect(server.frames.some(frame => frame.method === 'turn/interrupt')).toBe(true);
    expect(provider.configured).toBe(true);
    await provider.dispose();
  });

  it('maps a timed out turn to TIMEOUT after it is interrupted', async () => {
    const server = new FakeServer(); server.onTurn = frame => server.startTurn(frame);
    const provider = await create(server, { timeoutMs: 10 });
    try { await expect(provider.generate('逾時物件', new AbortController().signal)).rejects.toMatchObject({ code: 'TIMEOUT' }); }
    finally { await provider.dispose(); }
    expect(server.frames.some(frame => frame.method === 'turn/interrupt')).toBe(true);
  });

  it('denies server tool/approval requests and cancels the turn without executing client actions', async () => {
    const server = new FakeServer(); server.onTurn = frame => {
      server.startTurn(frame);
      queueMicrotask(() => server.send({ id: 'server-tool-1', method: 'item/commandExecution/requestApproval', params: { threadId: frame.params!.threadId, turnId: `turn-${frame.params!.threadId}` } }));
    };
    const provider = await create(server);
    try { await expect(provider.generate('工具請求不得執行', new AbortController().signal)).rejects.toMatchObject({ code: 'APP_SERVER_TOOL_DENIED' }); }
    finally { await provider.dispose(); }
    expect(server.frames.find(frame => frame.id === 'server-tool-1')).toMatchObject({ error: { code: -32601 } });
  });

  it('rejects a forbidden tool item even if it did not request approval', async () => {
    const server = new FakeServer(); server.onTurn = frame => {
      server.startTurn(frame);
      queueMicrotask(() => server.notify('item/started', { threadId: frame.params!.threadId, turnId: `turn-${frame.params!.threadId}`,
        item: { type: 'mcpToolCall', id: 'not-allowed' } }));
    };
    const provider = await create(server);
    try { await expect(provider.generate('不可使用MCP', new AbortController().signal)).rejects.toMatchObject({ code: 'APP_SERVER_TOOL_DENIED' }); }
    finally { await provider.dispose(); }
  });

  it('does not accept invalid design data, a failed turn, or commentary as the final model', async () => {
    for (const mode of ['invalid', 'failed', 'commentary']) {
      const server = new FakeServer(); server.onTurn = frame => {
        server.startTurn(frame);
        if (mode === 'invalid') server.finish(frame, { bad: 'data' });
        else if (mode === 'failed') server.finish(frame, null, 'failed');
        else { server.notify('item/completed', { threadId: frame.params!.threadId, turnId: `turn-${frame.params!.threadId}`,
          item: { type: 'agentMessage', id: 'commentary', text: '處理中', phase: 'commentary' } }); server.finish(frame, null, 'completed-without-message'); }
      };
      const provider = await create(server);
      await expect(provider.generate(mode, new AbortController().signal)).rejects.toBeInstanceOf(Error);
      await provider.dispose();
    }
  });

  it('rejects pending calls and turns when the server exits', async () => {
    const server = new FakeServer(); server.onTurn = () => queueMicrotask(() => server.close());
    const provider = await create(server);
    await expect(provider.generate('突然中斷', new AbortController().signal)).rejects.toMatchObject({ code: 'APP_SERVER_CLOSED' });
    expect(provider.configured).toBe(false);
    await provider.dispose();
  });

  it.each(['not-json', 'oversized'])('bounds and validates %s stdout frames', async mode => {
    const server = new FakeServer(); server.onTurn = () => queueMicrotask(() => server.stdout.write(mode === 'not-json' ? 'not-json\n' : 'x'.repeat(20_000)));
    const provider = await create(server, { maxFrameBytes: 16_000 });
    await expect(provider.generate('格式錯誤', new AbortController().signal)).rejects.toMatchObject({ code: mode === 'not-json' ? 'APP_SERVER_PROTOCOL' : 'APP_SERVER_FRAME_LIMIT' });
    expect(provider.configured).toBe(false);
    await provider.dispose();
  });

  it('disposes the persistent process and rejects an active generation before returning', async () => {
    const server = new FakeServer(); server.onTurn = frame => server.startTurn(frame);
    const provider = await create(server);
    const outcome = provider.generate('關閉中的生成', new AbortController().signal).catch(error => error);
    await server.waitFor('turn/start'); await provider.dispose();
    expect(await outcome).toMatchObject({ code: 'APP_SERVER_CLOSED' });
    expect(server.closed).toBe(true);
  });
});

describe('persistent Codex app-server provider: edit task', () => {
  it('runs an edit task with its own instructions, input and schema on the same isolated path', async () => {
    const server = new FakeServer();
    const provider = await create(server);
    const plan = { status: 'clarify', explanation: '請問要放大哪個零件？', operations: [], name: null, summary: null, assumptions: null };
    server.onTurn = frame => { server.startTurn(frame); server.finish(frame, plan); };
    try {
      const result = await provider.run!(editTask(demoModel, '把它放大', [], 'zh-TW'), new AbortController().signal);
      expect(result).toEqual(plan);
      const thread = server.frames.find(frame => frame.method === 'thread/start')!;
      expect(thread.params!.baseInstructions).toBe(EDIT_INSTRUCTIONS);
      const turn = server.frames.find(frame => frame.method === 'turn/start')!;
      expect(turn.params!.outputSchema).toEqual(editJsonSchema());
      expect((turn.params!.input as Array<{ text: string }>)[0]!.text).toContain('EDIT_REQUEST:\n把它放大');
    } finally { await provider.dispose(); }
  });
});
