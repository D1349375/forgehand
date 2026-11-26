import { z } from 'zod';
import { assemblyOf, moveRigid } from './assembly';
import { modelBox, objectBox } from './bounds';
import { ObjectIdSchema } from './ids';
import { JointSchema, MAX_JOINTS, faceAllows, faceShape, type Joint, type JointMethod, type JointNeeds } from './joint';
import { MaterialIdSchema, type MaterialId } from './materials';
import { ModelSpecSchema, PartIdSchema, validateModel, type ModelSpec } from './model';
import { pullOutPart } from './pull-out';

/**
 * Workspace: a plain, versioned JSON value holding several model objects, the
 * active object, the part selection and the explode amount. Pure code only;
 * the browser and the server's agent loop use the same functions.
 *
 * Models enter a workspace only through `validateModel` (`createObject`,
 * `validateWorkspace`, and the operations that take a model). `assertWorkspace`
 * therefore checks the workspace's own rules and never copies or re-parses, so
 * unchanged objects keep their references between versions.
 */

export const WORKSPACE_VERSION = 2;
export const MAX_OBJECTS = 8;

/** Moved to shared/ids.ts; re-exported so every existing import keeps working. */
export { ObjectIdSchema };
const vector = (limit: number) => z.strictObject({
  x: z.number().min(-limit).max(limit),
  y: z.number().min(-limit).max(limit),
  z: z.number().min(-limit).max(limit),
});

const POSITION_LIMIT = 100;
const ROTATION_LIMIT = 360;

export const ObjectTransformSchema = z.strictObject({
  position: vector(POSITION_LIMIT), // metres, same limit as Part.position
  rotation: vector(ROTATION_LIMIT), // degrees, XYZ Euler, same limit as Part.rotation
});

export const SceneObjectSchema = z.strictObject({
  id: ObjectIdSchema,
  model: ModelSpecSchema, // the object's name is model.name
  transform: ObjectTransformSchema,
  source: z.string().min(1).max(100), // provider name or 'demo'
  providerModel: z.string().min(1).max(100),
  edited: z.boolean(),
  createdAt: z.iso.datetime(),
  // An object that arrives without a material (an old state event, a version-1 workspace) reads as null.
  material: MaterialIdSchema.nullable().default(null),
});

export const WorkspaceSelectionSchema = z.strictObject({
  objectId: ObjectIdSchema.nullable(),
  partIds: z.array(PartIdSchema).max(64),
});

export const WorkspaceSchema = z.strictObject({
  version: z.literal(WORKSPACE_VERSION),
  objects: z.array(SceneObjectSchema).max(MAX_OBJECTS),
  activeObjectId: ObjectIdSchema.nullable(),
  selection: WorkspaceSelectionSchema,
  display: z.strictObject({ explode: z.number().min(0).max(1) }),
  joints: z.array(JointSchema).max(MAX_JOINTS),
});

export type ObjectTransform = z.infer<typeof ObjectTransformSchema>;
export type SceneObject = z.infer<typeof SceneObjectSchema>;
export type WorkspaceSelection = z.infer<typeof WorkspaceSelectionSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;

const freezeTransform = (transform: ObjectTransform): ObjectTransform => {
  Object.freeze(transform.position);
  Object.freeze(transform.rotation);
  return Object.freeze(transform);
};

/** Position and rotation of zero. Frozen; copy it before changing anything. */
export const ZERO_TRANSFORM: ObjectTransform = freezeTransform({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
});

export type WorkspaceErrorCode =
  | 'INVALID_WORKSPACE' | 'OBJECT_LIMIT' | 'UNKNOWN_OBJECT' | 'DUPLICATE_OBJECT' | 'INVALID_SELECTION'
  | 'JOINT_LIMIT' | 'UNKNOWN_JOINT' | 'INVALID_JOINT' | 'CANNOT_ALIGN' | 'LINKED' | 'UNKNOWN_PART' | 'WHOLE_OBJECT';

