import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { GeneratedDesign } from '../shared/model';
import { designTask, GenerationError, type ModelProvider, type ModelTask } from './provider';

const DISABLED_FEATURES = ['shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use',
  'browser_use_external', 'computer_use', 'in_app_browser', 'code_mode_host', 'memories', 'skill_search'] as const;
const SAFE_CONFIG = { features: Object.fromEntries(DISABLED_FEATURES.map(feature => [feature, false])),
  mcp_servers: {}, project_doc_max_bytes: 0, web_search: 'disabled', sandbox_mode: 'read-only', approval_policy: 'never' };
const MAX_OUTPUT_BYTES = 1_000_000;

export interface AppServerProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}
export type AppServerSpawner = (executable: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; windowsHide: true; shell: false;
  stdio: ['pipe', 'pipe', 'pipe']; detached: boolean;
}) => AppServerProcess;

export interface CodexAppServerOptions {
  executable?: string;
  model?: string;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  cancellationTimeoutMs?: number;
  maxFrameBytes?: number;
  spawnProcess?: AppServerSpawner;
  onDiagnostic?: (event: { phase: string; elapsedMs: number; count?: number; scoped?: boolean }) => void;
}
export interface CodexAppServerProvider extends ModelProvider {
  readonly transport: 'app-server';
  readonly cliVersion: string | null;
  dispose(): Promise<void>;
}

type JsonObject = Record<string, unknown>;
type RpcId = string | number;
const object = (value: unknown): JsonObject | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
const id = (value: unknown): RpcId | null => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) ? value as RpcId : null;
const safeModel = (value: unknown): string | null => typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,100}$/.test(value) ? value : null;
const failure = (code: string, message: string, status = 502) => new GenerationError(code, message, status);

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'userprofile', 'homedrive', 'homepath',
    'home', 'localappdata', 'appdata', 'programdata', 'temp', 'tmp', 'tmpdir', 'codex_home',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
}

/** Newline-framed JSON-RPC only. No shell, raw stderr logs, or unbounded history. */
class StdioRpc {
  readonly process: AppServerProcess;
  private sequence = 0;
  private pending = new Map<RpcId, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private stopped = false;
  private closing: Promise<void> | null = null;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  private notifications = new Set<(method: string, params: JsonObject) => void>();
  private closedHandlers = new Set<(error: GenerationError) => void>();
  private requestHandlers = new Set<(params: JsonObject) => void>();
  error: GenerationError | null = null;

