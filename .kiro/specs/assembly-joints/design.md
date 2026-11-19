# Assembly joints — Design

This design satisfies `requirements.md`. It follows the patterns of `workspace-v2` and `hand-manipulation`: pure modules in `shared/` unit-tested in Node, thin React and Three.js wiring covered by Playwright, and one place for every rule. Requirement numbers (R…) refer to `requirements.md`; they are stable ids, and R84–R88 (assemblies) were added in review. Task numbers (T1–T6) refer to `tasks.md`.

## 1. Approach

```
data         shared: joint, material, profile and standard-part tables; workspace v2 with joints,
             migration, operations, cascades, assemblies and rigid assembly moves        (T1)
geometry     shared, pure: world faces, contact regions, facing pairs, snap candidates, alignment,
             snap hysteresis, re-alignment, feature layout per method                     (T2)
rules + kit  shared, pure: checks, recommendations, BOM, assembly notes
             src/print: printablePart with manifold-3d (lazy, also runs in Node)          (T3)
browser      scene marks, join preview, print preview; mouse join; 接合 panel and card;
             材料 select; 列印設定                                                         (T4)
agent        create_joint, update_joint, remove_joint, set_material; state, snapshot, request (T5)
hands        the assemble join row, holds that move assemblies, live snap with the cue   (T6)
```

Three ideas carry the design:

1. **A joint stores choices; everything else is derived.** `Joint` holds the two sides (object, part, face), the method with its parameters, the needs and `confirmed`. `jointFeatures(workspace, profile)` derives every hole, pocket and boss, and the screw and pin lengths, from the geometry, the standard-parts table and the printer profile. Checks, recommendations, the BOM, the notes and the printable geometry all start from that one derivation, so they can never disagree, and a part edit or a profile change updates them all.
2. **One move operation.** `setTransform(ws, id, patch)` keeps its signature and moves the object's whole assembly as one rigid body (R85). Every path that moves objects already ends in it (the 物件 panel, the fist commit `onObjectMove`, the agent's `set_transform` tool, the `transform` op of `applyWorkspaceChange` in the browser and on the server), so all of them move assemblies without further changes, and the browser and the server compute the same result.
3. **Snapping and joining are pure functions of the workspace and two transforms.** The mouse join, the agent and the two-hand join call the same `planJoin` / `snapCandidates` / `alignTransform` functions; only the input differs (clicked parts, tool arguments, previewed hand poses).

## 2. Module layout

```
shared/ids.ts                 T1  ObjectIdSchema (moved from workspace.ts, re-exported there unchanged)
shared/materials.ts           T1  MaterialIdSchema, MATERIALS
shared/standard-parts.ts      T1  inserts, screws, clearance holes, tap drills, magnets, pins, glues; MagnetIdSchema, PinIdSchema
shared/printer.ts             T1  PrinterProfileSchema, DEFAULT_PRINTER_PROFILE, printedDiameter, printedDepth
shared/joint.ts               T1  FaceIdSchema, JointSideSchema, JointMethodSchema, JointNeedsSchema, JointSchema,
                                  CONTACT_FACES, faceShape, faceAllows, MAX_JOINTS, labels for faces and methods
shared/assembly.ts            T1  assemblyOf, objectMatrix, moveRigid (no workspace rules; type-only import of Workspace)
shared/workspace.ts           T1  version 2, migrateWorkspace, joints and material in the schemas and in assertWorkspace,
                                  setTransform via moveRigid, cascades in removeObject and replaceModel,
                                  addJoint, updateJoint, removeJoint, setMaterial, joinObjects,
                                  ObjectChange 'material', WorkspaceChange.joint
shared/joint-constants.ts     T2  snap, contact and feature constants (R28, R38)
shared/contact.ts             T2  worldFace, facePolygon, contactRegion, touching, facingPairs, snapCandidates,
                                  measurePair, alignTransform, snapStep, planJoin, realignJoint
shared/features.ts            T2  jointFeatures, featuresForJoint, partThickness, layoutPositions
shared/joint-rules.ts         T3  checkJoints, recommendFor, recommendJoint, newJoint, finding texts
shared/kit.ts                 T3  jointBom, assemblyNotes (re-exports assemblyOf, jointFeatures, checkJoints)
src/print/manifold.ts         T3  loadManifold (cached; ?url wasm in the browser, default resolution in Node)
src/print/printable.ts        T3  printablePart, toBufferGeometry
src/workspace/store.ts        T1  Snapshot gains joints
src/scene/joint-marks.ts      T4  buildPartMarks, markKey (Three.js objects for outlines and features)
src/scene/SceneViewport.tsx   T4  props joints, marks, showJoints, joinPreview, printPreview; data attributes; projectFace
                              T6  beginObjectHold moves the assembly; beginAssemble
src/joints/labels.ts          T4  Traditional Chinese tables: materials, methods, faces, needs, states, notices
src/joints/mouse-join.ts      T4  mouseJoinStep (pure state machine)
src/joints/card-model.ts      T4  jointRows, jointCardModel, derivedText (pure view models)
src/joints/printer-store.ts   T4  loadPrinterProfile, savePrinterProfile (Storage interface)
src/joints/JointPanel.tsx     T4  接合 panel: list, 新增接合, mouse-join status, the card
src/joints/JointCard.tsx      T4  the card
src/joints/PrinterPanel.tsx   T4  列印設定
src/workspace/ObjectPanel.tsx T4  材料 select
src/App.tsx                   T4  state, derived kit, commits and notices, mouse join routing, preview;
                              T5  joint changes from agent events, printer in the request;  T6 onAssemble
src/agent/request.ts, apply-state.ts, useAgentRun.ts, AgentPanel.tsx   T5
shared/agent.ts               T5  AgentRequestSchema.printer, ObjectSummary.material, JointToolDetailSchema,
                                  GetProjectStateDetail.joints
server/agent-tools.ts         T5  AgentWorkingState.printer
server/tools/create-joint.ts, update-joint.ts, remove-joint.ts, set-material.ts   T5  NEW
server/tools/index.ts, get-project-state.ts, set-transform.ts, server/agent.ts     T5  EDIT
src/hands/join.ts, controller.ts, types.ts, text.ts, stats.ts   T6  (hand-manipulation modules, after its Task 7)
src/scene/hand-sessions.ts    T6  createHoldSession over several roots; createAssembleSession
README.md                     T3 credit line;  T4 assembly-joints section;  T6 one line for the two-fist join

tests/unit/joint-data.test.ts      T1      tests/unit/joint-contact.test.ts   T2
tests/unit/joint-features.test.ts  T2      tests/unit/joint-rules.test.ts     T3
tests/unit/printable.test.ts       T3      tests/unit/joint-ui.test.ts        T4
tests/unit/agent-joint-tools.test.ts T5    tests/unit/hand-assemble.test.ts   T6
tests/e2e/joints.spec.ts           T4 (T5 adds the agent case)
tests/e2e/assembly-hands.spec.ts   T6
```

Dependency direction inside `shared/`: `ids` ← `materials`, `standard-parts` ← `printer`, `joint` ← `assembly` ← `workspace` ← `contact` ← `features` ← `joint-rules` ← `kit`. `assembly.ts` imports the `Workspace` type only, so `workspace.ts` can call it without a runtime cycle. Everything in `shared/` uses only Three.js math classes (R75).

## 3. Data (T1)

### 3.1 Schemas

