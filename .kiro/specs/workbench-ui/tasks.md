# Workbench UI: a full-screen workbench, the parts tray and objects as groups — Tasks

Implementation order is **1 → 7**. Task 1 builds the pull-out as pure shared code and Task 2 gives it to the agent; neither changes the UI, so both can run beside other specs' non-UI tasks. Task 3 turns the page into the full-screen workbench (HUD, docks, status bar, panel model, framing in the free area, one demo button). Task 4 builds the parts tray for the mouse and keyboard, Task 5 for the hands, Task 6 the data cards and the agent's panel and card tools, and Task 7 checks that every feature is reachable and updates the README. Requirement numbers refer to `requirements.md` (stable ids); section numbers (§) refer to `design.md`. Each task is meant for one fresh Kiro session that starts without memory, so each one lists what to read first and repeats the session facts.

The tasks follow the recommendations of the open decisions in `requirements.md` ("Decisions"). If the user decides otherwise, the reviewer updates the affected task before it starts.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

## Parallel sessions and file ownership

Other Kiro sessions work in this same working tree at the same time. On 2026-11-26, the specs `design-fidelity`, `body-fit` and `english-ui` were being written; their tasks will edit some of the same files. Their uncommitted changes are expected and are not yours.

| This spec creates (only these sessions edit them) | Shared files this spec edits (other specs edit them too) |
|---|---|
| `shared/pull-out.ts`, `shared/workbench.ts`, `shared/measure.ts`, `server/tools/pull-out-part.ts`, `server/tools/show-panel.ts`, `server/tools/data-card.ts`, `src/workbench/**`, `tests/unit/pull-out*.test.ts`, `tests/unit/workbench-*.test.ts`, `tests/unit/parts-tray.test.ts`, `tests/unit/hand-tray.test.ts`, `tests/unit/data-cards.test.ts`, `tests/e2e/workbench-helpers.ts`, `tests/e2e/pull-out.spec.ts`, `tests/e2e/workbench-layout.spec.ts`, `tests/e2e/parts-tray.spec.ts`, `tests/e2e/hand-tray.spec.ts`, `tests/e2e/data-cards.spec.ts`, `tests/e2e/reachability.spec.ts`, `.kiro/specs/workbench-ui/**` | `shared/workspace.ts`, `shared/agent.ts`, `server/agent.ts`, `server/tools/index.ts`, `server/tools/helpers.ts`, `server/tools/create-joint.ts`, `src/App.tsx`, `src/styles.css`, `src/scene/SceneViewport.tsx`, `src/agent/*`, `src/workspace/ObjectPanel.tsx`, `src/joints/JointPanel.tsx`, `src/joints/PrinterPanel.tsx`, `src/hands/*`, `src/export/dialog-model.ts`, `src/export/ExportDialog.tsx`, existing `tests/unit/*.test.ts` and `tests/e2e/*.spec.ts` named in a task, `README.md` |

Later specs plug into this spec's files: `design-fidelity` fills the `extras` slot of `ObjectCaption`, the `checks` slot of `DetailsPanel`, the `notices` slot of `PartPanel`, adds `PRIMITIVE_ICONS.shell` and may add a `dimensions` card kind; `body-fit` adds the `fit` panel row and the `fit` card kind; `english-ui` replaces the strings of `src/workbench/text.ts` and adds its switch to the HUD's `languageSlot`.

