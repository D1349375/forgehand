# Workspace v2 — Design

This design satisfies `requirements.md`. It follows the patterns `agent-harness` set up: Zod authority and pure functions in `shared/`, pure browser modules unit-tested in Node (no DOM), thin React wiring covered by Playwright, and one `defineTool` file per agent tool.

## 1. Approach

The single `DisplayModel` in `App.tsx` becomes a `Workspace` value: a plain, versioned JSON object with a list of `SceneObject`s, the active object id, the selection and the explode amount. Every change to it goes through a small set of pure operations in `shared/workspace.ts`. The browser and the server's agent loop call the same operations, so an agent change computed on the server and replayed in the browser gives the same workspace.

In the browser, a pure reducer (`src/workspace/store.ts`) holds the workspace and its undo/redo history. `App.tsx` dispatches to it instead of calling `setDisplay`, `setHistory`, `setSelected` and `setExplode`. `SceneViewport` receives the object list and renders each object in its own Three.js group, rebuilding only objects whose model changed.

On the server, the agent's working copy becomes a `Workspace`. Tools return a small `WorkspaceChange` (at most one object change, plus active object, selection and explode). The loop applies it with `applyWorkspaceChange` and streams the same change in the `state` event. The server creates ids, timestamps and placement for objects the agent adds; the browser adds exactly the object it receives.

## 2. Data model — `shared/workspace.ts`

### 2.1 Schemas

```ts
export const WORKSPACE_VERSION = 1;
export const MAX_OBJECTS = 8;

export const ObjectIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);   // crypto.randomUUID() fits
const vector = (limit: number) => z.strictObject({
  x: z.number().min(-limit).max(limit), y: z.number().min(-limit).max(limit), z: z.number().min(-limit).max(limit),
});

export const ObjectTransformSchema = z.strictObject({
  position: vector(100),   // metres, same limit as Part.position
  rotation: vector(360),   // degrees, XYZ Euler, same as Part.rotation
});                        // no scale (requirement: out of scope)

export const SceneObjectSchema = z.strictObject({
  id: ObjectIdSchema,
  model: ModelSpecSchema,                     // unchanged contract; the object's name is model.name
  transform: ObjectTransformSchema,
  source: z.string().min(1).max(100),         // provider name or 'demo', as DisplayModel.source
  providerModel: z.string().min(1).max(100),
  edited: z.boolean(),                        // drives 「· 已修改」
  createdAt: z.iso.datetime(),                // ISO 8601, UTC
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

export type Workspace = z.infer<typeof WorkspaceSchema>;   // and SceneObject, ObjectTransform, WorkspaceSelection
```

`PartIdSchema` moves to `shared/model.ts` as `export const PartIdSchema = PartSchema.shape.id`, so `workspace.ts` and `agent.ts` both use the part-id format without importing each other. `PartSchema` itself is not touched, so the JSON schema sent to the model back ends is byte-for-byte the same. `shared/agent.ts` keeps re-exporting `PartIdSchema`.

Session state stays out of the workspace (requirement 11): undo history, try-on, camera, transform mode, request timing, dialogs. The `requestId` and `startedAt` fields of today's `DisplayModel` become an App-local timing ref (§5.1).

### 2.2 Validation

Two entry points share one rule set:

- `validateWorkspace(input: unknown): Workspace` — used at trust boundaries (the `/api/agent` request today; loading a saved project in `projects-memory` later). It parses `WorkspaceSchema`, runs `validateModel` on every model, then calls `assertWorkspace`. It returns a new copy.
- `assertWorkspace(workspace: Workspace): void` — the invariant check without copying, used by every operation on its result:
  - object ids unique;
  - `objects.length <= MAX_OBJECTS`;
  - `activeObjectId === null` exactly when `objects` is empty, otherwise an existing id;
  - `selection.objectId` is `null` (then `partIds` is empty) or equals `activeObjectId`, and every part id exists in that object's model, without duplicates;
  - `display.explode` within 0–1, and 0 when there are no objects;
  - transforms within range.

Models enter a workspace only through `validateModel` (inside `createObject`, `addObject`, `replaceModel` and `validateWorkspace`), so `assertWorkspace` does not re-validate them. Not copying matters: `SceneViewport` decides what to rebuild by comparing model references (§4), and the undo history shares unchanged objects between snapshots (requirement 61). A Zod `parse` on every change would copy every model and rebuild the whole scene each time.

Failures throw `WorkspaceError { code, message }` with `code` one of `INVALID_WORKSPACE`, `OBJECT_LIMIT`, `UNKNOWN_OBJECT`, `DUPLICATE_OBJECT`, `INVALID_SELECTION`. Messages are fixed Traditional Chinese and contain no ids, so callers can show them or replace them as they need. The limit message is `工作區最多 8 個物件，請先刪除一個物件。` (built from `MAX_OBJECTS`).

### 2.3 Operations

All pure; none mutates its input. Each returns the same reference when nothing changes, a new workspace otherwise, and calls `assertWorkspace` on the result. Unchanged objects keep their references.

```ts
emptyWorkspace(): Workspace
activeObject(ws): SceneObject | null
findObject(ws, id): SceneObject | null

/** Builds a new object placed beside the existing ones (§2.5). Id and timestamp are passed in. */
createObject(ws, input: { id; model; source; providerModel; createdAt }): SceneObject   // edited: false
addObject(ws, object): Workspace          // OBJECT_LIMIT, DUPLICATE_OBJECT; makes it active, clears selection, explode 0
replaceModel(ws, id, model, meta?: { source?; providerModel? }): Workspace
                                          // edited: true; meta keeps the current values when omitted (manual edits);
                                          // if id is active, drops selected ids that no longer exist
removeObject(ws, id): Workspace           // active removed → the object before it (or the new first) becomes active,
                                          // selection cleared, explode 0; last object → emptyWorkspace() fields
setTransform(ws, id, patch: { position?; rotation? }): Workspace
setActiveObject(ws, id): Workspace        // same id → unchanged; otherwise selection cleared, explode 0
selectParts(ws, id, partIds): Workspace   // id not active → setActiveObject first; [] → { objectId: null, partIds: [] }
setExplode(ws, amount): Workspace
```

