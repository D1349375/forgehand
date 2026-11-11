import * as THREE from 'three';
import type { ModelSpec, Part } from '../../shared/model';

/**
 * Exploded view computed locally from the part hierarchy and bounding boxes
 * (no model call). A simplified version of Li, Agrawala, Curless & Salesin,
 * "Automated Generation of Interactive 3D Exploded View Diagrams"
 * (SIGGRAPH 2008): parts move along the model axes, unblocked parts are
 * removed one at a time by smallest escape distance, and every sub-assembly
 * (a part with children) explodes its direct children as atomic units.
 * Boxes replace mesh contact tests, so this is approximate for rotated parts.
 *
 * The result is display-only: it never changes the ModelSpec.
 */
export interface ExplodeMove {
  /** World-space translation of this part's subtree at full explosion. */
  offset: THREE.Vector3;
  /** Group depth: outer groups (0) expand first, inner groups later. */
  depth: number;
}
export interface ExplodePlan { moves: Map<string, ExplodeMove>; maxDepth: number }

const AXES = [0, 1, 2] as const;
const DIRECTIONS = AXES.flatMap(axis => [{ axis, sign: 1 }, { axis, sign: -1 }]);
const component = (vector: THREE.Vector3, axis: number) => axis === 0 ? vector.x : axis === 1 ? vector.y : vector.z;
const min = (box: THREE.Box3, axis: number) => component(box.min, axis);
const max = (box: THREE.Box3, axis: number) => component(box.max, axis);

/** World matrix of every part with rotation in XYZ Euler degrees, as built in geometry.ts. */
export function worldMatrices(model: ModelSpec): Map<string, THREE.Matrix4> {
  const byId = new Map(model.parts.map(part => [part.id, part]));
  const result = new Map<string, THREE.Matrix4>();
  const resolve = (part: Part): THREE.Matrix4 => {
    const known = result.get(part.id);
    if (known) return known;
    const rotation = new THREE.Euler(...[part.rotation.x, part.rotation.y, part.rotation.z].map(THREE.MathUtils.degToRad) as [number, number, number]);
    const local = new THREE.Matrix4().compose(new THREE.Vector3(part.position.x, part.position.y, part.position.z),
      new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(1, 1, 1));
    const parent = part.parentId ? byId.get(part.parentId) : undefined;
    const world = parent ? resolve(parent).clone().multiply(local) : local;
    result.set(part.id, world);
    return world;
  };
  model.parts.forEach(resolve);
  return result;
}

/** Axis-aligned world box of each part's own primitive (every primitive is centred, full size = dimensions). */
export function partBoxes(model: ModelSpec, offsets?: Map<string, THREE.Vector3>): Map<string, THREE.Box3> {
  const matrices = worldMatrices(model);
  const boxes = new Map<string, THREE.Box3>();
  for (const part of model.parts) {
    const half = new THREE.Vector3(part.dimensions.x, part.dimensions.y, part.dimensions.z).multiplyScalar(0.5);
    const box = new THREE.Box3(half.clone().negate(), half).applyMatrix4(matrices.get(part.id)!);
    const shift = offsets?.get(part.id);
    boxes.set(part.id, shift ? box.translate(shift) : box);
  }
  return boxes;
}

