import { describe, expect, it } from 'vitest';
import {
  ExportPlanError, ExportSummarySchema, MAX_SUMMARY_PROBLEMS, METHOD_KIND_LABELS, boughtRows, classifyPart, exportSummary,
  jointLabel, machinedRows, scopeWorkspace, stepNumbers,
} from '../../shared/export-plan';
import { jointFeatures } from '../../shared/features';
import type { FaceId, JointMethod } from '../../shared/joint';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import { WorkspaceError, addJoint, addObject, emptyWorkspace, setActiveObject, setMaterial, type Workspace } from '../../shared/workspace';
import {
  demoPairWithScrew, interiorPartWorkspace, metalPair, singleBox,
} from '../fixtures/export-workspace';
import { BOX, boxModel, fixtureJoint, fixtureModel, fixtureObject, fixturePart, side, twoBoxes } from '../fixtures/joint-workspace';

const PROFILE = DEFAULT_PRINTER_PROFILE;
const WHOLE = { scope: 'workspace', objectId: null } as const;
const ORIGIN = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };

describe('scopeWorkspace', () => {
  it('keeps every object and joint in workspace scope and resets the display state', () => {
    const ws = demoPairWithScrew();
    const scoped = scopeWorkspace({ ...ws, display: { explode: 0.5 }, selection: { objectId: 'demo-b', partIds: ['housing'] } }, WHOLE);
    expect(scoped.objects.map(object => object.id)).toEqual(['demo-a', 'demo-b']);
    expect(scoped.joints).toHaveLength(1);
    expect(scoped.selection).toEqual({ objectId: null, partIds: [] });
    expect(scoped.display.explode).toBe(0);
    expect(scoped.activeObjectId).toBe(ws.activeObjectId);
    // Objects keep their references, so the dialog can detect changes by reference.
    expect(scoped.objects[0]).toBe(ws.objects[0]);
    expect(scoped.joints[0]).toBe(ws.joints[0]);
  });

  it('keeps the assembly of an object, in workspace order, and drops what is not joined', () => {
    const base = twoBoxes({ joint: true });
    const ws = addObject(base, fixtureObject('c', boxModel('Block C'), ORIGIN));
    const fromB = scopeWorkspace(ws, { scope: 'assembly', objectId: 'b' });
    expect(fromB.objects.map(object => object.id)).toEqual(['a', 'b']);
    expect(fromB.joints).toHaveLength(1);
    // The active object (c) is not in the assembly, so the first kept object becomes active.
    expect(ws.activeObjectId).toBe('c');
    expect(fromB.activeObjectId).toBe('a');
    const fromC = scopeWorkspace(ws, { scope: 'assembly', objectId: 'c' });
    expect(fromC.objects.map(object => object.id)).toEqual(['c']);
    expect(fromC.joints).toEqual([]);
  });

  it('uses the active object when no object is named and keeps it when it is in scope', () => {
    const ws = setActiveObject(addObject(twoBoxes({ joint: true }), fixtureObject('c', boxModel('Block C'), ORIGIN)), 'b');
    const scoped = scopeWorkspace(ws, { scope: 'assembly', objectId: null });
    expect(scoped.objects.map(object => object.id)).toEqual(['a', 'b']);
    expect(scoped.activeObjectId).toBe('b');
  });

  it('keeps a joint between two parts of one object', () => {
    const model = fixtureModel('One', [fixturePart('left', 'box', BOX), { ...fixturePart('right', 'box', BOX), position: { x: BOX.x, y: 0, z: 0 } }]);
    const ws = addJoint(
      addObject(emptyWorkspace(), fixtureObject('one', model, ORIGIN)),
      fixtureJoint(side('one', 'left', '+x'), side('one', 'right', '-x')),
    );
    expect(scopeWorkspace(ws, { scope: 'assembly', objectId: 'one' }).joints).toHaveLength(1);
  });

  it('throws a fixed error for an unknown object and for an empty workspace', () => {
    expect(() => scopeWorkspace(twoBoxes(), { scope: 'assembly', objectId: 'nope' })).toThrow(WorkspaceError);
    try {
      scopeWorkspace(twoBoxes(), { scope: 'assembly', objectId: 'nope' });
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('UNKNOWN_OBJECT');
    }
    expect(() => scopeWorkspace(emptyWorkspace(), WHOLE)).toThrow(ExportPlanError);
    expect(() => scopeWorkspace(emptyWorkspace(), WHOLE)).toThrow('目前沒有模型，請先生成設計。');
  });
});

describe('classifyPart', () => {
  const exterior = { role: 'exterior' } as const;
  const interior = { role: 'interior' } as const;
  it('classifies by role and material (requirement 4)', () => {
    expect(classifyPart({ material: null }, exterior)).toBe('printed');
    expect(classifyPart({ material: 'pla' }, exterior)).toBe('printed');
    expect(classifyPart({ material: 'resin' }, exterior)).toBe('printed');
    expect(classifyPart({ material: 'aluminium' }, exterior)).toBe('machined');
    expect(classifyPart({ material: 'steel' }, exterior)).toBe('machined');
    expect(classifyPart({ material: null }, interior)).toBe('bought');
    expect(classifyPart({ material: 'steel' }, interior)).toBe('bought');
  });
});

