import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportSummary, stepNumbers } from '../../shared/export-plan';
import { jointFeatures } from '../../shared/features';
import { checkJoints } from '../../shared/joint-rules';
import type { Part } from '../../shared/model';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import { pullOutPart } from '../../shared/pull-out';
import { addJoint, addObject, emptyWorkspace, type SceneObject, type Workspace } from '../../shared/workspace';
import { featuresSkippedJoints } from '../../src/export/findings';
import { meshProblems } from '../../src/export/mesh';
import { buildPieces, type PieceBuild, type PiecesInput, type PiecesResult } from '../../src/export/pieces';
import { loadManifold } from '../../src/print/manifold';
import { CREATED_AT, fixtureJoint, fixtureModel, fixtureObject, fixturePart, side } from '../fixtures/joint-workspace';

/**
 * Export proof of the pull-out (workbench-ui requirement 53, design 3.7): the export code is unchanged,
 * and a pulled-out part becomes a print piece of its new object. Real manifold-3d WASM, loaded as
 * `export-pieces.test.ts` loads it. The fixtures are built here and do not depend on the demo model.
 */

const PROFILE = DEFAULT_PRINTER_PROFILE;
const vec = (x: number, y: number, z: number) => ({ x, y, z });
const mm = (value: number) => value / 1000;
type Triple = readonly [number, number, number];
const NEW = { objectId: 'o', partId: 'lid', newObjectId: 'new', createdAt: CREATED_AT } as const;

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

/** A box part named after its id; size and position in millimetres. */
function box(id: string, size: Triple, at: Triple = [0, 0, 0], extra: Partial<Part> = {}): Part {
  return { ...fixturePart(id, 'box', vec(mm(size[0]), mm(size[1]), mm(size[2])), vec(mm(at[0]), mm(at[1]), mm(at[2]))), ...extra };
}

/** A body 40 x 20 x 30 mm with a lid 30 x 10 x 20 mm lying on top of it (the lid is the body's child). */
function stack(): SceneObject {
  return fixtureObject('o', fixtureModel('Rig', [box('body', [40, 20, 30]), box('lid', [30, 10, 20], [0, 15, 0], { parentId: 'body' })]),
    { position: vec(0.2, 0, 0), rotation: vec(0, 30, 0) });
}
const workspaceOf = (...objects: SceneObject[]): Workspace => objects.reduce(addObject, emptyWorkspace());

/** Runs `buildPieces` the way `prepareKit` does: features and skipped joints from the joint rules. */
function build(ws: Workspace, options: Partial<PiecesInput> = {}): Promise<PiecesResult> {
  const features = jointFeatures(ws, PROFILE);
  const skipped = featuresSkippedJoints(checkJoints(ws, PROFILE, features));
  return buildPieces(ws, PROFILE, { wasm, features, skipped, ...options });
}
const codes = (result: PiecesResult) => result.findings.map(finding => finding.code);
const pieceOf = (result: PiecesResult, objectId: string, partId: string): PieceBuild =>
  result.pieces.find(piece => piece.objectId === objectId && piece.partIds.includes(partId))!;

describe('pieces after a pull-out', () => {
  it('turns two touching parts of one object (one piece) into two pieces of two objects', async () => {
    const ws = workspaceOf(stack());
    const before = await build(ws);
    expect(before.pieces).toHaveLength(1);
    expect(before.pieces[0]!.partIds).toEqual(['body', 'lid']);
    expect(codes(before)).toContain('FUSED');

    for (const inPlace of [true, undefined] as const) {
      const after = await build(pullOutPart(ws, { ...NEW, ...(inPlace ? { inPlace } : {}) }));
      expect(after.pieces).toHaveLength(2);
      expect(after.pieces.map(piece => [piece.info.number, piece.objectId, piece.partIds])).toEqual([['P01', 'o', ['body']], ['P02', 'new', ['lid']]]);
      expect(after.pieces.map(piece => piece.info.objectName)).toEqual(['Rig', 'lid']);
      expect(codes(after)).not.toContain('FUSED');
      expect(codes(after)).not.toContain('LOOSE_PIECE');
      for (const piece of after.pieces) expect(meshProblems(piece.mesh)).toEqual([]);
    }
  });

  it('keeps the geometry of the pulled part: its piece has the size and volume it had as a separate piece', async () => {
    // With a joint between them the two parts are two pieces of one object already; pulling one out must not change either piece.
    const joined = addJoint(workspaceOf(stack()), fixtureJoint(side('o', 'body', '+y'), side('o', 'lid', '-y'), { confirmed: true }));
    const before = await build(joined);
    const after = await build(pullOutPart(joined, NEW));
    expect(before.pieces).toHaveLength(2);
    expect(after.pieces).toHaveLength(2);
    for (const [objectId, partId] of [['o', 'body'], ['new', 'lid']] as const) {
      const was = pieceOf(before, 'o', partId);
      const now = pieceOf(after, objectId, partId);
      expect(now.info.volumeMm3).toBeCloseTo(was.info.volumeMm3, 3);
      expect(now.info.sizeMm.x).toBeCloseTo(was.info.sizeMm.x, 6);
      expect(now.info.sizeMm.y).toBeCloseTo(was.info.sizeMm.y, 6);
      expect(now.info.sizeMm.z).toBeCloseTo(was.info.sizeMm.z, 6);
    }
    // Only the lid's piece moved to the new object; the object order decides the numbers.
    expect(after.pieces.map(piece => piece.objectId)).toEqual(['o', 'new']);
  });
});

