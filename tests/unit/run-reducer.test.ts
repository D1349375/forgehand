import { describe, expect, it } from 'vitest';
import type { LegacyToolResult } from '../../shared/agent';
import type { AgentEvent } from '../../src/agent/events';
import {
  agentRunReducer, initialAgentRunState, type AgentRunAction, type AgentRunState,
} from '../../src/agent/run-reducer';

const result = (over: Partial<LegacyToolResult> = {}): LegacyToolResult =>
  ({ tool: 'generate_design', ok: true, summary: '已產生「測試桌」。', detail: null, stateChange: null, ...over });
const event = (e: AgentEvent): AgentRunAction => ({ type: 'event', event: e });
const run = (actions: AgentRunAction[], from: AgentRunState = initialAgentRunState) =>
  actions.reduce(agentRunReducer, from);
const started = run([{ type: 'start' }]);

describe('agentRunReducer', () => {
  it('starts idle and moves to running on start, clearing the previous run', () => {
    expect(initialAgentRunState).toEqual({ status: 'idle', log: [], reply: null, error: null });
    expect(started).toEqual({ status: 'running', log: [], reply: null, error: null });

    const previous: AgentRunState = { status: 'error', log: [{ id: 0, kind: 'status', label: null, text: 'x', ok: null }], reply: 'r', error: 'e' };
    expect(agentRunReducer(previous, { type: 'start' })).toEqual(started);
  });

  it('logs a status note, and ignores a null note', () => {
    const state = run([event({ type: 'status', note: '先生成，再修改。' }), event({ type: 'status', note: null })], started);
    expect(state.log).toEqual([{ id: 0, kind: 'status', label: null, text: '先生成，再修改。', ok: null }]);
  });

  it('logs a tool start under its Chinese label', () => {
    const state = run([event({ type: 'tool', tool: 'explode_view' })], started);
    expect(state.log).toEqual([{ id: 0, kind: 'tool', label: '爆炸圖', text: '進行中', ok: null }]);
  });

  it('logs a result from the tool result summary, not from model text', () => {
    const state = run([event({ type: 'result', result: result({ tool: 'edit_design', summary: '已修改：電池顏色。' }) })], started);
    expect(state.log).toEqual([{ id: 0, kind: 'result', label: '修改設計', text: '已修改：電池顏色。', ok: true }]);
    const failed = run([event({ type: 'result', result: result({ ok: false, summary: '目前沒有模型，請先生成設計。', detail: { code: 'NO_MODEL', message: 'x' } }) })], started);
    expect(failed.log[0]).toMatchObject({ ok: false, text: '目前沒有模型，請先生成設計。' });
  });

  it('does not change the log for a state event (the hook applies it to the workbench)', () => {
    expect(run([event({ type: 'state', payload: { model: null, selection: ['a'], explode: null, tryOn: null } })], started)).toBe(started);
  });

  it('keeps the reply on final and finishes on done', () => {
    const afterFinal = run([event({ type: 'final', reply: '完成了。' })], started);
    expect(afterFinal).toMatchObject({ status: 'running', reply: '完成了。', error: null });
    const done = run([event({ type: 'done' })], afterFinal);
    expect(done).toMatchObject({ status: 'done', reply: '完成了。', error: null });
  });

  it('numbers log entries in order across a whole run', () => {
    const state = run([
      event({ type: 'status', note: '開始' }),
      event({ type: 'tool', tool: 'generate_design' }),
      event({ type: 'result', result: result() }),
      event({ type: 'final', reply: '好了' }),
      event({ type: 'done' }),
    ], started);
    expect(state.status).toBe('done');
    expect(state.log.map(entry => [entry.id, entry.kind])).toEqual([[0, 'status'], [1, 'tool'], [2, 'result']]);
  });

  it('error after a partial run keeps the log and ends in error; the following done does not undo it', () => {
    const state = run([
      event({ type: 'tool', tool: 'generate_design' }),
      event({ type: 'result', result: result() }),
      event({ type: 'error', message: '這次請求已逾時，請稍後重試或簡化任務。' }),
      event({ type: 'done' }),
    ], started);
    expect(state.status).toBe('error');
    expect(state.error).toBe('這次請求已逾時，請稍後重試或簡化任務。');
    expect(state.log).toHaveLength(2);
    expect(state.reply).toBeNull();
  });

  it('fail (HTTP error or lost stream) ends a running run in error and keeps the log', () => {
    const partial = run([event({ type: 'tool', tool: 'select_parts' })], started);
    const state = agentRunReducer(partial, { type: 'fail', message: '目前已有多個請求，請稍後重試。' });
    expect(state).toMatchObject({ status: 'error', error: '目前已有多個請求，請稍後重試。' });
    expect(state.log).toHaveLength(1);
  });

  it('cancel ends a running run as cancelled, keeping the log and no error', () => {
    const partial = run([event({ type: 'status', note: '處理中' })], started);
    const state = agentRunReducer(partial, { type: 'cancel' });
    expect(state).toMatchObject({ status: 'cancelled', error: null, reply: null });
    expect(state.log).toHaveLength(1);
  });

  it('ignores every action but start once the run has ended or before it begins', () => {
    const actions: AgentRunAction[] = [
      event({ type: 'status', note: '晚到' }), event({ type: 'tool', tool: 'explode_view' }),
      event({ type: 'final', reply: '晚到' }), event({ type: 'error', message: '晚到' }), event({ type: 'done' }),
      { type: 'fail', message: '晚到' }, { type: 'cancel' },
    ];
    const cancelled = agentRunReducer(started, { type: 'cancel' });
    const done = run([event({ type: 'final', reply: 'ok' }), event({ type: 'done' })], started);
    const errored = agentRunReducer(started, { type: 'fail', message: 'x' });
    for (const ended of [cancelled, done, errored, initialAgentRunState]) {
      for (const action of actions) expect(agentRunReducer(ended, action)).toBe(ended);
    }
  });

  it('never puts a raw tool name or argument text in the log', () => {
    const tools = ['generate_design', 'edit_design', 'select_parts', 'get_project_state', 'explode_view', 'wear_on_arm', 'mystery_tool'];
    const state = run(tools.flatMap(tool => [
      event({ type: 'tool', tool }),
      event({ type: 'result', result: result({ tool, summary: '完成。' }) }),
    ]), started);
    const text = JSON.stringify(state.log);
    for (const tool of tools) expect(text).not.toContain(tool);
    expect(state.log.find(entry => entry.label === '其他步驟')).toBeDefined();
  });

  it('replaces model-facing UNKNOWN_TOOL and INVALID_ARGS messages with a plain explanation', () => {
    const unknown = result({
      tool: 'no_such_tool', ok: false,
      summary: '沒有名為「no_such_tool」的工具。可用工具：generate_design、edit_design。',
      detail: { code: 'UNKNOWN_TOOL', message: 'x' },
    });
    const invalid = result({
      tool: 'explode_view', ok: false,
      summary: '工具「explode_view」的參數無效：缺少參數 amount。格式：explode_view(amount: number)。',
      detail: { code: 'INVALID_ARGS', message: 'x' },
    });
    const state = run([event({ type: 'result', result: unknown }), event({ type: 'result', result: invalid })], started);
    const text = JSON.stringify(state.log);
    expect(text).not.toMatch(/no_such_tool|explode_view|generate_design|argsJson|amount/);
    expect(state.log.map(entry => entry.ok)).toEqual([false, false]);
  });
});
