import { describe, expect, it } from 'vitest';
import { validateModel, type ModelSpec } from '../../shared/model';
import { addObject, emptyWorkspace, setActiveObject, WorkspaceError, type SceneObject, type Workspace } from '../../shared/workspace';
import { OBJECT_NAME_MAX, objectRows, renameObject } from '../../src/workspace/object-panel';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
function boxModel(name: string, partIds: string[]): ModelSpec {
  return validateModel({
    schemaVersion: '1.0', name, summary: 'Boxes.', units: 'm', assumptions: [],
    parts: partIds.map((id, index) => ({
      id, name: id, parentId: null, primitive: 'box', dimensions: vec(2, 1, 4), position: vec(index * 0.01, 0, 0),
      rotation: vec(0, 0, 0), color: '#336699', role: 'exterior', tubeRatio: 0.3,
    })),
  });
}
const object = (id: string, name: string, partIds: string[]): SceneObject => ({
  id, model: boxModel(name, partIds), transform: { position: vec(0, 0, 0), rotation: vec(0, 0, 0) },
  source: 'test', providerModel: 'fake', edited: false, material: null, createdAt: '2026-11-20T08:00:00.000Z',
});
/** Objects `a` (3 parts), `b` (2 parts), `c` (1 part) in creation order; `c` is active because it was added last. */
const three = (): Workspace => [object('a', 'Alpha', ['p1', 'p2', 'p3']), object('b', 'Beta', ['q1', 'q2']), object('c', 'Gamma', ['r1'])]
  .reduce(addObject, emptyWorkspace());

describe('objectRows', () => {
  it('lists the objects in creation order with name, part count and the active flag', () => {
    expect(objectRows(three())).toEqual([
      { id: 'a', name: 'Alpha', partCount: 3, active: false },
      { id: 'b', name: 'Beta', partCount: 2, active: false },
      { id: 'c', name: 'Gamma', partCount: 1, active: true },
    ]);
  });

  it('moves the active flag when another object is activated, without reordering', () => {
    const rows = objectRows(setActiveObject(three(), 'a'));
    expect(rows.map(row => row.id)).toEqual(['a', 'b', 'c']);
    expect(rows.map(row => row.active)).toEqual([true, false, false]);
  });

  it('is empty for an empty workspace', () => {
    expect(objectRows(emptyWorkspace())).toEqual([]);
  });
});

describe('renameObject', () => {
  it('trims the text and changes only model.name', () => {
    const before = three();
    const after = renameObject(before, 'b', '  新名稱  ');
    const renamed = after.objects.find(item => item.id === 'b')!;
    const original = before.objects.find(item => item.id === 'b')!;
    expect(renamed.model.name).toBe('新名稱');
    expect({ ...renamed.model, name: original.model.name }).toEqual(original.model);
    expect(renamed.transform).toBe(original.transform);
    expect(after.activeObjectId).toBe(before.activeObjectId);
    expect(after.objects.filter(item => item.id !== 'b')).toEqual(before.objects.filter(item => item.id !== 'b'));
    expect(before.objects.find(item => item.id === 'b')!.model.name).toBe('Beta');
  });

  it('rejects an empty or whitespace-only name with a Traditional Chinese message', () => {
    expect(() => renameObject(three(), 'a', '')).toThrow('物件名稱不能是空的。');
    expect(() => renameObject(three(), 'a', '  \t ')).toThrow('物件名稱不能是空的。');
  });

  it('rejects a name over 500 characters and accepts exactly 500', () => {
    expect(() => renameObject(three(), 'a', 'x'.repeat(OBJECT_NAME_MAX + 1))).toThrow('物件名稱最多 500 個字。');
    expect(renameObject(three(), 'a', 'x'.repeat(OBJECT_NAME_MAX)).objects[0]!.model.name).toHaveLength(OBJECT_NAME_MAX);
  });

  it('counts the length after trimming', () => {
    const padded = ` ${'x'.repeat(OBJECT_NAME_MAX)} `;
    expect(renameObject(three(), 'a', padded).objects[0]!.model.name).toHaveLength(OBJECT_NAME_MAX);
  });

  it('keeps the same workspace reference for an unchanged name, also after trimming', () => {
    const ws = three();
    expect(renameObject(ws, 'a', 'Alpha')).toBe(ws);
    expect(renameObject(ws, 'a', '  Alpha ')).toBe(ws);
  });

  it('throws for an unknown object', () => {
    expect(() => renameObject(three(), 'nope', 'X')).toThrow(WorkspaceError);
  });
});
