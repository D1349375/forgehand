import type { JointMethod } from '../../shared/joint';
import {
  addJoint, addObject, createObject, emptyWorkspace, setMaterial, type SceneObject, type Workspace,
} from '../../shared/workspace';
import type { PieceInfo } from '../../src/export/bom';
import {
  BOX, CREATED_AT, boxModel, fixtureJoint, fixtureModel, fixtureObject, fixturePart, side, solidDemoModel, twoBoxes,
} from './joint-workspace';

/**
 * Workspaces and piece lists for the export tests (spec export, design 9). They build on
 * `joint-workspace.ts`; Tasks 3 to 5 reuse them.
 */

/** A part and model name that tries to run as a spreadsheet formula and to inject markup into every format. */
export const HOSTILE_NAME = `=cmd|' /C calc'!A0 <script>|`;

export const SCREW_M3: JointMethod = { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'b' };

/**
 * Two `solidDemoModel` objects (`demo-a`, `demo-b`) and one screw joint `joint-1` between the two
 * housings (a `+x`, b `-x`). By default the second object is moved so the housings touch;
 * `touching: false` keeps the gap of `placeBeside`, which gives an `APART` error.
 */
export function demoPairWithScrew(options: { touching?: boolean; confirmed?: boolean; method?: JointMethod } = {}): Workspace {
  const first = createObject(emptyWorkspace(), { id: 'demo-a', model: solidDemoModel, source: 'demo', providerModel: 'demo', createdAt: CREATED_AT });
  const withFirst = addObject(emptyWorkspace(), first);
  const made = createObject(withFirst, { id: 'demo-b', model: solidDemoModel, source: 'demo', providerModel: 'demo', createdAt: CREATED_AT });
  const second: SceneObject = options.touching === false
    ? made
    : { ...made, transform: { position: { x: 0.16, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } };
  return addJoint(addObject(withFirst, second), {
    ...fixtureJoint(side('demo-a', 'housing', '+x'), side('demo-b', 'housing', '-x')),
    method: options.method ?? SCREW_M3,
    confirmed: options.confirmed ?? true,
  });
}

/** `twoBoxes` with object `a` made of aluminium and a screw joint whose insert side is `a` (a tapped hole). */
export function metalPair(options: { confirmed?: boolean } = {}): Workspace {
  const ws = setMaterial(twoBoxes(), 'a', 'aluminium');
  return addJoint(ws, {
    ...fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x')),
    method: { kind: 'screw-insert', size: 'M3', count: 2, insertSide: 'a' },
    confirmed: options.confirmed ?? true,
  });
}

/** One object `Casing`: an exterior box `shell` and an interior box `cell` (a bought component). No joints. */
export function interiorPartWorkspace(): Workspace {
  const model = fixtureModel('Casing', [
    fixturePart('shell', 'box', { x: 0.1, y: 0.06, z: 0.04 }),
    fixturePart('cell', 'box', { x: 0.04, y: 0.02, z: 0.02 }, { x: 0, y: 0, z: 0 }, 'interior'),
  ]);
  return addObject(emptyWorkspace(), fixtureObject('casing', model, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
}

/** Two touching boxes whose object names and part names are all `HOSTILE_NAME`, joined by an unconfirmed glue joint. */
export function hostileWorkspace(): Workspace {
  const named = (partId: string) => {
    const part = fixturePart(partId, 'box', BOX);
    return { ...part, name: HOSTILE_NAME };
  };
  const a = fixtureModel(HOSTILE_NAME, [named('body')]);
  const b = fixtureModel(HOSTILE_NAME, [named('body')]);
  let ws = addObject(emptyWorkspace(), fixtureObject('a', a, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
  ws = addObject(ws, fixtureObject('b', b, { position: { x: BOX.x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
  return addJoint(ws, fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x')));
}

/** One box object `Block`, no joints. */
export function singleBox(): Workspace {
  return addObject(emptyWorkspace(), fixtureObject('a', boxModel('Block'), { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
}

/** A `PieceInfo` with sensible defaults; pass `overrides` to change any field. */
export function pieceInfo(overrides: Partial<PieceInfo> = {}): PieceInfo {
  return {
    number: 'P01', name: '外殼', objectId: 'demo-a', objectName: '雙鏡頭概念裝置', material: 'pla', count: 1,
    sizeMm: { x: 160, y: 70, z: 90 }, volumeMm3: 412_300, file: 'stl/P01-housing.stl', partNames: ['外殼'], ...overrides,
  };
}

/**
 * Hand-built pieces for `demoPairWithScrew`: the housing with its lens tubes, glass and battery
 * fused into one piece (two copies, one per object) and the display stand with its base.
 */
export function demoPieces(): PieceInfo[] {
  return [
    pieceInfo({
      number: 'P01', name: '外殼（含 6 個零件）', count: 2, sizeMm: { x: 160, y: 70, z: 90 }, volumeMm3: 412_300,
      file: 'stl/P01-housing.stl', partNames: ['外殼', '鏡筒 1', '鏡片 1', '鏡筒 2', '鏡片 2', '側邊電池'],
    }),
    pieceInfo({
      number: 'P02', name: '展示底座（含 2 個零件）', count: 2, sizeMm: { x: 130, y: 100, z: 87 }, volumeMm3: 118_900,
      file: 'stl/P02-base.stl', partNames: ['展示底座', '展示支架'],
    }),
  ];
}