const MESSAGES: Record<WorkspaceErrorCode, string> = {
  INVALID_WORKSPACE: '工作區資料無效。',
  OBJECT_LIMIT: `工作區最多 ${MAX_OBJECTS} 個物件，請先刪除一個物件。`,
  UNKNOWN_OBJECT: '找不到指定的物件。',
  DUPLICATE_OBJECT: '工作區內已有相同編號的物件。',
  INVALID_SELECTION: '選取的零件無效。',
  JOINT_LIMIT: `工作區最多 ${MAX_JOINTS} 個接合，請先刪除一個接合。`,
  UNKNOWN_JOINT: '找不到指定的接合。',
  INVALID_JOINT: '接合資料無效。',
  CANNOT_ALIGN: '兩個面的方向差太多，請先旋轉物件。',
  LINKED: '這兩個物件還透過其他接合相連，無法單獨對齊。',
  UNKNOWN_PART: '找不到指定的零件。',
  WHOLE_OBJECT: '這個零件連同子零件就是整個物件，不需要拉出。',
};

/** Workspace failure. The message is fixed Traditional Chinese text without ids. */
export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode) {
    super(MESSAGES[code]);
    this.name = 'WorkspaceError';
  }
}

export function emptyWorkspace(): Workspace {
  return {
    version: WORKSPACE_VERSION,
    objects: [],
    activeObjectId: null,
    selection: { objectId: null, partIds: [] },
    display: { explode: 0 },
    joints: [],
  };
}

export function findObject(ws: Workspace, id: string): SceneObject | null {
  return ws.objects.find(object => object.id === id) ?? null;
}

export function activeObject(ws: Workspace): SceneObject | null {
  return ws.activeObjectId === null ? null : findObject(ws, ws.activeObjectId);
}

const inRange = (value: number, limit: number) => Number.isFinite(value) && value >= -limit && value <= limit;
const vectorInRange = (v: { x: number; y: number; z: number }, limit: number) =>
  inRange(v.x, limit) && inRange(v.y, limit) && inRange(v.z, limit);

/**
 * Checks every workspace rule and throws `WorkspaceError` on the first
 * violation. Does not copy and does not re-validate models.
 */
export function assertWorkspace(ws: Workspace): void {
  if (ws.version !== WORKSPACE_VERSION) throw new WorkspaceError('INVALID_WORKSPACE');
  if (ws.objects.length > MAX_OBJECTS) throw new WorkspaceError('OBJECT_LIMIT');
  const ids = new Set<string>();
  for (const object of ws.objects) {
    if (ids.has(object.id)) throw new WorkspaceError('DUPLICATE_OBJECT');
    ids.add(object.id);
    const { position, rotation } = object.transform;
    if (!vectorInRange(position, POSITION_LIMIT) || !vectorInRange(rotation, ROTATION_LIMIT)) {
      throw new WorkspaceError('INVALID_WORKSPACE');
    }
  }
  if (ws.objects.length === 0) {
    if (ws.activeObjectId !== null) throw new WorkspaceError('INVALID_WORKSPACE');
  } else {
    if (ws.activeObjectId === null) throw new WorkspaceError('INVALID_WORKSPACE');
    if (!ids.has(ws.activeObjectId)) throw new WorkspaceError('UNKNOWN_OBJECT');
  }

  const { objectId, partIds } = ws.selection;
  if (objectId === null) {
    if (partIds.length > 0) throw new WorkspaceError('INVALID_SELECTION');
  } else {
    if (objectId !== ws.activeObjectId) throw new WorkspaceError('INVALID_SELECTION');
    const object = findObject(ws, objectId);
    if (!object) throw new WorkspaceError('INVALID_SELECTION');
    const known = new Set(object.model.parts.map(part => part.id));
    const seen = new Set<string>();
    for (const id of partIds) {
      if (!known.has(id) || seen.has(id)) throw new WorkspaceError('INVALID_SELECTION');
      seen.add(id);
    }
  }

  const explode = ws.display.explode;
  if (!Number.isFinite(explode) || explode < 0 || explode > 1) throw new WorkspaceError('INVALID_WORKSPACE');
  if (ws.objects.length === 0 && explode !== 0) throw new WorkspaceError('INVALID_WORKSPACE');

  assertJoints(ws);
}

/**
 * Joint rules (design 3.3). Whether the faces touch is deliberately not checked:
 * moving or editing an object never makes the workspace invalid.
 */
