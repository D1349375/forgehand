import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import { recommendJoint } from '../../shared/joint-rules';
import type { Joint, JointMethod } from '../../shared/joint';
import { addJoint, addObject, emptyWorkspace, setMaterial, updateJoint, type Workspace } from '../../shared/workspace';
import {
  buildKit, derivedText, jointCardModel, jointRows, jointState, onConfirm, onMethod, onNeeds, onParam, onRecommendation,
} from '../../src/joints/card-model';
import {
  JOINT_NOTICES, JOINT_STATE_LABELS, MATERIAL_OPTIONS, METHOD_LABELS, askAgentText, methodSummary,
} from '../../src/joints/labels';
import { hasContactFace, mouseJoinStep, previewPoses, type MouseJoinState } from '../../src/joints/mouse-join';
import { PRINTER_STORAGE_KEY, loadPrinterProfile, savePrinterProfile } from '../../src/joints/printer-store';
import { buildPartMarks, computeMarks, faceOutline, glowMarks, jointOutlines, markId, markKey, type PartMarks } from '../../src/scene/joint-marks';
import {
  BOX, boxModel, demoPair, fixtureJoint, fixtureModel, fixtureObject, fixturePart, rotatedPair, side, twoBoxes,
} from '../fixtures/joint-workspace';

const PROFILE = DEFAULT_PRINTER_PROFILE;
const vec = (x: number, y: number, z: number) => ({ x, y, z });
const kitOf = (ws: Workspace) => buildKit(ws, PROFILE);
const cardOf = (ws: Workspace, id = 'joint-1') => jointCardModel(ws, id, kitOf(ws), recommendJoint(ws, id, PROFILE))!;
const screws = (count = 2): JointMethod => ({ kind: 'screw-insert', size: 'M3', count, insertSide: 'a' });

/** Two thin plates, 1 mm thick, one on top of the other: two facing pairs (top/bottom and bottom/top, 2 mm inside). */
function plates(): Workspace {
  const plate = (name: string) => fixtureModel(name, [fixturePart('plate', 'box', { x: 0.04, y: 0.001, z: 0.03 })]);
  return [
    fixtureObject('p', plate('Plate P'), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }),
    fixtureObject('q', plate('Plate Q'), { position: vec(0, 0.001, 0), rotation: vec(0, 0, 0) }),
  ].reduce(addObject, emptyWorkspace());
}

/** A box and a sphere: the sphere has no contact face. */
function boxAndSphere(): Workspace {
  const ball = fixtureModel('Ball', [fixturePart('ball', 'sphere', { x: 0.02, y: 0.02, z: 0.02 })]);
  return [
    fixtureObject('a', boxModel('Block A'), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }),
    fixtureObject('s', ball, { position: vec(0.05, 0, 0), rotation: vec(0, 0, 0) }),
  ].reduce(addObject, emptyWorkspace());
}

