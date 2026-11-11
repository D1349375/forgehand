import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import { validateDesign, validateModel } from '../../shared/model';
import { designJsonSchema } from '../../shared/schema';

const copy = () => structuredClone(demoModel);

describe('model contract', () => {
  it('retains arbitrary named parts, dimensions, colors and parent relationships', () => {
    const model = validateModel(copy());
    expect(model.parts).toHaveLength(9);
    expect(model.parts.find(p => p.id === 'battery')).toMatchObject({ parentId: 'housing', color: '#f27562' });
    expect(model.parts.find(p => p.id === 'lens-1')?.primitive).toBe('tube');
  });
  it.each([
    ['negative dimension', (m: ReturnType<typeof copy>) => { m.parts[0]!.dimensions.x = -1; }],
    ['non-finite coordinate', (m: ReturnType<typeof copy>) => { m.parts[0]!.position.z = Infinity; }],
    ['unknown primitive', (m: ReturnType<typeof copy>) => { (m.parts[0] as unknown as { primitive: string }).primitive = 'script'; }],
    ['duplicate id', (m: ReturnType<typeof copy>) => { m.parts[1]!.id = m.parts[0]!.id; }],
    ['missing parent', (m: ReturnType<typeof copy>) => { m.parts[0]!.parentId = 'missing'; }],
    ['cycle', (m: ReturnType<typeof copy>) => { m.parts[0]!.parentId = 'lens-1'; }],
    ['self parent', (m: ReturnType<typeof copy>) => { m.parts[0]!.parentId = m.parts[0]!.id; }],
    ['invalid color', (m: ReturnType<typeof copy>) => { m.parts[0]!.color = 'red'; }],
    ['oversized model', (m: ReturnType<typeof copy>) => { m.parts = Array.from({ length: 65 }, (_, i) => ({ ...m.parts[0]!, id: `part-${i}` })); }],
  ])('rejects %s', (_name, mutate) => {
    const model = copy(); mutate(model);
    expect(() => validateModel(model)).toThrow();
  });
  it('rejects unrecognized fields rather than accepting generated code', () => {
    expect(() => validateModel({ ...copy(), script: 'alert(1)' })).toThrow();
  });
  it('requires a usable model for ready/approximation and none for unsupported', () => {
    expect(() => validateDesign({ status: 'ready', explanation: '完成', model: null })).toThrow();
    expect(() => validateDesign({ status: 'unsupported', explanation: '不支援', model: copy() })).toThrow();
    expect(validateDesign({ status: 'approximation', explanation: '請先確認近似範圍', model: copy() }).status).toBe('approximation');
  });
  it('converts the exact response contract using native Zod JSON schema', () => {
    const schema = designJsonSchema();
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(schema).not.toHaveProperty('$schema');
  });
});
