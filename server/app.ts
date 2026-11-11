import express, { type ErrorRequestHandler, type Response } from 'express';
import path from 'node:path';
import { z } from 'zod';
import { applyEditPlan, EditError, EditRequestSchema, validateEditPlan, type EditPlan, type EditResult } from '../shared/edit';
import { validateDesign, validateModel, type GenerationResult, type ModelSpec } from '../shared/model';
import { createOpenAIProvider, editTask, GenerationError, type ModelProvider } from './provider';

const RequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(4000),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
});

export interface AppOptions {
  provider?: ModelProvider;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
  staticDirectory?: string;
}

export function createApp(options: AppOptions = {}) {
  const provider = options.provider ?? createOpenAIProvider(options);
  const timeoutMs = options.timeoutMs ?? 180_000;
  const terminationGraceMs = options.terminationGraceMs ?? 22000;
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A loopback-only app still must reject arbitrary websites using the local API.
    const origin = req.get('origin');
    if (origin) {
      try {
        const url = new URL(origin);
        if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
          res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: '只接受本機工作台的請求。' } });
          return;
        }
      } catch {
        res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: '請求來源無效。' } });
        return;
      }
    }
    next();
  });
  // Edit requests carry the current model (up to 64 parts, roughly 25 kB).
  app.use(express.json({ limit: '128kb', strict: true }));
  app.get('/api/status', (_req, res) => {
    res.json({ configured: provider.configured, provider: provider.name, model: provider.model,
      ...(provider.statusMessage ? { reason: provider.statusMessage } : {}) });
  });

  let activeRequests = 0;
  /**
   * Shared lifecycle for every model call: concurrency limit, client
   * disconnect, server timeout that waits for the provider to stop, and safe
   * error bodies. `work` returns the JSON body for a successful answer.
   */
  async function modelRoute(res: Response, requestId: string, work: (signal: AbortSignal, start: number) => Promise<unknown>) {
    if (activeRequests >= 3) {
      res.status(429).json({ error: { code: 'BUSY', message: '目前已有多個生成請求，請稍後重試。' }, requestId });
      return;
    }
    const start = performance.now();
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.on('close', disconnected);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    activeRequests++;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          // Keep the active slot until a real provider has stopped its process.
          // Only a provider that ignores cancellation reaches this final bound.
          terminationTimer = setTimeout(() => reject(new GenerationError('TIMEOUT',
            '模型服務回應逾時，請稍後重試或減少零件。', 504)), terminationGraceMs);
        }, timeoutMs);
      });
      const body = await Promise.race([work(controller.signal, start), timeout]);
      if (timedOut) throw new GenerationError('TIMEOUT', '模型服務回應逾時，請稍後重試或減少零件。', 504);
      if (!res.destroyed) res.json(body);
    } catch (error) {
      const safe = timedOut && !(error instanceof GenerationError && error.code === 'CLI_TERMINATION_FAILED')
        ? new GenerationError('TIMEOUT', '模型服務回應逾時，請稍後重試或減少零件。', 504)
        : error instanceof GenerationError ? error
        : new GenerationError('SERVICE_ERROR', '模型服務暫時無法完成生成，請稍後重試。');
      if (!res.destroyed) res.status(safe.status).json({ error: { code: safe.code, message: safe.message }, requestId });
    } finally {
      activeRequests--;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      res.off('close', disconnected);
    }
  }

  app.post('/api/generate', async (req, res) => {
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '請輸入 1–4000 字的物件描述，並使用有效的請求識別碼。' } });
      return;
    }
    const { prompt, requestId } = parsed.data;
    await modelRoute(res, requestId, async (signal, start) => {
      const raw = await provider.generate(prompt, signal);
      let design;
      try { design = validateDesign(raw); }
      catch { throw new GenerationError('INVALID_MODEL', '模型資料未通過驗證，上一個成功模型會保留。請修改描述後重試。'); }
      const result: GenerationResult = { design, source: provider.name, model: provider.model,
        elapsedMs: Math.round(performance.now() - start), requestId };
      return result;
    });
  });

  app.post('/api/edit', async (req, res) => {
    const parsed = EditRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '請輸入 1–4000 字的修改指示，並附上目前模型。' } });
      return;
    }
    const { instruction, requestId, selectedPartIds } = parsed.data;
    let model: ModelSpec;
    try { model = validateModel(parsed.data.model); }
    catch {
      res.status(400).json({ error: { code: 'INVALID_MODEL', message: '目前模型資料無效，無法修改。' }, requestId });
      return;
    }
    if (selectedPartIds.some(id => !model.parts.some(part => part.id === id))) {
      res.status(400).json({ error: { code: 'INVALID_SELECTION', message: '選取的零件不在目前模型中，請重新選取。' }, requestId });
      return;
    }
    const run = provider.run?.bind(provider);
    if (!run) {
      res.status(501).json({ error: { code: 'EDIT_UNSUPPORTED', message: '目前的模型服務不支援文字修改。' }, requestId });
      return;
    }
    await modelRoute(res, requestId, async (signal, start) => {
      const plan = await run(editTask(model, instruction, selectedPartIds), signal);
      let checked: EditPlan;
      try {
        checked = validateEditPlan(plan);
        // Prove the plan applies to the model it was made for. The browser
        // re-applies it to its latest model and handles conflicts itself.
        if (checked.status === 'applied') applyEditPlan(model, checked);
      } catch (error) {
        throw new GenerationError('INVALID_EDIT', `模型回覆的修改無法套用，目前模型已保留。${error instanceof EditError ? error.message : ''}`.trim());
      }
      const result: EditResult = { plan: checked, source: provider.name, model: provider.model,
        elapsedMs: Math.round(performance.now() - start), requestId };
      return result;
    });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '找不到此服務。' } }));
  if (options.staticDirectory) {
    app.use(express.static(path.resolve(options.staticDirectory)));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.resolve(options.staticDirectory!, 'index.html')));
  }
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const tooLarge = (error as { type?: string }).type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ error: { code: tooLarge ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON',
      message: tooLarge ? '請求過大，請縮短物件描述。' : '請求格式無效，請重新送出。' } });
  };
  app.use(errorHandler);
  return app;
}