function assertJoints(ws: Workspace): void {
  if (ws.joints.length > MAX_JOINTS) throw new WorkspaceError('JOINT_LIMIT');
  const objects = new Map(ws.objects.map(object => [object.id, object]));
  const jointIds = new Set<string>();
  const pairs = new Set<string>();
  for (const joint of ws.joints) {
    if (jointIds.has(joint.id)) throw new WorkspaceError('INVALID_JOINT');
    jointIds.add(joint.id);
    for (const side of [joint.a, joint.b]) {
      const part = objects.get(side.objectId)?.model.parts.find(candidate => candidate.id === side.partId);
      if (!part) throw new WorkspaceError('INVALID_JOINT');
      const shape = faceShape(part.primitive, side.face);
      if (shape === null || !faceAllows(shape, joint.method)) throw new WorkspaceError('INVALID_JOINT');
    }
    if (joint.a.objectId === joint.b.objectId && joint.a.partId === joint.b.partId) throw new WorkspaceError('INVALID_JOINT');
    const key = [joint.a, joint.b].map(side => `${side.objectId}|${side.partId}|${side.face}`).sort().join('~');
    if (pairs.has(key)) throw new WorkspaceError('INVALID_JOINT');
    pairs.add(key);
  }
}

/**
 * Turns a version-1 workspace into version 2: `joints: []` and `material: null`
 * on every object. Version-2 and unrecognised input is returned unchanged, so
 * `validateWorkspace` rejects any other version. Never mutates its input.
 */
export function migrateWorkspace(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.version !== 1) return input;
  const objects = Array.isArray(record.objects)
    ? record.objects.map(object => (typeof object === 'object' && object !== null && !Array.isArray(object) ? { material: null, ...object } : object))
    : record.objects;
  return { ...record, version: 2, objects, joints: [] };
}

/**
 * Trust-boundary entry point: migrates version 1, parses the schema, validates
 * every model and checks the workspace rules. Returns a copy. Failures are
 * `WorkspaceError`s with fixed messages; schema and model error text is never
 * passed on.
 */
export function validateWorkspace(input: unknown): Workspace {
  const parsed = WorkspaceSchema.safeParse(migrateWorkspace(input));
  if (!parsed.success) throw new WorkspaceError('INVALID_WORKSPACE');
  let ws: Workspace;
  try {
    ws = { ...parsed.data, objects: parsed.data.objects.map(object => ({ ...object, model: validateModel(object.model) })) };
  } catch {
    throw new WorkspaceError('INVALID_WORKSPACE');
  }
  assertWorkspace(ws);
  return ws;
}

const round5 = (value: number) => Math.round(value * 1e5) / 1e5;

/**
 * Transform for a new object: beside the existing ones, never overlapping
 * them. The first object sits at the origin. Others start `gap` metres past
 * the right edge (largest max X) of the existing object boxes.
 */