  constructor(executable: string, args: string[], cwd: string, private maxFrameBytes: number,
    spawnProcess: AppServerSpawner = (command, parameters, options) => spawn(command, parameters, options) as ChildProcessWithoutNullStreams) {
    try {
      this.process = spawnProcess(executable, args, { cwd, env: childEnvironment(), windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch { throw failure('CLI_UNAVAILABLE', '無法啟動 Codex app-server。請檢查安裝路徑與執行權限。', 503); }
    this.process.stdout.on('data', (chunk: Buffer | string) => {
      try { this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
      catch { this.fail(failure('APP_SERVER_PROTOCOL', 'Codex app-server 通訊失敗，已停止連線。')); }
    });
    // Drain diagnostics without retaining or forwarding private paths/auth/prompt text.
    this.process.stderr.on('data', () => {});
    this.process.stdin.on('error', () => this.fail(failure('APP_SERVER_CLOSED', 'Codex app-server 連線已關閉，請重新啟動工作台。', 503)));
    this.process.once('error', () => this.fail(failure('CLI_UNAVAILABLE', 'Codex app-server 無法執行，請檢查安裝與權限。', 503)));
    this.process.once('close', () => {
      this.stopped = true;
      const error = this.error ?? failure('APP_SERVER_CLOSED', 'Codex app-server 已停止，請重新啟動工作台。', 503);
      this.error = error;
      this.rejectPending(error);
      this.closedHandlers.forEach(handler => handler(error));
      this.resolveClosed();
    });
  }

  get available() { return !this.stopped && !this.error && !this.closing; }
  onNotification(handler: (method: string, params: JsonObject) => void) { this.notifications.add(handler); }
  onClosed(handler: (error: GenerationError) => void) { this.closedHandlers.add(handler); }
  onDeniedRequest(handler: (params: JsonObject) => void) { this.requestHandlers.add(handler); }

  private consume(chunk: Buffer) {
    if (this.stopped || this.error) return;
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
      this.fail(failure('APP_SERVER_FRAME_LIMIT', 'Codex app-server 回覆過大，已停止連線。')); return;
    }
    let boundary: number;
    while ((boundary = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, boundary).trim(); this.buffer = this.buffer.slice(boundary + 1);
      if (!line) continue;
      let message: JsonObject | null;
      try { message = object(JSON.parse(line)); } catch { message = null; }
      if (!message) { this.fail(failure('APP_SERVER_PROTOCOL', 'Codex app-server 傳回無效的通訊資料。')); return; }
      const messageId = id(message.id);
      if (typeof message.method === 'string') {
        const params = object(message.params) ?? {};
        if (messageId !== null) {
          // Never execute a server-requested tool, auth refresh, or approval.
          this.send({ id: messageId, error: { code: -32601, message: 'Client-side tools and approvals are disabled.' } });
          this.requestHandlers.forEach(handler => handler(params));
        } else this.notifications.forEach(handler => handler(message.method as string, params));
      } else if (messageId !== null) {
        const pending = this.pending.get(messageId);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(messageId);
        if (message.error !== undefined) pending.reject(failure('APP_SERVER_RPC_FAILED', 'Codex app-server 無法完成這個操作，請檢查 CLI 版本與設定。'));
        else if ('result' in message) pending.resolve(message.result);
        else pending.reject(failure('APP_SERVER_PROTOCOL', 'Codex app-server 回覆缺少結果。'));
      }
    }
  }

  private send(message: JsonObject) {
    if (this.stopped || this.error) throw this.error ?? failure('APP_SERVER_CLOSED', 'Codex app-server 已停止。', 503);
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw failure('APP_SERVER_FRAME_LIMIT', '模型描述或結構定義過大。');
    try { this.process.stdin.write(frame); }
    catch { this.fail(failure('APP_SERVER_CLOSED', 'Codex app-server 連線已中斷。', 503)); throw this.error; }
  }
  notify(method: string, params: JsonObject = {}) { this.send({ method, params }); }
  request(method: string, params: JsonObject, timeoutMs: number, fatalOnTimeout = true): Promise<unknown> {
    if (!this.available) return Promise.reject(this.error ?? failure('APP_SERVER_CLOSED', 'Codex app-server 已停止，請重新啟動工作台。', 503));
    if (this.pending.size >= 128) return Promise.reject(failure('APP_SERVER_BUSY', 'Codex app-server 待處理操作過多。', 429));
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = failure('APP_SERVER_RPC_TIMEOUT', 'Codex app-server 操作逾時，請重新啟動工作台。', 504);
        if (fatalOnTimeout) this.fail(error);
        else { this.pending.delete(requestId); reject(error); }
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ id: requestId, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  private rejectPending(error: Error) {
    this.pending.forEach(pending => { clearTimeout(pending.timer); pending.reject(error); });
    this.pending.clear();
  }
  fail(error: GenerationError) {
    if (this.error) return;
    this.error = error; this.rejectPending(error);
    void this.dispose().catch(() => {});
  }

  private kill() {
    if (!this.process.pid) { try { this.process.kill('SIGKILL'); } catch {} return; }
    if (process.platform === 'win32') {
      try {
        const taskkill = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
        const killer = spawn(taskkill, ['/pid', String(this.process.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { this.process.kill('SIGKILL'); } catch {} });
      } catch { try { this.process.kill('SIGKILL'); } catch {} }
    } else { try { process.kill(-this.process.pid, 'SIGKILL'); } catch { try { this.process.kill('SIGKILL'); } catch {} } }
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.stopped) return;
      try { this.process.stdin.end(); } catch {}
      const hardKill = setTimeout(() => this.kill(), 1000);
      let finalTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.closed, new Promise<never>((_resolve, reject) => {
          finalTimer = setTimeout(() => {
            this.kill();
            const error = failure('CLI_TERMINATION_FAILED', '無法確認 Codex app-server 已停止，請先關閉殘留程序。', 503);
            this.error = error; this.rejectPending(error); this.closedHandlers.forEach(handler => handler(error));
            reject(error);
          }, 10_000);
        })]);
      } finally { clearTimeout(hardKill); clearTimeout(finalTimer); }
    })();
    return this.closing;
  }
}

