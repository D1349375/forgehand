import { describe, expect, it } from 'vitest';
import { jointFeatures } from '../../shared/features';
import type { Joint, JointMethod, JointNeeds } from '../../shared/joint';
import {
  checkJoints, FINDING_MESSAGES, FINDING_SEVERITY, newJoint, recommendFor, recommendJoint,
  type Finding, type FindingCode, type Recommendation,
} from '../../shared/joint-rules';
import { assemblyNotes, assemblyOf, jointBom } from '../../shared/kit';
import * as kit from '../../shared/kit';
import type { MaterialId } from '../../shared/materials';
import type { Part } from '../../shared/model';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import { addJoint, addObject, emptyWorkspace, WorkspaceError, type Workspace } from '../../shared/workspace';
import { CREATED_AT, fixtureJoint, fixtureModel, fixtureObject, fixturePart, side } from '../fixtures/joint-workspace';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const mm = (value: number) => value / 1000;
const profile = DEFAULT_PRINTER_PROFILE;
const ZERO = { position: vec(0, 0, 0), rotation: vec(0, 0, 0) };

const screw = (size: 'M2' | 'M3' = 'M3', count = 1, insertSide: 'a' | 'b' = 'a'): JointMethod => ({ kind: 'screw-insert', size, count, insertSide });
const magnet = (id: 'd6x3' | 'd10x3' = 'd6x3', count = 1): JointMethod => ({ kind: 'magnet', magnet: id, count });
const pin = (id: 'd2' | 'd3' | 'd4' = 'd3', count = 1, fit: 'press-both' | 'press-slide' = 'press-both'): JointMethod => ({ kind: 'pin', pin: id, count, fit });
const glue = (id: 'ca' | 'epoxy' | 'solvent' = 'ca'): JointMethod => ({ kind: 'glue', glue: id });

interface PairOptions {
  /** Thickness along x of a and b, mm. */
  aMm?: number;
  bMm?: number;
  /** Size of the contact faces, mm. */
  yMm?: number;
  zMm?: number;
  aRole?: Part['role'];
  bRole?: Part['role'];
  aMaterial?: MaterialId | null;
  bMaterial?: MaterialId | null;
  gapMm?: number;
  joint?: Partial<Joint>;
}

/**
 * Objects `obj-a` (錶殼, part 外殼) and `obj-b` (錶帶, part 扣環), one box each, touching along x.
 * Ids and names differ on purpose, so a message that leaks an id is caught.
 * Joint `joint-1`: a `+x` to b `-x`.
 */
function pair(method: JointMethod, options: PairOptions = {}): Workspace {
  const aMm = options.aMm ?? 40;
  const bMm = options.bMm ?? 40;
  const yMm = options.yMm ?? 20;
  const zMm = options.zMm ?? 30;
  const part = (thicknessMm: number, name: string, role: Part['role'] = 'exterior'): Part =>
    ({ ...fixturePart('body', 'box', vec(mm(thicknessMm), mm(yMm), mm(zMm)), vec(0, 0, 0), role), name });
  const a = { ...fixtureObject('obj-a', fixtureModel('錶殼', [part(aMm, '外殼', options.aRole)]), ZERO), material: options.aMaterial ?? null };
  const b = {
    ...fixtureObject('obj-b', fixtureModel('錶帶', [part(bMm, '扣環', options.bRole)]),
      { position: vec(mm(aMm / 2 + bMm / 2 + (options.gapMm ?? 0)), 0, 0), rotation: vec(0, 0, 0) }),
    material: options.bMaterial ?? null,
  };
  const joint = fixtureJoint(side('obj-a', 'body', '+x'), side('obj-b', 'body', '-x'), { method, ...options.joint });
  return addJoint(addObject(addObject(emptyWorkspace(), a), b), joint);
}

const findingsOf = (ws: Workspace, jointId = 'joint-1'): Finding[] => checkJoints(ws, profile).get(jointId)!;
const codesOf = (ws: Workspace, jointId = 'joint-1'): FindingCode[] => findingsOf(ws, jointId).map(finding => finding.code);
const messageOf = (ws: Workspace, code: FindingCode): string => findingsOf(ws).find(finding => finding.code === code)!.message;

const A = { a: side('obj-a', 'body', '+x'), b: side('obj-b', 'body', '-x') };
const UNKNOWN: JointNeeds = { load: null, disassembly: null };
const kinds = (recommendations: Recommendation[]) => recommendations.map(entry => entry.method.kind);
const of = (recommendations: Recommendation[], kind: JointMethod['kind']) => recommendations.find(entry => entry.method.kind === kind)!;

describe('finding messages', () => {
  it('has the fixed Traditional Chinese text and severity of design 6.1 for every code', () => {
    const params = { n: 2, item: '熱壓螺母', part: '外殼', material: '尼龍', glue: '瞬間膠', sameObject: false };
    const table: Record<FindingCode, [string, string]> = {
      APART: ['error', '已分開，可按「重新對齊」。'],
      NO_FACE: ['error', '接合面已不存在，請刪除這個接合。'],
      NO_ROOM: ['error', '接合面太小，放不下 2 個熱壓螺母。'],
      TOO_THIN: ['error', '「外殼」太薄，放不下熱壓螺母。'],
      NO_LENGTH: ['error', '沒有合適長度的標準熱壓螺母。'],
      OVERLAP: ['error', '與另一個接合的孔位重疊。'],
      COMPONENT_FEATURE: ['error', '「外殼」是外購件，無法加工熱壓螺母。'],
      GLUE_POOR: ['warning', '「尼龍」不易用瞬間膠黏合。'],
      SOLVENT_NOT_ABS: ['warning', '溶劑黏合只適用於兩側都是 ABS。'],
      METAL_GLUE: ['warning', '金屬與塑膠建議用螺絲或銷固定。'],
      INSERT_UNSUITABLE: ['warning', '「尼龍」不適合熱壓螺母。'],
      BOSS_COLLIDES: ['warning', '螺柱會碰到「外殼」。'],
      SAME_MATERIAL: ['info', '同材質接合最容易。'],
      NO_MATERIAL: ['info', '未指定材料，先以一般 FDM 塑膠估算。'],
      PETG_EXTRA: ['info', 'PETG 已加大配合間隙 2 mm。'],
      RESIN_PROFILE: ['info', '列印設定是依 FDM 調整的，樹脂列印請另行測試。'],
      MACHINED: ['info', '金屬零件需另行加工。'],
      BOSS_ADDED: ['info', '已在背面加上螺柱。'],
      THROUGH_HOLE: ['info', '螺絲孔貫穿到背面。'],
    };
    expect(Object.keys(FINDING_MESSAGES).sort()).toEqual(Object.keys(table).sort());
    for (const [code, [severity, text]] of Object.entries(table) as Array<[FindingCode, [string, string]]>) {
      expect(FINDING_SEVERITY[code]).toBe(severity);
      expect(FINDING_MESSAGES[code](params)).toBe(text);
    }
    expect(FINDING_MESSAGES.APART({ ...params, sameObject: true })).toBe('接合面已分開，請調整零件。');
  });
});

