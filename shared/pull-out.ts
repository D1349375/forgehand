import * as THREE from 'three';
import { z } from 'zod';
import { objectMatrix } from './assembly';
import { objectBox, worldMatrices } from './bounds';
import { ObjectIdSchema } from './ids';
import type { JointSide } from './joint';
import { validateModel, type ModelSpec, type Part } from './model';
import {
  MAX_OBJECTS, WorkspaceError, assertWorkspace, findObject,
  type ObjectChange, type ObjectTransform, type SceneObject, type Workspace, type WorkspaceSelection,
} from './workspace';

/**
 * Pull-out (workbench-ui requirements 40 to 50, design 3): takes a part and its
 * descendants out of an object into a new object, exactly where they were, or
 * next to the original. Pure code that uses only Three.js math classes, so the
 * browser and the server's agent loop get the same workspace.
 *
 * `shared/workspace.ts` calls `pullOutPart` from `applyWorkspaceChange` and this
 * module imports workspace values back, so the two modules import each other.
 * That is safe because nothing here reads a workspace export while the module
 * loads: every use sits inside a function body.
 */

const POSITION_LIMIT = 100;
const ZERO = { x: 0, y: 0, z: 0 } as const;
const EMPTY_SELECTION: WorkspaceSelection = { objectId: null, partIds: [] };
const createdAtSchema = z.iso.datetime();

// + 0 turns -0 into 0.
const round5 = (value: number) => Math.round(value * 1e5) / 1e5 + 0;
const round2 = (value: number) => Math.round(value * 1e2) / 1e2 + 0;

/** `partId` and every descendant, in model order. Empty for an unknown part. */
export function subtreeIds(model: ModelSpec, partId: string): string[] {
  if (!model.parts.some(part => part.id === partId)) return [];
  const children = new Map<string, string[]>();
  for (const part of model.parts) {
    if (part.parentId === null) continue;
    const list = children.get(part.parentId);
    if (list) list.push(part.id);
    else children.set(part.parentId, [part.id]);
  }
  const inside = new Set<string>([partId]);
  const queue = [partId];
  for (let at = 0; at < queue.length; at++) {
    for (const child of children.get(queue[at]!) ?? []) {
      if (inside.has(child)) continue;
      inside.add(child);
      queue.push(child);
    }
  }
  return model.parts.filter(part => inside.has(part.id)).map(part => part.id);
}

export type PullOutCheck =
  | { ok: true; partIds: string[]; inPlace: boolean }
  | { ok: false; code: 'UNKNOWN_OBJECT' | 'UNKNOWN_PART' | 'WHOLE_OBJECT' | 'OBJECT_LIMIT' };

/**
 * Whether part `partId` of object `objectId` can be pulled out now, and whether it
 * would stay in place because a joint links the subtree to something outside it
 * (requirement 42). The first failing reason wins, in the order object, part,
 * whole object, object limit.
 */
export function pullOutCheck(ws: Workspace, objectId: string, partId: string): PullOutCheck {
  const object = findObject(ws, objectId);
  if (!object) return { ok: false, code: 'UNKNOWN_OBJECT' };
  const partIds = subtreeIds(object.model, partId);
  if (partIds.length === 0) return { ok: false, code: 'UNKNOWN_PART' };
  if (partIds.length === object.model.parts.length) return { ok: false, code: 'WHOLE_OBJECT' };
  if (ws.objects.length >= MAX_OBJECTS) return { ok: false, code: 'OBJECT_LIMIT' };
  const inside = new Set(partIds);
  const inSubtree = (side: JointSide) => side.objectId === objectId && inside.has(side.partId);
  const inPlace = ws.joints.some(joint => inSubtree(joint.a) !== inSubtree(joint.b));
  return { ok: true, partIds, inPlace };
}

export interface PullOutInput {
  objectId: string;
  partId: string;
  newObjectId: string;
  createdAt: string;
  /** Forces the new object to stay where the subtree was, as a joint to the rest would. */
  inPlace?: true;
}

/** The three-axis rotation of a matrix in XYZ Euler degrees, rounded to 2 decimals like `transformOfMatrix`. */
function rotationDegrees(matrix: THREE.Matrix4): Part['rotation'] {
  const quaternion = new THREE.Quaternion();
  matrix.decompose(new THREE.Vector3(), quaternion, new THREE.Vector3());
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  return {
    x: round2(THREE.MathUtils.radToDeg(euler.x)),
    y: round2(THREE.MathUtils.radToDeg(euler.y)),
    z: round2(THREE.MathUtils.radToDeg(euler.z)),
  };
}