```ts
// shared/materials.ts
export const MaterialIdSchema = z.enum(['pla', 'petg', 'abs', 'tpu', 'nylon', 'resin', 'aluminium', 'steel']);
export type Rating = 'good' | 'fair' | 'poor';
export interface Material {
  label: string; process: 'fdm' | 'resin' | 'metal'; flexible: boolean;
  inserts: boolean;                       // heat-set inserts suit it
  solvent: 'abs' | null;                  // solvent family
  glue: Record<GlueId, Rating>;           // ca, epoxy, solvent
  snapFit: Rating;                        // recorded for a later snap-fit spec
}
export const MATERIALS: Record<MaterialId, Material>;

// shared/standard-parts.ts
export const ThreadSchema = z.enum(['M2', 'M3']);
export const MagnetIdSchema = z.enum(['d6x2', 'd6x3', 'd8x3', 'd10x2', 'd10x3']);
export const PinIdSchema = z.enum(['d2', 'd3', 'd4']);
export const GlueIdSchema = z.enum(['ca', 'epoxy', 'solvent']);
export const INSERTS: Record<Thread, { lengthMm; outerMm; holeMm; vendor: 'CNC Kitchen'; label }>;
export const SCREWS: Record<Thread, { headMm; headHeightMm; lengthsMm: readonly number[]; clearanceMm; tapDrillMm }>;
export const MAGNETS: Record<MagnetId, { diameterMm; thicknessMm }>;
export const PINS: Record<PinId, { diameterMm; lengthsMm: readonly number[] }>;
export const GLUES: Record<GlueId, { label: string }>;

// shared/printer.ts
export const PrinterProfileSchema = z.strictObject({
  slidingFit: z.number().min(0).max(1), pressFit: z.number().min(0).max(0.5),
  holeCompensation: z.number().min(0).max(1), depthAllowance: z.number().min(0).max(1),
  petgExtra: z.number().min(0).max(0.5),
});
export const DEFAULT_PRINTER_PROFILE: PrinterProfile = { slidingFit: 0.25, pressFit: 0.10, holeCompensation: 0.20, depthAllowance: 0.20, petgExtra: 0.05 };
export type Fit = 'none' | 'press' | 'sliding';
export function printedDiameter(nominalMm: number, fit: Fit, profile: PrinterProfile, material: MaterialId | null): number;
//   nominal + holeCompensation + 2 × (fitAllowance + (material === 'petg' && fit !== 'none' ? petgExtra : 0)), rounded to 0.01
export function printedDepth(nominalMm: number, profile: PrinterProfile): number;   // nominal + depthAllowance

// shared/joint.ts
export const FaceIdSchema = z.enum(['+x', '-x', '+y', '-y', '+z', '-z']);
export const JointSideSchema = z.strictObject({ objectId: ObjectIdSchema, partId: PartIdSchema, face: FaceIdSchema });
export const JointMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('screw-insert'), size: ThreadSchema, count: z.number().int().min(1).max(4), insertSide: z.enum(['a', 'b']) }),
  z.strictObject({ kind: z.literal('magnet'), magnet: MagnetIdSchema, count: z.number().int().min(1).max(4) }),
  z.strictObject({ kind: z.literal('pin'), pin: PinIdSchema, count: z.number().int().min(1).max(4), fit: z.enum(['press-both', 'press-slide']) }),
  z.strictObject({ kind: z.literal('glue'), glue: GlueIdSchema }),
]);
export const JointNeedsSchema = z.strictObject({
  load: z.enum(['light', 'medium', 'heavy']).nullable(),
  disassembly: z.enum(['never', 'sometimes', 'often']).nullable(),
});
export const JointSchema = z.strictObject({
  id: ObjectIdSchema, a: JointSideSchema, b: JointSideSchema, method: JointMethodSchema,
  needs: JointNeedsSchema, confirmed: z.boolean(), createdAt: z.iso.datetime(),
});
export const MAX_JOINTS = 32;
export type FaceShape = 'rect' | 'disc' | 'ring';
export const CONTACT_FACES: Record<Part['primitive'], Partial<Record<FaceId, FaceShape>>> = {
  box: { '+x': 'rect', '-x': 'rect', '+y': 'rect', '-y': 'rect', '+z': 'rect', '-z': 'rect' },
  cylinder: { '+y': 'disc', '-y': 'disc' }, cone: { '-y': 'disc' }, tube: { '+y': 'ring', '-y': 'ring' },
  sphere: {}, torus: {},
};
export function faceShape(primitive: Part['primitive'], face: FaceId): FaceShape | null;
export function faceAllows(shape: FaceShape, method: JointMethod): boolean;   // ring → glue only
```

`CONTACT_FACES` is a `Record` over the primitive enum, so when `design-fidelity` adds `shell`, the type check fails until a `shell` row (as box) is added. That is the intended reminder.

### 3.2 Workspace version 2 and migration (R1, R2, R8)

```ts
export const WORKSPACE_VERSION = 2;
SceneObjectSchema = z.strictObject({ ...v1 fields, material: MaterialIdSchema.nullable().default(null) });
WorkspaceSchema   = z.strictObject({ version: z.literal(2), objects, activeObjectId, selection, display,
                                     joints: z.array(JointSchema).max(MAX_JOINTS) });
export function migrateWorkspace(input: unknown): unknown;   // { version: 1, ... } → { ...input, version: 2, joints: [] }; others unchanged
export function validateWorkspace(input: unknown): Workspace;  // migrate → parse → validate models → assertWorkspace
```

`material` defaults to `null` on parse, so an `add` object in an old `state` event or e2e frame stays valid (R2) and the parsed type always has the field. A version-1 object has no `material`, and the default fills it during the parse after migration. `createObject` sets `material: null`. Unit-test fixtures typed as `SceneObject` or `Workspace` gain `material: null` and `joints: []` (R73).

### 3.3 Invariants (R4)

`assertWorkspace` adds, after the existing checks: at most `MAX_JOINTS` joints; unique joint ids; for each side the object and the part exist, and `faceShape(part.primitive, side.face)` is not null; `faceAllows(shape, method)` for both sides; the two sides differ in `(objectId, partId)`; no two joints share the same unordered pair of `(objectId, partId, face)` sides. Magnet and pin ids are enforced by the schema. New `WorkspaceErrorCode`s with fixed messages:

| Code | Message |
|---|---|
| `JOINT_LIMIT` | 工作區最多 32 個接合，請先刪除一個接合。 |
| `UNKNOWN_JOINT` | 找不到指定的接合。 |
| `INVALID_JOINT` | 接合資料無效。 |

Contact (touching) is never checked here (R4, R88).

### 3.4 Assemblies and rigid moves (R84–R86)

```ts
// shared/assembly.ts
export function assemblyOf(ws: Pick<Workspace, 'objects' | 'joints'>, objectId: string, skipJointId?: string): string[];
export function objectMatrix(transform: ObjectTransform): THREE.Matrix4;     // compose(position, Euler XYZ degrees)
export function moveRigid(ws: Workspace, memberIds: readonly string[], anchorId: string, anchor: ObjectTransform):
  Map<string, ObjectTransform> | null;   // null when a member would leave the limits
```

- `assemblyOf`: breadth-first over joints whose sides name different objects (a same-object joint links nothing), skipping `skipJointId`; result in workspace order, always containing `objectId`.
- `moveRigid`: the anchor gets `anchor`. If only the position changed, every other member's position moves by the same offset and its rotation object is kept by reference (R85: "leaves their rotations untouched"). Otherwise `D = M(anchor) · M(old anchor)⁻¹` and each member gets `D · M(member)`, decomposed into a position (rounded to 5 decimals) and XYZ Euler degrees (rounded to 2). Results outside ±100 m or ±360° return `null`.
- `setTransform(ws, id, patch)` in `workspace.ts`: merges and validates the patch as today; if unchanged returns `ws`; otherwise `moveRigid(ws, assemblyOf(ws, id), id, merged)`; `null` throws `INVALID_WORKSPACE` (R86); members whose values did not change keep their object reference.
- **Drift test (R85).** A box pair joined `+x`/`-x`, rotated 30° about Y: 200 random position moves and 20 random rotations through `setTransform`; after each step `touching` (§4.2, T2) holds. T1 writes the test with a local plane-gap helper; T2 switches it to `touching`.

### 3.5 Operations (R5, R6)

```ts
export function setMaterial(ws, objectId, material: MaterialId | null): Workspace;
export function addJoint(ws, joint: Joint): Workspace;                // JOINT_LIMIT, INVALID_JOINT, UNKNOWN_OBJECT
export function updateJoint(ws, jointId, patch: { method?: JointMethod; needs?: Partial<JointNeeds>; confirmed?: boolean }): Workspace;
export function removeJoint(ws, jointId): Workspace;                  // UNKNOWN_JOINT
export function joinObjects(ws, input: { moves: ReadonlyArray<{ objectId: string; transform: ObjectTransform }>; joint: Joint }): Workspace;
export function jointsRemovedBy(before: Workspace, after: Workspace): number;   // for the cascade notice
```

- `joinObjects` applies at most two moves through `setTransform` (each moves its assembly), then `addJoint`, and returns one workspace, so a join is one `commit` (R7).
- `updateJoint` never changes the sides; a joint whose sides must change is removed and added again.
- **Cascades.** `removeObject` filters out joints naming the object. `replaceModel` filters out joints whose part is gone or whose `faceShape(newPrimitive, face)` is null or no longer allows the method. Both happen before `assertWorkspace`, inside the same operation.
- `setMaterial` does not touch `edited` (R10).
- `realignJoint` needs the alignment maths and lives in `contact.ts` (T2, §4.6).

### 3.6 Changes and state events (R65, schema part)

```ts
ObjectChangeSchema gains z.strictObject({ op: z.literal('material'), objectId, material: MaterialIdSchema.nullable() });
export const JointChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), joint: JointSchema }),
  z.strictObject({ op: z.literal('update'), joint: JointSchema }),     // replaces method, needs, confirmed of the joint with this id
  z.strictObject({ op: z.literal('remove'), jointId: ObjectIdSchema }),
]);
WorkspaceChangeSchema gains joint: JointChangeSchema.nullable().optional();
```

`applyWorkspaceChange` applies, in order: activation, object (the `transform` op calls `setTransform`, so an assembly moves; `material` calls `setMaterial`), joint, selection, explode. `StateChangeSchema` spreads `WorkspaceChangeSchema.shape`, so it gains `joint` without an edit. T5 makes `applyStateEvent` record an undo step when `object !== null || joint` is set.

### 3.7 Undo store (R7)

`Snapshot = Pick<Workspace, 'objects' | 'activeObjectId' | 'joints'>`; `snapshotOf` and `restoreSnapshot` carry `joints`. The array is shared by reference like `objects`. Nothing else in the reducer changes.

### 3.8 Material table (R9, R12, R13)

