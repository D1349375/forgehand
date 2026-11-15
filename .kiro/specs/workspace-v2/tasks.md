# Workspace v2 — Tasks

Implementation order is **1, 2, 3, 4, 5, 9, 6, 7, 8, 10**: e2e isolation → shared workspace data → operations and undo store → scene → App wiring → 物件 panel → agent contract and loop → agent tools → agent client → workspace e2e. The 物件 panel (Task 9) lands before the agent contract changes, so Tasks 6, 7 and 8 run back to back. Task numbers do not follow that order; the numbers stay as they are. Requirement numbers refer to `requirements.md`; section numbers (§) refer to `design.md`. Each task is meant for one fresh Kiro session that starts without memory, so each one lists what to read first and repeats the session facts.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

---

## Task 1 — E2E isolation: own ports, never reuse a server

`[x]`

The e2e suite has twice tested an unrelated app listening on port 5173. Give it its own ports and make a taken port a loud failure.

**Read first:** `playwright.config.ts`; `server/index.ts` (how `PORT` and `API_PORT` are read and validated, Vite started with `--strictPort`); `vite.config.ts` (`FORGEHAND_API_PORT` proxy); the test section of `README.md`; design §9; requirements 1–5.

**Build:**
- `tests/e2e/ports.ts`: a pure `e2ePorts(env)` returning `{ port, apiPort, localUrl }`. `E2E_PORT` defaults to 5197 and `E2E_API_PORT` to 8797; each must be an integer 1024–65535 and they must differ, otherwise it throws an `Error` with an English message. `localUrl` is `http://127.0.0.1:<port>`.
- `playwright.config.ts`: import `e2ePorts(process.env)`. `use.baseURL` is `PLAYWRIGHT_BASE_URL || localUrl`. `webServer` (only when `PLAYWRIGHT_BASE_URL` is unset): `command: 'npm run dev'`, `env` always contains `PORT` and `API_PORT`, plus `MODEL_PROVIDER: 'openai', OPENAI_API_KEY: ''` unless `RUN_LIVE_CLI === '1'`; `url: localUrl`; `reuseExistingServer: false`; timeout unchanged.
- `README.md` test section: one sentence saying the e2e suite starts its own server on ports 5197/8797 (override with `E2E_PORT` / `E2E_API_PORT`) and stops with an error if those ports are taken.
- No change to `server/index.ts` or `vite.config.ts` should be needed. If one is, stop and report.

**Tests:**
- `tests/unit/e2e-ports.test.ts`: defaults; both overrides; non-integer, out-of-range and equal ports throw; `localUrl` format.
- Verification runs, reported with their real output:
  1. Make sure something listens on 5173 and 8787. If the user's dev server is already running there, leave it alone. Otherwise start `npm run dev` with default ports as a background process (`control_pwsh_process`), and stop it at the end.
  2. Run the full suite. It passes, and the test server is on 5197 (check the Playwright output or `Get-NetTCPConnection -LocalPort 5197` while it runs).
  3. Negative check: start any listener on 5197 (for example `node -e "require('http').createServer((q,s)=>s.end('x')).listen(5197,'127.0.0.1')"` in the background), run one spec file, and confirm Playwright stops with its "already used" error instead of running tests. Stop the listener.

**Dependencies:** none.

