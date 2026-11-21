import { describe, expect, it } from 'vitest';
import { runAgent } from '../../server/agent';
import { runTool, type AgentWorkingState } from '../../server/agent-tools';
import { checkedChange } from '../../server/tools/helpers';
import type { ModelProvider } from '../../server/provider';
import {
  StateChangeSchema, ToolResultSchema, type AgentEventName, type StateChange, type ToolResult,
} from '../../shared/agent';
import { ExportSummarySchema, exportSummary } from '../../shared/export-plan';
import { DEFAULT_PRINTER_PROFILE, type PrinterProfile } from '../../shared/printer';
import { demoModel } from '../../shared/demo';
import { addObject, applyWorkspaceChange, setActiveObject, type Workspace } from '../../shared/workspace';
import { applyStateEvent } from '../../src/agent/apply-state';
import { buildAgentRequest } from '../../src/agent/request';
import { twoBoxes } from '../fixtures/joint-workspace';
import { idCounter, sceneObject, stateOver, workspaceOf } from './agent-fixtures';

/**
 * Export Task 5: the `prepare_export` tool, the `exportDialog` state change and how the loop carries it.
 * No model runs: the tool is local, and the one loop test uses a scripted fake provider.
 */

const signal = new AbortController().signal;
const idleProvider = { name: 'openai', configured: true, model: 'm' } as unknown as ModelProvider;
const call = (args: Record<string, unknown> | string) => ({
  tool: 'prepare_export', argsJson: typeof args === 'string' ? args : JSON.stringify(args), reason: null,
});
const run = (state: AgentWorkingState, args: Record<string, unknown> | string) =>
  runTool(call(args), state, idleProvider, signal, { newObjectId: idCounter('x'), now: () => '2026-11-25T10:00:00.000Z' });

/** The change with the session-state keys removed, as the loop's own `applyWorkspaceChange` sees it. */
const workspaceAfter = (ws: Workspace, change: StateChange): Workspace => {
  const { tryOn: _tryOn, exportDialog: _exportDialog, ...workspaceChange } = change;
  return applyWorkspaceChange(ws, workspaceChange).after;
};

/** A printer profile far from the defaults, to see that the tool reads the request's profile. */
const COARSE: PrinterProfile = { slidingFit: 0.9, pressFit: 0.4, holeCompensation: 1, depthAllowance: 1, petgExtra: 0.5 };