describe('mouseJoinStep', () => {
  const off: MouseJoinState = { step: 'off' };
  const start = (ws: Workspace) => mouseJoinStep(off, { type: 'start' }, ws).state;

  it('starts at the first step and ignores picks while off', () => {
    const ws = twoBoxes();
    expect(start(ws)).toEqual({ step: 'first' });
    const result = mouseJoinStep(off, { type: 'pick', objectId: 'a', partId: 'body' }, ws);
    expect(result.state).toBe(off);
    expect(result.notice).toBeNull();
  });

  it('first pick: a part with a flat face moves on, a sphere gives the notice, empty space and unknown parts change nothing', () => {
    const ws = boxAndSphere();
    const first = start(ws);
    expect(mouseJoinStep(first, { type: 'pick', objectId: 'a', partId: 'body' }, ws).state).toEqual({ step: 'second', a: { objectId: 'a', partId: 'body' } });
    const ball = mouseJoinStep(first, { type: 'pick', objectId: 's', partId: 'ball' }, ws);
    expect(ball.state).toBe(first);
    expect(ball.notice).toBe('這個零件沒有平面可以接合。');
    expect(mouseJoinStep(first, { type: 'pick', objectId: null, partId: null }, ws).state).toBe(first);
    expect(mouseJoinStep(first, { type: 'pick', objectId: 'a', partId: 'missing' }, ws).state).toBe(first);
    expect(hasContactFace(ws, { objectId: 's', partId: 'ball' })).toBe(false);
    expect(hasContactFace(ws, { objectId: 'a', partId: 'body' })).toBe(true);
  });

  it('second pick of a facing part gives a preview with the best pair of the two parts', () => {
    const ws = demoPair();
    const second = mouseJoinStep(start(ws), { type: 'pick', objectId: 'demo-a', partId: 'battery' }, ws).state;
    const result = mouseJoinStep(second, { type: 'pick', objectId: 'demo-b', partId: 'housing' }, ws);
    expect(result.notice).toBeNull();
    expect(result.state.step).toBe('preview');
    if (result.state.step !== 'preview') throw new Error('not a preview');
    expect(result.state.pairIndex).toBe(0);
    expect(result.state.plan.a).toEqual({ objectId: 'demo-a', partId: 'battery', face: '+x' });
    expect(result.state.plan.b).toEqual({ objectId: 'demo-b', partId: 'housing', face: '-x' });
    // The second demo object is placed beside the first with a gap: b has to move to meet a.
    expect(result.state.plan.move?.objectId).toBe('demo-b');
  });

  it('a failed plan stays in the second step with the plan message', () => {
    const ws = boxAndSphere();
    const second = mouseJoinStep(start(ws), { type: 'pick', objectId: 'a', partId: 'body' }, ws).state;
    const ball = mouseJoinStep(second, { type: 'pick', objectId: 's', partId: 'ball' }, ws);
    expect(ball.state).toEqual({ step: 'second', a: { objectId: 'a', partId: 'body' } });
    expect(ball.notice).toBe('這兩個零件沒有可以接合的平面。');
    // The same part twice has no facing pair either.
    const same = mouseJoinStep(second, { type: 'pick', objectId: 'a', partId: 'body' }, ws);
    expect(same.state.step).toBe('second');
    expect(same.notice).toBe('這兩個零件沒有可以接合的平面。');
  });

  it('parts of objects that already touch need no move; a gap gives an aligned move', () => {
    const ws = twoBoxes();
    const second = mouseJoinStep(start(ws), { type: 'pick', objectId: 'a', partId: 'body' }, ws).state;
    const result = mouseJoinStep(second, { type: 'pick', objectId: 'b', partId: 'body' }, ws);
    if (result.state.step !== 'preview') throw new Error('not a preview');
    expect(result.state.plan.move).toBeNull();
    expect(previewPoses(ws, result.state.plan)?.transforms).toEqual([]);
  });

  it('next-pair steps through the ranked pairs and wraps around', () => {
    const ws = plates();
    const second = mouseJoinStep(start(ws), { type: 'pick', objectId: 'p', partId: 'plate' }, ws).state;
    const preview = mouseJoinStep(second, { type: 'pick', objectId: 'q', partId: 'plate' }, ws).state;
    if (preview.step !== 'preview') throw new Error('not a preview');
    expect(preview.plan.pairs).toHaveLength(2);
    expect(preview.plan.a.face).toBe('+y');
    const next = mouseJoinStep(preview, { type: 'next-pair' }, ws);
    if (next.state.step !== 'preview') throw new Error('not a preview');
    expect(next.state.pairIndex).toBe(1);
    expect(next.state.plan.a.face).toBe('-y');
    const wrapped = mouseJoinStep(next.state, { type: 'next-pair' }, ws);
    if (wrapped.state.step !== 'preview') throw new Error('not a preview');
    expect(wrapped.state.pairIndex).toBe(0);
    expect(wrapped.state.plan.a.face).toBe('+y');
  });

  it('next-pair with one pair, or outside a preview, changes nothing', () => {
    const ws = demoPair();
    const first = start(ws);
    expect(mouseJoinStep(first, { type: 'next-pair' }, ws).state).toBe(first);
    const second = mouseJoinStep(first, { type: 'pick', objectId: 'demo-a', partId: 'battery' }, ws).state;
    const preview = mouseJoinStep(second, { type: 'pick', objectId: 'demo-b', partId: 'housing' }, ws).state;
    if (preview.step !== 'preview') throw new Error('not a preview');
    expect(preview.plan.pairs).toHaveLength(1);
    expect(mouseJoinStep(preview, { type: 'next-pair' }, ws).state).toBe(preview);
  });

  it('a pick in the preview chooses another part as side b; a failed pick returns to the second step', () => {
    const ws = demoPair();
    const second = mouseJoinStep(start(ws), { type: 'pick', objectId: 'demo-a', partId: 'battery' }, ws).state;
    const preview = mouseJoinStep(second, { type: 'pick', objectId: 'demo-b', partId: 'housing' }, ws).state;
    const again = mouseJoinStep(preview, { type: 'pick', objectId: 'demo-a', partId: 'battery' }, ws);
    expect(again.state.step).toBe('second');
    expect(again.notice).toBe('這兩個零件沒有可以接合的平面。');
  });

  it('cancel and workspace-changed put everything away from every step, and do nothing when already off', () => {
    const ws = demoPair();
    const first = start(ws);
    const second = mouseJoinStep(first, { type: 'pick', objectId: 'demo-a', partId: 'battery' }, ws).state;
    const preview = mouseJoinStep(second, { type: 'pick', objectId: 'demo-b', partId: 'housing' }, ws).state;
    for (const state of [first, second, preview]) {
      expect(mouseJoinStep(state, { type: 'cancel' }, ws).state).toEqual(off);
      expect(mouseJoinStep(state, { type: 'workspace-changed' }, ws).state).toEqual(off);
    }
    expect(mouseJoinStep(off, { type: 'cancel' }, ws).state).toBe(off);
    expect(mouseJoinStep(off, { type: 'workspace-changed' }, ws).state).toBe(off);
  });

  it('previewPoses moves side b with its whole assembly and puts the label on side a', () => {
    const ws = demoPair();
    const second = mouseJoinStep(start(ws), { type: 'pick', objectId: 'demo-a', partId: 'battery' }, ws).state;
    const preview = mouseJoinStep(second, { type: 'pick', objectId: 'demo-b', partId: 'housing' }, ws).state;
    if (preview.step !== 'preview') throw new Error('not a preview');
    const poses = previewPoses(ws, preview.plan)!;
    expect(poses.transforms.map(pose => pose.objectId)).toEqual(['demo-b']);
    expect(poses.transforms[0]!.transform.position.x).not.toBe(ws.objects[1]!.transform.position.x);
    expect(poses.label.x).toBeGreaterThan(0);
  });
});

