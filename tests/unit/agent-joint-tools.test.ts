import { describe, expect, it } from 'vitest';
import { runTool, type AgentWorkingState } from '../../server/agent-tools';
import { runAgent, workspaceSnapshot } from '../../server/agent';
import type { ModelProvider } from '../../server/provider';
import {
  AgentRequestSchema, GetProjectStateDetailSchema, JointToolDetailSchema, StateChangeSchema, ToolResultSchema, validateAgentRequest,
  type AgentEventName, type StateChange, type ToolResult,
} from '../../shared/agent';
import { facingPairs, measurePair } from '../../shared/contact';
import type { Joint } from '../../shared/joint';
import { newJoint, recommendFor } from '../../shared/joint-rules';
import { DEFAULT_PRINTER_PROFILE, type PrinterProfile } from '../../shared/printer';
import { addJoint, addObject, applyWorkspaceChange, emptyWorkspace, findObject, type Workspace } from '../../shared/workspace';
import { applyStateEvent } from '../../src/agent/apply-state';
import { buildAgentRequest } from '../../src/agent/request';
import {
  boxModel, BOX, CREATED_AT, fixtureJoint, fixtureModel, fixtureObject, fixturePart, side, twoBoxes,
} from '../fixtures/joint-workspace';
import { idCounter, stateOver } from './agent-fixtures';

/**
 * Assembly-joints Task 5: `create_joint`, `update_joint`, `remove_joint`, `set_material`, the joint view of
 * `get_project_state` and `set_transform`, and the request's printer profile. A fake provider never runs: none
 * of these tools calls a model.
 */

const call = (tool: string, args: Record<string, unknown> = {}) => ({ tool, argsJson: JSON.stringify(args), reason: null });
const signal = new AbortController().signal;
const idleProvider = { name: 'openai', configured: true, model: 'm' } as unknown as ModelProvider;
const NOW = '2026-11-25T10:00:00.000Z';
const vec = (x: number, y: number, z: number) => ({ x, y, z });
const flat = { position: vec(0, 0, 0), rotation: vec(0, 0, 0) };

const run = (state: AgentWorkingState, tool: string, args: Record<string, unknown> = {}) =>
  runTool(call(tool, args), state, idleProvider, signal, { newObjectId: idCounter('joint'), now: () => NOW });

const apply = (state: AgentWorkingState, change: StateChange | null | undefined): Workspace => {
  if (!change) throw new Error('expected a state change');
  const { tryOn: _tryOn, ...workspaceChange } = change;
  return applyWorkspaceChange(state.workspace, workspaceChange).after;
};

/** Every result is a valid `ToolResult` and its change applies to the working workspace. */
function expectConsistent(state: AgentWorkingState, result: ToolResult): void {
  expect(ToolResultSchema.safeParse(result).success).toBe(true);
  if (result.stateChange) {
    expect(StateChangeSchema.safeParse(result.stateChange).success).toBe(true);
    expect(() => apply(state, result.stateChange)).not.toThrow();
  }
}

function expectFailure(state: AgentWorkingState, result: ToolResult, code: string): void {
  expect(result.ok).toBe(false);
  expect(result.detail).toMatchObject({ code });
  expect(result.stateChange).toBeNull();
  expectConsistent(state, result);
}

const jointOf = (ws: Workspace, id = 'joint-1'): Joint => ws.joints.find(joint => joint.id === id)!;
const unconfirmedGlue = (): Joint => fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'));

/** Objects `a` and `b` as in `twoBoxes`, with `b` moved by `gapX` metres. */
function pairWithGap(gapX: number): Workspace {
  let ws = emptyWorkspace();
  ws = addObject(ws, fixtureObject('a', boxModel('Block A'), flat));
  return addObject(ws, fixtureObject('b', boxModel('Block B'), { position: vec(BOX.x + gapX, 0, 0), rotation: vec(0, 0, 0) }));
}

