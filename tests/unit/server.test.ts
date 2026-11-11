import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { createOpenAIProvider, GenerationError, type ModelProvider } from '../../server/provider';
import { demoModel } from '../../shared/demo';
import type { GeneratedDesign } from '../../shared/model';

const design: GeneratedDesign = { status: 'ready', explanation: '測試替身資料', model: demoModel };
const provider = (generate: ModelProvider['generate'] = async () => design): ModelProvider => ({
  name: 'openai', configured: true, model: 'test-double', generate,
});

describe('local model API (injected test provider, no real AI requests)', () => {
  it('reports configuration without exposing keys', async () => {
    const response = await request(createApp({ provider: provider() })).get('/api/status');
    expect(response.body).toEqual({ configured: true, provider: 'openai', model: 'test-double' });
  });
  it('uses the supplied free-form text and returns request identity', async () => {
    let received = '';
    const response = await request(createApp({ provider: provider(async prompt => { received = prompt; return design; }) }))
      .post('/api/generate').send({ prompt: '紫色三腳架上有兩個斜放的感測器，側邊加黃把手', requestId: 'latest-2' });
    expect(response.status).toBe(200);
    expect(received).toBe('紫色三腳架上有兩個斜放的感測器，側邊加黃把手');
    expect(response.body).toMatchObject({ source: 'openai', requestId: 'latest-2', design });
    expect(response.body.elapsedMs).toBeGreaterThanOrEqual(0);
  });
  it('fails explicitly when no real API key is configured', async () => {
    const app = createApp({ provider: createOpenAIProvider({ apiKey: '' }) });
    const response = await request(app).post('/api/generate').send({ prompt: '紅桌子', requestId: 'req' });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('NOT_CONFIGURED');
  });
  it.each(['', ' '.repeat(10), 'x'.repeat(4001)])('rejects invalid text without calling provider', async prompt => {
    const response = await request(createApp({ provider: provider(async () => { throw new Error('must not run'); }) }))
      .post('/api/generate').send({ prompt, requestId: 'req' });
    expect(response.status).toBe(400);
  });
  it('rejects a model with invalid data', async () => {
    const bad = structuredClone(design); bad.model!.parts[0]!.dimensions.x = -1;
    const response = await request(createApp({ provider: provider(async () => bad) }))
      .post('/api/generate').send({ prompt: '桌子', requestId: 'req' });
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('INVALID_MODEL');
  });
  it('does not leak provider errors or secrets', async () => {
    const response = await request(createApp({ provider: provider(async () => { throw new Error('sk-secret-do-not-leak'); }) }))
      .post('/api/generate').send({ prompt: '桌子', requestId: 'req' });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('sk-secret');
  });
  it('preserves actionable sanitized service errors', async () => {
    const response = await request(createApp({ provider: provider(async () => { throw new GenerationError('RATE_LIMITED', '請稍後重試', 429); }) }))
      .post('/api/generate').send({ prompt: '桌子', requestId: 'req' });
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('RATE_LIMITED');
  });
  it('times out even a noncooperating test provider', async () => {
    const response = await request(createApp({ timeoutMs: 10, terminationGraceMs: 20, provider: provider(() => new Promise(() => {})) }))
      .post('/api/generate').send({ prompt: '桌子', requestId: 'req' });
    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe('TIMEOUT');
  });
  it('holds active slots until cancellation cleanup has finished', async () => {
    let aborted = 0;
    const releases: Array<() => void> = [];
    const app = createApp({ timeoutMs: 100, terminationGraceMs: 10_000, provider: provider((_prompt, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted++; releases.push(() => reject(new GenerationError('CANCELLED', '已取消', 499))); });
    })) });
    const active = ['a', 'b', 'c'].map(requestId => request(app).post('/api/generate').send({ prompt: '桌子', requestId }).then(response => response));
    for (let attempt = 0; attempt < 100 && aborted < 3; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(aborted).toBe(3);
    const busy = await request(app).post('/api/generate').send({ prompt: '新桌子', requestId: 'fourth' });
    expect(busy.status).toBe(429);
    expect(busy.body.error.code).toBe('BUSY');
    releases.forEach(release => release());
    const responses = await Promise.all(active);
    expect(responses.every(response => response.status === 504)).toBe(true);
  });
  it('rejects remote website origin and malformed JSON', async () => {
    const app = createApp({ provider: provider() });
    expect((await request(app).post('/api/generate').set('Origin', 'https://evil.example').send({ prompt: '桌子', requestId: 'req' })).status).toBe(403);
    const malformed = await request(app).post('/api/generate').set('Content-Type', 'application/json').send('{invalid');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');
  });
  it('rejects oversized input and unknown API endpoints', async () => {
    const app = createApp({ provider: provider() });
    const response = await request(app).post('/api/generate').send({ prompt: 'x'.repeat(200_000), requestId: 'req' });
    expect(response.status).toBe(413);
    expect((await request(app).get('/api/missing')).status).toBe(404);
  });
});