describe('checkJoints: every finding code from a built case', () => {
  it('APART: the faces no longer touch', () => {
    const ws = pair(glue(), { gapMm: 5 });
    expect(codesOf(ws)).toContain('APART');
    expect(messageOf(ws, 'APART')).toBe('已分開，可按「重新對齊」。');
  });

  it('APART inside one object asks to adjust the parts', () => {
    const parts = [
      { ...fixturePart('base', 'box', vec(0.04, 0.02, 0.03)), name: '座' },
      { ...fixturePart('lid', 'box', vec(0.04, 0.02, 0.03), vec(0.045, 0, 0)), name: '蓋' },
    ];
    const solo = fixtureObject('solo', fixtureModel('單件', parts), ZERO);
    const ws = addJoint(addObject(emptyWorkspace(), solo), fixtureJoint(side('solo', 'base', '+x'), side('solo', 'lid', '-x')));
    expect(messageOf(ws, 'APART')).toBe('接合面已分開，請調整零件。');
  });

  it('NO_FACE: a side is no longer a contact face; nothing else is reported', () => {
    const ws = pair(glue());
    const sphere = { ...fixturePart('body', 'sphere', vec(0.04, 0.04, 0.04)), name: '扣環' };
    const broken: Workspace = { ...ws, objects: ws.objects.map(object => (object.id === 'obj-b' ? { ...object, model: fixtureModel('錶帶', [sphere]) } : object)) };
    expect(findingsOf(broken)).toEqual([
      { jointId: 'joint-1', severity: 'error', code: 'NO_FACE', message: '接合面已不存在，請刪除這個接合。' },
    ]);
  });

  it('NO_ROOM: the features do not fit the contact region', () => {
    const ws = pair(screw('M3', 2), { yMm: 6, zMm: 6 });
    expect(messageOf(ws, 'NO_ROOM')).toBe('接合面太小，放不下 2 個熱壓螺母。');
  });

  it('TOO_THIN: a magnet pocket needs depth plus a floor', () => {
    const ws = pair(magnet('d6x3'), { aMm: 3 });
    expect(codesOf(ws)).toContain('TOO_THIN');
    expect(messageOf(ws, 'TOO_THIN')).toBe('「錶殼・外殼」太薄，放不下磁鐵。');
    expect(findingsOf(ws).filter(finding => finding.code === 'TOO_THIN')).toHaveLength(1);
  });

  it('NO_LENGTH: no standard pin is short enough', () => {
    const ws = pair(pin('d4'), { aMm: 3, bMm: 3 });
    expect(messageOf(ws, 'NO_LENGTH')).toBe('沒有合適長度的標準定位銷。');
  });

  it('OVERLAP: two joints put features on the same spot', () => {
    const third = { ...fixtureObject('obj-c', fixtureModel('錶扣', [{ ...fixturePart('body', 'box', vec(0.04, 0.02, 0.03)), name: '扣' }]),
      { position: vec(0.04, 0, 0), rotation: vec(0, 0, 0) }), material: null };
    const base = pair(screw('M3', 1));
    const ws = addJoint(addObject(base, third), fixtureJoint(side('obj-a', 'body', '+x'), side('obj-c', 'body', '-x'), { id: 'joint-2', method: screw('M3', 1) }));
    for (const id of ['joint-1', 'joint-2']) {
      expect(codesOf(ws, id)).toContain('OVERLAP');
      expect(findingsOf(ws, id).find(finding => finding.code === 'OVERLAP')!.message).toBe('與另一個接合的孔位重疊。');
    }
  });

  it('COMPONENT_FEATURE: a bought component cannot take a pocket', () => {
    const ws = pair(magnet(), { bRole: 'interior' });
    expect(messageOf(ws, 'COMPONENT_FEATURE')).toBe('「錶帶・扣環」是外購件，無法加工磁鐵。');
  });

  it('GLUE_POOR: a glue that bonds a side poorly', () => {
    const ws = pair(glue('ca'), { aMaterial: 'pla', bMaterial: 'nylon' });
    expect(messageOf(ws, 'GLUE_POOR')).toBe('「尼龍」不易用瞬間膠黏合。');
    expect(codesOf(pair(glue('ca'), { aMaterial: 'pla', bMaterial: 'pla' }))).not.toContain('GLUE_POOR');
  });

  it('SOLVENT_NOT_ABS: solvent glue needs ABS on both sides', () => {
    expect(messageOf(pair(glue('solvent'), { aMaterial: 'abs', bMaterial: 'pla' }), 'SOLVENT_NOT_ABS')).toBe('溶劑黏合只適用於兩側都是 ABS。');
    expect(codesOf(pair(glue('solvent'), { aMaterial: 'abs', bMaterial: 'abs' }))).not.toContain('SOLVENT_NOT_ABS');
    expect(codesOf(pair(glue('solvent')))).toContain('SOLVENT_NOT_ABS');
  });

  it('METAL_GLUE: glue as the only fixing between metal and plastic', () => {
    const ws = pair(glue('epoxy'), { aMaterial: 'aluminium', bMaterial: 'pla' });
    expect(messageOf(ws, 'METAL_GLUE')).toBe('金屬與塑膠建議用螺絲或銷固定。');
    expect(codesOf(pair(glue('epoxy'), { aMaterial: 'aluminium', bMaterial: 'steel' }))).not.toContain('METAL_GLUE');
    expect(codesOf(pair(magnet(), { aMaterial: 'aluminium', bMaterial: 'pla' }))).not.toContain('METAL_GLUE');
  });

  it('INSERT_UNSUITABLE: a heat-set insert in resin or TPU', () => {
    expect(messageOf(pair(screw(), { aMaterial: 'resin', bMaterial: 'pla' }), 'INSERT_UNSUITABLE')).toBe('「樹脂」不適合熱壓螺母。');
    expect(messageOf(pair(screw(), { aMaterial: 'tpu', bMaterial: 'pla' }), 'INSERT_UNSUITABLE')).toBe('「TPU」不適合熱壓螺母。');
    expect(codesOf(pair(screw(), { aMaterial: 'pla', bMaterial: 'tpu' }))).not.toContain('INSERT_UNSUITABLE');
    expect(codesOf(pair(screw(), { aMaterial: 'aluminium', bMaterial: 'pla' }))).not.toContain('INSERT_UNSUITABLE');
  });

  it('BOSS_COLLIDES: the boss runs into another part of the same object', () => {
    const plate = { ...fixturePart('body', 'box', vec(0.003, 0.02, 0.03)), name: '外殼' };
    // The boss grows 3.9 mm behind the plate (x from -1.5 to -5.4 mm); the blocker fills -5 to -2 mm.
    const blocker = { ...fixturePart('blocker', 'box', vec(0.003, 0.02, 0.03), vec(-0.0035, 0, 0)), name: '擋塊' };
    const a = fixtureObject('obj-a', fixtureModel('錶殼', [plate, blocker]), ZERO);
    const clear = fixtureObject('obj-a', fixtureModel('錶殼', [plate, { ...blocker, position: vec(-0.02, 0, 0) }]), ZERO);
    const b = fixtureObject('obj-b', fixtureModel('錶帶', [{ ...fixturePart('body', 'box', vec(0.04, 0.02, 0.03)), name: '扣環' }]), { position: vec(0.0215, 0, 0), rotation: vec(0, 0, 0) });
    const build = (first: typeof a) => addJoint(addObject(addObject(emptyWorkspace(), first), b), fixtureJoint(A.a, A.b, { method: screw('M3', 1) }));
    // The joint joins two objects, so the part is named with its object.
    expect(messageOf(build(a), 'BOSS_COLLIDES')).toBe('螺柱會碰到「錶殼・擋塊」。');
    expect(codesOf(build(clear))).not.toContain('BOSS_COLLIDES');
    expect(codesOf(build(clear))).toContain('BOSS_ADDED');
  });

  it('SAME_MATERIAL and NO_MATERIAL', () => {
    expect(codesOf(pair(glue(), { aMaterial: 'pla', bMaterial: 'pla' }))).toContain('SAME_MATERIAL');
    expect(codesOf(pair(glue(), { aMaterial: 'pla', bMaterial: 'petg' }))).not.toContain('SAME_MATERIAL');
    expect(codesOf(pair(glue(), { aMaterial: 'pla', bMaterial: null }))).not.toContain('SAME_MATERIAL');
    expect(messageOf(pair(glue(), { aMaterial: 'pla' }), 'NO_MATERIAL')).toBe('未指定材料，先以一般 FDM 塑膠估算。');
    expect(codesOf(pair(glue(), { aMaterial: 'pla', bMaterial: 'pla' }))).not.toContain('NO_MATERIAL');
  });

  it('PETG_EXTRA: only when a PETG part has a fit, and only with an allowance', () => {
    expect(messageOf(pair(magnet(), { aMaterial: 'petg', bMaterial: 'petg' }), 'PETG_EXTRA')).toBe('PETG 已加大配合間隙 0.05 mm。');
    expect(codesOf(pair(glue(), { aMaterial: 'petg', bMaterial: 'petg' }))).not.toContain('PETG_EXTRA');
    expect(codesOf(pair(magnet(), { aMaterial: 'pla', bMaterial: 'pla' }))).not.toContain('PETG_EXTRA');
    const none = checkJoints(pair(magnet(), { aMaterial: 'petg', bMaterial: 'petg' }), { ...profile, petgExtra: 0 }).get('joint-1')!;
    expect(none.map(finding => finding.code)).not.toContain('PETG_EXTRA');
  });

  it('RESIN_PROFILE', () => {
    expect(messageOf(pair(glue(), { aMaterial: 'resin', bMaterial: 'pla' }), 'RESIN_PROFILE')).toBe('列印設定是依 FDM 調整的，樹脂列印請另行測試。');
    expect(codesOf(pair(glue(), { aMaterial: 'pla', bMaterial: 'pla' }))).not.toContain('RESIN_PROFILE');
  });

  it('MACHINED: a metal side needs machining', () => {
    expect(messageOf(pair(screw('M3', 1, 'a'), { aMaterial: 'aluminium', bMaterial: 'pla' }), 'MACHINED')).toBe('金屬零件需另行加工。');
    expect(codesOf(pair(screw(), { aMaterial: 'pla', bMaterial: 'pla' }))).not.toContain('MACHINED');
  });

  it('BOSS_ADDED and THROUGH_HOLE: a thin insert side gets a boss and a through hole', () => {
    const thin = pair(screw('M3', 1), { aMm: 3 });
    expect(messageOf(thin, 'BOSS_ADDED')).toBe('已在背面加上螺柱。');
    expect(messageOf(thin, 'THROUGH_HOLE')).toBe('螺絲孔貫穿到背面。');
    const thick = pair(screw('M3', 1), { aMm: 40 });
    expect(codesOf(thick)).not.toContain('BOSS_ADDED');
    expect(codesOf(thick)).not.toContain('THROUGH_HOLE');
  });
});

