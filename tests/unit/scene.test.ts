import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ModelSpec, Part } from '../../shared/model';
import { buildModel, createPartGeometry, disposeObject, modelBounds } from '../../src/scene/geometry';
import { HOLOGRAM, SELECTION, applyPartStyle, applySelectionStyle, hologramPart } from '../../src/scene/style';

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

  it('dims surface and edge opacity by the inactive factor and restores it', () => {
    const root = buildModel(spec([part(), part({ id: 'ball', primitive: 'sphere', role: 'interior' })]), hologramPart);
    const surface = root.getObjectByName('body:surface') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const interior = root.getObjectByName('ball:surface') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const edges = root.getObjectByName('body:edges') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    const rings: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
    root.traverse(object => { if (object instanceof THREE.LineLoop) rings.push(object as typeof rings[number]); });
    expect(HOLOGRAM.inactiveFactor).toBe(0.4);
    expect(rings.length).toBeGreaterThan(0);
    applyPartStyle(root, { selected: false, dimmed: true });
    expect(surface.material.opacity).toBeCloseTo(HOLOGRAM.shellOpacity * 0.4, 10);
    expect(interior.material.opacity).toBeCloseTo(HOLOGRAM.interiorOpacity * 0.4, 10);
    expect(edges.material.opacity).toBeCloseTo(0.88 * 0.4, 10);
    rings.forEach(ring => expect(ring.material.opacity).toBeCloseTo(0.55 * 0.4, 10));
    // Dimming twice does not compound: it scales the stored base opacity.
    applyPartStyle(root, { selected: false, dimmed: true });
    expect(surface.material.opacity).toBeCloseTo(HOLOGRAM.shellOpacity * 0.4, 10);
    applyPartStyle(root, { selected: false, dimmed: false });
    expect(surface.material.opacity).toBe(HOLOGRAM.shellOpacity);
    expect(interior.material.opacity).toBe(HOLOGRAM.interiorOpacity);
    expect(edges.material.opacity).toBe(0.88);
    rings.forEach(ring => expect(ring.material.opacity).toBe(0.55));
    disposeObject(root);
  });
  it('selection still recolours edges and raises the glow, and is not dimmed', () => {
    const root = buildModel(spec([part()]), hologramPart);
    const surface = root.getObjectByName('body:surface') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const edges = root.getObjectByName('body:edges') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    applySelectionStyle(root, true);
    expect(edges.material.color.getHexString()).toBe(SELECTION.edgeColor.slice(1));
    expect(edges.material.opacity).toBe(1);
    expect(edges.material.depthTest).toBe(false);
    expect(surface.material.emissiveIntensity).toBe(SELECTION.emissiveIntensity);
    expect(surface.material.opacity).toBe(HOLOGRAM.shellOpacity);
    applySelectionStyle(root, false);
    expect(edges.material.color.getHexString()).toBe('69eaff');
    expect(edges.material.opacity).toBe(0.88);
    expect(edges.material.depthTest).toBe(true);
    expect(surface.material.emissiveIntensity).toBe(0.14);
    disposeObject(root);
  });  it('rejects a cycle even if data validation was bypassed', () => {
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