interface TurnState {
  threadId: string;
  turnId?: string;
  messages: Map<string, { text: string; phase: unknown }>;
  outputBytes: number;
  completed: boolean;
  cancellation: GenerationError | null;
  interruptSent: boolean;
  cancellationTimer?: ReturnType<typeof setTimeout>;
  resolve(text: string): void;
  reject(error: Error): void;
  done: Promise<string>;
}

export async function createCodexAppServerProvider(options: CodexAppServerOptions = {}): Promise<CodexAppServerProvider> {
  return createIsolatedProvider(options, []);
}

class McpDisableBootstrap extends Error {
  constructor(readonly names: string[]) { super('MCP entries require explicit ephemeral disabling'); }
}

async function createIsolatedProvider(options: CodexAppServerOptions, disabledMcpNames: string[]): Promise<CodexAppServerProvider> {
  const startedAt = Date.now();
  const diagnostic = (phase: string, details: { count?: number; scoped?: boolean } = {}) => {
    const event = { phase, elapsedMs: Date.now() - startedAt, ...details };
    try { options.onDiagnostic?.(event); } catch { /* diagnostics cannot change generation behavior */ }
    if (process.env.MODEL_DEBUG === '1') console.info('[model-debug]', JSON.stringify({ transport: 'app-server', ...event }));
  };
  const cwd = await mkdtemp(path.join(tmpdir(), 'forgehand-app-server-'));
  const startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const cancellationTimeoutMs = options.cancellationTimeoutMs ?? 10_000;
  let rpc: StdioRpc | undefined;
  let cleanupSafe = true;
  let disposed: Promise<void> | null = null;
  let model = options.model?.trim() || 'CLI default';
  let inFlight = 0;
  const states = new Map<string, TurnState>();
  const dispose = (): Promise<void> => disposed ??= (async () => {
    try { await rpc?.dispose(); }
    catch (error) { cleanupSafe = false; throw error; }
    finally {
      if (cleanupSafe && path.dirname(path.resolve(cwd)) === path.resolve(tmpdir()) && path.basename(cwd).startsWith('forgehand-app-server-')) {
        await rm(cwd, { recursive: true, force: true }).catch(() => {});
      }
    }
  })();

  try {
    const args = ['app-server', '--listen', 'stdio://'];
    for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
    for (const [key, value] of Object.entries(SAFE_CONFIG).filter(([key]) => key !== 'features')) args.push('-c', `${key}=${JSON.stringify(value)}`);
    // Empty TOML tables deep-merge in this CLI. A discovery-only first process
    // may supply names in memory; a single restart pins every entry disabled.
    // This CLI has been verified with bare dotted keys. Refuse special names
    // rather than depending on ambiguous quoted-key/inline-table merging.
    // Names stay in memory and argument arrays; no shell or config writes.
    for (const name of disabledMcpNames) args.push('-c', `mcp_servers.${name}.enabled=false`);
    // app-server 0.166 has no --ignore-user-config. Retain the authenticated
    // CODEX_HOME; fixed overrides and verified effective inventories gate use.
    rpc = new StdioRpc(options.executable || (process.platform === 'win32' ? 'codex.exe' : 'codex'), args, cwd,
      options.maxFrameBytes ?? 2_000_000, options.spawnProcess);
    diagnostic('spawned');
    const connection = rpc;
    const rejectState = (state: TurnState, error: Error) => {
      if (state.completed) return;
      state.completed = true; clearTimeout(state.cancellationTimer); state.reject(error);
    };
    connection.onClosed(error => states.forEach(state => rejectState(state, state.cancellation ?? error)));
    const interrupt = (state: TurnState, reason: GenerationError) => {
      if (state.completed) return;
      state.cancellation ??= reason;
      state.cancellationTimer ??= setTimeout(() => connection.fail(failure('APP_SERVER_INTERRUPT_TIMEOUT',
        'Codex app-server 未確認取消，已停止連線。請重新啟動工作台。', 504)), cancellationTimeoutMs);
      if (state.turnId && !state.interruptSent) {
        state.interruptSent = true;
        void connection.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }, cancellationTimeoutMs, false)
          .catch(() => {
            if (!state.completed) connection.fail(failure('APP_SERVER_INTERRUPT_FAILED', 'Codex app-server 無法確認取消，已停止連線。', 503));
          });
      }
    };
    const bindTurn = (state: TurnState, turnId: unknown) => {
      if (typeof turnId !== 'string') return false;
      if (state.turnId && state.turnId !== turnId) return false;
      state.turnId = turnId;
      if (state.cancellation) interrupt(state, state.cancellation);
      return true;
    };
    const collectItem = (state: TurnState, item: JsonObject) => {
      if (item.type !== 'agentMessage' || typeof item.id !== 'string' || typeof item.text !== 'string') return;
      const previous = state.messages.get(item.id)?.text ?? '';
      state.outputBytes += Buffer.byteLength(item.text) - Buffer.byteLength(previous);
      if (state.outputBytes > MAX_OUTPUT_BYTES) { interrupt(state, failure('CLI_OUTPUT_LIMIT', '模型資料過大，請減少零件後重試。')); return; }
      state.messages.set(item.id, { text: item.text, phase: item.phase });
    };
    connection.onDeniedRequest(params => {
      const target = typeof params.threadId === 'string' ? states.get(params.threadId) : null;
      if (target) interrupt(target, failure('APP_SERVER_TOOL_DENIED', '這次生成要求了未支援的工具，已取消。'));
      else if (typeof params.threadId !== 'string') states.forEach(state => interrupt(state, failure('APP_SERVER_TOOL_DENIED', '這次生成要求了未支援的工具，已取消。')));
    });
    connection.onNotification((method, params) => {
      const state = typeof params.threadId === 'string' ? states.get(params.threadId) : undefined;
      if (!state || state.completed) return;
      const turn = object(params.turn);
      if (method === 'turn/started') { bindTurn(state, turn?.id); return; }
      if (method === 'item/started' || method === 'item/completed') {
        if (!bindTurn(state, params.turnId)) return;
        const item = object(params.item);
        if (!item) return;
        if (!['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(String(item.type))) {
          interrupt(state, failure('APP_SERVER_TOOL_DENIED', '這次生成出現未支援的工具或執行項目，已取消。')); return;
        }
        if (method === 'item/completed') collectItem(state, item);
      } else if (method === 'turn/completed' && turn && bindTurn(state, turn.id)) {
        if (Array.isArray(turn.items) && turn.items.some(item => {
          const value = object(item); return value && !['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(String(value.type));
        })) {
          rejectState(state, failure('APP_SERVER_TOOL_DENIED', '這次生成包含未支援的工具項目，結果未採用。')); return;
        }
        if (Array.isArray(turn.items)) turn.items.forEach(item => { const value = object(item); if (value) collectItem(state, value); });
        if (state.cancellation) { rejectState(state, state.cancellation); return; }
        if (turn.status !== 'completed') {
          rejectState(state, failure(turn.status === 'interrupted' ? 'CANCELLED' : 'CLI_FAILED',
            turn.status === 'interrupted' ? '這次生成已取消。' : 'Codex app-server 未完成生成，請重試。', turn.status === 'interrupted' ? 499 : 502)); return;
        }
        const replies = [...state.messages.values()];
        const text = replies.filter(reply => reply.phase === 'final_answer').at(-1)?.text
          ?? replies.filter(reply => reply.phase == null).at(-1)?.text;
        if (!text) { rejectState(state, failure('INVALID_MODEL', 'Codex app-server 未提供完整模型資料。')); return; }
        state.completed = true; clearTimeout(state.cancellationTimer); state.resolve(text);
      }
    });
    const initialized = object(await connection.request('initialize', { clientInfo: { name: 'forgehand', title: 'Forgehand', version: '0.1.0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'] } }, startupTimeoutMs));
    connection.notify('initialized');
    diagnostic('initialized');
    const cliVersion = typeof initialized?.userAgent === 'string' ? initialized.userAgent.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.]+)?/)?.[0] ?? null : null;
    const effective = object(await connection.request('config/read', { includeLayers: false, cwd }, startupTimeoutMs));
    const config = object(effective?.config);
    const features = object(config?.features);
    const mcp = config?.mcp_servers;
    const mcpEntries = object(mcp);
    const mcpNames = mcpEntries ? Object.keys(mcpEntries) : [];
    const enabledMcpCount = mcpEntries ? Object.values(mcpEntries).filter(entry => object(entry)?.enabled !== false).length : 0;
    diagnostic('effective-disabled-feature-mismatches', { count: DISABLED_FEATURES.filter(feature => features?.[feature] !== false).length });
    diagnostic('effective-mcp-servers', { count: mcp == null ? 0 : object(mcp) ? Object.keys(mcp as JsonObject).length : -1 });
    diagnostic('effective-enabled-mcp-servers', { count: enabledMcpCount });
    if (!config || !features || DISABLED_FEATURES.some(feature => features[feature] !== false)
      || mcp != null && (!mcpEntries || Object.values(mcpEntries).some(entry => !object(entry)))
      || config.project_doc_max_bytes !== 0 || config.web_search !== 'disabled'
      || config.sandbox_mode !== 'read-only' || config.approval_policy !== 'never') {
      throw failure('APP_SERVER_ISOLATION_FAILED', 'Codex app-server 的工具隔離設定未通過核對，已停用此連線。', 503);
    }
    if (enabledMcpCount > 0) {
      if (!disabledMcpNames.length && mcpNames.length <= 100 && mcpNames.every(name => /^[a-zA-Z0-9_-]{1,256}$/.test(name))) {
        throw new McpDisableBootstrap(mcpNames);
      }
      throw failure('APP_SERVER_ISOLATION_FAILED', 'Codex app-server 仍有啟用中的 MCP 設定，已停用生成。', 503);
    }
    diagnostic('effective-config-verified');
    const ensureNoMcp = async (threadId?: string) => {
      const inventory = object(await connection.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly', ...(threadId ? { threadId } : {}) }, startupTimeoutMs));
      diagnostic('mcp-inventory-count', { count: Array.isArray(inventory?.data) ? inventory.data.length : -1, scoped: Boolean(threadId) });
      const metadata = Array.isArray(inventory?.data) ? inventory.data.map(object) : [];
      const active = metadata.filter(entry => !entry || entry.runtimeStatus !== null && entry.runtimeStatus !== 'disabled').length;
      const catalog = metadata.reduce((count, entry) => count + (object(entry?.tools) ? Object.keys(entry!.tools as JsonObject).length : 1)
        + (Array.isArray(entry?.resources) ? entry.resources.length : 1) + (Array.isArray(entry?.resourceTemplates) ? entry.resourceTemplates.length : 1), 0);
      diagnostic('mcp-active-runtime-count', { count: active, scoped: Boolean(threadId) });
      diagnostic('mcp-catalog-item-count', { count: catalog, scoped: Boolean(threadId) });
      const knownDisabled = new Set(mcpNames);
      const unknown = metadata.some(entry => !entry || typeof entry.name !== 'string' || !knownDisabled.has(entry.name));
      if (!Array.isArray(inventory?.data) || inventory.nextCursor !== null || active !== 0 || catalog !== 0 || unknown) {
        const error = failure('APP_SERVER_ISOLATION_FAILED', 'Codex app-server 仍有 MCP 連線，已停用生成。', 503);
        connection.fail(error); throw error;
      }
    };
    await ensureNoMcp();
    const account = object(await connection.request('account/read', { refreshToken: false }, startupTimeoutMs));
    if (!account || account.account == null && account.requiresOpenaiAuth !== false) {
      throw failure('CLI_NOT_LOGGED_IN', 'Codex CLI 尚未登入。請執行 codex login 後重新啟動工作台。', 503);
    }
    diagnostic('account-verified');
    model = safeModel(options.model?.trim()) ?? safeModel(config.model) ?? model;
    const run = async <T>(task: ModelTask<T>, signal: AbortSignal): Promise<T> => {
        if (!connection.available || disposed) throw connection.error ?? failure('APP_SERVER_CLOSED', 'Codex app-server 已停止，請重新啟動工作台。', 503);
        if (signal.aborted) throw failure('CANCELLED', '這次生成已取消。', 499);
        if (inFlight >= 3) throw failure('APP_SERVER_BUSY', '目前已有多個生成請求，請稍後重試。', 429);
        inFlight++;
        let state: TurnState | null = null;
        let aborted = false;
        let turnRequested = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => { aborted = true; if (state) interrupt(state, failure('CANCELLED', '這次生成已取消。', 499)); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          const response = object(await connection.request('thread/start', { ...(options.model?.trim() ? { model: options.model.trim() } : {}), cwd,
            ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', config: { ...SAFE_CONFIG,
              mcp_servers: Object.fromEntries(mcpNames.map(name => [name, { enabled: false }])) }, baseInstructions: task.instructions,
            developerInstructions: 'Return only the final JSON. Do not call any tools.', environments: [], dynamicTools: [] }, startupTimeoutMs));
          const thread = object(response?.thread), sandbox = object(response?.sandbox);
          const threadId = thread?.id;
          if (typeof threadId !== 'string' || thread?.ephemeral !== true || response?.approvalPolicy !== 'never'
            || sandbox?.type !== 'readOnly' || sandbox.networkAccess !== false
            || !Array.isArray(response?.instructionSources) || response.instructionSources.length !== 0 || !safeModel(response?.model)) {
            connection.fail(failure('APP_SERVER_ISOLATION_FAILED', 'Codex app-server 的執行環境未通過隔離核對，已停止連線。', 503));
            throw connection.error;
          }
          model = safeModel(response?.model) ?? model;
          diagnostic('thread-isolation-verified');
          let resolve!: (text: string) => void, reject!: (error: Error) => void;
          const done = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
          void done.catch(() => {});
          state = { threadId, messages: new Map(), outputBytes: 0, completed: false, cancellation: null, interruptSent: false, done, resolve, reject };
          states.set(threadId, state);
          await ensureNoMcp(threadId);
          if (aborted || signal.aborted) throw failure('CANCELLED', '這次生成已取消。', 499);
          timer = setTimeout(() => interrupt(state!, failure('TIMEOUT', 'Codex app-server 生成逾時，請減少零件後重試。', 504)), timeoutMs);
          turnRequested = true;
          diagnostic('turn-start-requested');
          const started = object(await connection.request('turn/start', { threadId, input: [{ type: 'text', text: task.input, text_elements: [] }],
            approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, environments: [], outputSchema: task.schema }, startupTimeoutMs));
          const turn = object(started?.turn);
          if (!bindTurn(state, turn?.id)) {
            connection.fail(failure('APP_SERVER_PROTOCOL', 'Codex app-server 回覆的工作識別不一致，已停止連線。'));
            throw connection.error;
          }
          const text = await done;
          diagnostic('turn-completed');
          try { return task.parse(JSON.parse(text)); }
          catch { throw failure('INVALID_MODEL', 'Codex app-server 模型資料未通過驗證，上一個成功模型會保留。'); }
        } catch (error) {
          if (state && turnRequested && !state.completed && connection.available) {
            const reason = error instanceof GenerationError ? error : failure('CLI_FAILED', 'Codex app-server 未能確認工作狀態，已取消。');
            if (state.turnId) {
              interrupt(state, reason);
              await state.done.catch(() => {});
            } else connection.fail(reason);
          }
          throw error;
        } finally {
          inFlight--;
          clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (state) {
            clearTimeout(state.cancellationTimer); states.delete(state.threadId);
            if (connection.available) {
              await connection.request('thread/unsubscribe', { threadId: state.threadId }, startupTimeoutMs).catch(() => {});
            }
          }
          if (connection.error) await dispose();
        }
    };
    return {
      name: 'codex', transport: 'app-server', cliVersion,
      get configured() { return connection.available && !disposed; },
      get model() { return model; },
      dispose, run,
      generate: (prompt: string, signal: AbortSignal): Promise<GeneratedDesign> => run(designTask(prompt), signal),
    };
  } catch (error) {
    await dispose();
    if (error instanceof McpDisableBootstrap) {
      diagnostic('mcp-disable-bootstrap-restart', { count: error.names.length });
      return createIsolatedProvider(options, error.names);
    }
    throw error instanceof GenerationError ? error : failure('APP_SERVER_FAILED', 'Codex app-server 初始化失敗，請檢查 CLI 版本與登入狀態。', 503);
  }
}
