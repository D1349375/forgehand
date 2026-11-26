import * as THREE from 'three';
import { shellWall } from '../../shared/hollow';
import type { ModelSpec, Part } from '../../shared/model';

/** Reverses every triangle and negates the normals, so the faces look into the box instead of out of it. */
function flipInward(geometry: THREE.BufferGeometry): void {
  const index = geometry.getIndex()!;
  for (let i = 0; i < index.count; i += 3) {
    const second = index.getX(i + 1);
    index.setX(i + 1, index.getX(i + 2));
    index.setX(i + 2, second);
  }
  const normal = geometry.getAttribute('normal');
  for (let i = 0; i < normal.count; i += 1) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
}

/** Joins indexed geometries that share the same attributes (position, normal, uv) into one; the inputs are not changed. */
function concatIndexed(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const sources = parts.map(entry => entry.getAttribute(name));
    const itemSize = sources[0]!.itemSize;
    const array = new Float32Array(sources.reduce((sum, source) => sum + source.count, 0) * itemSize);
    let at = 0;
    for (const source of sources) {
      array.set(source.array as ArrayLike<number>, at);
      at += source.count * itemSize;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }
  const indices: number[] = [];
  let offset = 0;
  for (const entry of parts) {
    const index = entry.getIndex()!;
    for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + offset);
    offset += entry.getAttribute('position').count;
  }
  merged.setIndex(indices);
  return merged;
}

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
    case 'shell': {
      // Two boxes in one closed mesh: the outer box looks out, the void looks in (48 vertices, 24 triangles).
      const { x, y, z } = part.dimensions;
      const wall = shellWall(part);
      const outer = new THREE.BoxGeometry(1, 1, 1);
      const inner = new THREE.BoxGeometry((x - 2 * wall) / x, (y - 2 * wall) / y, (z - 2 * wall) / z);
      flipInward(inner);
      geometry = concatIndexed([outer, inner]);
      outer.dispose();
      inner.dispose();
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

/** Union box and bounding sphere of several objects (their world boxes); used to frame the whole scene. */
export function objectsBounds(objects: Iterable<THREE.Object3D>) {
  const bounds = new THREE.Box3();
  for (const object of objects) {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (!box.isEmpty()) bounds.union(box);
  }
  if (bounds.isEmpty()) throw new Error('模型沒有可展示的零件。');
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  return { bounds, center: sphere.center, radius: Math.max(sphere.radius, 0.001) };
}