import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import {
  AgentRequestError, AgentRequestSchema, AgentStepSchema, EditDesignDetailSchema, ExplodeViewDetailSchema,
  GenerateDesignDetailSchema, GetProjectStateDetailSchema, ObjectToolDetailSchema,
  SelectPartsDetailSchema, StateChangeSchema, ToolEventSchema, ToolResultSchema, UNKNOWN_TOOL_LABEL,
  agentJsonSchema, serializeSseEvent, validateAgentRequest, validateAgentStep,
} from '../../shared/agent';
import { emptyWorkspace } from '../../shared/workspace';
import { sceneObject, workspaceOf } from './agent-fixtures';

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

  describe('StateChangeSchema', () => {
    const none = { activeObjectId: null, object: null, selection: null, explode: null, tryOn: null };
    const transform = { position: { x: 0.5, y: 0, z: 0 }, rotation: { x: 0, y: 90, z: 0 } };
    const objectChanges = [
      ['add', { op: 'add', object: sceneObject('obj-1') }],
      ['model', { op: 'model', objectId: 'obj-1', model: demoModel, source: 'claude', providerModel: 'm' }],
      ['transform', { op: 'transform', objectId: 'obj-1', transform }],
      ['remove', { op: 'remove', objectId: 'obj-1' }],
    ] as const;

    it.each(objectChanges)('round-trips an object change with op %s', (_op, object) => {
      const change = { ...none, object };
      expect(StateChangeSchema.parse(JSON.parse(JSON.stringify(change)))).toEqual(change);
    });
    it('round-trips an activation, a selection, an explode amount and tryOn', () => {
      const change = { activeObjectId: 'obj-2', object: null, selection: { objectId: 'obj-2', partIds: ['housing'] }, explode: 0.5, tryOn: true };
      expect(StateChangeSchema.parse(change)).toEqual(change);
    });
    it.each([
      ['a missing tryOn', { activeObjectId: null, object: null, selection: null, explode: null }],
      ['an unknown key', { ...none, extra: true }],
      ['the removed model field', { ...none, model: { kind: 'generated', model: demoModel, source: 'x', providerModel: 'y' } }],
      ['an add with a bad model', { ...none, object: { op: 'add', object: { ...sceneObject('obj-1'), model: { bad: true } } } }],
      ['an out-of-range explode', { ...none, explode: 1.5 }],
    ])('rejects %s', (_name, value) => {
      expect(() => StateChangeSchema.parse(value)).toThrow();
    });
    it('is used by ToolResultSchema for stateChange', () => {
      const result = { tool: 'explode_view', ok: true, summary: 'x', detail: null, stateChange: { ...none, explode: 1 } };
      expect(ToolResultSchema.parse(result).stateChange?.explode).toBe(1);
      expect(() => ToolResultSchema.parse({ ...result, stateChange: { explode: 1 } })).toThrow();
    });
  });

  describe('ToolEventSchema', () => {
    it('requires a label of 1 to 40 characters', () => {
      expect(ToolEventSchema.parse({ tool: 'explode_view', label: '爆炸圖', argsJson: '{}' }).label).toBe('爆炸圖');
      expect(() => ToolEventSchema.parse({ tool: 'explode_view', argsJson: '{}' })).toThrow();
      expect(() => ToolEventSchema.parse({ tool: 'explode_view', label: '', argsJson: '{}' })).toThrow();
      expect(() => ToolEventSchema.parse({ tool: 'explode_view', label: 'x'.repeat(41), argsJson: '{}' })).toThrow();
    });
    it('uses 其他步驟 for an unknown tool', () => {
      expect(UNKNOWN_TOOL_LABEL).toBe('其他步驟');
    });
  });

  describe('detail schemas', () => {
    const position = { x: 1, y: 0, z: 0 };
    const rotation = { x: 0, y: 0, z: 0 };
    it('describe the workspace: objects, active id and the target object', () => {
      const detail = {
        objects: [{ id: 'obj-1', name: '殼', partCount: 2, position, rotation, active: true, material: null }],
        joints: [],
        activeObjectId: 'obj-1',
        target: { objectId: 'obj-1', parts: [], selection: [], explode: 0 },
        tryOn: false,
      };
      expect(GetProjectStateDetailSchema.parse(detail)).toEqual(detail);
      expect(GetProjectStateDetailSchema.parse({ objects: [], joints: [], activeObjectId: null, target: null, tryOn: false }).target).toBeNull();
    });
    it('carry the object id on every writing tool', () => {
      expect(GenerateDesignDetailSchema.parse({ source: 's', providerModel: 'm', status: 'ready', objectId: 'obj-1' }).objectId).toBe('obj-1');
      expect(GenerateDesignDetailSchema.parse({ source: 's', providerModel: 'm', status: 'unsupported', objectId: null }).objectId).toBeNull();
      expect(() => GenerateDesignDetailSchema.parse({ source: 's', providerModel: 'm', status: 'ready' })).toThrow();
      expect(EditDesignDetailSchema.parse({ objectId: 'obj-1', changes: { added: [], updated: ['a'], removed: [] }, explanation: 'x' }).objectId).toBe('obj-1');
      expect(SelectPartsDetailSchema.parse({ objectId: 'obj-1', selection: ['a'] }).selection).toEqual(['a']);
      expect(ExplodeViewDetailSchema.parse({ objectId: 'obj-1', amount: 0.5 }).amount).toBe(0.5);
      expect(ObjectToolDetailSchema.parse({ objectId: 'obj-1', activeObjectId: null, transform: { position, rotation } }).transform).toEqual({ position, rotation });
      expect(ObjectToolDetailSchema.parse({ objectId: 'obj-1', activeObjectId: 'obj-2', transform: null }).transform).toBeNull();
    });
  });

  describe('validateAgentRequest', () => {
    const base = { instruction: '產生一張桌子', requestId: 'req-1', tryOn: false, cameraOn: false, history: [] };
    const twoObjects = () => workspaceOf(sceneObject('obj-1'), sceneObject('obj-2', demoModel, 1));
    const rejection = (input: unknown) => {
      try { validateAgentRequest(input); } catch (error) { return error; }
      throw new Error('should have thrown');
    };

    it('accepts an empty workspace', () => {
      const req = validateAgentRequest({ ...base, workspace: emptyWorkspace() });
      expect(req.workspace).toEqual(emptyWorkspace());
    });
    it('accepts a workspace with objects, selection and explode, and returns a validated copy', () => {
      const workspace = { ...twoObjects(), selection: { objectId: 'obj-1', partIds: ['housing'] }, display: { explode: 0.25 } };
      const req = validateAgentRequest(JSON.parse(JSON.stringify({ ...base, workspace })));
      expect(req.workspace).toEqual(workspace);
      expect(req.requestId).toBe('req-1');
      expect(req.history).toEqual([]);
    });
    it.each([
      ['not a workspace', { bad: true }],
      ['null', null],
      ['an unknown model part selection', { ...twoObjects(), selection: { objectId: 'obj-1', partIds: ['missing'] } }],
      ['an active object that does not exist', { ...twoObjects(), activeObjectId: 'obj-9' }],
      ['a duplicate object id', { ...twoObjects(), objects: [sceneObject('obj-1'), sceneObject('obj-1')] }],
      ['an invalid model inside an object', { ...twoObjects(), objects: [{ ...sceneObject('obj-1'), model: { bad: true } }] }],
    ])('rejects %s as INVALID_WORKSPACE with a fixed message', (_name, workspace) => {
      const error = rejection({ ...base, workspace });
      expect(error).toBeInstanceOf(AgentRequestError);
      expect((error as AgentRequestError).code).toBe('INVALID_WORKSPACE');
      expect((error as AgentRequestError).message).toBe('目前工作區資料無效，無法處理這次請求。');
      expect((error as AgentRequestError).message).not.toContain('obj-');
    });
    it('rejects a structurally invalid request via Zod (not AgentRequestError)', () => {
      const error = rejection({ ...base, workspace: emptyWorkspace(), requestId: 'bad id with space' });
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AgentRequestError);
    });
    it('rejects a missing workspace key as a structural error, not INVALID_WORKSPACE', () => {
      const error = rejection(base);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AgentRequestError);
    });
    it('rejects an explicit undefined workspace as a structural error', () => {
      const error = rejection({ ...base, workspace: undefined });
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AgentRequestError);
    });
    it('rejects the old single-model fields', () => {
      const error = rejection({ ...base, workspace: emptyWorkspace(), model: null, selectedPartIds: [], explode: 0 });
      expect(error).not.toBeInstanceOf(AgentRequestError);
    });
  });

  describe('AgentRequestSchema', () => {
    it('requires the workspace key and has no model, selectedPartIds or explode fields', () => {
      const base = { instruction: 'x', requestId: 'r', tryOn: false, cameraOn: false, history: [] };
      expect(() => AgentRequestSchema.parse({ ...base, workspace: emptyWorkspace() })).not.toThrow();
      expect(() => AgentRequestSchema.parse(base)).toThrow();
      expect(Object.keys(AgentRequestSchema.shape)).toEqual(['instruction', 'requestId', 'workspace', 'tryOn', 'cameraOn', 'history', 'printer', 'detail']);
    });
  });

  describe('serializeSseEvent', () => {
    it('produces the exact frame format for a given name and data', () => {
      expect(serializeSseEvent('status', { note: '產生中' })).toBe('event: status\ndata: {"note":"產生中"}\n\n');
      expect(serializeSseEvent('done', {})).toBe('event: done\ndata: {}\n\n');
    });
  });
});