describe('create_joint', () => {
  it('joins two touching objects on their best facing pair without moving anything', async () => {
    const state = stateOver(twoBoxes());
    const result = await run(state, 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'b' } });
    expect(result.ok).toBe(true);
    expectConsistent(state, result);
    expect(result.stateChange).toMatchObject({
      activeObjectId: null, object: null, selection: null, explode: null, tryOn: null,
      joint: { op: 'add', joint: {
        id: 'joint-1', a: side('a', 'body', '+x'), b: side('b', 'body', '-x'), confirmed: false, createdAt: NOW,
        needs: { load: null, disassembly: null },
      } },
    });
    const after = apply(state, result.stateChange);
    expect(after.joints).toHaveLength(1);
    expect(after.objects.map(object => object.transform)).toEqual(state.workspace.objects.map(object => object.transform));
    expect(after.activeObjectId).toBe(state.workspace.activeObjectId);
    expect(result.summary).toContain('已建立接合');
    expect(result.summary).toContain('尚未確認');
    // The new joint carries the top recommendation and nothing else is decided yet.
    const [top] = recommendFor(state.workspace, { a: side('a', 'body', '+x'), b: side('b', 'body', '-x') }, { load: null, disassembly: null }, DEFAULT_PRINTER_PROFILE);
    expect(jointOf(after).method).toEqual(top!.method);
  });

  it('returns the joint, the recommendation with reasons, the findings and the derived numbers', async () => {
    const state = stateOver(twoBoxes());
    const result = await run(state, 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'b' } });
    const detail = JointToolDetailSchema.parse(result.detail);
    expect(detail.jointId).toBe('joint-1');
    expect(detail.joint).toEqual(jointOf(apply(state, result.stateChange)));
    expect(detail.recommendation).toHaveLength(4);
    expect(detail.recommendation[0]!.method).toEqual(detail.joint.method);
    expect(detail.recommendation[0]!.reasons.length).toBeGreaterThan(0);
    expect(detail.recommendation[0]!.reasons[0]).toContain('尚未得知負重與拆裝需求');
    expect(detail.derived).toMatch(/螺絲|磁鐵|定位銷|接觸面積/);
    expect(detail.findings.every(finding => ['error', 'warning', 'info'].includes(finding.severity))).toBe(true);
  });

  it('uses the faces it is given and treats null like a missing part or face', async () => {
    const state = stateOver(twoBoxes());
    const given = await run(state, 'create_joint', { a: { objectId: 'a', partId: 'body', face: '+x' }, b: { objectId: 'b', partId: 'body', face: '-x' } });
    const nulls = await run(state, 'create_joint', { a: { objectId: 'a', partId: null, face: null }, b: { objectId: 'b', partId: null, face: null } });
    expect(given.ok).toBe(true);
    expect(nulls.ok).toBe(true);
    expect(given.stateChange).toEqual(nulls.stateChange);
    // Naming one face narrows the choice: no pair has a's top face against b.
    const none = await run(state, 'create_joint', { a: { objectId: 'a', face: '+y' }, b: { objectId: 'b' } });
    expectFailure(state, none, 'NO_CONTACT_FACE');
  });

  it('aligns side b and its assembly onto side a when the faces are apart', async () => {
    // a and c are far apart; b is joined to c and so is part of c's assembly.
    let ws = pairWithGap(0.2);
    ws = addObject(ws, fixtureObject('c', boxModel('Block C'), { position: vec(0.2 + 2 * BOX.x, 0, 0), rotation: vec(0, 0, 0) }));
    ws = addJoint(ws, fixtureJoint(side('b', 'body', '+x'), side('c', 'body', '-x'), { id: 'joint-bc' }));
    const state = stateOver(ws);
    const result = await run(state, 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'b' }, ...{} });
    expect(result.ok).toBe(true);
    expectConsistent(state, result);
    expect(result.stateChange!.object).toMatchObject({ op: 'transform', objectId: 'b' });
    expect(result.summary).toContain('移到貼合位置');
    const after = apply(state, result.stateChange);
    const joint = after.joints.find(candidate => candidate.id === 'joint-1')!;
    expect(joint.a).toEqual(side('a', 'body', '+x'));
    expect(joint.b).toEqual(side('b', 'body', '-x'));
    // b now touches a, and c moved with b by the same offset.
    expect(measurePair(after, joint.a, joint.b)!.gapMm).toBeCloseTo(0, 3);
    expect(findObject(after, 'b')!.transform.position.x).toBeCloseTo(BOX.x, 4);
    expect(findObject(after, 'c')!.transform.position.x).toBeCloseTo(2 * BOX.x, 4);
    expect(after.joints).toHaveLength(2);
  });

  it('joins two parts of one object that already touch', async () => {
    const model = fixtureModel('Two parts', [
      fixturePart('left', 'box', BOX, vec(-BOX.x / 2, 0, 0)),
      fixturePart('right', 'box', BOX, vec(BOX.x / 2, 0, 0)),
    ]);
    const state = stateOver(addObject(emptyWorkspace(), fixtureObject('one', model, flat)));
    const result = await run(state, 'create_joint', { a: { objectId: 'one', partId: 'left' }, b: { objectId: 'one', partId: 'right' } });
    expect(result.ok).toBe(true);
    expect(result.stateChange!.object).toBeNull();
    expect(jointOf(apply(state, result.stateChange))).toMatchObject({ a: side('one', 'left', '+x'), b: side('one', 'right', '-x') });
  });

  it('returns NOT_TOUCHING inside one assembly when the faces are apart', async () => {
    const model = fixtureModel('Two parts', [
      fixturePart('left', 'box', BOX, vec(-0.05, 0, 0)),
      fixturePart('right', 'box', BOX, vec(0.05, 0, 0)),
    ]);
    const state = stateOver(addObject(emptyWorkspace(), fixtureObject('one', model, flat)));
    const result = await run(state, 'create_joint', { a: { objectId: 'one', partId: 'left', face: '+x' }, b: { objectId: 'one', partId: 'right', face: '-x' } });
    expectFailure(state, result, 'NOT_TOUCHING');
    expect(result.summary).toBe('這兩個面沒有貼合；已接合在一起的零件只能在接觸面上新增接合。');
  });

  it('returns UNKNOWN_OBJECT and UNKNOWN_PART with fixed messages', async () => {
    const state = stateOver(twoBoxes());
    const object = await run(state, 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'nope' } });
    expectFailure(state, object, 'UNKNOWN_OBJECT');
    expect(object.summary).toBe('工作區沒有 id 為「nope」的物件。');
    const part = await run(state, 'create_joint', { a: { objectId: 'a', partId: 'ghost' }, b: { objectId: 'b' } });
    expectFailure(state, part, 'UNKNOWN_PART');
    expect(part.summary).toBe('工作區的「Block A」沒有 id 為「ghost」的零件。');
    expectFailure(stateOver(emptyWorkspace()), await run(stateOver(emptyWorkspace()), 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'b' } }), 'NO_MODEL');
  });

  it('returns NO_CONTACT_FACE when a side has no flat face (a sphere)', async () => {
    let ws = addObject(emptyWorkspace(), fixtureObject('a', boxModel('Block A'), flat));
    ws = addObject(ws, fixtureObject('ball', fixtureModel('Ball', [fixturePart('ball', 'sphere', vec(0.03, 0.03, 0.03))]), { position: vec(0.1, 0, 0), rotation: vec(0, 0, 0) }));
    const state = stateOver(ws);
    const result = await run(state, 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'ball' } });
    expectFailure(state, result, 'NO_CONTACT_FACE');
    expect(result.summary).toBe('這兩個零件沒有可以接合的平面。');
  });

  it('returns CANNOT_ALIGN when the faces differ by more than the snap angle', async () => {
    let ws = addObject(emptyWorkspace(), fixtureObject('a', boxModel('Block A'), flat));
    ws = addObject(ws, fixtureObject('b', boxModel('Block B'), { position: vec(0.2, 0, 0), rotation: vec(0, 0, 40) }));
    const state = stateOver(ws);
    // The 40-degree object has a face within 15 degrees of facing a only by luck; name faces that cannot align.
    const result = await run(state, 'create_joint', { a: { objectId: 'a', partId: 'body', face: '+x' }, b: { objectId: 'b', partId: 'body', face: '-x' } });
    expectFailure(state, result, 'CANNOT_ALIGN');
    expect(result.summary).toBe('兩個面的方向差太多，請先旋轉物件。');
  });

  it('returns JOINT_LIMIT at 32 joints without changing anything', async () => {
    let ws = twoBoxes();
    const faces = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
    let n = 0;
    for (const fa of faces) for (const fb of faces) {
      if (n >= 32) break;
      ws = addJoint(ws, fixtureJoint(side('a', 'body', fa), side('b', 'body', fb), { id: `j-${n++}` }));
    }
    expect(ws.joints).toHaveLength(32);
    const state = stateOver(ws);
    const result = await run(state, 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'b' } });
    expectFailure(state, result, 'JOINT_LIMIT');
    expect(result.summary).toBe('工作區最多 32 個接合，請先刪除一個接合。');
  });

  it('rejects stray or invalid arguments with INVALID_ARGS', async () => {
    const state = stateOver(twoBoxes());
    expectFailure(state, await run(state, 'create_joint', { a: { objectId: 'a' } }), 'INVALID_ARGS');
    expectFailure(state, await run(state, 'create_joint', { a: { objectId: 'a', face: '+w' }, b: { objectId: 'b' } }), 'INVALID_ARGS');
    expectFailure(state, await run(state, 'create_joint', { a: { objectId: 'a', extra: 1 }, b: { objectId: 'b' } }), 'INVALID_ARGS');
  });

  it('plans the method with the printer profile of the run', async () => {
    // 10 mm faces: an M3 insert and its counterbore fit with the default tolerances, not with loose ones.
    const small = (name: string) => fixtureModel(name, [fixturePart('body', 'box', vec(0.04, 0.01, 0.01))]);
    let ws = addObject(emptyWorkspace(), fixtureObject('a', small('A'), flat));
    ws = addObject(ws, fixtureObject('b', small('B'), { position: vec(0.04, 0, 0), rotation: vec(0, 0, 0) }));
    const loose: PrinterProfile = { slidingFit: 1, pressFit: 0.5, holeCompensation: 1, depthAllowance: 1, petgExtra: 0.5 };
    const sides = { a: side('a', 'body', '+x'), b: side('b', 'body', '-x') };
    const expected = (profile: PrinterProfile) => newJoint(ws, { id: 'joint-1', createdAt: NOW, ...sides }, profile).method;
    expect(expected(DEFAULT_PRINTER_PROFILE)).not.toEqual(expected(loose));

    const methodWith = async (printer: PrinterProfile | undefined) => {
      const state: AgentWorkingState = { ...stateOver(ws), ...(printer ? { printer } : {}) };
      const result = await run(state, 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'b' } });
      return jointOf(apply(state, result.stateChange)).method;
    };
    expect(await methodWith(undefined)).toEqual(expected(DEFAULT_PRINTER_PROFILE));
    expect(await methodWith(loose)).toEqual(expected(loose));
  });
});

