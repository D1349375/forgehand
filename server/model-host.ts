import { createCodexAppServerProvider } from './app-server';
import { createClaudeCodeProvider } from './claude';
import { createCodexProvider } from './codex';
import { createOpenAIProvider, GenerationError, type ModelProvider } from './provider';

/** Server-only selection. All implementations share the same design contract. */
export async function createModelHost(env: NodeJS.ProcessEnv = process.env): Promise<ModelProvider> {
  const name = env.MODEL_PROVIDER?.trim() || 'codex';
  if (name !== 'codex' && name !== 'claude' && name !== 'openai') throw new Error('MODEL_PROVIDER 必須是 codex、claude 或 openai');
  const timeoutMs = Number(env.MODEL_TIMEOUT_MS || 180_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new Error('MODEL_TIMEOUT_MS 必須是 1000–300000 的整數');
  if (name === 'openai') return createOpenAIProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, timeoutMs });
  if (name === 'claude') return createClaudeCodeProvider({ executable: env.CLAUDE_CLI_PATH, model: env.CLAUDE_MODEL, timeoutMs });
  const transport = env.CODEX_TRANSPORT?.trim() || 'app-server';
  if (transport !== 'app-server' && transport !== 'exec') throw new Error('CODEX_TRANSPORT 必須是 app-server 或 exec');
  const options = { executable: env.CODEX_CLI_PATH, model: env.CODEX_MODEL, timeoutMs };
  if (transport === 'exec') return Object.assign(await createCodexProvider(options), { transport: 'exec' as const });
  try { return await createCodexAppServerProvider(options); }
  catch (error) {
    // The local UI/demo remains available; real generation is never replaced.
    const safe = error instanceof GenerationError ? error : new GenerationError('APP_SERVER_FAILED', 'Codex CLI 長駐連線尚未準備就緒，請檢查登入與版本後重啟工作台。', 503);
    return { name: 'codex', transport: 'app-server', configured: false,
      model: env.CODEX_MODEL?.trim() || 'CLI 設定預設', statusMessage: safe.message,
      async generate() { throw safe; } };
  }
}
