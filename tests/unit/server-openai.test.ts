import { describe, expect, it } from 'vitest';
import { createOpenAIProvider } from '../../server/provider';
import { demoModel } from '../../shared/demo';

const design = { status: 'ready', explanation: 'REST adapter 測試替身', model: demoModel };
const completed = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(design) }] }] };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('optional OpenAI REST provider (mocked fetch, no real API requests)', () => {
  it('uses strict shared schema and keeps authorization on the server request', async () => {
    const provider = createOpenAIProvider({ apiKey: 'test-key', model: 'test-model', fetcher: async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'test-model', store: false,
        input: [{ role: 'user', content: '任意新組合物件' }],
        text: { format: { type: 'json_schema', strict: true, schema: { additionalProperties: false } } } });
      return jsonResponse(completed);
    } });
    expect(await provider.generate('任意新組合物件', new AbortController().signal)).toEqual(design);
  });
  it.each([[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [404, 'MODEL_UNAVAILABLE'], [429, 'RATE_LIMITED'], [500, 'SERVICE_ERROR']])
    ('maps HTTP %i into a sanitized error', async (status, code) => {
      const provider = createOpenAIProvider({ apiKey: 'test-key', fetcher: async () => jsonResponse({ secret: 'do-not-leak' }, Number(status)) });
      await expect(provider.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code });
    });
  it.each([
    [{ status: 'incomplete', output: [] }, 'INCOMPLETE'],
    [{ status: 'failed', output: completed.output }, 'SERVICE_ERROR'],
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, 'REFUSED'],
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"bad":"data"}' }] }] }, 'INVALID_MODEL'],
  ])('rejects incomplete, refused, failed or invalid output', async (body, code) => {
    const provider = createOpenAIProvider({ apiKey: 'test-key', fetcher: async () => jsonResponse(body) });
    await expect(provider.generate('桌子', new AbortController().signal)).rejects.toMatchObject({ code });
  });
  it('forwards cancellation without returning raw network errors', async () => {
    const provider = createOpenAIProvider({ apiKey: 'test-key', fetcher: async () => { throw new Error('private network diagnostic'); } });
    const controller = new AbortController(); controller.abort();
    await expect(provider.generate('桌子', controller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
