import { describe, expect, it } from 'vitest';
import { applyEditPlan, describeChanges, editConflicts, EditError, validateEditPlan, type EditPlan } from '../../shared/edit';
import { demoModel } from '../../shared/demo';
import { editJsonSchema } from '../../shared/schema';

const battery = demoModel.parts.find(part => part.id === 'battery')!;
const plan = (values: Partial<EditPlan>): EditPlan => ({ status: 'applied', explanation: '測試修改', operations: [], name: null, summary: null, assumptions: null, ...values });

describe('edit plans', () => {
  it('updates only the listed parts and keeps every other part identical', () => {
    const { model, changes } = applyEditPlan(demoModel, plan({ operations: [{ op: 'upsert', partId: 'battery', part: { ...battery, color: '#2563eb' } }] }));
    expect(changes).toEqual({ added: [], updated: ['battery'], removed: [], modelFields: false });
    expect(model.parts.find(part => part.id === 'battery')!.color).toBe('#2563eb');
    for (const part of demoModel.parts.filter(entry => entry.id !== 'battery')) expect(model.parts.find(entry => entry.id === part.id)).toEqual(part);
    expect(demoModel.parts.find(part => part.id === 'battery')!.color).toBe('#f27562');
  });

  it('adds and removes parts, and updates model fields only when given', () => {
    const cup = { ...battery, id: 'cup', name: '綠色杯子', parentId: null, primitive: 'tube' as const, color: '#22c55e' };
    const { model, changes } = applyEditPlan(demoModel, plan({ name: '雙鏡頭裝置與杯子',
      operations: [{ op: 'upsert', partId: 'cup', part: cup }, { op: 'remove', partId: 'board', part: null }] }));
    expect(changes).toMatchObject({ added: ['cup'], removed: ['board'], modelFields: true });
    expect(model.name).toBe('雙鏡頭裝置與杯子');
    expect(model.summary).toBe(demoModel.summary);
    expect(model.parts.map(part => part.id)).not.toContain('board');
    expect(describeChanges(demoModel, model, changes)).toBe('新增 綠色杯子；刪除 內部電路概念件；更新模型說明');
  });

  it('rejects removing a parent while its children remain, leaving the input untouched', () => {
    const before = JSON.stringify(demoModel);
    expect(() => applyEditPlan(demoModel, plan({ operations: [{ op: 'remove', partId: 'housing', part: null }] })))
      .toThrow(/依附在被刪除的零件上/);
    expect(JSON.stringify(demoModel)).toBe(before);
  });

  it('rejects malformed, duplicate, unknown and no-op operations', () => {
    expect(() => validateEditPlan(plan({ operations: [{ op: 'upsert', partId: 'battery', part: { ...battery, id: 'other' } }] }))).toThrow(EditError);
    expect(() => validateEditPlan(plan({ operations: [{ op: 'remove', partId: 'battery', part: null }, { op: 'remove', partId: 'battery', part: null }] }))).toThrow(/兩次/);
    expect(() => applyEditPlan(demoModel, plan({ operations: [{ op: 'remove', partId: 'missing', part: null }] }))).toThrow(/找不到/);
    expect(() => applyEditPlan(demoModel, plan({ operations: [{ op: 'upsert', partId: 'battery', part: battery }] }))).toThrow(/沒有改變/);
    expect(() => applyEditPlan(demoModel, plan({ operations: [{ op: 'upsert', partId: 'battery', part: { ...battery, parentId: 'ghost' } }] }))).toThrow(/未通過驗證/);
    expect(() => validateEditPlan(plan({ status: 'clarify', operations: [{ op: 'remove', partId: 'battery', part: null }] }))).toThrow(/不可附帶修改/);
  });

  it('detects conflicts with manual changes made after the request', () => {
    const moved = { ...demoModel, parts: demoModel.parts.map(part => part.id === 'battery' ? { ...part, position: { ...part.position, x: 0.12 } } : part) };
    const edit = plan({ operations: [{ op: 'upsert', partId: 'battery', part: { ...battery, color: '#000000' } }, { op: 'upsert', partId: 'board', part: { ...demoModel.parts.find(p => p.id === 'board')!, color: '#111111' } }] });
    expect(editConflicts(demoModel, moved, edit).map(part => part.id)).toEqual(['battery']);
    expect(editConflicts(demoModel, demoModel, edit)).toEqual([]);
    const deleted = { ...demoModel, parts: demoModel.parts.filter(part => part.id !== 'battery') };
    expect(editConflicts(demoModel, deleted, edit).map(part => part.id)).toEqual(['battery']);
  });

  it('exports a portable JSON schema with every property required', () => {
    const schema = editJsonSchema() as { $schema?: string; required: string[]; additionalProperties: boolean };
    expect(schema.$schema).toBeUndefined();
    expect(schema.required.sort()).toEqual(['assumptions', 'explanation', 'name', 'operations', 'status', 'summary']);
    expect(schema.additionalProperties).toBe(false);
  });
});
