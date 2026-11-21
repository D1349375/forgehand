import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { objectMatrix } from '../../shared/assembly';
import { partBoxes, worldMatrices } from '../../shared/bounds';
import { stepNumbers, scopeWorkspace } from '../../shared/export-plan';
import { jointFeatures } from '../../shared/features';
import type { ModelSpec } from '../../shared/model';
import { DEFAULT_PRINTER_PROFILE } from '../../shared/printer';
import {
  addJoint, addObject, emptyWorkspace, replaceModel, selectParts, setActiveObject, setExplode, type Workspace,
} from '../../shared/workspace';
import {
  defaultScope, fileRows, formatKb, problemBanner, sameSnapshot, scopeChoiceVisible, snapshotKey, summaryLines,
} from '../../src/export/dialog-model';
import type { ExportFinding } from '../../src/export/findings';
import { computeExplosion, explodedOffsets } from '../../src/scene/explode';
import { explodedLayout, type ImageLayout } from '../../src/export/kit-image';
import type { PreparedKit } from '../../src/export/prepare';
import { SEPARATION_FACTOR } from '../../src/export/constants';
import { demoPairWithScrew } from '../fixtures/export-workspace';
import { boxModel, demoPair, fixtureJoint, fixtureModel, fixtureObject, fixturePart, side, twoBoxes } from '../fixtures/joint-workspace';
const PROFILE = DEFAULT_PRINTER_PROFILE;
const WHOLE = { scope: 'workspace', objectId: null } as const;
const ASSEMBLY = { scope: 'assembly', objectId: null } as const;
function finding(severity: ExportFinding['severity'], code: ExportFinding['code'] = 'LOOSE_PIECE'): ExportFinding {
  return { severity, code, source: 'export', message: `${severity} ${code}`, jointId: null, step: null, piece: null };
}
function fakeKit(overrides: Partial<PreparedKit> = {}): PreparedKit {
  return {
    summary: { pieces: 2, copies: 3, bought: 1, machined: 0, standard: 4, totalVolumeMm3: 12_345 },
    findings: [],
    files: [
      { path: 'assembly.html', bytes: new Uint8Array(2048), mime: 'text/html;charset=utf-8' },
      { path: 'stl/P01-housing.stl', bytes: new Uint8Array(84), mime: 'model/stl' },
    ],
    zipName: 'forgehand-kit-20261121-1030.zip',
    imageMissing: false,
    ...overrides,
  };
}
describe('dialog model', () => {
  it('defaults to the whole workspace', () => {
    expect(defaultScope(twoBoxes())).toEqual({ scope: 'workspace', objectId: null });
  });
  it('shows the scope choice only when the active assembly is not the whole workspace', () => {
    expect(scopeChoiceVisible(emptyWorkspace())).toBe(false);
    // One object.
    const single = addObject(emptyWorkspace(), fixtureObject('a', boxModel('A'), { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
    expect(scopeChoiceVisible(single)).toBe(false);
    // Two unjoined objects: the active object's assembly is only itself.
    expect(scopeChoiceVisible(twoBoxes())).toBe(true);
    // Two joined objects: the assembly is the whole workspace.
    expect(scopeChoiceVisible(twoBoxes({ joint: true }))).toBe(false);
  });
  it('treats a change of selection, explode or activation as the same snapshot', () => {
    const ws = demoPairWithScrew();
    const key = snapshotKey(ws, WHOLE, PROFILE);
    const changed: Workspace[] = [
      selectParts(ws, 'demo-a', ['housing']),
      setExplode(ws, 0.6),
      setActiveObject(ws, 'demo-b'),
    ];
    for (const next of changed) expect(sameSnapshot(key, snapshotKey(next, WHOLE, PROFILE))).toBe(true);
    // A profile with the same values is the same snapshot.
    expect(sameSnapshot(key, snapshotKey(ws, WHOLE, { ...PROFILE }))).toBe(true);
  });
  it('treats a model change, a joint change, a profile change and a scope change as a new snapshot', () => {
    const ws = demoPairWithScrew();
    const key = snapshotKey(ws, WHOLE, PROFILE);
    const renamed: ModelSpec = { ...ws.objects[0]!.model, name: '改了名稱' };
    expect(sameSnapshot(key, snapshotKey(replaceModel(ws, 'demo-a', renamed), WHOLE, PROFILE))).toBe(false);
    expect(sameSnapshot(key, snapshotKey({ ...ws, joints: ws.joints.map(joint => ({ ...joint, confirmed: !joint.confirmed })) }, WHOLE, PROFILE))).toBe(false);
    expect(sameSnapshot(key, snapshotKey({ ...ws, joints: [] }, WHOLE, PROFILE))).toBe(false);
    expect(sameSnapshot(key, snapshotKey(ws, WHOLE, { ...PROFILE, slidingFit: PROFILE.slidingFit + 0.05 }))).toBe(false);
    expect(sameSnapshot(key, snapshotKey(ws, { scope: 'assembly', objectId: 'demo-a' }, PROFILE))).toBe(false);
  });
  it('resolves the assembly scope against the active object', () => {
    const ws = setActiveObject(twoBoxes(), 'a');
    const first = snapshotKey(ws, ASSEMBLY, PROFILE);
    expect(first.objects.map(object => object.id)).toEqual(['a']);
    // Another active object is another assembly, so another snapshot.
    expect(sameSnapshot(first, snapshotKey(setActiveObject(ws, 'b'), ASSEMBLY, PROFILE))).toBe(false);
  });
  it('throws for a workspace or an object that cannot be exported', () => {
    expect(() => snapshotKey(emptyWorkspace(), WHOLE, PROFILE)).toThrow();
    expect(() => snapshotKey(twoBoxes(), { scope: 'assembly', objectId: 'missing' }, PROFILE)).toThrow();
  });
  it('lists the files with sizes and download labels', () => {
    const rows = fileRows(fakeKit());
    expect(rows).toEqual([
      { path: 'assembly.html', bytes: 2048, label: '下載 assembly.html' },
      { path: 'stl/P01-housing.stl', bytes: 84, label: '下載 stl/P01-housing.stl' },
    ]);
    expect(formatKb(2048)).toBe('2.0 KB');
    expect(formatKb(84)).toBe('0.1 KB');
  });
  it('counts only errors and warnings in the banner', () => {
    expect(problemBanner([])).toBeNull();
    expect(problemBanner([finding('info', 'FUSED'), finding('info', 'BOUGHT')])).toBeNull();
    expect(problemBanner([finding('error', 'PIECE_FAILED'), finding('warning'), finding('info', 'FUSED')])).toBe('有 2 個問題，仍可繼續匯出。');
  });
  it('writes the summary, also for a kit with nothing to print', () => {
    expect(summaryLines(fakeKit())).toEqual(['列印件 2 種（共 3 件）、外購件 1 個、加工件 0 個、標準件 4 項、列印總體積 12.3 cm³']);
    const none = fakeKit({ summary: { pieces: 0, copies: 0, bought: 2, machined: 1, standard: 0, totalVolumeMm3: 0 } });
    expect(summaryLines(none)).toEqual(['沒有需要列印的零件。', '外購件 2 個、加工件 1 個、標準件 0 項']);
  });
});
/** The world box of an object as the layout draws it: part positions of the layout, root matrix of the layout. */
function drawnBox(ws: Workspace, layout: ImageLayout, objectId: string): THREE.Box3 {
  const object = ws.objects.find(candidate => candidate.id === objectId)!;
  const entry = layout.objects.find(candidate => candidate.objectId === objectId)!;
  const model: ModelSpec = {
    ...object.model,
    parts: object.model.parts.map(part => {
      const at = entry.parts.get(part.id)!;
      return { ...part, position: { x: at.x, y: at.y, z: at.z } };
    }),
  };
  const box = new THREE.Box3();
  for (const partBox of partBoxes(model).values()) box.union(partBox);
  return box.applyMatrix4(entry.root);
}
const steps = (ws: Workspace) => stepNumbers(ws, PROFILE, jointFeatures(ws, PROFILE));
const translationOf = (matrix: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(matrix);
describe('explodedLayout', () => {
  it('draws the parts of one object exploded and keeps the object where it is', () => {
    const ws = scopeWorkspace(demoPair(), WHOLE);
    const layout = explodedLayout({ ...ws, objects: [ws.objects[0]!], joints: [] }, new Map());
    const entry = layout.objects[0]!;
    expect(entry.root.equals(objectMatrix(ws.objects[0]!.transform))).toBe(true);
    const parts = ws.objects[0]!.model.parts;
    const moved = parts.filter(part => entry.parts.get(part.id)!.distanceTo(new THREE.Vector3(part.position.x, part.position.y, part.position.z)) > 1e-6);
    expect(moved.length).toBeGreaterThan(3);
    // The exploded drawing is larger than the assembled object.
    const assembled = new THREE.Box3();
    for (const box of partBoxes(ws.objects[0]!.model).values()) assembled.union(box);
    const exploded = drawnBox(ws, layout, ws.objects[0]!.id);
    expect(exploded.getSize(new THREE.Vector3()).length()).toBeGreaterThan(assembled.getSize(new THREE.Vector3()).length());
    expect(layout.bounds.containsBox(exploded)).toBe(true);
    expect(layout.badges).toEqual([]);
  });
  it('keeps the parts of a child in the frame of its parent (a rotated parent)', () => {
    const model = fixtureModel('Turned', [
      { ...fixturePart('base', 'box', { x: 0.1, y: 0.02, z: 0.1 }), rotation: { x: 0, y: 90, z: 0 } },
      { ...fixturePart('post', 'box', { x: 0.02, y: 0.04, z: 0.02 }), parentId: 'base', position: { x: 0.03, y: 0, z: 0 } },
      { ...fixturePart('cap', 'box', { x: 0.02, y: 0.02, z: 0.02 }), parentId: 'base', position: { x: -0.03, y: 0, z: 0 } },
    ]);
    const ws = addObject(emptyWorkspace(), fixtureObject('turned', model, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
    const layout = explodedLayout(ws, new Map());
    // Each part's drawn world position must be its assembled position plus its total explosion offset, whatever the parent's rotation.
    const offsets = explodedOffsets(model, computeExplosion(model), 1);
    const assembled = worldMatrices(model);
    const drawnModel: ModelSpec = {
      ...model,
      parts: model.parts.map(part => {
        const at = layout.objects[0]!.parts.get(part.id)!;
        return { ...part, position: { x: at.x, y: at.y, z: at.z } };
      }),
    };
    const drawn = worldMatrices(drawnModel);
    let movedParts = 0;
    for (const part of model.parts) {
      const expected = translationOf(assembled.get(part.id)!).add(offsets.get(part.id)!);
      expect(translationOf(drawn.get(part.id)!).distanceTo(expected)).toBeLessThan(1e-9);
      if (offsets.get(part.id)!.length() > 1e-6) movedParts += 1;
    }
    expect(movedParts).toBeGreaterThan(0);
    expect(layout.bounds.containsBox(drawnBox(ws, layout, 'turned'))).toBe(true);
  });
  it('draws the objects of an assembly apart along the joint normal, with no overlap along it', () => {
    const ws = scopeWorkspace(demoPairWithScrew(), WHOLE);
    const layout = explodedLayout(ws, steps(ws));
    const a = drawnBox(ws, layout, 'demo-a');
    const b = drawnBox(ws, layout, 'demo-b');
    // demo-a's housing +x face points along +x; the equal-sized anchor is the first object and stays where it is.
    expect(layout.objects[0]!.root.equals(objectMatrix(ws.objects[0]!.transform))).toBe(true);
    const gap = b.min.x - a.max.x;
    const smaller = Math.min(a.getSize(new THREE.Vector3()).length(), b.getSize(new THREE.Vector3()).length());
    expect(gap).toBeGreaterThanOrEqual(SEPARATION_FACTOR * smaller - 1e-9);
    // Only along the joint normal.
    const moved = translationOf(layout.objects[1]!.root).sub(translationOf(objectMatrix(ws.objects[1]!.transform)));
    expect(moved.x).toBeGreaterThan(0);
    expect(Math.abs(moved.y)).toBeLessThan(1e-9);
    expect(Math.abs(moved.z)).toBeLessThan(1e-9);
  });
  it('keeps the largest object of an assembly in place and moves the other one away from it', () => {
    const small = boxModel('Small', 'body');
    const large = fixtureModel('Large', [fixturePart('body', 'box', { x: 0.12, y: 0.06, z: 0.06 })]);
    // Object a (small) is joined to the +x face of b (large): a's -x... the joint is a:+x to b:-x, and b is the anchor.
    let ws = addObject(emptyWorkspace(), fixtureObject('a', small, { position: { x: -0.08, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
    ws = addObject(ws, fixtureObject('b', large, { position: { x: 0.04, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x')));
    const layout = explodedLayout(ws, new Map([['joint-1', 1]]));
    expect(translationOf(layout.objects[1]!.root).equals(translationOf(objectMatrix(ws.objects[1]!.transform)))).toBe(true);
    const moved = translationOf(layout.objects[0]!.root).sub(translationOf(objectMatrix(ws.objects[0]!.transform)));
    // b's face points along -x, so the small object moves to -x.
    expect(moved.x).toBeLessThan(0);
    const a = drawnBox(ws, layout, 'a');
    const b = drawnBox(ws, layout, 'b');
    expect(b.min.x - a.max.x).toBeGreaterThanOrEqual(SEPARATION_FACTOR * a.getSize(new THREE.Vector3()).length() - 1e-9);
  });
  it('moves an object reached through another object with it', () => {
    const body = (id: string, x: number) => fixtureObject(id, boxModel(id), { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } });
    // Three equal boxes in a row: a - b - c, each touching the next along x.
    let ws = [body('a', 0), body('b', 0.04), body('c', 0.08)].reduce(addObject, emptyWorkspace());
    ws = addJoint(ws, fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x'), { id: 'ab' }));
    ws = addJoint(ws, fixtureJoint(side('b', 'body', '+x'), side('c', 'body', '-x'), { id: 'bc' }));
    const layout = explodedLayout(ws, new Map([['ab', 1], ['bc', 2]]));
    const shift = (index: number) => translationOf(layout.objects[index]!.root).x - translationOf(objectMatrix(ws.objects[index]!.transform)).x;
    expect(shift(0)).toBe(0);
    expect(shift(1)).toBeGreaterThan(0);
    // c travels with b and then moves again.
    expect(shift(2)).toBeGreaterThan(shift(1));
    const [a, b, c] = ['a', 'b', 'c'].map(id => drawnBox(ws, layout, id));
    expect(b!.min.x).toBeGreaterThan(a!.max.x);
    expect(c!.min.x).toBeGreaterThan(b!.max.x);
  });
  it('leaves objects outside any assembly where they are', () => {
    const ws = twoBoxes();
    const layout = explodedLayout(ws, new Map());
    ws.objects.forEach((object, index) => expect(layout.objects[index]!.root.equals(objectMatrix(object.transform))).toBe(true));
  });
  it('puts a badge halfway between the two contact faces of each joint with a step', () => {
    const ws = scopeWorkspace(demoPairWithScrew(), WHOLE);
    const layout = explodedLayout(ws, steps(ws));
    expect(layout.badges).toHaveLength(1);
    const badge = layout.badges[0]!;
    expect(badge.step).toBe(1);
    // The housing is the root of its object and does not move in the explosion; its +x and -x faces are 0.08 m from its centre.
    const shift = translationOf(layout.objects[1]!.root).x - ws.objects[1]!.transform.position.x;
    const faceA = ws.objects[0]!.transform.position.x + 0.08;
    const faceB = ws.objects[1]!.transform.position.x + shift - 0.08;
    expect(badge.point.x).toBeCloseTo((faceA + faceB) / 2, 6);
    expect(badge.point.y).toBeCloseTo(0, 6);
    expect(badge.point.z).toBeCloseTo(0, 6);
    expect(layout.bounds.containsPoint(badge.point)).toBe(true);
  });
  it('draws no badge for a joint without a step number', () => {
    const ws = scopeWorkspace(demoPairWithScrew(), WHOLE);
    expect(explodedLayout(ws, new Map()).badges).toEqual([]);
  });
  it('gives a joint inside one object a badge and no separation', () => {
    const model = fixtureModel('Pair', [
      fixturePart('left', 'box', { x: 0.04, y: 0.02, z: 0.03 }),
      { ...fixturePart('right', 'box', { x: 0.04, y: 0.02, z: 0.03 }), position: { x: 0.04, y: 0, z: 0 } },
    ]);
    let ws = addObject(emptyWorkspace(), fixtureObject('one', model, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }));
    ws = addJoint(ws, fixtureJoint(side('one', 'left', '+x'), side('one', 'right', '-x')));
    const layout = explodedLayout(ws, new Map([['joint-1', 1]]));
    expect(layout.objects[0]!.root.equals(objectMatrix(ws.objects[0]!.transform))).toBe(true);
    expect(layout.badges).toHaveLength(1);
  });
});
