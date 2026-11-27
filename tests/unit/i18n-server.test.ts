import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { AGENT_INSTRUCTIONS, agentInstructions, runAgent } from '../../server/agent';
import { LANGUAGE_LINE, UI_NAMES } from '../../server/i18n/instructions';
import {
  createOpenAIProvider, EDIT_INSTRUCTIONS, editInstructions, editTask, designTask, GenerationError, MODEL_INSTRUCTIONS,
  modelInstructions, type ModelProvider, type ModelTask,
} from '../../server/provider';
import { langOf } from '../../server/tools/helpers';
import type { AgentRequest } from '../../shared/agent';
import { demoModel } from '../../shared/demo';
import type { EditPlan } from '../../shared/edit';
import { hasCjk } from '../../shared/i18n/format';
import { sceneObject, withModel, workspaceOf } from './agent-fixtures';

/**
 * english-ui Task 2 (design 4.4): the request language reaches the instruction texts of generation, edits and
 * the agent. Every provider is a test double (a fetch double for the OpenAI adapter, a fake `run` for the agent).
 */

const design = { status: 'ready', explanation: 'Test double', model: demoModel };
const battery = demoModel.parts.find(part => part.id === 'battery')!;
const recolor: EditPlan = {
  status: 'applied', explanation: 'Recoloured the battery.', name: null, summary: null, assumptions: null,
  operations: [{ op: 'upsert', partId: 'battery', part: { ...battery, color: '#2563eb' } }],
};
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const completedWith = (payload: unknown) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] });

/** The OpenAI adapter with a fetch double that records the `instructions` field of each request. */
function recordingProvider(answer: unknown): { provider: ModelProvider; seen: string[] } {
  const seen: string[] = [];
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetcher: async (_url, init) => {
      seen.push((JSON.parse(String(init?.body)) as { instructions: string }).instructions);
      return jsonResponse(completedWith(answer));
    },
  });
  return { provider, seen };
}

/** The lines of an instruction text that `GEOMETRY_RULES` copies (they must be identical in both languages). */
const geometryLines = (text: string) => text.split('\n')
  .filter(line => /^(Only the following controlled solid primitives|Model schema version is|Each part has a stable|Use realistic scale)/.test(line));
/** The Chinese words the English edit instructions keep on purpose (english-ui R23). */
const KEPT_WORDS = ['這個', '它', '這些'];
const withoutAllowedWords = (text: string) => KEPT_WORDS.reduce((rest, word) => rest.split(word).join(''), text);

describe('instruction texts per language', () => {
  it('keeps the exported constants equal to the zh-TW variants', () => {
    expect(MODEL_INSTRUCTIONS).toBe(modelInstructions('zh-TW'));
    expect(EDIT_INSTRUCTIONS).toBe(editInstructions('zh-TW'));
    expect(AGENT_INSTRUCTIONS).toBe(agentInstructions('zh-TW'));
  });

  it('carries the language sentence in each variant and nowhere else', () => {
    expect(MODEL_INSTRUCTIONS).toContain(LANGUAGE_LINE.design['zh-TW']);
    expect(modelInstructions('en')).toContain(LANGUAGE_LINE.design.en);
    expect(modelInstructions('en')).not.toContain('Traditional Chinese');
    expect(EDIT_INSTRUCTIONS).toContain(LANGUAGE_LINE.edit['zh-TW']);
    expect(editInstructions('en')).toContain(LANGUAGE_LINE.edit.en);
    expect(editInstructions('en')).not.toContain('Traditional Chinese');
    expect(AGENT_INSTRUCTIONS).toContain(LANGUAGE_LINE.agent['zh-TW']);
    expect(agentInstructions('en')).toContain(LANGUAGE_LINE.agent.en);
    expect(agentInstructions('en')).not.toContain('Traditional Chinese');
  });

  it('differs between the two languages only in the language slots', () => {
    expect(modelInstructions('en').replace(LANGUAGE_LINE.design.en, LANGUAGE_LINE.design['zh-TW'])).toBe(MODEL_INSTRUCTIONS);
    expect(editInstructions('en').replace(LANGUAGE_LINE.edit.en, LANGUAGE_LINE.edit['zh-TW'])).toBe(EDIT_INSTRUCTIONS);
    const agentEn = agentInstructions('en')
      .replace(LANGUAGE_LINE.agent.en, LANGUAGE_LINE.agent['zh-TW'])
      .replace(`(${UI_NAMES.cameraImage.en})`, `(${UI_NAMES.cameraImage['zh-TW']})`)
      .replace(UI_NAMES.downloadKit.en, UI_NAMES.downloadKit['zh-TW']);
    expect(agentEn).toBe(AGENT_INSTRUCTIONS);
  });

  it('keeps the geometry rules identical in generation, edit and agent instructions, in both languages', () => {
    const rules = geometryLines(MODEL_INSTRUCTIONS);
    expect(rules).toHaveLength(4);
    for (const lang of ['zh-TW', 'en'] as const) {
      expect(geometryLines(modelInstructions(lang))).toEqual(rules);
      for (const text of [editInstructions(lang), agentInstructions(lang)]) expect(text).toContain(rules.join('\n'));
    }
  });

  it('keeps the English variants free of Chinese text, except the words the edit rule needs', () => {
    expect(hasCjk(modelInstructions('en'))).toBe(false);
    expect(hasCjk(agentInstructions('en'))).toBe(false);
    expect(hasCjk(withoutAllowedWords(editInstructions('en')))).toBe(false);
    // The edit rule keeps the Chinese words for "this" in both languages, because a user may type either.
    for (const word of KEPT_WORDS) expect(editInstructions('en')).toContain(word);
  });

  it('names the controls in the language of the request', () => {
    expect(agentInstructions('zh-TW')).toContain('下載完整套件');
    expect(agentInstructions('en')).toContain('Download full kit');
    expect(agentInstructions('en')).not.toContain('下載完整套件');
    expect(agentInstructions('zh-TW')).toContain('隱藏或顯示鏡頭畫面');
  });

  it('builds each task with its language, and the language is required', () => {
    expect(designTask('a table', 'en').instructions).toBe(modelInstructions('en'));
    expect(designTask('a table', 'zh-TW').instructions).toBe(MODEL_INSTRUCTIONS);
    expect(editTask(demoModel, 'bigger', [], 'en').instructions).toBe(editInstructions('en'));
    expect(editTask(demoModel, 'bigger', [], 'zh-TW').instructions).toBe(EDIT_INSTRUCTIONS);
  });
});