| id | label | process | flexible | inserts | CA | epoxy | solvent | snap-fit |
|---|---|---|---|---|---|---|---|---|
| `pla` | PLA | fdm | no | yes | good | good | poor | poor |
| `petg` | PETG | fdm | no | yes | fair | good | poor | fair |
| `abs` | ABS | fdm | no | yes | good | good | good | fair |
| `tpu` | TPU | fdm | yes | no | fair | poor | poor | good |
| `nylon` | 尼龍 | fdm | no | yes | poor | fair | poor | good |
| `resin` | 樹脂 | resin | no | no | good | good | poor | poor |
| `aluminium` | 鋁 | metal | no | no (tapped) | fair | good | poor | — (`poor`) |
| `steel` | 鋼 | metal | no | no (tapped) | fair | good | poor | — (`poor`) |

`solvent` family is `abs` for ABS only. The ratings are advisory starting points; the reviewer checks them with the standard-parts numbers. A part with `role: 'interior'` is a **component** regardless of the object's material (R12).

### 3.9 Standard-parts values (R14, R15)

As in R15, with comments citing: the CNC Kitchen M2×3 and M3×5.7 product pages and datasheets (insert length, hole Ø, outer Ø; the M2 outer Ø is taken from its datasheet when Task 1 is built and marked "verify" if the page does not give it); ISO 4762 (head Ø and height); ISO 273 medium series; ISO 261 tap drill tables; one magnet supplier datasheet for the disc sizes; ISO 8734 for pins. `tests/unit/joint-data.test.ts` pins every number.

### 3.10 Printed sizes (R17, R18)

`printedDiameter` and `printedDepth` are the only places where the profile meets a nominal size. The fit class per feature kind is a table in `features.ts` (§5.1), copied from R18. Machined features (metal) never call them; their diameter is the nominal one.

## 4. Contact and snapping (T2)

### 4.1 World faces

```ts
export interface LocalFace { axis: 0 | 1 | 2; sign: 1 | -1; shape: FaceShape; centre: Vector3; normal: Vector3; u: Vector3; v: Vector3;
  half: { u: number; v: number }; inner: number | null /* ring: tubeRatio */ }
export interface WorldFace extends LocalFace { side: JointSide; matrix: Matrix4 /* object · part world */ }
export function localFace(part: Part, face: FaceId): LocalFace | null;
export function worldFace(object: SceneObject, part: Part, face: FaceId, transform?: ObjectTransform): WorldFace | null;
export function facePolygon(face: WorldFace): Vector3[];   // rect: 4 corners; disc and ring: DISC_SEGMENTS points of the outer ellipse
```

For face axis `k` and sign `s`: centre `s · dims[k] / 2 · e_k`, normal `s · e_k`, `u = e_(k+1)%3`, `v = e_(k+2)%3`, half extents `dims[u] / 2`, `dims[v] / 2`. Cylinder and cone caps are ellipses (`dims.x`, `dims.z`), the same shape the display geometry has after scaling. The part matrix is `worldMatrices(model)` from `shared/bounds.ts`, cached per model in a `WeakMap`; the object matrix is `objectMatrix(transform ?? object.transform)`, so previewed transforms can be passed in.

### 4.2 Touching and the contact region (R22)

```ts
export interface Region { origin: Vector3; normal: Vector3; u: Vector3; v: Vector3; polygon: Array<{ x: number; y: number }>; areaMm2: number }
export function contactRegion(a: WorldFace, b: WorldFace): Region | null;   // in a's plane frame, metres
export function touching(a: WorldFace, b: WorldFace): { ok: boolean; gapMm: number; angleDeg: number; region: Region | null };
```

The region is computed in a's plane: b's polygon is projected onto that plane and clipped against a's polygon with Sutherland–Hodgman (both are convex). For a ring the area is the outer clip minus the clip of the inner ellipse. `touching` requires `angle ≤ CONTACT_ANGLE_DEG`, `|gap| ≤ CONTACT_GAP_MM` where the gap is measured along a's normal at the region's centroid, and `area ≥ MIN_CONTACT_MM2`.

### 4.3 Facing pairs and snap candidates (R23)

```ts
export interface PairMetrics { a: JointSide; b: JointSide; gapMm: number; angleDeg: number; overlapMm2: number; key: string }
export function facingPairs(ws: Workspace, a: { objectId: string; partId?: string }, b: { objectId: string; partId?: string },
  transforms?: ReadonlyMap<string, ObjectTransform>): PairMetrics[];          // ranked; no distance limit
export function snapCandidates(ws: Workspace, aObjectId: string, bObjectId: string,
  transforms: ReadonlyMap<string, ObjectTransform>): PairMetrics | null;   // best within the engage limits
export function measurePair(ws: Workspace, a: JointSide, b: JointSide, transforms?: ReadonlyMap<string, ObjectTransform>): PairMetrics | null;
```

Both enumerate the contact faces of the exterior parts (or of the given part), compute world faces once per call, reject pairs by normal angle first (`dot(nA, nB) > −cos SNAP_ANGLE_DEG`), then by gap, then compute the projected overlap. `facingPairs` needs each centre in front of the other face (`gap ≥ −SNAP_PENETRATION_MM` both ways); `snapCandidates` needs `−SNAP_PENETRATION_MM ≤ gap ≤ SNAP_DISTANCE_MM`. Ranking: gap, angle, larger overlap, then `key` (`objectId:partId:face|objectId:partId:face`). `key` identifies a pair for the hysteresis.

**Budget (R76).** Two 64-part box objects give at most 384 × 384 face pairs; the angle test is a dot product, and only parallel, facing pairs reach the polygon clip. Target: under 2 ms per call on the user's laptop; a unit test asserts under 25 ms for that worst case in Node (a loose bound against regressions, not a benchmark); the debug panel (T6) shows the measured time.

### 4.4 Alignment (R24)

```ts
export function alignTransform(ws: Workspace, a: JointSide, b: JointSide, transforms?: ReadonlyMap<string, ObjectTransform>):
  ObjectTransform | null;    // side b's object's new transform; null when the angle exceeds SNAP_ANGLE_DEG or the result leaves the limits
```

1. `q = setFromUnitVectors(nB, −nA)`; rotate b's object about b's face centre `pB`: `T1 = T(pB) · R(q) · T(−pB) · M_b`.
2. Translate along `nA` by `−((pB − pA) · nA)` so the planes meet.
3. If the in-plane distance between the face centres is below `CENTRE_SNAP_MM`, translate by that in-plane difference too.
4. Decompose to position (5 decimals) and XYZ Euler degrees (2 decimals). A unit test checks that `touching` holds after rounding for rotated objects and parents.

The caller applies it with `setTransform`, so b's assembly follows (R24, R85).

### 4.5 Snap hysteresis (R25)

```ts
export interface SnapState { key: string | null; since: number; ready: boolean; rival: { key: string; since: number } | null }
export const initialSnapState: SnapState;
export function snapStep(state: SnapState, best: PairMetrics | null, held: PairMetrics | null, now: number): SnapState;
```

`best` is `snapCandidates` (engage limits); `held` is `measurePair` for `state.key` (no limits). Not ready: the same `best.key` for `SNAP_SETTLE_MS` → ready; another key restarts the timer; none resets. Ready: `held` missing, `held.gapMm > SNAP_RELEASE_MM` or `held.angleDeg > SNAP_RELEASE_DEG` → not ready; a different `best.key` held as `rival` for `SNAP_SETTLE_MS` replaces the key and stays ready.

### 4.6 Planning a join and re-alignment (R26, R27, R52, R64)

```ts
export type JoinPlan =
  | { ok: true; a: JointSide; b: JointSide; move: { objectId: string; transform: ObjectTransform } | null; pairs: PairMetrics[] }
  | { ok: false; code: 'NO_CONTACT_FACE' | 'CANNOT_ALIGN' | 'NOT_TOUCHING'; message: string };
export function planJoin(ws: Workspace, a: { objectId: string; partId?: string; face?: FaceId },
  b: { objectId: string; partId?: string; face?: FaceId }, pairIndex?: number): JoinPlan;
export function realignJoint(ws: Workspace, jointId: string): Workspace;   // throws WorkspaceError; see below
```

`planJoin` takes the given faces or `facingPairs(…)[pairIndex ?? 0]`. When the two objects are the same or already in one assembly (`assemblyOf`), the faces must already touch (`NOT_TOUCHING`, 這兩個面沒有貼合；已接合在一起的零件只能在接觸面上新增接合。); otherwise, if they do not touch, `alignTransform` gives `move` for b's object (`CANNOT_ALIGN`, 兩個面的方向差太多，請先旋轉物件。). No contact face or no facing pair → `NO_CONTACT_FACE` (這兩個零件沒有可以接合的平面。).

`realignJoint`: `alignTransform` for the joint's sides; the members are `assemblyOf(ws, b.objectId, jointId)`; if they include `a.objectId`, it throws `WorkspaceError('LINKED')` (這兩個物件還透過其他接合相連，無法單獨對齊。); otherwise `moveRigid(ws, members, b.objectId, aligned)`. Angle too large throws `CANNOT_ALIGN`. Two more codes join `WorkspaceErrorCode`: `CANNOT_ALIGN`, `LINKED`.

### 4.7 Constants (`shared/joint-constants.ts`, R28, R38)