/**
 * The new object exactly where the subtree is, and the original without it
 * (requirements 40, 41). The new object keeps the original's rotation; its
 * position is the subtree root's origin in the world, and the root part gets
 * position (0, 0, 0) and its model-frame rotation. Does not check the object
 * limit or the id in use; `pullOutPart` does. Throws `WorkspaceError`.
 */
export function pulledObject(ws: Workspace, input: PullOutInput): { original: SceneObject; pulled: SceneObject } {
  const object = findObject(ws, input.objectId);
  if (!object) throw new WorkspaceError('UNKNOWN_OBJECT');
  if (!ObjectIdSchema.safeParse(input.newObjectId).success || !createdAtSchema.safeParse(input.createdAt).success) {
    throw new WorkspaceError('INVALID_WORKSPACE');
  }
  const partIds = subtreeIds(object.model, input.partId);
  if (partIds.length === 0) throw new WorkspaceError('UNKNOWN_PART');
  if (partIds.length === object.model.parts.length) throw new WorkspaceError('WHOLE_OBJECT');
  const inside = new Set(partIds);
  const root = object.model.parts.find(part => part.id === input.partId)!;

  const modelMatrix = worldMatrices(object.model).get(root.id)!;
  const origin = new THREE.Vector3().setFromMatrixPosition(objectMatrix(object.transform).multiply(modelMatrix));
  // A root part already is in the model frame: keep its own angles instead of decomposing them again.
  const rotation = root.parentId === null ? root.rotation : rotationDegrees(modelMatrix);
  const rerooted: Part = { ...root, parentId: null, position: { ...ZERO }, rotation };

  let model: ModelSpec;
  try {
    model = validateModel({
      schemaVersion: object.model.schemaVersion,
      units: object.model.units,
      name: root.name,
      summary: `從「${object.model.name}」拉出的零件。`.slice(0, 2000),
      assumptions: [],
      parts: object.model.parts.filter(part => inside.has(part.id)).map(part => (part === root ? rerooted : part)),
    });
  } catch {
    throw new WorkspaceError('INVALID_WORKSPACE');
  }

  const pulled: SceneObject = {
    id: input.newObjectId,
    model,
    transform: { position: { x: round5(origin.x), y: round5(origin.y), z: round5(origin.z) }, rotation: object.transform.rotation },
    source: object.source,
    providerModel: object.providerModel,
    edited: true,
    createdAt: input.createdAt,
    material: object.material,
  };
  const original: SceneObject = {
    ...object,
    model: { ...object.model, parts: object.model.parts.filter(part => !inside.has(part.id)) },
    edited: true,
  };
  return { original, pulled };
}

/**
 * Transform for `pulled` next to `original` (already without the subtree), avoiding
 * the boxes of `others` (every object but those two). Tries right, left, front and
 * back of the original along world X and Z; when all of them overlap something, goes
 * past the right edge of every box, as `placeBeside` does. Height and rotation never change.
 */
export function placeNextTo(others: readonly SceneObject[], original: SceneObject, pulled: SceneObject): ObjectTransform {
  const box = objectBox(pulled.model, pulled.transform);
  const base = objectBox(original.model, original.transform);
  const otherBoxes = others.map(object => objectBox(object.model, object.transform));
  const gap = Math.max(0.02, 0.1 * (box.max.x - box.min.x));
  const { position, rotation } = pulled.transform;

  const candidates: ReadonlyArray<{ axis: 'x' | 'z'; delta: number }> = [
    { axis: 'x', delta: base.max.x + gap - box.min.x },
    { axis: 'x', delta: base.min.x - gap - box.max.x },
    { axis: 'z', delta: base.max.z + gap - box.min.z },
    { axis: 'z', delta: base.min.z - gap - box.max.z },
  ];
  for (const { axis, delta } of candidates) {
    const next = round5(position[axis] + delta);
    if (Math.abs(next) > POSITION_LIMIT) continue;
    const shift = new THREE.Vector3().setComponent(axis === 'x' ? 0 : 2, next - position[axis]);
    const moved = box.clone().translate(shift);
    if (otherBoxes.some(other => other.intersectsBox(moved))) continue;
    return { position: { ...position, [axis]: next }, rotation };
  }

  const right = Math.max(base.max.x, ...otherBoxes.map(other => other.max.x));
  const x = round5(Math.min(POSITION_LIMIT, Math.max(-POSITION_LIMIT, position.x + right + gap - box.min.x)));
  return { position: { ...position, x }, rotation };
}