describe('Accept-Language on /api/generate', () => {
  const generate = async (header: string | undefined) => {
    const { provider, seen } = recordingProvider(design);
    let call = request(createApp({ provider })).post('/api/generate');
    if (header !== undefined) call = call.set('Accept-Language', header);
    const response = await call.send({ prompt: 'a small red table', requestId: 'lang-1' });
    return { response, seen };
  };

  it('uses the zh-TW instructions without a header (today\'s behaviour)', async () => {
    const { response, seen } = await generate(undefined);
    expect(response.status).toBe(200);
    expect(seen).toEqual([MODEL_INSTRUCTIONS]);
  });

  it('uses the English instructions for Accept-Language: en', async () => {
    const { response, seen } = await generate('en');
    expect(response.status).toBe(200);
    expect(seen).toEqual([modelInstructions('en')]);
  });

  it('reads only the first tag: en-US with weights is English, zh-TW and unknown tags are Chinese', async () => {
    expect((await generate('en-US,en;q=0.9,zh-TW;q=0.8')).seen).toEqual([modelInstructions('en')]);
    expect((await generate('zh-TW')).seen).toEqual([MODEL_INSTRUCTIONS]);
    expect((await generate('fr-FR, en;q=0.5')).seen).toEqual([MODEL_INSTRUCTIONS]);
    expect((await generate('x'.repeat(5000))).seen).toEqual([MODEL_INSTRUCTIONS]);
  });

  it('passes the language to a provider double and defaults to undefined for a direct call', async () => {
    const received: Array<string | undefined> = [];
    const provider: ModelProvider = {
      name: 'openai', configured: true, model: 'double',
      generate: async (_prompt, _signal, lang) => { received.push(lang); return design as never; },
    };
    const app = createApp({ provider });
    await request(app).post('/api/generate').set('Accept-Language', 'en').send({ prompt: 'table', requestId: 'r1' });
    await request(app).post('/api/generate').send({ prompt: 'table', requestId: 'r2' });
    expect(received).toEqual(['en', 'zh-TW']);
    // The adapter itself falls back to zh-TW when a caller passes no language.
    const { provider: adapter, seen } = recordingProvider(design);
    await adapter.generate('table', new AbortController().signal);
    expect(seen).toEqual([MODEL_INSTRUCTIONS]);
  });

  it('keeps error texts as they are in this task (the sanitized messages are localized in a later task)', async () => {
    const failing: ModelProvider = {
      name: 'openai', configured: true, model: 'double',
      generate: async () => { throw new GenerationError('SERVICE_ERROR', '模型服務暫時無法完成生成，請稍後重試。'); },
    };
    const response = await request(createApp({ provider: failing })).post('/api/generate').set('Accept-Language', 'en')
      .send({ prompt: 'table', requestId: 'r3' });
    expect(response.status).toBe(502);
    expect(response.body.error.message).toBe('模型服務暫時無法完成生成，請稍後重試。');
    expect(JSON.stringify(response.body)).not.toContain('Accept-Language');
  });

  it('still answers /api/status with a language header', async () => {
    const { provider } = recordingProvider(design);
    const response = await request(createApp({ provider })).get('/api/status').set('Accept-Language', 'en');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: true, provider: 'openai' });
  });
});