**Rules for every task** (repeated in each task's session facts):
- Create and edit only the files the task lists under **Build** and **Tests**. Never revert, reformat, stage or "fix" a file you did not change, and never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`.
- Before the first edit of a shared file (right column above), run `git status --short <file>`. If it shows changes, another session is still working on it: stop and ask. Do not wait in a loop.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them; the task is then not done until the reviewer confirms.
- Only one session runs Playwright at a time, because the suite needs ports 5197/8797. If they are taken, another session is running e2e: wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.

---

## Task 1 — Pull-out in `shared/`: the operation, the change and the export proof

`[ ]`

Taking a part with its child parts out of an object into a new object: subtree, exact re-rooting in place, placement next to the original, joint re-pointing, selection, the `pull-out` object change, and the helper that separates two parts of one object before a join. Pure code; nothing changes on screen.

**Read first:** `shared/workspace.ts` (all of it: `assertWorkspace`, `assertJoints`, `placeBeside`, `addObject`, `replaceModel`, `removeObject`, `selectParts`, `ObjectChangeSchema`, `applyWorkspaceChange`, `WorkspaceError` and `MESSAGES`, the reference rules in the "Part 2" comment); `shared/assembly.ts` (`assemblyOf`, `objectMatrix`, `transformOfMatrix`, the rounding helpers); `shared/bounds.ts` (`worldMatrices`, `partBoxes`, `modelBox`, `objectBox`); `shared/model.ts` (`PartSchema`, `ModelSpecSchema`, `validateModel`); `shared/joint.ts`; `shared/contact.ts` (`touching`, `worldFace`, `planJoin`); `shared/joint-rules.ts` (`newJoint`); `src/workspace/store.ts` (`workspaceReducer`, `restoreSnapshot`); `shared/demo.ts` (the demo's hierarchy: `housing` with six children, `support` and `base` as roots); `tests/fixtures/joint-workspace.ts`; `tests/unit/export-pieces.test.ts` (how the WASM is loaded in Node and how pieces are built); design §3, §10, §11 (T1); requirements 39–53, 55, 83.

**Build:**
- `shared/pull-out.ts` (design §3.1–§3.4, §3.6): `subtreeIds`, `PullOutCheck`, `pullOutCheck`, `PullOutInput`, `pulledObject`, `placeNextTo`, `pullOutPart`, `splitForJoin`. Three.js math classes only; type-only imports of `shared/workspace.ts` types where a runtime import would make a cycle.
- `shared/workspace.ts`: `WorkspaceErrorCode` and `MESSAGES` gain `UNKNOWN_PART` (找不到指定的零件。) and `WHOLE_OBJECT` (這個零件連同子零件就是整個物件，不需要拉出。); `ObjectChangeSchema` gains the `pull-out` member of design §3.5; `applyWorkspaceChange` applies it with `pullOutPart`. Nothing else changes (`WORKSPACE_VERSION` stays 2; `assertJoints` and `migrateWorkspace` unchanged).
- `src/workspace/object-panel.ts`: the `objectRows` comment says "in workspace order" instead of "in creation order". No code change.

**Tests:**
- New `tests/unit/pull-out.test.ts`: the T1 cases of design §11, including the timing line for 64 parts and 32 joints (printed, not asserted).
- New `tests/unit/pull-out-export.test.ts`: the export cases of design §11 with the real manifold-3d WASM, loaded the way `export-pieces.test.ts` loads it.
- Existing tests pass unchanged.
- E2E: none.

**Dependencies:** none (all earlier specs are built).

**Done when:** `npm run check` passes, the new tests are green, no existing test changed, and the report gives the timing line and the workspace before and after pulling the demo's `battery` out (object ids, names, part counts, the new object's position).

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. Before the first edit of `shared/workspace.ts`, check `git status --short shared/workspace.ts`; if it shows changes, stop and ask.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests. Never run `verify:real` or `verify:edit`. Do not add dependencies.
- Every operation follows the workspace rules: pure, never mutates its input, keeps the references of unchanged objects and joints, ends with `assertWorkspace`, throws only `WorkspaceError` with a fixed Traditional Chinese message.
- The server imports `shared/`: no DOM, no `src/` imports.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(workspace): pull a part out into its own object (spec workbench-ui, task 1)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

**Requirements:** 39–49, 50 (`splitForJoin`), 51–53, 55, 83 (timing), 88.

---

## Task 2 — Agent: `pull_out_part`, joins inside one object, instructions

`[ ]`

The agent can pull a part out, and `create_joint` on two parts of one object first separates them. The browser names an agent pull-out in its message.

**Read first:** Task 1's `shared/pull-out.ts`; `server/tools/registry.ts`, `helpers.ts` (`ok`, `fail`, `resolveTarget`, `checkedChange`, `OptionalObjectIdSchema`), `index.ts`, `create-joint.ts`, `remove-joint.ts`, `remove-object.ts`, `joint-helpers.ts` (`sideText`, `methodText`, `jointDetail`, `printerOf`); `server/agent.ts` (`AGENT_INSTRUCTIONS` from line 244, `workspaceSnapshot`, `stripModels`); `shared/agent.ts` (`StateChangeSchema`, the detail schemas); `src/agent/apply-state.ts`; in `src/App.tsx`: `applyAgentWorkspace`; `tests/unit/tool-registry.test.ts`, `agent-loop.test.ts` (the exact instruction lines around line 558), `agent-joint-tools.test.ts` (the test "joins two parts of one object that already touch", line 141), `apply-state.test.ts`; `tests/e2e/workspace.spec.ts` (the last test: how a routed `/api/agent` stream adds an object); design §4, §11 (T2); requirements 50, 56, 57, 74–77, 80.

**Build:**
- `shared/agent.ts`: `PullOutDetailSchema` (design §4.1). Nothing else.
- `server/tools/pull-out-part.ts` (design §4.1), with its strings in a `TEXT` constant at the top; registered in `server/tools/index.ts` right after `removeJoint`.
- `server/tools/create-joint.ts` (design §4.2): two parts of one object go through `splitForJoin`; the description and summary as in design §4.2.
- `server/agent.ts`: the `AGENT_INSTRUCTIONS` changes of design §4.3.
- `src/agent/apply-state.ts`: `StateEffects.objectOp` (design §4.4).
- `src/App.tsx`: the first branch of `applyAgentWorkspace` for `objectOp === 'pull-out'` (design §4.4). No other change in this file.

**Tests:**
- New `tests/unit/pull-out-agent.test.ts`: design §11 (T2).
- Extend `tool-registry.test.ts` (the new tool, label 拉出零件, effect `writes-scene`), `apply-state.test.ts` (`objectOp`, `recordUndo` for `pull-out`).
- Update, on purpose (decision 5): `agent-loop.test.ts`'s expected joints line and new lines; `agent-joint-tools.test.ts` "joins two parts of one object that already touch" now expects one `pull-out` object change and a joint between two objects. If any other existing unit test needs a change, stop and report.
- New `tests/e2e/pull-out.spec.ts`: a routed `/api/agent` stream with `tool`, `result` and `state` frames for `pull_out_part` on the demo's `battery`: `data-object-count` becomes 2, the message 代理已把「側邊電池」拉出成新物件，可按「復原」回到上一步。 shows, the new object sits to the right of the original (`data-object-json`), and 復原 restores one object.
- E2E: run `pull-out`, `agent-panel`, `workspace` and `joints` specs. The full suite is not needed (one message branch in `App.tsx`).

**Dependencies:** Task 1.

**Done when:** `npm run check` passes, the tests above are green, the four e2e specs pass, and the report lists the tool count (expected 16) and the changed instruction lines.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `shared/agent.ts`, `server/agent.ts`, `server/tools/index.ts`, `server/tools/create-joint.ts`, `src/agent/apply-state.ts` and `src/App.tsx` are shared: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`). Never download MediaPipe models in tests.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Only one session runs Playwright at a time: if the ports are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`. Do not add dependencies.
- The server never logs prompts, tool arguments or provider output; error texts returned to the model or the client are fixed Traditional Chinese strings without Zod text.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(agent): pull a part out and join parts of one object (spec workbench-ui, task 2)`).
- User-facing strings are Traditional Chinese; code, comments, model-facing descriptions and reports are English.