export function computeExplosion(model: ModelSpec): ExplodePlan {
  const boxes = partBoxes(model);
  const children = new Map<string | null, Part[]>();
  for (const part of model.parts) children.set(part.parentId, [...(children.get(part.parentId) ?? []), part]);
  // Inner sub-assemblies are exploded first; an outer group then spaces its
  // units by their *exploded* extent, so expanded children never land inside
  // a neighbouring assembly.
  const moves = new Map<string, ExplodeMove>();
  const explodedBox = new Map<string, THREE.Box3>();
  const subtree = (part: Part): THREE.Box3 => {
    const known = explodedBox.get(part.id);
    if (known) return known;
    const box = boxes.get(part.id)!.clone();
    for (const child of children.get(part.id) ?? []) {
      const offset = moves.get(child.id)?.offset;
      const childBox = subtree(child).clone();
      box.union(offset ? childBox.translate(offset) : childBox);
    }
    explodedBox.set(part.id, box);
    return box;
  };
  const volume = (box: THREE.Box3) => { const size = box.getSize(new THREE.Vector3()); return size.x * size.y * size.z; };
  const depthOf = new Map<string, number>();
  const depth = (part: Part): number => {
    const known = depthOf.get(part.id);
    if (known !== undefined) return known;
    const parent = part.parentId ? model.parts.find(entry => entry.id === part.parentId) : undefined;
    const value = parent ? depth(parent) + 1 : 0;
    depthOf.set(part.id, value);
    return value;
  };

  let maxDepth = 0;
  const explodeGroup = (anchor: { id: string | null; box: THREE.Box3 }, members: Part[], groupDepth: number) => {
    if (!members.length) return;
    const units = members.map(part => ({ id: part.id, box: subtree(part) }));
    const groupBox = units.reduce((box, unit) => box.union(unit.box), anchor.box.clone());
    const size = groupBox.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 1e-6);
    const epsilon = extent * 1e-4;
    const contactTolerance = extent * 5e-3;
    const anchorCentre = anchor.box.getCenter(new THREE.Vector3());
    const overlaps = (a: THREE.Box3, b: THREE.Box3, axis: number, tolerance: number) =>
      Math.min(max(a, axis), max(b, axis)) - Math.max(min(a, axis), min(b, axis)) > tolerance;
    const perpendicular = (a: THREE.Box3, b: THREE.Box3, axis: number) => AXES.every(other => other === axis || overlaps(a, b, other, epsilon));
    const touches = (a: THREE.Box3, b: THREE.Box3) => a.clone().expandByScalar(contactTolerance).intersectsBox(b);
    const blocked = (box: THREE.Box3, obstacles: THREE.Box3[], axis: number, sign: number) => obstacles.some(other => perpendicular(box, other, axis)
      && (sign > 0 ? max(other, axis) > max(box, axis) + epsilon : min(other, axis) < min(box, axis) - epsilon));
    const gap = (box: THREE.Box3, axis: number) => Math.max(0.3 * (max(box, axis) - min(box, axis)), 0.1 * extent);

    // Iteratively remove the unblocked unit with the smallest escape distance.
    const active = new Map(units.map(unit => [unit.id, unit.box]));
    const order: Array<{ id: string; axis: number; sign: number; base: number }> = [];
    while (active.size) {
      let best: { id: string; axis: number; sign: number; escape: number; alignment: number } | null = null;
      for (const [id, box] of active) {
        const others = [anchor.box, ...[...active].filter(([other]) => other !== id).map(([, value]) => value)];
        const contacts = others.filter(other => touches(box, other));
        const contactBox = (contacts.length ? contacts : [anchor.box]).reduce((union, other) => union.union(other), new THREE.Box3());
        const direction = box.getCenter(new THREE.Vector3()).sub(anchorCentre);
        for (const { axis, sign } of DIRECTIONS) {
          if (blocked(box, others, axis, sign)) continue;
          const escape = Math.max(0, sign > 0 ? max(contactBox, axis) - min(box, axis) : max(box, axis) - min(contactBox, axis));
          const alignment = sign * component(direction, axis) / extent;
          if (!best || escape < best.escape - epsilon || (Math.abs(escape - best.escape) <= epsilon && alignment > best.alignment)) {
            best = { id, axis, sign, escape, alignment };
          }
        }
      }
      if (!best) break;
      order.push({ id: best.id, axis: best.axis, sign: best.sign, base: best.escape + gap(active.get(best.id)!, best.axis) });
      active.delete(best.id);
    }
    // Interlocked or contained units: push out along the main axis of their
    // offset from the anchor until they clear everything still in place.
    for (const [id, box] of active) {
      const direction = box.getCenter(new THREE.Vector3()).sub(anchorCentre);
      const scaled = AXES.map(axis => Math.abs(component(direction, axis)) / Math.max(component(size, axis), epsilon));
      const axis = scaled[0]! < 1e-3 && scaled[1]! < 1e-3 && scaled[2]! < 1e-3 ? 1 : scaled.indexOf(Math.max(...scaled));
      const sign = component(direction, axis) < 0 ? -1 : 1;
      const escape = sign > 0 ? max(groupBox, axis) - min(box, axis) : max(box, axis) - min(groupBox, axis);
      order.push({ id, axis, sign, base: escape + gap(box, axis) });
    }
    // A unit removed earlier that sits further out along the same direction is
    // carried by the units behind it, so stacked parts never pass each other.
    const final = new Map<string, number>();
    for (let index = order.length - 1; index >= 0; index--) {
      const entry = order[index]!;
      const box = active.has(entry.id) ? active.get(entry.id)! : units.find(unit => unit.id === entry.id)!.box;
      let carried = 0;
      for (let later = index + 1; later < order.length; later++) {
        const other = order[later]!;
        if (other.axis !== entry.axis || other.sign !== entry.sign) continue;
        const otherBox = units.find(unit => unit.id === other.id)!.box;
        const behind = entry.sign > 0 ? min(otherBox, entry.axis) < min(box, entry.axis) : max(otherBox, entry.axis) > max(box, entry.axis);
        if (behind && perpendicular(box, otherBox, entry.axis)) carried = Math.max(carried, final.get(other.id) ?? 0);
      }
      final.set(entry.id, entry.base + carried);
    }
    for (const entry of order) {
      const offset = new THREE.Vector3();
      offset.setComponent(entry.axis, entry.sign * final.get(entry.id)!);
      moves.set(entry.id, { offset, depth: groupDepth });
      maxDepth = Math.max(maxDepth, groupDepth);
    }
  };

  // Deepest sub-assemblies first, then outward; the root level last.
  const assemblies = model.parts.filter(part => children.get(part.id)?.length).sort((a, b) => depth(b) - depth(a));
  for (const part of assemblies) explodeGroup({ id: part.id, box: boxes.get(part.id)! }, children.get(part.id)!, depth(part) + 1);
  // Root level: the largest root assembly stays, the other roots move away from it.
  const roots = children.get(null) ?? [];
  if (roots.length > 1) {
    const anchor = roots.reduce((largest, part) => volume(subtree(part)) > volume(subtree(largest)) ? part : largest);
    explodeGroup({ id: anchor.id, box: subtree(anchor) }, roots.filter(part => part !== anchor), 0);
  }
  return { moves, maxDepth };
}

/** Progress of one group: outer groups expand first and collapse last. */
export function groupProgress(amount: number, depth: number, maxDepth: number): number {
  return THREE.MathUtils.clamp(amount * (maxDepth + 1) - depth, 0, 1);
}

/** World-space translation of every part (accumulated through its ancestors) at a given amount. */
export function explodedOffsets(model: ModelSpec, plan: ExplodePlan, amount: number): Map<string, THREE.Vector3> {
  const byId = new Map(model.parts.map(part => [part.id, part]));
  const result = new Map<string, THREE.Vector3>();
  const resolve = (part: Part): THREE.Vector3 => {
    const known = result.get(part.id);
    if (known) return known;
    const parent = part.parentId ? byId.get(part.parentId) : undefined;
    const total = parent ? resolve(parent).clone() : new THREE.Vector3();
    const move = plan.moves.get(part.id);
    if (move) total.addScaledVector(move.offset, groupProgress(amount, move.depth, plan.maxDepth));
    result.set(part.id, total);
    return total;
  };
  model.parts.forEach(resolve);
  return result;
}