export function placeBeside(objects: readonly SceneObject[], model: ModelSpec): ObjectTransform {
  if (objects.length === 0) return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
  const right = Math.max(...objects.map(object => objectBox(object.model, object.transform).max.x));
  const box = modelBox(model);
  const gap = Math.max(0.02, 0.1 * (box.max.x - box.min.x));
  const x = round5(Math.min(POSITION_LIMIT, Math.max(-POSITION_LIMIT, right + gap - box.min.x)));
  return { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
}

export interface NewObjectInput {
  id: string;
  model: unknown;
  source: string;
  providerModel: string;
  createdAt: string;
}

/**
 * Builds a validated object placed beside the existing ones. It does not check
 * the object limit or the id; `addObject` does.
 */
export function createObject(ws: Workspace, input: NewObjectInput): SceneObject {
  const model = validateModel(input.model);
  return {
    id: input.id,
    model,
    transform: placeBeside(ws.objects, model),
    source: input.source,
    providerModel: input.providerModel,
    edited: false,
    createdAt: input.createdAt,
    material: null,
  };
}

// ---------------------------------------------------------------------------
// Part 2: operations (design 2.3) and changes (design 2.4).
//
// Every operation is pure, never mutates its input, returns the same reference
// when nothing changes, keeps the references of unchanged objects, and runs
// `assertWorkspace` on the workspace it returns.
// ---------------------------------------------------------------------------

const EMPTY_SELECTION: WorkspaceSelection = { objectId: null, partIds: [] };

/** Validates an incoming model. Fixed error: validator messages can contain part ids. */
function checkedModel(input: unknown): ModelSpec {
  try {
    return validateModel(input);
  } catch {
    throw new WorkspaceError('INVALID_WORKSPACE');
  }
}

function checked(ws: Workspace): Workspace {
  assertWorkspace(ws);
  return ws;
}

function requireObject(ws: Workspace, id: string): SceneObject {
  const object = findObject(ws, id);
  if (!object) throw new WorkspaceError('UNKNOWN_OBJECT');
  return object;
}

const createdAtSchema = SceneObjectSchema.shape.createdAt;

/**
 * Adds an object and makes it active: clears the selection and resets explode.
 * Throws `INVALID_WORKSPACE` for an id or `createdAt` that fails the schema or
 * a model that fails `validateModel`, `OBJECT_LIMIT` at `MAX_OBJECTS` and
 * `DUPLICATE_OBJECT` for an id already in use.
 */
export function addObject(ws: Workspace, object: SceneObject): Workspace {
  if (!ObjectIdSchema.safeParse(object.id).success || !createdAtSchema.safeParse(object.createdAt).success) {
    throw new WorkspaceError('INVALID_WORKSPACE');
  }
  if (ws.objects.length >= MAX_OBJECTS) throw new WorkspaceError('OBJECT_LIMIT');
  if (findObject(ws, object.id)) throw new WorkspaceError('DUPLICATE_OBJECT');
  const added: SceneObject = { ...object, model: checkedModel(object.model) };
  return checked({
    ...ws,
    objects: [...ws.objects, added],
    activeObjectId: added.id,
    selection: EMPTY_SELECTION,
    display: { explode: 0 },
  });
}

/**
 * Replaces an object's model and marks it edited. `meta` keeps the current
 * `source` and `providerModel` when omitted (manual edits). If the object is
 * active, selected part ids that no longer exist are dropped.
 */
export function replaceModel(
  ws: Workspace, id: string, model: ModelSpec, meta: { source?: string; providerModel?: string } = {},
): Workspace {
  const current = requireObject(ws, id);
  const source = meta.source ?? current.source;
  const providerModel = meta.providerModel ?? current.providerModel;
  if (model === current.model && current.edited && source === current.source && providerModel === current.providerModel) return ws;
  const next: SceneObject = { ...current, model: model === current.model ? model : checkedModel(model), edited: true, source, providerModel };
  let selection = ws.selection;
  if (selection.objectId === id) {
    const known = new Set(next.model.parts.map(part => part.id));
    const kept = selection.partIds.filter(partId => known.has(partId));
    if (kept.length !== selection.partIds.length) selection = kept.length > 0 ? { objectId: id, partIds: kept } : EMPTY_SELECTION;
  }
  // Cascade: a joint ends when its part is gone, its face is no longer a contact face, or the face no longer allows its method.
  const stillValid = (joint: Joint) => [joint.a, joint.b].every(side => {
    if (side.objectId !== id) return true;
    const part = next.model.parts.find(candidate => candidate.id === side.partId);
    const shape = part ? faceShape(part.primitive, side.face) : null;
    return shape !== null && faceAllows(shape, joint.method);
  });
  const kept = ws.joints.filter(stillValid);
  const joints = kept.length === ws.joints.length ? ws.joints : kept;
  return checked({ ...ws, objects: ws.objects.map(object => (object === current ? next : object)), selection, joints });
}

/**
 * Removes an object. Removing the active object activates the one before it
 * (or the new first), clears the selection and resets explode. Removing the
 * last object gives an empty workspace.
 */
export function removeObject(ws: Workspace, id: string): Workspace {
  const index = ws.objects.findIndex(object => object.id === id);
  if (index < 0) throw new WorkspaceError('UNKNOWN_OBJECT');
  const objects = ws.objects.filter((_, at) => at !== index);
  const keptJoints = ws.joints.filter(joint => joint.a.objectId !== id && joint.b.objectId !== id);
  const joints = keptJoints.length === ws.joints.length ? ws.joints : keptJoints;
  if (ws.activeObjectId !== id) return checked({ ...ws, objects, joints });
  const next = objects[index - 1] ?? objects[0] ?? null;
  return checked({
    ...ws,
    objects,
    joints,
    activeObjectId: next?.id ?? null,
    selection: EMPTY_SELECTION,
    display: { explode: 0 },
  });
}

const sameVector = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * Merges the given position and/or rotation into an object's transform and
 * moves the object's whole assembly (`assemblyOf`) as one rigid body: every
 * other member gets the same change, so their placement relative to each other
 * and every joint between them is kept. An object without joints moves alone.
 * Members whose transform does not change keep their object reference.
 * Throws `INVALID_WORKSPACE` for values outside the transform limits, for the
 * object or for any member of its assembly; then nothing moves.
 */
export function setTransform(
  ws: Workspace, id: string, patch: { position?: ObjectTransform['position']; rotation?: ObjectTransform['rotation'] },
): Workspace {
  const current = requireObject(ws, id);
  const merged = ObjectTransformSchema.safeParse({
    position: patch.position ?? current.transform.position,
    rotation: patch.rotation ?? current.transform.rotation,
  });
  if (!merged.success) throw new WorkspaceError('INVALID_WORKSPACE');
  const positionSame = sameVector(merged.data.position, current.transform.position);
  const rotationSame = sameVector(merged.data.rotation, current.transform.rotation);
  if (positionSame && rotationSame) return ws;
  const transform: ObjectTransform = {
    position: positionSame ? current.transform.position : merged.data.position,
    rotation: rotationSame ? current.transform.rotation : merged.data.rotation,
  };
  const moves = moveRigid(ws, assemblyOf(ws, id), id, transform);
  if (!moves) throw new WorkspaceError('INVALID_WORKSPACE');
  const objects = ws.objects.map(object => {
    const moved = moves.get(object.id);
    if (!moved) return object;
    const { position, rotation } = object.transform;
    if (sameVector(moved.position, position) && sameVector(moved.rotation, rotation)) return object;
    return { ...object, transform: moved };
  });
  return checked({ ...ws, objects });
}

/** Makes an object active. Another object: clears the selection and resets explode. */
export function setActiveObject(ws: Workspace, id: string): Workspace {
  requireObject(ws, id);
  if (ws.activeObjectId === id) return ws;
  return checked({ ...ws, activeObjectId: id, selection: EMPTY_SELECTION, display: { explode: 0 } });
}

/**
 * Selects parts of an object, activating it first when it is not active.
 * An empty list clears the selection. Unknown or duplicate part ids throw
 * `INVALID_SELECTION`.
 */
export function selectParts(ws: Workspace, id: string, partIds: readonly string[]): Workspace {
  const activated = setActiveObject(ws, id);
  const object = requireObject(activated, id);
  const known = new Set(object.model.parts.map(part => part.id));
  const unique = new Set(partIds);
  if (unique.size !== partIds.length || partIds.some(partId => !known.has(partId))) throw new WorkspaceError('INVALID_SELECTION');
  const current = activated.selection;
  if (partIds.length === 0) {
    return current.objectId === null ? activated : checked({ ...activated, selection: EMPTY_SELECTION });
  }
  if (current.objectId === id && current.partIds.length === partIds.length && current.partIds.every((partId, at) => partId === partIds[at])) {
    return activated;
  }
  return checked({ ...activated, selection: { objectId: id, partIds: [...partIds] } });
}

/** Sets the explode amount (0 to 1). A workspace without objects only accepts 0. */
export function setExplode(ws: Workspace, amount: number): Workspace {
  if (ws.display.explode === amount) return ws;
  return checked({ ...ws, display: { explode: amount } });
}

// ---------------------------------------------------------------------------
// Materials and joints (assembly-joints design 3.5).
// ---------------------------------------------------------------------------

/**
 * Sets an object's material (`null` = 未指定). Does not mark the object edited.
 * Throws `INVALID_WORKSPACE` for a material that is not in the table.
 */
export function setMaterial(ws: Workspace, objectId: string, material: MaterialId | null): Workspace {
  const current = requireObject(ws, objectId);
  if (!MaterialIdSchema.nullable().safeParse(material).success) throw new WorkspaceError('INVALID_WORKSPACE');
  if ((current.material ?? null) === material) return ws;
  const next: SceneObject = { ...current, material };
  return checked({ ...ws, objects: ws.objects.map(object => (object === current ? next : object)) });
}

/**
 * Adds a joint. Throws `INVALID_JOINT` for a joint that fails the schema or a
 * workspace rule (unknown part, face that is not a contact face, method the
 * face does not allow, same part twice, duplicate id or side pair),
 * `JOINT_LIMIT` at `MAX_JOINTS` and `UNKNOWN_OBJECT` for a side whose object
 * does not exist. Does not check that the faces touch and does not move anything.
 */
export function addJoint(ws: Workspace, joint: Joint): Workspace {
  const parsed = JointSchema.safeParse(joint);
  if (!parsed.success) throw new WorkspaceError('INVALID_JOINT');
  if (ws.joints.length >= MAX_JOINTS) throw new WorkspaceError('JOINT_LIMIT');
  requireObject(ws, parsed.data.a.objectId);
  requireObject(ws, parsed.data.b.objectId);
  return checked({ ...ws, joints: [...ws.joints, parsed.data] });
}

const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = Object.entries(a);
  const right = Object.entries(b);
  return left.length === right.length && left.every(([key, value]) => key in b && sameJson(value, (b as Record<string, unknown>)[key]));
};