describe('jointRows and jointState', () => {
  it('lists each joint with its two sides, its method and its state', () => {
    const ws = twoBoxes({ joint: true });
    const [row] = jointRows(ws, kitOf(ws).findings);
    expect(row).toMatchObject({
      id: 'joint-1', label: 'Block A・body ↔ Block B・body', methodLabel: '膠合（瞬間膠）', state: 'pending', stateText: '待確認', icon: '○',
    });
  });

  it('a confirmed joint is 已確認; any error makes it 有問題, whatever its confirmation', () => {
    const touching = twoBoxes({ joint: true });
    const confirmed = updateJoint(touching, 'joint-1', { confirmed: true });
    expect(jointRows(confirmed, kitOf(confirmed).findings)[0]).toMatchObject({ state: 'confirmed', stateText: '已確認', icon: '✓' });
    const apart = demoPair({ joint: true, jointOverrides: { confirmed: true } });
    const findings = kitOf(apart).findings;
    expect(findings.get('joint-1')?.some(finding => finding.code === 'APART')).toBe(true);
    expect(jointRows(apart, findings)[0]).toMatchObject({ state: 'problem', stateText: '有問題', icon: '⚠' });
    expect(jointState({ confirmed: false }, undefined)).toBe('pending');
    expect(JOINT_STATE_LABELS.problem.text).toBe('有問題');
  });
});