| Constant | Default | Constant | Default |
|---|---|---|---|
| `CONTACT_ANGLE_DEG` | 1 | `SNAP_RELEASE_MM` | 15 |
| `CONTACT_GAP_MM` | 0.1 | `SNAP_RELEASE_DEG` | 25 |
| `MIN_CONTACT_MM2` | 20 | `DISC_SEGMENTS` | 32 |
| `SNAP_ANGLE_DEG` | 15 | `EDGE_MARGIN_MM` | 1.2 |
| `SNAP_PENETRATION_MM` | 3 | `CLAMP_FLOOR_MM` | 2.0 |
| `SNAP_DISTANCE_MM` | 10 | `SCREW_TAIL_MM` | 3.0 |
| `CENTRE_SNAP_MM` | 3 | `MIN_FLOOR_MM` | 1.0 |
| `SNAP_SETTLE_MS` | 150 | `BOSS_WALL_MM` | 1.6 |
| | | `MIN_ENGAGEMENT_FACTOR` | 1.5 |

## 5. Features (T2)

### 5.1 Output

```ts
export type FeatureKind = 'insert-hole' | 'clearance-hole' | 'counterbore' | 'boss' | 'magnet-pocket' | 'pin-hole' | 'tapped-hole' | 'drilled-hole';
export interface JointFeature {
  id: string;                     // `${jointId}:${side}:${position}:${kind}`, stable
  jointId: string; side: 'a' | 'b'; objectId: string; partId: string;
  kind: FeatureKind;
  centre: Vector;                 // part-local metres: on the face where it starts (for a boss: on the face it grows from)
  axis: Vector;                   // unit, part-local: into the material (for a boss: the direction it grows)
  diameter: number; depth: number; through: boolean;   // metres; `through` means to the far face
  fit: Fit; made: 'printed' | 'machined';
  nominal: { diameterMm: number; depthMm: number };
}
export interface JointDerived { positions: number; screwLengthMm: number | null; pinLengthMm: number | null; contactAreaMm2: number;
  thicknessMm: { a: number; b: number } }
export type FeatureProblem = { code: 'APART' | 'NO_FACE' | 'NO_ROOM' | 'TOO_THIN' | 'NO_LENGTH' | 'COMPONENT_FEATURE'; side?: 'a' | 'b' };
export interface JointFeatureSet { features: JointFeature[]; derived: JointDerived; problems: FeatureProblem[] }
export interface FeatureSet { joints: Map<string, JointFeatureSet>; parts: Map<string /* objectId:partId */, JointFeature[]> }
export function jointFeatures(ws: Workspace, profile: PrinterProfile): FeatureSet;
export function featuresForJoint(ws: Workspace, joint: Joint, profile: PrinterProfile): JointFeatureSet;   // for recommendations
```

A joint whose faces do not touch gets `APART` and its features are still laid out on side a's face, so the markers stay visible and the export can decide (R40).

### 5.2 Thickness (R30)

`partThickness(part, face, at?)`: the part's dimension along the face axis. A cone's base is thinner away from its axis: `h · (1 − ρ)`, with `ρ` the feature footprint's outer distance from the axis relative to the base radius. `design-fidelity` adds a `shell` branch (the wall from `tubeRatio`). Components and metal parts use the same function.

### 5.3 Layout (R30)

Positions are computed in the contact region's 2D frame. The **footprint** of a joint is the largest diameter it puts on either face (insert hole, counterbore, magnet pocket, pin hole, or the boss outer Ø). A point is valid when its distance to every region edge is at least `footprint / 2 + EDGE_MARGIN_MM`. The long axis `e` is the principal axis of the region polygon (covariance of its vertices); `f ⟂ e`.

| Count | Pattern |
|---|---|
| 1 | the centroid `c` |
| 2 | `c ± t·e` |
| 3 | `c`, `c ± t·e` when the extent along `e` is ≥ 1.5 × the extent along `f`; otherwise a triangle at radius `t`, angles 90°, 210°, 330° |
| 4 | `c ± t·e ± t·r·f`, with `r` = extent along `f` ÷ extent along `e` |

`t` is the largest value with every point valid, found by bisection (valid points form a convex set, so validity is monotone in `t`). Two points must be at least `2 × footprint` apart; if no `t` satisfies both rules, the joint gets `NO_ROOM`. Positions are mapped to world points in the plane and then into each side's part-local frame with the inverse matrices.

### 5.4 Per method (R31–R37)

Let `c` be the clamp thickness on the screw side, `t_a`, `t_b` the thicknesses at the positions, `d` the thread diameter.