Renaming is `replaceModel(ws, id, { ...model, name })`; there is no separate operation, because the name is `model.name` (decision 1).

### 2.4 Changes — `WorkspaceChange` and `applyWorkspaceChange`

The agent sends workspace changes, not whole workspaces. One schema, in `shared/workspace.ts`:

```ts
export const ObjectChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), object: SceneObjectSchema }),
  z.strictObject({ op: z.literal('model'), objectId: ObjectIdSchema, model: ModelSpecSchema,
                   source: z.string().min(1).max(100), providerModel: z.string().min(1).max(100) }),
  z.strictObject({ op: z.literal('transform'), objectId: ObjectIdSchema, transform: ObjectTransformSchema }),
  z.strictObject({ op: z.literal('remove'), objectId: ObjectIdSchema }),
]);

export const WorkspaceChangeSchema = z.strictObject({
  activeObjectId: ObjectIdSchema.nullable(),       // null = no change. Applied FIRST; must name an existing object.
  object: ObjectChangeSchema.nullable(),           // at most one object change
  selection: WorkspaceSelectionSchema.nullable(),  // null = no change
  explode: z.number().min(0).max(1).nullable(),    // null = no change
});

export function applyWorkspaceChange(ws: Workspace, change: WorkspaceChange): { before: Workspace; after: Workspace };
```

Order: `activeObjectId` (via `setActiveObject`) → `object` (`add` → `addObject`, `model` → `replaceModel`, `transform` → `setTransform`, `remove` → `removeObject`) → `selection` (via `selectParts`) → `explode` (via `setExplode`). `add` and `model` run `validateModel` on the incoming model.

`before` is the workspace after the activation step, `after` the final one. The browser records `before` as the undo snapshot when `object` is not null (§3.2). Activation first means the snapshot already has the object the agent is about to change as its active object, so undoing an agent edit of another object leaves that object active, with its old model. The server only uses `after`.

A tool that adds or removes an object leaves `activeObjectId` null: `addObject` and `removeObject` decide the active object themselves.

### 2.5 Bounds and placement — `shared/bounds.ts`

`worldMatrices(model)` and `partBoxes(model, offsets?)` move unchanged from `src/scene/explode.ts` to `shared/bounds.ts` (decision 5). They use only Three.js math classes (`Matrix4`, `Euler`, `Quaternion`, `Vector3`, `Box3`), which run in Node. `src/scene/explode.ts` imports them and re-exports both, so `tests/unit/explode.test.ts` and `SceneViewport.tsx` keep their imports. Two additions:

```ts
modelBox(model): THREE.Box3                       // union of partBoxes, in the model's own frame
objectBox(model, transform): THREE.Box3            // modelBox transformed by the object's position + rotation (AABB of the result)
```

Placement lives in `workspace.ts` (it needs `SceneObject`), as `placeBeside(objects, model): ObjectTransform`:

```
no objects            → position (0, 0, 0), rotation (0, 0, 0)       // the first object sits where models sit today
otherwise:
  right = max over objects of objectBox(o.model, o.transform).max.x
  box   = modelBox(model)
  gap   = max(0.02, 0.1 × (box.max.x − box.min.x))                    // metres
  x     = right + gap − box.min.x                                      // new box starts `gap` past the right edge
  position (round5(clamp(x, −100, 100)), 0, 0), rotation (0, 0, 0)
```

The new object's box starts at `right + gap` on X, so it cannot overlap any existing box. The clamp keeps the transform valid; reaching it would need eight objects tens of metres wide, and then overlap is accepted rather than failing the add. `createObject` calls `placeBeside`; the server (agent adds) and the browser (manual adds) both go through `createObject`, so placement has one implementation.

## 3. Browser state — `src/workspace/`

### 3.1 Store (`store.ts`, pure)

```ts
export const HISTORY_LIMIT = 50;
type Snapshot = Pick<Workspace, 'objects' | 'activeObjectId'>;     // decision 6
export interface WorkspaceState { workspace: Workspace; past: Snapshot[]; future: Snapshot[] }

export type WorkspaceAction =
  | { type: 'commit'; next: Workspace; before?: Workspace }   // an undo step; `before` defaults to the current workspace
  | { type: 'replace'; next: Workspace }                     // no undo step: activation, selection, explode, render fallback
  | { type: 'undo' } | { type: 'redo' };

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState;
export function restoreSnapshot(current: Workspace, snapshot: Snapshot): Workspace;
export const canUndo = (s: WorkspaceState) => s.past.length > 0;   // and canRedo
```

### 3.2 Undo rules

- `commit` with `next === state.workspace` is a no-op.
- `commit` pushes `snapshot(before ?? state.workspace)` onto `past` (keeping the latest 50) and clears `future`. **Exception (requirement 22):** when `before` has no objects and `past` is empty, nothing is pushed. This keeps 復原 disabled after the first 載入示範模型, which `explode.spec.ts`, `arm-try-on.spec.ts` and `edit-select.spec.ts` assert.
- `replace` sets the workspace and leaves the history alone.
- `undo` pushes the current snapshot onto `future` (latest 50), pops `past`, and sets `restoreSnapshot(current, popped)`. `redo` mirrors it.
- `restoreSnapshot` (requirement 21): objects and active id from the snapshot; selection keeps only part ids that exist in the restored active object, and only if the active object is unchanged; explode kept if the active object is unchanged, else 0.

Undo steps (requirement 19) are therefore exactly the `commit` dispatches; §5.1 lists which App paths commit and which replace.

### 3.3 Hook (`useWorkspace.ts`)

```ts
export function useWorkspace(): {
  workspace: Workspace; canUndo: boolean; canRedo: boolean;
  dispatch(action: WorkspaceAction): Workspace;   // returns the new workspace synchronously
  current(): Workspace;                          // latest value, for async callbacks
}
```