describe('jointCardModel', () => {
  it('shows the sides with their face labels, the recommendation and the buttons of an unconfirmed joint', () => {
    const card = cardOf(twoBoxes({ joint: true }));
    expect(card.title).toBe('Block A・body ↔ Block B・body');
    expect(card.sideA).toEqual({ tag: 'a', name: 'Block A・body', faceLabel: '右面' });
    expect(card.sideB).toEqual({ tag: 'b', name: 'Block B・body', faceLabel: '左面' });
    expect(card.state).toBe('pending');
    expect(card.recommendation?.reasons[0]).toBe('尚未得知負重與拆裝需求，先假設中等負重、偶爾拆裝。');
    expect(card.actions.confirm).toBe(true);
    expect(card.actions.useRecommendation).toBe(false);
    expect(card.actions.realign).toBe(false);
    expect(card.actions.askAgent).toBe('請幫我為接合「Block A・body」↔「Block B・body」選擇固定方式，先問我負重和拆裝需求。');
    expect(card.methodKinds.map(kind => [kind.kind, kind.label, kind.allowed])).toEqual([
      ['screw-insert', '熱壓螺母＋螺絲', true], ['magnet', '磁鐵', true], ['pin', '定位銷', true], ['glue', '膠合', true],
    ]);
  });

  it('offers one preview button per printed side, and none for a bought component or a metal side', () => {
    const ws = twoBoxes({ joint: true });
    expect(cardOf(ws).actions.previews.map(item => [item.side, item.label])).toEqual([['a', '預覽「body」列印件'], ['b', '預覽「body」列印件']]);
    const metal = setMaterial(ws, 'b', 'aluminium');
    expect(cardOf(metal).actions.previews.map(item => item.side)).toEqual(['a']);
  });

  it('returns null for a joint that does not exist', () => {
    const ws = twoBoxes();
    expect(jointCardModel(ws, 'nope', kitOf(ws), [])).toBeNull();
  });

  it('a confirmed joint shows 改用建議 only when the top recommendation is another method', () => {
    const base = updateJoint(twoBoxes({ joint: true }), 'joint-1', { method: screws(), confirmed: true });
    const top = recommendJoint(base, 'joint-1', PROFILE)[0]!;
    const card = cardOf(base);
    expect(card.actions.confirm).toBe(false);
    expect(card.actions.useRecommendation).toBe(JSON.stringify(top.method) !== JSON.stringify(screws()));
    const agreeing = updateJoint(base, 'joint-1', { method: top.method });
    expect(cardOf(agreeing).actions.useRecommendation).toBe(false);
    const other = updateJoint(base, 'joint-1', { method: { kind: 'glue', glue: top.method.kind === 'glue' ? 'epoxy' : 'ca' } });
    expect(cardOf(other).actions.useRecommendation).toBe(true);
  });

  it('offers 重新對齊 only for a joint between two objects whose faces are apart', () => {
    expect(cardOf(demoPair({ joint: true })).actions.realign).toBe(true);
    expect(cardOf(twoBoxes({ joint: true })).actions.realign).toBe(false);
  });

  it('a tube cap takes glue only', () => {
    const tube = fixtureModel('Tube', [fixturePart('t', 'tube', { x: 0.04, y: 0.03, z: 0.04 })]);
    const ws = addJoint(
      [fixtureObject('t', tube, { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }),
        fixtureObject('b', boxModel('Cap'), { position: vec(0, 0.025, 0), rotation: vec(0, 0, 0) })].reduce(addObject, emptyWorkspace()),
      fixtureJoint(side('t', 't', '+y'), side('b', 'body', '-y')),
    );
    const card = jointCardModel(ws, 'joint-1', kitOf(ws), recommendJoint(ws, 'joint-1', PROFILE))!;
    expect(card.methodKinds.map(kind => [kind.kind, kind.allowed])).toEqual([['screw-insert', false], ['magnet', false], ['pin', false], ['glue', true]]);
  });
});

describe('derivedText', () => {
  it('describes screws with inserts with their sizes and printed hole diameters', () => {
    const ws = updateJoint(twoBoxes({ joint: true }), 'joint-1', { method: screws() });
    const joint = ws.joints[0]!;
    const text = derivedText(joint, kitOf(ws).features.joints.get('joint-1'));
    // Default profile: insert hole 4.0 + 0.2, counterbore 5.5 + 0.2 + 2 × 0.25.
    expect(text).toMatch(/^M3×\d+ 螺絲 ×2、M3×5\.7 熱壓螺母 ×2、螺母孔 Ø4\.20 mm、沉孔 Ø6\.20 mm/);
  });

  it('describes magnets, pins and glue', () => {
    const base = twoBoxes({ joint: true });
    const text = (method: JointMethod) => {
      const ws = updateJoint(base, 'joint-1', { method });
      return derivedText(ws.joints[0]!, kitOf(ws).features.joints.get('joint-1'));
    };
    expect(text({ kind: 'magnet', magnet: 'd6x3', count: 2 })).toMatch(/^6×3 mm 磁鐵 ×4、磁鐵孔 Ø6\.\d\d mm$/);
    expect(text({ kind: 'pin', pin: 'd3', count: 1, fit: 'press-both' })).toMatch(/^Ø3×\d+ mm 定位銷 ×1、銷孔 Ø3\.\d\d mm$/);
    expect(text({ kind: 'glue', glue: 'epoxy' })).toMatch(/^AB 膠、接觸面積 \d+ mm²$/);
    expect(derivedText({ method: { kind: 'glue', glue: 'ca' } }, undefined)).toBe('');
  });
});

