# Design fidelity — Design

This design satisfies `requirements.md` and assumes the recommended option of every open decision there. It follows the patterns of `workspace-v2`, `assembly-joints` (AJ) and `export`: pure modules unit-tested in Node, thin React and Three.js wiring covered by Playwright, one place for every rule. Requirement numbers (R…) refer to `requirements.md`; task numbers (T1–T6) to `tasks.md`; "D n" is decision n.

## 1. Approach

```
shell        shared/model.ts enum, shared/hollow.ts (wall, void, volume, inner surface, containment),
             display mesh, contact faces, thickness, printable solid, export COMPONENT_SEALED, demo   (T1)
rules        server/provider.ts rule blocks, FIDELITY_RULES, concept/detailed mode end to end,
             REFERENCE_PARTS in shared/standard-parts.ts, baseline freeze                            (T2)
checks       shared/fit-checks.ts (fit findings, size, staleness, metrics), tool details,
             src/fidelity UI: size readout, badge, fit notices, stale note                           (T3)
research     spike (user's go-ahead) → shared/research.ts, researchTask, adapter web path,
             research_reference tool, consent switch, briefs into designs, sources in the UI         (T4)
cutaway      pure plane maths, clipping in SceneViewport, pick filter, toggle                        (T5)
evaluation   six prompts, verify-real-provider switches, summary, replay screenshots, runs (go-ahead) (T6)
```

Five ideas carry the design:

1. **The shell is a box with a box-shaped void.** Everything that treats a shell from the outside (contact faces, picking, explode, part boxes, the size readout) treats it as a box. Only three places look inside: thickness (`partThickness` returns the wall), solids (`primitiveSolid` subtracts the void, `createPartGeometry` adds inward faces) and containment (`containedInVoid` in `shared/hollow.ts`, used by the fit checks and the export). `PartSchema` keeps its fields; the wall is read from `tubeRatio`.
2. **Rules are data, composed once.** Instruction text is built from named blocks in `server/provider.ts`; generation, edits and the agent import the blocks they need instead of filtering lines with a regular expression. The reference table is data in `shared/standard-parts.ts`, and its instruction lines are generated from it.
3. **Numbers come from geometry.** The size readout, the fit findings and the evaluation metrics are pure functions of the `ModelSpec`. The model's text is shown as text, with a note when manual edits may have made it stale.
4. **The web stays outside the design loop.** Only one task kind (`research`) may set `web: true`; only adapters that passed the spike honour it; only a validated brief (facts and links, short fields) comes back; only its facts (no links, no titles) enter a design or edit input.
5. **UI as mountable pieces.** Every new control is a small component in `src/fidelity/` with plain props. Today they are mounted in the existing panels; `workbench-ui` moves them into its slots without changing them.

## 2. Module layout

```
shared/model.ts                 T1  PartSchema.primitive + 'shell'
shared/hollow.ts                T1  NEW: shellWall, innerBox, partVolume, innerSurface, containedInVoid, VOID_TOLERANCE_M
shared/agent.ts                 T1  PartSummarySchema uses PartSchema.shape.primitive
                                T2  AgentRequestSchema.detail; GenerateDesign args doc only (args live in the tool)
                                T3  GenerateDesignDetailSchema / EditDesignDetailSchema: sizeMm?, fit?
                                T4  AgentRequestSchema.research?, references?
shared/joint.ts                 T1  CONTACT_FACES.shell (as box)
shared/features.ts              T1  partThickness: shell branch
shared/demo.ts                  T1  housing → shell (2 mm wall), battery x 0.0975, one assumption line
shared/fidelity-text.ts         T2  NEW (T2 creates, T3–T5 add): every new zh-TW string of this spec
shared/standard-parts.ts        T2  ReferencePart, REFERENCE_PARTS, referenceLines
shared/fit-checks.ts            T3  NEW: FIT_TOLERANCE_MM, FIT_GAP_MM, FitFinding, fitChecks, overallSizeMm, formatSizeMm,
                                    assumptionsStale;  T6 fidelityMetrics, DETAILED_PART_CAP re-export
shared/research.ts              T4  NEW: ResearchBriefSchema, validateBrief, researchJsonSchema, briefFacts, ReferenceEntry
src/scene/geometry.ts           T1  createPartGeometry: 'shell'
src/print/printable.ts          T1  primitiveSolid: 'shell'
src/export/findings.ts          T1  COMPONENT_SEALED (severity, message)
src/export/pieces.ts            T1  COMPONENT_SEALED detection next to COMPONENT_BLOCKED
server/provider.ts              T1  primitive line + tubeRatio sentence (shell)
                                T2  PRIMITIVE_RULES, PART_RULES, FIDELITY_RULES, LANGUAGE_RULE, DECISION_RULES, DETAILED_PART_CAP,
                                    DesignOptions, designTask(prompt, options), editTask(..., options), GENERATOR_VERSION 1.1.0
                                T4  ModelTask.kind 'research', ModelTask.web, ModelProvider.research, RESEARCH_INSTRUCTIONS, researchTask
server/agent.ts                 T2  imports the rule blocks; detail in state; agent lines (ask once, modes)
                                T3  agent lines (quote sizes, offer fixes);  T4 research lines, references in state
server/agent-tools.ts           T2  AgentWorkingState.detail;  T4 references, researchCalls, research
server/tools/generate-design.ts T2  arg detail;  T3 sizeMm + fit in detail and summary;  T4 arg referenceId
server/tools/edit-design.ts     T2  mode from state;  T3 sizeMm + fit;  T4 arg referenceId
server/tools/research-reference.ts T4 NEW;  server/tools/index.ts T4 register;  server/tools/registry.ts T4 'uses-network'
server/claude.ts, codex.ts, app-server.ts  T4  web path for research tasks only (per spike result)
server/app.ts                   T2  /api/generate, /api/edit: optional detail;  T4 INVALID_REFERENCES → 400
src/fidelity/settings.ts        T2  NEW: loadDetailMode/saveDetailMode;  T4 loadResearch/saveResearch
src/fidelity/DetailModeSwitch.tsx T2 NEW
src/fidelity/SizeReadout.tsx, ConceptBadge.tsx, FitNotices.tsx, StaleNote.tsx  T3 NEW
src/fidelity/baselines.ts       T3  NEW: pure helpers for the per-object provider baseline map
src/fidelity/ResearchSwitch.tsx, ReferenceSources.tsx  T4 NEW
src/fidelity/cutaway.ts         T5  NEW: cutAxis, cutPlane, inRemovedHalf (pure)
src/fidelity/CutawayToggle.tsx  T5  NEW
src/scene/SceneViewport.tsx     T5  prop cutaway; clipping; hitsAt filter; data-cutaway
src/agent/request.ts, useAgentRun.ts   T2 detail;  T4 research, references, sources
src/agent/AgentPanel.tsx        T4  sources of a research_reference result (ReferenceSources)
src/App.tsx                     T2  mode state + switch;  T3 readout, badge, notices, stale baselines;  T4 research switch, sources map;
                                T5  cutaway state + toggle
src/styles.css                  T2–T5  .fidelity-* styles
scripts/fidelity-baseline.ts    T2  NEW: BASELINE_MODEL_INSTRUCTIONS (frozen copy)
scripts/fidelity.ts             T6  NEW: fidelitySummary, scoreTemplate (pure, imported by the runner and tests)
scripts/verify-real-provider.ts T6  VERIFY_SET, VERIFY_RULES, VERIFY_DETAIL
README.md                       T1 (shell line), T2 (modes), T3 (numbers), T4 (references, privacy), T5 (cutaway), T6 (evaluation)

tests/unit/hollow.test.ts T1   fidelity-rules.test.ts T2   reference-parts.test.ts T2   fit-checks.test.ts T3
tests/unit/research.test.ts T4   cutaway.test.ts T5   fidelity-eval.test.ts T6
tests/fixtures/joint-workspace.ts  T1  solidDemoModel (frozen solid copy)
tests/fixtures/fidelity-models.ts  T3  NEW: shell enclosure with internals, floating part, board in solid box, 64-part model
tests/e2e/fidelity.spec.ts      T2 creates (mode switch); T3, T4, T5 add cases
tests/e2e/fidelity-prompts.ts   T6  NEW (six prompts)
tests/e2e/fidelity-replay.spec.ts T6 NEW (opt-in, REVIEW_FIDELITY=1)
```

