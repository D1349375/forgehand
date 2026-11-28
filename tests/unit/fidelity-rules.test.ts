import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { BASELINE_MODEL_INSTRUCTIONS } from '../../scripts/fidelity-baseline';
import { AGENT_INSTRUCTIONS, agentInstructions, runAgent } from '../../server/agent';
import { runTool } from '../../server/agent-tools';
import { createApp } from '../../server/app';
import {
  DETAIL_MODE_LINE, DETAILED_PART_CAP, designTask, EDIT_INSTRUCTIONS, editInstructions, editTask, FIDELITY_RULES,
  GENERATOR_VERSION, GEOMETRY_RULES, labelledInput, MODEL_INSTRUCTIONS, modelInstructions, PART_RULES, PRIMITIVE_RULES,
  type ModelProvider, type ModelTask,
} from '../../server/provider';
import { AgentRequestSchema, validateAgentRequest, type AgentRequest } from '../../shared/agent';
import { demoModel } from '../../shared/demo';
import { EditRequestSchema } from '../../shared/edit';
import { hasCjk } from '../../shared/i18n/format';
import { referenceLines } from '../../shared/standard-parts';
import { emptyWorkspace } from '../../shared/workspace';
import {
  DEFAULT_DETAIL_MODE, DETAIL_MODE_STORAGE_KEY, loadDetailMode, saveDetailMode,
} from '../../src/fidelity/settings';
import { buildAgentRequest } from '../../src/agent/request';
import type { AgentWorkingState } from '../../server/agent-tools';
import type { DetailMode } from '../../shared/agent';
import { idCounter, withModel } from './agent-fixtures';

/**
 * design-fidelity Task 2: the rule blocks, the baseline, the two detail modes end to end (inputs, transport,
 * the agent's tool, the routes, the browser setting). No real model is called; every provider is a double.
 */

const lines = (block: string) => block.split('\n');
/** A working copy with one object and the given request mode (the fixtures do not set one). */
const stateWith = (detail?: DetailMode): AgentWorkingState => ({ ...withModel(), ...(detail ? { detail } : {}) });
const call = (tool: string, args: Record<string, unknown> = {}) => ({ tool, argsJson: JSON.stringify(args), reason: null });
const design = { status: 'ready', explanation: 'Test double', model: demoModel };
const noChange = { status: 'unsupported', explanation: 'Test double', operations: [], name: null, summary: null, assumptions: null };

/** A provider double that records every task it is given and answers with `answer`. */
function recordingProvider(answer: unknown) {
  const tasks: ModelTask<unknown>[] = [];
  const run = vi.fn(async (task: ModelTask<unknown>) => { tasks.push(task); return answer; });
  const provider = { name: 'openai', configured: true, model: 'double', run } as unknown as ModelProvider;
  return { provider, tasks };
}

describe('rule blocks', () => {
  it('puts every line of each block into each instruction that must contain it, in both languages', () => {
    for (const lang of ['zh-TW', 'en'] as const) {
      const model = lines(modelInstructions(lang));
      const edit = lines(editInstructions(lang));
      const agent = lines(agentInstructions(lang));
      for (const line of [...lines(PRIMITIVE_RULES), ...lines(PART_RULES)]) {
        expect(model).toContain(line);
        expect(edit).toContain(line);
        expect(agent).toContain(line);
      }
      for (const line of lines(FIDELITY_RULES)) {
        expect(model).toContain(line);
        expect(edit).toContain(line);
        expect(agent).not.toContain(line);
      }
    }
  });

  it('exports the geometry rules the edit and agent texts copy: the four lines they always had', () => {
    expect(lines(GEOMETRY_RULES)).toHaveLength(4);
    expect(GEOMETRY_RULES).toBe([PRIMITIVE_RULES, PART_RULES].join('\n'));
    expect(EDIT_INSTRUCTIONS).toContain(GEOMETRY_RULES);
    expect(AGENT_INSTRUCTIONS).toContain(GEOMETRY_RULES);
  });

  it('keeps the language sentence out of the blocks, so english-ui can change it alone', () => {
    for (const block of [PRIMITIVE_RULES, PART_RULES, FIDELITY_RULES]) {
      expect(block).not.toContain('Traditional Chinese');
      expect(hasCjk(block)).toBe(false);
    }
    expect(modelInstructions('en').replace(modelInstructions('en').split('\n')[1]!, modelInstructions('zh-TW').split('\n')[1]!))
      .toBe(MODEL_INSTRUCTIONS);
  });

  it('keeps the edit text\'s check that it carries the schema version line', () => {
    expect(EDIT_INSTRUCTIONS).toContain(lines(MODEL_INSTRUCTIONS).find(line => line.startsWith('Model schema version'))!);
  });

  it('names the two modes, the part cap and the typical component sizes in the fidelity rules', () => {
    expect(DETAILED_PART_CAP).toBe(20);
    expect(FIDELITY_RULES).toContain(`"${DETAIL_MODE_LINE}"`);
    expect(FIDELITY_RULES).toContain('Without that line, use concept mode.');
    expect(FIDELITY_RULES).toContain('use at most 20 parts in total');
    expect(FIDELITY_RULES).toContain('exactly one assumption line');
    expect(FIDELITY_RULES).toContain('do not state the overall size of the object');
    for (const line of referenceLines()) expect(lines(FIDELITY_RULES)).toContain(line);
    expect(GENERATOR_VERSION).toBe('controlled-primitives/1.1.0');
  });
});