describe('the rules of requirement 55', () => {
  const joint = (ws: Workspace): Joint => ws.joints[0]!;

  it('changing 負重 or 拆裝 on an unconfirmed joint takes the new top recommendation and stays unconfirmed', () => {
    const ws = twoBoxes({ joint: true });
    const patch = onNeeds(ws, joint(ws), { load: 'light', disassembly: 'often' }, PROFILE);
    expect(patch.confirmed).toBeUndefined();
    expect(patch.needs).toEqual({ load: 'light', disassembly: 'often' });
    expect(patch.method?.kind).toBe('magnet');
    const next = updateJoint(ws, 'joint-1', patch);
    expect(next.joints[0]).toMatchObject({ confirmed: false, needs: { load: 'light', disassembly: 'often' }, method: { kind: 'magnet' } });
  });

  it('changing the needs of a confirmed joint keeps its method', () => {
    const ws = updateJoint(twoBoxes({ joint: true }), 'joint-1', { method: screws(), confirmed: true });
    const patch = onNeeds(ws, joint(ws), { load: 'light', disassembly: 'often' }, PROFILE);
    expect(patch).toEqual({ needs: { load: 'light', disassembly: 'often' } });
    expect(updateJoint(ws, 'joint-1', patch).joints[0]).toMatchObject({ confirmed: true, method: { kind: 'screw-insert' } });
  });

  it('choosing a method takes that method\'s recommended parameters and confirms; the same method changes nothing', () => {
    const ws = twoBoxes({ joint: true });
    const recommendations = recommendJoint(ws, 'joint-1', PROFILE);
    const patch = onMethod(joint(ws), 'pin', recommendations);
    expect(patch.confirmed).toBe(true);
    expect(patch.method?.kind).toBe('pin');
    expect(updateJoint(ws, 'joint-1', patch).joints[0]).toMatchObject({ confirmed: true, method: { kind: 'pin' } });
    expect(onMethod(joint(ws), 'glue', recommendations)).toEqual({});
    expect(updateJoint(ws, 'joint-1', {})).toBe(ws);
  });

  it('changing a parameter keeps the kind, changes one field and confirms', () => {
    const ws = updateJoint(twoBoxes({ joint: true }), 'joint-1', { method: screws() });
    const patch = onParam(joint(ws), { count: 1 });
    expect(patch).toEqual({ method: { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'a' }, confirmed: true });
    expect(updateJoint(ws, 'joint-1', patch).joints[0]).toMatchObject({ confirmed: true, method: { count: 1 } });
    expect(onParam(joint(ws), { size: 'M2' }).method).toMatchObject({ size: 'M2', count: 2 });
  });

  it('確認方式 and 改用建議 confirm', () => {
    expect(onConfirm()).toEqual({ confirmed: true });
    const ws = twoBoxes({ joint: true });
    const top = recommendJoint(ws, 'joint-1', PROFILE)[0]!;
    expect(onRecommendation(top)).toEqual({ method: top.method, confirmed: true });
  });
});