**Done when:** `npm run check` passes; the full suite passes while a server is running on 5173/8787; the negative check fails loudly; the report lists all three results.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `test(e2e): run on own ports (spec workspace-v2, task 1)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 2 — `shared/bounds.ts` and `shared/workspace.ts` part 1: data, validation, placement

`[x]`

The workspace data model, its validation, and where a new object goes. Pure code in `shared/`, no UI.

**Read first:** `shared/model.ts`; `shared/agent.ts` (the `partId` constant and `PartIdSchema`); `src/scene/explode.ts` (`worldMatrices`, `partBoxes`); `tests/unit/explode.test.ts`; `.kiro/steering/structure.md`; design §2.1, §2.2, §2.5; requirements 6–10, 14, 55.

**Build:**
- `shared/model.ts`: `export const PartIdSchema = PartSchema.shape.id;`. `PartSchema` itself is not edited. `shared/agent.ts` uses it for its `partId` constant and keeps exporting `PartIdSchema`.
- `shared/bounds.ts`: move `worldMatrices` and `partBoxes` from `src/scene/explode.ts` verbatim (Three.js math classes only). Add `modelBox(model)` (union of `partBoxes`) and `objectBox(model, transform)` (`modelBox` transformed by the object's position and XYZ Euler rotation in degrees; the AABB of the result).
- `src/scene/explode.ts`: import both functions from `shared/bounds` and re-export them (`export { partBoxes, worldMatrices } from '../../shared/bounds'`), so existing imports keep working.
- `shared/workspace.ts`, part 1 (design §2.1, §2.2):
  - `WORKSPACE_VERSION = 1`, `MAX_OBJECTS = 8`, `ZERO_TRANSFORM`.
  - `ObjectIdSchema`, `ObjectTransformSchema`, `SceneObjectSchema`, `WorkspaceSelectionSchema`, `WorkspaceSchema` and their types.
  - `WorkspaceError` with codes `INVALID_WORKSPACE`, `OBJECT_LIMIT`, `UNKNOWN_OBJECT`, `DUPLICATE_OBJECT`, `INVALID_SELECTION`; fixed Traditional Chinese messages without ids; the limit message is `工作區最多 8 個物件，請先刪除一個物件。`, built from `MAX_OBJECTS`.
  - `emptyWorkspace()`, `activeObject(ws)`, `findObject(ws, id)`.
  - `assertWorkspace(ws)` (every rule in design §2.2, no copying, models not re-validated) and `validateWorkspace(input)` (parse + `validateModel` on every model + `assertWorkspace`; returns a copy; never puts Zod text in its message).
  - `placeBeside(objects, model)` exactly as design §2.5: gap `max(0.02, 0.1 × new width)` metres, Y and Z 0, rotation 0, x rounded to 5 decimals and clamped to ±100.
  - `createObject(ws, { id, model, source, providerModel, createdAt })`: `validateModel(model)`, `transform = placeBeside(ws.objects, model)`, `edited: false`. It does not check the object limit (`addObject` in Task 3 does).
- `.kiro/steering/structure.md`: the `shared/` line becomes "Zod schemas, validation, and pure geometry helpers that use only Three.js math classes, imported by BOTH server and src."; add lines for `bounds.ts` (`worldMatrices`, `partBoxes`, `modelBox`, `objectBox`) and `workspace.ts` (Workspace schema, validation, operations, placement).

**Tests:**
- `tests/unit/bounds.test.ts`: `partBoxes` and `worldMatrices` imported from `shared/bounds` match the values that `src/scene/explode.ts` re-exports; `modelBox(demoModel)`; `objectBox` with a translation; `objectBox` with a 90° rotation about Y swaps the X and Z extents.
- `tests/unit/workspace.test.ts`: a valid workspace (empty, one object, three objects) passes `validateWorkspace` and survives `JSON.parse(JSON.stringify(…))`; each `assertWorkspace` rule rejects its own violation (duplicate id, nine objects, active null with objects, active unknown, selection on a non-active object, unknown part id, duplicate part id, `objectId` null with part ids, explode out of range, explode non-zero with no objects, transform out of range); `validateWorkspace` rejects a model with a parent cycle, and the message contains no Zod text; `assertWorkspace` returns without copying (same references); `placeBeside` for no objects (zero transform), one object, three objects, a rotated neighbour, and the clamp; placed boxes never overlap; `createObject` uses the given id and `createdAt` and sets `edited: false`.
- `tests/unit/explode.test.ts` passes unchanged.
- E2E: `tests/e2e/explode.spec.ts` only (the move touches `explode.ts`).

**Dependencies:** none (Task 1 recommended first so e2e runs on its own ports).

**Done when:** `npm run check` passes, the tests above are green, and `explode.spec.ts` passes.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(workspace): add workspace schema and placement (spec workspace-v2, task 2)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 3 — Workspace operations, changes and the undo store

`[x]`

All the rules for changing a workspace and undoing changes, as pure functions with tests. Nothing is wired into the UI yet.

**Read first:** `shared/workspace.ts` (Task 2); `src/App.tsx` functions `commit`, `restore`, `undo`, `redo` (today's undo rules); design §2.3, §2.4, §3.1, §3.2; requirements 12, 13, 15–22, 46, 61.

**Build:**
- `shared/workspace.ts`, part 2 (design §2.3): `addObject`, `replaceModel`, `removeObject`, `setTransform`, `setActiveObject`, `selectParts`, `setExplode`. Every operation is pure, returns the same reference when nothing changes, keeps unchanged objects' references, and calls `assertWorkspace` on its result. `addObject` and `replaceModel` run `validateModel` on incoming models. `addObject` checks `MAX_OBJECTS` (`OBJECT_LIMIT`) and duplicate ids (`DUPLICATE_OBJECT`). Unknown ids throw `UNKNOWN_OBJECT`.
- `shared/workspace.ts` (design §2.4): `ObjectChangeSchema`, `WorkspaceChangeSchema`, `applyWorkspaceChange(ws, change) → { before, after }` in the order activation → object → selection → explode; `before` is the workspace after activation.
- `src/workspace/store.ts` (design §3.1, §3.2): `HISTORY_LIMIT = 50`, `WorkspaceState`, `WorkspaceAction` (`commit` with optional `before`, `replace`, `undo`, `redo`), `workspaceReducer`, `restoreSnapshot`, `canUndo`, `canRedo`, and an `initialWorkspaceState`. Snapshots hold `objects` and `activeObjectId` only. The first-object exception: a `commit` whose `before` has no objects while `past` is empty records nothing.

**Tests:**
- `tests/unit/workspace-ops.test.ts`: `addObject` makes the object active, clears the selection, resets explode, rejects the ninth object and a duplicate id; `replaceModel` sets `edited`, keeps or replaces `source`/`providerModel`, filters the selection of the active object; `removeObject` of the active object activates the previous one (or the new first), of another object keeps the active one, of the last object gives an empty workspace; `setActiveObject` resets selection and explode, same id returns the same reference; `selectParts` on another object activates it, `[]` gives `{ objectId: null, partIds: [] }`, unknown parts throw; `setTransform` merges position and rotation and rejects out-of-range values; no operation mutates its input; unchanged objects keep their references; `applyWorkspaceChange` order, `before` versus `after` for an edit of a non-active object, an `activeObjectId` that names an object only added in the same change is rejected, an invalid model in `add` or `model` is rejected.
- `tests/unit/workspace-store.test.ts`: commit records the previous snapshot and clears `future`; the first-object exception; a later add to an emptied workspace is recorded; the 50-step limit; undo and redo; `restoreSnapshot` keeps the selection and explode only when the active object is the same, and keeps only part ids that still exist; `replace` leaves history alone; a commit of the unchanged workspace is a no-op; snapshots share unchanged objects.

**Dependencies:** Task 2.

**Done when:** `npm run check` passes and the tests above are green.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser. This task does not touch the browser; no e2e run is needed.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(workspace): add workspace operations and undo store (spec workspace-v2, task 3)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 4 — Scene: several objects in `SceneViewport`

`[ ]`

`SceneViewport` renders a list of objects, each in its own group with its own transform. App still has one model and passes it as a one-object list, so nothing visible changes yet.

**Read first:** `src/scene/SceneViewport.tsx`; `src/scene/style.ts`; `src/scene/geometry.ts`; `src/scene/explode.ts`; the `<SceneViewport …>` element and `pick`/`onTransform` in `src/App.tsx`; `tests/e2e/edit-select.spec.ts` (`clickPart`, `projectPart`, the camera-resize test); `tests/e2e/workbench.spec.ts` (reset returns to the first framing); `tests/e2e/explode.spec.ts`; `shared/workspace.ts` (`ObjectTransform`, `ZERO_TRANSFORM`); design §4; requirements 23–29.

**Build:**
- `src/scene/scene-sync.ts`: pure `planSceneSync(previous, next)` → `{ build, rebuild, move, remove, refit }` (design §4.2).
- `src/scene/style.ts`: `HOLOGRAM.inactiveFactor = 0.4`; base opacities stored in `userData` at build time; `applyPartStyle(group, { selected, dimmed })`; `applySelectionStyle(group, selected)` keeps its signature and calls it with `dimmed: false`.
- `src/scene/SceneViewport.tsx` (design §4.1–§4.5): props `objects`, `activeObjectId`, the rest as listed; one entry per object with a `root` group that carries the transform and `userData.objectId`; build-before-remove and dispose as today; refit on the union box only when `planSceneSync` says so; selection, gizmo and explode on the active entry only; the previously active entry snaps back to assembled when the active object changes; inactive entries dimmed; picking over all entries with `(objectId, partId)` cycling; the canvas attributes table in §4.5, including `data-object-count`, `data-active-object-id` and `data-object-json`; `projectPart(id, objectId?)`. Try-on drawing is unchanged.
- `src/App.tsx`, minimal: pass `objects={display ? [{ id: display.lineage, model: display.model, transform: ZERO_TRANSFORM }] : []}` and `activeObjectId={display?.lineage ?? null}`; `onPick(objectId, partId, additive)` and `onTransform(objectId, partId, position, rotation)` ignore `objectId` (there is only one object). `fitKey` goes away. No other App change.

**Tests:**
- `tests/unit/scene-sync.test.ts`: build for new ids; rebuild only for a new model reference; move only for changed transform values; remove; `refit` only when the id set changes or the scene goes from empty to non-empty; an unchanged list plans nothing.
- `tests/unit/scene.test.ts`: `applyPartStyle` with `dimmed` scales surface and edge opacity by `inactiveFactor` and restores it; selection still recolours edges.
- E2E while developing: `workbench.spec.ts`, `edit-select.spec.ts`, `explode.spec.ts`, `arm-try-on.spec.ts`. At the end: the full suite.

**Dependencies:** Task 2 (`ObjectTransform`, `ZERO_TRANSFORM`).

**Done when:** `npm run check` passes, the unit tests above are green, and the full e2e suite passes unchanged.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(scene): render several objects (spec workspace-v2, task 4)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 5 — App on the workspace

`[ ]`

`App.tsx` stops holding one `DisplayModel` and uses the workspace store. Generating adds an object, editing acts on the active object, undo covers the workspace. The agent client still speaks the old contract through a temporary adapter.

**Read first:** `src/App.tsx` (all of it); `src/workspace/store.ts` and `shared/workspace.ts` (Tasks 2–3); `src/agent/useAgentRun.ts` (its options) and `src/agent/types.ts`; `tests/e2e/edit-select.spec.ts` (the three edit-conflict tests and their messages); `tests/e2e/workbench.spec.ts`; `tests/e2e/agent-panel.spec.ts`; design §3.3, §5.1 (including the temporary adapter paragraph); requirements 11, 15–22, 30–32, 36, 54.

**Build:**
- `src/workspace/useWorkspace.ts` (design §3.3): state in a ref, `dispatch` returns the new workspace synchronously, `current()`, `canUndo`, `canRedo`.
- `src/workspace/app-rules.ts` (pure), so App's own rules are unit-tested:
  - `pickPart(workspace, objectId, partId, additive)` → the next workspace (requirement 24). A part of the active object: without Shift, select only that part (a click on the only selected part keeps it, as today's `pick`); with Shift, add or remove it. A part of another object: activate that object and select only that part, with or without Shift. Empty space (`objectId`/`partId` null): without Shift, clear the selection and keep the active object; with Shift, no change, as today.
  - `canApplyEdit(workspace, targetObjectId, when)` → `{ ok: true } | { ok: false, message }` (requirement 32). `ok` only if the object still exists and is active. Otherwise the message is today's text for that moment: `when: 'answer'` (the AI answer arrives, today's check in `edit()`) → `等待期間已換成另一個模型，這次修改沒有套用。`; `when: 'conflict'` (the user clicks 套用 AI 修改 in the conflict dialog, today's check in `applyEdit`) → `目前顯示的已是另一個物件，這次 AI 修改沒有套用。`. `tests/e2e/edit-select.spec.ts` checks the second text.
  - App's `pick`, `edit` and `applyEdit` call these instead of inlining the rules.
- `src/App.tsx`:
  - `display`, `history`, `selected` and `explode` are replaced by `useWorkspace()`; `active = activeObject(workspace)` feeds the caption, part list, part editor and details panel.
  - Every row of the design §5.1 table: generate, accepted approximation and 載入示範模型 add an object through `createObject` + `addObject` (`crypto.randomUUID()`, `new Date().toISOString()`) as a `commit`; edits, part fields, gizmo, delete parts as `commit` on the active object; selection, explode and activation as `replace`; undo/redo buttons and keys dispatch `undo`/`redo`.
  - `SceneViewport` gets `objects={workspace.objects}` and `activeObjectId`; `pick` applies requirement 24 (another object's part activates it and selects only that part, with or without Shift; empty space clears the selection).
  - Edit form: `edit()` remembers `base.id`; the answer applies only if that object still exists and is active; otherwise today's two messages. The conflict dialog stores `objectId` instead of `lineage`.
  - `transformMode` resets when `activeObjectId` changes and when a restore drops selected parts. Timing ref `{ objectId, startedAt }`; first-render messages keyed on the active id; render-error fallback to the last rendered workspace with `replace`.
  - Object limit: at `MAX_OBJECTS` the generate button, 接受近似並建立 and both 載入示範模型 buttons are disabled, with the notice `工作區最多 8 個物件，請先刪除一個物件。` under the generate form.
  - Caption: add `· 工作區 N 個物件` when there is more than one object; the `model-name` heading is unchanged.
  - The temporary agent adapter from design §5.1, marked `TEMPORARY (workspace-v2 Task 8)`. `useAgentRun` and `src/agent/*` are not changed.
- No new controls besides the limit notice; the 物件 panel is Task 9.

**Tests:**
- `tests/unit/app-rules.test.ts`: `pickPart` for each case above (active-object click, repeat click on the only selected part, Shift add, Shift remove, another object's part with and without Shift, empty space with and without Shift), never mutating its input; `canApplyEdit` for an active target (`ok`), a target that exists but is not active, a removed target and an empty workspace, each with both `when` values and the matching message. The temporary agent adapter is not unit-tested; Task 8 deletes it.
- The store and operations are tested in Task 3; `npm run check` covers the hook and App wiring through types and build.
- E2E while developing: `workbench.spec.ts`, `edit-select.spec.ts`, `agent-panel.spec.ts`, `explode.spec.ts`. At the end: the full suite. Every existing spec passes unchanged; if one needs a change, stop and report (requirement 52).

**Dependencies:** Tasks 3 and 4.

**Done when:** `npm run check` passes, `app-rules.test.ts` is green, and the full e2e suite passes with no existing test file changed.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(workspace): keep several objects in the workbench (spec workspace-v2, task 5)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 6 — Agent contract and loop on the workspace

`[ ]`

The agent request carries the workspace, `state` events carry workspace changes, and the loop and the six existing tools work on the workspace (on the active object; `objectId` arguments come in Task 7). The browser keeps the old contract under `Legacy*` names until Task 8.

**Known gap:** from this task until Task 8 lands, a real agent run in the browser fails with a 400, because the browser still sends the old request. Unit and e2e tests stay green. Run Tasks 6, 7 and 8 back to back. **The report of this task must say: "a real agent run in the browser fails until Task 8".**

**Read first:** `shared/agent.ts`; `shared/workspace.ts`; `server/agent.ts`; `server/agent-tools.ts`; `server/tools/registry.ts`, `helpers.ts`, `index.ts` and the six tool files; `server/app.ts` (the global `express.json` and the `/api/agent` handler); `src/agent/apply-state.ts`, `events.ts`, `labels.ts`; the tests `tests/unit/agent.test.ts`, `agent-tools.test.ts`, `agent-tools-model.test.ts`, `agent-loop.test.ts`, `tool-registry.test.ts`, `server-agent.test.ts`; design §6, §7.1, §7.3, §7.4; requirements 37–39, 41, 43–46, 49, 50, 53, 60.

**Build:**
- `shared/agent.ts` (design §6):
  - Rename the current browser-facing exports, unchanged in content: `ModelStateChangeSchema` → `LegacyModelStateChangeSchema`, `StateChangeSchema`/`StateChange` → `LegacyStateChangeSchema`/`LegacyStateChange`, `ToolResultSchema`/`ToolResult` → `LegacyToolResultSchema`/`LegacyToolResult`, `ToolEventSchema` → `LegacyToolEventSchema`; copy the current `AgentRequestSchema` to `LegacyAgentRequestSchema`. Mark the block `Legacy: removed in workspace-v2 Task 8`.
  - New, under the final names: `AgentRequestSchema`, `AgentRequest`, `validateAgentRequest` with `workspace` (§6.1) and `AgentRequestError('INVALID_WORKSPACE')`; `StateChangeSchema = WorkspaceChange + tryOn` and `ToolResultSchema` using it (§6.2); `UNKNOWN_TOOL_LABEL` and `ToolEventSchema` with `label` (§6.3); the detail schemas of §6.4.
  - Update imports in `src/agent/` and the tests that use the renamed names (`grep` for each); only rename, no behaviour change. Expected files: `src/agent/apply-state.ts`, `src/agent/events.ts`, `src/agent/labels.ts`, `tests/unit/apply-state.test.ts`, `tests/unit/agent-client-events.test.ts`, `tests/unit/run-reducer.test.ts` (if it imports `ToolResult`), `tests/e2e/agent-panel.spec.ts` (types only).
- `server/tools/registry.ts`: required `label` (1–40 characters) on `ToolDefinition`; `ToolContext` gains `newObjectId()` and `now()`.
- `server/tools/helpers.ts`: `resolveTarget`, `switchTo`, `checkedChange` (§7.1).
- `server/agent-tools.ts`: `AgentWorkingState = { workspace, tryOn, cameraOn }`; `runTool(call, state, provider, signal, env)` passes `newObjectId`/`now` into the context (defaults `crypto.randomUUID()` and `new Date().toISOString()`).
- The six tools, smallest change that works on the workspace and the active object: labels (生成設計, 修改設計, 選取零件, 檢視目前狀態, 爆炸圖, 護臂試戴); `generate_design` returns `OBJECT_LIMIT` before `provider.run` at the limit, otherwise an `add` change with the server-made `SceneObject` (`createObject` with `ctx.newObjectId()`/`ctx.now()`) and the id in its summary and detail; its description says it adds a new object; `edit_design`, `select_parts`, `explode_view` act on the active object and return `WorkspaceChange`s via `checkedChange`; `get_project_state` returns the new detail with `target` = the active object; `wear_on_arm` returns `NO_MODEL` on an empty workspace, otherwise unchanged.
- `server/agent.ts`: `runAgent` options accept `newObjectId`/`now`; working copy from `req.workspace`; apply each change with `applyWorkspaceChange(...).after` and `tryOn`; `tool` event with `label` (`UNKNOWN_TOOL_LABEL` for unknown tools); `stripModels` (§6.2); the per-round snapshot of §7.3; the empty-scene rule line becomes "If the workspace is empty, only generate_design and get_project_state work; other tools return NO_MODEL." The other `AGENT_INSTRUCTIONS` lines come in Task 7.
- `server/app.ts` (§7.4): `app.use('/api/agent', express.json({ limit: '512kb', strict: true }))` before the global 128 kB parser; `INVALID_WORKSPACE` with `目前工作區資料無效，無法處理這次請求。`. `/api/generate` and `/api/edit` unchanged.

**Tests:**
- `agent.test.ts`: new request schema (missing `workspace` → structural error, invalid workspace → `INVALID_WORKSPACE`), `StateChangeSchema` round-trip for each object op, `ToolEventSchema` requires `label`.
- `agent-tools.test.ts`, `agent-tools-model.test.ts`: build working states from workspaces (a small helper in the test); every existing case on the active object; `generate_design` uses the injected id and time, places beside, and returns `OBJECT_LIMIT` without calling the provider; every writing tool's change passes `applyWorkspaceChange`.
- `agent-loop.test.ts`: `tool` events carry labels, `其他步驟` for an unknown tool; `result` events carry no model or `SceneObject`; a `state` event for `generate_design` carries the complete `SceneObject`; the snapshot lists all objects and only the active object's parts; the working copy after a generate contains the new object.
- `tool-registry.test.ts`: every tool has a non-empty label; the generated tool list.
- `server-agent.test.ts`: existing route tests on the new request shape; a valid 200 kB `/api/agent` request streams while a 200 kB `/api/edit` body gets 413; an `/api/agent` body over 512 kB gets 413; `INVALID_WORKSPACE` cases with the fixed message and no id in the body.
- E2E: `tests/e2e/agent-panel.spec.ts` only (the browser runs on the `Legacy*` names).

**Dependencies:** Task 3. Task 5 must be done (App's adapter keeps the browser working on the old contract); in the implementation order Task 9 is also done by now.

**Done when:** `npm run check` passes, the tests above are green, `agent-panel.spec.ts` passes, and the report states the known gap.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser. Here only `agent-panel.spec.ts` is needed.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(agent): run the agent on the workspace (spec workspace-v2, task 6)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 7 — Agent tools: `objectId` and three object tools

`[ ]`

The agent can target any object by id, switch the active object, move objects and remove them.

**Known gap:** a real agent run in the browser still fails until Task 8 lands (see Task 6). **The report of this task must say: "a real agent run in the browser fails until Task 8".**

**Read first:** `server/tools/*.ts`, `server/tools/helpers.ts` (`resolveTarget`, `switchTo`, `checkedChange` from Task 6); `server/agent.ts` (`AGENT_INSTRUCTIONS`); `shared/agent.ts` (detail schemas); `shared/workspace.ts` (operations); design §7.2, §7.3; requirements 40, 42, 44, 48.

**Build:**
- `objectId: ObjectIdSchema.nullable().optional()` on `edit_design`, `select_parts`, `explode_view` and `get_project_state` (design §7.2). The three writing tools set `activeObjectId: switchTo(...)`; `get_project_state(objectId)` only reads and never activates. `edit_design` on a non-active object sends an empty selection to `editTask`.
- `server/tools/set-active-object.ts` (切換物件), `set-transform.ts` (移動物件), `remove-object.ts` (移除物件), as in the §7.2 table, with `ObjectToolDetail`. `set_transform` with neither `position` nor `rotation` → `INVALID_ARGS` `請至少提供 position 或 rotation。`.
- `server/tools/index.ts`: registration order `generate_design`, `edit_design`, `select_parts`, `get_project_state`, `explode_view`, `set_active_object`, `set_transform`, `remove_object`, `wear_on_arm`.
- `AGENT_INSTRUCTIONS`: the five new rule lines of §7.3; every existing line stays.

**Tests:**
- `tests/unit/agent-tools-workspace.test.ts`: each of the four tools with and without `objectId` (null and absent mean active); writing tools activate a non-active target and `get_project_state(objectId)` does not; `UNKNOWN_OBJECT` and `NO_MODEL` with no state change; `edit_design` sends the target's model and an empty selection for a non-active target (capture the `editTask` input with the fake provider); `set_active_object` (switch, already active, unknown); `set_transform` (position only, rotation only, both, neither, out of range, non-active target); `remove_object` (active, other, last, unknown); every change passes `applyWorkspaceChange`.
- `tool-registry.test.ts`: exactly nine tools in the order above, each with its label; the generated tool list has nine lines.
- `agent-loop.test.ts`: one run that generates an object and then edits it by the id from the result (the second round's snapshot lists that id); `AGENT_INSTRUCTIONS` contains the new rules.

**Dependencies:** Task 6.

**Done when:** `npm run check` passes, the tests above are green, and the report states the known gap.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser. This task is server-only; no e2e run is needed.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(agent): add object tools (spec workspace-v2, task 7)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 8 — Agent client on the new contract

`[ ]`

The browser sends the workspace, applies workspace changes from `state` events, and shows tool labels from the server. This closes the gap opened in Task 6 and removes the temporary code.

**Read first:** `src/agent/request.ts`, `apply-state.ts`, `events.ts`, `labels.ts`, `run-reducer.ts`, `useAgentRun.ts`, `types.ts`; the `TEMPORARY (workspace-v2 Task 8)` block and the `useAgentRun(...)` call in `src/App.tsx`; the `Legacy*` block in `shared/agent.ts`; `tests/unit/apply-state.test.ts`, `agent-client-events.test.ts`, `run-reducer.test.ts`; `tests/e2e/agent-panel.spec.ts`; design §8, §6.5; requirements 47, 51, 52.

**Build:**
- The `src/agent/` changes of design §8: `request.ts` (workspace in the request), `apply-state.ts` (`applyStateEvent(payload, workspace) → { before, after, recordUndo, tryOn? } | null`, never creating ids, timestamps or placement), `useAgentRun.ts` (new options, tracks its own workspace across events), `events.ts` (`tool` keeps `tool` and `label`), `labels.ts` (map and `toolLabel` deleted; `resultText` adds `UNKNOWN_OBJECT`), `run-reducer.ts` (labels from events; a result takes the latest tool entry's label).
- `src/App.tsx`: `applyWorkspace` dispatches `commit(after, before)` when `recordUndo`, else `replace(after)`, and clears stale dialogs and sets `代理已建立新物件…` / `代理已修改物件…` messages as `commitFromAgent` does today. Delete the temporary adapter.
- Delete `src/agent/types.ts` and every `Legacy*` export from `shared/agent.ts`.
- `tests/e2e/agent-panel.spec.ts`: new frame shapes and the request assertion `workspace.objects[0].model.name` (design §8). Steps and expectations stay the same.

**Tests:**
- `apply-state.test.ts`: an `add` gives a workspace containing exactly the received object (same id, transform, `createdAt`); `recordUndo` true only with an object change; an edit of a non-active object gives `before` with that object active; selection, explode and tryOn only; invalid payloads and `WorkspaceError`s → `null`.
- `agent-client-events.test.ts`: `parseAgentEvent` for `tool` with `label`; `buildAgentRequest` is accepted by `AgentRequestSchema` and `validateAgentRequest`.
- `run-reducer.test.ts`: labels from events; a result entry takes its tool's label; `UNKNOWN_TOOL_LABEL` fallback; no raw tool names in the log.
- E2E: `agent-panel.spec.ts` while developing, then the full suite.

**Dependencies:** Tasks 6 and 7.

**Done when:** `npm run check` passes; the full e2e suite passes; `grep` finds no `Legacy`, no `DisplayModel`, no `toolLabel` and no `TEMPORARY (workspace-v2` in `src/`, `shared/`, `server/` or `tests/`. Do not run a real agent; tell the reviewer that a manual run is possible again.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(agent): apply workspace changes in the browser (spec workspace-v2, task 8)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 9 — 物件 panel

`[ ]`

A panel in the control column to switch, rename, delete and move objects.

**Read first:** `src/App.tsx` (`NumberField`, the part editor and its `vector` helper, the part name field, the `agentActive` gating, the control column order); `src/styles.css` (`.panel`, `.part-picker`, `.vector-field`); `shared/workspace.ts` (`setActiveObject`, `replaceModel`, `setTransform`, `removeObject`); `tests/e2e/agent-panel.spec.ts` (the disabled-controls test); design §5.2; requirements 33–36.

**Build:**
- `src/ui/NumberField.tsx`: `NumberField` moved out of `App.tsx` unchanged; App imports it.
- `src/workspace/object-panel.ts` (pure): `objectRows(workspace)` → `{ id, name, partCount, active }[]` in creation order; `renameObject(workspace, id, text)` → trims, rejects empty or over 500 characters with a Traditional Chinese message, returns the same workspace when the name is unchanged, otherwise `replaceModel` with the new `model.name`.
- `src/workspace/ObjectPanel.tsx`: the markup of design §5.2 (`aria-label="物件"`, list `物件清單`, entries with `aria-pressed`, `物件名稱`, `物件位置 X/Y/Z` in mm, `物件角度 X/Y/Z` in degrees, `刪除物件`), every control disabled when `disabled`.
- `src/App.tsx`: render the panel between the prompt panel and the 零件 panel when there is at least one object; `onActivate` → `replace(setActiveObject)`; `onRename` → `commit(renameObject)` with errors shown like part adjust errors; `onTransform` → `commit(setTransform)`; `onRemove` → `commit(removeObject)`; `disabled={agentActive}`.
- `src/styles.css`: `.objects-panel` rules only, in the existing style.

**Tests:**
- `tests/unit/object-panel.test.ts`: `objectRows` order and active flag; `renameObject` trims, rejects empty and too long names, keeps the reference for an unchanged name, and changes only `model.name`.
- E2E: the full suite at the end (the new panel makes the control column taller; `edit-select.spec.ts` already scrolls the canvas into view before measuring). If an existing spec breaks because of layout, stop and report (requirement 52).

**Dependencies:** Task 5. In the implementation order this task runs right after Task 5 and before Task 6, so the panel lands while the agent still uses the old contract and Tasks 6, 7 and 8 can run back to back.

**Done when:** `npm run check` passes, the unit tests are green, and the full e2e suite passes unchanged.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(workspace): add the objects panel (spec workspace-v2, task 9)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 10 — Workspace e2e and the full suite

`[ ]`

One Playwright spec that checks the multi-object behaviour end to end, then the full suite.

**Read first:** `tests/e2e/edit-select.spec.ts` (`loadDemo`, `clickPart` via `window.__forgehandScene.projectPart`, `rows`); `tests/e2e/workbench.spec.ts` (routing `/api/generate`); `tests/e2e/agent-panel.spec.ts` (scripted SSE with `serializeSseEvent`); `src/scene/SceneViewport.tsx` (canvas attributes, `projectPart(id, objectId?)`); `shared/workspace.ts`; design §4.5 and §11; requirements 14, 17, 23–24, 27, 29, 33, 41, 47, 52–54.

**Build:** `tests/e2e/workspace.spec.ts`, with `/api/*` routed and the real WebGL scene:
1. Load the demo, generate a second object (routed `/api/generate`) → `data-object-count` is `2`, the new object is active (`data-active-object-id`, `data-model-name`), and its position X in `data-object-json` is greater than the first object's; undo removes it.
2. Click a part of the inactive object (`projectPart(partId, objectId)`) → that object becomes active and `data-selected-ids` is that part.
3. Explode the active object → a part of the other object projects to the same screen point as before.
4. 物件 panel: switch by clicking an entry; rename (`data-model-name` changes; undo restores it); move with 物件位置 X (`data-object-json` changes; undo restores it); 刪除物件 (count drops; undo restores it).
5. Limit: click 載入示範模型 until there are eight objects → 生成 3D 草案 and 載入示範模型 are disabled and the limit notice is visible.
6. Agent: a scripted `/api/agent` stream whose `state` frame adds a server-made object (fixed id, transform X `0.4`, fixed `createdAt`) → the browser shows exactly that id and transform in `data-object-json` and makes it active; undo removes it.
- No app changes are expected. If a scenario finds a bug, fix it only if the fix is a few lines and report it; otherwise stop and report.

**Tests:** this file is the test; then the full suite once.

**Dependencies:** Tasks 1–9.

**Done when:** `npm run check` passes, `workspace.spec.ts` passes, and the full e2e suite passes.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Ports: before Task 1 lands, the suite uses port 5173 and can hit another app the user runs there; after Task 1 it starts its own server on 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite (about 8 minutes; give the command a timeout of at least 15 minutes) once at the end of a task that touches the browser.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `test(e2e): cover the multi-object workspace (spec workspace-v2, task 10)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Cut order

If time runs short, drop these in order. Each is a self-contained part of one task, and the rest of the spec works without it:

1. Inactive-object dimming (Task 4): all objects draw at full style.
2. The object rotation fields 物件角度 (Task 9): position fields only.
3. Rename in the 物件 panel (Task 9): names change only through `edit_design` or the AI edit form.
4. `remove_object` (Task 7): objects are removed in the 物件 panel only.
5. `set_transform` (Task 7): objects are moved in the 物件 panel only.

Dropping an item removes its tests and its requirement (23 dimming, 33 rotation/rename, 42 tools); say so in the task report.