describe('baseline instructions (R24)', () => {
  it('is frozen from the text after Task 1: it names shell, and no internals, mode or table', () => {
    expect(BASELINE_MODEL_INSTRUCTIONS).toContain('shell (closed hollow box)');
    expect(BASELINE_MODEL_INSTRUCTIONS).not.toContain('DETAIL_MODE');
    expect(BASELINE_MODEL_INSTRUCTIONS).not.toContain('Typical component sizes');
    expect(BASELINE_MODEL_INSTRUCTIONS).not.toContain('Interior parts:');
    expect(BASELINE_MODEL_INSTRUCTIONS.length).toBe(3478);
  });

  it('survives line by line in the new instructions, except the one sentence R17 changes', () => {
    const now = new Set(lines(MODEL_INSTRUCTIONS));
    const missing = lines(BASELINE_MODEL_INSTRUCTIONS).filter(line => !now.has(line));
    // R17: sizes are no longer listed in the assumptions; the application computes them.
    expect(missing).toEqual([
      'If dimensions are not specified, use sensible provisional dimensions and list them in assumptions. Separate user-specified facts from guesses. If internal layout is unconfirmed, explicitly state it is conceptual. Do not claim measured dimensions, precise CAD, manufacturability, table anchoring, or tested mechanics.',
    ]);
    expect(MODEL_INSTRUCTIONS).toContain('If dimensions are not specified, use sensible provisional dimensions. Separate user-specified facts from guesses.');
  });

  it('keeps the order of today\'s lines', () => {
    const now = lines(MODEL_INSTRUCTIONS);
    const kept = lines(BASELINE_MODEL_INSTRUCTIONS).filter(line => now.includes(line));
    const positions = kept.map(line => now.indexOf(line));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('task inputs (R21)', () => {
  it('leaves concept mode byte-identical to today', () => {
    expect(designTask('a table', 'zh-TW').input).toBe('a table');
    expect(designTask('a table', 'zh-TW', {}).input).toBe('a table');
    expect(designTask('a table', 'zh-TW', { detail: 'concept' }).input).toBe('a table');
    expect(labelledInput(designTask('a table', 'zh-TW'))).toBe('User object description:\na table');
    expect(labelledInput(designTask('a table', 'zh-TW', { detail: 'concept' }))).toBe('User object description:\na table');
    const concept = editTask(demoModel, 'bigger', ['battery'], 'zh-TW');
    expect(concept.input).toBe(`CURRENT_MODEL:\n${JSON.stringify(demoModel)}\n\nSELECTED_PART_IDS: ["battery"]\n\nEDIT_REQUEST:\nbigger`);
    expect(editTask(demoModel, 'bigger', ['battery'], 'zh-TW', { detail: 'concept' }).input).toBe(concept.input);
    expect(labelledInput(concept)).toBe(concept.input);
  });

  it('starts the input with the mode line in detailed mode and labels only the description', () => {
    const task = designTask('a table', 'en', { detail: 'detailed' });
    expect(task.input).toBe('DETAIL_MODE: detailed\n\na table');
    expect(labelledInput(task)).toBe('DETAIL_MODE: detailed\n\nUser object description:\na table');
    const edit = editTask(demoModel, 'add internals', [], 'en', { detail: 'detailed' });
    expect(edit.input.startsWith('DETAIL_MODE: detailed\n\nCURRENT_MODEL:\n')).toBe(true);
    expect(labelledInput(edit)).toBe(edit.input);
  });

  it('uses the same instructions in both modes: the mode travels in the input', () => {
    expect(designTask('x', 'zh-TW', { detail: 'detailed' }).instructions).toBe(MODEL_INSTRUCTIONS);
    expect(editTask(demoModel, 'x', [], 'en', { detail: 'detailed' }).instructions).toBe(editInstructions('en'));
  });
});

describe('request transport (R20)', () => {
  const body = { instruction: 'x', requestId: 'r1', workspace: emptyWorkspace(), tryOn: false, cameraOn: false, history: [] };

  it('defaults a request without detail to concept and keeps an explicit one', () => {
    expect(validateAgentRequest(body).detail).toBe('concept');
    expect(validateAgentRequest({ ...body, detail: 'detailed' }).detail).toBe('detailed');
    expect(validateAgentRequest({ ...body, detail: 'concept' }).detail).toBe('concept');
  });

  it('rejects another value, in the agent request and in the edit request', () => {
    expect(AgentRequestSchema.safeParse({ ...body, detail: 'huge' }).success).toBe(false);
    expect(AgentRequestSchema.safeParse({ ...body, detail: null }).success).toBe(false);
    const edit = { instruction: 'x', requestId: 'r1', model: demoModel, selectedPartIds: [] };
    expect(EditRequestSchema.safeParse(edit).success).toBe(true);
    expect(EditRequestSchema.safeParse({ ...edit, detail: 'detailed' }).success).toBe(true);
    expect(EditRequestSchema.safeParse({ ...edit, detail: 'huge' }).success).toBe(false);
  });

  it('sends detail from the browser request builder only when the snapshot has one', () => {
    const snapshot = { workspace: emptyWorkspace(), tryOn: false, cameraOn: false };
    expect(buildAgentRequest('x', snapshot, [], 'r')).not.toHaveProperty('detail');
    expect(buildAgentRequest('x', { ...snapshot, detail: 'detailed' }, [], 'r')).toMatchObject({ detail: 'detailed' });
    expect(validateAgentRequest(buildAgentRequest('x', { ...snapshot, detail: 'detailed' }, [], 'r')).detail).toBe('detailed');
  });
});

describe('generate_design and edit_design', () => {
  const run = async (state: AgentWorkingState, args: Record<string, unknown>) => {
    const { provider, tasks } = recordingProvider(design);
    const result = await runTool(call('generate_design', args), state, provider, new AbortController().signal, { newObjectId: idCounter() });
    return { result, task: tasks[0]! };
  };

  it('uses the request\'s mode when detail is null or absent', async () => {
    expect((await run(stateWith('detailed'), { prompt: 'a lamp' })).task.input).toBe('DETAIL_MODE: detailed\n\na lamp');
    expect((await run(stateWith('detailed'), { prompt: 'a lamp', detail: null })).task.input).toBe('DETAIL_MODE: detailed\n\na lamp');
    expect((await run(stateWith('concept'), { prompt: 'a lamp', detail: null })).task.input).toBe('a lamp');
    expect((await run(stateWith(), { prompt: 'a lamp' })).task.input).toBe('a lamp');
  });

  it('lets the agent override the mode for one call', async () => {
    expect((await run(stateWith('concept'), { prompt: 'a lamp', detail: 'detailed' })).task.input).toBe('DETAIL_MODE: detailed\n\na lamp');
    expect((await run(stateWith('detailed'), { prompt: 'a lamp', detail: 'concept' })).task.input).toBe('a lamp');
  });

  it('refuses a detail value that is not a mode, without a model call', async () => {
    const { provider, tasks } = recordingProvider(design);
    const refused = await runTool(call('generate_design', { prompt: 'a lamp', detail: 'huge' }), stateWith(), provider, new AbortController().signal);
    expect(refused.ok).toBe(false);
    expect(refused.detail).toMatchObject({ code: 'INVALID_ARGS' });
    expect(tasks).toHaveLength(0);
  });

  it('edit_design takes the mode from the request', async () => {
    for (const [detail, prefix] of [['detailed', 'DETAIL_MODE: detailed\n\n'], ['concept', ''], [undefined, '']] as const) {
      const { provider, tasks } = recordingProvider(noChange);
      await runTool(call('edit_design', { instruction: 'add internals' }), stateWith(detail), provider, new AbortController().signal);
      expect(tasks[0]!.input.startsWith(`${prefix}CURRENT_MODEL:\n`)).toBe(true);
    }
  });
});

describe('the agent loop', () => {
  const req = (over: Partial<AgentRequest> = {}): AgentRequest => ({
    requestId: 'r', workspace: emptyWorkspace(), tryOn: false, cameraOn: false, history: [], instruction: 'hi', ...over,
  });
  const inputOf = async (request: AgentRequest) => {
    const { provider, tasks } = recordingProvider({ type: 'final', note: null, calls: null, reply: 'ok' });
    await runAgent(provider, request, { maxRounds: 2, totalTimeoutMs: 60_000 }, () => undefined, new AbortController().signal);
    return tasks[0]!.input;
  };

  it('shows the setting of the detail switch in the state, with or without objects', async () => {
    expect(await inputOf(req())).toContain('Detail mode setting: concept.');
    expect(await inputOf(req({ detail: 'detailed' }))).toContain('Detail mode setting: detailed.');
    expect(await inputOf(req({ detail: 'detailed' }))).toContain('目前狀態：工作區沒有物件。');
  });

  it('tells the agent when it may ask about internals and when to use detailed mode', () => {
    for (const lang of ['zh-TW', 'en'] as const) {
      const text = agentInstructions(lang);
      expect(text).toContain('you may ask once in your final reply whether to add typical internals');
      expect(text).toContain('call generate_design with detail "detailed"');
      expect(text).toContain('Never ask again after the user has answered.');
      expect(text).toContain('Do not make up sizes for them');
      expect(text).toContain('detail is "concept" or "detailed"');
    }
  });
});

describe('/api/generate and /api/edit', () => {
  const edit = (extra: Record<string, unknown> = {}) => ({ instruction: 'bigger', requestId: 'r-edit', model: demoModel, selectedPartIds: [], ...extra });

  it('keeps provider.generate for a request without detail', async () => {
    const generate = vi.fn(async () => design as never);
    const run = vi.fn(async () => design as never);
    const provider = { name: 'openai', configured: true, model: 'double', generate, run } as unknown as ModelProvider;
    const response = await request(createApp({ provider })).post('/api/generate').send({ prompt: 'a table', requestId: 'g1' });
    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('sends the detail mode through provider.run as a design task', async () => {
    const { provider, tasks } = recordingProvider(design);
    const app = createApp({ provider });
    expect((await request(app).post('/api/generate').send({ prompt: 'a table', requestId: 'g2', detail: 'detailed' })).status).toBe(200);
    expect((await request(app).post('/api/generate').send({ prompt: 'a table', requestId: 'g3', detail: 'concept' })).status).toBe(200);
    expect(tasks.map(task => [task.kind, task.input])).toEqual([['design', 'DETAIL_MODE: detailed\n\na table'], ['design', 'a table']]);
    expect(tasks.every(task => task.instructions === MODEL_INSTRUCTIONS)).toBe(true);
  });

  it('falls back to generate for a provider without run, also with detail', async () => {
    const generate = vi.fn(async () => design as never);
    const provider = { name: 'openai', configured: true, model: 'double', generate } as unknown as ModelProvider;
    const response = await request(createApp({ provider })).post('/api/generate').send({ prompt: 'a table', requestId: 'g4', detail: 'detailed' });
    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown detail value with the usual 400', async () => {
    const { provider, tasks } = recordingProvider(design);
    const response = await request(createApp({ provider })).post('/api/generate').send({ prompt: 'a table', requestId: 'g5', detail: 'huge' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(tasks).toHaveLength(0);
  });

  it('puts the mode line first in an edit input when asked, and nothing without it', async () => {
    const { provider, tasks } = recordingProvider(noChange);
    const app = createApp({ provider });
    expect((await request(app).post('/api/edit').send(edit())).status).toBe(200);
    expect((await request(app).post('/api/edit').send(edit({ detail: 'detailed', requestId: 'r-edit2' }))).status).toBe(200);
    expect(tasks[0]!.input.startsWith('CURRENT_MODEL:\n')).toBe(true);
    expect(tasks[1]!.input.startsWith('DETAIL_MODE: detailed\n\nCURRENT_MODEL:\n')).toBe(true);
    expect((await request(app).post('/api/edit').send(edit({ detail: 'huge', requestId: 'r-edit3' }))).status).toBe(400);
  });
});

describe('the browser setting (R23)', () => {
  const storage = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
  };

  it('reads concept when nothing valid is stored', () => {
    expect(DEFAULT_DETAIL_MODE).toBe('concept');
    expect(loadDetailMode(null)).toBe('concept');
    expect(loadDetailMode(undefined)).toBe('concept');
    expect(loadDetailMode(storage())).toBe('concept');
    expect(loadDetailMode(storage({ [DETAIL_MODE_STORAGE_KEY]: 'huge' }))).toBe('concept');
    expect(loadDetailMode({ getItem: () => { throw new Error('blocked'); } })).toBe('concept');
  });

  it('stores under forgehand.detailMode and reads it back', () => {
    expect(DETAIL_MODE_STORAGE_KEY).toBe('forgehand.detailMode');
    const store = storage();
    saveDetailMode(store, 'detailed');
    expect(store.data).toEqual({ 'forgehand.detailMode': 'detailed' });
    expect(loadDetailMode(store)).toBe('detailed');
    saveDetailMode(store, 'concept');
    expect(loadDetailMode(store)).toBe('concept');
  });

  it('ignores a blocked storage and never stores an invalid value', () => {
    expect(() => saveDetailMode({ setItem: () => { throw new Error('full'); } }, 'detailed')).not.toThrow();
    expect(() => saveDetailMode(null, 'detailed')).not.toThrow();
    const store = storage();
    saveDetailMode(store, 'huge' as never);
    expect(store.data).toEqual({});
  });
});