describe('checkJoints: result shape', () => {
  it('has an entry for every joint and none for an empty workspace', () => {
    expect(checkJoints(emptyWorkspace(), profile).size).toBe(0);
    const ws = pair(glue(), { aMaterial: 'pla', bMaterial: 'pla' });
    expect([...checkJoints(ws, profile).keys()]).toEqual(['joint-1']);
  });

  it('sorts errors, then warnings, then infos, then by code', () => {
    // M3 x 2 on a 6 x 6 mm face does not fit (error); a resin insert side (warning, info); b has no material (info).
    const ws = pair(screw('M3', 2), { yMm: 6, zMm: 6, aMaterial: 'resin', bMaterial: null });
    expect(findingsOf(ws).map(finding => [finding.severity, finding.code])).toEqual([
      ['error', 'NO_ROOM'], ['warning', 'INSERT_UNSUITABLE'], ['info', 'NO_MATERIAL'], ['info', 'RESIN_PROFILE'],
    ]);
  });

  it('is stable: the same workspace gives the same findings, and no finding repeats', () => {
    const ws = pair(glue('ca'), { aMaterial: 'nylon', bMaterial: 'nylon' });
    expect(findingsOf(ws)).toEqual(findingsOf(ws));
    expect(findingsOf(ws).filter(finding => finding.code === 'GLUE_POOR')).toHaveLength(1);
  });

  it('never puts an id in a message', () => {
    const cases = [
      pair(glue(), { gapMm: 5, aMaterial: 'nylon', bMaterial: 'resin' }),
      pair(screw('M3', 2), { yMm: 6, zMm: 6, aMaterial: 'resin' }),
      pair(magnet(), { aMm: 3, bRole: 'interior' }),
      pair(pin('d4'), { aMm: 3, bMm: 3 }),
      pair(screw('M3', 1), { aMm: 3, aMaterial: 'petg' }),
    ];
    for (const ws of cases) {
      for (const finding of findingsOf(ws)) {
        for (const id of ['joint-1', 'obj-a', 'obj-b', 'body']) expect(finding.message).not.toContain(id);
        expect(finding.jointId).toBe('joint-1');
      }
    }
  });

  it('accepts precomputed features and gives the same result', () => {
    const ws = pair(magnet(), { aMaterial: 'petg', bMaterial: 'pla' });
    expect(checkJoints(ws, profile, jointFeatures(ws, profile))).toEqual(checkJoints(ws, profile));
  });

  it('does not block anything: every finding is advisory data', () => {
    const ws = pair(pin('d4'), { aMm: 3, bMm: 3 });
    expect(findingsOf(ws).some(finding => finding.severity === 'error')).toBe(true);
    expect(ws.joints).toHaveLength(1);
  });
});