/**
 * Changes a joint's method, needs and/or `confirmed`. The sides never change:
 * a joint whose sides must change is removed and added again. Returns the same
 * workspace when nothing changes. `UNKNOWN_JOINT` for an unknown id,
 * `INVALID_JOINT` for a method or needs that fail the schema or the face rules.
 */
export function updateJoint(
  ws: Workspace, jointId: string,
  patch: { method?: JointMethod; needs?: Partial<JointNeeds>; confirmed?: boolean },
): Workspace {
  const current = ws.joints.find(joint => joint.id === jointId);
  if (!current) throw new WorkspaceError('UNKNOWN_JOINT');
  const needs: Record<string, unknown> = { ...current.needs };
  for (const [key, value] of Object.entries(patch.needs ?? {})) if (value !== undefined) needs[key] = value;
  const candidate = {
    ...current,
    method: patch.method ?? current.method,
    needs,
    confirmed: patch.confirmed ?? current.confirmed,
  };
  const parsed = JointSchema.safeParse(candidate);
  if (!parsed.success) throw new WorkspaceError('INVALID_JOINT');
  if (sameJson(parsed.data, current)) return ws;
  return checked({ ...ws, joints: ws.joints.map(joint => (joint === current ? parsed.data : joint)) });
}

/** Removes a joint. `UNKNOWN_JOINT` for an unknown id. The objects stay where they are. */
export function removeJoint(ws: Workspace, jointId: string): Workspace {
  if (!ws.joints.some(joint => joint.id === jointId)) throw new WorkspaceError('UNKNOWN_JOINT');
  return checked({ ...ws, joints: ws.joints.filter(joint => joint.id !== jointId) });
}