Dependency direction: `shared/model.ts` ← `shared/hollow.ts` ← `shared/features.ts`, `shared/fit-checks.ts`, `src/print/printable.ts`, `src/export/pieces.ts`; `shared/standard-parts.ts` ← `server/provider.ts`; `shared/research.ts` ← `shared/agent.ts`, `server/tools/research-reference.ts`; `shared/fidelity-text.ts` ← everything that shows a new string. `shared/` imports nothing from `src/` or `server/`.

## 3. The shell (T1; R1–R13)

### 3.1 Geometry (`shared/hollow.ts`)

```ts
export const VOID_TOLERANCE_M = 0.0001;               // 0.1 mm, the same as FIT_TOLERANCE_MM
export function shellWall(part: Part): number;         // (1 - tubeRatio) * min(x, y, z) / 2; throws if not a shell
export function innerBox(part: Part): { x: number; y: number; z: number } | null;   // half extents of the void
export function partVolume(part: Part): number;        // m³, analytic
export type InnerSurface =
  | { kind: 'box'; half: { x: number; y: number; z: number }; wall: number }
  | { kind: 'cylinder'; radius: { x: number; z: number }; halfLength: number; wall: number };
export function innerSurface(part: Part): InnerSurface | null;   // shell, tube; null otherwise
/** True when every corner of `partId`'s own box lies inside the void of `shellId`, within tolerance. */
export function containedInVoid(model: ModelSpec, partId: string, shellId: string, toleranceM?: number,
  matrices?: Map<string, THREE.Matrix4>): boolean;
/** Largest distance (m) by which a corner of `partId`'s box lies outside the void of `shellId`; 0 when contained. */
export function voidExcess(model: ModelSpec, partId: string, shellId: string, matrices?: Map<string, THREE.Matrix4>): number;
```

Volumes (`d` = dimensions, `r` = `tubeRatio`, `w` = wall):

| Primitive | Volume | Matches |
|---|---|---|
| box | `x·y·z` | `BoxGeometry`, `Manifold.cube` |
| sphere | `π/6 · x·y·z` | ellipsoid |
| cylinder | `π/4 · x·z · y` | axis Y |
| cone | `π/12 · x·z · y` | axis Y |
| tube | `π/4 · (1 − r²) · x·z · y` | inner diameter = `r` × outer |
| torus | `2π² · 0.375 · 0.125² · x · y · (z / 0.25)` | unit `TorusGeometry(0.375, 0.125)` scaled like `primitiveSolid` |
| shell | `x·y·z − (x − 2w)(y − 2w)(z − 2w)` | outer box minus void |

`containedInVoid` takes the 8 corners of the part's own box (`±dimensions/2` in its frame), maps them to world with `worldMatrices`, then into the shell's frame with the inverse of the shell's world matrix, and compares with `innerBox ± tolerance`. Using the part's own box is conservative for round parts, which is the right side for an advisory check. `voidExcess` returns the largest excess, for the `{n}` of `INTERIOR_OUTSIDE`.

### 3.2 Display mesh (`createPartGeometry`, R4)

```ts
case 'shell': {
  const outer = new THREE.BoxGeometry(1, 1, 1);
  const inner = new THREE.BoxGeometry(ix, iy, iz);   // ix = (x - 2w) / x, …: the void in the unit box
  flipInward(inner);                                  // reverse each triangle's index order, negate normals
  geometry = concatIndexed(outer, inner);             // positions, normals, uvs and indices; inner indices offset by 24
  outer.dispose(); inner.dispose();
  break;
}
```

The existing tail (`computeBoundingBox`, `center`, `scale(dimensions / size)`) then scales the unit outer box to `dimensions` and the inner box to the void exactly, because the outer box defines the bounding box. `concatIndexed` is a small local helper in `geometry.ts` (no `BufferGeometryUtils` import, so no extra module in the main chunk). The mesh is 48 vertices and 24 triangles, uses no DOM, and is closed. With `DoubleSide` and the existing opacities the wall reads as two translucent layers; `EdgesGeometry(geometry, 24)` draws both boxes.

### 3.3 Faces and thickness (R6, R7)

- `shared/joint.ts`: `shell: { '+x': 'rect', '-x': 'rect', '+y': 'rect', '-y': 'rect', '+z': 'rect', '-z': 'rect' }`. The `Record` type makes this a compile error until it is added (AJ design §4.1).
- `shared/contact.ts`: no change. `localFace` derives everything from `dimensions` and `faceShape`; `inner` is `null` for `rect`. A test pins that a shell and a box of the same size give equal faces.
- `shared/features.ts`: `partThickness` starts with `if (part.primitive === 'shell') return shellWall(part);`. The boss rule (`bossHeight = insertDepth + MIN_FLOOR − t`, starting at `offsetMm: tI`) then starts the boss at the inner wall face and grows it into the void, as AJ requirement 33 describes. No other change in `features.ts`.

### 3.4 Printable solid (R8)

```ts
case 'shell': {
  const w = (1 - part.tubeRatio) * Math.min(x, y, z) / 2;
  const outer = own.keep(own.keep(Manifold.cube([1, 1, 1], true)).scale(size));
  const voidSize: [number, number, number] = [(x - 2 * w) * MM, (y - 2 * w) * MM, (z - 2 * w) * MM];
  const hollow = own.keep(own.keep(Manifold.cube([1, 1, 1], true)).scale(voidSize));
  result = own.keep(outer.subtract(hollow));
  break;
}
```

