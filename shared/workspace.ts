import { z } from 'zod';
import { modelBox, objectBox } from './bounds';
import { ModelSpecSchema, PartIdSchema, validateModel, type ModelSpec } from './model';

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

export const WORKSPACE_VERSION = 1;
export const MAX_OBJECTS = 8;

export const ObjectIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
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
  | 'INVALID_WORKSPACE' | 'OBJECT_LIMIT' | 'UNKNOWN_OBJECT' | 'DUPLICATE_OBJECT' | 'INVALID_SELECTION';

const MESSAGES: Record<WorkspaceErrorCode, string> = {
  INVALID_WORKSPACE: '工作區資料無效。',
  OBJECT_LIMIT: `工作區最多 ${MAX_OBJECTS} 個物件，請先刪除一個物件。`,
  UNKNOWN_OBJECT: '找不到指定的物件。',
  DUPLICATE_OBJECT: '工作區內已有相同編號的物件。',
  INVALID_SELECTION: '選取的零件無效。',
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
}

/**
 * Trust-boundary entry point: parses the schema, validates every model and
 * checks the workspace rules. Returns a copy. Failures are `WorkspaceError`s
 * with fixed messages; schema and model error text is never passed on.
 */
export function validateWorkspace(input: unknown): Workspace {
  const parsed = WorkspaceSchema.safeParse(input);
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
  return checked({ ...ws, objects: ws.objects.map(object => (object === current ? next : object)), selection });
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
  if (ws.activeObjectId !== id) return checked({ ...ws, objects });
  const next = objects[index - 1] ?? objects[0] ?? null;
  return checked({
    ...ws,
    objects,
    activeObjectId: next?.id ?? null,
    selection: EMPTY_SELECTION,
    display: { explode: 0 },
  });
}

const sameVector = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * Merges the given position and/or rotation into an object's transform.
 * Throws `INVALID_WORKSPACE` for values outside the transform limits.
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
  const next: SceneObject = { ...current, transform };
  return checked({ ...ws, objects: ws.objects.map(object => (object === current ? next : object)) });
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
]);

export const WorkspaceChangeSchema = z.strictObject({
  activeObjectId: ObjectIdSchema.nullable(), // null = no change; applied first, must name an existing object
  object: ObjectChangeSchema.nullable(), // at most one object change
  selection: WorkspaceSelectionSchema.nullable(), // null = no change
  explode: z.number().min(0).max(1).nullable(), // null = no change
});

export type ObjectChange = z.infer<typeof ObjectChangeSchema>;
export type WorkspaceChange = z.infer<typeof WorkspaceChangeSchema>;

/**
 * Applies a change in the order activation, object, selection, explode.
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
    else after = removeObject(after, op.objectId);
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