- **Screws with inserts** (insert side `i`, screw side `s`):
  - Printed `i`: an `insert-hole` of `printedDiameter(insert.holeMm, 'none')`, depth `printedDepth(insert.lengthMm)`. Below it, a `clearance-hole` of the screw clearance Ø: blind for `SCREW_TAIL_MM` when `t_i ≥ insertDepth + SCREW_TAIL_MM + MIN_FLOOR_MM`, otherwise through to the back face. When `t_i < insertDepth + MIN_FLOOR_MM`, a `boss` of outer Ø `insert.outerMm + 2 · BOSS_WALL_MM` grows from the far face by `insertDepth + MIN_FLOOR_MM − t_i`, and the tail goes through it (R33).
  - Metal `i`: a `tapped-hole` (tap drill Ø, machined), depth `min(t_i, d · MIN_ENGAGEMENT_FACTOR + 1)`, through when the part is thinner; no insert in the BOM (R32).
  - Component `i`: `COMPONENT_FEATURE` (the card shows it; the recommendation never picks it).
  - Printed `s`: a through `clearance-hole` (ISO 273 medium + hole compensation); when `t_s > CLAMP_FLOOR_MM`, a `counterbore` of `printedDiameter(screw.headMm, 'sliding')` from the far face down to `CLAMP_FLOOR_MM` above the contact face, so `c = CLAMP_FLOOR_MM`; otherwise `c = t_s` and the head sits on the surface. Metal `s`: a machined `drilled-hole`, no counterbore, `c = t_s`. Component `s`: no features, `c = t_s` (the component's own holes).
  - Screw length: the shortest standard length `L` with `L ≥ c + MIN_ENGAGEMENT_FACTOR · d` and `L ≤ c + insertDepth + tail` (`tail` = `SCREW_TAIL_MM`, or the rest of the part when the hole goes through); none → `NO_LENGTH`. With the defaults: an M3 joint with a 2 mm clamp needs 6.5–10.9 mm and gets M3×8; an M2 joint needs 5–8.2 mm and gets M2×5.
- **Magnets:** on each printed side a `magnet-pocket` of `printedDiameter(magnet.diameterMm, 'press')`, depth `printedDepth(magnet.thicknessMm)`, open at the contact face; `t < depth + MIN_FLOOR_MM` → `TOO_THIN`. Metal side: a machined pocket of the nominal size. Component side: `COMPONENT_FEATURE`.
- **Pins:** the pin length `L` is the longest standard length with `L / 2 + depthAllowance + MIN_FLOOR_MM ≤ min(t_a, t_b)` and `L ≥ 2 × pin Ø`; none → `NO_LENGTH`. Each side gets a blind `pin-hole` of depth `printedDepth(L / 2)`, press fit on side a, and on side b press (`press-both`) or sliding (`press-slide`).
- **Glue:** no features; `derived.contactAreaMm2` feeds the checks.

### 5.5 Collisions

After all joints are laid out, features on the same part are tested pairwise as cylinders projected onto the part's faces (axis-aligned, so a 2D circle test per face plus depth ranges along the axis). Two features of different joints that intersect give both joints an `OVERLAP` finding (§6.1). Features of one joint never collide, by construction of the layout.

## 6. Checks, recommendations and the kit (T3)

### 6.1 Findings (R39, R40)

```ts
export interface Finding { jointId: string; severity: 'error' | 'warning' | 'info'; code: FindingCode; message: string }
export function checkJoints(ws: Workspace, profile: PrinterProfile, features = jointFeatures(ws, profile)): Map<string, Finding[]>;
```

| Severity | Code | Message (Traditional Chinese, fixed) |
|---|---|---|
| error | `APART` | 已分開，可按「重新對齊」。 (inside one object: 接合面已分開，請調整零件。) |
| error | `NO_FACE` | 接合面已不存在，請刪除這個接合。 |
| error | `NO_ROOM` | 接合面太小，放不下 {n} 個{item}。 |
| error | `TOO_THIN` | 「{part}」太薄，放不下{item}。 |
| error | `NO_LENGTH` | 沒有合適長度的標準{螺絲／定位銷}。 |
| error | `OVERLAP` | 與另一個接合的孔位重疊。 |
| error | `COMPONENT_FEATURE` | 「{part}」是外購件，無法加工{item}。 |
| warning | `GLUE_POOR` | 「{material}」不易用{glue}黏合。 |
| warning | `SOLVENT_NOT_ABS` | 溶劑黏合只適用於兩側都是 ABS。 |
| warning | `METAL_GLUE` | 金屬與塑膠建議用螺絲或銷固定。 |
| warning | `INSERT_UNSUITABLE` | 「{material}」不適合熱壓螺母。 |
| warning | `BOSS_COLLIDES` | 螺柱會碰到「{part}」。 |
| info | `SAME_MATERIAL` | 同材質接合最容易。 |
| info | `NO_MATERIAL` | 未指定材料，先以一般 FDM 塑膠估算。 |
| info | `PETG_EXTRA` | PETG 已加大配合間隙 {n} mm。 |
| info | `RESIN_PROFILE` | 列印設定是依 FDM 調整的，樹脂列印請另行測試。 |
| info | `MACHINED` | 金屬零件需另行加工。 |
| info | `BOSS_ADDED` | 已在背面加上螺柱。 |
| info | `THROUGH_HOLE` | 螺絲孔貫穿到背面。 |

`{item}` is one of 熱壓螺母, 螺絲頭沉孔, 磁鐵, 定位銷. Findings are sorted error, warning, info, then by code, so the card and the agent see a stable order. `BOSS_COLLIDES` tests the boss cylinder against the part boxes of the same object (`partBoxes`).

### 6.2 Recommendations (R41, R42)

```ts
export interface Recommendation { method: JointMethod; ok: boolean; reasons: string[] }
export function recommendFor(ws: Workspace, sides: { a: JointSide; b: JointSide }, needs: JointNeeds, profile: PrinterProfile,
  excludeJointId?: string): Recommendation[];          // one per method kind, ranked
export function recommendJoint(ws: Workspace, jointId: string, profile: PrinterProfile): Recommendation[];
export function newJoint(ws: Workspace, input: { id: string; createdAt: string; a: JointSide; b: JointSide }, profile: PrinterProfile): Joint;
//   top recommendation, needs { load: null, disassembly: null }, confirmed false (R42)
```

1. **Variants per kind**, in order; the first variant with no error from `featuresForJoint` (and no `OVERLAP` with other joints) represents its kind:
   - screws: M3 ×2, M3 ×1, M2 ×2, M2 ×1; insert side: printed sides whose material takes inserts (thicker first), then metal sides; never a component or a TPU or resin side;
   - magnets: 10×3, 10×2, 8×3, 6×3, 6×2, each ×2 then ×1;
   - pins: Ø4, Ø3, Ø2, each ×2 then ×1; fit `press-both` when disassembly is `never`, else `press-slide`;
   - glue: solvent when both sides are ABS; otherwise epoxy or CA, whichever has the better worse-side rating (epoxy on ties when a side is metal, CA otherwise).
2. **Order by needs** (unknown → medium load, sometimes, with the assumption reason first):

   | Disassembly | Light | Medium | Heavy |
   |---|---|---|---|
   | often | magnet, screw, pin, glue | screw, magnet, pin, glue | screw, magnet, pin, glue |
   | sometimes | magnet, screw, pin, glue | screw, pin, magnet, glue | screw, pin, magnet, glue |
   | never | glue, pin, screw, magnet | glue, pin, screw, magnet | screw, glue, pin, magnet |

3. **Adjustments:** kinds without a valid variant go last (`ok: false`, with the reason of their first variant's problem); a metal–plastic pair moves glue behind every valid kind; glue whose worse side rates `poor` moves behind pins.
4. **Reasons** (first match per kind, plus the context lines): 螺絲配熱壓螺母最牢固，也能重複拆裝。 · 磁鐵拆裝最方便，適合輕負重。 · 定位銷對位準確，壓入後很牢固。 (with `press-slide`: 一側滑配，可以拆開。) · 膠合不需加工，但之後無法拆開。 · context: the assumption line of R41, 金屬側使用攻牙孔，不需熱壓螺母。, 「{material}」不適合熱壓螺母，改用其他方式。

### 6.3 BOM (R68)

```ts
export interface BomItem { kind: 'screw' | 'insert' | 'magnet' | 'pin' | 'glue'; standardId: string; label: string; quantity: number; jointIds: string[] }
export function jointBom(ws: Workspace, profile: PrinterProfile, features = jointFeatures(ws, profile)): BomItem[];
```

Aggregated by `standardId` (`M3x8`, `M3x5.7`, `d6x3`, `d3x10`, `ca`); ordered screws, inserts, magnets, pins, glue, then by size. Labels: 「M3×8 內六角螺絲（ISO 4762）」, 「M3×5.7 熱壓螺母（CNC Kitchen）」, 「6×3 mm 圓形釹磁鐵」, 「Ø3×10 mm 定位銷（ISO 8734）」, 「瞬間膠（CA）」, 「AB 膠（環氧樹脂）」, 「溶劑（ABS 用，例如丙酮）」. Magnets count `2 × count` (one per side and position). A joint with an error that removes a length (`NO_LENGTH`) contributes no screw or pin item, and `export` reads the finding.

### 6.4 Assembly notes (R69)

```ts
export function assemblyNotes(ws: Workspace, profile: PrinterProfile, features = jointFeatures(ws, profile)): Array<{ jointId: string; text: string }>;
```

Joints sorted by `createdAt`, then id. Templates:

- screws: 先用烙鐵把 {n} 顆 {size} 熱壓螺母壓入「{insertPart}」，再用 {n} 支 {size}×{L} 螺絲從「{screwPart}」鎖上。 (metal: …鎖入「{part}」的 {size} 螺紋孔（需先攻牙）。; component: …穿過「{part}」原有的孔…)
- magnets: 把 {2n} 顆 {d}×{t} mm 磁鐵壓入「{a}」與「{b}」的孔位，壓入前先確認兩側磁極相吸。
- pins: 把 {n} 支 Ø{d}×{L} mm 定位銷壓入「{a}」，再對準「{b}」壓合。 (`press-slide`: …再把「{b}」套上；這一側是滑配，可以拆開。)
- glue: 在「{a}」與「{b}」的接觸面塗上{glue}，對準後壓緊直到固化。

Part names are `「{object name}・{part name}」` when the two sides belong to different objects.

## 7. Printable geometry (T3)

### 7.1 Spike first

Task 3 starts with a spike, in this order, before any other code:

1. `npm install manifold-3d@3.2.1 --save-exact`. `npm ls --all manifold-3d` and the lockfile diff must show no other new packages (3.2.1 has no dependencies; 3.3 and later pull in esbuild-wasm and glTF-Transform).
2. In a Vitest file, `const wasm = await Module(); wasm.setup();`, build `Manifold.cube([10, 10, 10], true).subtract(Manifold.cylinder(12, 2, 2, 48, true))`, and read its volume and mesh. This confirms Node loading under `pool: 'threads'` and `isolate: false`, and the exact API names in 3.2.1 (`volume()` or `getProperties()`, `getMesh()`, `transform`, `delete`).
3. In the browser: a dynamic `import('../print/printable')` from a temporary button or the e2e test of Task 4, with the wasm URL from `import wasmUrl from 'manifold-3d/manifold.wasm?url'` passed as `locateFile`. `npm run build` must emit the wasm as an asset and manifold's JS in its own chunk (not in the main chunk), with no network request at run time.
4. Record the sizes (JS, wasm, gzip) and the loading code in the task report.

If any step fails after two or three attempts, the task stops and reports. The fallback (`three-bvh-csg` with welded input meshes and a manifold check) is a decision for the user, not for the task.

### 7.2 Interface (R43–R46)

```ts
// src/print/printable.ts
export interface PrintableMesh { positions: Float32Array /* mm, xyz */; indices: Uint32Array; volumeMm3: number }
export interface PrintableResult { mesh: PrintableMesh; applied: string[]; skipped: Array<{ featureId: string; reason: 'problem' | 'invalid' }> }
export async function printablePart(part: Part, features: readonly JointFeature[], options?: { skip?: ReadonlySet<string> }): Promise<PrintableResult>;
export function toBufferGeometry(mesh: PrintableMesh): THREE.BufferGeometry;    // positions and indices, normals computed; mm
```

The caller (the card, later `export`) passes `featureSet.parts.get(key)` and, in `skip`, the ids of features whose joint has an error (R46). `printablePart` never throws for a part that passed `validateModel`; a feature whose numbers are not finite and positive is skipped as `invalid`.

### 7.3 Primitives in Manifold (millimetres)

Every primitive is built as a unit solid with the same proportions as `createPartGeometry`, centred, and scaled to `dimensions × 1000`, so the printable solid and the display mesh coincide:

| Primitive | Manifold construction (before scaling) |
|---|---|
| box | `cube([1, 1, 1], true)` |
| cylinder | `cylinder(1, 0.5, 0.5, n, true)` rotated −90° about X (axis Z → Y) |
| cone | `cylinder(1, 0.5, 0, n, true)` rotated −90° about X (apex at +Y, as `ConeGeometry`) |
| sphere | `sphere(0.5, n)` |
| tube | cylinder minus `cylinder(1.02, 0.5 · tubeRatio, …)`, rotated like the cylinder |
| torus | `CrossSection.circle(0.125, n).translate([0.375, 0]).revolve(n)` (hole axis Z, as `TorusGeometry`); scale Z by `dims.z / 0.25` |

Circular segment counts follow the size: `n = clamp(ceil(2π r / 0.5 mm), 32, 128)` for the body and `clamp(ceil(2π r / 0.3 mm), 24, 64)` for holes.

### 7.4 Applying features

Bosses first, as a union: a cylinder of the boss Ø and height, starting at `centre` and growing along `axis`. Then every hole as one batch subtraction: a cylinder of `diameter` and `depth + 2 · OVERSHOOT_MM` (0.05 mm, a module constant), starting `OVERSHOOT_MM` outside the face so no coplanar faces remain; `through` holes run to the far side plus the overshoot. Each cylinder is built along +Z and placed with `transform` using the matrix that maps +Z to `axis` and the origin to `centre × 1000`. Every `Manifold` and `CrossSection` is `delete()`d in a `finally` (R78).

### 7.5 Tests (R45)

`tests/unit/printable.test.ts`, in Node:

- every primitive without features: the mesh is closed (Manifold status `NoError`, every edge used by two triangles), and the volume matches the analytic volume within 1 % (box, cylinder, tube, cone) or 2 % (sphere, torus);
- a 30 × 20 × 10 mm box with one M3 insert joint (insert side): volume = box − insert hole − tail hole within 1 %; a ray cast down the axis finds the hole wall at the printed radius;
- a 3 mm plate with an M3 insert: a boss is added and the volume grows by the boss minus the hole;
- `skip` leaves a feature out and lists it.

## 8. Browser (T4)

### 8.1 App state and derived data

```ts
const [printer, setPrinter] = useState(() => loadPrinterProfile(window.localStorage));
const [showJoints, setShowJoints] = useState(true);
const [openJointId, setOpenJointId] = useState<string | null>(null);
const [mouseJoin, setMouseJoin] = useState<MouseJoinState>({ step: 'off' });
const [printPreview, setPrintPreview] = useState<PrintPreviewState | null>(null);
const kit = useMemo(() => { const features = jointFeatures(workspace, printer);
  return { features, findings: checkJoints(workspace, printer, features) }; }, [workspace.objects, workspace.joints, printer]);
```

The memo recomputes only when objects, joints or the profile change (R76). `savePrinterProfile` writes on every committed field. An open card whose joint no longer exists closes; a print preview closes on any workspace change (R49).

**Commits.** Joint changes use one helper like `commitObjectChange` (one `commit`, a notice, errors shown in the 接合 panel). Notices:

| Change | Notice |
|---|---|
| join | 已接合「{a}」與「{b}」，請確認固定方式。 |
| method or needs changed | 已更新接合方式，可按「復原」回到上一步。 |
| confirmed | 已確認固定方式。 |
| removed | 已刪除接合，可按「復原」回到上一步。 |
| re-aligned | 已重新對齊接合面，可按「復原」回到上一步。 |
| material | 已設定材料，可按「復原」回到上一步。 |
| assembly move (R87) | 已調整物件位置（連同接合的 {n} 個物件），可按「復原」回到上一步。 |
| cascade (R6) | the existing notice + 已一併移除 {n} 個接合。 (`jointsRemovedBy`) |

`moveObject` picks the assembly notice when `assemblyOf(before, id).length > 1`. The cascade suffix is added in `adjust`, `applyEdit`, `deleteObject` and (T5) `applyAgentWorkspace`.

### 8.2 Scene

New props on `SceneViewport`:

```ts
joints?: readonly Joint[];                                  // attributes; T6 uses it for assemblies
marks?: readonly PartMarks[];                               // per part: features, region outline, state
showJoints?: boolean;
joinPreview?: { transforms: ReadonlyArray<{ objectId: string; transform: ObjectTransform }>;
  glow: readonly PartMarks[]; label: Vector | null; ready: boolean } | null;
printPreview?: { objectId: string; partId: string; geometry: THREE.BufferGeometry /* mm */ } | null;
```

and one handle method for tests, `projectFace(objectId, partId, face)` (client coordinates of a face centre, like `projectPart`).

- **Marks** (`src/scene/joint-marks.ts`): `PartMarks = { objectId, partId, outline: Vector[] /* part-local */, features: JointFeature[], state: 'ok' | 'problem' | 'open' }`. `buildPartMarks` returns a `THREE.Group` named `joint-marks` with a line loop for the outline (dashed for `problem`) and, per feature, a translucent cylinder of the real size (holes slightly darker, bosses lighter) plus a ring at the face. Colour: a violet `#c77dff` for marks, distinct from the edge cyan `#69eaff`, the selection amber `#ffc53d` and the hand colours. The group is added to the part's transform node, so it follows previews, moves and the explode animation (R47); its meshes are not named `:surface`, so picking and `projectPart` ignore them; `raycast` is disabled on them. A mark is rebuilt only when its `markKey` (a JSON of its inputs) changes; the old one is disposed. After `sync` rebuilds an entry, its marks are attached again.
- **Join preview:** while `joinPreview` is set, the listed roots are placed at the given transforms (the stored `entry.transform` is untouched) and the glow marks are drawn in an emphasised style (thicker outline, brighter fill); when `ready`, a small text sprite (a canvas texture) with 可以接合 is drawn at `label`. When it is cleared, roots go back to `entry.transform`. `data-snap` is `ready` or `none` (R50).
- **Print preview:** the part's `:surface` mesh is hidden and a mesh from `geometry` scaled by 0.001 is added to the part node with the part's hologram style; cleared or replaced, it is disposed and the surface shown again. `data-print-preview` is `{objectId}:{partId}` or empty.
- **Attributes:** `data-joint-count`, `data-joints-json` (`JSON.stringify(joints)`), written in `writeAttributes`.

### 8.3 Mouse join (`src/joints/mouse-join.ts`, R52, R53)

```ts
export type MouseJoinState =
  | { step: 'off' }
  | { step: 'first' }
  | { step: 'second'; a: { objectId: string; partId: string } }
  | { step: 'preview'; a: { objectId: string; partId: string }; b: { objectId: string; partId: string }; pairIndex: number; plan: JoinPlan & { ok: true } };
export type MouseJoinEvent = { type: 'start' } | { type: 'pick'; objectId: string | null; partId: string | null }
  | { type: 'next-pair' } | { type: 'cancel' } | { type: 'workspace-changed' };
export function mouseJoinStep(state: MouseJoinState, event: MouseJoinEvent, ws: Workspace): { state: MouseJoinState; notice: string | null };
```

- `start` → `first`; `pick` on a part with no contact face → stays, notice 這個零件沒有平面可以接合。; on a part → `second`.
- In `second`, `pick` on a part → `planJoin(ws, a, b)`; failure → stays in `second` with the plan's message; success → `preview`.
- `next-pair` → `planJoin(…, pairIndex + 1)` wrapping around `plan.pairs.length`.
- `cancel`, `workspace-changed` → `off`.
- App: while `mouseJoin.step !== 'off'`, `onPick` calls `mouseJoinStep` instead of `pick`; the gizmo is off; Esc cancels first. An agent run starting cancels it. In `preview`, `joinPreview` shows `plan.move` for b's assembly (via `moveRigid` on a scratch workspace) and the two faces as glow. 確認接合 commits `joinObjects(before, { moves: plan.move ? [plan.move] : [], joint: newJoint(afterMoves, { id, createdAt, a: plan.a, b: plan.b }, printer) })` and opens the card.
- Status lines in the panel: 點選第一個要接合的零件。 · 點選另一個物件上要接合的零件。 · 可以接合：按「確認接合」完成，或按 Esc 取消。

### 8.4 Panels

- **接合 panel** (`JointPanel.tsx`, shown when there is at least one object): heading 接合 with the count; a 顯示接合 toggle (`aria-pressed`); 新增接合 (disabled with fewer than one object, during agent runs, and during a mouse join, where 確認接合 / 換一組面 / 取消接合 appear instead); the list from `jointRows(ws, findings)` (label, method label, state 待確認 / 已確認 / 有問題 with an icon: ○ / ✓ / ⚠); the open card below the list.
- **Card** (`JointCard.tsx`, view model `jointCardModel(ws, jointId, kit, recommendations)`): the R54 content. Method parameters: screws: 規格 (M2/M3), 數量 (1–4), 螺母側 (the two side names); magnets: 磁鐵尺寸, 數量; pins: 銷徑, 數量, 配合 (兩側壓配 / 一側滑配); glue: 膠種. Derived text from `derivedText(set)`, for example 「M3×8 螺絲 ×2、M3×5.7 熱壓螺母 ×2、螺母孔 Ø4.20 mm、沉孔 Ø6.20 mm」. 列印件預覽 buttons per printed side: 預覽「{part}」列印件; while loading the button shows 正在產生列印件預覽…; a second press closes it (關閉預覽).
- **R55 behaviour** is in the view model's actions: `onNeeds` replaces the method with `recommendJoint(…)[0].method` when `!confirmed`; `onMethod` and `onParam` set `confirmed: true`; `改用建議` appears when confirmed and the top recommendation's method differs.
- **請代理建議** calls `agent.run(text)` with the R57 text. `useAgentRun` exposes the running `instruction`, and `AgentPanel` shows it in its "你的指示" line when the run did not start from its own form.
- **材料 select** in `ObjectPanel` (`aria-label="材料"`), options 未指定 and the eight labels; `onMaterial(id, value)` → `setMaterial`.
- **列印設定** (`PrinterPanel.tsx`): a `<details>` panel with five `NumberField`s in mm (滑配間隙（每側）, 壓配間隙（每側）, 孔徑補償, 深度補償, PETG 額外間隙（每側）), the note of R19, and 恢復預設值.

Accessible names avoid existing selectors (R73): 新增接合, 確認接合, 換一組面, 取消接合, 確認方式, 改用建議, 重新對齊, 請代理建議, 刪除接合, 顯示接合, 恢復預設值, 材料. None contains 刪除零件, 刪除物件, 取消選取, 復原, 重做 or the agent panel's 取消.

### 8.5 Tests

- `tests/unit/joint-ui.test.ts`: `mouseJoinStep` for every transition (no face, failed plan, next pair wrap, cancel, workspace change); `jointCardModel` (rows, derived text, R55 actions on confirmed and unconfirmed joints); `loadPrinterProfile` with a fake `Storage` (missing, invalid JSON, out of range → defaults; valid → kept); `buildPartMarks` in Node (one child per feature, dashed outline for problems, `markKey` stable).
- `tests/e2e/joints.spec.ts`: two demo objects (the second is placed beside the first, so A's 側邊電池 `+x` face faces B's 外殼 `-x` face); 新增接合 → click A's battery, click B's housing (`projectPart`) → `data-snap="ready"`; 確認接合 → `data-joint-count` 1, `data-joints-json` names `battery` `+x` and `housing` `-x`, B's position changed in `data-object-json`, the card shows 待確認 and a method; 負重 輕 + 拆裝 經常 → 磁鐵; select 熱壓螺母＋螺絲 → 已確認; one 復原 restores the method; 復原 again removes the joint and moves B back; redo; moving A by 物件位置 X moves B by the same offset; the 材料 select sets PLA (and one 復原 clears it); 列印設定 value kept after a reload; 列印件預覽 sets `data-print-preview` and closing clears it; with no joints, the workbench passes the existing specs unchanged (the full suite).

## 9. Agent (T5)

- **Contract (`shared/agent.ts`).** `AgentRequestSchema.printer: PrinterProfileSchema.optional()`; `validateAgentRequest` fills `DEFAULT_PRINTER_PROFILE`. `ObjectSummarySchema.material`. `GetProjectStateDetailSchema.joints: z.array(JointSummarySchema).max(32)` with `JointSummary = { id, a: { objectId, objectName, partId, partName, face }, b: same, method, needs, confirmed, findings: string[] /* codes */ }`. `JointToolDetailSchema = { jointId, joint: JointSchema, recommendation: z.array({ method, ok, reasons }).max(4), findings: z.array({ severity, code, message }).max(20), derived: z.string().max(300) }`.
- **Working state.** `AgentWorkingState.printer`, set from the request in `runAgent`.
- **Tools** (`server/tools/`, all `side: 'server'`, `scope: 'project'`, `effects: 'writes-scene'`, `category: 'assembly'`):

  | Tool | Label | Arguments | State change |
  |---|---|---|---|
  | `create_joint` | 建立接合 | `{ a: Side, b: Side }`, `Side = { objectId, partId?, face? }` (nullable optionals) | `object: { op: 'transform', objectId: b, transform }` when b moves, `joint: { op: 'add', joint }`, `activeObjectId: null` |
  | `update_joint` | 設定接合 | `{ jointId, load?, disassembly?, method?, confirmed? }` | `joint: { op: 'update', joint }` |
  | `remove_joint` | 移除接合 | `{ jointId }` | `joint: { op: 'remove', jointId }` |
  | `set_material` | 設定材料 | `{ objectId, material: MaterialId \| null }` | `activeObjectId: switchTo(…)`, `object: { op: 'material', … }` |

  `create_joint` calls `planJoin` and `newJoint` (ids from `ctx.newObjectId()`, time from `ctx.now()`), dry-runs with `checkedChange`, and returns the detail with `recommendJoint` and `checkJoints` on the workspace after the change. Errors: `UNKNOWN_OBJECT`, `UNKNOWN_PART` (工作區的「{object}」沒有 id 為「{part}」的零件。), `NO_CONTACT_FACE`, `CANNOT_ALIGN`, `NOT_TOUCHING`, `JOINT_LIMIT`, `UNKNOWN_JOINT`. `update_joint` with no field set returns `INVALID_ARGS` (請至少提供一個要修改的欄位。). An `update_joint` that changes the needs of an unconfirmed joint without a `method` also replaces the method with the new top recommendation, as the card does (R55).
- **`set_transform`** keeps its arguments; its description adds "moves the whole assembly of jointed objects"; its summary adds （連同接合的 {n} 個物件） when the assembly has more than one object.
- **Snapshot (`workspaceSnapshot`).** Each object line gains `，材料 {label | 未指定}`. A joints block follows the objects: `接合 {n} 個：` and per joint `- {id}：「{A}」{part}（{face}）↔「{B}」{part}（{face}），{method label}，{已確認 | 待確認}，負重 {…}，拆裝 {…}{，問題：{codes}}`. A workspace with no joints adds nothing, so existing snapshot tests keep passing.
- **`AGENT_INSTRUCTIONS`** gains these rule lines:
  - "Joints connect two objects (or two parts of one object) on flat faces. The only fixing methods are screw-insert (heat-set inserts with M2 or M3 screws), magnet, pin and glue. Snap-fits and moving joints (hinges, sliders) are not supported yet; PLA is too brittle for snap-fits. Never suggest welding for printed parts."
  - "Before recommending a method, ask the user about the load (light, medium, heavy) and how often the parts are taken apart (never, sometimes, often) unless they are known; then call update_joint with load and disassembly and explain the recommendation using the reasons the tool returns. Do not invent dimensions or strengths."
  - "Pass confirmed: true only when the user chose or accepted the method in this conversation."
  - "Metal and plastic parts are fastened mechanically (screws or pins), not glued alone. Hole sizes come from the user's printer profile, which you cannot change."
  - "set_transform on a jointed object moves its whole assembly. An object leaves its assembly only when its joint is removed (remove_joint, only when the user asks)."
- **Client.** `buildAgentRequest` adds `printer`; `RunSnapshot.printer`. `applyStateEvent` sets `recordUndo` when `object !== null || (joint ?? null) !== null`. `applyAgentWorkspace` notices: 代理已建立接合，可按「復原」回到上一步。 (and opens the card), 代理已更新接合。, 代理已刪除接合。, 代理已設定材料。; the cascade suffix.
- **Tests** (`tests/unit/agent-joint-tools.test.ts`): each tool's success and error paths; `create_joint` with and without faces, aligning b and its assembly, inside one assembly (`NOT_TOUCHING`); `update_joint` needs on an unconfirmed joint; the state changes apply identically through `applyWorkspaceChange` on server and client; old payloads without `joint` still parse; `tool-registry.test.ts` lists the four tools with labels and effects (an extension, R73); `agent-loop.test.ts`: `AGENT_INSTRUCTIONS` names the tools; a request without `printer` uses the defaults. E2E (`joints.spec.ts`): a routed `/api/agent` stream with a `state` frame carrying a transform and a joint `add` creates the joint and opens the card; the request body carries `printer`; one 復原 undoes it.

## 10. Two hands (T6)

Built on `hand-manipulation` Task 7 (fists, holds, the explode row). Names below are from its design (§5.4 join rule, §5.5 controller, §7.4 hold sessions).

### 10.1 The join row and its context (R59)

```ts
// src/hands/join.ts
export type TwoHandGesture = 'zoom' | 'rotate' | 'explode' | 'assemble';
export interface JoinContext { ownerObjectId: string | null; sameAssembly(a: string, b: string): boolean }
export type JoinRule = (owner: OwnerGesture, joiner: JoinInput, gate: Gate, context?: JoinContext) => TwoHandGesture | null;
// row: owner 'hold', joiner.kind 'fist', joiner.target.kind 'part', gate.level 'full',
//      target.objectId !== context.ownerObjectId && !context.sameAssembly(ownerObjectId, target.objectId) → 'assemble'
```

The optional fourth argument keeps the existing rows and tests unchanged. The controller passes the held object's id and a `sameAssembly` from the port. `GestureKind` gains `assemble`.

### 10.2 Holds move assemblies (R60, R87)

`beginObjectHold(objectId, hit)` collects the roots of `assemblyOf({ objects, joints }, objectId)` (the scene has both from its props) and `createHoldSession` takes `roots: Array<{ root: Object3D; start: Vector3 }>`: `preview(offset)` computes the held root's new position with `dragPosition` (unchanged) and moves every root by the same world delta; `cancel` restores all; `commit` still calls `onObjectMove(objectId, position)` once, and `setTransform` moves the rest of the assembly in the workspace (§3.4), matching the preview exactly because both apply the same offset. `grabStillValid` is unchanged.

### 10.3 The assemble session (R58, R60–R62)

```ts
export interface AssembleSession {
  preview(ownerOffset: Point, joinerOffset: Point, now: number): { ready: boolean; metrics: PairMetrics | null };
  commit(allowJoin: boolean): void;
  cancel(): void;
}
// HandPort gains:
beginAssemble?(owner: HoldSession, objectId: string, hit: Vector): AssembleSession | null;
sameAssembly?(a: string, b: string): boolean;
```

`SceneViewport.beginAssemble` creates a second hold for b's assembly (holds do not refuse each other, HM design §7.4) and keeps a `SnapState`. Each `preview`: both holds preview their offsets; the previewed transforms of A and B go into `snapCandidates` and `measurePair` (§4.3), then `snapStep` (§4.5); when ready, b's roots are placed at `alignTransform` (moved as a group) instead of the hand position, and the glow and label are drawn as in §8.2. `commit(true)` with a ready snap calls `onAssemble({ kind: 'join', aId, aPosition, bId, bTransform, a, b })`; otherwise `onAssemble({ kind: 'moves', aId, aPosition, bId, bPosition })` (positions only when moved). App turns a `join` into `joinObjects` with `newJoint` and a `moves` result into two `setTransform`s in one `commit`, or nothing when neither moved (R61).

### 10.4 Controller flow

On `fist-engage` while another hand owns a `hold` session without a joiner: `pick(palm)`, then `join(…, context)`; `assemble` → `port.beginAssemble(owner.scene, target.objectId, target.hit)`; `null` → inert. While assembling, the owner's hold does **not** freeze (the exception to HM R84): each frame passes `owner palm − owner ref` and `joiner palm − joiner ref` to `preview`. Either fist's release → `commit(true)`; the other fist is inert until it opens. Either hand lost longer than `TRACKING_LOSS_MS`: `ON_TRACKING_LOSS === 'cancel'` → `cancel()`, else `commit(false)` (R62). A gate change away from `full` cancels. The overlay frame has `gesture: 'assemble'`, the joiner state `hold`, its badge 手勢：握住 {object name} or, when ready, 手勢：可以接合 (R63); the link line is not drawn while ready, because the label replaces it.

### 10.5 Debug and stats (R63)

`HandStats` gains `assembles` and `joins`; the debug line adds 接合：間隙 {gap} mm · 角度 {angle}° · 重疊 {area} mm² · 偵測 {ms} ms · 接合 {joins}.

### 10.6 Tests

- `tests/unit/hand-assemble.test.ts`: the join row (another object → `assemble`; the same object, the same assembly, empty space, a pinch, gates `view-only` and `off` → `null`; without context → `null`); the controller with a fake port: assemble starts on the second fist, both offsets reach `preview` each frame, the owner does not freeze, release of either hand commits with `allowJoin`, loss follows `ON_TRACKING_LOSS`, `beginAssemble` returning `null` makes the fist inert; `createHoldSession` over two roots moves both and restores both; `createAssembleSession` on a small Three.js scene of two boxes: moving b toward a reaches `ready` after `SNAP_SETTLE_MS` and b snaps to the aligned pose.
- `tests/e2e/assembly-hands.spec.ts` with `installFakeHands` and two fists (`FakeHand.fist`): two demo objects; fist on A, fist on B, move B's fist toward A until `data-snap="ready"` and the joiner badge state; release → one joint in `data-joints-json`, the card open; one 復原 removes it and puts both objects back; a fist on an object of A's assembly stays inert (`data-hand2-state="locked"`); after the join, a fist move of A moves B too (`data-object-json`).

## 11. Testing strategy

- Pure modules (`shared/*`, `src/joints/mouse-join.ts`, `card-model.ts`, `printer-store.ts`) are tested in Node with small hand-built workspaces: two boxes side by side, a rotated pair, a box on a cylinder cap, a demo pair. A shared fixture `tests/fixtures/joint-workspace.ts` (T1) builds them so later tasks reuse the same cases.
- `printablePart` is tested in Node with the real WASM (§7.5); it is the only test that loads it.
- Three.js wiring (`joint-marks.ts`, hold and assemble sessions) is tested in Node on plain object trees, as `hand-sessions.test.ts` does.
- E2E covers each user path once (§8.5, §9, §10.6). Tests never call a real model; `/api/agent` is routed; the fake tracking worker drives the hands.

## 12. Task plan and requirement map

Six tasks (R83). Tasks 1–3 are pure and give `export` everything it calls (R67–R71); Tasks 4–6 add the paths for the user and the agent. Task 6 waits for `hand-manipulation` Task 7.

| Task | Content | Requirements |
|---|---|---|
| 1 | Data: materials, standard parts, printer profile schema and printed sizes, joint schema and face table, workspace v2 with migration, invariants, operations, cascades, assemblies and rigid moves, change schemas, undo snapshot, joint fixtures | 1–9, 11, 14–18, 21, 65 (schemas), 70, 73, 75, 84–86 |
| 2 | Geometry: world faces, contact regions, touching, facing pairs, snap candidates, alignment, hysteresis, `planJoin`, `realignJoint`, feature layout and features per method, collisions | 5 (`realignJoint`), 12, 13, 22–38, 76 (snap budget), 88 (detection) |
| 3 | Rules and kit: findings, recommendations, `newJoint`, BOM, assembly notes; CSG spike, manifold-3d, `printablePart` | 18 (resin info), 39–46, 67–69, 71, 77, 78 (WASM), 82 (credit) |
| 4 | Browser: marks, join and print previews, attributes, mouse join, 接合 panel and card, 材料 select, 列印設定, notices, README section, e2e | 6 (notice), 7 (UI), 10, 19, 47–57, 72, 76 (memo), 78 (drawings), 79, 82, 87 (panel and mouse), 88 (realign UI) |
| 5 | Agent: request `printer`, four tools, `set_transform` text, `get_project_state`, snapshot, instructions, client apply and notices, e2e case | 20, 64–66, 79 (agent case), 85 (agent text) |
| 6 | Two hands: join row with context, holds over assemblies, assemble session, controller flow, cue and badges, debug, e2e, manual list | 58–63, 79 (fist case), 83 (manual list), 87 (holds) |

Requirements 74, 80 and 81 apply to every task; 83 is satisfied by `tasks.md` itself.

## 13. Key decisions

- **Derive, don't store.** Only choices live in a joint; sizes come from the profile, the table and the geometry, so tolerance tuning after a test print updates every hole at once (R3, R19).
- **Assemblies move inside `setTransform`.** Changing the one operation that every move path already uses gives the panel, the fist, the agent and `state` events group moves with no new change type, keeps the agent's "one object change per call" rule, and makes the browser and the server agree by construction (R85). Pure translations keep the other objects' rotations by reference, so the common case adds no rounding at all.
- **Parts, not faces, are clicked.** The facing faces of two objects point at each other, so one of them always faces away from the camera; ranking facing pairs between two clicked parts avoids that, and the agent uses the same rule (R23, R52).
- **Hysteresis on the pair, measured without limits once held.** The cue appears after 150 ms on the same pair and stays until the held pair drifts past the release limits, so small hand tremor never flickers it (R25).
- **manifold-3d 3.2.1, lazy, millimetres.** Guaranteed manifold output for slicers, the same code in Node tests and the browser, no dependency tree, and nothing on the first page load (R43, R44).
- **Markers always, CSG on demand.** Markers are children of part nodes and cost nothing during gestures; CSG runs once per preview or export (R47–R49).

## 14. Risks

- **Task 4 size.** It wires the scene, the panel, the card, the profile and the mouse join into `App.tsx`. The pure parts (`mouse-join.ts`, `card-model.ts`, `printer-store.ts`, `joint-marks.ts`) are listed first so the session can test them before the wiring. If the session runs long, the print preview button is the first thing to leave for later (cut order).
- **Concurrent edits of `App.tsx` and `src/hands/`.** `hand-manipulation` Tasks 3–9 change the same files during phase C. Each task here starts from a clean, committed tree and stops if it finds uncommitted changes it did not make.
- **WASM loading.** Vite and Vitest handling of `manifold-3d` is the largest technical unknown; the spike comes first in Task 3, and Tasks 1–2 do not depend on it.
- **Geometry bugs show only in print.** Unit tests check positions in part frames and volumes, but a wrong axis would look right on screen and fail on the printer. The manual list asks for one real print of an M3 joint and the defaults.
- **Snap thresholds and laptop speed.** `SNAP_DISTANCE_MM` and the settle time are guesses until the user tries the two-fist join; the debug line shows the numbers.
- **Rounding drift over many rotations** (R88). Bounded by the drift test; 重新對齊 is the recovery.
- **Task 6 timing.** It needs `hand-manipulation` Task 7, which may land late in phase C. The mouse join and the agent give the same result without it.

## 15. Changes to other specs' code

| File (spec, task) | Change | Task |
|---|---|---|
| `shared/workspace.ts` (`workspace-v2`) | version 2, migration, joints, material, `setTransform` moves assemblies, cascades, new ops and change kinds; `ObjectIdSchema` moves to `shared/ids.ts` and is re-exported | 1 |
| `src/workspace/store.ts` (`workspace-v2`) | `Snapshot` gains `joints` | 1 |
| unit-test fixtures typed as `Workspace` or `SceneObject` | `joints: []`, `material: null` | 1 |
| `src/workspace/ObjectPanel.tsx` (`workspace-v2`) | 材料 select | 4 |
| `src/scene/SceneViewport.tsx` (`workspace-v2`, `hand-manipulation` T5, T7) | marks, previews, attributes, `projectFace`; `beginObjectHold` over the assembly, `beginAssemble` | 4, 6 |
| `src/agent/useAgentRun.ts`, `AgentPanel.tsx` (`agent-harness`) | `instruction` exposed and shown | 4 |
| `shared/agent.ts`, `src/agent/request.ts`, `apply-state.ts`, `server/agent.ts`, `server/agent-tools.ts`, `server/tools/*` (`agent-harness`, `workspace-v2`) | §9 | 5 |
| `src/hands/join.ts`, `controller.ts`, `types.ts`, `text.ts`, `stats.ts`, `src/scene/hand-sessions.ts` (`hand-manipulation` T4–T7) | §10 | 6 |
