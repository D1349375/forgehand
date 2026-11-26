# Workbench UI: a full-screen workbench, the parts tray and objects as groups — Design

This design satisfies `requirements.md` and follows its recommended decisions. It follows the patterns of `workspace-v2`, `assembly-joints`, `hand-manipulation` and `export`: pure modules unit-tested in Node, thin React and Three.js wiring covered by Playwright, one place for every rule. Requirement numbers (R…) refer to `requirements.md`; task numbers (T1–T7) to `tasks.md`. "HM", "AJ", "EX" and "WS" mean `hand-manipulation`, `assembly-joints`, `export` and `workspace-v2`.

## 1. Approach

```
data         shared/pull-out.ts: subtree, in-place re-rooting, placement, joint re-pointing, the 'pull-out'
             object change; shared/workspace.ts applies it                                          (T1)
agent        pull_out_part; create_joint on two parts of one object; instructions; message          (T2)
layout       full-screen stage, HUD, docks, status bar, panel model, framing in the free area,
             one demo button; today's part list moves to the bottom zone unchanged                 (T3)
tray         cards, selection, keyboard, mouse drag to pull out, 拉出成新物件, mouse join inside
             one object, the export scope line                                                     (T4)
hands        on-screen target registry, draggable targets, the carry session, HUD toggles by pinch (T5)
cards        data cards, measurements, show_panel and data_card, the request's ui field            (T6)
audit        reachability e2e, README, measurements, manual checks                                 (T7)
```

Five ideas carry the design:

1. **A pull-out is one pure function.** `pullOutPart(ws, input)` in `shared/pull-out.ts` does everything (subtree, re-rooting, placement, joints, selection) and returns a new workspace or throws a `WorkspaceError`. The browser commits its result as one undo step; the agent's tool sends the same input as an object change (`op: 'pull-out'`) that `applyWorkspaceChange` passes to the same function. Ids and time are inputs, so both sides get the same workspace.
2. **The layout is zones over one fixed canvas.** The stage never resizes when panels change. Panels float in docks; the free area is computed from the zone boxes and used for three things: framing (through the camera's view offset), the drop rule, and the data-card placement.
3. **Panels follow edges.** A pure state machine holds the open panels. `App` feeds it a small context (object count, selection count, joints, attention, agent status); the machine opens a panel when a context value *changes* in a listed way and closes it only when its content is gone. The user's close is final until the next edge.
4. **The hands press and carry on-screen targets.** HM already has on-screen targets and a tap that presses them (`pickTarget`, `decidePinch` → `press`, `HandPort.press`) but registers none. A registry module lets components register elements (HUD toggles, the demo button, tray cards, tray scroll buttons). A tray card is *draggable*: a press session that starts dragging on it becomes a **carry**, which moves the card's ghost and drops it with the same drop rule as the mouse.
5. **Cards carry references, the browser computes values.** A data card stores a kind and target ids. The browser computes its rows from the current workspace each time it is drawn; the server computes the same numbers with the same shared functions only to write the tool summary.

## 2. Module layout

```
shared/pull-out.ts             T1  subtreeIds, pullOutCheck, PullOutInput, pulledObject, placeNextTo, pullOutPart, splitForJoin
shared/workspace.ts            T1  ObjectChangeSchema 'pull-out'; applyWorkspaceChange; codes UNKNOWN_PART, WHOLE_OBJECT
src/workspace/object-panel.ts  T1  objectRows comment: workspace order (no code change)
server/tools/pull-out-part.ts  T2  NEW
server/tools/create-joint.ts   T2  two parts of one object (R50, R75)
server/tools/index.ts          T2  register pull_out_part;  T6 show_panel, data_card
server/agent.ts                T2  AGENT_INSTRUCTIONS;  T6 instructions, ui lines in workspaceSnapshot
shared/agent.ts                T2  PullOutDetailSchema;  T6 StateChange.panel, .dataCard, AgentRequest.ui, detail schemas
src/agent/apply-state.ts       T2  StateEffects.objectOp;  T6 .panel, .dataCard
src/App.tsx                    T2  message for an agent pull-out;  T3 layout;  T4 tray, pull-out, mouse join;  T6 cards, panels from the agent
src/workbench/text.ts          T3  (T4–T6 add) every string of src/workbench
src/workbench/panels.ts        T3  PanelId, DOCK_ORDER, PanelContext, PanelState, initialPanels, panelTriggers, panelStep (pure)
src/workbench/zones.ts         T3  ZoneRects, freeArea, viewOffsetFor (pure);  T4 inDropZone
src/workbench/Hud.tsx          T3  both HUD rows, toggles, the demo button, the language slot
src/workbench/ObjectCaption.tsx T3 the caption with the `extras` slot
src/workbench/StatusBar.tsx    T3  message, request cancel, hand status, try-on status, errors, hints
src/workbench/DockPanel.tsx    T3  heading, close button, focus and Esc rules, data-panel
src/workbench/CreatePanel.tsx  T3  today's prompt panel JSX, moved
src/workbench/PartPanel.tsx    T3  today's part editor JSX, moved;  T4 拉出成新物件
src/workbench/DetailsPanel.tsx T3  today's 模型與假設 JSX, moved, with the `checks` slot
src/workbench/StartMessage.tsx T3  the empty-workspace message
src/workbench/PartList.tsx     T3  today's part list, moved unchanged into the bottom zone;  T4 replaced by PartsTray
src/workbench/tray-model.ts    T4  TrayCard, trayCards, cardLabel (pure)
src/workbench/card-drag.ts     T4  the mouse drag state machine (pure)
src/workbench/primitive-icons.tsx T4 PRIMITIVE_ICONS: Record<Part['primitive'], icon>
src/workbench/PartsTray.tsx    T4  cards, roving focus, scroll buttons, ghost;  T5 registers its targets
src/workbench/screen-targets.ts T5 registry and useScreenTarget hook
src/workbench/data-cards/kinds.ts      T6  DATA_CARD_KINDS registry (title, rows, anchor)
src/workbench/data-cards/placement.ts  T6  placeCards (pure)
src/workbench/data-cards/DataCardLayer.tsx T6
shared/workbench.ts            T6  AgentPanelIdSchema, DataCardSpecSchema, PanelChangeSchema, DataCardChangeSchema, UiStateSchema, MAX_DATA_CARDS
shared/measure.ts              T6  partSizeMm, partOriginWorld, partDistanceMm (Three.js math only)
server/tools/show-panel.ts     T6  NEW
server/tools/data-card.ts      T6  NEW
server/tools/helpers.ts        T6  checkedChange strips panel and dataCard
src/agent/useAgentRun.ts, request.ts  T6  setPanel / applyDataCard options; RunSnapshot.ui
src/agent/AgentPanel.tsx       T3  collapsed and expanded
src/workspace/ObjectPanel.tsx, src/joints/JointPanel.tsx, src/joints/PrinterPanel.tsx  T3  inside DockPanel; printer shown open
src/scene/SceneViewport.tsx    T3  framingArea prop, view offset in fit(), pixel-ratio cap;  T6 onRendered, anchorPoint
src/hands/types.ts, controller.ts, useHandControl.ts, text.ts, constants.ts  T5  draggable targets, carry
src/export/dialog-model.ts, ExportDialog.tsx  T4  outsideAssembly line (R54)
src/styles.css                 T3 (T4–T6 add)
README.md                      T7
```

Tests (new files): `tests/unit/pull-out.test.ts` (T1), `tests/unit/pull-out-export.test.ts` (T1, real WASM), `tests/unit/pull-out-agent.test.ts` (T2), `tests/unit/workbench-panels.test.ts` and `workbench-zones.test.ts` (T3), `tests/unit/parts-tray.test.ts` (T4), `tests/unit/hand-tray.test.ts` (T5), `tests/unit/data-cards.test.ts` and `workbench-agent.test.ts` (T6); `tests/e2e/workbench-helpers.ts` (T3), `tests/e2e/pull-out.spec.ts` (T2), `workbench-layout.spec.ts` (T3), `parts-tray.spec.ts` (T4), `hand-tray.spec.ts` (T5), `data-cards.spec.ts` (T6), `reachability.spec.ts` (T7).

Dependency direction: `shared/pull-out.ts` imports `shared/workspace.ts` types, `shared/bounds.ts` and `shared/assembly.ts`; `shared/workspace.ts` imports `pullOutPart` for `applyWorkspaceChange` (the same pattern as `assembly.ts`: type-only imports in the other direction, so there is no runtime cycle). `src/workbench/**` imports `shared/` and `src/scene` types; `src/hands/**` never imports `src/workbench/**` (the registry is passed to `useHandControl` as the port's source, §7.3).

## 3. Pull-out in `shared/` (T1)

### 3.1 Subtree and checks (R40, R43)

```ts
/** `partId` and every descendant, in model order. Empty for an unknown part. */
export function subtreeIds(model: ModelSpec, partId: string): string[];

export type PullOutCheck =
  | { ok: true; partIds: string[]; inPlace: boolean }
  | { ok: false; code: 'UNKNOWN_OBJECT' | 'UNKNOWN_PART' | 'WHOLE_OBJECT' | 'OBJECT_LIMIT' };

/** Whether part `partId` of object `objectId` can be pulled out now, and whether it would stay in place (R42). */
export function pullOutCheck(ws: Workspace, objectId: string, partId: string): PullOutCheck;
```

`inPlace` is true when some joint has exactly one side in the subtree (`side.objectId === objectId && partIds.includes(side.partId)`). The order of checks is object, part, whole object, limit, so the tray (R32, R35) and the tool (R56) give the same first reason.

### 3.2 Re-rooting in place (R40, R41)

```ts
export interface PullOutInput { objectId: string; partId: string; newObjectId: string; createdAt: string; inPlace?: true }

/** The new object exactly where the subtree is, and the original without it. Throws WorkspaceError. */
export function pulledObject(ws: Workspace, input: PullOutInput): { original: SceneObject; pulled: SceneObject };
```

1. `M = objectMatrix(O.transform) · worldMatrices(O.model).get(p)` (both exist in `shared/assembly.ts` and `shared/bounds.ts`). Decompose `M` into position and quaternion.
2. `N.transform = { position: round5(world position of p's origin), rotation: O.transform.rotation }` (the same object reference, so an unchanged rotation is shared).
3. `p' = { ...p, parentId: null, position: {0,0,0}, rotation: xyzDegrees(R_model(p)) }` where `R_model(p)` is the rotation part of `worldMatrices(O.model).get(p)` and `xyzDegrees` rounds to 2 decimals like `transformOfMatrix`. With the object's rotation unchanged and the root's rotation equal to its model-frame rotation, the world rotation is `R_O · R_model(p)`, as before.
4. Every other subtree part is copied unchanged (its `position` and `rotation` are relative to its parent, which moved with it).
5. `N.model = validateModel({ schemaVersion, units, name: p.name, summary: \`從「${O.model.name}」拉出的零件。\`.slice(0, 2000), assumptions: [], parts })`. A model name longer than 500 characters cannot occur, because part names have the same limit.
6. `O'` = `O` with the subtree removed, `edited: true`, the rest unchanged.

Rounding: position to 1e-5 m (0.01 mm), rotation to 0.01°. A face of a 100 mm part moves at most 100 × tan(0.005°) ≈ 0.009 mm from rotation rounding, plus 0.005 mm from position rounding, well under `CONTACT_GAP_MM` (0.1 mm) and `CONTACT_ANGLE_DEG` (1°). A unit test checks that a joint between the subtree and the rest still `touching` after a pull-out of a rotated child (AJ R22).

### 3.3 Placement next to the original (R42)

```ts
/** Transform for `pulled` next to `original` (already without the subtree), avoiding the other objects' boxes. */
export function placeNextTo(others: readonly SceneObject[], original: SceneObject, pulled: SceneObject): ObjectTransform;
```

Let `B = objectBox(pulled.model, pulled.transform)`, `A = objectBox(original.model, original.transform)`, `w = B.max.x − B.min.x`, `gap = max(0.02, 0.1 · w)`, the same gap rule as `placeBeside`. Candidates, in order, each a translation of `pulled.transform.position`:

1. right: `dx = A.max.x + gap − B.min.x`;
2. left: `dx = A.min.x − gap − B.max.x`;
3. front: `dz = A.max.z + gap − B.min.z`;
4. back: `dz = A.min.z − gap − B.max.z`.

The first candidate whose moved box does not intersect the box of any object in `others` (everything but `original` and `pulled`) and stays within the position limit wins. Otherwise `dx = max over all boxes (including A) of max.x + gap − B.min.x`, as `placeBeside` does. Positions are rounded to 5 decimals. `y` never changes, so a part keeps its height.

### 3.4 The operation (R42–R47)

```ts
export function pullOutPart(ws: Workspace, input: PullOutInput): Workspace;
```

1. `pullOutCheck`; a failure throws `new WorkspaceError(code)`. `DUPLICATE_OBJECT` and an id or `createdAt` that fails the schema are checked as `addObject` does.
2. `pulledObject`; then the transform is `placeNextTo(...)` unless `check.inPlace || input.inPlace`.
3. Joints: `ws.joints.map(joint => remap(joint))` where `remap` replaces `objectId` on each side that names a subtree part; a joint with no such side keeps its reference, and the array keeps its reference when no joint changed (WS R61's reference rule).
4. Objects: `O` replaced by `O'`, `N` inserted right after it.
5. Selection: when `selection.objectId === O.id`, the pulled ids are removed; an empty result becomes `EMPTY_SELECTION`. `activeObjectId` and `display` are unchanged.
6. `checked(...)` (`assertWorkspace`) on the result.

`WorkspaceErrorCode` gains `UNKNOWN_PART` (找不到指定的零件。) and `WHOLE_OBJECT` (這個零件連同子零件就是整個物件，不需要拉出。) in `MESSAGES`.

### 3.5 The object change (R49)

```ts
z.strictObject({
  op: z.literal('pull-out'),
  objectId: ObjectIdSchema,
  partId: PartIdSchema,
  newObjectId: ObjectIdSchema,
  createdAt: SceneObjectSchema.shape.createdAt,
  inPlace: z.literal(true).optional(),
})
```

is added to `ObjectChangeSchema`, and `applyWorkspaceChange` gains `else if (op.op === 'pull-out') after = pullOutPart(after, op)`. Because `StateChangeSchema` spreads `WorkspaceChangeSchema.shape`, the agent contract gets the op without another edit. `applyStateEvent` already returns `recordUndo: true` for any object change. The change carries only ids, so `stripModels` (which nulls `add` and `model` changes in the `result` event) needs no case for it.

### 3.6 Joining two parts of one object (R50)

```ts
/**
 * For a planned joint whose sides are parts of one object: pulls out the side whose part is not an ancestor of the other's
 * (side b when neither is) in place, and returns the workspace and both sides re-pointed. Returns null when the sides are
 * in different objects. Throws WorkspaceError (OBJECT_LIMIT).
 */
export function splitForJoin(ws: Workspace, a: JointSide, b: JointSide, ids: { newObjectId: string; createdAt: string }):
  { ws: Workspace; a: JointSide; b: JointSide; pulled: 'a' | 'b'; change: Extract<ObjectChange, { op: 'pull-out' }> } | null;
```

Pulling out the non-ancestor side never takes the whole object (the ancestor stays), so `WHOLE_OBJECT` cannot occur. The joint is then built with `newJoint(result.ws, { a: result.a, b: result.b, … })` and added with `addJoint`. The pair still touches after the pull-out (§3.2), so the joint's checks are what they were.

### 3.7 What does not change

`assertJoints` still accepts a joint inside one object (R51); `migrateWorkspace` and `WORKSPACE_VERSION` are untouched (R52, decision 6). The export needs no change for R53: `buildPieces` fuses only parts of one object (EX R6), so the pulled parts become pieces of *N*, and `jointFeatures` follows the re-pointed joint sides. T1's export test proves it with the real WASM (§11).

## 4. Agent (T2)

### 4.1 `pull_out_part` (`server/tools/pull-out-part.ts`, R56)

```ts
defineTool({
  name: 'pull_out_part', label: '拉出零件', category: 'assembly', side: 'server', scope: 'project', effects: 'writes-scene',
  description: 'takes a part (partId) with its child parts out of its object (objectId, default: the active object) and makes it a new object. A part joined to anything outside it stays where it is, and its joints then connect the two objects; otherwise the new object is placed next to the original. The original stays active. Use it to separate a part, print it separately, give it another material, or join it to another part of the same design. The user can undo it. Errors: NO_MODEL, UNKNOWN_OBJECT, UNKNOWN_PART, WHOLE_OBJECT, OBJECT_LIMIT.',
  args: z.strictObject({ partId: PartIdSchema, objectId: OptionalObjectIdSchema }),
  async run({ partId, objectId }, { state, newObjectId, now }) { … },
});
```

`run`: `resolveTarget`; `pullOutCheck` (a failure returns `fail(code, message)`); the change `{ activeObjectId: null, object: { op: 'pull-out', objectId: target.id, partId, newObjectId: newObjectId(), createdAt: now() }, selection: null, explode: null, tryOn: null }`; `checkedChange`; the result detail `PullOutDetailSchema = { objectId, partId, newObjectId, partIds: string[] (≤ 64), inPlace: boolean, jointsMoved: number }` (added to `shared/agent.ts`); the summary from the file's `TEXT` constant: 已把「{part}」（含 {n} 個子零件）拉出成新物件「{name}」，{放在「{original}」旁邊 | 原位保留並與原接合相連}。 It is registered after `remove_joint` in `server/tools/index.ts`, so the joint tools stay together.

### 4.2 `create_joint` on two parts of one object (R50, R75)

After `planJoin` returns `ok`, when `plan.a.objectId === plan.b.objectId`: `splitForJoin(ws, plan.a, plan.b, { newObjectId: newObjectId(), createdAt: now() })`, then `newJoint` on its workspace with a second `newObjectId()` for the joint id, and the change `{ object: split.change, joint: { op: 'add', joint } }` (the existing `WorkspaceChange` allows one object change and one joint change, applied in that order). `OBJECT_LIMIT` returns `fail`. The summary adds 「{part}」已拉出成新物件。 The description's "(or two parts of one object)" becomes "two parts of one object are first separated: one of them becomes its own object in place".

### 4.3 Instructions (R74)

In `AGENT_INSTRUCTIONS`, the line "Joints connect two objects (or two parts of one object) on flat faces. …" becomes "Joints connect two objects on flat faces. create_joint on two parts of one object first takes one of them out into its own object, in place, and then joins them. …" (the rest of the line unchanged), and these lines are added after it:

- "An object is one printed group: parts of one object that touch are printed as one piece. pull_out_part takes a part with its child parts out into a new object of its own. Use it when the user wants to separate a part, print it separately, give it another material, or join it to the rest. A part joined to anything stays in place; otherwise it goes next to the original. The original stays active."
- "remove_joint separates two objects; they stay separate objects. Nothing merges objects; only the user's undo (復原) reverses a pull-out."

### 4.4 Browser message (R76)

`StateEffects` gains `objectOp?: ObjectChange['op']`, set from `change.object?.op`. In `applyAgentWorkspace`, a first branch `if (effects.objectOp === 'pull-out')` sets 代理已把「{part}」拉出成新物件，可按「復原」回到上一步。 (the part name read from the new object, which is the one in `after` and not in `before`) plus the cascade suffix; the other branches are unchanged.

## 5. Full-screen layout (T3)

### 5.1 Structure and zones (R1–R5, R9)

```tsx
<div className="workbench" data-layout={narrow ? 'narrow' : 'wide'}>
  <div className="viewport" data-testid="viewport">          {/* fixed, inset 0 */}
    <video … className="camera-video" aria-label="即時攝影機背景" />
    <div className="viewport-shade" />
    <SceneViewport … framingArea={freeAreaNow} />
    {empty && <StartMessage … />}
    <div className="orientation" aria-hidden="true">…</div>
  </div>
  {/* T6: <DataCardLayer /> */}
  <Hud … />                                                    {/* .hud, top */}
  <aside className="dock dock-left"><AgentPanel … /></aside>   {/* collapsed: bottom-left above the tray */}
  <aside className="dock dock-right" aria-label="面板">{open panels in DOCK_ORDER}</aside>
  <StatusBar … />                                              {/* bottom centre, above the tray */}
  {active && <PartList … />}                                   {/* T3: today's list in .parts-tray; T4: <PartsTray /> */}
  {handDebugOpen && <DockPanel id="hand-debug" floating …><HandDebugPanel … /></DockPanel>}
  {handControlOn && <HandOverlay ref={overlayRef} />}           {/* fixed, inset 0, top layer */}
</div>
```

CSS (one block at the top of the new layout section of `styles.css`): `--hud-h`, `--dock-right-w` (365 / 390 / 320 px as the control column today), `--dock-left-w` (340 px), `--tray-h` (112 px), `--tray-gap` (`TRAY_BOTTOM_GAP_PX`, 24 px), `--panel-alpha` (0.9). z-index: viewport 0, cards 10, HUD / docks / status / tray 20, ghost 30, hand overlay 40. The old two-column rules (`.workspace` grid, `.stage-column`, `.control-column`, the `.viewport` heights, the sticky mouse-join rule, the `.topbar`, `.section-heading`, `.stage-label`, `.stage-footer`, `.stage-note`, `.app-footer` rules) are removed. At `max-width: 800px` the docks become one bottom sheet (`max-height: 55vh`, `overflow: auto`), the HUD rows wrap, and the tray scrolls inside.

```ts
// src/workbench/zones.ts (pure)
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface ZoneRects { viewport: Rect; hud: Rect | null; leftDock: Rect | null; rightDock: Rect | null; bottom: Rect[] /* status bar, collapsed agent bar, tray */ }
/** The scene area no zone covers (R3). */
export function freeArea(z: ZoneRects): Rect;
/** setViewOffset arguments that move the canvas centre to the free area's centre (R8). */
export function viewOffsetFor(canvas: { width: number; height: number }, free: Rect): { x: number; y: number };
```

`freeArea`: left = the left dock's right edge when the left dock is a column (expanded agent), else the viewport's left; right = the right dock's left edge when any right panel is open; top = the HUD's bottom; bottom = the smallest top of the bottom rectangles. `App` reads the boxes with one `getBoundingClientRect` per zone element (`zoneRectsFromDom()`), only when asked (framing, a drop, a card placement), never per frame.

### 5.2 Panel model (R11–R14, `src/workbench/panels.ts`)

```ts
export type PanelId = 'create' | 'part' | 'objects' | 'joints' | 'printer' | 'details' | 'export' | 'hand-debug' | 'fit';
export const DOCK_ORDER: readonly PanelId[] = ['export', 'create', 'part', 'objects', 'joints', 'printer', 'details', 'fit'];
export interface PanelContext {
  objectCount: number; selectionCount: number; jointIds: readonly string[]; openJointId: string | null;
  mouseJoin: boolean; attention: boolean; handDebug: boolean; agentRunning: boolean; agentAnswer: string | null;
}
export interface PanelState { open: ReadonlySet<PanelId>; agentExpanded: boolean }
export function initialPanels(context: PanelContext): PanelState;
export function panelTriggers(prev: PanelContext, next: PanelContext): { open: PanelId[]; close: PanelId[]; expandAgent: boolean };
export type PanelEvent =
  | { type: 'toggle'; id: PanelId } | { type: 'open'; id: PanelId } | { type: 'close'; id: PanelId }
  | { type: 'agent'; expanded: boolean } | { type: 'context'; prev: PanelContext; next: PanelContext };
export function panelStep(state: PanelState, event: PanelEvent): PanelState;   // same reference when nothing changes
```

`panelTriggers` is the R13 table, one line per row: for example `objects` opens when `prev.objectCount < 2 && next.objectCount >= 2`; `part` opens when `prev.selectionCount === 0 && next.selectionCount > 0` and closes when `next.selectionCount === 0`; `joints` opens on the object edge, on a new id in `jointIds`, on `openJointId` becoming non-null or changing, and on `mouseJoin` turning true; `create` opens when `next.objectCount === 0 && prev.objectCount > 0`, and when `attention` turns true; `expandAgent` when `agentRunning` turns true or `agentAnswer` changes to a non-null value. `initialPanels` opens `create` for an empty workspace. `export` is not in the state: its flag is `exportRequest !== null` in `App`, as today, and `DOCK_ORDER` only places it.

`App` keeps `const [panels, dispatchPanels] = useReducer(panelStep, …)` and a `useRef` of the last context; an effect compares the new `PanelContext` (built from the workspace, `mouseJoin`, `error || clarify || conflict || pending`, `handControlOn && handDebug`, `agent.status`, `agent.reply ?? agent.error`) with the last one and dispatches `context` when any field differs. Closing the `joints` panel dispatches `stepMouseJoin({ type: 'cancel' })` first (R21).

### 5.3 HUD (R4, R6, R15, R25)

`Hud` receives everything it shows as props (no state of its own): the camera group, history and view group, the explode group (with an active object; the note 依零件階層在本機計算，不改模型資料、不呼叫 AI；拆開時停用拖曳把手。 becomes the slider's `aria-describedby` text), 匯出套件, the demo button (only with at least one object, R25), and on the first row the brand, `ObjectCaption` and the toggles. A toggle is `<button aria-expanded={open} aria-controls={'panel-' + id}>{title}</button>`; the 零件 toggle renders only with a selection, 手勢除錯 only with `?hands=debug`. A `languageSlot?: ReactNode` prop is the place for `english-ui`'s switch. All texts come from `src/workbench/text.ts` (`HUD_TEXT`, `PANEL_TITLES`, `CLOSE_LABELS`).

### 5.4 Docks, focus and keys (R15, R16, R19, R20, R23)

`DockPanel({ id, title, closeLabel, focusOnOpen, onClose, children })` renders `<section role="region" id={'panel-' + id} aria-labelledby={…} data-panel={id}>` with an `<h2 tabIndex={-1}>` and the close button. `focusOnOpen` (set by a toggle press, cleared after use) focuses the heading on mount; otherwise mounting never touches the focus (R13). `onClose` from the close button or Esc moves the focus back to the toggle (`document.getElementById('toggle-' + id)`) or, for `part`, to the selected tray card. When a panel opens by itself, the dock calls `element.scrollIntoView({ block: 'nearest' })` on it.

The existing global `keydown` handler in `App` gains, after the mouse-join branch and before clearing the selection: if `event.key === 'Escape'` and the target is inside `[data-panel]` and is not a text field, close that panel (`close` event) and stop. Esc and `/` work during an agent run (they change no data); the other keys keep the early `agentActive` return. `/` (no modifier, not in a field) dispatches `{ type: 'agent', expanded: true }` and focuses `#agent-instruction`.

`AgentPanel` gains `expanded` and `onToggle` props; collapsed, it renders the form (任務指示, 執行, 取消), the status line and `agent-blocked`; expanded, also the eyebrow, the heading, the intro, `agent-sent`, `agent-log`, `agent-reply`, `agent-error`. The `section`'s `aria-label="代理對話"` and `data-testid="agent-panel"` stay in both.

`ObjectPanel`, `JointPanel` and `PrinterPanel` keep their props and markup and are wrapped by `DockPanel` in `App`; `PrinterPanel` changes its root from `<details>` with `<summary>` to a `<div>` with the same `aria-label` and `data-testid`, because the dock panel is the disclosure now. `CreatePanel`, `PartPanel` and `DetailsPanel` receive today's JSX unchanged except that their strings move to `text.ts` (decision 13); the state and handlers stay in `App`.

### 5.5 Status bar (R7)

`StatusBar` renders, as today's elements with their test ids and roles: the message line (`role="status"`, `aria-live="polite"`, the pulsing dot, `busyText`), 取消這次生成 / 取消這次修改 while `busy`, `hand-status`, `try-on-status` with `try-on-stats`, `cameraError` and `renderError` (`role="alert"`), and the hint line. The generate or edit error with 重試 stays in `CreatePanel` (it is the attention that opens it).

### 5.6 Framing in the free area (R8, `SceneViewport`)

`SceneViewport` gains an optional prop `framingArea?: () => { left: number; top: number; width: number; height: number } | null` in client pixels. `fit()`:

1. Reads `framingArea()`; null (or no prop) means the whole canvas, which is today's behaviour exactly.
2. `camera.setViewOffset(W, H, x, y, W, H)` with `viewOffsetFor`, or `camera.clearViewOffset()` when the area is the whole canvas.
3. Uses the free area's FOVs: `vFov' = 2·atan(tan(vFov/2) · h/H)`, `hFov' = 2·atan(tan(hFov/2) · w/W)`, and the existing distance formula with `min(vFov', hFov')`.

The offset changes only in `fit()`, which runs on 重設視角, on the automatic framing while `viewChanged` is false, and on a window resize (the existing `ResizeObserver`). The arm preview renders with its own orthographic camera (`src/scene/arm-preview.ts`) and the export image with its own camera (`src/export/kit-image.ts`), so neither is affected. `renderer.setPixelRatio(Math.min(devicePixelRatio, pixelRatioCap))` uses `FULLSCREEN_MAX_PIXEL_RATIO = 1.5` (decision 14), overridable with `?pixel-ratio=<0.5..2>` for the manual measurement (read once at load, like `?hands-min-fps`).

### 5.7 Demo entry (R25)

`StartMessage` holds the start text, the privacy line and `<button className="button ghost">載入示範模型</button>`; `Hud` holds `<button className="button demo-button">載入示範模型 <span>非 AI 生成</span></button>` only while `objects.length > 0`. Both call `loadDemo` and are disabled with `agentActive || atLimit`. The `.demo-link` in the prompt panel is removed.

### 5.8 Moving the part list (T3 only)

T3 moves today's `<ul className="part-picker" aria-label="零件清單">` with its buttons, unchanged, into `PartList` inside a `<section className="parts-tray" aria-label="零件匣">` at the bottom, so every test that uses 零件清單 keeps working between T3 and T4. The part editor goes into `PartPanel`.

## 6. Parts tray with the mouse and keyboard (T4)

### 6.1 Tray model (R27, R28, R32, `src/workbench/tray-model.ts`)

```ts
export interface TrayCard {
  partId: string; name: string; parentName: string | null; color: string; primitive: Part['primitive'];
  sizeMm: { x: number; y: number; z: number }; interior: boolean; descendants: number; selected: boolean;
  pull: { ok: true; inPlace: boolean } | { ok: false; reason: string };   // reason: the R43 message
}
export function trayCards(ws: Workspace): TrayCard[];   // the active object's parts in model order; [] without one
export function cardLabel(card: TrayCard): string;      // "{name}" + " 屬於 {parent}" + " · {x} × {y} × {z} mm" + " · 內部" + " · 含 {n} 個子零件"
```

`pull` comes from `pullOutCheck`. The card's accessible name is `cardLabel`, which starts with the name (R28).

### 6.2 `PartsTray` (R27–R31)

`<section className="parts-tray" aria-label="零件匣">`, a heading with the object's name (not a button), 上一組零件 and 下一組零件 (rendered when the list overflows; `scrollBy({ left: ±clientWidth })`), and `<ul aria-label="零件清單">` with one `<li><button aria-pressed data-part-id>` per card: colour chip, `PRIMITIVE_ICONS[primitive]` (inline SVG, `aria-hidden`), name, the small lines, and `aria-describedby` pointing at 拖到畫面上即可拉出成新物件 (or the refusal reason). Roving focus: the selected card, else the first, has `tabIndex={0}`; ←, →, Home, End move the focus and `scrollIntoView({ inline: 'nearest' })`. Click and Enter or Space call `onPick(active.id, partId, shiftKey)`. Cards are disabled while `agentActive`.

### 6.3 Mouse drag (R33, R34, `card-drag.ts`)

```ts
export type DragState = { step: 'idle' } | { step: 'pressed'; partId: string; start: Point } | { step: 'dragging'; partId: string; point: Point; inZone: boolean };
export type DragEvent = { type: 'down'; partId: string; point: Point; allowed: boolean } | { type: 'move'; point: Point; inZone: boolean }
  | { type: 'up' } | { type: 'cancel' };
export function dragStep(state: DragState, event: DragEvent): { state: DragState; effect: 'none' | 'select' | 'start' | 'pull-out' | 'return' };
```

`down` with `allowed` false (agent run, mouse join, refused part) stays idle; a `move` beyond `TRAY_DRAG_START_PX` gives `start` (the tray selects the part, shows the ghost and calls `setPointerCapture`); `up` while dragging in the zone gives `pull-out`, out of it `return`; `up` while pressed is an ordinary click (the button's own click handler selects). Esc during a drag is caught by a capture-phase `keydown` listener the tray adds while dragging (`stopPropagation`, `cancel`). The ghost is one absolutely positioned element moved with `style.transform` in the `pointermove` handler; React renders only on `start` and the end. `inDropZone(point, freeArea(zoneRectsFromDom()), trayTop)` (`zones.ts`) is the R34 rule.

### 6.4 `App` wiring (R35, R40, R47, R50)

```ts
function pullOut(partId: string): boolean   // used by the tray drop, 拉出成新物件 and the hand carry
```

`if (agentActive) return false`; `before = store.current()`; `next = pullOutPart(before, { objectId: before.activeObjectId!, partId, newObjectId: crypto.randomUUID(), createdAt: new Date().toISOString() })`; `store.dispatch({ type: 'commit', next })`; clears `editSummary` and `adjustError`; sets the R35 message (in place when the new object's transform equals the in-place transform, read from `pullOutCheck(before, …).inPlace`); returns true. A `WorkspaceError` sets its message and returns false.

`confirmMouseJoin`: when `state.plan.a.objectId === state.plan.b.objectId`, it uses `splitForJoin` before `newJoint` and `addJoint`, commits once, opens the card and sets 已把「{part}」拉出成新物件，並接合「{a}」與「{b}」，請確認固定方式。 (`JOINT_NOTICES` keeps `joined` for the normal case).

### 6.5 Export scope line (R54)

`dialog-model.ts` gains `outsideAssembly(ws: Workspace, scope: ExportScope): string[]` (names of the objects not in `scopeWorkspace(ws, scope)`, in workspace order; `[]` for the workspace scope). `ExportDialog` shows `<p className="notice info">不在這個組合件中的物件不會匯出：{names joined by 、}。</p>` under the scope select when the list is not empty. No other export change.

## 7. Parts tray by hand (T5)

### 7.1 Registry (`src/workbench/screen-targets.ts`, R17, R26, R36, R37)

```ts
export interface CarryHandle { move(point: Point): void; drop(point: Point): boolean; cancel(): void }
export interface TargetEntry {
  id: string; label: string; element: HTMLElement;
  enabled(): boolean; press(): void;
  /** Draggable targets only: starts a carry, or null when a pull-out is not possible now. */
  carry?: (point: Point) => CarryHandle | null;
}
export interface ScreenTargetRegistry {
  register(entry: TargetEntry): () => void;
  /** Current rectangles of the registered elements, in registration order (later wins in pickTarget). */
  list(): ScreenTarget[];
  press(id: string): void;
  beginCarry(id: string, point: Point): CarryHandle | null;
  invalidate(): void;
}
export function createScreenTargets(read?: (element: HTMLElement) => DOMRect): ScreenTargetRegistry;
export const screenTargets: ScreenTargetRegistry;   // the app's one registry
export function useScreenTarget(ref: RefObject<HTMLElement | null>, entry: Omit<TargetEntry, 'element'>): void;
```

`list()` returns cached rectangles; the cache is invalidated by `register`, a window `resize`, the tray's `scroll`, a `ResizeObserver` on registered elements and any panel change (the HUD toggles move when the 零件 toggle appears), and is at most 250 ms old. Disabled entries stay in the list with `disabled: true` (`ScreenTarget` gains `disabled?: boolean` and `draggable?: boolean`), so a pinch over the tray during an agent run never turns the view; `press` and `beginCarry` do nothing for them. Registration order: HUD toggles and the demo button first, then the tray's scroll buttons, then the cards.

### 7.2 Controller (R36, `src/hands/controller.ts`)

- `HandPort` gains `beginCarry(id: string, point: Point): CarryHandle | null`; `pick` already returns `screen` targets from `pickTarget`.
- `Session.kind` gains `'carry'`; `Session.scene` holds the `CarryHandle`.
- `onDragStart(slot)` for an owner press session whose target is a draggable screen target and `fistAllowed(this.gate)`: `carry = port.beginCarry(id, track.cursor)`; if not null the session becomes `kind: 'carry'`. Otherwise it stays a press, and HM R27's rule applies (the drag does nothing).
- `follow`: a carry moves `carry.move(cursor)` unless `session.frozen` (the HM Task 10 freeze applies to carries as to grabs; `updateFreeze` no longer skips `kind === 'carry'`).
- `finishOnRelease`: a carry calls `carry.drop(session.lastPoint)` with the last unfrozen point and ends.
- Loss beyond the loss window, `reset()` (hidden page, gate off) and `setGate` to a level that does not allow it: `carry.cancel()`.
- `joinGesture` has no row for owner `press`, and a carry keeps owner kind `press` for the join rule, so a second hand stays inert.
- `GestureKind` gains `'carry'`; the overlay state for the owner is `grab`; `badgeText` gains the carry rows from `src/hands/text.ts`: 手勢：拉出 {name}, 手勢：放開拉出 {name} (the `inZone` flag comes from the last `move`, exposed by the handle as `inZone(): boolean`).

### 7.3 Wiring (`useHandControl.ts`, `PartsTray.tsx`, `Hud.tsx`)

`useHandControl` gains an optional input `screen?: ScreenTargetRegistry`; its port uses `pickTarget(point, screen?.list() ?? [], …)`, `press: id => screen?.press(id)` and `beginCarry: (id, point) => screen?.beginCarry(id, point) ?? null`. `App` passes `screenTargets` (one line). `PartsTray` registers each card with `carry` that selects the part, shows the same ghost as the mouse drag (§6.3) and on `drop` calls `pullOut(partId)` when `inDropZone`; `Hud` and `StartMessage` register the toggles and the demo button with `press` calling their click handler.

## 8. Data cards and panel tools (T6)

### 8.1 Shared schemas (`shared/workbench.ts`, R62, R72, R73)

```ts
export const MAX_DATA_CARDS = 4;
export const AgentPanelIdSchema = z.enum(['create', 'objects', 'joints', 'printer', 'details']);   // body-fit adds 'fit'
const PartRef = z.strictObject({ objectId: ObjectIdSchema, partId: PartIdSchema });
export const DataCardSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('part-size'), id: ObjectIdSchema, target: PartRef }),
  z.strictObject({ kind: z.literal('distance'), id: ObjectIdSchema, a: PartRef, b: PartRef }),
  z.strictObject({ kind: z.literal('joint'), id: ObjectIdSchema, jointId: ObjectIdSchema }),
  // design-fidelity: { kind: 'dimensions', id, objectId }; body-fit: { kind: 'fit', id, objectId }
]);
export const PanelChangeSchema = z.strictObject({ id: AgentPanelIdSchema, open: z.boolean() });
export const DataCardChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('show'), card: DataCardSpecSchema }),
  z.strictObject({ op: z.literal('hide'), cardId: ObjectIdSchema }),
  z.strictObject({ op: z.literal('clear') }),
]);
export const UiStateSchema = z.strictObject({ panels: z.array(z.string().max(20)).max(12), cards: z.array(DataCardSpecSchema).max(MAX_DATA_CARDS) });
```

`StateChangeSchema` gains `panel: PanelChangeSchema.nullable().optional()` and `dataCard: DataCardChangeSchema.nullable().optional()`; `AgentRequestSchema` gains `ui: UiStateSchema.optional()`. `checkedChange` and `applyStateEvent` strip both fields with `tryOn`, `exportDialog` and `cameraHidden`; `StateEffects` gains `panel?` and `dataCard?`; `useAgentRun` options gain `setPanel?(change)` and `applyDataCard?(change)`, called like `openExport`; `RunSnapshot` gains `ui?`, and `buildAgentRequest` sends it when present.

### 8.2 Measurements (`shared/measure.ts`, R62, R63)

```ts
export function partSizeMm(part: Part): { x: number; y: number; z: number };                 // dimensions × 1000, 1 decimal
export function partOriginWorld(object: SceneObject, partId: string): THREE.Vector3 | null;    // objectMatrix · worldMatrices
export function partDistanceMm(ws: Workspace, a: PartRef, b: PartRef): { centreMm: number; gapMm: number } | null;
```

`gapMm` is the distance between the parts' world boxes (each the model-frame `partBoxes` box transformed by `objectMatrix`, like `objectBox`), 0 when they overlap; it is approximate for rotated parts, so the card labels it 約. Three.js math only, so the server tool and the browser card use the same numbers.

### 8.3 Tools (`server/tools/show-panel.ts`, `server/tools/data-card.ts`, R71)

`show_panel({ panel: AgentPanelIdSchema, open: z.boolean() })`, label 開關面板, category `view`, effect `read-only`: no workspace needed; returns `ok` with the change `{ …null fields, panel: { id, open } }` and the summary 已開啟「{title}」面板。 or 已關閉「{title}」面板。.

`data_card({ action: z.enum(['show', 'hide', 'clear']), kind: z.enum(['part-size', 'distance', 'joint']).nullable().optional(), objectId, partId, otherObjectId, otherPartId, jointId, cardId: … .nullable().optional() })`, label 資料卡, category `view`, effect `read-only`. `show` checks the targets it needs (`MISSING_TARGET` when one is absent, `UNKNOWN_OBJECT`, `UNKNOWN_PART`, `UNKNOWN_JOINT`), builds the spec with `newObjectId()`, and summarises with `partSizeMm` / `partDistanceMm` / the joint's method and findings (`methodText`, `checkJoints`): 已在畫面上顯示「{part}」的尺寸：寬 {x} × 高 {y} × 深 {z} mm。 and so on. `hide` needs `cardId` (`UNKNOWN_CARD` when it is not in the request's `ui.cards`); `clear` always succeeds. Both tools are registered last, after `prepare_export`. `AGENT_INSTRUCTIONS` gains: "show_panel opens or closes a side panel (create, objects, joints, printer, details). Selecting parts opens the part panel by itself, and prepare_export opens the export panel." and "data_card shows a small card on the camera view: part-size, distance (between two parts) or joint. The numbers are computed locally; in your reply, use only numbers a tool or card returned. At most 4 cards; hide removes one, clear removes all." `workspaceSnapshot` adds `開啟的面板：…` and `畫面上的資料卡：{id} {kind} …` lines when `ui` is present.

### 8.4 Layer and placement (R61, R64–R70)

```ts
// src/workbench/data-cards/kinds.ts
export interface DataCardKind<S> {
  title(spec: S, ws: Workspace): string | null;          // null: the target is gone, hide the card
  rows(spec: S, ws: Workspace): Array<{ label: string; value: string }>;
  anchor(spec: S): Anchor;                              // { part } | { between: [part, part] } | { joint } | { screen: 'top-right' }
}
export const DATA_CARD_KINDS: { [K in DataCardSpec['kind']]: DataCardKind<Extract<DataCardSpec, { kind: K }>> };

// src/workbench/data-cards/placement.ts (pure)
export function placeCards(anchors: Array<{ id: string; point: Point | null; size: { w: number; h: number } }>, free: Rect): Map<string, { x: number; y: number; line: boolean }>;
```

`App` holds `cards: DataCardSpec[]` (session state; `applyDataCard` adds with the R65 limit, hides, clears; a card whose `title` is null is dropped on the next render). `DataCardLayer` renders each card (`role="group"`, `aria-label` = title, rows as text, 關閉資料卡) and subscribes to `SceneHandle.onRendered(listener): () => void` (new, called after each `renderer.render`); the listener asks `SceneHandle.anchorPoint(anchor)` (new: `projectPart`, the midpoint of two `projectPart` results, or the joint's two `projectFace` centres) for each card, runs `placeCards` with the free area, and writes `style.transform` and the leader line's coordinates. `DATA_CARD_KINDS` is a mapped type over the schema's kinds, so a kind added to the schema by `design-fidelity` or `body-fit` fails the type check until its entry exists.

## 9. Reachability, measurements and README (T7)

- `tests/e2e/reachability.spec.ts` turns the R78 table into data: for each row, a starting state (fresh page; one demo; two demos; a selected part; a joint; the camera on with fake hands) and the control's role and exact name; the test opens at most one toggle and expects the control to be visible and enabled (or disabled for the documented reason).
- Measurements reported (not asserted): `npm run build` chunk sizes against T3's report; the T1 pull-out timing; the time from 載入示範模型 to `onReady` on the full-screen canvas in e2e.
- README: the usage sections of "Hand control", "Assembly joints" and "Export" follow the new layout (R91): the HUD, the docks and their toggles, the tray and pulling a part out (mouse, 拉出成新物件, pinch), "joints connect objects" and removing a joint, data cards; the "status line under the camera" becomes the status bar.

## 10. Data shapes and migrations

| Shape | Change | Old data |
|---|---|---|
| `Workspace`, `SceneObject`, `ModelSpec`, `Part`, `Joint` | none; version stays 2 | unchanged |
| `ObjectChangeSchema` | new member `pull-out` (§3.5) | every old change parses |
| `StateChangeSchema` | `panel`, `dataCard`, optional and nullable (§8.1) | every old payload parses |
| `AgentRequestSchema` | `ui`, optional (§8.1) | every old request parses |
| `WorkspaceErrorCode` | `UNKNOWN_PART`, `WHOLE_OBJECT` | — |
| Session state in the browser | open panels, agent expanded, data cards | not persisted |

No migration runs: no workspace is persisted today (R52), and joints inside one object stay valid (R51).

## 11. Test strategy

Unit tests (Vitest in Node, `maxWorkers: 1`, no jsdom, fake `ModelProvider`, no real model call):

- **T1 `pull-out.test.ts`:** `subtreeIds` order; `pullOutCheck` for each code and for `inPlace`; the demo's `battery` (a child of `housing`) beside the original, its world box unchanged in size and shifted only along X; `housing` with its six children (`support` and `base` stay); the root of everything → `WHOLE_OBJECT`; `MAX_OBJECTS` → `OBJECT_LIMIT`; a rotated object and a rotated child: the pulled part's world corners equal the original's within 1e-5 m before placement; a joint between the subtree and the rest: re-pointed, in place, `touching` still true, `assemblyOf` contains both; a joint to another object: re-pointed, the original leaves the assembly; a joint inside the subtree; selection pruning; `activeObjectId` and `display.explode` unchanged; insertion after the original; untouched objects and joints keep their references; `placeNextTo` falls back left, front, back and past all; `applyWorkspaceChange` with the `pull-out` op equals `pullOutPart`; the change schema parses old payloads; `workspaceReducer` makes it one undo step and 復原 restores the original references; `splitForJoin` picks the non-ancestor side, side b when unrelated, and refuses at the limit; a timing line for 64 parts and 32 joints.
- **T1 `pull-out-export.test.ts` (real WASM, loaded as `export-pieces.test.ts` does):** two touching boxes in one object are one piece; after pulling one out they are two pieces (and `LOOSE_PIECE` is not reported for a one-piece object); a joint re-pointed by the pull-out still cuts its features.
- **T2 `pull-out-agent.test.ts`:** the tool's success (detail, summary, change, `checkedChange`), each error, `objectId` defaulting to the active object; `create_joint` on two parts of one object (one object change and one joint change, the joint between two objects) and at the limit; `applyStateEvent` sets `objectOp` and `recordUndo`. Extended: `tool-registry.test.ts` (the new tool, label, effect), `agent-loop.test.ts` (the changed joints line and the new lines), `agent-joint-tools.test.ts` ("joins two parts of one object that already touch" now expects the split, decision 5).
- **T3 `workbench-panels.test.ts`:** every R13 row as an edge and as a non-edge, R14 (a closed panel stays closed until its edge), toggles, `initialPanels`, the agent expansion, same reference when nothing changes. **`workbench-zones.test.ts`:** `freeArea` with and without each dock, narrow layout, `viewOffsetFor` (the target projects to the free area's centre within 1 px with a real `PerspectiveCamera`).
- **T4 `parts-tray.test.ts`:** `trayCards` (order, parent names, sizes, descendants, `pull` reasons), `cardLabel` starts with the name, `dragStep` for every transition, `inDropZone` edges, `outsideAssembly`. Extended: `export-dialog.test.ts` (`outsideAssembly`).
- **T5 `hand-tray.test.ts`** (the controller with a fake port and `syntheticHand` frames, like `hand-assemble.test.ts`): a tap on a card presses; a tap on a disabled card does nothing; a drag carries, moves the handle and drops; a drop outside the zone returns; the freeze on opening; loss cancels; a gate change cancels; carrying refused at `view-only` for the agent but allowed for the exploded view; a second hand stays inert; a drag from a non-draggable target does nothing (HM R27 kept); badges. **Registry tests** in the same file with a fake `read`: order, disabled entries, cache invalidation.
- **T6 `data-cards.test.ts`:** schemas (old `StateChange` and request payloads parse), `partSizeMm`, `partDistanceMm` (overlap gives 0, a known gap), `placeCards` (offset, clamping, stacking, off-screen anchors), the limit of 4. **`workbench-agent.test.ts`:** `show_panel` and `data_card` success and errors, `checkedChange` strips the fields, `applyStateEvent` effects, `workspaceSnapshot` lines. Extended: `tool-registry.test.ts`, `agent-loop.test.ts` (instruction lines), `apply-state.test.ts`.

E2E (Playwright; the fake camera; `tests/e2e/fake-hands.ts`; routed `/api/*`; `PLAYWRIGHT_GPU=1` on this laptop). The full suite takes about 25 minutes, so a task runs its own specs while it develops and the full suite once at the end where noted:

| Task | New or extended specs | Specs to run while developing | Full suite at the end |
|---|---|---|---|
| T1 | — | — | no (no browser change) |
| T2 | `pull-out.spec.ts` (a routed stream whose `state` frame pulls `battery` out: two objects, the message, 復原 restores) | `pull-out`, `agent-panel`, `workspace`, `joints` | no |
| T3 | `workbench-layout.spec.ts` (no page scroll at 1440 × 1000; opening and closing every panel by toggle, close button and Esc; focus return; `/`; auto-open edges for 零件, 物件, 接合, 生成與修改; exactly one 載入示範模型; the canvas box unchanged when panels change; the demo framed inside the free area), `workbench-helpers.ts` (`openPanel(page, title)`), selector updates in existing specs | `workbench-layout`, `workbench`, `edit-select`, `joints`, `workspace`, `agent-panel`, `export` | yes |
| T4 | `parts-tray.spec.ts` (cards, keyboard, a drag that pulls `battery` out beside, a drag that returns, 拉出成新物件, Esc during a drag, a refused drag, a joined part stays in place, 復原, a mouse join of two parts of one object, the export scope line) | `parts-tray`, `edit-select`, `joints`, `agent-panel`, `export`, `explode` | yes |
| T5 | `hand-tray.spec.ts` (a pinch tap selects a card, a pinch drag pulls a part out, a drag released over the tray returns, a pinch tap on a HUD toggle opens its panel, a pinch tap on 載入示範模型) | `hand-tray`, `hand-control`, `assembly-hands` | yes |
| T6 | `data-cards.spec.ts` (routed streams with `dataCard` and `panel` state frames: a card appears near its part and follows an orbit, 關閉資料卡, a card disappears with its part, the limit, `show_panel` opens 列印設定, the request carries `ui`) | `data-cards`, `agent-panel`, `export` | yes |
| T7 | `reachability.spec.ts` | `reachability` | yes |

Expected edits of existing e2e specs in T3 (selectors and panel opening only, R82): `workbench.spec.ts` (the demo assumption text is in 詳細資料: `openPanel(page, '詳細資料')`); `edit-select.spec.ts` (the empty-space click at 93 % of the canvas width lands on the right dock: use a free-area empty point, as `hand-control.spec.ts`'s `emptyPoint` does); `joints.spec.ts` (the sticky-canvas test becomes "the canvas stays in view and the page does not scroll when 新增接合 is pressed"; tests with one object that use 列印設定 open it first, and the `<summary>` click is replaced by `openPanel`). The session confirms the list by running the suite and reports any other edit.

## 12. File ownership

| File | This spec's tasks | Other specs that touch it (as far as known on 2026-11-26) |
|---|---|---|
| `shared/pull-out.ts` | T1 creates | — |
| `shared/workspace.ts` | T1 | design-fidelity (assumption: not needed for `shell`) |
| `shared/agent.ts` | T2, T6 | body-fit (try-on / fit detail schemas), english-ui (language line) — assumptions |
| `shared/workbench.ts`, `shared/measure.ts` | T6 creates | body-fit (`fit` kind), design-fidelity (`dimensions` kind) add members later |
| `server/tools/pull-out-part.ts`, `show-panel.ts`, `data-card.ts` | T2, T6 create | — |
| `server/tools/create-joint.ts` | T2 | — |
| `server/tools/index.ts`, `helpers.ts` | T2, T6 | body-fit (new tools), design-fidelity (`research_reference`) |
| `server/agent.ts` | T2, T6 | body-fit, design-fidelity, english-ui (instruction lines) |
| `src/App.tsx` | T2 (one branch), T3, T4, T5 (one prop), T6 | design-fidelity UI, body-fit UI, english-ui |
| `src/styles.css` | T3, T4, T5, T6 | design-fidelity, body-fit, english-ui |
| `src/scene/SceneViewport.tsx` | T3, T6 | body-fit (try-on rendering, occlusion), design-fidelity (cutaway, optional) |
| `src/workbench/**` | T3–T6 create | design-fidelity (`ObjectCaption`, `DetailsPanel`, `PartPanel` slots, `PRIMITIVE_ICONS.shell`), body-fit (`panels.ts` `fit` row, `data-cards/kinds.ts`), english-ui (`text.ts`) |
| `src/agent/AgentPanel.tsx`, `apply-state.ts`, `useAgentRun.ts`, `request.ts` | T2, T3, T6 | english-ui (strings) |
| `src/workspace/ObjectPanel.tsx`, `src/joints/JointPanel.tsx`, `PrinterPanel.tsx` | T3 | english-ui (strings) |
| `src/hands/types.ts`, `controller.ts`, `useHandControl.ts`, `text.ts`, `constants.ts` | T5 | body-fit (tracking for the fit, assumption: `useHandTracking.ts` and `src/try-on/**` only), english-ui (`text.ts`) |
| `src/export/dialog-model.ts`, `ExportDialog.tsx` | T4 | english-ui (strings) |
| `README.md` | T7 | every spec |
| `tests/e2e/*.spec.ts` (existing) | T3 (selectors), T4, T5 as listed | every spec that changes UI |

## 13. Parallel sessions and order

- Before the first edit of a file in the right column above, the session runs `git status --short <file>`; if it shows changes, another session is working on it: stop and ask, do not wait in a loop.
- Never revert, reformat or stage another session's changes; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`.
- Only one session runs Playwright at a time (ports 5197/8797); if they are taken, wait a few minutes and retry at most three times, then report. Never stop a process you did not start.
- The cross-spec order of `requirements.md` ("Dependencies on other specs") applies: T1 and T2 can run beside other specs' non-UI tasks; T3–T7 run one after the other and not at the same time as another spec's task that edits `App.tsx`, `styles.css`, `SceneViewport.tsx` or a panel component; `english-ui`'s string tasks for these files come after T7.

## 14. Requirement map

| Task | Content | Requirements |
|---|---|---|
| T1 | `shared/pull-out.ts`, the `pull-out` change, error codes, export proof | 39–49, 50 (`splitForJoin`), 51–53, 55, 83 (timing), 88 |
| T2 | `pull_out_part`, `create_joint` inside one object, instructions, the agent message | 50 (agent), 56, 57, 74 (pull-out and joints lines), 75–77, 80 |
| T3 | layout, HUD, docks, panel model, status bar, framing, demo button, moved part list, test updates | 1–16, 18 (model only), 19–25, 78 (layout rows), 79, 81, 82, 83 (pixel ratio), 84, 85 (layout), 86, 89 |
| T4 | the tray with the mouse and keyboard, 拉出成新物件, drop rule, mouse join inside one object, export line | 27–35, 38 (sizes), 50 (mouse), 54, 58, 60, 85 (SC 2.5.7, 2.5.8) |
| T5 | registry, draggable targets, carry, HUD and demo by pinch | 17, 26, 36, 37, 38 (tuning constants), 59 |
| T6 | data cards, measurements, `show_panel`, `data_card`, `ui` | 18, 61–73, 74 (panel and card lines) |
| T7 | reachability spec, measurements, README, manual checks | 78 (audit), 82, 83 (manual), 84, 91 |

R87, R88, R90 and R92 apply to every task.

## 15. Risks

- **T3 touches almost every UI file at once.** The layout change moves every control; the e2e suite is the safety net and takes about 25 minutes per run. Mitigation: the part list moves unchanged in T3 (§5.8), state and handlers stay in `App`, test edits go through one helper, and T3 stops and reports after two or three failed fixes of the same test.
- **Hands at the frame edges.** The tray is at the bottom and the HUD at the top of the camera image. The hand cursor is the thumb–index midpoint and the palm lies below it (`palmOffset` in `fake-hands.ts`), so reaching a tray card puts the palm near the bottom edge, where MediaPipe may lose the hand. Synthetic hands cannot show this. Mitigation: `TRAY_BOTTOM_GAP_PX`, `TRAY_CARD_MIN` and the HUD height are named constants, and the manual check measures the reach on the user's webcam.
- **Render cost of the full-screen canvas** on the integrated GPU shared with the MediaPipe GPU delegate (decision 14). Mitigation: the pixel-ratio cap, `?pixel-ratio`, and the before/after measurement in the manual check.
- **View offset and the gizmo.** `TransformControls` and `OrbitControls` read the camera's projection; the offset is part of it, so they should work unchanged. `edit-select.spec.ts`'s gizmo drag is the check.
- **Tool count.** 18 tools after T6; `body-fit` and `design-fidelity` may add more and pass VISION's 20-tool threshold (`find_tools`), which no spec owns yet.
- **Same-object joins change an AJ behaviour** (decision 5). If the user prefers to keep joints inside one object, T2 and T4 drop R50 and the one test edit, and nothing else changes.
