import { describe, expect, it } from 'vitest';
import { AgentRequestSchema, serializeSseEvent, validateAgentRequest } from '../../shared/agent';
import { selectParts, setExplode } from '../../shared/workspace';
import { parseAgentEvent } from '../../src/agent/events';
import { parseSseStream } from '../../src/agent/sse';
import { buildAgentRequest, errorMessageFromBody, HISTORY_TURN_LIMIT, type RunSnapshot } from '../../src/agent/request';
import { sceneObject, workspaceOf } from './agent-fixtures';

const frame = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) });
const resultPayload = { tool: 'select_parts', ok: true, summary: '已選取 1 個零件。', detail: { objectId: 'obj-1', selection: ['housing'] }, stateChange: null };
const stateChange = (over: Record<string, unknown> = {}) =>
  ({ activeObjectId: null, object: null, selection: { objectId: 'obj-1', partIds: ['housing'] }, explode: null, tryOn: null, ...over });

describe('parseAgentEvent', () => {
  it('parses every event the server sends', () => {
    expect(parseAgentEvent(frame('status', { note: '處理中' }))).toEqual({ type: 'status', note: '處理中' });
    expect(parseAgentEvent(frame('status', { note: null }))).toEqual({ type: 'status', note: null });
    expect(parseAgentEvent(frame('result', resultPayload))).toEqual({ type: 'result', result: resultPayload });
    expect(parseAgentEvent(frame('final', { reply: '完成。' }))).toEqual({ type: 'final', reply: '完成。' });
    expect(parseAgentEvent(frame('error', { message: '逾時' }))).toEqual({ type: 'error', message: '逾時' });
    expect(parseAgentEvent(frame('done', {}))).toEqual({ type: 'done' });
    const state = stateChange();
    expect(parseAgentEvent(frame('state', state))).toEqual({ type: 'state', payload: state });
  });

  it('keeps the tool name and label from a tool event and drops argsJson', () => {
    const parsed = parseAgentEvent(frame('tool', { tool: 'generate_design', label: '生成設計', argsJson: '{"prompt":"秘密描述"}' }));
    expect(parsed).toEqual({ type: 'tool', tool: 'generate_design', label: '生成設計' });
    expect(JSON.stringify(parsed)).not.toContain('秘密');
  });

  it('parses a result with a workspace state change', () => {
    const result = { ...resultPayload, stateChange: { ...stateChange(), tryOn: null } };
    expect(parseAgentEvent(frame('result', result))).toEqual({ type: 'result', result });
  });

  it.each([
    ['an unknown event name', frame('mystery', {})],
    ['unreadable JSON', { event: 'status', data: '{oops' }],
    ['a status payload with a wrong type', frame('status', { note: 5 })],
    ['a tool payload without argsJson', frame('tool', { tool: 'x', label: '其他步驟' })],
    ['a tool payload without a label (the old shape)', frame('tool', { tool: 'x', argsJson: '{}' })],
    ['a tool payload with an empty label', frame('tool', { tool: 'x', label: '', argsJson: '{}' })],
    ['a result payload that fails the schema', frame('result', { tool: 'x' })],
    ['a result with the old state change shape', frame('result', { ...resultPayload, stateChange: { model: null, selection: null, explode: null, tryOn: null } })],
    ['a final payload with an empty reply', frame('final', { reply: '' })],
    ['an error payload with extra fields', frame('error', { message: 'x', body: 'provider text' })],
  ])('returns null for %s', (_label, input) => {
    expect(parseAgentEvent(input)).toBeNull();
  });

  it('parses real server frames end to end', () => {
    const wire = serializeSseEvent('tool', { tool: 'wear_on_arm', label: '護臂試戴', argsJson: '{"enabled":true}' }) + serializeSseEvent('done', {});
    const { frames } = parseSseStream(wire, '');
    expect(frames.map(parseAgentEvent)).toEqual([{ type: 'tool', tool: 'wear_on_arm', label: '護臂試戴' }, { type: 'done' }]);
  });
});

describe('buildAgentRequest', () => {
  const workspace = () => setExplode(selectParts(workspaceOf(sceneObject('obj-1'), sceneObject('obj-2', undefined, 2)), 'obj-1', ['housing']), 0.5);
  const snapshot = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({ workspace: workspace(), tryOn: true, cameraOn: true, ...over });

  it('builds a request the server schema and validator accept', () => {
    const request = buildAgentRequest('  把電池改成藍色  ', snapshot(), [{ instruction: '先前', reply: '好' }], 'run-1');
    expect(request).toMatchObject({ instruction: '把電池改成藍色', requestId: 'run-1', tryOn: true, cameraOn: true });
    expect(() => AgentRequestSchema.parse(request)).not.toThrow();
    const validated = validateAgentRequest(JSON.parse(JSON.stringify(request)));
    expect(validated.workspace).toEqual(workspace());
    expect(validated.workspace.selection).toEqual({ objectId: 'obj-1', partIds: ['housing'] });
    expect(validated.workspace.display.explode).toBe(0.5);
    expect(validated.history).toEqual([{ instruction: '先前', reply: '好' }]);
  });

  it('sends the whole workspace as it is', () => {
    const ws = workspace();
    expect(buildAgentRequest('x', snapshot({ workspace: ws }), [], 'r').workspace).toBe(ws);
  });

  it('accepts an empty workspace', () => {
    const request = buildAgentRequest('生成', snapshot({ workspace: workspaceOf(), tryOn: false, cameraOn: false }), [], 'run-1');
    expect(request.workspace.objects).toEqual([]);
    expect(validateAgentRequest(JSON.parse(JSON.stringify(request))).workspace.activeObjectId).toBeNull();
  });

  it('has none of the old single-model fields', () => {
    const request = buildAgentRequest('x', snapshot(), [], 'r');
    expect(Object.keys(request).sort()).toEqual(['cameraOn', 'history', 'instruction', 'requestId', 'tryOn', 'workspace']);
  });

  it('sends only the latest turns', () => {
    const turns = Array.from({ length: 14 }, (_, i) => ({ instruction: `指示${i}`, reply: `回覆${i}` }));
    const history = buildAgentRequest('x', snapshot(), turns, 'r').history;
    expect(history).toHaveLength(HISTORY_TURN_LIMIT);
    expect(history[0]!.instruction).toBe('指示4');
    expect(history.at(-1)!.instruction).toBe('指示13');
  });
});

describe('errorMessageFromBody', () => {
  it('shows the server message from a 400 or 429 JSON body', () => {
    expect(errorMessageFromBody({ error: { code: 'BUSY', message: '目前已有多個生成請求，請稍後重試。' }, requestId: 'r' }, 429))
      .toBe('目前已有多個生成請求，請稍後重試。');
  });

  it('falls back to a fixed Traditional Chinese message for anything else', () => {
    expect(errorMessageFromBody(null, 500)).toBe('代理服務未完成，請重試。');
    expect(errorMessageFromBody({ error: { message: 42 } }, 400)).toBe('代理服務未完成，請重試。');
    expect(errorMessageFromBody({}, 429)).toBe('目前已有多個請求，請稍後重試。');
  });
});