describe('update_joint', () => {
  const withJoint = (over: Partial<Joint> = {}) => stateOver(twoBoxes({ joint: true, jointOverrides: over }));

  it('sets the needs of an unconfirmed joint and re-picks its method as the card does', async () => {
    const state = withJoint();
    const result = await run(state, 'update_joint', { jointId: 'joint-1', load: 'light', disassembly: 'often' });
    expect(result.ok).toBe(true);
    expectConsistent(state, result);
    const joint = jointOf(apply(state, result.stateChange));
    expect(joint.needs).toEqual({ load: 'light', disassembly: 'often' });
    expect(joint.confirmed).toBe(false);
    const [top] = recommendFor(state.workspace, { a: joint.a, b: joint.b }, joint.needs, DEFAULT_PRINTER_PROFILE, 'joint-1');
    expect(joint.method).toEqual(top!.method);
    expect(joint.method.kind).toBe('magnet'); // light load, taken apart often
    const detail = JointToolDetailSchema.parse(result.detail);
    expect(detail.joint).toEqual(joint);
    expect(detail.recommendation[0]!.method).toEqual(joint.method);
    expect(result.stateChange).toMatchObject({ activeObjectId: null, object: null, joint: { op: 'update' } });
  });

  it('keeps the method of a confirmed joint when only the needs change', async () => {
    const state = withJoint({ confirmed: true });
    const result = await run(state, 'update_joint', { jointId: 'joint-1', load: 'light', disassembly: 'often' });
    const joint = jointOf(apply(state, result.stateChange));
    expect(joint.method).toEqual({ kind: 'glue', glue: 'ca' });
    expect(joint.confirmed).toBe(true);
    expect(joint.needs).toEqual({ load: 'light', disassembly: 'often' });
  });

  it('keeps the method when the same call confirms the joint, and when the method is given', async () => {
    const confirming = withJoint();
    const confirmed = jointOf(apply(confirming, (await run(confirming, 'update_joint', { jointId: 'joint-1', load: 'light', disassembly: 'often', confirmed: true })).stateChange));
    expect(confirmed.method).toEqual({ kind: 'glue', glue: 'ca' });
    expect(confirmed.confirmed).toBe(true);

    const method = { kind: 'pin', pin: 'd3', count: 2, fit: 'press-slide' };
    const explicit = jointOf(apply(confirming, (await run(confirming, 'update_joint', { jointId: 'joint-1', load: 'heavy', method })).stateChange));
    expect(explicit.method).toEqual(method);
    expect(explicit.confirmed).toBe(false);
    expect(explicit.needs).toEqual({ load: 'heavy', disassembly: null });
  });

  it('confirms a joint, treating null fields as not given', async () => {
    const state = withJoint();
    const result = await run(state, 'update_joint', { jointId: 'joint-1', load: null, disassembly: null, method: null, confirmed: true });
    expect(result.ok).toBe(true);
    const joint = jointOf(apply(state, result.stateChange));
    expect(joint).toEqual({ ...jointOf(state.workspace), confirmed: true });
    expect(result.summary).toContain('已確認');
  });

  it('reports no change without a state change when nothing differs', async () => {
    const state = withJoint({ confirmed: true });
    const result = await run(state, 'update_joint', { jointId: 'joint-1', confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.stateChange).toBeNull();
    expect(result.summary).toContain('接合沒有變更');
    expect(JointToolDetailSchema.safeParse(result.detail).success).toBe(true);
  });

  it('returns INVALID_ARGS without a field, UNKNOWN_JOINT for an unknown id and INVALID_JOINT for a method the faces do not take', async () => {
    const state = withJoint();
    const empty = await run(state, 'update_joint', { jointId: 'joint-1' });
    expectFailure(state, empty, 'INVALID_ARGS');
    expect(empty.summary).toBe('請至少提供一個要修改的欄位。');
    expectFailure(state, await run(state, 'update_joint', { jointId: 'joint-1', load: null, confirmed: null }), 'INVALID_ARGS');
    const unknown = await run(state, 'update_joint', { jointId: 'nope', load: 'light' });
    expectFailure(state, unknown, 'UNKNOWN_JOINT');
    expect(unknown.summary).toBe('找不到指定的接合。');
    expectFailure(state, await run(state, 'update_joint', { jointId: 'joint-1', load: 'extreme' }), 'INVALID_ARGS');
    expectFailure(state, await run(state, 'update_joint', { jointId: 'joint-1', method: { kind: 'magnet', magnet: 'd99', count: 1 } }), 'INVALID_ARGS');

    // A tube end is a ring face: only glue is allowed.
    let ws = addObject(emptyWorkspace(), fixtureObject('a', boxModel('Block A'), flat));
    ws = addObject(ws, fixtureObject('t', fixtureModel('Tube', [fixturePart('t', 'tube', vec(0.03, 0.04, 0.03))]), { position: vec(0, (BOX.y + 0.04) / 2, 0), rotation: vec(0, 0, 0) }));
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '+y'), side('t', 't', '-y')));
    const ring = stateOver(ws);
    const rejected = await run(ring, 'update_joint', { jointId: 'joint-1', method: { kind: 'magnet', magnet: 'd6x2', count: 1 } });
    expectFailure(ring, rejected, 'INVALID_JOINT');
    expect(rejected.summary).toBe('接合資料無效。');
  });
});

