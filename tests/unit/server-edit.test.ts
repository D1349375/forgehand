import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { createOpenAIProvider, EDIT_INSTRUCTIONS, editTask, GenerationError, MODEL_INSTRUCTIONS, type ModelProvider, type ModelTask } from '../../server/provider';
import { demoModel } from '../../shared/demo';
import type { EditPlan } from '../../shared/edit';
import { editJsonSchema } from '../../shared/schema';

const battery = demoModel.parts.find(part => part.id === 'battery')!;
const recolor: EditPlan = { status: 'applied', explanation: '電池改成藍色', operations: [{ op: 'upsert', partId: 'battery', part: { ...battery, color: '#2563eb' } }], name: null, summary: null, assumptions: null };
const provider = (run: (task: ModelTask<unknown>, signal: AbortSignal) => Promise<unknown>): ModelProvider => ({
  name: 'claude', configured: true, model: 'edit-double', async generate() { throw new Error('unused'); },
  run: <T>(task: ModelTask<T>, signal: AbortSignal) => run(task, signal).then(value => task.parse(value)),
});
const body = (values: Record<string, unknown> = {}) => ({ instruction: '把電池改成藍色', requestId: 'edit-1', model: demoModel, selectedPartIds: ['battery'], ...values });

describe('POST /api/edit (provider test doubles)', () => {
  it('sends the current model, selection and instruction as an edit task and returns the checked plan', async () => {
    let seen: ModelTask<unknown> | undefined;
    const app = createApp({ provider: provider(async task => { seen = task; return recolor; }) });
    const response = await request(app).post('/api/edit').send(body());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ plan: recolor, source: 'claude', model: 'edit-double', requestId: 'edit-1' });
    expect(seen!.kind).toBe('edit');
    expect(seen!.instructions).toBe(EDIT_INSTRUCTIONS);
    expect(seen!.schema).toEqual(editJsonSchema());
    expect(seen!.input).toContain('"id":"battery"');
    expect(seen!.input).toContain('SELECTED_PART_IDS: ["battery"]');
    expect(seen!.input.endsWith('EDIT_REQUEST:\n把電池改成藍色')).toBe(true);
  });

  it('returns clarify answers without changes', async () => {
    const clarify = { status: 'clarify', explanation: '要放大哪個零件？', operations: [], name: null, summary: null, assumptions: null };
    const response = await request(createApp({ provider: provider(async () => clarify) })).post('/api/edit').send(body({ selectedPartIds: [] }));
    expect(response.status).toBe(200);
    expect(response.body.plan).toEqual(clarify);
  });

  it('rejects invalid requests before calling the model', async () => {
    let calls = 0;
    const app = createApp({ provider: provider(async () => { calls++; return recolor; }) });
    expect((await request(app).post('/api/edit').send(body({ instruction: ' ' }))).status).toBe(400);
    expect((await request(app).post('/api/edit').send(body({ model: { ...demoModel, parts: [] } }))).body.error.code).toBe('INVALID_MODEL');
    expect((await request(app).post('/api/edit').send(body({ selectedPartIds: ['ghost'] }))).body.error.code).toBe('INVALID_SELECTION');
    expect(calls).toBe(0);
  });

  it('rejects a plan that does not apply to the submitted model', async () => {
    const orphaning = { ...recolor, operations: [{ op: 'remove', partId: 'housing', part: null }] };
    const response = await request(createApp({ provider: provider(async () => orphaning) })).post('/api/edit').send(body());
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('INVALID_EDIT');
    expect(response.body.error.message).toContain('依附在被刪除的零件上');
  });

  it('maps provider failures and missing edit support to safe errors', async () => {
    const failing = provider(async () => { throw new GenerationError('RATE_LIMITED', '暫時達到用量限制', 429); });
    expect((await request(createApp({ provider: failing })).post('/api/edit').send(body())).status).toBe(429);
    const generateOnly: ModelProvider = { name: 'openai', configured: true, model: 'x', async generate() { throw new Error('unused'); } };
    expect((await request(createApp({ provider: generateOnly })).post('/api/edit').send(body())).body.error.code).toBe('EDIT_UNSUPPORTED');
  });

  it('times out an edit with the same lifecycle as generation', async () => {
    const slow = provider((_task, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new GenerationError('CANCELLED', 'x', 499)))));
    const response = await request(createApp({ provider: slow, timeoutMs: 50, terminationGraceMs: 50 })).post('/api/edit').send(body());
    expect(response.status).toBe(504);
  });

  it('OpenAI adapter sends the edit task schema and instructions', async () => {
    let sent: { instructions: string; text: { format: { name: string; schema: unknown } }; input: Array<{ content: string }> } | undefined;
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(recolor) }] }] }), { status: 200 });
    }) as typeof fetch;
    const openai = createOpenAIProvider({ apiKey: 'test-key', fetcher });
    expect(await openai.run!(editTask(demoModel, '改藍色', ['battery'], 'zh-TW'), new AbortController().signal)).toEqual(recolor);
    expect(sent!.instructions).toBe(EDIT_INSTRUCTIONS);
    expect(sent!.text.format.name).toBe('concept_edit');
    expect(sent!.text.format.schema).toEqual(editJsonSchema());
    expect(EDIT_INSTRUCTIONS).toContain(MODEL_INSTRUCTIONS.split('\n').find(line => line.startsWith('Model schema version'))!);
  });
});