describe('loadPrinterProfile and savePrinterProfile', () => {
  const fake = (value?: string) => ({ getItem: (key: string) => (key === PRINTER_STORAGE_KEY ? (value ?? null) : null) });

  it('uses the defaults when nothing is stored, the text is not JSON or the shape is wrong', () => {
    expect(loadPrinterProfile(fake())).toEqual(DEFAULT_PRINTER_PROFILE);
    expect(loadPrinterProfile(fake('not json'))).toEqual(DEFAULT_PRINTER_PROFILE);
    expect(loadPrinterProfile(fake('{"slidingFit":0.3}'))).toEqual(DEFAULT_PRINTER_PROFILE);
    expect(loadPrinterProfile(fake(JSON.stringify({ ...DEFAULT_PRINTER_PROFILE, extra: 1 })))).toEqual(DEFAULT_PRINTER_PROFILE);
    expect(loadPrinterProfile(null)).toEqual(DEFAULT_PRINTER_PROFILE);
    expect(loadPrinterProfile({ getItem: () => { throw new Error('blocked'); } })).toEqual(DEFAULT_PRINTER_PROFILE);
  });

  it('uses the defaults when a value is out of range', () => {
    expect(loadPrinterProfile(fake(JSON.stringify({ ...DEFAULT_PRINTER_PROFILE, slidingFit: 2 })))).toEqual(DEFAULT_PRINTER_PROFILE);
    expect(loadPrinterProfile(fake(JSON.stringify({ ...DEFAULT_PRINTER_PROFILE, pressFit: -0.1 })))).toEqual(DEFAULT_PRINTER_PROFILE);
  });

  it('keeps a valid stored profile and round-trips what it saves', () => {
    const profile = { slidingFit: 0.3, pressFit: 0.12, holeCompensation: 0.25, depthAllowance: 0.15, petgExtra: 0.08 };
    expect(loadPrinterProfile(fake(JSON.stringify(profile)))).toEqual(profile);
    const store = new Map<string, string>();
    savePrinterProfile({ setItem: (key, value) => { store.set(key, value); } }, profile);
    expect([...store.keys()]).toEqual(['forgehand.printer.v1']);
    expect(loadPrinterProfile({ getItem: key => store.get(key) ?? null })).toEqual(profile);
  });

  it('ignores a storage that refuses to write, and a missing one', () => {
    expect(() => savePrinterProfile({ setItem: () => { throw new Error('full'); } }, DEFAULT_PRINTER_PROFILE)).not.toThrow();
    expect(() => savePrinterProfile(null, DEFAULT_PRINTER_PROFILE)).not.toThrow();
  });
});

