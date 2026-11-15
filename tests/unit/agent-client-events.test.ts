import { describe, expect, it } from 'vitest';
import { serializeSseEvent } from '../../shared/agent';
import { parseAgentEvent } from '../../src/agent/events';
import { parseSseStream } from '../../src/agent/sse';
import { buildAgentRequest, errorMessageFromBody, HISTORY_TURN_LIMIT, type RunSnapshot } from '../../src/agent/request';
import { demoModel } from '../../shared/demo';
import { LegacyAgentRequestSchema } from '../../shared/agent';

const frame = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) });
const resultPayload = { tool: 'select_parts', ok: true, summary: '已選取 1 個零件。', detail: { selection: ['housing'] }, stateChange: null };

describe('parseAgentEvent', () => {
  it('parses every event the server sends', () => {
    expect(parseAgentEvent(frame('status', { note: '處理中' }))).toEqual({ type: 'status', note: '處理中' });
    expect(parseAgentEvent(frame('status', { note: null }))).toEqual({ type: 'status', note: null });
    expect(parseAgentEvent(frame('result', resultPayload))).toEqual({ type: 'result', result: resultPayload });
    expect(parseAgentEvent(frame('final', { reply: '完成。' }))).toEqual({ type: 'final', reply: '完成。' });
    expect(parseAgentEvent(frame('error', { message: '逾時' }))).toEqual({ type: 'error', message: '逾時' });
    expect(parseAgentEvent(frame('done', {}))).toEqual({ type: 'done' });
    const state = { model: null, selection: ['housing'], explode: null, tryOn: null };
    expect(parseAgentEvent(frame('state', state))).toEqual({ type: 'state', payload: state });
  });

  it('keeps only the tool name from a tool event and drops argsJson', () => {
    const parsed = parseAgentEvent(frame('tool', { tool: 'generate_design', argsJson: '{"prompt":"秘密描述"}' }));
    expect(parsed).toEqual({ type: 'tool', tool: 'generate_design' });
    expect(JSON.stringify(parsed)).not.toContain('秘密');
  });

  it.each([
    ['an unknown event name', frame('mystery', {})],
    ['unreadable JSON', { event: 'status', data: '{oops' }],
    ['a status payload with a wrong type', frame('status', { note: 5 })],
    ['a tool payload without argsJson', frame('tool', { tool: 'x' })],
    ['a result payload that fails the schema', frame('result', { tool: 'x' })],
    ['a final payload with an empty reply', frame('final', { reply: '' })],
    ['an error payload with extra fields', frame('error', { message: 'x', body: 'provider text' })],
  ])('returns null for %s', (_label, input) => {
    expect(parseAgentEvent(input)).toBeNull();
  });

  it('parses real server frames end to end', () => {
    const wire = serializeSseEvent('tool', { tool: 'wear_on_arm', argsJson: '{"enabled":true}' }) + serializeSseEvent('done', {});
    const { frames } = parseSseStream(wire, '');
    expect(frames.map(parseAgentEvent)).toEqual([{ type: 'tool', tool: 'wear_on_arm' }, { type: 'done' }]);
  });
});

describe('buildAgentRequest', () => {
  const display = { model: structuredClone(demoModel), source: 'codex', providerModel: 'm', requestId: 'r', startedAt: 1, lineage: 'l', edited: false };
  const snapshot = (over: Partial<RunSnapshot> = {}): RunSnapshot =>
    ({ display, selectedPartIds: ['housing'], explode: 0.5, tryOn: true, cameraOn: true, ...over });

  it('builds a request the server schema accepts', () => {
    const request = buildAgentRequest('  把電池改成藍色  ', snapshot(), [{ instruction: '先前', reply: '好' }], 'run-1');
    expect(request).toMatchObject({ instruction: '把電池改成藍色', requestId: 'run-1', selectedPartIds: ['housing'], explode: 0.5, tryOn: true, cameraOn: true });
    expect(() => LegacyAgentRequestSchema.parse(request)).not.toThrow();
  });

  it('sends model: null for an empty scene, with no selection', () => {
    const request = buildAgentRequest('生成', snapshot({ display: null, selectedPartIds: ['housing'] }), [], 'run-1');
    expect(request.model).toBeNull();
    expect(request.selectedPartIds).toEqual([]);
    expect(() => LegacyAgentRequestSchema.parse(request)).not.toThrow();
  });

  it('keeps only selected parts that exist in the model', () => {
    expect(buildAgentRequest('x', snapshot({ selectedPartIds: ['housing', 'gone'] }), [], 'r').selectedPartIds).toEqual(['housing']);
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