describe('recommendFor: order by needs', () => {
  const ASSUMPTION = '尚未得知負重與拆裝需求，先假設中等負重、偶爾拆裝。';
  const table: Array<[NonNullable<JointNeeds['disassembly']>, NonNullable<JointNeeds['load']>, JointMethod['kind'][]]> = [
    ['often', 'light', ['magnet', 'screw-insert', 'pin', 'glue']],
    ['often', 'medium', ['screw-insert', 'magnet', 'pin', 'glue']],
    ['often', 'heavy', ['screw-insert', 'magnet', 'pin', 'glue']],
    ['sometimes', 'light', ['magnet', 'screw-insert', 'pin', 'glue']],
    ['sometimes', 'medium', ['screw-insert', 'pin', 'magnet', 'glue']],
    ['sometimes', 'heavy', ['screw-insert', 'pin', 'magnet', 'glue']],
    ['never', 'light', ['glue', 'pin', 'screw-insert', 'magnet']],
    ['never', 'medium', ['glue', 'pin', 'screw-insert', 'magnet']],
    ['never', 'heavy', ['screw-insert', 'glue', 'pin', 'magnet']],
  ];
  const ws = pair(glue(), { aMaterial: 'pla', bMaterial: 'pla' });
  for (const [disassembly, load, expected] of table) {
    it(`${disassembly} / ${load}: ${expected.join(', ')}`, () => {
      const recommendations = recommendFor(ws, A, { load, disassembly }, profile);
      expect(kinds(recommendations)).toEqual(expected);
      expect(recommendations.every(entry => entry.ok)).toBe(true);
      // Known needs: no assumption line.
      expect(recommendations.every(entry => !entry.reasons.includes(ASSUMPTION))).toBe(true);
    });
  }

  it('unknown needs assume a medium load and occasional disassembly, and say so first', () => {
    const recommendations = recommendFor(ws, A, UNKNOWN, profile);
    expect(kinds(recommendations)).toEqual(['screw-insert', 'pin', 'magnet', 'glue']);
    for (const entry of recommendations) expect(entry.reasons[0]).toBe(ASSUMPTION);
    expect(recommendations[0]!.reasons[1]).toBe('螺絲配熱壓螺母最牢固，也能重複拆裝。');
  });

  it('names only the unknown half when one of the needs is known', () => {
    expect(recommendFor(ws, A, { load: null, disassembly: 'often' }, profile)[0]!.reasons[0]).toBe('尚未得知負重需求，先假設中等負重。');
    expect(recommendFor(ws, A, { load: 'light', disassembly: null }, profile)[0]!.reasons[0]).toBe('尚未得知拆裝需求，先假設偶爾拆裝。');
    // Light load, occasional disassembly: magnets first.
    expect(kinds(recommendFor(ws, A, { load: 'light', disassembly: null }, profile))[0]).toBe('magnet');
  });

  it('gives one recommendation per kind with the reasons of design 6.2', () => {
    const recommendations = recommendFor(ws, A, { load: 'medium', disassembly: 'often' }, profile);
    expect(recommendations.map(entry => entry.reasons)).toEqual([
      ['螺絲配熱壓螺母最牢固，也能重複拆裝。'],
      ['磁鐵拆裝最方便，適合輕負重。'],
      ['定位銷對位準確，壓入後很牢固。', '一側滑配，可以拆開。'],
      ['膠合不需加工，但之後無法拆開。'],
    ]);
    // Taken apart "never": both sides press, so no slide line.
    const never = recommendFor(ws, A, { load: 'heavy', disassembly: 'never' }, profile);
    expect(of(never, 'pin').reasons).toEqual(['定位銷對位準確，壓入後很牢固。']);
    expect(of(never, 'pin').method).toMatchObject({ fit: 'press-both' });
    expect(of(recommendations, 'pin').method).toMatchObject({ fit: 'press-slide' });
  });
});