**Requirements:** 50 (agent), 56, 57, 74 (pull-out and joints lines), 75–77, 80.

---

## Task 3 — The full-screen workbench: HUD, docks, status bar and panel model

`[ ]`

The camera video and the scene fill the window; the HUD and the status bar stay visible; every panel lives in a dock and opens when needed; the scene is framed in the free area; exactly one 載入示範模型 is on screen. Today's part list moves unchanged into the bottom zone (Task 4 turns it into the tray). Every existing e2e test passes.

**Read first:** `src/App.tsx` (all of it: the state, `loadDemo`, the key handler, the JSX from line 766 to the end); `src/styles.css` (the layout rules: `.app-shell`, `.topbar`, `.workspace` and its media queries, `.viewport`, `.camera-video`, `.hand-overlay`, `.viewport-shade`, `.stage-*`, `.empty-scene`, `.model-caption`, `.control-column`, `.panel`, `.demo-link`, the sticky mouse-join rule, `prefers-reduced-motion`); `src/scene/SceneViewport.tsx` (`fit()`, the `ResizeObserver`, `setPixelRatio`, the `SceneHandle` methods); `src/agent/AgentPanel.tsx`; `src/workspace/ObjectPanel.tsx`; `src/joints/JointPanel.tsx`, `JointCard.tsx`, `PrinterPanel.tsx`; `src/export/ExportDialog.tsx`; `src/hands/HandOverlay.tsx`, `HandDebugPanel.tsx`, `useHandControl.ts` (how the video rectangle maps the hands); `tests/e2e/workbench.spec.ts`, `workspace.spec.ts`, `edit-select.spec.ts` (lines 44–55), `joints.spec.ts` (lines 25–85 and 206–230, 310–335), `agent-panel.spec.ts`, `hand-control.spec.ts` (`emptyPoint`, line 366), `visual-backgrounds.spec.ts`; `playwright.config.ts` (viewport 1440 × 1000); design §5, §11 (T3), §12, §15; requirements 1–25, 78, 79, 81–86, 89.