describe('remove_joint', () => {
  it('removes the joint and leaves the objects where they are', async () => {
    const state = stateOver(twoBoxes({ joint: true }));
    const result = await run(state, 'remove_joint', { jointId: 'joint-1' });
    expect(result.ok).toBe(true);
    expectConsistent(state, result);
    expect(result.stateChange).toMatchObject({ activeObjectId: null, object: null, joint: { op: 'remove', jointId: 'joint-1' } });
    const after = apply(state, result.stateChange);
    expect(after.joints).toEqual([]);
    expect(after.objects).toBe(state.workspace.objects);
    expect(result.summary).toContain('已移除接合');
  });

  it('returns UNKNOWN_JOINT for an unknown id', async () => {
    const state = stateOver(twoBoxes({ joint: true }));
    expectFailure(state, await run(state, 'remove_joint', { jointId: 'nope' }), 'UNKNOWN_JOINT');
    expectFailure(state, await run(state, 'remove_joint', {}), 'INVALID_ARGS');
  });
});

describe('set_material', () => {
  it('sets the material, makes the object active and is one object change', async () => {
    const state = stateOver(twoBoxes());
    expect(state.workspace.activeObjectId).toBe('b');
    const result = await run(state, 'set_material', { objectId: 'a', material: 'petg' });
    expect(result.ok).toBe(true);
    expectConsistent(state, result);
    expect(result.stateChange).toMatchObject({ activeObjectId: 'a', object: { op: 'material', objectId: 'a', material: 'petg' } });
    expect(result.stateChange!.joint ?? null).toBeNull();
    const after = apply(state, result.stateChange);
    expect(findObject(after, 'a')!.material).toBe('petg');
    expect(findObject(after, 'a')!.edited).toBe(false);
    expect(after.activeObjectId).toBe('a');
    expect(result.summary).toContain('PETG');
    expect(result.detail).toEqual({ objectId: 'a', activeObjectId: 'a', transform: null });
  });

  it('clears the material with null and reports an unchanged material without a state change', async () => {
    const state = stateOver(twoBoxes());
    const set = await run(state, 'set_material', { objectId: 'b', material: 'pla' });
    expect(set.stateChange).toMatchObject({ activeObjectId: null }); // b is already active
    const withPla = stateOver(apply(state, set.stateChange));
    const cleared = await run(withPla, 'set_material', { objectId: 'b', material: null });
    expect(findObject(apply(withPla, cleared.stateChange), 'b')!.material).toBeNull();
    expect(cleared.summary).toContain('已清除');
    const same = await run(withPla, 'set_material', { objectId: 'b', material: 'pla' });
    expect(same.ok).toBe(true);
    expect(same.stateChange).toBeNull();
  });

  it('returns UNKNOWN_OBJECT and INVALID_ARGS for a bad id or material, and requires the material key', async () => {
    const state = stateOver(twoBoxes());
    expectFailure(state, await run(state, 'set_material', { objectId: 'nope', material: 'pla' }), 'UNKNOWN_OBJECT');
    expectFailure(state, await run(state, 'set_material', { objectId: 'a', material: 'wood' }), 'INVALID_ARGS');
    expectFailure(state, await run(state, 'set_material', { objectId: 'a' }), 'INVALID_ARGS');
  });
});