describe('prepare_export', () => {
  it('summarises the whole workspace and asks the browser to open the dialog, without changing the workspace', async () => {
    const ws = twoBoxes({ joint: true });
    const state = stateOver(ws);
    const result = await run(state, { scope: null, objectId: null });

    expect(result.ok).toBe(true);
    expect(ToolResultSchema.safeParse(result).success).toBe(true);
    const summary = ExportSummarySchema.parse(result.detail);
    expect(summary).toEqual(exportSummary(ws, { scope: 'workspace', objectId: null }, DEFAULT_PRINTER_PROFILE));
    expect(summary.objects.map(object => object.objectId)).toEqual(['a', 'b']);
    expect(summary.unconfirmed).toHaveLength(1);

    expect(result.stateChange).toEqual({
      activeObjectId: null, object: null, selection: null, explode: null, tryOn: null,
      exportDialog: { scope: 'workspace', objectId: null },
    });
    expect(StateChangeSchema.safeParse(result.stateChange).success).toBe(true);
    // Session state only: the loop's own apply leaves every part of the workspace as it was.
    expect(workspaceAfter(ws, result.stateChange!)).toEqual(ws);
    expect(ws).toEqual(twoBoxes({ joint: true }));

    expect(result.summary).toContain(summary.note);
    expect(result.summary).toContain('請使用者按「下載完整套件」');
    expect(result.summary).toContain(`標準件 ${summary.standardParts.length} 項`);
  });

  it('counts bought parts and mentions problems in the summary text', async () => {
    const ws = twoBoxes({ joint: true });
    const summary = exportSummary(ws, { scope: 'workspace', objectId: null }, DEFAULT_PRINTER_PROFILE);
    const result = await run(stateOver(ws), { scope: 'workspace', objectId: null });
    const bought = summary.objects.reduce((sum, object) => sum + object.bought, 0);
    expect(result.summary).toContain(`外購件 ${bought} 個`);
    if (summary.problems.length > 0) expect(result.summary).toContain(`，有 ${summary.problems.length} 個問題`);
    else expect(result.summary).not.toContain('個問題');
  });

  it('reads the printer profile of the request, and the defaults only without one', async () => {
    // The summary of an ordinary design does not change with the profile, so watch which profile object is read.
    const ws = twoBoxes({ joint: true, jointOverrides: { method: { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'a' } } });
    const scope = { scope: 'workspace' as const, objectId: null };
    const reads: string[] = [];
    const watched = new Proxy({ ...COARSE }, {
      get(target, key, receiver) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    const result = await run({ ...stateOver(ws), printer: watched }, scope);
    expect(result.ok).toBe(true);
    expect(reads).toContain('holeCompensation');
    expect(result.detail).toEqual(exportSummary(ws, scope, COARSE));
    // Without a profile in the state the defaults apply.
    expect((await run(stateOver(ws), scope)).detail).toEqual(exportSummary(ws, scope, DEFAULT_PRINTER_PROFILE));
  });

  it('exports the assembly of objectId, or of the active object when objectId is null', async () => {
    // Two joined objects plus a loose one, which is the active object.
    const state = stateOver(setActiveObject(addObject(twoBoxes({ joint: true }), sceneObject('solo', demoModel, 3)), 'solo'));

    const named = await run(state, { scope: 'assembly', objectId: 'b' });
    expect(named.ok).toBe(true);
    expect(ExportSummarySchema.parse(named.detail).objects.map(object => object.objectId)).toEqual(['a', 'b']);
    expect(named.stateChange?.exportDialog).toEqual({ scope: 'assembly', objectId: 'b' });

    const active = await run(state, { scope: 'assembly', objectId: null });
    expect(ExportSummarySchema.parse(active.detail).objects.map(object => object.objectId)).toEqual(['solo']);
    expect(active.stateChange?.exportDialog).toEqual({ scope: 'assembly', objectId: null });
  });

  it('a workspace scope carries no object id', async () => {
    const result = await run(stateOver(twoBoxes({ joint: true })), { scope: 'workspace', objectId: 'a' });
    expect(result.ok).toBe(true);
    expect(result.stateChange?.exportDialog).toEqual({ scope: 'workspace', objectId: null });
  });

  it('returns NO_MODEL for an empty workspace', async () => {
    const result = await run(stateOver(workspaceOf()), { scope: null, objectId: null });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatchObject({ code: 'NO_MODEL' });
    expect(result.stateChange).toBeNull();
  });

  it.each([
    ['assembly', 'nope'],
    ['workspace', 'nope'],
    [null, 'nope'],
  ])('returns UNKNOWN_OBJECT for an unknown objectId (scope %s)', async (scope, objectId) => {
    const result = await run(stateOver(twoBoxes({ joint: true })), { scope, objectId });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatchObject({ code: 'UNKNOWN_OBJECT' });
    expect(result.stateChange).toBeNull();
    expect(ToolResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    ['an unknown scope', { scope: 'everything', objectId: null }],
    ['a missing scope', { objectId: null }],
    ['an extra key', { scope: null, objectId: null, extra: 1 }],
    ['a bad object id', { scope: 'assembly', objectId: 'not a valid id' }],
    ['not an object', '"workspace"'],
  ])('rejects bad arguments (%s) with a fixed message and no change', async (_label, args) => {
    const result: ToolResult = await run(stateOver(twoBoxes({ joint: true })), args);
    expect(result.ok).toBe(false);
    expect(result.stateChange).toBeNull();
    expect(result.summary).not.toMatch(/zod|expected|invalid_/i);
  });
});

describe('exportDialog in the contract', () => {
  const base = { activeObjectId: null, object: null, selection: null, explode: null, tryOn: null };

  it('StateChangeSchema parses old payloads and the new field, and rejects a malformed scope', () => {
    expect(StateChangeSchema.safeParse(base).success).toBe(true);
    expect(StateChangeSchema.safeParse({ ...base, exportDialog: null }).success).toBe(true);
    expect(StateChangeSchema.safeParse({ ...base, exportDialog: { scope: 'assembly', objectId: 'a' } }).success).toBe(true);
    expect(StateChangeSchema.safeParse({ ...base, exportDialog: { scope: 'all', objectId: null } }).success).toBe(false);
    expect(StateChangeSchema.safeParse({ ...base, exportDialog: { scope: 'workspace' } }).success).toBe(false);
  });

  it('checkedChange ignores exportDialog, like tryOn', () => {
    const state = stateOver(twoBoxes({ joint: true }));
    const change: StateChange = { ...base, exportDialog: { scope: 'workspace', objectId: null } };
    expect(checkedChange(state, 'prepare_export', change)).toBeNull();
  });

  it('applyStateEvent turns the tool\'s own change into an effect that is not an undo step', async () => {
    const ws = twoBoxes({ joint: true });
    const result = await run(stateOver(ws), { scope: 'assembly', objectId: 'a' });
    const effects = applyStateEvent(result.stateChange, ws)!;
    expect(effects.exportDialog).toEqual({ scope: 'assembly', objectId: 'a' });
    expect(effects.recordUndo).toBe(false);
    expect(effects.after).toEqual(ws);
  });
});

describe('prepare_export in the agent loop', () => {
  it('emits tool, result and state events; the state event opens the dialog; the request printer is used', async () => {
    const ws = twoBoxes({ joint: true });
    const rounds = [
      { type: 'tool_calls', note: '準備匯出', reply: null, calls: [{ tool: 'prepare_export', argsJson: '{"scope":"workspace","objectId":null}', reason: null }] },
      { type: 'final', note: null, reply: '匯出視窗已開啟，請按「下載完整套件」。', calls: null },
    ];
    let index = 0;
    const provider = {
      name: 'openai', configured: true, model: 'fake',
      run: async (task: { parse(raw: unknown): unknown }) => task.parse(rounds[index++]),
    } as unknown as ModelProvider;
    const events: Array<{ name: AgentEventName; data: unknown }> = [];
    const request = {
      ...buildAgentRequest('幫我匯出可以列印的套件', { workspace: ws, tryOn: false, cameraOn: false, printer: COARSE }, [], 'req-1'),
    };
    await runAgent(provider, request, { maxRounds: 4, totalTimeoutMs: 60000 }, (name, data) => events.push({ name, data }), signal);

    expect(events.map(event => event.name)).toEqual(['status', 'tool', 'result', 'state', 'final', 'done']);
    expect(events[1]!.data).toMatchObject({ tool: 'prepare_export', label: '準備匯出' });
    const result = events[2]!.data as ToolResult;
    expect(result.ok).toBe(true);
    expect(result.detail).toEqual(exportSummary(ws, { scope: 'workspace', objectId: null }, COARSE));
    const state = events[3]!.data as StateChange;
    expect(state.exportDialog).toEqual({ scope: 'workspace', objectId: null });
    const effects = applyStateEvent(state, ws)!;
    expect(effects.exportDialog).toEqual({ scope: 'workspace', objectId: null });
    expect(effects.recordUndo).toBe(false);
  });
});