describe('recommendFor: variants fall back', () => {
  const known: JointNeeds = { load: 'medium', disassembly: 'often' };
  const top = (ws: Workspace, kind: JointMethod['kind'], needs = known) => of(recommendFor(ws, A, needs, profile), kind);

  it('uses the largest screw that fits, two of them when two fit', () => {
    expect(top(pair(glue()), 'screw-insert').method).toEqual({ kind: 'screw-insert', size: 'M3', count: 2, insertSide: 'a' });
    expect(top(pair(glue(), { yMm: 12, zMm: 12 }), 'screw-insert').method).toMatchObject({ size: 'M3', count: 1 });
  });

  it('small faces lose M3 and get M2, then lose screws altogether', () => {
    const small = top(pair(glue(), { yMm: 8, zMm: 8 }), 'screw-insert');
    expect(small.ok).toBe(true);
    expect(small.method).toMatchObject({ size: 'M2', count: 1 });
    const tiny = recommendFor(pair(glue(), { yMm: 6, zMm: 6 }), A, known, profile);
    expect(of(tiny, 'screw-insert').ok).toBe(false);
    expect(of(tiny, 'screw-insert').reasons).toEqual(['接合面太小，放不下 2 個熱壓螺母。']);
    // A kind without a valid variant goes last; here pins and glue still fit.
    expect(tiny.map(entry => entry.ok)).toEqual([true, true, false, false]);
    expect(kinds(tiny).slice(0, 2)).toEqual(['pin', 'glue']);
  });

  it('uses the largest magnet that fits', () => {
    expect(top(pair(glue()), 'magnet').method).toEqual({ kind: 'magnet', magnet: 'd10x3', count: 1 });
    expect(top(pair(glue(), { yMm: 12, zMm: 12 }), 'magnet').method).toMatchObject({ magnet: 'd8x3', count: 1 });
    expect(top(pair(glue(), { yMm: 9, zMm: 9 }), 'magnet').method).toMatchObject({ magnet: 'd6x3', count: 1 });
  });

  it('pins fall back to a smaller diameter when the parts are thin or small', () => {
    expect(top(pair(glue()), 'pin').method).toMatchObject({ pin: 'd4', count: 2 });
    expect(top(pair(glue(), { yMm: 7, zMm: 7 }), 'pin').method).toMatchObject({ pin: 'd3', count: 1 });
    expect(top(pair(glue(), { yMm: 6, zMm: 6 }), 'pin').method).toMatchObject({ pin: 'd2', count: 1 });
    const thin = top(pair(glue(), { aMm: 4, bMm: 4 }), 'pin');
    expect(thin.ok).toBe(false);
    expect(thin.reasons).toEqual(['沒有合適長度的標準定位銷。']);
  });

  it('a kind that cannot be made goes last, with the reason of its first variant', () => {
    // 3 mm plates: magnets and pins do not fit; screws (with a boss) and glue do.
    const needs: JointNeeds = { load: 'light', disassembly: 'often' };
    const thin = recommendFor(pair(glue(), { aMm: 3, bMm: 3 }), A, needs, profile);
    expect(kinds(thin)).toEqual(['screw-insert', 'glue', 'magnet', 'pin']);
    expect(thin.map(entry => entry.ok)).toEqual([true, true, false, false]);
    // The first magnet variant is two 10 mm magnets, which do not fit a 20 mm face.
    expect(of(thin, 'magnet').reasons[0]).toBe('接合面太小，放不下 2 個磁鐵。');
    // On a larger face the first variant fits the face and fails for the thickness.
    const wide = recommendFor(pair(glue(), { aMm: 3, bMm: 3, yMm: 30, zMm: 60 }), A, needs, profile);
    expect(of(wide, 'magnet').reasons[0]).toBe('「錶殼・外殼」太薄，放不下磁鐵。');
  });

  it('a joint whose faces are apart still gets recommendations', () => {
    const apart = recommendFor(pair(glue(), { gapMm: 5 }), A, known, profile);
    expect(apart.every(entry => entry.ok)).toBe(true);
  });

  it('every recommendation names a method that the feature rules accept', () => {
    const ws: Workspace = { ...pair(glue(), { aMaterial: 'pla', bMaterial: 'abs' }), joints: [] };
    for (const entry of recommendFor(ws, A, known, profile)) {
      const candidate = addJoint(ws, fixtureJoint(A.a, A.b, { id: 'candidate', method: entry.method }));
      const set = jointFeatures(candidate, profile).joints.get('candidate')!;
      expect(set.problems).toEqual([]);
    }
  });

  it('with missing faces every kind is unavailable', () => {
    const recommendations = recommendFor(pair(glue()), { a: side('obj-a', 'body', '+x'), b: side('obj-b', 'gone', '-x') }, known, profile);
    expect(recommendations).toHaveLength(4);
    expect(recommendations.every(entry => !entry.ok)).toBe(true);
    expect(recommendations[0]!.reasons).toEqual(['接合面已不存在，請刪除這個接合。']);
  });
});