describe('get_project_state and set_transform with joints', () => {
  it('lists each object\'s material and the joints in short form', async () => {
    let ws = twoBoxes({ joint: true });
    ws = apply(stateOver(ws), (await run(stateOver(ws), 'set_material', { objectId: 'a', material: 'abs' })).stateChange);
    const state = stateOver(ws);
    const result = await run(state, 'get_project_state', {});
    const detail = GetProjectStateDetailSchema.parse(result.detail);
    expect(detail.objects.map(object => [object.id, object.material])).toEqual([['a', 'abs'], ['b', null]]);
    expect(detail.joints).toHaveLength(1);
    expect(detail.joints[0]).toMatchObject({
      id: 'joint-1', confirmed: false, method: { kind: 'glue', glue: 'ca' }, needs: { load: null, disassembly: null },
      a: { objectId: 'a', objectName: 'Block A', partId: 'body', partName: 'body', face: '+x' },
      b: { objectId: 'b', objectName: 'Block B', partId: 'body', partName: 'body', face: '-x' },
    });
    expect(Array.isArray(detail.joints[0]!.findings)).toBe(true);
    expect(result.stateChange).toBeNull();
    // Without joints the list is empty.
    expect(GetProjectStateDetailSchema.parse((await run(stateOver(twoBoxes()), 'get_project_state', {})).detail).joints).toEqual([]);
  });

  it('set_transform moves the whole assembly and says how many other objects moved', async () => {
    const state = stateOver(twoBoxes({ joint: true }));
    const result = await run(state, 'set_transform', { objectId: 'a', position: vec(0.1, 0, 0) });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('已移動「Block A」（連同接合的 1 個物件）。');
    const after = apply(state, result.stateChange);
    expect(findObject(after, 'a')!.transform.position.x).toBeCloseTo(0.1, 5);
    expect(findObject(after, 'b')!.transform.position.x).toBeCloseTo(0.1 + BOX.x, 5);
    // An object without a joint moves alone and the summary is unchanged.
    const alone = await run(stateOver(twoBoxes()), 'set_transform', { objectId: 'a', position: vec(0.1, 0, 0) });
    expect(alone.summary).toBe('已移動「Block A」。');
  });
});