describe('jointLabel and stepNumbers', () => {
  it('qualifies part names with the object name across objects only', () => {
    const cross = twoBoxes({ joint: true });
    expect(jointLabel(cross, cross.joints[0]!)).toBe('「Block A・body」↔「Block B・body」');
    const model = fixtureModel('One', [fixturePart('left', 'box', BOX), { ...fixturePart('right', 'box', BOX), position: { x: BOX.x, y: 0, z: 0 } }]);
    const joint = fixtureJoint(side('one', 'left', '+x'), side('one', 'right', '-x'));
    const inside = addJoint(addObject(emptyWorkspace(), fixtureObject('one', model, ORIGIN)), joint);
    expect(jointLabel(inside, inside.joints[0]!)).toBe('「left」↔「right」');
  });

  it('numbers joints by creation time, then id, from 1', () => {
    const ws = twoBoxes({ joint: true });
    const earlier = fixtureJoint(side('a', 'body', '+z'), side('b', 'body', '+z'), { id: 'joint-0', createdAt: '2026-11-19T08:00:00.000Z' });
    const same = fixtureJoint(side('a', 'body', '-z'), side('b', 'body', '-z'), { id: 'joint-2' });
    const steps = stepNumbers(addJoint(addJoint(ws, same), earlier), PROFILE);
    expect(steps.get('joint-0')).toBe(1);
    expect(steps.get('joint-1')).toBe(2);
    expect(steps.get('joint-2')).toBe(3);
  });

  it('has the four method labels of the joint card', () => {
    expect(METHOD_KIND_LABELS).toEqual({ 'screw-insert': '熱壓螺母＋螺絲', magnet: '磁鐵', pin: '定位銷', glue: '膠合' });
  });
});

describe('boughtRows', () => {
  it('groups interior parts by name, primitive and dimensions rounded to 0.1 mm', () => {
    const cell = (id: string, x: number, name = '電池') => ({ ...fixturePart(id, 'box', { x, y: 0.01, z: 0.02 }, { x: 0, y: 0, z: 0 }, 'interior'), name });
    const model = fixtureModel('Pack', [
      fixturePart('shell', 'box', BOX), cell('c1', 0.0300), cell('c2', 0.03004), cell('c3', 0.031), cell('c4', 0.03, '主板'),
    ]);
    const ws = addObject(emptyWorkspace(), fixtureObject('pack', model, ORIGIN));
    const rows = boughtRows(ws);
    expect(rows).toEqual([
      { name: '電池', objectNames: ['Pack'], sizeMm: { x: 30, y: 10, z: 20 }, count: 2 },
      { name: '電池', objectNames: ['Pack'], sizeMm: { x: 31, y: 10, z: 20 }, count: 1 },
      { name: '主板', objectNames: ['Pack'], sizeMm: { x: 30, y: 10, z: 20 }, count: 1 },
    ]);
  });

  it('lists each object once and counts across objects', () => {
    const ws = demoPairWithScrew();
    expect(boughtRows(ws)).toEqual([{ name: '內部電路概念件', objectNames: ['雙鏡頭概念裝置'], sizeMm: { x: 120, y: 4, z: 45 }, count: 2 }]);
    const mixed = addObject(ws, fixtureObject('other', fixtureModel('Other', [
      fixturePart('shell', 'box', BOX), { ...fixturePart('pcb', 'box', { x: 0.12, y: 0.004, z: 0.045 }, { x: 0, y: 0, z: 0 }, 'interior'), name: '內部電路概念件' },
    ]), ORIGIN));
    expect(boughtRows(mixed)).toEqual([{ name: '內部電路概念件', objectNames: ['雙鏡頭概念裝置', 'Other'], sizeMm: { x: 120, y: 4, z: 45 }, count: 3 }]);
  });

  it('has no row for a workspace without interior parts and ignores metal for the class', () => {
    expect(boughtRows(singleBox())).toEqual([]);
    expect(boughtRows(setMaterial(interiorPartWorkspace(), 'casing', 'steel'))).toEqual([
      { name: 'cell', objectNames: ['Casing'], sizeMm: { x: 40, y: 20, z: 20 }, count: 1 },
    ]);
  });
});