describe('recommendFor: materials', () => {
  const never: JointNeeds = { load: 'light', disassembly: 'never' };
  // The metal part is 6 mm thick: a screw through a thicker metal part would need more than the longest standard length.
  const metalOnPlastic = (plasticSide: 'a' | 'b') => pair(glue(), {
    aMaterial: plasticSide === 'a' ? 'pla' : 'aluminium', bMaterial: plasticSide === 'a' ? 'aluminium' : 'pla',
    aMm: plasticSide === 'a' ? 40 : 6, bMm: plasticSide === 'a' ? 6 : 40,
  });

  it('metal to plastic never puts glue first and puts the insert on the plastic side', () => {
    for (const plastic of ['a', 'b'] as const) {
      const recommendations = recommendFor(metalOnPlastic(plastic), A, never, profile);
      expect(kinds(recommendations)).toEqual(['pin', 'screw-insert', 'magnet', 'glue']);
      expect(of(recommendations, 'screw-insert').method).toMatchObject({ insertSide: plastic });
      expect(of(recommendations, 'glue').reasons).toContain('金屬與塑膠建議用螺絲或銷固定。');
      expect(of(recommendations, 'screw-insert').reasons).not.toContain('金屬側使用攻牙孔，不需熱壓螺母。');
    }
    // Plastic to plastic with the same needs keeps glue first.
    expect(kinds(recommendFor(pair(glue(), { aMaterial: 'pla', bMaterial: 'pla' }), A, never, profile))[0]).toBe('glue');
  });

  it('metal to metal tap the insert side and say so', () => {
    const recommendations = recommendFor(pair(glue(), { aMaterial: 'aluminium', bMaterial: 'steel', bMm: 6 }), A, { load: 'heavy', disassembly: 'often' }, profile);
    const screws = of(recommendations, 'screw-insert');
    expect(screws.ok).toBe(true);
    expect(screws.reasons).toEqual(['螺絲配熱壓螺母最牢固，也能重複拆裝。', '金屬側使用攻牙孔，不需熱壓螺母。']);
    expect(kinds(recommendations)).toEqual(['screw-insert', 'magnet', 'pin', 'glue']);
  });

  it('TPU and resin never get the insert', () => {
    for (const material of ['tpu', 'resin'] as const) {
      const label = material === 'tpu' ? 'TPU' : '樹脂';
      // One side printed in a suitable material: the insert goes there, whichever side the other is on.
      expect(of(recommendFor(pair(glue(), { aMaterial: material, bMaterial: 'pla' }), A, known(), profile), 'screw-insert').method).toMatchObject({ insertSide: 'b' });
      expect(of(recommendFor(pair(glue(), { aMaterial: 'pla', bMaterial: material }), A, known(), profile), 'screw-insert').method).toMatchObject({ insertSide: 'a' });
      // Both sides unsuitable: screws are unavailable and go last.
      const both = recommendFor(pair(glue(), { aMaterial: material, bMaterial: material }), A, { load: 'heavy', disassembly: 'often' }, profile);
      expect(of(both, 'screw-insert').ok).toBe(false);
      expect(of(both, 'screw-insert').reasons).toEqual([`「${label}」不適合熱壓螺母，改用其他方式。`]);
      expect(kinds(both)[3]).toBe('screw-insert');
    }
    function known(): JointNeeds { return { load: 'heavy', disassembly: 'often' }; }
  });

  it('puts the insert on the thicker printed side, and never on a component', () => {
    expect(of(recommendFor(pair(glue(), { aMm: 20, bMm: 40 }), A, { load: 'heavy', disassembly: 'often' }, profile), 'screw-insert').method)
      .toMatchObject({ insertSide: 'b' });
    expect(of(recommendFor(pair(glue(), { aMm: 40, bMm: 20 }), A, { load: 'heavy', disassembly: 'often' }, profile), 'screw-insert').method)
      .toMatchObject({ insertSide: 'a' });
    const component = recommendFor(pair(glue(), { aRole: 'interior', bMm: 8 }), A, { load: 'heavy', disassembly: 'often' }, profile);
    expect(of(component, 'screw-insert').method).toMatchObject({ insertSide: 'b' });
    const both = recommendFor(pair(glue(), { aRole: 'interior', bRole: 'interior' }), A, { load: 'heavy', disassembly: 'often' }, profile);
    expect(of(both, 'screw-insert').ok).toBe(false);
    expect(of(both, 'screw-insert').reasons).toEqual(['「錶殼・外殼」是外購件，無法加工熱壓螺母。']);
    // A component never takes a magnet or a pin either.
    expect(of(component, 'magnet').ok).toBe(false);
    expect(of(component, 'pin').ok).toBe(false);
  });

  it('chooses the glue by material: solvent only for ABS to ABS', () => {
    const glueFor = (a: MaterialId | null, b: MaterialId | null) =>
      of(recommendFor(pair(magnet(), { aMaterial: a, bMaterial: b }), A, never, profile), 'glue').method;
    expect(glueFor('abs', 'abs')).toEqual({ kind: 'glue', glue: 'solvent' });
    expect(glueFor('abs', 'pla')).toEqual({ kind: 'glue', glue: 'ca' });
    expect(glueFor('pla', 'pla')).toEqual({ kind: 'glue', glue: 'ca' });
    expect(glueFor(null, null)).toEqual({ kind: 'glue', glue: 'ca' });
    // The glue with the better worse side: nylon bonds CA poorly and epoxy fairly; PETG bonds CA fairly and epoxy well.
    expect(glueFor('nylon', 'pla')).toEqual({ kind: 'glue', glue: 'epoxy' });
    expect(glueFor('petg', 'pla')).toEqual({ kind: 'glue', glue: 'epoxy' });
    expect(glueFor('aluminium', 'pla')).toEqual({ kind: 'glue', glue: 'epoxy' });
  });

  it('glue that bonds a side poorly goes behind pins', () => {
    // TPU bonds epoxy poorly and nylon bonds CA poorly, so both glues are poor for this pair.
    const ws = pair(magnet(), { aMaterial: 'tpu', bMaterial: 'nylon' });
    const recommendations = recommendFor(ws, A, never, profile);
    expect(kinds(recommendations)).toEqual(['pin', 'glue', 'screw-insert', 'magnet']);
    expect(of(recommendations, 'screw-insert').method).toMatchObject({ insertSide: 'b' });
  });

  it('leaves the joint being re-planned out of the overlap test', () => {
    const ws = pair(screw('M3', 2));
    // The existing joint has the holes that two M3 screws would need, so those collide with it; one screw (at the centre) does not.
    expect(of(recommendFor(ws, A, known(), profile), 'screw-insert').method).toMatchObject({ size: 'M3', count: 1 });
    expect(of(recommendFor(ws, A, known(), profile, 'joint-1'), 'screw-insert').method).toMatchObject({ size: 'M3', count: 2 });
    expect(of(recommendJoint(ws, 'joint-1', profile), 'screw-insert').method).toMatchObject({ size: 'M3', count: 2 });
    function known(): JointNeeds { return { load: 'heavy', disassembly: 'often' }; }
  });
});