describe('state changes on the server and in the browser', () => {
  it('apply identically through applyWorkspaceChange and applyStateEvent, and each is an undo step', async () => {
    const state = stateOver(pairWithGap(0.1));
    const created = await run(state, 'create_joint', { a: { objectId: 'a' }, b: { objectId: 'b' } });
    expect(created.ok).toBe(true);
    const afterCreate = apply(state, created.stateChange);

    const steps: Array<[string, AgentWorkingState, ToolResult]> = [
      ['create_joint', state, created],
      ['update_joint', stateOver(afterCreate), await run(stateOver(afterCreate), 'update_joint', { jointId: 'joint-1', load: 'heavy', disassembly: 'never' })],
      ['set_material', stateOver(afterCreate), await run(stateOver(afterCreate), 'set_material', { objectId: 'a', material: 'nylon' })],
      ['remove_joint', stateOver(afterCreate), await run(stateOver(afterCreate), 'remove_joint', { jointId: 'joint-1' })],
    ];
    for (const [name, from, result] of steps) {
      expect(result.ok, name).toBe(true);
      const payload = JSON.parse(JSON.stringify(result.stateChange));
      const effects = applyStateEvent(payload, from.workspace);
      expect(effects, name).not.toBeNull();
      expect(effects!.after, name).toEqual(apply(from, result.stateChange));
      expect(effects!.recordUndo, name).toBe(true);
    }
  });

  it('a joint-only change records an undo step, and an old payload without `joint` still parses', () => {
    const ws = twoBoxes({ joint: true });
    const removal = { activeObjectId: null, object: null, joint: { op: 'remove', jointId: 'joint-1' }, selection: null, explode: null, tryOn: null };
    expect(applyStateEvent(removal, ws)).toMatchObject({ recordUndo: true });
    expect(applyStateEvent({ ...removal, joint: null }, ws)).toMatchObject({ recordUndo: false });
    const old = { activeObjectId: null, object: null, selection: null, explode: 0.5, tryOn: null };
    expect(StateChangeSchema.safeParse(old).success).toBe(true);
    expect(applyStateEvent(old, ws)).toMatchObject({ recordUndo: false });
  });

  it('a change that names an unknown joint, or changes the sides of a joint, is dropped', () => {
    const ws = twoBoxes({ joint: true });
    expect(applyStateEvent({ activeObjectId: null, object: null, joint: { op: 'remove', jointId: 'nope' }, selection: null, explode: null, tryOn: null }, ws)).toBeNull();
    const moved: Joint = { ...jointOf(ws), a: side('a', 'body', '+y') };
    expect(applyStateEvent({ activeObjectId: null, object: null, joint: { op: 'update', joint: moved }, selection: null, explode: null, tryOn: null }, ws)).toBeNull();
  });
});