describe('joint marks', () => {
  const marksOf = (ws: Workspace, open: string | null = null) => computeMarks(ws, kitOf(ws), open);

  it('has one entry per joint side with the contact outline in the part frame', () => {
    const ws = updateJoint(twoBoxes({ joint: true }), 'joint-1', { method: screws() });
    const marks = marksOf(ws);
    expect(marks.map(item => [markId(item), item.objectId, item.partId, item.state])).toEqual([
      ['joint-1:a', 'a', 'body', 'ok'], ['joint-1:b', 'b', 'body', 'ok'],
    ]);
    // The contact region is the 20 × 30 mm overlap of the +x and -x faces.
    for (const item of marks) {
      expect(item.outline).toHaveLength(4);
      const xs = item.outline.map(point => point.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0, 6);
      expect(Math.abs(xs[0]!)).toBeCloseTo(BOX.x / 2, 6);
    }
    expect(marks[0]!.outline[0]!.x).toBeCloseTo(BOX.x / 2, 6);
    expect(marks[1]!.outline[0]!.x).toBeCloseTo(-BOX.x / 2, 6);
    expect(marks.every(item => item.features.length > 0)).toBe(true);
    expect(marks.flatMap(item => item.features.map(feature => feature.side))).toEqual([...marks[0]!.features.map(() => 'a'), ...marks[1]!.features.map(() => 'b')]);
  });

  it('follows rotated objects: the outline stays on the part\'s own face', () => {
    const ws = rotatedPair({ joint: true });
    for (const item of marksOf(ws)) {
      expect(item.outline).toHaveLength(4);
      expect(new Set(item.outline.map(point => Math.round(Math.abs(point.x) * 1e6))).size).toBe(1);
    }
  });

  it('marks an open card, and a joint with an error as a problem', () => {
    const ws = twoBoxes({ joint: true });
    expect(marksOf(ws, 'joint-1').map(item => item.state)).toEqual(['open', 'open']);
    const apart = demoPair({ joint: true });
    expect(marksOf(apart, 'joint-1').map(item => item.state)).toEqual(['problem', 'problem']);
  });

  it('draws the whole face of each side when the faces do not overlap, and nothing for a face that is gone', () => {
    const apart = demoPair({ joint: true });
    const outlines = jointOutlines(apart, apart.joints[0]!)!;
    expect(outlines.a.length).toBeGreaterThanOrEqual(3);
    expect(outlines.b.length).toBeGreaterThanOrEqual(3);
    const gone = { ...apart, joints: [{ ...apart.joints[0]!, a: { ...apart.joints[0]!.a, partId: 'missing' } }] };
    expect(computeMarks(gone, kitOf(apart), null)).toEqual([]);
  });

  it('builds one child per feature marker and ring, plus the outline', () => {
    const ws = updateJoint(twoBoxes({ joint: true }), 'joint-1', { method: screws() });
    const [first] = marksOf(ws);
    const group = buildPartMarks(first!);
    expect(group.name).toBe('joint-marks');
    expect(group.userData.jointMarks).toBe(true);
    expect(group.children).toHaveLength(1 + 2 * first!.features.length);
    expect(group.children.filter(child => child instanceof THREE.Mesh)).toHaveLength(first!.features.length);
    const caster = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
    expect(caster.intersectObject(group, true)).toEqual([]);
  });

  it('uses a dashed outline for a problem, a solid one otherwise, so colour never carries the state alone', () => {
    const base: PartMarks = {
      jointId: 'j', side: 'a', objectId: 'a', partId: 'body', features: [], state: 'ok',
      outline: [vec(0, 0, 0), vec(0.01, 0, 0), vec(0.01, 0.01, 0), vec(0, 0.01, 0)],
    };
    const line = (marks: PartMarks) => buildPartMarks(marks).children[0] as THREE.Line;
    expect(line(base).material).toBeInstanceOf(THREE.LineBasicMaterial);
    expect(line({ ...base, state: 'problem' }).material).toBeInstanceOf(THREE.LineDashedMaterial);
    expect(line({ ...base, state: 'open' }).material).toBeInstanceOf(THREE.LineBasicMaterial);
  });

  it('adds an inner outline and a fill for a glow, with no features', () => {
    const ws = demoPair();
    const glows = glowMarks(ws, { objectId: 'demo-a', partId: 'battery', face: '+x' }, { objectId: 'demo-b', partId: 'housing', face: '-x' });
    expect(glows.map(item => [markId(item), item.glow, item.features.length])).toEqual([['preview:a', true, 0], ['preview:b', true, 0]]);
    const group = buildPartMarks(glows[0]!);
    expect(group.children.filter(child => child instanceof THREE.Mesh)).toHaveLength(1);
    expect(group.children.filter(child => child instanceof THREE.Line)).toHaveLength(2);
  });

  it('has a stable key that changes exactly when the drawing would', () => {
    const ws = updateJoint(twoBoxes({ joint: true }), 'joint-1', { method: screws() });
    const [first] = marksOf(ws);
    expect(markKey(first!)).toBe(markKey(marksOf(ws)[0]!));
    expect(markKey({ ...first!, state: 'problem' })).not.toBe(markKey(first!));
    expect(markKey({ ...first!, features: first!.features.slice(1) })).not.toBe(markKey(first!));
    const more = updateJoint(ws, 'joint-1', { method: screws(1) });
    expect(markKey(marksOf(more)[0]!)).not.toBe(markKey(first!));
  });

  it('faceOutline gives four corners for a box and an ellipse for a cylinder cap', () => {
    const part = twoBoxes().objects[0]!.model.parts[0]!;
    expect(faceOutline(part, '+x')).toHaveLength(4);
    expect(faceOutline({ ...part, primitive: 'sphere' }, '+x')).toEqual([]);
    expect(faceOutline({ ...part, primitive: 'cylinder' }, '+y').length).toBeGreaterThan(8);
  });
});

describe('labels', () => {
  it('has the Traditional Chinese tables of the design', () => {
    expect(METHOD_LABELS).toEqual({ 'screw-insert': '熱壓螺母＋螺絲', magnet: '磁鐵', pin: '定位銷', glue: '膠合' });
    expect(MATERIAL_OPTIONS.map(option => option.label)).toEqual(['未指定', 'PLA', 'PETG', 'ABS', 'TPU', '尼龍', '樹脂', '鋁', '鋼']);
    expect(MATERIAL_OPTIONS[0]!.value).toBe('');
    expect(methodSummary({ kind: 'magnet', magnet: 'd6x3', count: 2 })).toBe('磁鐵 6×3 mm ×2');
    expect(JOINT_NOTICES.joined('甲・外殼', '乙・電池')).toBe('已接合「甲・外殼」與「乙・電池」，請確認固定方式。');
    expect(JOINT_NOTICES.assemblyMoved(2)).toBe('已調整物件位置（連同接合的 2 個物件），可按「復原」回到上一步。');
    expect(JOINT_NOTICES.cascade(1)).toBe('已一併移除 1 個接合。');
    expect(askAgentText('甲', '乙')).toBe('請幫我為接合「甲」↔「乙」選擇固定方式，先問我負重和拆裝需求。');
  });
});
