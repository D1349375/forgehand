import * as THREE from 'three';
import type { ModelSpec, Part } from '../../shared/model';

/** Coordinates and dimensions stay in metres; presentation never changes source data. */
export function createPartGeometry(part: Part): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry;
  switch (part.primitive) {
    case 'box': geometry = new THREE.BoxGeometry(1, 1, 1); break;
    case 'sphere': geometry = new THREE.SphereGeometry(0.5, 40, 24); break;
    case 'cylinder': geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 48); break;
    case 'cone': geometry = new THREE.ConeGeometry(0.5, 1, 48); break;
    case 'torus': geometry = new THREE.TorusGeometry(0.375, 0.125, 24, 64); break;
    case 'tube': {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, part.tubeRatio * 0.5, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 32, steps: 1 });
      geometry.rotateX(Math.PI / 2);
      break;
    }
    default: throw new Error('不支援的幾何類型，上一個模型已保留。');
  }
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  geometry.center();
  geometry.scale(part.dimensions.x / size.x, part.dimensions.y / size.y, part.dimensions.z / size.z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Separate transform nodes prevent a parent's size from resizing its children. */
export function buildModel(spec: ModelSpec, decorate: (geometry: THREE.BufferGeometry, part: Part) => THREE.Object3D): THREE.Group {
  const root = new THREE.Group();
  root.name = spec.name;
  root.userData.modelName = spec.name;
  const transforms = new Map<string, THREE.Group>();
  try {
    for (const part of spec.parts) {
      if (transforms.has(part.id)) throw new Error('零件識別碼重複。');
      const transform = new THREE.Group();
      transform.name = part.id;
      transform.position.set(part.position.x, part.position.y, part.position.z);
      transform.rotation.set(...[part.rotation.x, part.rotation.y, part.rotation.z].map(THREE.MathUtils.degToRad) as [number, number, number]);
      transform.userData = { partId: part.id, partName: part.name, primitive: part.primitive, color: part.color, role: part.role };
      transforms.set(part.id, transform);
      // Attach immediately so failure cleanup owns every allocated resource.
      root.add(transform);
      const geometry = createPartGeometry(part);
      try { transform.add(decorate(geometry, part)); }
      catch (error) { geometry.dispose(); throw error; }
    }
    for (const part of spec.parts) {
      if (!part.parentId) continue;
      const parent = transforms.get(part.parentId);
      if (!parent) throw new Error('找不到組件的父零件。');
      let ancestor: THREE.Object3D | null = parent;
      const child = transforms.get(part.id)!;
      while (ancestor) {
        if (ancestor === child) throw new Error('零件關係不可形成循環。');
        ancestor = ancestor.parent;
      }
      parent.add(child);
    }
    root.updateMatrixWorld(true);
    return root;
  } catch (error) {
    disposeObject(root);
    throw error;
  }
}

export function disposeObject(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if ('geometry' in child && child.geometry instanceof THREE.BufferGeometry) geometries.add(child.geometry);
    if ('material' in child) {
      const material = child.material;
      if (Array.isArray(material)) material.forEach((entry: THREE.Material) => materials.add(entry));
      else if (material instanceof THREE.Material) materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  object.removeFromParent();
}

export function modelBounds(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) throw new Error('模型沒有可展示的零件。');
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  return { bounds, center: sphere.center, radius: Math.max(sphere.radius, 0.001) };
}