describe('the printer profile in the request', () => {
  const base = { instruction: '接合', requestId: 'req-1', tryOn: false, cameraOn: false, history: [] };
  const custom: PrinterProfile = { slidingFit: 0.3, pressFit: 0.12, holeCompensation: 0.25, depthAllowance: 0.1, petgExtra: 0.05 };

  it('is optional in the schema, defaulted by validateAgentRequest and sent by buildAgentRequest', () => {
    const workspace = emptyWorkspace();
    expect(AgentRequestSchema.safeParse({ ...base, workspace }).success).toBe(true);
    expect(validateAgentRequest({ ...base, workspace }).printer).toEqual(DEFAULT_PRINTER_PROFILE);
    expect(validateAgentRequest({ ...base, workspace, printer: custom }).printer).toEqual(custom);
    expect(AgentRequestSchema.safeParse({ ...base, workspace, printer: { ...custom, slidingFit: 5 } }).success).toBe(false);
    expect(AgentRequestSchema.safeParse({ ...base, workspace, printer: { ...custom, extra: 1 } }).success).toBe(false);
    const request = buildAgentRequest('接合', { workspace, tryOn: false, cameraOn: false, printer: custom }, [], 'req-1');
    expect(request.printer).toEqual(custom);
    expect(validateAgentRequest(JSON.parse(JSON.stringify(request))).printer).toEqual(custom);
    expect(buildAgentRequest('接合', { workspace, tryOn: false, cameraOn: false }, [], 'req-1')).not.toHaveProperty('printer');
  });

  it('reaches the tools of an agent run, and a run without it uses the defaults', async () => {
    const small = (name: string) => fixtureModel(name, [fixturePart('body', 'box', vec(0.04, 0.01, 0.01))]);
    let ws = addObject(emptyWorkspace(), fixtureObject('a', small('A'), flat));
    ws = addObject(ws, fixtureObject('b', small('B'), { position: vec(0.04, 0, 0), rotation: vec(0, 0, 0) }));
    const loose: PrinterProfile = { slidingFit: 1, pressFit: 0.5, holeCompensation: 1, depthAllowance: 1, petgExtra: 0.5 };

    async function methodOfRun(printer: PrinterProfile | undefined) {
      const script = [
        { type: 'tool_calls', note: null, reply: null, calls: [{ tool: 'create_joint', argsJson: JSON.stringify({ a: { objectId: 'a' }, b: { objectId: 'b' } }), reason: null }] },
        { type: 'final', note: null, reply: '完成。', calls: null },
      ];
      const provider = {
        name: 'openai', configured: true, model: 'test-model',
        run: async (task: { parse(raw: unknown): unknown }) => task.parse(script.shift()),
      } as unknown as ModelProvider;
      const events: Array<{ name: AgentEventName; data: unknown }> = [];
      await runAgent(provider, { ...base, workspace: ws, ...(printer ? { printer } : {}) },
        { maxRounds: 3, totalTimeoutMs: 5000, newObjectId: idCounter('joint'), now: () => NOW },
        (name, data) => events.push({ name, data }), new AbortController().signal);
      const state = events.find(event => event.name === 'state')!.data as StateChange;
      return (state.joint as { op: 'add'; joint: Joint }).joint.method;
    }

    const expected = (profile: PrinterProfile) => newJoint(ws, { id: 'joint-1', createdAt: NOW, a: side('a', 'body', '+x'), b: side('b', 'body', '-x') }, profile).method;
    expect(await methodOfRun(undefined)).toEqual(expected(DEFAULT_PRINTER_PROFILE));
    expect(await methodOfRun(loose)).toEqual(expected(loose));
    expect(expected(loose)).not.toEqual(expected(DEFAULT_PRINTER_PROFILE));
  });
});

