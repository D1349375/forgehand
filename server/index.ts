import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createApp } from './app';
import { createModelHost } from './model-host';

const port = Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必須是 1024–65535 的整數');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const apiPort = production ? port : Number(process.env.API_PORT || 8787);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535 || (!production && apiPort === port)) {
  throw new Error('API_PORT 必須是 1024–65535 的整數，且開發模式需與 PORT 不同');
}
const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 180_000);
const agentMaxRounds = Number(process.env.AGENT_MAX_ROUNDS || 6);
if (!Number.isInteger(agentMaxRounds) || agentMaxRounds < 1 || agentMaxRounds > 20) throw new Error('AGENT_MAX_ROUNDS 必須是 1–20 的整數');
const agentTotalTimeoutMs = Number(process.env.AGENT_TOTAL_TIMEOUT_MS || 600_000);
if (!Number.isInteger(agentTotalTimeoutMs) || agentTotalTimeoutMs < 1000) throw new Error('AGENT_TOTAL_TIMEOUT_MS 必須是不小於 1000 的整數（毫秒）');
const provider = await createModelHost();
const app = createApp({ provider, timeoutMs, agentMaxRounds, agentTotalTimeoutMs,
  staticDirectory: production ? 'dist' : undefined });
// Keep the model host independent of Vite's runtime and native workers.
// Production serves dist directly; development proxies /api from Vite.
let frontend: ChildProcess | null = null;
const server = app.listen(apiPort, '127.0.0.1', () => {
  console.log(`Forgehand 本機服務：http://127.0.0.1:${port}`);
  console.log(`模型服務：${provider.name} / ${provider.model}；${provider.configured ? '已設定（連線品質待實測）' : '尚未設定或登入'}`);
  if (!production) {
    frontend = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      windowsHide: true, shell: false, stdio: 'inherit', env: { ...process.env, FORGEHAND_API_PORT: String(apiPort) },
    });
    frontend.on('error', () => { console.error('無法啟動前端服務，請確認已安裝相依套件。'); stop(); });
    frontend.on('exit', () => { void stop(); });
  }
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close();
  if (frontend?.pid && process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/pid', String(frontend.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.on('error', () => { frontend?.kill(); });
  } else frontend?.kill('SIGTERM');
  try { await provider.dispose?.(); }
  catch { console.error('模型連線尚未確認關閉，請檢查本次 CLI 程序。'); }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop(); });