describe('recommendJoint and newJoint', () => {
  it('recommendJoint uses the needs of the joint and rejects an unknown id', () => {
    const light = pair(glue(), { joint: { needs: { load: 'light', disassembly: 'often' } } });
    expect(kinds(recommendJoint(light, 'joint-1', profile))[0]).toBe('magnet');
    const never = pair(glue(), { joint: { needs: { load: 'heavy', disassembly: 'never' } } });
    expect(kinds(recommendJoint(never, 'joint-1', profile))[0]).toBe('screw-insert');
    expect(() => recommendJoint(light, 'nope', profile)).toThrowError(WorkspaceError);
    try {
      recommendJoint(light, 'nope', profile);
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('UNKNOWN_JOINT');
    }
  });

  it('newJoint takes the top recommendation, unconfirmed, with unknown needs', () => {
    const ws = pair(glue(), { aMaterial: 'pla', bMaterial: 'pla' });
    const input = { id: 'joint-new', createdAt: CREATED_AT, a: A.a, b: A.b };
    const joint = newJoint(ws, input, profile);
    expect(joint).toEqual({
      id: 'joint-new', a: A.a, b: A.b, method: recommendFor(ws, A, UNKNOWN, profile)[0]!.method,
      needs: { load: null, disassembly: null }, confirmed: false, createdAt: CREATED_AT,
    });
    expect(joint.method).toEqual({ kind: 'screw-insert', size: 'M3', count: 2, insertSide: 'a' });
    // The joint is valid workspace data.
    expect(() => addJoint({ ...ws, joints: [] }, joint)).not.toThrow();
  });

  it('newJoint uses glue when nothing else is possible', () => {
    const ws = pair(glue(), { yMm: 3, zMm: 3 });
    expect(newJoint(ws, { id: 'j', createdAt: CREATED_AT, a: A.a, b: A.b }, profile).method).toEqual({ kind: 'glue', glue: 'ca' });
  });
});

interface ChainObject { mm?: number; role?: Part['role']; material?: MaterialId | null }

/**
 * Objects 物件1, 物件2, ... in a row along x (each 20 x 30 mm in section), each touching the next. Joint
 * `joint-N` joins object N (+x) to object N+1 (-x), so no face carries two joints. Part 外殼 in every object.
 */
function chain(methods: JointMethod[], objects: ChainObject[] = [], overrides: Array<Partial<Joint>> = []): Workspace {
  let ws = emptyWorkspace();
  let edge = 0;
  for (let index = 0; index <= methods.length; index++) {
    const spec = objects[index] ?? {};
    const thickness = spec.mm ?? 40;
    const part = { ...fixturePart('body', 'box', vec(mm(thickness), 0.02, 0.03), vec(0, 0, 0), spec.role ?? 'exterior'), name: '外殼' };
    const object = { ...fixtureObject(`obj-${index + 1}`, fixtureModel(`物件${index + 1}`, [part]), { position: vec(mm(edge + thickness / 2), 0, 0), rotation: vec(0, 0, 0) }), material: spec.material ?? null };
    ws = addObject(ws, object);
    edge += thickness;
  }
  methods.forEach((method, index) => {
    ws = addJoint(ws, fixtureJoint(side(`obj-${index + 1}`, 'body', '+x'), side(`obj-${index + 2}`, 'body', '-x'), { id: `joint-${index + 1}`, method, ...overrides[index] }));
  });
  return ws;
}

describe('jointBom', () => {
  it('aggregates across joints: two joints of M3 x 8 are one item of 4', () => {
    const ws = chain([screw('M3', 2), screw('M3', 2)]);
    expect(jointBom(ws, profile)).toEqual([
      { kind: 'screw', standardId: 'M3x8', label: 'M3×8 內六角螺絲（ISO 4762）', quantity: 4, jointIds: ['joint-1', 'joint-2'] },
      { kind: 'insert', standardId: 'M3x5.7', label: 'M3×5.7 熱壓螺母（CNC Kitchen）', quantity: 4, jointIds: ['joint-1', 'joint-2'] },
    ]);
  });

  it('counts a magnet on each side of every position', () => {
    const ws = chain([magnet('d6x3', 2)]);
    expect(jointBom(ws, profile)).toEqual([
      { kind: 'magnet', standardId: 'd6x3', label: '6×3 mm 圓形釹磁鐵', quantity: 4, jointIds: ['joint-1'] },
    ]);
    expect(jointBom(chain([magnet('d10x3', 1)]), profile)[0]).toMatchObject({ standardId: 'd10x3', label: '10×3 mm 圓形釹磁鐵', quantity: 2 });
  });

  it('lists pins by diameter and length, one per position', () => {
    const ws = chain([pin('d3', 2)], [{ mm: 7 }, { mm: 7 }]);
    expect(jointBom(ws, profile)).toEqual([
      { kind: 'pin', standardId: 'd3x10', label: 'Ø3×10 mm 定位銷（ISO 8734）', quantity: 2, jointIds: ['joint-1'] },
    ]);
  });

  it('lists one item per glue type with quantity 1', () => {
    const ws = chain([glue('ca'), glue('epoxy'), glue('ca'), glue('solvent')]);
    expect(jointBom(ws, profile)).toEqual([
      { kind: 'glue', standardId: 'ca', label: '瞬間膠（CA）', quantity: 1, jointIds: ['joint-1', 'joint-3'] },
      { kind: 'glue', standardId: 'epoxy', label: 'AB 膠（環氧樹脂）', quantity: 1, jointIds: ['joint-2'] },
      { kind: 'glue', standardId: 'solvent', label: '溶劑（ABS 用，例如丙酮）', quantity: 1, jointIds: ['joint-4'] },
    ]);
  });

  it('orders screws, inserts, magnets, pins, glue, then by size', () => {
    const ws = chain([glue('epoxy'), pin('d3', 1), magnet('d10x3', 1), screw('M3', 1), screw('M2', 1)]);
    expect(jointBom(ws, profile).map(item => `${item.kind}:${item.standardId}`)).toEqual([
      'screw:M2x5', 'screw:M3x8', 'insert:M2x3', 'insert:M3x5.7', 'magnet:d10x3', 'pin:d3x20', 'glue:epoxy',
    ]);
    const sizes = chain([magnet('d10x3', 1), magnet('d6x3', 1), magnet('d10x3', 1)]);
    expect(jointBom(sizes, profile).map(item => [item.standardId, item.quantity])).toEqual([['d6x3', 2], ['d10x3', 4]]);
  });

  it('leaves out inserts for a metal side and screws that have no length', () => {
    // Metal insert side: a tapped hole, no insert in the BOM.
    const metal = chain([screw('M3', 1, 'a')], [{ mm: 6, material: 'aluminium' }, { material: 'pla' }]);
    expect(jointBom(metal, profile).map(item => item.kind)).toEqual(['screw']);
    // A 40 mm component on the screw side: no standard screw is long enough, so no screw item (and the finding says why).
    const noLength = chain([screw('M3', 1, 'a')], [{}, { role: 'interior' }]);
    expect(codesOf(noLength)).toContain('NO_LENGTH');
    expect(jointBom(noLength, profile).map(item => item.kind)).toEqual(['insert']);
  });

  it('has no item for a joint that does not fit, and no items without joints', () => {
    expect(jointBom(emptyWorkspace(), profile)).toEqual([]);
    expect(jointBom(pair(screw('M3', 2), { yMm: 6, zMm: 6 }), profile)).toEqual([]);
    expect(jointBom(pair(magnet('d6x3', 1), { yMm: 3, zMm: 3 }), profile)).toEqual([]);
  });

  it('accepts precomputed features and gives the same result', () => {
    const ws = chain([screw('M3', 2), magnet('d6x3', 1)]);
    expect(jointBom(ws, profile, jointFeatures(ws, profile))).toEqual(jointBom(ws, profile));
  });
});