The state lives in a ref; `dispatch` runs the reducer on the ref, stores the result, and calls `setState` to render. That gives async code (an AI edit arriving, an agent event) the latest workspace synchronously, the way `currentDisplay.current` does today.

## 4. Scene — `src/scene/SceneViewport.tsx`

### 4.1 Props

```ts
export interface SceneObjectInput { id: string; model: ModelSpec; transform: ObjectTransform }
interface Props {
  objects: readonly SceneObjectInput[];
  activeObjectId: string | null;
  selectedIds?: readonly string[];          // parts of the active object
  transformMode?: TransformMode;            // gizmo on a part of the active object
  explode?: number;                         // applies to the active object only
  tryOn?: { readonly current: ArmSample | null };
  onPick?: (objectId: string | null, partId: string | null, additive: boolean) => void;
  onTransform?: (objectId: string, partId: string, position: Vector, rotation: Vector) => void;
  onError?: (message: string) => void;
  onReady?: (info: { objects: number; parts: number; renderMs: number }) => void;
}
```

`fitKey` and `model` go away. `SceneHandle.projectPart(id, objectId?)` measures a part of `objectId`, defaulting to the active object.

### 4.2 Sync

Each object is an entry `{ root: THREE.Group, model, built: THREE.Group, explosion, explosionDepth }`. `root` carries the object transform (position, XYZ Euler rotation in degrees) and `userData.objectId`; `built` is today's `buildModel(model, hologramPart)` output inside it. Because parts live inside `root`, a part's gizmo position stays relative to its parent part or to the object origin, as today (requirement 26), and the exploded-view offsets, which are in the model's own frame, keep working unchanged.

A pure planner, `src/scene/scene-sync.ts`, decides the work:

```ts
planSceneSync(previous: ReadonlyMap<string, { model: ModelSpec; transform: ObjectTransform }>,
              next: readonly SceneObjectInput[]):
  { build: string[]; rebuild: string[]; move: string[]; remove: string[]; refit: boolean }
```

- `build`: new ids. `rebuild`: same id, different model reference. `move`: same model, different transform values. `remove`: ids that are gone.
- `refit` when the id set changed (an object was added or removed, including by undo/redo) or the scene goes from empty to non-empty. Editing, switching the active object and moving an object keep the user's view (decision 3).

As today, new geometry is built and compiled before the old is removed, and on a build error the old entry stays, `onError` fires, and App falls back to the last rendered workspace. Removed and replaced entries are disposed with `disposeObject` (requirement 28).

Framing (`fit`) is today's code applied to the union box of all roots (`Box3.setFromObject` on the scene's object container). With one object at the origin the union is today's box, so the camera position is identical; `workbench.spec.ts` checks that 重設視角 returns to the first framing.

### 4.3 Active object, selection, explode, dimming

- Selection style and the gizmo apply to parts of the active entry only.
- The explode animation drives the active entry only. When the active object changes, the previously active entry snaps back to assembled and `explodeShown` resets to 0 (App also resets `explode` to 0, requirement 16).
- Inactive entries are dimmed: `style.ts` gets `applyPartStyle(group, { selected, dimmed })`, which multiplies every surface and edge opacity by `HOLOGRAM.inactiveFactor` (0.4) from a base opacity stored in `userData` at build time. `applySelectionStyle(group, selected)` keeps its signature and calls it with `dimmed: false`. Dimming is display only and needs no rebuild.
- Try-on is unchanged (requirement 23): the arm preview draws over all objects exactly as it draws over one model today.

### 4.4 Picking

The pointer-up handler raycasts the surfaces of every entry and collects distinct `(objectId, partId)` pairs, front to back. Repeated clicks on the same spot cycle through the pairs, as part ids cycle today. It calls `onPick(objectId, partId, shiftKey)`; empty space gives `onPick(null, null, shift)`. App then applies requirement 24 (§5.1).

### 4.5 Canvas attributes

Set after every sync:

| Attribute | Value |
|---|---|
| `data-model-name`, `data-part-count`, `data-model-json` | as today, for the active object; removed when there are no objects |
| `data-selected-ids` | as today (active object's selection) |
| `data-explode` | as today (shown amount, active object) |
| `data-object-count` | number of objects |
| `data-active-object-id` | active id, or empty |
| `data-object-json` | `JSON.stringify(objects.map(o => [o.id, o.transform.position, o.transform.rotation]))`, so e2e tests check placement and moves without screen maths |

## 5. App wiring and the 物件 panel

### 5.1 `src/App.tsx`

`display`, `history`, `selected` and `explode` are replaced by `useWorkspace()`. `active = activeObject(workspace)` replaces `display` in the render code, so the caption, details panel, part list and part editor read the same fields as before.

| User action | Workspace call | Dispatch |
|---|---|---|
| Generate ready / accepted approximation / 載入示範模型 | `addObject(ws, createObject(ws, { id: crypto.randomUUID(), …, createdAt: new Date().toISOString() }))` | `commit` |
| AI edit (edit form), applied | `replaceModel(ws, target.id, model, { source, providerModel })` then `selectParts(…, added+updated)` | `commit` (with `before` = ws) |
| Part fields, gizmo drag, delete parts, part colour/name | `replaceModel(ws, active.id, model)` | `commit` |
| Click a part / part list / Escape / 取消選取 | `selectParts` (other object → activates it, requirement 24) | `replace` |
| Explode button and slider | `setExplode` | `replace` |
| 物件 panel: switch | `setActiveObject` | `replace` |
| 物件 panel: rename, move, delete | `replaceModel` / `setTransform` / `removeObject` | `commit` |
| Undo / redo (buttons and keys) | — | `undo` / `redo` |
| Render error fallback | last rendered workspace | `replace` |

Other details:
- Edit form (requirements 31, 32): `edit()` captures `base = active`. When the answer arrives, it applies only if `current().activeObjectId === base.id` and the object still exists; otherwise it shows today's messages. `editConflicts(base.model, current.model, plan)` compares the same object as today. The conflict dialog stores `objectId` where it stored `lineage`.
- Shift-click on another object's part activates it and selects only that part (requirement 24). Clicking empty space clears the selection and keeps the active object.
- The click rule and the edit-target rule live in the pure module `src/workspace/app-rules.ts`, so they are unit-tested: `pickPart(workspace, objectId, partId, additive)` returns the next workspace, and `canApplyEdit(workspace, targetObjectId, when)` returns `ok` or today's message for that moment (`'answer'`: 等待期間已換成另一個模型，這次修改沒有套用。; `'conflict'`: 目前顯示的已是另一個物件，這次 AI 修改沒有套用。).
- `transformMode` is reset when `activeObjectId` changes, and when a restore drops selected parts, as today.
- Timing: a ref `{ objectId, startedAt }` is set when a generate, edit or agent commit lands; `onReady` turns it into the existing 送出至繪製提交 time for the active object. The "first render" messages fire when the active id differs from the last rendered active id.
- Object limit (requirement 17): when `objects.length === MAX_OBJECTS`, the generate submit button, 接受近似並建立 and both 載入示範模型 buttons are disabled, and a notice `工作區最多 8 個物件，請先刪除一個物件。` appears under the generate form.
- The caption adds `· 工作區 N 個物件` when there is more than one object. The `model-name` heading text is unchanged.
- `window.__forgehandScene` keeps exposing the scene handle for tests.

**Temporary agent adapter (Task 5 until Task 8).** Task 5 moves App to the workspace while the agent client still speaks of one `DisplayModel`. A short block in App, marked `TEMPORARY (workspace-v2 Task 8)`, bridges the two: `getSnapshot().display` is the active object as a `DisplayModel` (`lineage` = object id, `requestId` `'workspace'`, `startedAt` null); the agent's `commit(next)` adds a new object (`id = next.lineage`, placed by `createObject`) when `next.lineage` is not the active id, and otherwise replaces the active object's model; `setSelected` and `setExplode` map to `selectParts` and `setExplode` on the active object. `tests/e2e/agent-panel.spec.ts` passes unchanged through this adapter. Task 8 deletes it.

### 5.2 `src/workspace/ObjectPanel.tsx`

Rendered when there is at least one object, between the prompt panel and the 零件 panel. Props: `objects`, `activeObjectId`, `disabled` (`agentActive`), and callbacks `onActivate`, `onRename`, `onRemove`, `onTransform`.

```
<section class="panel objects-panel" aria-label="物件">     eyebrow OBJECTS · tag "N / 8"
  <ul aria-label="物件清單">  one <button aria-pressed> per object: name + <small>N 件</small>
  active object:
    物件名稱      text field, Enter/blur commits, validated like the part name (1–500 chars, trimmed)
    物件位置      NumberField × 3, labels 物件位置 X/Y/Z, mm (scale 1000, ±100 000)
    物件角度      NumberField × 3, labels 物件角度 X/Y/Z, ° (±360)
    刪除物件      button, danger style
```

These names avoid every existing test selector (requirement 34): the part fields are `尺寸 X`, `位置 X`, `角度 X`, `零件名稱`; the part list is `零件清單`; part delete is `刪除零件`. Object names are model names (no test selector matches `雙鏡頭概念裝置` or `測試手環`).

`NumberField` moves from `App.tsx` to `src/ui/NumberField.tsx` unchanged, so the panel can use it.

## 6. Agent contract — `shared/agent.ts`

### 6.1 Request

```ts
export const AgentRequestSchema = z.strictObject({
  instruction, requestId,                                  // unchanged
  workspace: z.unknown().refine(v => v !== undefined),     // required key; checked by validateWorkspace
  tryOn: z.boolean(), cameraOn: z.boolean(),
  history: z.array(AgentTurnSchema).max(10),
});
export interface AgentRequest { instruction; requestId; workspace: Workspace; tryOn; cameraOn; history }
```

`validateAgentRequest` parses, then runs `validateWorkspace`; a failure throws `AgentRequestError('INVALID_WORKSPACE')`. The full `Workspace` is sent, not a separate compact schema: the extra fields (`source`, `providerModel`, `edited`, `createdAt`) are about 150 bytes per object, and one schema with one validator is simpler than two. The compact view is what the model sees each round (§7.3).

### 6.2 State changes

```ts
export const StateChangeSchema = z.strictObject({
  ...WorkspaceChangeSchema.shape,
  tryOn: z.boolean().nullable(),
});
```

`ToolResultSchema.stateChange` stays `StateChangeSchema.nullable()`. `ModelStateChangeSchema` is removed; its role is taken by the `add` and `model` object ops. `stripModel` becomes `stripModels`: in the `result` event, an `object` change of op `add` or `model` is replaced by `null`, so the full `ModelSpec` and the new `SceneObject` travel once, in the `state` event (requirement 46).

### 6.3 Events and labels

```ts
export const UNKNOWN_TOOL_LABEL = '其他步驟';
export const ToolEventSchema = z.strictObject({ tool: z.string().min(1).max(64), label: z.string().min(1).max(40), argsJson: z.string() });
```

### 6.4 Detail schemas

| Schema | Shape |
|---|---|
| `GenerateDesignDetail` | `{ source, providerModel, status, objectId: ObjectId | null }` (id set when ready) |
| `EditDesignDetail` | `{ objectId, changes, explanation }` |
| `SelectPartsDetail` (new) | `{ objectId, selection }` |
| `ExplodeViewDetail` | `{ objectId, amount }` |
| `GetProjectStateDetail` | `{ objects: ObjectSummary[], activeObjectId, target: { objectId, parts: PartSummary[], selection, explode } | null, tryOn }` |
| `ObjectSummary` (new) | `{ id, name, partCount, position, rotation, active }` |
| `ObjectToolDetail` (new) | `{ objectId, activeObjectId, transform: ObjectTransform | null }` for `set_active_object`, `set_transform`, `remove_object` |
| `WearOnArmDetail`, `ToolErrorDetail` | unchanged |

### 6.5 Migration from Task 6 to Task 8

Task 6 changes the contract and the server loop, Task 7 the server tools, and Task 8 the browser. So that `npm run check` and the e2e suite stay green in between, Task 6 renames the current browser-facing exports to `LegacyStateChangeSchema` / `LegacyStateChange`, `LegacyToolResultSchema` / `LegacyToolResult` and `LegacyToolEventSchema`, adds a `LegacyAgentRequestSchema`, and updates their imports in `src/agent/` and the three test files that use them (`apply-state.test.ts`, `agent-client-events.test.ts`, `agent-panel.spec.ts`). That edit is a mechanical rename. From Task 6 until Task 8 lands, a real browser-to-server agent run fails with a 400 (the browser still sends the old request); no test calls the real route from the browser. Tasks 6, 7 and 8 run back to back, and nobody demos the agent in between. Task 8 moves the browser to the final names and deletes every `Legacy*` export.

## 7. Server

### 7.1 Working state and tool context

```ts
export interface AgentWorkingState { workspace: Workspace; tryOn: boolean; cameraOn: boolean }
export interface ToolContext {
  state: AgentWorkingState; provider: ModelProvider;
  newObjectId(): string;   // default crypto.randomUUID(); tests inject a counter
  now(): string;           // default new Date().toISOString(); tests inject a fixed time
}
```

`runAgent` takes optional `newObjectId` and `now` in its options and passes them to `runTool`, so loop and route tests are deterministic.

`ToolDefinition` gains `label: string` (required). New helpers in `server/tools/helpers.ts`:
- `resolveTarget(state, tool, objectId?)` → the target `SceneObject`, or a `ToolResult`: `NO_MODEL` for an empty workspace, `UNKNOWN_OBJECT` (`工作區沒有 id 為「…」的物件。`) for an unknown id.
- `switchTo(state, target)` → `target.id` when it is not active, else `null`; used as `activeObjectId` by `writes-scene` tools only (requirement 40).
- `checkedChange(state, tool, change)` → dry-runs `applyWorkspaceChange(state.workspace, change)`; a `WorkspaceError` becomes `fail(tool, error.code, error.message)`. Every writing tool returns its change through this, so the loop's own `applyWorkspaceChange` never sees an invalid change.

### 7.2 Tools

All server side, project scope. Registration order (the order the model sees): `generate_design`, `edit_design`, `select_parts`, `get_project_state`, `explode_view`, `set_active_object`, `set_transform`, `remove_object`, `wear_on_arm`.

| Tool | Label | Args | Effects | State change |
|---|---|---|---|---|
| `generate_design` | 生成設計 | `prompt` | writes-scene | `object: add` with the server-made `SceneObject` (`createObject` with `ctx.newObjectId()`, `ctx.now()`). At the limit: `OBJECT_LIMIT` before `provider.run`. Summary `已產生「name」（物件 id：…）。` |
| `edit_design` | 修改設計 | `instruction`, `objectId?` | writes-scene | `activeObjectId: switchTo`, `object: model`, `selection: { target, added+updated }`. `editTask` gets the target's model and the selection only if it belongs to the target, else `[]` |
| `select_parts` | 選取零件 | `partIds`, `objectId?` | writes-scene | `activeObjectId: switchTo`, `selection`. Unknown part ids → `INVALID_ARGS`, as today |
| `get_project_state` | 檢視目前狀態 | `objectId?` | read-only | none; never activates. Empty workspace → ok with `objects: []`, `target: null` |
| `explode_view` | 爆炸圖 | `amount`, `objectId?` | writes-scene | `activeObjectId: switchTo`, `explode` |
| `set_active_object` | 切換物件 | `objectId` | writes-scene | `activeObjectId`; already active → ok, no change |
| `set_transform` | 移動物件 | `objectId`, `position?`, `rotation?` | writes-scene | `activeObjectId: switchTo`, `object: transform` (merged with the current transform). Neither given → `INVALID_ARGS` `請至少提供 position 或 rotation。` |
| `remove_object` | 移除物件 | `objectId` | writes-scene | `object: remove` |
| `wear_on_arm` | 護臂試戴 | `enabled` | uses-camera | unchanged; `NO_MODEL` when the workspace is empty |

`objectId` is `ObjectIdSchema.nullable().optional()`: models often send `null` for "not given", and both mean "the active object". `position` and `rotation` are full `{ x, y, z }` vectors with the transform limits; the tool description states metres and degrees.

### 7.3 Loop and per-round snapshot — `server/agent.ts`

- The working copy starts from `req.workspace` (already validated by the route).
- After each tool: if `stateChange` is set, `state.workspace = applyWorkspaceChange(state.workspace, change).after`, `state.tryOn` from `tryOn` when not null, then `emit('state', stateChange)`.
- `emit('tool', { tool, label: getTool(call.tool)?.label ?? UNKNOWN_TOOL_LABEL, argsJson })`.
- `emit('result', stripModels(result))`.

Per-round snapshot (requirement 45), replacing the one-model text:

```
工作區共 2 個物件（上限 8）：
- 3f2a…（完整 id）「雙鏡頭概念裝置」9 個零件，位置 (0, 0, 0) m，角度 (0, 0, 0)°【目前物件】
- 9c1d…「測試手環」2 個零件，位置 (0.25, 0, 0) m，角度 (0, 0, 0)°
目前物件「雙鏡頭概念裝置」的零件：外殼(housing, box, #…)、…。已選取：無。爆炸圖程度：0%。試戴：關閉。
```

An empty workspace gives `工作區沒有物件。`. Only the active object's parts are listed; `get_project_state(objectId)` gives another object's parts.

`AGENT_INSTRUCTIONS` keeps every existing rule and adds (requirement 48):

```
- The workspace holds up to 8 objects. generate_design adds a new object beside the others and makes it
  active; it never replaces an existing object. Its result gives the new object's id.
- Refer to objects by id. Tools that change the scene take an optional objectId (default: the active
  object) and make that object active first. get_project_state(objectId) reads any object without
  changing the active one.
- If it is unclear which object the user means, ask in your final reply instead of guessing.
- Call remove_object only when the user asks to remove an object.
- set_transform moves or rotates a whole object (position in metres, rotation in degrees). It never
  changes size; change sizes with edit_design.
```

The empty-scene rule line becomes "If the workspace is empty, only generate_design and get_project_state work; other tools return NO_MODEL."

### 7.4 Route — `server/app.ts`

**Body limit (requirement 38).** `app.use(express.json({ limit: '128kb' }))` runs before every route, so a parser on the route itself would never see a larger body. The agent parser is mounted first, by path:

```ts
app.use('/api/agent', express.json({ limit: '512kb', strict: true }));   // after the origin check
app.use(express.json({ limit: '128kb', strict: true }));                 // unchanged, for every other route
```

`body-parser` skips a request whose body has already been read, so the second parser does nothing for `/api/agent`. The required unit test proves it: a valid 200 kB agent request (a workspace of 8 large models) streams, while a 200 kB `/api/edit` body gets 413. If the test shows the second parser still rejecting the agent body, the fallback is to wrap the global parser so it calls `next()` for paths under `/api/agent`. The existing "agent body over 128 kB → 413" test changes to a body over 512 kB.

**Validation.** `INVALID_WORKSPACE` replaces `INVALID_MODEL` and `INVALID_SELECTION` for `/api/agent`, with the fixed message `目前工作區資料無效，無法處理這次請求。` (no ids, no Zod text). `/api/generate` and `/api/edit` are untouched.

## 8. Agent client — `src/agent/`

- `request.ts`: `RunSnapshot = { workspace, tryOn, cameraOn }`; `buildAgentRequest` sends `{ instruction, requestId, workspace, tryOn, cameraOn, history }`.
- `apply-state.ts`: `applyStateEvent(payload, workspace): { before, after, recordUndo, tryOn? } | null`. It parses with `StateChangeSchema`, calls `applyWorkspaceChange`, and returns `null` on a parse failure or `WorkspaceError` (requirement 47). `recordUndo = change.object !== null`. An `add` adds exactly the received `SceneObject`; nothing here creates ids, timestamps or placement. The `newLineage`, `requestId` and `now` parameters go away.
- `useAgentRun.ts`: options become `{ applyWorkspace(effects), setTryingOn, getSnapshot, getTurns, pushTurn }`. The hook keeps the workspace it built itself across events in one run, as it keeps `display` today, so two `state` events in one chunk build on each other.
- `events.ts`: the `tool` event keeps `tool` and `label` and drops `argsJson`, as today.
- `labels.ts`: the tool-label map and `toolLabel` are deleted. `resultText` stays, and also gives a plain sentence for `UNKNOWN_OBJECT` (`代理指定的物件不存在，會改用其他方式。`).
- `run-reducer.ts`: a `tool` entry uses the event's label; a `result` entry uses the label of the latest `tool` entry (the loop always emits a tool's `result` right after its `tool` event), falling back to `UNKNOWN_TOOL_LABEL`.
- `App.tsx`: `applyWorkspace` dispatches `commit(after, before)` when `recordUndo`, else `replace(after)`, then clears stale dialogs and sets the status message, as `commitFromAgent` does today (`代理已建立新物件…` / `代理已修改物件…`). The temporary adapter from Task 5 is deleted.
- `tests/e2e/agent-panel.spec.ts`: the scripted frames use the new shapes (`tool` with `label`, `result` with the new `stateChange`, `state` with `object: { op: 'add', object }`), and the request assertion reads `workspace.objects[0].model.name`. The test steps and expectations stay the same.