/**
 * Pulls a part and its descendants out of an object into a new object, as one pure
 * step (requirements 40 to 47): the new object is inserted right after the original,
 * joints on the moved parts follow them, the original stays active, and the pulled
 * parts leave the selection. Throws `WorkspaceError`: `UNKNOWN_OBJECT`, `UNKNOWN_PART`,
 * `WHOLE_OBJECT`, `OBJECT_LIMIT`, `DUPLICATE_OBJECT`, or `INVALID_WORKSPACE` for an id,
 * a time or a position that the workspace rules reject.
 */
export function pullOutPart(ws: Workspace, input: PullOutInput): Workspace {
  const check = pullOutCheck(ws, input.objectId, input.partId);
  if (!check.ok) throw new WorkspaceError(check.code);
  if (findObject(ws, input.newObjectId)) throw new WorkspaceError('DUPLICATE_OBJECT');

  const { original, pulled: inPlace } = pulledObject(ws, input);
  const stays = check.inPlace || input.inPlace === true;
  const pulled: SceneObject = stays
    ? inPlace
    : { ...inPlace, transform: placeNextTo(ws.objects.filter(object => object.id !== original.id), original, inPlace) };

  const inside = new Set(check.partIds);
  const moves = (side: JointSide) => side.objectId === input.objectId && inside.has(side.partId);
  let jointsChanged = false;
  const rejoined = ws.joints.map(joint => {
    if (!moves(joint.a) && !moves(joint.b)) return joint;
    jointsChanged = true;
    return {
      ...joint,
      a: moves(joint.a) ? { ...joint.a, objectId: pulled.id } : joint.a,
      b: moves(joint.b) ? { ...joint.b, objectId: pulled.id } : joint.b,
    };
  });

  let selection = ws.selection;
  if (selection.objectId === input.objectId) {
    const kept = selection.partIds.filter(partId => !inside.has(partId));
    if (kept.length !== selection.partIds.length) {
      selection = kept.length > 0 ? { objectId: input.objectId, partIds: kept } : EMPTY_SELECTION;
    }
  }

  const objects = ws.objects.flatMap(object => (object.id === input.objectId ? [original, pulled] : [object]));
  const result: Workspace = { ...ws, objects, joints: jointsChanged ? rejoined : ws.joints, selection };
  assertWorkspace(result);
  return result;
}

/**
 * For a planned joint whose sides are parts of one object (requirement 50): pulls out
 * in place the side whose part is not an ancestor of the other side's part (side b when
 * neither is), and returns the workspace with both sides re-pointed and the object change
 * that did it. Returns `null` when the sides are in different objects. Pulling that side
 * never takes the whole object, because the other side stays. Throws `WorkspaceError`:
 * `UNKNOWN_OBJECT`, `UNKNOWN_PART`, `INVALID_JOINT` (both sides name one part) and the
 * errors of `pullOutPart`, among them `OBJECT_LIMIT`.
 */
export function splitForJoin(
  ws: Workspace, a: JointSide, b: JointSide, ids: { newObjectId: string; createdAt: string },
): { ws: Workspace; a: JointSide; b: JointSide; pulled: 'a' | 'b'; change: Extract<ObjectChange, { op: 'pull-out' }> } | null {
  if (a.objectId !== b.objectId) return null;
  const object = findObject(ws, a.objectId);
  if (!object) throw new WorkspaceError('UNKNOWN_OBJECT');
  const known = new Set(object.model.parts.map(part => part.id));
  if (!known.has(a.partId) || !known.has(b.partId)) throw new WorkspaceError('UNKNOWN_PART');
  if (a.partId === b.partId) throw new WorkspaceError('INVALID_JOINT');

  const pulled: 'a' | 'b' = subtreeIds(object.model, b.partId).includes(a.partId) ? 'a' : 'b';
  const change = {
    op: 'pull-out' as const,
    objectId: a.objectId,
    partId: pulled === 'a' ? a.partId : b.partId,
    newObjectId: ids.newObjectId,
    createdAt: ids.createdAt,
    inPlace: true as const,
  };
  const next = pullOutPart(ws, change);
  return {
    ws: next,
    a: pulled === 'a' ? { ...a, objectId: ids.newObjectId } : a,
    b: pulled === 'b' ? { ...b, objectId: ids.newObjectId } : b,
    pulled,
    change,
  };
}