describe('assemblyNotes', () => {
  const textOf = (ws: Workspace) => assemblyNotes(ws, profile).map(note => note.text);

  it('screws with inserts in a printed part', () => {
    expect(textOf(chain([screw('M3', 2, 'a')]))).toEqual([
      '先用烙鐵把 2 顆 M3 熱壓螺母壓入「物件1・外殼」，再用 2 支 M3×8 螺絲從「物件2・外殼」鎖上。',
    ]);
    expect(textOf(chain([screw('M3', 1, 'b')]))).toEqual([
      '先用烙鐵把 1 顆 M3 熱壓螺母壓入「物件2・外殼」，再用 1 支 M3×8 螺絲從「物件1・外殼」鎖上。',
    ]);
    expect(textOf(chain([screw('M2', 1, 'a')]))[0]).toBe('先用烙鐵把 1 顆 M2 熱壓螺母壓入「物件1・外殼」，再用 1 支 M2×5 螺絲從「物件2・外殼」鎖上。');
  });

  it('screws into a metal part', () => {
    expect(textOf(chain([screw('M3', 2, 'a')], [{ mm: 6, material: 'aluminium' }, {}]))).toEqual([
      '用 2 支 M3×8 螺絲從「物件2・外殼」鎖入「物件1・外殼」的 M3 螺紋孔（需先攻牙）。',
    ]);
  });

  it('screws through a component', () => {
    expect(textOf(chain([screw('M3', 2, 'a')], [{}, { role: 'interior', mm: 2 }]))).toEqual([
      '先用烙鐵把 2 顆 M3 熱壓螺母壓入「物件1・外殼」，再用 2 支 M3×8 螺絲穿過「物件2・外殼」原有的孔鎖上。',
    ]);
  });

  it('magnets, pins and glue', () => {
    expect(textOf(chain([magnet('d6x3', 2)]))).toEqual([
      '把 4 顆 6×3 mm 磁鐵壓入「物件1・外殼」與「物件2・外殼」的孔位，壓入前先確認兩側磁極相吸。',
    ]);
    expect(textOf(chain([pin('d3', 1, 'press-both')], [{ mm: 7 }, { mm: 7 }]))).toEqual([
      '把 1 支 Ø3×10 mm 定位銷壓入「物件1・外殼」，再對準「物件2・外殼」壓合。',
    ]);
    expect(textOf(chain([pin('d3', 2, 'press-slide')], [{ mm: 7 }, { mm: 7 }]))).toEqual([
      '把 2 支 Ø3×10 mm 定位銷壓入「物件1・外殼」，再把「物件2・外殼」套上；這一側是滑配，可以拆開。',
    ]);
    expect(textOf(chain([glue('ca')]))).toEqual(['在「物件1・外殼」與「物件2・外殼」的接觸面塗上瞬間膠，對準後壓緊直到固化。']);
    expect(textOf(chain([glue('epoxy')]))[0]).toContain('塗上AB 膠，');
    expect(textOf(chain([glue('solvent')]))[0]).toContain('塗上溶劑，');
  });

  it('names parts without the object when the joint is inside one object', () => {
    const parts = [
      { ...fixturePart('base', 'box', vec(0.04, 0.02, 0.03)), name: '座' },
      { ...fixturePart('lid', 'box', vec(0.04, 0.02, 0.03), vec(0.04, 0, 0)), name: '蓋' },
    ];
    const solo = fixtureObject('solo', fixtureModel('單件', parts), ZERO);
    const ws = addJoint(addObject(emptyWorkspace(), solo), fixtureJoint(side('solo', 'base', '+x'), side('solo', 'lid', '-x'), { method: glue('ca') }));
    expect(textOf(ws)).toEqual(['在「座」與「蓋」的接觸面塗上瞬間膠，對準後壓緊直到固化。']);
  });

  it('orders joints by creation time, then id, and tells which joint each note is for', () => {
    const methods = [glue('ca'), glue('epoxy'), glue('solvent')];
    const ws = chain(methods, [], [
      { id: 'zeta', createdAt: '2026-11-20T08:00:00.000Z' },
      { id: 'beta', createdAt: '2026-11-20T09:00:00.000Z' },
      { id: 'alpha', createdAt: '2026-11-20T09:00:00.000Z' },
    ]);
    expect(assemblyNotes(ws, profile).map(note => note.jointId)).toEqual(['zeta', 'alpha', 'beta']);
    expect(assemblyNotes(emptyWorkspace(), profile)).toEqual([]);
  });

  it('accepts precomputed features and gives the same notes', () => {
    const ws = chain([screw('M3', 2), pin('d3', 1)], [{}, {}, {}]);
    expect(assemblyNotes(ws, profile, jointFeatures(ws, profile))).toEqual(assemblyNotes(ws, profile));
  });
});

describe('kit module', () => {
  it('re-exports assemblyOf, jointFeatures and checkJoints for export', () => {
    expect(kit.assemblyOf).toBe(assemblyOf);
    expect(kit.jointFeatures).toBe(jointFeatures);
    expect(kit.checkJoints).toBe(checkJoints);
    const ws = chain([glue(), glue()]);
    expect(kit.assemblyOf(ws, 'obj-1')).toEqual(['obj-1', 'obj-2', 'obj-3']);
  });
});