describe('a joint that a pull-out re-pointed', () => {
  const screw = { kind: 'screw-insert', size: 'M3', count: 1, insertSide: 'b' } as const;
  const joined = () => addJoint(workspaceOf(stack()), fixtureJoint(side('o', 'body', '+y'), side('o', 'lid', '-y'), { method: screw, confirmed: true }));

  it('still cuts its holes, with the same volumes, and reports nothing new', async () => {
    const before = joined();
    const after = pullOutPart(before, NEW);
    expect(after.joints[0]).toMatchObject({ id: 'joint-1', a: side('o', 'body', '+y'), b: side('new', 'lid', '-y'), method: screw, confirmed: true });

    // The feature set follows the re-pointed side: the lid's holes are now keyed by the new object.
    const featuresBefore = jointFeatures(before, PROFILE);
    const featuresAfter = jointFeatures(after, PROFILE);
    expect(featuresBefore.parts.get('o:lid')?.length).toBeGreaterThan(0);
    expect(featuresAfter.parts.get('new:lid')?.map(feature => feature.kind)).toEqual(featuresBefore.parts.get('o:lid')!.map(feature => feature.kind));
    expect(featuresAfter.parts.has('o:lid')).toBe(false);
    expect(featuresAfter.parts.get('o:body')?.map(feature => feature.kind)).toEqual(featuresBefore.parts.get('o:body')?.map(feature => feature.kind));

    const resultBefore = await build(before);
    const resultAfter = await build(after);
    expect(resultBefore.pieces).toHaveLength(2);
    expect(resultAfter.pieces).toHaveLength(2);
    const lidBefore = pieceOf(resultBefore, 'o', 'lid');
    const lidAfter = pieceOf(resultAfter, 'new', 'lid');
    const nominal = 30 * 10 * 20;
    expect(lidAfter.info.volumeMm3).toBeLessThan(nominal);
    expect(lidAfter.info.volumeMm3).toBeCloseTo(lidBefore.info.volumeMm3, 3);
    expect(meshProblems(lidAfter.mesh)).toEqual([]);

    // Control: with the joint's features left out, the same piece is a plain box.
    const plain = await build(after, { skipped: new Set(['joint-1']) });
    expect(pieceOf(plain, 'new', 'lid').info.volumeMm3).toBeCloseTo(nominal, 3);
    expect(codes(plain)).toContain('FEATURES_SKIPPED');

    expect(codes(resultAfter)).not.toContain('FEATURES_SKIPPED');
    expect(codes(resultAfter)).toEqual(codes(resultBefore));
  });

  it('keeps its step and its standard parts in the bill of materials', () => {
    const before = joined();
    const after = pullOutPart(before, NEW);
    expect(stepNumbers(after, PROFILE)).toEqual(stepNumbers(before, PROFILE));
    expect(stepNumbers(after, PROFILE).get('joint-1')).toBe(1);

    const scope = { scope: 'workspace', objectId: null } as const;
    const summaryBefore = exportSummary(before, scope, PROFILE);
    const summaryAfter = exportSummary(after, scope, PROFILE);
    expect(summaryBefore.standardParts.length).toBeGreaterThan(0);
    expect(summaryAfter.standardParts).toEqual(summaryBefore.standardParts);
    expect(summaryAfter.unconfirmed).toEqual(summaryBefore.unconfirmed);
    // The pulled part is listed under the new object's own name.
    expect(summaryAfter.objects.map(object => [object.name, object.printed])).toEqual([['Rig', 1], ['lid', 1]]);
  });
});
