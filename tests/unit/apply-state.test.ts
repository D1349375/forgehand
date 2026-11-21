import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import { validateModel } from '../../shared/model';
import { activeObject, setActiveObject, type ObjectTransform, type SceneObject, type Workspace } from '../../shared/workspace';
import { applyStateEvent } from '../../src/agent/apply-state';
import { twoBoxes } from '../fixtures/joint-workspace';
import { sceneObject, workspaceOf } from './agent-fixtures';

const newModel = validateModel({ ...structuredClone(demoModel), name: '新的模型' });
const moved: ObjectTransform = { position: { x: 1.5, y: 0, z: -0.5 }, rotation: { x: 0, y: 45, z: 0 } };

/** A `state` event payload; every field is `null` unless given. */
const change = (over: Record<string, unknown> = {}) =>
  ({ activeObjectId: null, object: null, selection: null, explode: null, tryOn: null, ...over });

/** Objects `a` (active) and `b`. */
const twoObjects = () => workspaceOf(sceneObject('a'), sceneObject('b', demoModel, 2));

describe('applyStateEvent', () => {
  it('add: the workspace holds exactly the received object (same id, transform, createdAt) and the input is not touched', () => {
    const ws = twoObjects();
    const received: SceneObject = {
      ...sceneObject('from-server', newModel, 4), source: 'claude', providerModel: 'test-double', createdAt: '2026-11-21T09:30:00.000Z',
      transform: moved,
    };
    const effects = applyStateEvent(change({ object: { op: 'add', object: received } }), ws);
    expect(effects).not.toBeNull();
    const added = effects!.after.objects.at(-1)!;
    expect(added).toEqual(received);
    expect(added.id).toBe('from-server');
    expect(added.transform).toEqual(moved);
    expect(added.createdAt).toBe('2026-11-21T09:30:00.000Z');
    expect(effects!.after.objects).toHaveLength(3);
    expect(effects!.after.activeObjectId).toBe('from-server');
    expect(effects!.recordUndo).toBe(true);
    expect(ws.objects).toHaveLength(2); // the input workspace is not mutated
    expect(effects).not.toHaveProperty('tryOn');
  });

  it('add on an empty workspace works and records an undo step', () => {
    const effects = applyStateEvent(change({ object: { op: 'add', object: sceneObject('first', newModel) } }), workspaceOf());
    expect(effects!.after.objects.map(object => object.id)).toEqual(['first']);
    expect(effects!.before.objects).toEqual([]);
    expect(effects!.recordUndo).toBe(true);
  });

  it('recordUndo is true only with an object change', () => {
    const ws = twoObjects();
    const payloads: [string, Record<string, unknown>, boolean][] = [
      ['model', change({ object: { op: 'model', objectId: 'a', model: newModel, source: 'claude', providerModel: 'm' } }), true],
      ['transform', change({ object: { op: 'transform', objectId: 'a', transform: moved } }), true],
      ['remove', change({ object: { op: 'remove', objectId: 'b' } }), true],
      ['selection only', change({ selection: { objectId: 'a', partIds: ['housing'] } }), false],
      ['explode only', change({ explode: 0.5 }), false],
      ['activation only', change({ activeObjectId: 'b' }), false],
      ['tryOn only', change({ tryOn: true }), false],
      ['nothing', change(), false],
    ];
    for (const [label, payload, expected] of payloads) {
      expect(applyStateEvent(payload, ws)?.recordUndo, label).toBe(expected);
    }
  });

  it('a joint change records an undo step with and without an object change, a material change is one too', () => {
    const joined = twoBoxes({ joint: true });
    const unjoined = twoBoxes();
    const joint = joined.joints[0]!;
    const cases: [string, Workspace, Record<string, unknown>][] = [
      ['joint add', unjoined, change({ joint: { op: 'add', joint } })],
      ['joint update', joined, change({ joint: { op: 'update', joint: { ...joint, confirmed: true } } })],
      ['joint remove', joined, change({ joint: { op: 'remove', jointId: joint.id } })],
      ['transform with a joint add', unjoined, change({ object: { op: 'transform', objectId: 'b', transform: moved }, joint: { op: 'add', joint } })],
      ['material', joined, change({ object: { op: 'material', objectId: 'a', material: 'abs' } })],
    ];
    for (const [label, ws, payload] of cases) {
      const effects = applyStateEvent(payload, ws);
      expect(effects, label).not.toBeNull();
      expect(effects!.recordUndo, label).toBe(true);
    }
    expect(applyStateEvent(cases[0]![2], unjoined)!.after.joints).toEqual([joint]);
    expect(applyStateEvent(cases[2]![2], joined)!.after.joints).toEqual([]);
    expect(applyStateEvent(change({ joint: null }), joined)!.recordUndo).toBe(false);
  });

  it('an old payload without the joint key still parses and applies', () => {
    const old = { activeObjectId: null, object: { op: 'transform', objectId: 'a', transform: moved }, selection: null, explode: null, tryOn: null };
    const effects = applyStateEvent(old, twoObjects());
    expect(effects?.recordUndo).toBe(true);
    expect(effects!.after.objects[0]!.transform).toEqual(moved);
  });

  it('a joint change that the workspace rejects is dropped', () => {
    const joined = twoBoxes({ joint: true });
    expect(applyStateEvent(change({ joint: { op: 'remove', jointId: 'nope' } }), joined)).toBeNull();
    expect(applyStateEvent(change({ joint: { op: 'add', joint: joined.joints[0]! } }), joined)).toBeNull(); // the same sides twice
  });

  it('model: replaces the model and marks the object edited, leaving the other object alone', () => {
    const ws = twoObjects();
    const effects = applyStateEvent(change({ object: { op: 'model', objectId: 'a', model: newModel, source: 'claude', providerModel: 'new-model' } }), ws)!;
    const [a, b] = effects.after.objects;
    expect(a).toMatchObject({ id: 'a', source: 'claude', providerModel: 'new-model', edited: true });
    expect(a!.model.name).toBe('新的模型');
    expect(b).toBe(ws.objects[1]);
    expect(effects.before).toBe(ws);
  });

  it('an edit of a non-active object gives `before` with that object active', () => {
    const ws = twoObjects();
    expect(ws.activeObjectId).toBe('a');
    const effects = applyStateEvent(change({
      activeObjectId: 'b',
      object: { op: 'model', objectId: 'b', model: newModel, source: 'claude', providerModel: 'm' },
    }), ws)!;
    expect(effects.before.activeObjectId).toBe('b');
    expect(effects.before.objects).toEqual(setActiveObject(ws, 'b').objects);
    expect(effects.before.objects[1]!.model.name).toBe(demoModel.name); // before the edit
    expect(effects.after.activeObjectId).toBe('b');
    expect(effects.after.objects[1]!.model.name).toBe('新的模型');
    expect(effects.recordUndo).toBe(true);
    expect(activeObject(ws)!.id).toBe('a'); // the input is not mutated
  });

  it('selection, explode and tryOn only: no object changes, `before` is the input', () => {
    const ws = twoObjects();
    const selected = applyStateEvent(change({ selection: { objectId: 'a', partIds: ['housing', 'battery'] } }), ws)!;
    expect(selected.after.selection).toEqual({ objectId: 'a', partIds: ['housing', 'battery'] });
    expect(selected.after.objects).toBe(ws.objects);
    expect(selected.before).toBe(ws);
    expect(selected.recordUndo).toBe(false);

    const exploded = applyStateEvent(change({ explode: 0.4 }), ws)!;
    expect(exploded.after.display.explode).toBe(0.4);
    expect(exploded.after.objects).toBe(ws.objects);
    expect(exploded.recordUndo).toBe(false);

    expect(applyStateEvent(change({ tryOn: true }), ws)).toMatchObject({ tryOn: true, recordUndo: false });
    expect(applyStateEvent(change({ tryOn: false }), ws)).toMatchObject({ tryOn: false });
    const all = applyStateEvent(change({ selection: { objectId: 'a', partIds: [] }, explode: 1, tryOn: true }), ws)!;
    expect(all.after.display.explode).toBe(1);
    expect(all.tryOn).toBe(true);
  });

  it('a second event builds on the workspace the first one produced', () => {
    const first = applyStateEvent(change({ object: { op: 'add', object: sceneObject('n1', newModel) } }), workspaceOf())!;
    const second = applyStateEvent(change({ selection: { objectId: 'n1', partIds: ['housing'] }, explode: 0.5 }), first.after)!;
    expect(second.after.objects).toBe(first.after.objects);
    expect(second.after.selection.partIds).toEqual(['housing']);
  });

  it.each([
    ['null', null],
    ['a string', 'state'],
    ['an empty object', {}],
    ['an unknown field', change({ extra: 1 })],
    ['the old single-model shape', { model: null, selection: null, explode: null, tryOn: null }],
    ['an explode value out of range', change({ explode: 2 })],
    ['a bad object id', change({ activeObjectId: 'not a valid id' })],
    ['an unknown op', change({ object: { op: 'rename', objectId: 'a' } })],
    ['an add with an invalid object', change({ object: { op: 'add', object: { id: 'x' } } })],
    ['a model change that fails the schema', change({ object: { op: 'model', objectId: 'a', model: { bad: true }, source: 's', providerModel: 'm' } })],
  ])('returns null for an invalid payload: %s', (_label, payload) => {
    expect(applyStateEvent(payload, twoObjects())).toBeNull();
  });

  it.each([
    ['an unknown active object', change({ activeObjectId: 'nope' })],
    ['a model change for an unknown object', change({ object: { op: 'model', objectId: 'nope', model: newModel, source: 's', providerModel: 'm' } })],
    ['a remove of an unknown object', change({ object: { op: 'remove', objectId: 'nope' } })],
    ['an add with a duplicate id', change({ object: { op: 'add', object: sceneObject('a') } })],
    ['a selection of an unknown part', change({ selection: { objectId: 'a', partIds: ['no-such-part'] } })],
    ['a selection in an unknown object', change({ selection: { objectId: 'nope', partIds: [] } })],
    ['explode on an empty workspace', change({ explode: 0.5 })],
  ])('returns null when the workspace rejects the change: %s', (label, payload) => {
    const ws = label.includes('empty workspace') ? workspaceOf() : twoObjects();
    expect(applyStateEvent(payload, ws)).toBeNull();
  });

  it('returns null for an add past the object limit', () => {
    const full = workspaceOf(...Array.from({ length: 8 }, (_, i) => sceneObject(`o${i}`)));
    expect(applyStateEvent(change({ object: { op: 'add', object: sceneObject('ninth') } }), full)).toBeNull();
  });
});