describe('machinedRows', () => {
  it('labels a tapped hole with its thread and counts it', () => {
    const ws = metalPair();
    expect(machinedRows(ws, jointFeatures(ws, PROFILE))).toEqual([
      { name: 'body', objectName: 'Block A', material: 'aluminium', sizeMm: { x: 40, y: 20, z: 30 }, features: ['M3 攻牙孔 ×2'] },
    ]);
  });

  it('labels drilled holes, magnet pockets and pin holes', () => {
    const metal = (method: JointMethod, face: [FaceId, FaceId] = ['+x', '-x']): string[] => {
      const base = setMaterial(twoBoxes(), 'a', 'steel');
      const ws = addJoint(base, { ...fixtureJoint(side('a', 'body', face[0]), side('b', 'body', face[1])), method });
      return machinedRows(ws, jointFeatures(ws, PROFILE))[0]!.features;
    };
    expect(metal({ kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'b' })).toEqual([expect.stringMatching(/^Ø\d+(\.\d+)? mm 通孔 ×1$/)]);
    expect(metal({ kind: 'magnet', magnet: 'd6x3', count: 1 })).toEqual(['Ø6×3 mm 磁鐵槽 ×1']);
    expect(metal({ kind: 'pin', pin: 'd3', count: 1, fit: 'press-both' })).toEqual(['Ø3 mm 銷孔 ×1']);
    expect(metal({ kind: 'glue', glue: 'epoxy' })).toEqual([]);
  });

  it('has no row for printed or bought parts', () => {
    expect(machinedRows(twoBoxes({ joint: true }), jointFeatures(twoBoxes({ joint: true }), PROFILE))).toEqual([]);
    const ws = setMaterial(interiorPartWorkspace(), 'casing', 'aluminium');
    expect(machinedRows(ws, jointFeatures(ws, PROFILE)).map(row => row.name)).toEqual(['shell']);
  });
});

describe('exportSummary', () => {
  it('summarises the demo pair with one screw joint', () => {
    const ws = demoPairWithScrew();
    const summary = exportSummary(ws, WHOLE, PROFILE);
    expect(ExportSummarySchema.parse(summary)).toEqual(summary);
    expect(summary.scope).toEqual(WHOLE);
    expect(summary.objects).toEqual([
      { objectId: 'demo-a', name: '雙鏡頭概念裝置', material: null, printed: 8, bought: 1, machined: 0 },
      { objectId: 'demo-b', name: '雙鏡頭概念裝置', material: null, printed: 8, bought: 1, machined: 0 },
    ]);
    expect(summary.standardParts).toEqual([
      { label: 'M3×8 內六角螺絲（ISO 4762）', quantity: 1 },
      { label: 'M3×5.7 熱壓螺母（CNC Kitchen）', quantity: 1 },
    ]);
    expect(summary.unconfirmed).toEqual([]);
    expect(summary.problems).toEqual([]);
    expect(summary.note).toBe('列印零件 16 個（相連的零件會合併成一個列印件，實際數量以匯出視窗為準）');
  });

  it('lists unconfirmed joints and the joint problems with the joint label', () => {
    const ws = demoPairWithScrew({ touching: false, confirmed: false });
    const summary = exportSummary(ws, WHOLE, PROFILE);
    expect(summary.unconfirmed).toEqual([
      { jointId: 'joint-1', label: '「雙鏡頭概念裝置・外殼」↔「雙鏡頭概念裝置・外殼」', method: '熱壓螺母＋螺絲' },
    ]);
    expect(summary.problems).toEqual([
      { severity: 'error', code: 'APART', message: '「雙鏡頭概念裝置・外殼」↔「雙鏡頭概念裝置・外殼」：已分開，可按「重新對齊」。' },
    ]);
  });

  it('follows the scope and leaves the workspace unchanged', () => {
    const ws = addObject(demoPairWithScrew(), fixtureObject('c', boxModel('Block C'), ORIGIN));
    const before = JSON.stringify(ws);
    const whole = exportSummary(ws, WHOLE, PROFILE);
    const assembly = exportSummary(ws, { scope: 'assembly', objectId: 'demo-b' }, PROFILE);
    expect(whole.objects.map(object => object.objectId)).toEqual(['demo-a', 'demo-b', 'c']);
    expect(assembly.objects.map(object => object.objectId)).toEqual(['demo-a', 'demo-b']);
    expect(assembly.scope).toEqual({ scope: 'assembly', objectId: 'demo-b' });
    expect(JSON.stringify(ws)).toBe(before);
  });

  it('counts metal parts as machined and reads the material', () => {
    const summary = exportSummary(metalPair(), WHOLE, PROFILE);
    expect(summary.objects).toEqual([
      { objectId: 'a', name: 'Block A', material: 'aluminium', printed: 0, bought: 0, machined: 1 },
      { objectId: 'b', name: 'Block B', material: null, printed: 1, bought: 0, machined: 0 },
    ]);
  });

  it('keeps at most 40 problems', () => {
    let ws: Workspace = setMaterial(twoBoxes(), 'a', 'aluminium');
    const faces: FaceId[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
    let count = 0;
    for (const fa of faces) {
      for (const fb of faces) {
        if (count === 32) break;
        ws = addJoint(ws, fixtureJoint(side('a', 'body', fa), side('b', 'body', fb), { id: `j${count++}` }));
      }
    }
    const summary = exportSummary(ws, WHOLE, PROFILE);
    expect(summary.problems).toHaveLength(MAX_SUMMARY_PROBLEMS);
    expect(ExportSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('throws for an empty workspace and an unknown object', () => {
    expect(() => exportSummary(emptyWorkspace(), WHOLE, PROFILE)).toThrow(ExportPlanError);
    expect(() => exportSummary(twoBoxes(), { scope: 'assembly', objectId: 'nope' }, PROFILE)).toThrow(WorkspaceError);
  });
});