**Build** (pure modules first, then the wiring):
- `src/workbench/text.ts`: every string of the files below (decision 13), grouped by component (`HUD_TEXT`, `PANEL_TITLES`, `CLOSE_LABELS`, `STATUS_TEXT`, `START_TEXT`, `CREATE_TEXT`, `PART_TEXT`, `DETAILS_TEXT`), texts copied exactly from today's JSX.
- `src/workbench/panels.ts` (design §5.2) and `src/workbench/zones.ts` (`Rect`, `ZoneRects`, `freeArea`, `viewOffsetFor`, design §5.1).
- `src/workbench/DockPanel.tsx`, `Hud.tsx`, `ObjectCaption.tsx`, `StatusBar.tsx`, `StartMessage.tsx`, `CreatePanel.tsx`, `PartPanel.tsx`, `DetailsPanel.tsx`, `PartList.tsx` (design §5.3–§5.8). They take props only; state and handlers stay in `App`.
- `src/agent/AgentPanel.tsx`: `expanded` and `onToggle` (design §5.4); names and test ids unchanged.
- `src/joints/PrinterPanel.tsx`: the root becomes a `<div>` with the same `aria-label` and `data-testid`; the fields always show (design §5.4).
- `src/workspace/ObjectPanel.tsx`, `src/joints/JointPanel.tsx`: no change in markup; they are wrapped by `DockPanel` in `App` (edit them only if the wrapping needs a prop).
- `src/scene/SceneViewport.tsx`: the `framingArea` prop, the view offset and the free-area FOVs in `fit()`, `FULLSCREEN_MAX_PIXEL_RATIO` and `?pixel-ratio` (design §5.6). Nothing else in this file.
- `src/App.tsx`: the structure of design §5.1; the panel reducer and the context effect (§5.2); toggles, close buttons, focus requests; the Esc and `/` keys (§5.4); closing 接合 cancels a mouse join (R21); the demo button rule (R25); `framingArea` from `freeArea(zoneRectsFromDom())`.
- `src/styles.css`: the zone variables and rules of design §5.1; remove the old two-column, topbar, stage-label, stage-footer, stage-note, footer and sticky mouse-join rules; keep every class the moved JSX still uses.

**Tests:**
- New `tests/unit/workbench-panels.test.ts` and `tests/unit/workbench-zones.test.ts`: design §11 (T3).
- New `tests/e2e/workbench-helpers.ts`: `openPanel(page, title)` (presses the toggle when its `aria-expanded` is not `true`) and `freeEmptyPoint(page)` (a point in the free area where `hitTest` finds nothing).
- New `tests/e2e/workbench-layout.spec.ts`: design §11 (T3).
- Update existing e2e specs only as listed in design §11 (selectors and panel opening through `openPanel`, the empty-space click through `freeEmptyPoint`, the sticky-canvas test rewritten). Behaviour assertions do not change. If another existing test needs a change, make only a selector or panel-opening change and list it in the report; if a behaviour assertion would have to change, stop and report.
- `npm run build`: report the main chunk size before and after.
- E2E: develop with the specs of design §11 (T3); run the full suite once at the end.

**Dependencies:** Tasks 1 and 2 (Task 2 edited `applyAgentWorkspace` in `App.tsx`; keep that branch).

**Done when:** `npm run check` passes, the new unit tests are green, the full e2e suite passes, and the report gives: the list of edited existing e2e files with one line per change, the chunk sizes, a screenshot of the workbench with the demo loaded and two panels open (attached from the e2e run), and how to try it: `npm run dev`, 載入示範模型, open and close each panel, press `/`, resize the window to 390 px wide.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/App.tsx`, `src/styles.css`, `src/scene/SceneViewport.tsx`, `src/agent/AgentPanel.tsx`, `src/joints/PrinterPanel.tsx` and the existing e2e specs are shared: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- This task moves JSX; it does not change behaviour. Keep every handler and every piece of state in `App`. Keep every accessible name, label, role and `data-testid` exactly (R79).
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers or MediaPipe models.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Only one session runs Playwright at a time: if the ports are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- Run single spec files while developing. Run the full suite (about 25 minutes) once at the end: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-workbench-task3.log`), give it a timeout of at least 40 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests; e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`. Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time. Never drop or simplify a requirement on your own; only the user decides cuts.
- Do not commit; the reviewer commits (suggested message: `feat(ui): full-screen workbench with docks and a status bar (spec workbench-ui, task 3)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

**Requirements:** 1–16, 18 (panel model), 19–25, 78 (layout rows), 79, 81, 82, 83 (pixel ratio), 84, 85 (layout), 86, 89.

---

## Task 4 — The parts tray with the mouse and keyboard

`[ ]`

The bottom zone becomes the parts tray: cards, selection, keyboard, sideways scrolling, dragging a card into the scene to pull the part out, 拉出成新物件 in the 零件 panel, the mouse join of two parts of one object, and the export dialog's scope line.