## 9. E2E isolation — `playwright.config.ts`

```ts
const externalServer = process.env.PLAYWRIGHT_BASE_URL;
const port = e2ePort('E2E_PORT', 5197);          // integer 1024–65535, else throw at config load
const apiPort = e2ePort('E2E_API_PORT', 8797);   // must differ from port
const localUrl = `http://127.0.0.1:${port}`;

use.baseURL = externalServer || localUrl;
webServer = externalServer ? undefined : {
  command: 'npm run dev',
  env: { PORT: String(port), API_PORT: String(apiPort),
         ...(process.env.RUN_LIVE_CLI === '1' ? {} : { MODEL_PROVIDER: 'openai', OPENAI_API_KEY: '' }) },
  url: localUrl,
  reuseExistingServer: false,
  timeout: 90_000,
};
```

- Playwright merges `webServer.env` over `process.env`, and `dotenv` never overrides a variable that is already set, so the user's `.env` (`PORT=5173`) cannot pull the test server back to 5173. Task 1 confirms this by checking which port the test server answers on.
- `reuseExistingServer: false`: if `localUrl` already answers, Playwright stops with its "already used" error. Vite runs with `--strictPort`, and the API server fails on `EADDRINUSE`, so a taken port is a loud failure, not a wrong app.
- README's test section gets one sentence: the e2e suite starts its own server on 5197/8797 (override with `E2E_PORT` / `E2E_API_PORT`) and fails if those ports are taken.

## 10. Module layout

```
playwright.config.ts                EDIT  own ports, never reuse (Task 1)
README.md                           EDIT  one sentence on e2e ports (Task 1)
.kiro/steering/structure.md         EDIT  shared/ description + bounds.ts/workspace.ts lines (Task 2)

