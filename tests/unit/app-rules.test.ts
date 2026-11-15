import { describe, expect, it } from 'vitest';
import { validateModel, type ModelSpec } from '../../shared/model';
import { addObject, emptyWorkspace, selectParts, type SceneObject, type Workspace } from '../../shared/workspace';
import { canApplyEdit, pickPart, type EditMoment } from '../../src/workspace/app-rules';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
function boxModel(partIds: string[]): ModelSpec {
  return validateModel({
    schemaVersion: '1.0', name: 'Slab', summary: 'Boxes.', units: 'm', assumptions: [],
    parts: partIds.map((id, index) => ({
      id, name: id, parentId: null, primitive: 'box', dimensions: vec(2, 1, 4), position: vec(index * 0.01, 0, 0),
      rotation: vec(0, 0, 0), color: '#336699', role: 'exterior', tubeRatio: 0.3,
    })),
  });
}
const object = (id: string, partIds: string[]): SceneObject => ({
  id, model: boxModel(partIds), transform: { position: vec(0, 0, 0), rotation: vec(0, 0, 0) },
  source: 'test', providerModel: 'fake', edited: false, createdAt: '2026-11-20T08:00:00.000Z',
});
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

/** Objects `a` (parts p1, p2, p3) and `b` (parts q1, q2); `b` is active because it was added last. */
const twoObjects = (): Workspace => addObject(addObject(emptyWorkspace(), object('a', ['p1', 'p2', 'p3'])), object('b', ['q1', 'q2']));
/** The same, with `a` active and `parts` selected in it. */
const withSelection = (parts: string[]): Workspace => selectParts(twoObjects(), 'a', parts);

describe('pickPart', () => {
  it('selects only the clicked part of the active object', () => {
    const ws = withSelection(['p1', 'p2']);
    const next = pickPart(ws, 'a', 'p3', false);
    expect(next.activeObjectId).toBe('a');
    expect(next.selection).toEqual({ objectId: 'a', partIds: ['p3'] });
  });

  it('replaces a multi-selection with the clicked part when it is one of them', () => {
    const next = pickPart(withSelection(['p1', 'p2']), 'a', 'p2', false);
    expect(next.selection).toEqual({ objectId: 'a', partIds: ['p2'] });
  });

  it('keeps the same workspace when the only selected part is clicked again', () => {
    const ws = withSelection(['p2']);
    expect(pickPart(ws, 'a', 'p2', false)).toBe(ws);
  });

  it('adds a part with Shift', () => {
    const next = pickPart(withSelection(['p1']), 'a', 'p3', true);
    expect(next.selection).toEqual({ objectId: 'a', partIds: ['p1', 'p3'] });
  });

  it('starts a selection with Shift when nothing is selected', () => {
    const next = pickPart(twoObjects(), 'b', 'q1', true);
    expect(next.selection).toEqual({ objectId: 'b', partIds: ['q1'] });
  });

  it('removes a selected part with Shift and clears the selection when it was the last one', () => {
    const fewer = pickPart(withSelection(['p1', 'p3']), 'a', 'p1', true);
    expect(fewer.selection).toEqual({ objectId: 'a', partIds: ['p3'] });
    const none = pickPart(fewer, 'a', 'p3', true);
    expect(none.selection).toEqual({ objectId: null, partIds: [] });
    expect(none.activeObjectId).toBe('a');
  });

  it('activates another object and selects only that part without Shift', () => {
    const ws = withSelection(['p1', 'p2']);
    const next = pickPart(ws, 'b', 'q2', false);
    expect(next.activeObjectId).toBe('b');
    expect(next.selection).toEqual({ objectId: 'b', partIds: ['q2'] });
  });

  it('activates another object and selects only that part with Shift', () => {
    const ws = withSelection(['p1', 'p2']);
    const next = pickPart(ws, 'b', 'q1', true);
    expect(next.activeObjectId).toBe('b');
    expect(next.selection).toEqual({ objectId: 'b', partIds: ['q1'] });
  });

  it('resets explode when another object is activated', () => {
    const ws = { ...withSelection(['p1']), display: { explode: 0.5 } };
    expect(pickPart(ws, 'b', 'q1', false).display.explode).toBe(0);
  });

  it('clears the selection and keeps the active object on empty space without Shift', () => {
    const next = pickPart(withSelection(['p1', 'p2']), null, null, false);
    expect(next.activeObjectId).toBe('a');
    expect(next.selection).toEqual({ objectId: null, partIds: [] });
  });

  it('changes nothing on empty space with Shift', () => {
    const ws = withSelection(['p1', 'p2']);
    expect(pickPart(ws, null, null, true)).toBe(ws);
  });

  it('changes nothing on empty space when the selection is already empty', () => {
    const ws = twoObjects();
    expect(pickPart(ws, null, null, false)).toBe(ws);
  });

  it('changes nothing on empty space in an empty workspace', () => {
    const ws = emptyWorkspace();
    expect(pickPart(ws, null, null, false)).toBe(ws);
    expect(pickPart(ws, null, null, true)).toBe(ws);
  });

  it('ignores a click on an object or part that does not exist', () => {
    const ws = withSelection(['p1']);
    expect(pickPart(ws, 'gone', 'p1', false)).toBe(ws);
    expect(pickPart(ws, 'a', 'missing', false)).toBe(ws);
    expect(pickPart(ws, 'b', 'p1', false)).toBe(ws);
    expect(pickPart(emptyWorkspace(), 'a', 'p1', false)).toEqual(emptyWorkspace());
  });

  it('never mutates its input and keeps object references', () => {
    const ws = deepFreeze(withSelection(['p1', 'p2']));
    const cases: Array<[string | null, string | null, boolean]> = [
      ['a', 'p3', false], ['a', 'p1', true], ['a', 'p2', false], ['b', 'q1', false], ['b', 'q1', true], [null, null, false], [null, null, true],
    ];
    for (const [objectId, partId, additive] of cases) {
      const next = pickPart(ws, objectId, partId, additive);
      expect(next.objects).toBe(ws.objects);
    }
    expect(ws.selection).toEqual({ objectId: 'a', partIds: ['p1', 'p2'] });
    expect(ws.activeObjectId).toBe('a');
  });
});

describe('canApplyEdit', () => {
  const moments: EditMoment[] = ['answer', 'conflict'];
  const messages: Record<EditMoment, string> = {
    answer: '等待期間已換成另一個模型，這次修改沒有套用。',
    conflict: '目前顯示的已是另一個物件，這次 AI 修改沒有套用。',
  };

  it.each(moments)('accepts an edit for the active object (%s)', when => {
    expect(canApplyEdit(twoObjects(), 'b', when)).toEqual({ ok: true });
  });

  it.each(moments)('rejects an object that exists but is not active (%s)', when => {
    expect(canApplyEdit(twoObjects(), 'a', when)).toEqual({ ok: false, message: messages[when] });
  });

  it.each(moments)('rejects an object that was removed (%s)', when => {
    expect(canApplyEdit(twoObjects(), 'gone', when)).toEqual({ ok: false, message: messages[when] });
  });

  it.each(moments)('rejects any target in an empty workspace (%s)', when => {
    expect(canApplyEdit(emptyWorkspace(), 'a', when)).toEqual({ ok: false, message: messages[when] });
  });

  it('does not change the workspace', () => {
    const ws = deepFreeze(twoObjects());
    canApplyEdit(ws, 'a', 'answer');
    canApplyEdit(ws, 'b', 'conflict');
    expect(ws.activeObjectId).toBe('b');
  });
});