**Read first:** Task 1's `shared/pull-out.ts`; Task 3's `src/workbench/` files (`PartList.tsx`, `PartPanel.tsx`, `zones.ts`, `text.ts`, `panels.ts`); in `src/App.tsx`: `pick`, `selectInActive`, `confirmMouseJoin`, `stepMouseJoin`, `commitObjectChange`, the key handler; `src/joints/mouse-join.ts`, `src/joints/labels.ts` (`JOINT_NOTICES`); `src/workspace/app-rules.ts` (`pickPart`); `src/export/dialog-model.ts`, `ExportDialog.tsx`, `shared/export-plan.ts` (`scopeWorkspace`); `tests/e2e/edit-select.spec.ts`, `joints.spec.ts`, `agent-panel.spec.ts` (`partListButtons`), `export.spec.ts`; design §6, §11 (T4); requirements 27–35, 38, 50, 54, 58, 60, 85.

**Build:**
- `src/workbench/tray-model.ts` (design §6.1), `src/workbench/card-drag.ts` (§6.3), `src/workbench/primitive-icons.tsx` (`PRIMITIVE_ICONS`, a `Record` over `Part['primitive']`, inline SVG), `inDropZone` in `src/workbench/zones.ts`.
- `src/workbench/PartsTray.tsx` (design §6.2–§6.3), replacing `PartList.tsx` (delete `PartList.tsx`).
- `src/workbench/PartPanel.tsx`: 拉出成新物件 with exactly one part selected, disabled with the reason (R32).
- `src/workbench/text.ts`: the tray, drag and pull-out strings of R31–R35.
- `src/App.tsx`: `pullOut(partId)` and the messages (design §6.4); `confirmMouseJoin` for two parts of one object (§6.4); the tray in place of `PartList`.
- `src/export/dialog-model.ts`: `outsideAssembly`; `src/export/ExportDialog.tsx`: the info line (design §6.5).
- `src/styles.css`: tray, card, ghost and scroll-button styles (cards at least `TRAY_CARD_MIN`, the selected outline and check mark, the ghost's return transition, off under `prefers-reduced-motion`).

**Tests:**
- New `tests/unit/parts-tray.test.ts`: design §11 (T4). Extend `tests/unit/export-dialog.test.ts` with `outsideAssembly`.
- New `tests/e2e/parts-tray.spec.ts`: design §11 (T4). Drag with `page.mouse` (down on a card's box centre, `move` in steps to a free-area point, `up`); read the result from `data-object-count` and `data-object-json`.
- Existing e2e specs keep passing; the tray keeps the list name 零件清單 and names that start with the part name, so no selector should need a change. Report any change.
- E2E: develop with the specs of design §11 (T4); run the full suite once at the end.

**Dependencies:** Task 3.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and the report says how to try it: `npm run dev`, 載入示範模型, drag 側邊電池 up into the scene, 復原, select 鏡筒 1 and press 拉出成新物件, join two parts of one object with 新增接合.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/App.tsx`, `src/styles.css`, `src/export/dialog-model.ts`, `src/export/ExportDialog.tsx` and `tests/unit/export-dialog.test.ts` are shared: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- No React render per pointer move: move the ghost through its element's style; render only when a drag starts and ends.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers or MediaPipe models.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Only one session runs Playwright at a time: if the ports are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- Run single spec files while developing. Run the full suite once at the end in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-workbench-task4.log`), with a timeout of at least 40 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests; e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`. Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time. Never drop or simplify a requirement on your own.
- Do not commit; the reviewer commits (suggested message: `feat(ui): parts tray with drag to pull a part out (spec workbench-ui, task 4)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

**Requirements:** 27–35, 38 (sizes), 50 (mouse), 54, 58, 60, 85 (SC 2.5.7, 2.5.8).

---

## Task 5 — The parts tray by hand, and pinch taps on the HUD

`[ ]`

On-screen targets become real: the HUD toggles, the demo button, the tray cards and the tray scroll buttons register with one registry. A pinch tap presses them; a pinch drag that starts on a tray card carries it into the scene and pulls the part out.

**Read first:** `src/hands/types.ts` (`Target`, `ScreenTarget`, `GestureKind`), `targets.ts` (`pickTarget`, `settleStep`), `decide.ts` (`decidePinch`), `gate.ts` (`fistAllowed`), `join.ts` (`joinGesture`), `controller.ts` (`HandPort`, `Session`, `onEngage`, `onDragStart`, `onRelease`, `finishOnRelease`, `updateFreeze`, the loss handling, `reset`), `useHandControl.ts` (the port, `press: () => { /* no on-screen targets yet */ }`), `text.ts` (`badgeText`), `constants.ts`; `.kiro/specs/hand-manipulation/requirements.md` requirements 22, 23, 27–29, 37, 39, 81 and design §5 (gestures and the controller), §16 (the Task 10 freeze on opening); Task 4's `PartsTray.tsx`, `card-drag.ts`, `zones.ts`; Task 3's `Hud.tsx`, `StartMessage.tsx`; `tests/unit/hand-assemble.test.ts` (how the controller is driven with a fake port), `tests/fixtures/synthetic-hand.ts`; `tests/e2e/fake-hands.ts`, `hand-control.spec.ts` (`openCamera`, `framesAbove`, `dragBy`), `assembly-hands.spec.ts`; design §7, §11 (T5); requirements 17, 26, 36–38, 59.

**Build:**
- `src/workbench/screen-targets.ts` (design §7.1).
- `src/hands/types.ts`: `ScreenTarget.disabled?`, `ScreenTarget.draggable?`, `GestureKind` `'carry'`; `src/hands/controller.ts`: the carry of design §7.2; `src/hands/useHandControl.ts`: the `screen` input (design §7.3); `src/hands/text.ts`: the carry badges; `src/hands/constants.ts`: nothing new unless a constant is needed (name it and say why).
- `src/workbench/PartsTray.tsx`: register the cards (draggable, with `carry`) and the scroll buttons; the ghost follows a carry as it follows the mouse.
- `src/workbench/Hud.tsx`, `StartMessage.tsx`: register the toggles and the demo button.
- `src/App.tsx`: pass `screen: screenTargets` to `useHandControl`. No other change.
- `src/styles.css`: only if the hand hover on a card needs a style (a ring around the hovered card).

**Tests:**
- New `tests/unit/hand-tray.test.ts`: design §11 (T5).
- Existing hand unit tests (`hand-controller.test.ts`, `hand-assemble.test.ts`, `hand-drag.test.ts`, `hand-fist.test.ts`, `hand-gate.test.ts`, `hand-input.test.ts`, `hand-sessions.test.ts`) pass unchanged; if one needs a change, stop and report.
- New `tests/e2e/hand-tray.spec.ts`: design §11 (T5), with `installFakeHands`, `handsUrl()` and `showHands` from `fake-hands.ts`.
- E2E: develop with `hand-tray`, `hand-control` and `assembly-hands`; run the full suite once at the end.

**Dependencies:** Task 4.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, `git diff --stat tests/e2e/hand-control.spec.ts tests/e2e/assembly-hands.spec.ts` is empty, and the report hands the user the webcam steps 6 and 7 of the manual check below (they need the real camera).

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/hands/*`, `src/App.tsx` and `src/styles.css` are shared: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- No React render per tracking frame (HM rule): the carry moves the ghost through its element's style; the registry reads element rectangles from its cache.
- HM R27 stays for every target that is not draggable: a drag that starts on it does nothing.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (without the GPU the fake camera drops to 1–2 fps and hand gestures time out). Never download browsers or MediaPipe models; `installFakeHands` replaces the worker.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Only one session runs Playwright at a time: if the ports are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- Run single spec files while developing. Run the full suite once at the end in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-workbench-task5.log`), with a timeout of at least 40 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests. Never run `verify:real` or `verify:edit`. Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time. Never drop or simplify a requirement on your own.
- Do not commit; the reviewer commits (suggested message: `feat(hands): pull a part out of the tray by pinching (spec workbench-ui, task 5)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

**Requirements:** 17, 26, 36, 37, 38 (tuning constants), 59.

---

## Task 6 — Data cards, `show_panel` and `data_card`

`[ ]`

The agent can open and close panels and place data cards on the camera view: a part's size, a distance between two parts, a joint's state. The values are computed locally and follow the scene. The agent sees which panels and cards are open.

**Read first:** `shared/agent.ts` (`StateChangeSchema`, `AgentRequestSchema`, `validateAgentRequest`); `server/tools/helpers.ts` (`checkedChange`), `set-camera-image.ts` and `prepare-export.ts` (tools with a session-state change), `index.ts`; `server/agent.ts` (`AGENT_INSTRUCTIONS`, `workspaceSnapshot`); `src/agent/apply-state.ts`, `useAgentRun.ts`, `request.ts`; `shared/bounds.ts`, `shared/assembly.ts` (`objectMatrix`); `shared/joint-rules.ts` (`checkJoints`); `src/joints/labels.ts` (`methodSummary`), `card-model.ts` (`jointState`); `src/scene/SceneViewport.tsx` (`projectPart`, `projectFace`, the animation loop); Task 3's `zones.ts` and `panels.ts`; `tests/unit/tool-registry.test.ts`, `apply-state.test.ts`, `agent-loop.test.ts`; `tests/e2e/agent-panel.spec.ts` (routed streams); design §8, §11 (T6); requirements 18, 61–74.

**Build:**
- `shared/workbench.ts` and `shared/measure.ts` (design §8.1–§8.2).
- `shared/agent.ts`: `StateChange.panel`, `StateChange.dataCard`, `AgentRequest.ui`, the detail schemas of the two tools.
- `server/tools/show-panel.ts`, `server/tools/data-card.ts` (design §8.3), each with a `TEXT` constant; registered last in `server/tools/index.ts`; `server/tools/helpers.ts`: `checkedChange` strips `panel` and `dataCard`; `server/agent.ts`: the instruction lines and the `ui` lines of `workspaceSnapshot`.
- `src/agent/apply-state.ts`, `useAgentRun.ts`, `request.ts`: the effects, options and `RunSnapshot.ui` (design §8.1).
- `src/workbench/data-cards/kinds.ts`, `placement.ts`, `DataCardLayer.tsx` (design §8.4); card strings in `src/workbench/text.ts`.
- `src/scene/SceneViewport.tsx`: `SceneHandle.onRendered` and `SceneHandle.anchorPoint` (additive). Nothing else in this file.
- `src/App.tsx`: the `cards` state, `applyDataCard`, `setPanel` (through the panel reducer's `open` and `close`), the layer, `ui` in `getSnapshot`.
- `src/styles.css`: card and leader-line styles.

**Tests:**
- New `tests/unit/data-cards.test.ts` and `tests/unit/workbench-agent.test.ts`: design §11 (T6).
- Extend `tool-registry.test.ts` (two tools, labels, effects), `apply-state.test.ts` (`panel`, `dataCard`, old payloads), `agent-loop.test.ts` (instruction lines and the snapshot lines).
- New `tests/e2e/data-cards.spec.ts`: design §11 (T6).
- E2E: develop with `data-cards`, `agent-panel` and `export`; run the full suite once at the end.

**Dependencies:** Task 3 (zones, panels). Task 5 is not required, but run after it because both edit `App.tsx` and `styles.css`.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and the report lists the tool count (expected 18), shows the summary text of one `data_card` call for the demo's `battery`, and attaches a screenshot of two cards from the e2e run.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `shared/agent.ts`, `server/agent.ts`, `server/tools/index.ts`, `server/tools/helpers.ts`, `src/agent/*`, `src/scene/SceneViewport.tsx`, `src/App.tsx` and `src/styles.css` are shared: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- Card values are computed from the workspace; never put model text into a card. No React render per scene frame: positions are written to the elements after each render.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers or MediaPipe models.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Only one session runs Playwright at a time: if the ports are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- Run single spec files while developing. Run the full suite once at the end in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-workbench-task6.log`), with a timeout of at least 40 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`. Do not add dependencies.
- The server never logs prompts, tool arguments or provider output; error texts returned to the model or the client are fixed Traditional Chinese strings without Zod text.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time. Never drop or simplify a requirement on your own.
- Do not commit; the reviewer commits (suggested message: `feat(agent): data cards on the camera view and panel control (spec workbench-ui, task 6)`).
- User-facing strings are Traditional Chinese; code, comments, model-facing descriptions and reports are English.

**Requirements:** 18, 61–73, 74 (panel and card lines).

---

## Task 7 — Reachability, measurements, README and the manual check

`[ ]`

One e2e spec proves that every feature of the inventory (R78) is reachable; the README describes the new workbench; the task ends with the measurements and the manual check on the user's machine.

**Read first:** requirements 78–84, 91 and the inventory table of R78; design §9, §11 (T7); every `src/workbench/` file; `tests/e2e/workbench-helpers.ts`; `README.md` (the "Hand control", "Assembly joints" and "Export" sections); Task 3's and Task 6's reports (chunk sizes, timings).

**Build:**
- `README.md` (R91, design §9): the usage sections follow the new layout. Keep the install and run instructions unchanged.
- Nothing else unless the reachability spec finds a control that cannot be reached; then fix only that, in the file that hides it, and list it in the report.

**Tests:**
- New `tests/e2e/reachability.spec.ts`: design §9.
- `npm run build`: report the chunk sizes against Task 3's report.
- E2E: run `reachability`, then the full suite once at the end.

**Dependencies:** Tasks 1–6.

**Done when:** `npm run check` passes, the reachability spec and the full e2e suite pass, the README reads correctly for a first-time user (the reviewer reads it), and the report hands the user the manual check below.

### Manual check (user's machine)

Run `npm run dev` in a maximised browser window. Note the display scaling of the laptop (Windows Settings → Display → Scale), because it sets `devicePixelRatio`.

1. **First look.** The camera image and the scene fill the window; the HUD at the top, the agent bar at the bottom left, the status bar above the tray. Nothing scrolls. 生成與修改 is open.
2. **Demo entry.** 載入示範模型 in the middle; after loading, the same button sits in the HUD toolbar with 非 AI 生成, and there is only one.
3. **Panels.** Open and close each panel with its HUD toggle and its close button; Tab through the HUD; press Esc on a panel button; press `/` and type into 任務指示. Load the demo twice: 物件 and 接合 open by themselves. Select a part: 零件 opens; Esc clears the selection and it closes.
4. **Tray with the mouse.** Click cards, Shift-click, use ← → Home End and Enter. Drag 側邊電池 up into the scene: a new object 側邊電池 appears beside the original; 復原 brings it back; 重做 again. Drag a card and release it over the tray: nothing changes. Select 鏡筒 1, press 拉出成新物件.
5. **Joints connect objects.** Pull 側邊電池 out, then join it to 外殼 with two pinches (or 新增接合). Remove the joint with 刪除接合 on its card: the two objects stay separate and do not merge. Join two parts of one object with 新增接合: one of them becomes its own object, and the joint card opens.
6. **Hands at the edges** (`?hands=debug&hands-min-fps=5`). Turn the camera on. Point at a card at the left, the middle and the right of the tray; pinch-tap each one five times and note how many selected the part. Pinch a card and pull it up into the scene five times; note the successes and whether the hand was lost near the bottom edge. Pinch-tap three HUD toggles and 載入示範模型. If cards are hard to reach, note which `TRAY_BOTTOM_GAP_PX` or card size would help.
7. **Speed.** With `?hands=debug`, note the tracking rate (每秒幀數) and the recognition time for one minute of two-hand gestures with the demo loaded, once with the default URL, once with `&pixel-ratio=1` and once with `&pixel-ratio=2`. Note whether orbiting and dragging feel smooth in each.
8. **Data cards and panels with the real agent** (uses model quota; your own action). Ask 「顯示側邊電池的尺寸」, 「量一下兩個鏡筒的距離」, 「把列印設定打開」, 「把資料卡都關掉」. The cards appear next to their parts and follow when you turn the view; the numbers in the reply match the cards.
9. **Pull-out with the real agent.** Ask 「把側邊電池拉出來，改成 PETG」 and then 「把電池和外殼用 M3 螺絲接起來」. The agent pulls the part out, sets the material, creates the joint, and asks about the load.
10. **Export after a pull-out.** 匯出套件 with 目前物件的組合件 while one pulled-out part is not joined: the line 不在這個組合件中的物件不會匯出：… names it. With 整個工作區, the BOM lists the pulled-out part under its own name.
11. **Narrow window.** Make the window about 400 px wide: the panels become one sheet at the bottom; nothing scrolls sideways.

**Report:** the display scaling; the hit counts of step 6 and any constant you would change; the rates of step 7 for the three pixel ratios; whether the agent's numbers matched the cards; anything that was hard to find.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `README.md` is shared with every spec: check `git status --short README.md` before the first edit and stop and ask if it shows changes.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers or MediaPipe models.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Only one session runs Playwright at a time: if the ports are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- Run the full suite once at the end in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-workbench-task7.log`), with a timeout of at least 40 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests. Never run `verify:real` or `verify:edit`; the manual check's agent steps are the user's own action. Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `docs(readme): describe the full-screen workbench and the parts tray (spec workbench-ui, task 7)`).
- README and reports are English; user-facing strings quoted in them stay Traditional Chinese.

**Requirements:** 78 (audit), 82, 83 (manual), 84, 91.

---

## Priorities, for a cut decision by the user

**Only the user decides whether anything is cut.** A Kiro session never drops or simplifies a requirement on its own, also not to save time: it reports the problem, and the reviewer asks the user. For that decision, the priorities of `requirements.md` are: P0 is Tasks 1–4 except R10, R54 and R84, plus Task 5's carry and reach (R36, R38, R59) and Task 7's audit and README; P1 is the pinch taps on the HUD, the demo button and the scroll buttons (Task 5: R17, R26, R37), all of Task 6, the export scope line (Task 4: R54), the decorative clean-up (Task 3: R10) and the size report (R84). Decision 16 in `requirements.md` gives the schedule evidence.

## Requirement-to-task map

| Requirements | Task |
|---|---|
| 1–16, 19–25, 79, 81, 86, 89 | 3 |
| 17, 26, 36, 37, 59 | 5 |
| 18 | 3 (panel model), 6 (tool) |
| 27–35, 54, 58, 60 | 4 |
| 38 | 4 (sizes), 5 (tuning) |
| 39–49, 51–53, 55 | 1 |
| 50 | 1 (`splitForJoin`), 2 (agent), 4 (mouse) |
| 56, 57, 75–77, 80 | 2 |
| 61–73 | 6 |
| 74 | 2 (pull-out and joint lines), 6 (panel and card lines) |
| 78 | 3 (layout), 7 (audit) |
| 82 | 3–7 |
| 83 | 1 (timing), 3 (pixel ratio), 7 (manual) |
| 84 | 3, 7 |
| 85 | 3, 4 |
| 87, 88, 90, 92 | every task |
| 91 | 7 |