/**
 * Moves up to two objects (each through `setTransform`, so each with its
 * assembly) and then adds one joint, as one result and so one undo step. The
 * joint is added after the moves, so the new joint does not make the second
 * move drag the first object. `INVALID_JOINT` for more than two moves.
 */
export function joinObjects(
  ws: Workspace,
  input: { moves: ReadonlyArray<{ objectId: string; transform: ObjectTransform }>; joint: Joint },
): Workspace {
  if (input.moves.length > 2) throw new WorkspaceError('INVALID_JOINT');
  let next = ws;
  for (const move of input.moves) next = setTransform(next, move.objectId, move.transform);
  return addJoint(next, input.joint);
}

/** How many joints `before` has that `after` does not, for the cascade notice. */
export function jointsRemovedBy(before: Workspace, after: Workspace): number {
  const remaining = new Set(after.joints.map(joint => joint.id));
  return before.joints.filter(joint => !remaining.has(joint.id)).length;
}

export const ObjectChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), object: SceneObjectSchema }),
  z.strictObject({
    op: z.literal('model'),
    objectId: ObjectIdSchema,
    model: ModelSpecSchema,
    source: z.string().min(1).max(100),
    providerModel: z.string().min(1).max(100),
  }),
  z.strictObject({ op: z.literal('transform'), objectId: ObjectIdSchema, transform: ObjectTransformSchema }),
  z.strictObject({ op: z.literal('remove'), objectId: ObjectIdSchema }),
  z.strictObject({ op: z.literal('material'), objectId: ObjectIdSchema, material: MaterialIdSchema.nullable() }),
  // Takes a part and its descendants out into a new object (workbench-ui design 3.5); applied by `pullOutPart`.
  z.strictObject({
    op: z.literal('pull-out'),
    objectId: ObjectIdSchema,
    partId: PartIdSchema,
    newObjectId: ObjectIdSchema,
    createdAt: SceneObjectSchema.shape.createdAt,
    inPlace: z.literal(true).optional(),
  }),
]);