describe('Accept-Language on /api/edit', () => {
  const edit = async (header: string | undefined) => {
    const { provider, seen } = recordingProvider(recolor);
    let call = request(createApp({ provider })).post('/api/edit');
    if (header !== undefined) call = call.set('Accept-Language', header);
    const response = await call.send({ instruction: 'make the battery blue', requestId: 'edit-lang', model: demoModel, selectedPartIds: ['battery'] });
    return { response, seen };
  };

  it('uses the zh-TW edit instructions without a header and the English ones for en', async () => {
    const zh = await edit(undefined);
    expect(zh.response.status).toBe(200);
    expect(zh.seen).toEqual([EDIT_INSTRUCTIONS]);
    const en = await edit('en');
    expect(en.response.status).toBe(200);
    expect(en.seen).toEqual([editInstructions('en')]);
  });
});

describe('Accept-Language on /api/agent', () => {
  /** A fake agent model that records each task's instructions and answers with a final reply. */
  function agentProvider(seen: ModelTask<unknown>[]): ModelProvider {
    return {
      name: 'openai', configured: true, model: 'double',
      generate: async () => { throw new Error('unused'); },
      run: async <T>(task: ModelTask<T>) => {
        seen.push(task as ModelTask<unknown>);
        return task.parse({ type: 'final', note: null, reply: 'Done.', calls: null });
      },
    };
  }
  const agentBody = () => ({
    instruction: 'show the exploded view', requestId: 'agent-lang', workspace: workspaceOf(sceneObject('obj-1')),
    tryOn: false, cameraOn: false, history: [],
  });

  it('builds the agent instructions in the request language', async () => {
    const zh: ModelTask<unknown>[] = [];
    await request(createApp({ provider: agentProvider(zh) })).post('/api/agent').send(agentBody());
    expect(zh.map(task => task.instructions)).toEqual([AGENT_INSTRUCTIONS]);
    const en: ModelTask<unknown>[] = [];
    await request(createApp({ provider: agentProvider(en) })).post('/api/agent').set('Accept-Language', 'en-US,en;q=0.9').send(agentBody());
    expect(en.map(task => task.instructions)).toEqual([agentInstructions('en')]);
  });
});

describe('the language inside an agent run', () => {
  const REQUEST: AgentRequest = {
    instruction: 'redo it', requestId: 'run-lang', workspace: workspaceOf(sceneObject('obj-1')),
    tryOn: false, cameraOn: false, history: [],
  };
  const calls = (...tools: Array<[string, Record<string, unknown>]>) =>
    ({ type: 'tool_calls', note: null, reply: null, calls: tools.map(([tool, args]) => ({ tool, argsJson: JSON.stringify(args), reason: null })) });

  async function run(lang: 'zh-TW' | 'en' | undefined) {
    const tasks: ModelTask<unknown>[] = [];
    const queue: unknown[] = [
      calls(['generate_design', { prompt: 'a lamp' }], ['edit_design', { instruction: 'bigger' }]),
      { type: 'final', note: null, reply: 'Done.', calls: null },
    ];
    const provider: ModelProvider = {
      name: 'openai', configured: true, model: 'double',
      generate: async () => { throw new Error('unused'); },
      run: async <T>(task: ModelTask<T>) => {
        tasks.push(task as ModelTask<unknown>);
        if (task.kind === 'design') return task.parse(design);
        if (task.kind === 'edit') return task.parse(recolor);
        return task.parse(queue.shift());
      },
    };
    await runAgent(provider, REQUEST, { maxRounds: 4, totalTimeoutMs: 60_000, ...(lang ? { lang } : {}) }, () => {}, new AbortController().signal);
    return tasks;
  }

  it('hands the language to the design and edit sub-tasks and to every agent round', async () => {
    const tasks = await run('en');
    expect(tasks.filter(task => task.kind === 'agent').map(task => task.instructions))
      .toEqual([agentInstructions('en'), agentInstructions('en')]);
    expect(tasks.find(task => task.kind === 'design')!.instructions).toBe(modelInstructions('en'));
    expect(tasks.find(task => task.kind === 'edit')!.instructions).toBe(editInstructions('en'));
  });

  it('defaults to zh-TW when the run has no language', async () => {
    const tasks = await run(undefined);
    expect(tasks.find(task => task.kind === 'design')!.instructions).toBe(MODEL_INSTRUCTIONS);
    expect(tasks.find(task => task.kind === 'edit')!.instructions).toBe(EDIT_INSTRUCTIONS);
    expect(tasks.filter(task => task.kind === 'agent').every(task => task.instructions === AGENT_INSTRUCTIONS)).toBe(true);
  });

  it('reads the language of the working state with langOf', () => {
    expect(langOf(withModel())).toBe('zh-TW');
    expect(langOf({ ...withModel(), lang: 'en' })).toBe('en');
    expect(langOf({ ...withModel(), lang: 'zh-TW' })).toBe('zh-TW');
  });
});
