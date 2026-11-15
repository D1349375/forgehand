import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { modelBox, objectBox, partBoxes, worldMatrices } from '../../shared/bounds';
import { demoModel } from '../../shared/demo';
import { validateModel, type ModelSpec } from '../../shared/model';
import * as explode from '../../src/scene/explode';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const slab = (dimensions = vec(2, 1, 4), position = vec(0, 0, 0)): ModelSpec => validateModel({
  schemaVersion: '1.0', name: 'Slab', summary: 'One box.', units: 'm', assumptions: [],
  parts: [{
    id: 'slab', name: 'Slab', parentId: null, primitive: 'box', dimensions, position, rotation: vec(0, 0, 0),
    color: '#336699', role: 'exterior', tubeRatio: 0.3,
  }],
});
const size = (box: THREE.Box3) => box.getSize(new THREE.Vector3());

describe('shared/bounds', () => {
  it('is re-exported unchanged by src/scene/explode', () => {
    expect(explode.partBoxes).toBe(partBoxes);
    expect(explode.worldMatrices).toBe(worldMatrices);
    const fromShared = partBoxes(demoModel);
    const fromScene = explode.partBoxes(demoModel);
    expect([...fromScene.keys()]).toEqual([...fromShared.keys()]);
    for (const [id, box] of fromShared) expect(fromScene.get(id)!.equals(box)).toBe(true);
    for (const [id, matrix] of worldMatrices(demoModel)) expect(explode.worldMatrices(demoModel).get(id)!.equals(matrix)).toBe(true);
  });

  it('modelBox of a single box part is that part box', () => {
    const box = modelBox(slab(vec(2, 1, 4), vec(1, 0, 0)));
    expect(box.min.toArray()).toEqual([0, -0.5, -2]);
    expect(box.max.toArray()).toEqual([2, 0.5, 2]);
  });

  it('modelBox of the demo model is the union of its part boxes', () => {
    const union = new THREE.Box3();
    for (const box of partBoxes(demoModel).values()) union.union(box);
    const box = modelBox(demoModel);
    expect(box.isEmpty()).toBe(false);
    expect(box.equals(union)).toBe(true);
  });

  it('objectBox applies a translation', () => {
    const model = slab();
    const box = objectBox(model, { position: vec(3, 1, -2), rotation: vec(0, 0, 0) });
    expect(box.min.toArray()).toEqual([2, 0.5, -4]);
    expect(box.max.toArray()).toEqual([4, 1.5, 0]);
  });

  it('objectBox with a zero transform equals modelBox', () => {
    const box = objectBox(demoModel, { position: vec(0, 0, 0), rotation: vec(0, 0, 0) });
    expect(box.equals(modelBox(demoModel))).toBe(true);
  });

  it('objectBox with a 90 degree turn about Y swaps the X and Z extents', () => {
    const model = slab(vec(2, 1, 4));
    const turned = size(objectBox(model, { position: vec(0, 0, 0), rotation: vec(0, 90, 0) }));
    expect(turned.x).toBeCloseTo(4, 6);
    expect(turned.y).toBeCloseTo(1, 6);
    expect(turned.z).toBeCloseTo(2, 6);
  });

  it('does not change the model', () => {
    const model = slab();
    const before = JSON.stringify(model);
    objectBox(model, { position: vec(1, 2, 3), rotation: vec(10, 20, 30) });
    expect(JSON.stringify(model)).toBe(before);
  });
});