describe('the snapshot of the working copy', () => {
  it('shows the material of every object and no joints block when there are none', () => {
    const text = workspaceSnapshot(stateOver(twoBoxes()));
    expect(text).toContain('材料 未指定');
    expect(text).not.toContain('接合');
  });

  it('lists each joint with its sides, method, state and needs, and the codes of its problems', () => {
    let ws = twoBoxes({ joint: true, jointOverrides: { needs: { load: 'light', disassembly: 'often' }, confirmed: true } });
    ws = { ...ws, objects: ws.objects.map(object => (object.id === 'a' ? { ...object, material: 'pla' as const } : object)) };
    const text = workspaceSnapshot(stateOver(ws));
    expect(text).toContain('，材料 PLA');
    expect(text).toContain('接合 1 個：');
    expect(text).toContain('- joint-1：「Block A」body（右面）↔「Block B」body（左面），膠合（瞬間膠），已確認，負重 輕，拆裝 經常');
    // A joint whose faces are apart is a problem.
    const apart = twoBoxes({ joint: true });
    const moved = { ...apart, objects: apart.objects.map(object => (object.id === 'b' ? { ...object, transform: { ...object.transform, position: vec(0.2, 0, 0) } } : object)) };
    expect(workspaceSnapshot(stateOver(moved))).toContain('待確認，負重 未指定，拆裝 未指定，問題：APART');
  });

  it('never carries tool arguments or a created-at time', () => {
    const text = workspaceSnapshot(stateOver(twoBoxes({ joint: true })));
    expect(text).not.toContain(CREATED_AT);
  });
});
