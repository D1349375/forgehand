import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ModelSpec, Part } from '../../shared/model';
import { buildModel, createPartGeometry, disposeObject, modelBounds } from '../../src/scene/geometry';
import { HOLOGRAM, hologramPart } from '../../src/scene/style';

const part = (overrides: Partial<Part> = {}): Part => ({ id: 'body', name: '主體', parentId: null, primitive: 'box', dimensions: { x: 2, y: 3, z: 4 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#ff0000', role: 'exterior', tubeRatio: 0.6, ...overrides });
const spec = (parts: Part[]): ModelSpec => ({ schemaVersion: '1.0', name: '測試模型', summary: '測試', units: 'm', assumptions: ['概念尺寸'], parts });

describe('scene geometry and presentation', () => {
  it.each(['box', 'sphere', 'cylinder', 'cone', 'torus', 'tube'] as const)('%s has the exact requested bounds', (primitive) => {
    const geometry = createPartGeometry(part({ primitive }));
    const size = geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(2, 5);
    expect(size.y).toBeCloseTo(3, 5);
    expect(size.z).toBeCloseTo(4, 5);
    geometry.dispose();
  });

  it('keeps the tube physically hollow', () => {
    const geometry = createPartGeometry(part({ primitive: 'tube', dimensions: { x: 2, y: 3, z: 2 } }));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    const sideRay = new THREE.Raycaster(new THREE.Vector3(0.9, 10, 0), new THREE.Vector3(0, -1, 0));
    expect(sideRay.intersectObject(mesh).length).toBeGreaterThan(0);
    disposeObject(mesh);
  });

  it('applies parent rotation in degrees without inheriting its mesh dimensions', () => {
    const root = buildModel(spec([
      part({ dimensions: { x: 20, y: 30, z: 40 }, rotation: { x: 0, y: 0, z: 90 } }),
      part({ id: 'child', parentId: 'body', position: { x: 2, y: 0, z: 0 }, dimensions: { x: 1, y: 1, z: 1 } }),
    ]), (geometry) => new THREE.Mesh(geometry));
    const child = root.getObjectByName('child')!;
    const position = child.getWorldPosition(new THREE.Vector3());
    expect(position.x).toBeCloseTo(0);
    expect(position.y).toBeCloseTo(2);
    expect(child.getWorldScale(new THREE.Vector3()).toArray()).toEqual([1, 1, 1]);
    expect(modelBounds(root).radius).toBeGreaterThan(20);
    disposeObject(root);
  });

  it('preserves the requested surface color and displays only actual parts', () => {
    const root = buildModel(spec([part()]), hologramPart);
    const surface = root.getObjectByName('body:surface') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(surface.material.color.getHexString()).toBe('ff0000');
    expect(surface.material.opacity).toBe(HOLOGRAM.shellOpacity);
    const edges = root.getObjectByName('body:edges') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    expect(edges.material.color.getHexString()).toBe('69eaff');
    expect(root.children).toHaveLength(1);
    disposeObject(root);
  });

  it('rejects a cycle even if data validation was bypassed', () => {
    expect(() => buildModel(spec([part({ parentId: 'child' }), part({ id: 'child', parentId: 'body' })]), hologramPart)).toThrow('循環');
  });

  it('disposes shared GPU resources exactly once', () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material, 'dispose');
    disposeObject(root);
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
  });
});
