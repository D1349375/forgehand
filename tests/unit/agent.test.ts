import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import {
  AgentRequestSchema, AgentStepSchema, ModelStateChangeSchema,
  agentJsonSchema, serializeSseEvent, validateAgentRequest, validateAgentStep,
  AgentRequestError,
} from '../../shared/agent';

const call = (tool: string, args: Record<string, unknown> = {}) => ({ tool, argsJson: JSON.stringify(args), reason: null });
const calls = (tool: string, args: Record<string, unknown> = {}) => [call(tool, args)];
const step = (c: ReturnType<typeof calls>, note: string | null = null) =>
  ({ type: 'tool_calls' as const, note, calls: c, reply: null });
const final = (reply: string) => ({ type: 'final' as const, note: null, reply, calls: null });
const thrown = (fn: () => unknown): unknown => { try { fn(); } catch (cause) { return cause; } return undefined; };

describe('agent contract', () => {
  describe('validateAgentStep', () => {
    it('accepts a valid tool_calls step and a valid final step', () => {
      const toolCalls = validateAgentStep(step(calls('generate_design', { prompt: '一張紅桌子' }), '產生中'));
      if (toolCalls.type !== 'tool_calls') throw new Error('expected tool_calls');
      expect(toolCalls.calls).toHaveLength(1);
      expect(toolCalls.calls[0]).toEqual({ tool: 'generate_design', argsJson: '{"prompt":"一張紅桌子"}', reason: null });
      expect(toolCalls.reply).toBeNull();

      const done = validateAgentStep(final('完成'));
      if (done.type !== 'final') throw new Error('expected final');
      expect(done.reply).toBe('完成');
      expect(done.calls).toBeNull();
      expect(done.note).toBeNull();
    });

    it.each([
      ['tool_calls with null calls', { type: 'tool_calls', note: null, calls: null, reply: null }],
      ['tool_calls with empty calls', { type: 'tool_calls', note: null, calls: [], reply: null }],
      ['tool_calls with a reply', { type: 'tool_calls', note: null, calls: calls('get_project_state', {}), reply: 'nope' }],
      ['final with calls', { type: 'final', note: null, reply: 'done', calls: calls('get_project_state', {}) }],
      ['final with null reply', { type: 'final', note: null, reply: null, calls: null }],
    ])('rejects %s', (_name, value) => {
      expect(() => validateAgentStep(value)).toThrow();
    });
    it('drops a stray note on a final step instead of rejecting', () => {
      const done = validateAgentStep({ type: 'final', note: '多餘註記', reply: '完成', calls: null });
      if (done.type !== 'final') throw new Error('expected final');
      expect(done.note).toBeNull();
      expect(done.reply).toBe('完成');
    });
  });

  describe('tool calls in a step', () => {
    it('does not check tool names or argument contents (the tool registry does, at dispatch)', () => {
      const parsed = validateAgentStep(step([call('not_a_tool'), { tool: 'explode_view', argsJson: 'not json', reason: null }]));
      if (parsed.type !== 'tool_calls') throw new Error('expected tool_calls');
      expect(parsed.calls.map(entry => entry.tool)).toEqual(['not_a_tool', 'explode_view']);
    });
    it.each([
      ['an empty tool name', { tool: '  ', argsJson: '{}', reason: null }],
      ['a tool name over 64 characters', { tool: 'x'.repeat(65), argsJson: '{}', reason: null }],
      ['argsJson over 8000 characters', { tool: 'generate_design', argsJson: 'x'.repeat(8001), reason: null }],
      ['a missing argsJson', { tool: 'get_project_state', reason: null }],
      ['the removed flat args object', { tool: 'get_project_state', argsJson: '{}', args: {}, reason: null }],
    ])('rejects %s', (_name, badCall) => {
      expect(() => validateAgentStep({ type: 'tool_calls', note: null, calls: [badCall], reply: null })).toThrow();
    });
  });

  describe('agentJsonSchema', () => {
    const schema = agentJsonSchema();
    it('is a single top-level object with no anyOf/oneOf at the root, $schema stripped, all properties required', () => {
      expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(schema).not.toHaveProperty('$schema');
      expect(schema).not.toHaveProperty('anyOf');
      expect(schema).not.toHaveProperty('oneOf');
      expect((schema as { required?: string[] }).required).toEqual(
        expect.arrayContaining(['type', 'note', 'reply', 'calls']),
      );
    });
    it('nullable fields render as nested anyOf (expected, like editJsonSchema), not at the root', () => {
      const properties = (schema as { properties: Record<string, { anyOf?: unknown[] }> }).properties;
      // A nullable string field -> anyOf [string, null]
      expect(properties.note).toHaveProperty('anyOf');
      // A nullable array field -> anyOf [array, null]
      expect(properties.calls).toHaveProperty('anyOf');
    });
    it('describes a call as plain strings: tool is not an enum and argsJson is not a nested object', () => {
      type Node = { type?: string; enum?: unknown; properties?: unknown; items?: { properties: Record<string, Node>; required: string[] } };
      const properties = (schema as { properties: Record<string, { anyOf: Node[] }> }).properties;
      const callItem = properties.calls!.anyOf.find(branch => branch.type === 'array')!.items!;
      expect(callItem.required).toEqual(expect.arrayContaining(['tool', 'argsJson', 'reason']));
      expect(callItem.properties.tool).toMatchObject({ type: 'string' });
      expect(callItem.properties.tool).not.toHaveProperty('enum');
      expect(callItem.properties.argsJson).toMatchObject({ type: 'string' });
      expect(callItem.properties.argsJson).not.toHaveProperty('properties');
    });
    it('does not grow with the tool set: no per-tool names appear in the schema', () => {
      const text = JSON.stringify(schema);
      for (const name of ['generate_design', 'edit_design', 'select_parts', 'explode_view', 'wear_on_arm']) {
        expect(text).not.toContain(name);
      }
    });
  });

  describe('AgentStepSchema direct parse', () => {
    it('accepts a step whose calls carry { tool, argsJson, reason }', () => {
      expect(() => AgentStepSchema.parse(step(calls('get_project_state', {}), '查看狀態'))).not.toThrow();
    });
  });

  describe('ModelStateChangeSchema', () => {
    it('round-trips a generated and an edited change', () => {
      const generated = ModelStateChangeSchema.parse({ kind: 'generated', model: demoModel, source: 'openai', providerModel: 'gpt-x' });
      expect(generated.kind).toBe('generated');
      const edited = ModelStateChangeSchema.parse({ kind: 'edited', model: demoModel, source: 'claude', providerModel: 'm' });
      expect(edited.kind).toBe('edited');
    });
    it('rejects a model that fails ModelSpecSchema', () => {
      expect(() => ModelStateChangeSchema.parse({ kind: 'generated', model: { bad: true }, source: 'x', providerModel: 'y' })).toThrow();
    });
  });

  describe('validateAgentRequest', () => {
    const base = { instruction: '產生一張桌子', requestId: 'req-1', explode: 0, tryOn: false, cameraOn: false, history: [] };
    it('accepts model: null with empty selection', () => {
      const req = validateAgentRequest({ ...base, model: null, selectedPartIds: [] });
      expect(req.model).toBeNull();
    });
    it('rejects model: null with a non-empty selection (INVALID_SELECTION)', () => {
      expect(() => validateAgentRequest({ ...base, model: null, selectedPartIds: ['housing'] })).toThrowError(AgentRequestError);
      try {
        validateAgentRequest({ ...base, model: null, selectedPartIds: ['housing'] });
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRequestError);
        expect((error as AgentRequestError).code).toBe('INVALID_SELECTION');
      }
    });
    it('rejects an invalid non-null model (INVALID_MODEL) with a fixed sanitized message', () => {
      try {
        validateAgentRequest({ ...base, model: { bad: true }, selectedPartIds: [] });
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRequestError);
        expect((error as AgentRequestError).code).toBe('INVALID_MODEL');
        expect((error as AgentRequestError).message).toBe('目前模型資料無效，無法處理這次請求。');
      }
    });
    it('rejects a selection referencing a missing part (INVALID_SELECTION)', () => {
      try {
        validateAgentRequest({ ...base, model: structuredClone(demoModel), selectedPartIds: ['missing'] });
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRequestError);
        expect((error as AgentRequestError).code).toBe('INVALID_SELECTION');
      }
    });
    it('accepts a valid model with a valid selection', () => {
      const req = validateAgentRequest({ ...base, model: structuredClone(demoModel), selectedPartIds: ['housing'] });
      expect(req.model?.parts.length).toBe(demoModel.parts.length);
    });
    it('rejects a structurally invalid request via Zod (not AgentRequestError)', () => {
      expect(() => validateAgentRequest({ ...base, model: null, selectedPartIds: [], requestId: 'bad id with space' })).toThrow();
    });
    it('rejects a missing model key as a structural error, not INVALID_MODEL', () => {
      const cause = thrown(() => validateAgentRequest({ ...base, selectedPartIds: [] }));
      expect(cause).toBeInstanceOf(Error);
      expect(cause).not.toBeInstanceOf(AgentRequestError);
    });
    it('rejects an explicit undefined model as a structural error (only null means no model)', () => {
      const cause = thrown(() => validateAgentRequest({ ...base, model: undefined, selectedPartIds: [] }));
      expect(cause).toBeInstanceOf(Error);
      expect(cause).not.toBeInstanceOf(AgentRequestError);
    });
  });

  describe('AgentRequestSchema', () => {
    it('accepts model: null', () => {
      expect(() => AgentRequestSchema.parse({ ...{ instruction: 'x', requestId: 'r', selectedPartIds: [], explode: 0, tryOn: false, cameraOn: false, history: [] }, model: null })).not.toThrow();
    });
  });

  describe('serializeSseEvent', () => {
    it('produces the exact frame format for a given name and data', () => {
      expect(serializeSseEvent('status', { note: '產生中' })).toBe('event: status\ndata: {"note":"產生中"}\n\n');
      expect(serializeSseEvent('done', {})).toBe('event: done\ndata: {}\n\n');
    });
  });
});