The void never touches the outer faces (`w > 0`), so no coplanar faces arise. `printablePart` then unions bosses and subtracts holes as for any part. Tests use the real WASM like `tests/unit/printable.test.ts`.

### 3.5 Export (R9, R10)

No change is needed for pieces, STL, 3MF or the BOM: `buildPieces` uses `primitiveSolid`, the writers take the mesh, and `meshVolume` sums signed tetrahedra (the void's inward faces subtract, so the total stays positive and `meshProblems` reports nothing).

`COMPONENT_SEALED` sits next to `COMPONENT_BLOCKED` in step 5 of `buildPieces` (`src/export/pieces.ts`, the bought-component loop): for each bought component and each printed shell part of the same object that belongs to a built piece, `containedInVoid(object.model, component.id, shell.id)` → a draft `{ code: 'COMPONENT_SEALED', params: { part, piece } }`. One finding per component (the first shell in model order). `src/export/findings.ts` gains the code (severity `warning`) and the message of R10, and the sort order puts it right after `COMPONENT_BLOCKED`. This is the only change in export files.

### 3.6 Demo and fixtures (R12, D4)

- `shared/demo.ts`: `housing` gets `primitive: 'shell'` and `tubeRatio: 1 - (2 * 0.002) / 0.07`; `battery` position x `0.0975` (its −x face then lies on the housing's +x face at 0.080); the size assumption line becomes R12's text. Ids, names, count and order unchanged.
- `tests/fixtures/joint-workspace.ts`: add `export const solidDemoModel` (a verbatim copy of today's demo: solid box housing, battery at 0.099), and use it in `demoPair` and in every fixture whose tests assert numbers that depend on the solid housing. T1 first runs the unit suite with the new demo, lists each failing test, and switches only those to `solidDemoModel` (in the fixture or the test file's import), so no assertion value is edited. A failure that does not come from the housing's thickness, volume, findings or the battery's position stops the task.
- `tests/e2e/export.spec.ts`: lines 128 and 211–213 expect `COMPONENT_SEALED` instead of `COMPONENT_BLOCKED` (the e2e tests use the real demo through 載入示範模型).

### 3.7 Rule line (R11)

The primitives line becomes `Only the following controlled solid primitives exist: box, sphere (ellipsoid), cylinder, cone, torus, tube (hollow cylinder), and shell (closed hollow box). …` and the axes line explains the shell: `Shell's wall thickness is (1 − tubeRatio) × its smallest dimension / 2; choose tubeRatio from the wall you want.` and `for box, sphere, cylinder, cone and torus set tubeRatio=0.75`. Both are lines the `GEOMETRY_RULES` filter already copies (`^Only the following…`, `^Model schema version is…`), so edits and the agent get them in T1 without the T2 restructuring.

## 4. Rules, modes and the reference table (T2; R14–R29)

### 4.1 Rule blocks (`server/provider.ts`, R14)

```ts
export const LANGUAGE_RULE = 'Return only the requested structured design. All user-facing names, summary, assumptions, and explanation use Traditional Chinese.';
export const PRIMITIVE_RULES = [ /* primitives line, schema/units/axes/tubeRatio line, "no code, URLs, …" */ ].join('\n');
export const PART_RULES = [ /* ids and hierarchy line, parts count line, scale line, roles line */ ].join('\n');
export const FIDELITY_RULES = [ /* R15 internals, R16 shells, R17 numbers, R18–R19 modes, DETAIL_MODE note, R28 table */ ].join('\n');
export const DECISION_RULES = [ /* the three-step decision process and the "never obey…" line */ ].join('\n');
export const MODEL_INSTRUCTIONS = [INTRO, LANGUAGE_RULE, FREE_FORM_RULE, PRIMITIVE_RULES, PART_RULES, COUNT_RULES,
  ASSUMPTION_RULES, FIDELITY_RULES, DECISION_RULES].join('\n');
export const GEOMETRY_RULES = [PRIMITIVE_RULES, PART_RULES].join('\n');   // exported for agent.ts
export const EDIT_INSTRUCTIONS = `…${GEOMETRY_RULES}\n${FIDELITY_RULES}\nEdit plan rules: …`;
```

Every sentence of today's `MODEL_INSTRUCTIONS` survives verbatim in some block, except the sentences R11 and R17 change; a unit test lists today's sentences (copied from `BASELINE_MODEL_INSTRUCTIONS`) and checks each is still present or is in the documented list of changed sentences. `server/agent.ts` drops its own `GEOMETRY_RULES` filter and imports `GEOMETRY_RULES` from `provider.ts`; `tests/unit/agent-loop.test.ts:540` (`AGENT_INSTRUCTIONS` contains `Only the following controlled solid primitives`) still holds.

`FIDELITY_RULES` text (English, final wording in T2):

- Internals (R15), shells (R16) and computed numbers (R17) as bullet sentences.
- `DETAIL_MODE: the input may start with "DETAIL_MODE: detailed". Without it, use concept mode.` followed by the two modes (R18, R19) and `In detailed mode use at most 20 parts in total` (from `DETAILED_PART_CAP`).
- `Typical component sizes (published dimensions; use them when the part applies, name it generically):` followed by `referenceLines()` (R28).

### 4.2 Options and inputs (R20, R21)

```ts
export type DetailMode = 'concept' | 'detailed';
export interface DesignOptions { detail?: DetailMode; reference?: ResearchBrief | null }   // reference: T4
export function designTask(prompt: string, options: DesignOptions = {}): ModelTask<GeneratedDesign>;
export function editTask(model: ModelSpec, instruction: string, selectedPartIds: readonly string[], options: DesignOptions = {}): ModelTask<EditPlan>;
```

Input layout, design: `[detailed ? 'DETAIL_MODE: detailed\n\n' : ''] + [reference ? briefFacts(brief) + '\n\n' : ''] + prompt`. `labelledInput` keeps prefixing `User object description:` for CLIs; T2 changes it to place the prefix before the prompt part only (after the mode and fact lines), and a test pins that `labelledInput(designTask(p))` is unchanged for concept mode without a reference. Edit: the mode line is prepended before `CURRENT_MODEL:`.

### 4.3 Transport (R20, R22, R23)

| Where | Change |
|---|---|
| `shared/agent.ts` | `AgentRequestSchema.detail: z.enum(['concept','detailed']).optional()`; `AgentRequest.detail: DetailMode` (always set by `validateAgentRequest`) |
| `server/agent-tools.ts` | `AgentWorkingState.detail: DetailMode` |
| `server/agent.ts` | `state.detail = req.detail ?? 'concept'`; the snapshot line 「細節程度：概念／詳細」 so the agent knows the setting; the R22 lines |
| `generate_design` | `args: { prompt, detail: DetailModeSchema.nullable() }` (strict object, so `detail` must be present; the description says `null` uses the user's setting); `designTask(prompt, { detail: detail ?? state.detail })` |
| `edit_design` | `editTask(..., { detail: state.detail })` |
| `server/app.ts` | `RequestSchema` and `EditRequestSchema` accept optional `detail`; `/api/generate` uses `provider.run(designTask(prompt, { detail }))` when `provider.run` exists, otherwise `provider.generate` (unchanged for the fake providers in tests that only implement `generate`) |
| `src/agent/request.ts` | `detail` in the request body |
| `src/App.tsx` | `detailMode` state from `loadDetailMode(storage)`; `<DetailModeSwitch>` in the prompt panel; `detail` in the `/api/generate` and `/api/edit` bodies and in the agent options |

`EditRequestSchema` lives in `shared/edit.ts`; the optional field is added there. Making `detail` a required-nullable argument of `generate_design` matches the other tools (`objectId: OptionalObjectIdSchema`). Existing unit tests that call `generate_design` with `{ prompt }` only: T2 checks `tests/unit/agent-tools-model.test.ts` and `agent-loop.test.ts`; if they pass `argsJson` without `detail`, the schema uses `.nullable().default(null)` instead so old calls stay valid (argsShapeText then shows `detail?`). The session picks whichever keeps every existing test green and reports which.

`src/fidelity/settings.ts`: `loadDetailMode(storage: Storage | null): DetailMode`, `saveDetailMode(storage, mode)`, key `forgehand.detailMode`, invalid values read as `concept`; same pattern as `src/joints/printer-store.ts`.

`DetailModeSwitch`: a `role="radiogroup"` with the label 細節程度 and two `role="radio"` buttons (概念, 詳細（含典型內部零件）), the help text, `data-detail-mode` on the group, disabled while an agent run is active.

### 4.4 Reference table (R25–R29)

```ts
export type ReferenceCategory = 'battery' | 'board' | 'fastener' | 'connector' | 'actuator' | 'input' | 'light' | 'audio' | 'module' | 'mechanical' | 'wall';
export interface ReferencePart {
  id: string; label: string; description: string; category: ReferenceCategory;
  primitive: Part['primitive'] | null;              // null for wall entries
  sizeMm: { x: number; y: number; z: number } | null;
  wallMm: { min: number; typical: number; max: number } | null;
  sourceUrl: string; source: string; checked: string;   // https URL, what was read, ISO date
}
export const REFERENCE_PARTS: Record<ReferencePartId, ReferencePart>;
export function referenceLines(): string[];   // one English line per entry, table order
```

`screw-m2` / `screw-m3` build `sizeMm` from `SCREWS` (head diameter, head height, diameter) and copy its source URL, so R29 holds by construction. The ids are a `z.enum` (`ReferencePartIdSchema`) so tests and later specs can refer to them. T2 fills the values per R27 and D12; the candidate list is R26.

### 4.5 Baseline freeze (R24)

First build step of T2, before any instruction edit: create `scripts/fidelity-baseline.ts` with `export const BASELINE_MODEL_INSTRUCTIONS = \`…\`` holding today's `MODEL_INSTRUCTIONS` text after T1 (T1's shell sentences are part of the schema contract the baseline runs against; the baseline must not mention internals, modes or the table). T1's change to the primitive line is therefore in the baseline; the comparison isolates T2's rules. A unit test pins that the baseline contains `shell (closed hollow box)` and does not contain `DETAIL_MODE` or `Typical component sizes`.

## 5. Fit checks and computed numbers (T3; R30–R41)

### 5.1 `shared/fit-checks.ts`

```ts
export const FIT_TOLERANCE_MM = 0.1;
export const FIT_GAP_MM = 0.5;
export type FitCode = 'INTERIOR_OUTSIDE' | 'INTERIOR_NO_SHELL' | 'FLOATING_PART';
export interface FitFinding { code: FitCode; severity: 'warning'; partIds: string[]; params: Record<string, string | number>; message: string }
export function fitChecks(model: ModelSpec): FitFinding[];
export function overallSizeMm(model: ModelSpec): { width: number; depth: number; height: number };
export function formatSizeMm(mm: number): string;
export function assumptionsStale(baseline: ModelSpec, current: ModelSpec): boolean;
export function fidelityMetrics(model: ModelSpec): FidelityMetrics;    // T6
```

Algorithm of `fitChecks` (one pass of `worldMatrices` and `partBoxes`, shared with the helpers):

1. **Shell of an interior part** (R31): walk `parentId` up to the first `shell`; else among all shells take those whose void contains the part's box centre (centre mapped into the shell frame, inside `innerBox`), the smallest void volume first.
2. With a shell: `voidExcess > FIT_TOLERANCE_MM` → `INTERIOR_OUTSIDE` with `n = excess` (mm, 0.1). Without: `INTERIOR_NO_SHELL`.
3. **Groups** (R33): union-find over parts; `attached(a, b)` when the boxes, each expanded by `FIT_GAP_MM / 2`, intersect. Pairs are pruned by sorting boxes on min x (sweep), so 64 parts stay well under the 5 ms budget (R76). The main group has the largest sum of box volumes (ties: the group containing the first part in model order). Every other part → `FLOATING_PART` with `n` = the smallest box-to-box distance to the main group.
4. Sort by code (`INTERIOR_OUTSIDE`, `INTERIOR_NO_SHELL`, `FLOATING_PART`), then model order.

`message` comes from `FIT_MESSAGES` in `shared/fidelity-text.ts`, filled with names as plain strings.

`assumptionsStale` compares the parts by id: a different id set, or for a common id a different `primitive`, `dimensions`, `position`, `rotation`, `parentId` or `tubeRatio`.

### 5.2 Tool details (R35, R36)

```ts
const FitFindingSummarySchema = z.strictObject({ code: z.string().min(1).max(40), partIds: z.array(partId).max(2), message: z.string().min(1).max(300) });
const SizeMmSchema = z.strictObject({ width: z.number().nonnegative(), depth: z.number().nonnegative(), height: z.number().nonnegative() });
// GenerateDesignDetailSchema and EditDesignDetailSchema gain:
sizeMm: SizeMmSchema.optional(), fit: z.array(FitFindingSummarySchema).max(20).optional(),
```

`generate_design` computes both from `design.model` after `validateDesign`; `edit_design` from the applied model. The summary text is built by `fitSummaryText(size, findings)` in `shared/fidelity-text.ts` and truncated at a sentence boundary to keep the whole summary ≤ 1000 characters. The agent sees them in the next round through the compact round history (`rounds` in `server/agent.ts` already carries `summary` and `detail`). The R36 lines go into `AGENT_INSTRUCTIONS`.

### 5.3 Browser (R37–R41)

- `src/fidelity/SizeReadout.tsx` (`model`), `ConceptBadge.tsx`, `FitNotices.tsx` (`findings`), `StaleNote.tsx` (`stale: boolean`). Each memoises on the model object (models are immutable), so recomputation happens only on a model change.
- `src/fidelity/baselines.ts`: pure helpers over `ReadonlyMap<objectId, ModelSpec>`: `recordBaseline(map, objectId, model)`, `dropBaseline(map, objectId)`, `pruneBaselines(map, objectIds)`.
- `src/App.tsx`: a `useRef(new Map())` of baselines. It is recorded where a back end or the demo writes a model: `applyResult` (generate), `applyEdit`, the agent `state` handler for `object.op === 'add' | 'model'` (through the `useAgentRun` options callback that already applies state), and `loadDemo`. Objects removed from the workspace are pruned. `stale = baseline ? assumptionsStale(baseline, active.model) : false`.
- Mounting until `workbench-ui` lands: `SizeReadout` + `ConceptBadge` at the top of the details panel (`details-panel`) and as a compact line in the `stage-footer`; `StaleNote` directly above `<h3>暫定假設</h3>`; `FitNotices` below the assumptions.

## 6. Research sub-agent (T4; R48–R61)

### 6.1 Spike (R49–R51, user's go-ahead)

Step 0 of T4, executed only after the user says go. No research code is written before it. The commands run from an empty temporary directory, with the query and the instructions passed by file or stdin (PowerShell `Get-Content … | claude …`), never in arguments, and the outputs saved under `artifacts/local/research-spike/` (git-ignored). Two attempts per CLI at most.

- **Claude Code CLI.** Today's isolated flags from `server/claude.ts`, with `--tools ''` replaced by `--tools WebSearch,WebFetch` and `--allowedTools WebSearch,WebFetch` added, `--max-budget-usd 0.5`, `--system-prompt` = draft `RESEARCH_INSTRUCTIONS`, `--json-schema` = draft brief schema. **Assumption:** the tool names `WebSearch` and `WebFetch` and the `--allowedTools` flag behave in `-p` mode as in interactive mode; the spike confirms or corrects them and records `claude --version`.
- **Codex CLI, exec transport.** Today's flags from `server/codex.ts` with `-c web_search="live"` instead of `"disabled"`. **Assumption:** `web_search` accepts a value that enables live search in this CLI version; the spike records `codex --version` and the value that works (or that none does).
- **Codex CLI, app-server transport.** `server/app-server.ts` verifies the effective config and rejects `web_search !== 'disabled'`. The spike checks whether a research thread can be started with web search on while every other `SAFE_CONFIG` value holds; if not, research uses the exec transport for Codex even when the server runs app-server.
- **Check** per R50: brief validates, ≥ 2 `https` sources, ≤ 120 s, temp directory empty afterwards, and one design call of the same CLI still works with web disabled (an existing unit-tested path, run once for real). The user opens two links.
- **Record** in §14 "Spike log": date, CLI versions, exact flags, elapsed time, pass or fail per criterion, cost or quota as the CLI reports it, and the user's link check. Then branch per R51.

### 6.2 Brief (`shared/research.ts`, R52)

```ts
export const ResearchSourceSchema = z.strictObject({ id: z.number().int().min(1).max(8), title: z.string().trim().min(1).max(160), url: z.string().min(8).max(400) });
export const ResearchComponentSchema = z.strictObject({
  name: z.string().trim().min(1).max(80), role: z.enum(['interior', 'exterior']),
  typicalSizeMm: z.strictObject({ x: mm, y: mm, z: mm }).nullable(), note: z.string().trim().min(1).max(200).nullable(),
  sources: z.array(z.number().int().min(1).max(8)).min(1).max(4),
});
export const ResearchBriefSchema = z.strictObject({
  status: z.enum(['found', 'not_found']), summary: z.string().trim().min(1).max(300),
  components: z.array(ResearchComponentSchema).max(12), sources: z.array(ResearchSourceSchema).max(8),
});
export function validateBrief(input: unknown): ResearchBrief;          // schema + the R52 semantic checks
export function researchJsonSchema(): Record<string, unknown>;       // draft-7, $schema removed, like designJsonSchema
export function briefFacts(brief: ResearchBrief): string;            // R58 block: names, sizes, notes; no titles, no URLs
export const ReferenceEntrySchema = z.strictObject({ id: z.string().regex(/^ref-[1-9][0-9]{0,2}$/), brief: ResearchBriefSchema });
```

URL check: `new URL(url)`, `protocol === 'https:'`, no `username`/`password`, host not `localhost`, not an IPv4 or bracketed IPv6 literal, and containing a dot.

### 6.3 Task and adapters (R53, R54)

```ts
export interface ModelTask<T> { readonly kind: 'design' | 'edit' | 'agent' | 'research'; …; readonly web?: true }
export interface ModelProvider { …; readonly research?: boolean }
export function researchTask(query: string): ModelTask<ResearchBrief>;   // web: true, RESEARCH_INSTRUCTIONS, researchJsonSchema, validateBrief
```

- `server/claude.ts`: `const tools = task.web ? <spike flags> : ['--tools', '']`; the prompt preamble `Return the structured … directly. Do not use tools.` becomes `Use only web search and web fetch, then return the structured brief.` for research. Everything else identical. `research: true` only if the spike passed for Claude.
- `server/codex.ts`: `web_search` value from the spike for `task.web`, `"disabled"` otherwise; preamble analogous.
- `server/app-server.ts`: per the spike, either a research thread with the recorded config (and the effective-config check adjusted for that thread only) or delegation to the exec runner.
- OpenAI adapter: `research: false`; a research task throws `GenerationError('RESEARCH_UNAVAILABLE', …)`.
- A constant `RESEARCH_SPIKE` in `server/provider.ts` records the outcome (`{ claude: boolean; codex: boolean }`) with a comment pointing to §14; adapters read it.

### 6.4 Tool, state and request (R55–R58, R60)

- `server/tools/registry.ts`: `ToolEffects` gains `'uses-network'`.
- `server/tools/research-reference.ts`: `args: z.strictObject({ query: z.string().trim().min(1).max(300) })`. Order of checks: `state.research` false → `RESEARCH_OFF`; `state.researchCalls >= RESEARCH_MAX_PER_RUN` → `RESEARCH_LIMIT`; `!provider.research` → `RESEARCH_UNAVAILABLE`; then `provider.run(researchTask(query), AbortSignal.any([signal, AbortSignal.timeout(RESEARCH_TIMEOUT_MS)]))`, one retry on `INVALID_MODEL`; a timeout of the research call (not of the run) or any `GenerationError` → `RESEARCH_FAILED` as `ok: false`, so the run continues; a run abort propagates as for every tool. On success the brief is stored as `ref-{n}` in `state.references` and returned.
- Registered last in `server/tools/index.ts` only when `RESEARCH_SPIKE.claude || RESEARCH_SPIKE.codex` (R51).
- `AgentWorkingState` gains `research: boolean`, `researchCalls: number`, `references: Map<string, ResearchBrief>`. `runAgent` fills `references` from `req.references`.
- `shared/agent.ts`: `AgentRequestSchema.research: z.boolean().optional()`, `references: z.array(ReferenceEntrySchema).max(3).optional()`; `validateAgentRequest` runs `validateBrief` on each and throws `AgentRequestError('INVALID_REFERENCES', '參考資料格式無效，請重新查詢。')` on failure (the route maps it to 400 like `INVALID_WORKSPACE`); `ResearchDetailSchema = z.strictObject({ referenceId, brief })`.
- `generate_design` / `edit_design`: `referenceId: z.string().max(8).nullable()`; unknown → `fail(tool, 'UNKNOWN_REFERENCE', …)`; known → `options.reference = brief`. Their details gain `referenceId: string | null` (optional field) so the browser can attach sources to the object.
- `AGENT_INSTRUCTIONS` (only when the tool is registered): use `research_reference` only when the user asks for references or real-product data; pass the returned `referenceId` to `generate_design` or `edit_design`; never put URLs or page text into prompts or designs; if it fails, continue with the built-in typical sizes and say so.

### 6.5 Browser (R56, R57, R59)

- `src/fidelity/settings.ts`: `loadResearch`/`saveResearch`, key `forgehand.research`, default false. `ResearchSwitch`: a checkbox with label and help text.
- `src/agent/useAgentRun.ts`: keeps `references` (last 3 `{ id, brief }` from `research_reference` result events, newest last) for the session and sends them with `research` in each request; offers `onReferenceUsed(objectId, referenceId)` when a `generate_design`/`edit_design` result carries a `referenceId` and an object id.
- `src/fidelity/ReferenceSources.tsx` (`brief`): sources as links with host names, components with sizes. `AgentPanel` renders it for `research_reference` results; the details panel renders it for the active object from a session map `objectId → brief` in `App.tsx`.

### 6.6 Failure branch without research code

If both CLIs fail, T4 builds only: the `uses-network` effect is not added, nothing is registered, `AGENT_INSTRUCTIONS` gains one line (`Web references are not available; use the typical component sizes you know from the design rules.` — the design and edit calls carry the table), README states it, and §14 records the result. `ResearchSwitch` and `ReferenceSources` are not mounted. The rest of T4's requirements are then reported as blocked for the user's decision (R51, D9).

## 7. Cutaway (T5; R42–R47)

`src/fidelity/cutaway.ts` (pure, Three.js math only):

```ts
export type CutAxis = 'x' | 'y' | 'z';
/** The object's local axis most aligned with the view direction (world), given the object's world quaternion. */
export function cutAxis(viewDirection: Vector3Like, objectQuaternion: THREE.Quaternion): { axis: CutAxis; sign: 1 | -1 };
/** World plane through the model box centre: keeps the half away from the camera. */
export function cutPlane(axis: { axis: CutAxis; sign: 1 | -1 }, modelBox: THREE.Box3, objectMatrix: THREE.Matrix4, target?: THREE.Plane): THREE.Plane;
/** True for a world point in the removed half. */
export function inRemovedHalf(plane: THREE.Plane, point: THREE.Vector3): boolean;   // plane.distanceToPoint(point) < 0
```

`SceneViewport.tsx`:

- New prop `cutaway: boolean`. On the rising edge it calls `cutAxis` once (from `viewDirection()` and the active object's root quaternion) and stores the axis in the view state; on the falling edge, on an active-object change or removal it clears it.
- Each frame, while an axis is stored, `cutPlane` updates one preallocated `THREE.Plane` from the active object's current matrix (so dragging the object moves the cut; no allocation per frame).
- `renderer.localClippingEnabled = true` once at start-up (it has no effect on materials without planes). The active object's part materials (`MeshStandardMaterial`, `LineBasicMaterial`) get `clippingPlanes = [plane]`; others `[]`. Rebuilt objects (scene sync) get the planes again when they are the active one.
- `hitsAt` skips hits of the active object with `inRemovedHalf(plane, hit.point)` when the cut is on (R45), so the click handler and `hitTest` (hands) both see only visible parts.
- The canvas gets `data-cutaway` (R47).
- The export's off-screen renderer (`src/export/kit-image.ts`) builds its own meshes and materials and never sets `localClippingEnabled`, so it cannot show the cut (R46); a unit test of `explodedLayout` input and a check that `kit-image.ts` does not import `cutaway.ts` pin that.

`CutawayToggle` sits in the explode toolbar in `App.tsx` with `aria-pressed`, disabled without an active object; `App.tsx` passes `cutaway` to `SceneViewport` and resets it when the active object changes.

## 8. Evaluation (T6; R62–R69)

- `tests/e2e/fidelity-prompts.ts`: `export const fidelityPrompts = [{ id: 'F01', prompt: '一個可以放在桌上的藍牙喇叭', checks: [...] }, …] as const`, with `checks` for the human reviewer (for example 「外殼為中空殼體」「內部零件為同類典型件」「尺寸合理」).
- `scripts/verify-real-provider.ts`: when `VERIFY_SET=fidelity`, the scenarios are `fidelityPrompts`, and instead of `provider.generate(prompt)` it calls `provider.run(task)` with `task = VERIFY_RULES === 'baseline' ? { ...designTask(prompt), instructions: BASELINE_MODEL_INSTRUCTIONS } : designTask(prompt, { detail: VERIFY_DETAIL })`. Each entry adds `rules`, `detail`, `metrics: fidelityMetrics(design.model)` and `fit: fitChecks(design.model)` next to the existing fields. The artifact is `artifacts/fidelity-{date}.json` (same run/append/persist logic as today), and at the end the runner writes `artifacts/fidelity-summary-{date}.md` through `fidelitySummary` and creates `artifacts/fidelity-scores-{date}.json` from `scoreTemplate` if it does not exist. Without `VERIFY_SET` nothing changes. `structuralChecks` is skipped for the fidelity set.
- `scripts/fidelity.ts`: `fidelitySummary(runs, scores?) → string` (Markdown table, one row per prompt, columns per provider × rules: parts, interior, contained, floating, shells, cap exceeded, JSON bytes, latency, score) and `scoreTemplate(runs)`.
- `tests/e2e/fidelity-replay.spec.ts`: opt-in with `REVIEW_FIDELITY=1`, reads the latest `artifacts/fidelity-*.json`, routes `/api/generate` with each captured design like `captured-models.spec.ts`, and saves `assembled`, `exploded` (爆炸圖) and `cutaway` (剖面檢視) screenshots per design and run to `artifacts/local/fidelity/{provider}-{rules}-{id}-{view}.png`. No model calls.
- The 24 runs (and the optional 12) are listed in `tasks.md` T6 as commands the session prepares and the user approves; results go into §15.

## 9. Test strategy

All unit tests run in Node with Vitest (`maxWorkers: 1`, `isolate: false`), use fake providers, and never call a real model. E2E tests use the fake camera and routed `/api/*`, render the real WebGL scene, and run with `PLAYWRIGHT_GPU=1` and the installed headless shell (see `tasks.md` session facts). The full e2e suite takes about 25 minutes on this laptop; each task runs only the specs listed, and the full suite where marked.

| Task | Unit tests | E2E specs to run |
|---|---|---|
| T1 | `hollow.test.ts` (wall, void, `partVolume` for all seven primitives vs `createPartGeometry` mesh volume and `primitiveSolid` volume, `innerSurface` for shell and tube, `containedInVoid` with rotation and tolerance); `model.test.ts` (shell parses, old demo parses); `scene.test.ts` (shell bounds equal dimensions, 24 triangles, closed); `explode.test.ts` (children of a shell move out); `joint-data.test.ts` (shell face row); `joint-contact.test.ts` (shell faces = box faces); `joint-features.test.ts` (shell thickness is the wall; an M3 insert on a 2 mm wall gets a boss that grows into the void); `printable.test.ts` (shell manifold, volume = `partVolume` ±0.1 %, with an insert boss and a through hole); `export-pieces.test.ts` (shell with a bought part inside: no `COMPONENT_BLOCKED`, `COMPONENT_SEALED`, `meshProblems` `[]`, STL triangle count = both surfaces, BOM volume = wall volume); `export-docs.test.ts` (the new message); `agent-tools-workspace.test.ts`-style check that `get_project_state` returns a shell part | **Full suite** (the demo changes under every spec); at least `export.spec.ts`, `joints.spec.ts`, `explode.spec.ts`, `workbench.spec.ts`, `edit-select.spec.ts`, `assembly-hands.spec.ts`, `hand-control.spec.ts` must pass |
| T2 | `fidelity-rules.test.ts` (each block's lines in each instruction; baseline sentences preserved; `labelledInput` unchanged for concept; `DETAIL_MODE` line for detailed; `editTask` mode line; request default `concept`; `generate_design` `detail` override; `/api/generate` and `/api/edit` with and without `detail` via supertest; settings load/save); `reference-parts.test.ts` (R27 pins and checks, R29 equality, `referenceLines` contains every id); `server-claude`/`codex`/`app-server` tests still pin today's args for design and edit | `fidelity.spec.ts` (new: the switch, its persistence after reload, and `detail` in routed `/api/agent` and `/api/generate` bodies), `workbench.spec.ts`, `agent-panel.spec.ts` |
| T3 | `fit-checks.test.ts` (each code and its negative: board in shell → none; board in solid box → `INTERIOR_NO_SHELL`; board sticking 3 mm through the wall → `INTERIOR_OUTSIDE` 3.0; rotated shell; floating button 2 mm off → `FLOATING_PART` 2.0; contained board not floating; one part → none; demo → none; order stable; 64-part timing); `overallSizeMm` and `formatSizeMm`; `assumptionsStale` (name and colour changes → false; dimension change → true; undo to baseline → false); tool details and summaries in `agent-tools-model.test.ts`-style tests; `baselines.ts` | `fidelity.spec.ts` (readout and badge for the demo, `data-size-mm` equal to `overallSizeMm(demoModel)` computed in the test, which is 195.0 × 129.0 × 177.0 mm after Task 1 because the battery, the lens tubes and the stand extend past the housing; a routed agent result whose model floats a part shows the notice; a manual dimension edit shows the stale note and undo hides it), `workbench.spec.ts`, `edit-select.spec.ts`, `agent-panel.spec.ts` |
| T4 | `research.test.ts` (schema and semantic checks with hostile input; `briefFacts` has no URL or title; tool: off, limit, unavailable, success with a fake provider returning a brief, invalid twice → `RESEARCH_FAILED`, research-call timeout → `RESEARCH_FAILED` with the run continuing, run abort propagates; `referenceId` into `designTask` input; unknown id; request `references` valid and invalid); adapter tests: research args per spike result, design/edit/agent args byte-identical to today; `tool-registry.test.ts` (tool, label, effect `uses-network`); `agent-loop.test.ts` (instruction lines present only when registered) | `fidelity.spec.ts` (the switch; a routed stream with a `research_reference` result shows 參考來源 links with `rel="noopener noreferrer"`; a following `generate_design` result with that `referenceId` lists the sources in the details panel; the next request body carries `references` and `research`), `agent-panel.spec.ts` |
| T5 | `cutaway.test.ts` (`cutAxis` for views along each axis and a rotated object; `cutPlane` through the box centre with the camera side removed; `inRemovedHalf`) | `fidelity.spec.ts` (toggle sets `data-cutaway`; a click on the removed half of the demo housing does not select it, a click on the visible board does; switching objects clears it; the export image is unaffected: `data-export-image` `ok` with the toggle on), `explode.spec.ts`, `edit-select.spec.ts`, `export.spec.ts`, `hand-control.spec.ts` (hit testing is shared) |
| T6 | `fidelity-eval.test.ts` (`fidelityMetrics` on fixtures; `fidelitySummary` table from a hand-built artifact; `scoreTemplate`; the runner's task choice for each `VERIFY_*` combination, tested through an exported pure `fidelityTask(prompt, env)` so no model is called) | `fidelity-replay.spec.ts` is opt-in (only with the user's artifact); at the end of T6 the **full suite** |

Fixtures: `tests/fixtures/fidelity-models.ts` (T3) builds an enclosure shell with a board, cell and button, a floating variant, a board in a solid box, a rotated shell, and a 64-part model.

## 10. Data shapes and compatibility

| Data | Change | Old data |
|---|---|---|
| `Part.primitive` | + `shell` | every old model and edit plan valid; the JSON schema gains one enum value |
| `Part.tubeRatio` | meaning extended to shell | unchanged range and default use |
| `AgentRequest` | + `detail?`, `research?`, `references?` | missing → `concept`, `false`, `[]` |
| `/api/generate`, `/api/edit` bodies | + `detail?` | missing → `concept` |
| `generate_design` args | + `detail`, `referenceId` (nullable) | see §4.3 for argsJson without them |
| `edit_design` args | + `referenceId` (nullable) | same |
| `GenerateDesignDetail`, `EditDesignDetail` | + `sizeMm?`, `fit?`, `referenceId?` | older payloads parse |
| `StateChange`, `Workspace`, `SceneObject` | none | — |
| Export findings | + `COMPONENT_SEALED` | `data-export-findings` lists one more possible code |
| Browser storage | + `forgehand.detailMode`, `forgehand.research` | missing → defaults |
| Session state (browser) | provider baselines per object, briefs (≤ 3), sources per object | lost on reload, like the workspace today |

No saved projects exist yet (`projects-memory` is later), so nothing on disk needs migrating. A model with a shell sent to an older build would fail `validateModel`; there is no such path in this repo.

## 11. File ownership and parallel sessions

Other Kiro sessions work in this working tree at the same time. On 2026-11-26 the specs `workbench-ui`, `body-fit` and `english-ui` were being written; their implementation sessions will edit the files below too.

| File | Tasks of this spec | Also touched by |
|---|---|---|
| `shared/model.ts` | T1 | `english-ui` (validation messages) |
| `shared/agent.ts` | T1, T2, T3, T4 | agent-harness, export, AJ, `body-fit` (a `fit_to_body` tool detail, expected) |
| `shared/edit.ts` | T2 | — |
| `shared/joint.ts`, `shared/features.ts` | T1 | AJ |
| `shared/standard-parts.ts` | T2 | AJ |
| `shared/demo.ts` | T1 | `english-ui` (strings), possibly `workbench-ui` |
| `shared/hollow.ts`, `fit-checks.ts`, `research.ts`, `fidelity-text.ts` | this spec (new) | `body-fit` imports `hollow.ts`; `english-ui` edits `fidelity-text.ts` |
| `src/scene/geometry.ts` | T1 | `body-fit` (likely reads) |
| `src/scene/SceneViewport.tsx` | T5 | hand-manipulation, AJ, export, `workbench-ui`, `body-fit` |
| `src/print/printable.ts` | T1 | AJ, export |
| `src/export/findings.ts`, `pieces.ts` | T1 | export |
| `server/provider.ts` | T1, T2, T4 | `english-ui` (language line) |
| `server/agent.ts`, `server/agent-tools.ts` | T2, T3, T4 | agent-harness, AJ, export, `body-fit` |
| `server/tools/generate-design.ts`, `edit-design.ts` | T2, T3, T4 | — |
| `server/tools/index.ts`, `registry.ts` | T4 | agent-harness, export, `body-fit` |
| `server/claude.ts`, `codex.ts`, `app-server.ts` | T4 | — |
| `server/app.ts` | T2, T4 | agent-harness |
| `src/App.tsx`, `src/styles.css` | T2, T3, T4, T5 | every spec; `workbench-ui` restructures the layout |
| `src/agent/*` | T2, T4 | agent-harness, export, `english-ui` |
| `src/fidelity/**` | this spec (new) | `workbench-ui` mounts the components |
| `scripts/verify-real-provider.ts` | T6 | — |
| `tests/fixtures/joint-workspace.ts` | T1 | AJ, export |
| `tests/e2e/export.spec.ts` | T1, T5 (one case) | export |
| `README.md` | T1–T6 | every spec |
| `.kiro/specs/design-fidelity/**` | T4 (§14), T6 (§15), status marks | — |

**Rules for every task** (repeated in each task's session facts):

- Create and edit only the files the task lists. Never revert, reformat, stage or "fix" a file you did not change; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`.
- Before the first edit of a file in the right column, run `git status --short <file>`. If it shows changes, another session is working on it: stop and ask. Do not wait in a loop.
- `src/App.tsx`: keep the edit to mounting components and passing props; all logic lives in `src/fidelity/`. If `workbench-ui` has landed and defines slots, mount into its slots instead of today's panels, and report which.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- Only one session runs Playwright at a time (ports 5197/8797). If they are taken, wait a few minutes and retry, at most three times, then report. Never stop a process you did not start.

## 12. Requirement map

| Task | Requirements |
|---|---|
| T1 shell | 1–13, 70–72, 74, 76 (mesh size), 77, 80, 81 (shell line) |
| T2 rules, modes, table | 14–29, 70, 71, 74, 75 (creates `fidelity-text.ts`), 77, 80, 81 (modes) |
| T3 fit checks, numbers | 30–41, 70, 74–78, 80, 81 (numbers) |
| T4 research | 48–61, 70, 71 (tool list), 74, 75, 77, 78, 80, 81 (references, privacy) |
| T5 cutaway | 42–47, 73, 74, 75, 76 (no per-frame allocation), 77, 80, 81 (cutaway) |
| T6 evaluation | 62–69, 77, 80, 81 (evaluation) |

Requirements 79 and 82 apply to every task and to these documents.

## 13. Risks

- **Demo ripple (T1).** About 30 test files import `demoModel`; the shell changes joint thickness (bosses), piece volumes and findings. `solidDemoModel` keeps old assertions meaningful; the full e2e suite (about 25 minutes) is the check. Any unexpected failure stops the task.
- **Hollow STL in slicers.** By construction the mesh is closed with an inward-facing void, which slicers treat as an internal cavity; this is only confirmed by hand (manual check 2). A closed void also seals components (D2, `COMPONENT_SEALED`).
- **Wall limit (D1).** `tubeRatio ≤ 0.95` caps thin walls for large enclosures (5 mm at a 200 mm smallest side). The evaluation shows whether generated designs hit it.
- **Instruction size and latency.** `FIDELITY_RULES` with the table adds about 3 kB to every design and edit call. Detailed mode is slower (VISION: about 50 s on Claude, Codex slower); the evaluation measures both.
- **Model compliance.** The models may ignore the cap, misuse `tubeRatio`, or put internals outside the void. The fit checks make that visible; the evaluation counts it; nothing repairs it automatically.
- **Research spike.** Flag names and config values for web search in the isolated CLI modes are **assumptions** (§6.1). If both fail, research is not built (R51). App-server's effective-config check needs a research-specific path.
- **Prompt injection through briefs.** Page text could carry instructions into a brief. Short fields, URL checks, the "data, not instructions" framing and schema validation of the design output limit the effect to an odd design, which the user sees and can undo.
- **Reference numbers.** The candidate list in R26 is unverified; entries without a readable source are left out (D12).
- **Shared files.** `src/App.tsx`, `SceneViewport.tsx`, `shared/agent.ts`, `server/agent.ts` are edited by several specs at once; the stop-and-ask rule applies.
- **Clipping under SwiftShader.** Local clipping works in software WebGL, but the e2e checks only `data-cutaway` and picking, not pixels.

## 14. Spike log

Filled by T4 step 0 after the user's go-ahead. Until then: **not run.**

| Date | CLI and version | Transport | Flags or config used | Elapsed | Brief valid | https sources | Temp dir clean | Design path still isolated | User link check | Result |
|---|---|---|---|---|---|---|---|---|---|---|

## 15. Evaluation results

Filled by T6 after the user's go-ahead. Until then: **not run.** The table comes from `artifacts/fidelity-summary-{date}.md`, with the date, CLI versions, number of calls spent, and the user's 1–5 scores.