shared/model.ts                     EDIT  export PartIdSchema = PartSchema.shape.id (PartSchema unchanged)
shared/bounds.ts                    NEW   worldMatrices, partBoxes (moved), modelBox, objectBox
shared/workspace.ts                 NEW   schemas, MAX_OBJECTS, validateWorkspace, assertWorkspace, WorkspaceError,
                                          operations, placeBeside, WorkspaceChange + applyWorkspaceChange
shared/agent.ts                     EDIT  AgentRequest with workspace, StateChange = WorkspaceChange + tryOn,
                                          ToolEvent label, UNKNOWN_TOOL_LABEL, detail schemas; Legacy* from Task 6 until Task 8

server/tools/registry.ts            EDIT  label on ToolDefinition; ToolContext newObjectId/now
server/tools/helpers.ts             EDIT  resolveTarget, switchTo, checkedChange
server/tools/*.ts                   EDIT  six tools on the workspace; labels
server/tools/set-active-object.ts   NEW
server/tools/set-transform.ts       NEW
server/tools/remove-object.ts       NEW
server/tools/index.ts               EDIT  registration order (§7.2)
server/agent-tools.ts               EDIT  AgentWorkingState = { workspace, tryOn, cameraOn }; passes ids/clock
server/agent.ts                     EDIT  apply via applyWorkspaceChange, tool label, stripModels, snapshot, instructions
server/app.ts                       EDIT  512 kB parser for /api/agent, INVALID_WORKSPACE

src/scene/explode.ts                EDIT  imports and re-exports worldMatrices/partBoxes from shared/bounds
src/scene/scene-sync.ts             NEW   planSceneSync (pure)
src/scene/style.ts                  EDIT  applyPartStyle({ selected, dimmed }), inactiveFactor
src/scene/SceneViewport.tsx         EDIT  object list, per-object groups, picking, framing, attributes
src/workspace/store.ts              NEW   workspaceReducer, restoreSnapshot, HISTORY_LIMIT (pure)
src/workspace/useWorkspace.ts       NEW   hook around the reducer
src/workspace/ObjectPanel.tsx       NEW   物件 panel
src/ui/NumberField.tsx              NEW   moved out of App.tsx unchanged
src/agent/request.ts, apply-state.ts, events.ts, labels.ts, run-reducer.ts, useAgentRun.ts   EDIT  (Task 8)
src/agent/types.ts                  DELETE (Task 8) DisplayModel is gone; until then it serves the Task 5 adapter
src/App.tsx                         EDIT  workspace store, adds instead of replaces, panel, limit
src/styles.css                      EDIT  .objects-panel rules only

src/workspace/app-rules.ts          NEW   pickPart, canApplyEdit (pure, Task 5)
src/workspace/object-panel.ts       NEW   objectRows, renameObject (pure, Task 9)
tests/e2e/ports.ts                  NEW   e2ePorts(env) for playwright.config.ts (Task 1)
tests/unit/e2e-ports.test.ts, bounds.test.ts, workspace.test.ts, workspace-ops.test.ts,
           workspace-store.test.ts, scene-sync.test.ts, agent-tools-workspace.test.ts,
           app-rules.test.ts, object-panel.test.ts                              NEW
tests/unit/agent*.test.ts, tool-registry.test.ts, server-agent.test.ts, apply-state.test.ts,
           agent-client-events.test.ts, run-reducer.test.ts                     EDIT (subject changed)
tests/e2e/agent-panel.spec.ts       EDIT  new frames and request assertion only
tests/e2e/workspace.spec.ts         NEW
```

`server/` still never imports `src/`, and `src/` never imports `server/`.

## 11. Testing strategy

Unit tests (Vitest, Node, no DOM, fake `ModelProvider`):

- `bounds.test.ts`: `partBoxes` and `worldMatrices` give the same results as before the move (the existing `explode.test.ts` keeps passing through the re-export); `modelBox` of `demoModel`; `objectBox` with a rotation of 90° about Y swaps X and Z extents.
- `workspace.test.ts`: schema accepts a valid workspace and survives `JSON.parse(JSON.stringify(…))`; every `assertWorkspace` rule rejects its violation; `validateWorkspace` rejects an invalid model and never leaks Zod text in the message; each operation (add makes active and clears selection and explode; limit; duplicate id; remove active picks the previous object, remove last empties; set active resets selection and explode, same id is unchanged; select on another object activates it; replace model filters selection; transform merge); operations never mutate input and keep unchanged object references; `placeBeside` for empty, one and three objects, a rotated neighbour, and the clamp; boxes of placed objects never overlap; `applyWorkspaceChange` order, `before` vs `after`, and rejection of an `activeObjectId` that does not exist yet.
- `workspace-store.test.ts`: commit, the first-object exception, limit 50, undo/redo, restore rules for selection and explode, replace leaves history alone, commit of an unchanged workspace is a no-op, structural sharing across snapshots.
- `scene-sync.test.ts`: build, rebuild on a new model reference only, move on transform values only, remove, refit only when the id set changes.
- `app-rules.test.ts`: every `pickPart` case of requirement 24 (with and without Shift, active and other object, empty space); `canApplyEdit` for an active, inactive, removed and missing target with both `when` values. The temporary agent adapter is not unit-tested; Task 8 deletes it.
- Agent tools (`agent-tools.test.ts`, `agent-tools-model.test.ts`, new `agent-tools-workspace.test.ts`): every tool with and without `objectId`; writing tools activate a non-active target, `get_project_state(objectId)` does not; `UNKNOWN_OBJECT`, `NO_MODEL`, `OBJECT_LIMIT` (and the provider is not called); `generate_design` uses the injected id and time and places beside; `edit_design` sends the target's model and only the target's selection to `editTask`; `set_transform` merge and the neither-given error; `remove_object` of the active and of another object; every change passes `applyWorkspaceChange`.
- `tool-registry.test.ts`: nine tools in order, each with a non-empty label; the generated tool list.
- `agent-loop.test.ts`: generate then edit the new object by id within one run (the second round's snapshot lists the new id); `tool` events carry labels, `其他步驟` for an unknown tool; `result` events carry no model; the snapshot lists all objects and only the active object's parts.
- `server-agent.test.ts`: 200 kB valid agent request streams and a 200 kB `/api/edit` body gets 413; over 512 kB → 413; `INVALID_WORKSPACE` cases with fixed message; the existing route tests on the new request shape.
- Client (`apply-state.test.ts`, `agent-client-events.test.ts`, `run-reducer.test.ts`): `applyStateEvent` adds exactly the received object (same id, transform and `createdAt`), `recordUndo` only with an object change, invalid payloads → `null`; `buildAgentRequest` is accepted by `AgentRequestSchema`; labels come from events; a result entry takes its tool's label.

E2E (Playwright, `/api/*` routed, real WebGL):

- Task 1 checks isolation by running the suite with a dev server on 5173/8787.
- `agent-panel.spec.ts` keeps its four scenarios on the new frames.
- `workspace.spec.ts` (Task 10): load demo, generate a second object → `data-object-count` 2, the new object is active and placed to the right (`data-object-json`); click a part of the inactive object → it becomes active with that part selected; explode affects only the active object (a part of the other object projects to the same point); 物件 panel switch, rename (`data-model-name` changes, undo restores), move (`data-object-json` changes, undo restores), delete and undo; the limit (eight 載入示範模型 clicks → generate disabled with the notice); an agent `state` frame that adds a server-made object → the browser shows exactly that id and transform, and undo removes it.
- The full suite (about 8 minutes) runs once at the end of every task that touches the browser (Tasks 1, 4, 5, 8, 9 and 10).

## 12. Task plan and requirement map

At most ten tasks (requirement 62). Each is one module or one wiring step plus its tests, small enough for one fresh session. Implementation order is 1, 2, 3, 4, 5, 9, 6, 7, 8, 10: the 物件 panel lands before the agent contract changes, and Tasks 6–8 run back to back.

| Task | Content | Requirements |
|---|---|---|
| 1 | E2E isolation: `playwright.config.ts`, README sentence | 1–5 |
| 2 | `shared/bounds.ts` (move + `modelBox`/`objectBox`), `PartIdSchema` export, `shared/workspace.ts` part 1: schemas, `validateWorkspace`/`assertWorkspace`, `WorkspaceError`, lookups, `placeBeside`, `createObject`; steering update | 6–10, 14, 55 |
| 3 | `shared/workspace.ts` part 2: operations, `WorkspaceChange` + `applyWorkspaceChange`; `src/workspace/store.ts` (pure undo reducer) | 12, 13, 15–17 (data side), 18–22 (rules), 46 (change schema), 61 |
| 4 | `SceneViewport` multi-object, `scene-sync.ts`, dimming in `style.ts`. App passes its one model as a one-object list | 23–29 |
| 5 | `useWorkspace`, `app-rules.ts` (`pickPart`, `canApplyEdit`) and `App.tsx` on the workspace: adds instead of replaces, active-object editing, undo wiring, limit UI, temporary agent adapter | 11, 15–22 (browser side), 24, 30–32, 36, 54 |
| 6 | Agent contract and loop: `shared/agent.ts`, `Legacy*` names, registry `label` and `newObjectId`/`now`, tool helpers, the six tools on the workspace (active object only), loop, snapshot, 512 kB parser, `INVALID_WORKSPACE` | 37–39, 41, 43, 44 (detail shape), 45, 46, 49, 50, 53, 60 |
| 7 | Agent tools: `objectId` on four tools, `set_active_object`, `set_transform`, `remove_object`, registration order, new instruction lines | 40, 42, 44 (`objectId`), 48 |
| 8 | Agent client: `src/agent/*` on the new contract, App wiring, adapter and `Legacy*` removed, `agent-panel.spec.ts` frames | 47, 51, 52 (agent-panel) |
| 9 | `ObjectPanel.tsx`, `NumberField` move, panel wiring and styles | 33–35, 36 |
| 10 | `tests/e2e/workspace.spec.ts` and the full suite | 52–54, end-to-end check of 14, 17, 23–24, 27, 29, 33, 41, 47 |

Requirements 56–59 and 62 apply to every task. Cut order if time runs short (each item is a self-contained part of one task): inactive-object dimming (Task 4), the object rotation fields (Task 9), rename in the 物件 panel (Task 9), `remove_object` (Task 7), `set_transform` (Task 7).

## 13. Key decisions

- **One set of pure operations for both sides.** The browser and the server call the same `shared/workspace.ts` functions, so an agent change replays identically, and there is one place to test the rules.
- **Changes, not whole workspaces, on the wire.** A `state` event carries at most one object change; a full model travels only when it is new or changed. Eight objects never ride along with a selection change.
- **The server owns agent-created objects.** It creates id, `createdAt` and placement; the browser adds exactly that object. The model can therefore generate and then edit the same object in one run.
- **Validate at boundaries, assert inside.** `validateWorkspace` copies and fully checks untrusted input; `assertWorkspace` checks invariants without copying, so model references survive and the scene rebuilds only what changed.
- **Activation first in a change.** `applyWorkspaceChange` activates before it changes an object and returns the post-activation workspace as the undo snapshot, so undoing an agent edit lands on the object that was edited.
- **Undo history is objects + active id.** Selection and explode stay outside undo, as today; restore rules are today's `restore` applied to the active object.
- **Placement is X-only and conservative.** Axis-aligned boxes of rotated parts and objects can only over-estimate, so placed objects never overlap.
- **A temporary adapter and `Legacy*` names instead of two big tasks.** They keep every task green on `npm run check` and the e2e suite, at the cost of one known gap (the real agent route) from Task 6 until Task 8.

## 14. Decisions from review

The design's open questions were reviewed on 2026-11-14; all recommendations were accepted.

1. **Task 6 to Task 8 gap.** Keep the split with `Legacy*` names (§6.5). Tasks 6, 7 and 8 run back to back, and the reports of Tasks 6 and 7 say that a real agent run in the browser fails until Task 8.
2. **Placement gap.** `max(20 mm, 10% of the new object's width)`, Y and Z at 0.
3. **Object order.** Creation order (the `objects` array order), newest last, no reordering.
4. **`edit_design` on a non-active object.** `editTask` gets an empty selection (the whole model).