export const JointChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), joint: JointSchema }),
  z.strictObject({ op: z.literal('update'), joint: JointSchema }), // replaces method, needs and confirmed of the joint with this id
  z.strictObject({ op: z.literal('remove'), jointId: ObjectIdSchema }),
]);

export const WorkspaceChangeSchema = z.strictObject({
  activeObjectId: ObjectIdSchema.nullable(), // null = no change; applied first, must name an existing object
  object: ObjectChangeSchema.nullable(), // at most one object change
  joint: JointChangeSchema.nullable().optional(), // at most one joint change; absent or null = no change
  selection: WorkspaceSelectionSchema.nullable(), // null = no change
  explode: z.number().min(0).max(1).nullable(), // null = no change
});

export type ObjectChange = z.infer<typeof ObjectChangeSchema>;
export type JointChange = z.infer<typeof JointChangeSchema>;
export type WorkspaceChange = z.infer<typeof WorkspaceChangeSchema>;

const sameSide = (a: Joint['a'], b: Joint['b']) => a.objectId === b.objectId && a.partId === b.partId && a.face === b.face;

/**
 * Applies a change in the order activation, object, joint, selection, explode.
 * `before` is the workspace after the activation step (the undo snapshot for
 * a change that touches an object); `after` is the final workspace.
 */
export function applyWorkspaceChange(ws: Workspace, change: WorkspaceChange): { before: Workspace; after: Workspace } {
  const before = change.activeObjectId === null ? ws : setActiveObject(ws, change.activeObjectId);
  let after = before;
  const op = change.object;
  if (op) {
    if (op.op === 'add') after = addObject(after, op.object);
    else if (op.op === 'model') after = replaceModel(after, op.objectId, op.model, { source: op.source, providerModel: op.providerModel });
    else if (op.op === 'transform') after = setTransform(after, op.objectId, op.transform);
    else if (op.op === 'material') after = setMaterial(after, op.objectId, op.material);
    else if (op.op === 'pull-out') after = pullOutPart(after, op);
    else after = removeObject(after, op.objectId);
  }
  const jointOp = change.joint;
  if (jointOp) {
    if (jointOp.op === 'add') after = addJoint(after, jointOp.joint);
    else if (jointOp.op === 'update') {
      const { joint } = jointOp;
      const current = after.joints.find(candidate => candidate.id === joint.id);
      // `update` never changes the sides; an unknown id is reported by `updateJoint`.
      if (current && !(sameSide(current.a, joint.a) && sameSide(current.b, joint.b))) throw new WorkspaceError('INVALID_JOINT');
      after = updateJoint(after, joint.id, { method: joint.method, needs: joint.needs, confirmed: joint.confirmed });
    } else after = removeJoint(after, jointOp.jointId);
  }
  if (change.selection) {
    const { objectId, partIds } = change.selection;
    if (objectId !== null) after = selectParts(after, objectId, partIds);
    else if (partIds.length > 0) throw new WorkspaceError('INVALID_SELECTION');
    else if (after.selection.objectId !== null) after = checked({ ...after, selection: EMPTY_SELECTION });
  }
  if (change.explode !== null) after = setExplode(after, change.explode);
  return { before, after };
}
