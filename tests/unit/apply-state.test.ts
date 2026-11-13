import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import { applyStateEvent } from '../../src/agent/apply-state';
import type { DisplayModel } from '../../src/agent/types';

const context = { requestId: 'run-9', now: 1234, newLineage: 'lineage-new' };
const current = (): DisplayModel => ({
  model: structuredClone(demoModel), source: 'codex', providerModel: 'old-model',
  requestId: 'run-1', startedAt: 10, lineage: 'lineage-old', edited: false,
});
const change = (over: Record<string, unknown> = {}) => ({ model: null, selection: null, explode: null, tryOn: null, ...over });
const modelChange = (kind: 'generated' | 'edited') =>
  ({ kind, model: { ...structuredClone(demoModel), name: '新的模型' }, source: 'claude', providerModel: 'new-model' });

describe('applyStateEvent', () => {
  it('generated: builds a commit argument with the new lineage and the supplied request id and time', () => {
    const effects = applyStateEvent(change({ model: modelChange('generated') }), current(), context);
    expect(effects.commitArg).toMatchObject({
      source: 'claude', providerModel: 'new-model', requestId: 'run-9', startedAt: 1234,
      lineage: 'lineage-new', edited: false,
    });
    expect(effects.commitArg!.model.name).toBe('新的模型');
    expect(effects).not.toHaveProperty('selection');
    expect(effects).not.toHaveProperty('explode');
    expect(effects).not.toHaveProperty('tryOn');
  });

  it('generated: works with no current model', () => {
    const effects = applyStateEvent(change({ model: modelChange('generated') }), null, context);
    expect(effects.commitArg?.lineage).toBe('lineage-new');
  });

  it('edited: keeps the current lineage, marks the model edited and replaces request id and time', () => {
    const before = current();
    const effects = applyStateEvent(change({ model: modelChange('edited'), selection: ['battery'] }), before, context);
    expect(effects.commitArg).toMatchObject({
      lineage: 'lineage-old', edited: true, requestId: 'run-9', startedAt: 1234,
      source: 'claude', providerModel: 'new-model',
    });
    expect(effects.commitArg!.model.name).toBe('新的模型');
    expect(effects.selection).toEqual(['battery']);
    expect(before.requestId).toBe('run-1'); // the current display is not mutated
    expect(before.model.name).toBe(demoModel.name);
  });

  it('edited with no current model: no commit argument, other fields still pass through', () => {
    const effects = applyStateEvent(change({ model: modelChange('edited'), explode: 0.4 }), null, context);
    expect(effects).toEqual({ explode: 0.4 });
  });

  it('passes through selection, explode and tryOn when present, including empty and zero values', () => {
    expect(applyStateEvent(change({ selection: ['housing', 'battery'] }), current(), context)).toEqual({ selection: ['housing', 'battery'] });
    expect(applyStateEvent(change({ selection: [] }), current(), context)).toEqual({ selection: [] });
    expect(applyStateEvent(change({ explode: 0 }), current(), context)).toEqual({ explode: 0 });
    expect(applyStateEvent(change({ tryOn: false }), current(), context)).toEqual({ tryOn: false });
    expect(applyStateEvent(change({ selection: ['a'], explode: 1, tryOn: true }), current(), context))
      .toEqual({ selection: ['a'], explode: 1, tryOn: true });
  });

  it('applies nothing when every field is null', () => {
    expect(applyStateEvent(change(), current(), context)).toEqual({});
  });

  it.each([
    ['null', null],
    ['a string', 'state'],
    ['an empty object', {}],
    ['an unknown field', change({ extra: 1 })],
    ['an explode value out of range', change({ explode: 2 })],
    ['a bad part id', change({ selection: ['not a valid id'] })],
    ['an unknown model kind', change({ model: { ...modelChange('generated'), kind: 'replaced' } })],
    ['a model that fails the schema', change({ model: { ...modelChange('generated'), model: { bad: true } } })],
  ])('returns nothing to apply for an invalid payload: %s', (_label, payload) => {
    expect(applyStateEvent(payload, current(), context)).toEqual({});
  });
});
