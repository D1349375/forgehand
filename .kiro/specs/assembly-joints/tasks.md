# Assembly joints — Tasks

Implementation order is **1 → 6**. Tasks 1–3 are pure code in `shared/` and `src/print/`: the data, the geometry rules, then the checks, the kit and the printable geometry. After Task 3 the `export` spec can start, because everything it calls exists (requirements 67–71). Task 4 adds the browser paths (scene marks, mouse join, panels), Task 5 the agent tools, and Task 6 the two-hand join, which waits for `hand-manipulation` Task 7. Requirement numbers refer to `requirements.md` (stable ids; 84–88 were added in review); section numbers (§) refer to `design.md`. Each task is meant for one fresh Kiro session that starts without memory, so each one lists what to read first and repeats the session facts.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

---

## Task 1 — Joint data, workspace v2 and assemblies

`[x]`

Joints and materials become workspace data with a migration from version 1, and `setTransform` moves whole assemblies. Pure code only; nothing changes on screen.

**Read first:** `shared/workspace.ts` (all of it: schemas, `assertWorkspace`, `validateWorkspace`, every operation, `ObjectChangeSchema`, `WorkspaceChangeSchema`, `applyWorkspaceChange`); `shared/model.ts` (`PartSchema`, `PartIdSchema`); `shared/bounds.ts` (`worldMatrices`); `shared/agent.ts` (`StateChangeSchema` spreads `WorkspaceChangeSchema.shape`); `src/workspace/store.ts`; `tests/unit/workspace.test.ts`, `workspace-ops.test.ts`, `workspace-store.test.ts` (fixture style); design §1, §2, §3, §11, §15; requirements 1–9, 11, 14–18, 21, 65, 70, 73, 75, 84–86.

**Build:**
- `shared/ids.ts`: move `ObjectIdSchema` here; `shared/workspace.ts` re-exports it so every existing import keeps working.
- `shared/materials.ts` (design §3.1, §3.8): `MaterialIdSchema`, `Rating`, `MATERIALS` with the table of §3.8.
- `shared/standard-parts.ts` (design §3.1, §3.9): `ThreadSchema`, `MagnetIdSchema`, `PinIdSchema`, `GlueIdSchema`, `INSERTS`, `SCREWS`, `MAGNETS`, `PINS`, `GLUES` with the values of requirement 15. Put the source (standard or datasheet URL) in a comment next to every number. If the CNC Kitchen M2×3 outer diameter cannot be read from its datasheet, use the value from its product page and mark it `// verify`.
- `shared/printer.ts` (design §3.1, §3.10): `PrinterProfileSchema`, `DEFAULT_PRINTER_PROFILE`, `Fit`, `printedDiameter`, `printedDepth`.
- `shared/joint.ts` (design §3.1): `FaceIdSchema`, `JointSideSchema`, `JointMethodSchema`, `JointNeedsSchema`, `JointSchema`, `MAX_JOINTS`, `FaceShape`, `CONTACT_FACES`, `faceShape`, `faceAllows`, and the Traditional Chinese face labels of requirement 21 (`FACE_LABELS`).
- `shared/assembly.ts` (design §3.4): `assemblyOf`, `objectMatrix`, `moveRigid`. Import the `Workspace` type only.
- `shared/workspace.ts` (design §3.2–§3.6): `WORKSPACE_VERSION = 2`; `SceneObjectSchema.material` with `.default(null)`; `WorkspaceSchema.joints`; `migrateWorkspace`; `validateWorkspace` migrates first; `createObject` sets `material: null`; `emptyWorkspace` has `joints: []`; the joint rules in `assertWorkspace`; the error codes `JOINT_LIMIT`, `UNKNOWN_JOINT`, `INVALID_JOINT` with the messages of §3.3 (Task 2 adds `CANNOT_ALIGN` and `LINKED`); `setTransform` through `moveRigid` over `assemblyOf`; the cascades in `removeObject` and `replaceModel`; `setMaterial`, `addJoint`, `updateJoint`, `removeJoint`, `joinObjects`, `jointsRemovedBy`; `ObjectChange` op `material`; `JointChangeSchema`; `WorkspaceChangeSchema.joint` (nullable, optional); `applyWorkspaceChange` order activation, object, joint, selection, explode.
- `src/workspace/store.ts` (design §3.7): `Snapshot` gains `joints`; `snapshotOf` and `restoreSnapshot` carry it.
- `tests/fixtures/joint-workspace.ts` (design §11): builders for two boxes side by side, a rotated pair, a box on a cylinder cap and a demo pair (two `demoModel` objects placed with `placeBeside`), each with or without a joint.
- Existing unit-test fixtures typed as `Workspace` or `SceneObject`: add `joints: []` and `material: null` (requirement 73). Change nothing else in existing tests.

**Tests:**
- New `tests/unit/joint-data.test.ts`: every standard-part number pinned; `printedDiameter` and `printedDepth` (each fit class, PETG extra, rounding); `faceShape` and `faceAllows` for every primitive; schema round trips; `migrateWorkspace` (version 1 → 2 with `joints: []` and `material: null`; version 2 unchanged; version 3 rejected by `validateWorkspace`); an `add` object without `material` parses with `null`; every `assertWorkspace` joint rule (limit, duplicate ids, unknown object or part, a sphere face, glue-only ring with a screw joint, same side twice, duplicate side pairs); each operation (returns the same reference when nothing changes, never mutates, `JOINT_LIMIT`, `UNKNOWN_JOINT`, `updateJoint` keeps the sides); cascades (`removeObject`, `replaceModel` removing a part, changing a box to a sphere, a dimension change keeps the joint) and `jointsRemovedBy`; `assemblyOf` (chains, a cycle, a same-object joint links nothing, `skipJointId`); `setTransform` on an assembly: a position change moves every member by the same offset and keeps their rotation objects by reference; a rotation rotates the members about the moved object; a member leaving the limits throws `INVALID_WORKSPACE` and nothing moves; the **drift test** of design §3.4 with a local plane-gap helper; `joinObjects` is one result; `applyWorkspaceChange` with a `material` op and each `joint` op; a `transform` op moves the assembly.
- `tests/unit/workspace-store.test.ts` (extend): undo and redo restore `joints`; a join is one undo step.
- E2E: none new. Run `workspace.spec.ts` and `agent-panel.spec.ts` once to confirm old `state` frames still apply, then the full suite.

**Dependencies:** none.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes with no change to any e2e file, and the report lists every standard-part number with its source for the reviewer, plus any value marked `// verify`.

**Session facts:**
- Start from a clean tree. Other specs run in parallel in this repo; if `git status` shows uncommitted changes you did not make, stop and ask before editing.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of the task: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-joints-task1.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- Do not add dependencies. Only Task 3 installs one (`manifold-3d`).
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(joints): add joint data, workspace v2 and assemblies (spec assembly-joints, task 1)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 2 — Contact, snapping and joint features

`[x]`

The pure geometry: which faces touch, which faces face each other, how side b is aligned, a stable snap state for live use, re-alignment, and every hole, pocket and boss a joint needs.

**Read first:** Task 1's modules (`shared/joint.ts`, `assembly.ts`, `printer.ts`, `standard-parts.ts`, `materials.ts`, the joint parts of `workspace.ts`); `shared/bounds.ts`; `src/scene/geometry.ts` (`createPartGeometry`: how each primitive is oriented and scaled; contact faces must match it); `tests/fixtures/joint-workspace.ts`; design §4, §5, §11; requirements 5, 12, 13, 22–38, 76, 88.

**Build:**
- `shared/joint-constants.ts` (design §4.7): every constant with its default, exported by name.
- `shared/contact.ts` (design §4.1–§4.6): `localFace`, `worldFace` (part matrices cached per model in a `WeakMap`), `facePolygon`, `contactRegion` (projection and Sutherland–Hodgman clipping; ring = outer minus inner), `touching`, `PairMetrics`, `facingPairs`, `snapCandidates`, `measurePair`, `alignTransform`, `SnapState`, `initialSnapState`, `snapStep`, `JoinPlan`, `planJoin`, `realignJoint`. Add `CANNOT_ALIGN` and `LINKED` to `WorkspaceErrorCode` with the messages of §4.6.
- `shared/features.ts` (design §5): `FeatureKind`, `JointFeature`, `JointDerived`, `FeatureProblem`, `JointFeatureSet`, `FeatureSet`, `partThickness`, `layoutPositions`, `featuresForJoint`, `jointFeatures`, and the collision pass of §5.5 (it records `OVERLAP` problems for Task 3's findings).
- `tests/unit/joint-data.test.ts`: switch the drift test from its local helper to `touching`.

**Tests:**
- New `tests/unit/joint-contact.test.ts`: `localFace` for every primitive and face matches the display geometry's bounding box (build it with `createPartGeometry` in Node); world faces under a rotated parent and a rotated object; `contactRegion` for two offset rectangles (area by hand), a disc on a rectangle, a ring; `touching` at the angle, gap and area limits; `facingPairs` ranks the demo pair's battery `+x` / housing `-x` first and needs each face in front of the other; `snapCandidates` inside and outside the engage limits, and its tie-break; `alignTransform` for a 10° misaligned pair (normals exactly opposite after rounding, `touching` holds, side a unchanged, the centre snap below `CENTRE_SNAP_MM` only); `snapStep` (settle, restart on another pair, release by gap and by angle, a rival taking over after `SNAP_SETTLE_MS`); `planJoin` (faces given, faces ranked, `pairIndex`, same object or same assembly needs touching, `CANNOT_ALIGN`, `NO_CONTACT_FACE`); `realignJoint` (moves b's side only, `LINKED` for a cycle, `CANNOT_ALIGN`); the worst-case timing bound of §4.3 (two 64-part objects under 25 ms).
- New `tests/unit/joint-features.test.ts`: layout for 1–4 positions in a long and a square region, the edge margin and spacing rules, `NO_ROOM`; positions mirrored onto side b in its own part frame (a rotated b); screws with inserts: hole sizes from the profile, the tail blind or through, the counterbore and the clamp, a boss on a thin insert side, M3 and M2 screw lengths (8 and 5 mm with the defaults), `NO_LENGTH`, a metal insert side (tapped hole, no insert), a component screw side (no features, clamp = its thickness), a component insert side (`COMPONENT_FEATURE`); magnets (pockets on both sides, `TOO_THIN`); pins (length rule, press and sliding sides, `NO_LENGTH`); glue (no features, contact area); a cone base thinner away from its axis; `APART` keeps the layout; two joints on one part that collide give `OVERLAP`; the same input twice gives equal output.
- E2E: none.

**Dependencies:** Task 1.

**Done when:** `npm run check` passes and the tests above are green.

**Session facts:**
- Start from a clean tree. Other specs run in parallel in this repo; if `git status` shows uncommitted changes you did not make, stop and ask before editing.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests. Never run `verify:real` or `verify:edit`.
- Do not add dependencies. Only Task 3 installs one (`manifold-3d`).
- Everything in this task is pure and lives in `shared/`: Three.js math classes only, no DOM, no renderer, no React.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(joints): add contact, snapping and joint features (spec assembly-joints, task 2)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 3 — Checks, recommendations, the kit and printable parts

`[x]`

Findings and recommendations for every joint, the BOM and assembly notes, and the printable solid of a part with its features cut, using `manifold-3d`. **This task starts with a spike.** After it, the `export` spec can start.

**Read first:** Task 2's `shared/features.ts` and `shared/contact.ts` (their exports); `shared/materials.ts`, `standard-parts.ts`, `printer.ts`; `shared/bounds.ts` (`partBoxes`); `src/scene/geometry.ts` (`createPartGeometry` proportions); `vite.config.ts`, `vitest.config.ts`, `package.json`; design §6, §7, §13; requirements 18, 39–46, 67–69, 71, 77, 78, 82.

**Build:**
- **Spike first** (design §7.1), before any other code, in the order given there: install `manifold-3d@3.2.1` with `--save-exact` and confirm no other package is added; load it in a Vitest file in Node and compute a cube minus a cylinder; load it in the browser through a dynamic import with the `?url` wasm; run `npm run build` and confirm the wasm is an asset and manifold's JS is not in the main chunk. Report the API names found in 3.2.1 and the sizes. If a step fails after two or three attempts, stop and report; do not switch libraries.
- `shared/joint-rules.ts` (design §6.1, §6.2): `Finding`, `FindingCode`, the message table, `checkJoints`, `Recommendation`, `recommendFor`, `recommendJoint`, `newJoint`.
- `shared/kit.ts` (design §6.3, §6.4): `BomItem`, `jointBom`, `assemblyNotes`; re-export `assemblyOf`, `jointFeatures`, `checkJoints` so `export` imports one module.
- `src/print/manifold.ts` (design §7.1): `loadManifold()`, cached; `locateFile` with the `?url` wasm only in the browser.
- `src/print/printable.ts` (design §7.2–§7.4): `PrintableMesh`, `PrintableResult`, `printablePart`, `toBufferGeometry`; every Manifold object deleted in a `finally`.
- `README.md`: a credits line for manifold-3d (Apache-2.0) with its version.

**Tests:**
- New `tests/unit/joint-rules.test.ts`: every finding code from a built case (design §6.1), the sort order, and messages without ids; the needs table of §6.2 for all nine cells and the unknown default with its first reason; variants fall back (thin parts lose M3 and get M2, then magnets); a metal–plastic pair never puts glue first and puts the insert on the plastic side; TPU and resin never get the insert; glue choice (solvent only for ABS–ABS); `newJoint` uses the top recommendation, `confirmed: false`, needs `null`; `jointBom` aggregation across joints (two joints of M3×8 → one item of 4), magnets counted per side, labels; `assemblyNotes` order and each template.
- New `tests/unit/printable.test.ts`: the cases of design §7.5.
- E2E: none in this task (the browser load of the spike is checked by hand and again in Task 4's e2e).

**Dependencies:** Task 2.

**Done when:** `npm run check` passes, the tests above are green, `npm ls --all manifold-3d` shows only manifold-3d added, `npm run build` keeps manifold out of the main chunk, and the report gives the spike results (API names, JS and wasm sizes, gzip sizes). Tell the reviewer that the `export` spec can start now.

**Session facts:**
- Start from a clean tree. Other specs run in parallel in this repo; if `git status` shows uncommitted changes you did not make, stop and ask before editing.
- This is the only task that adds a dependency: `manifold-3d@3.2.1`, exact. Leave the `package.json` and `package-lock.json` changes in the working tree with the code, so the reviewer commits them together.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests. Never run `verify:real` or `verify:edit`.
- If the dev server is needed for the browser part of the spike, start it on other ports than 5197/8797 (the e2e ports) and stop only what you started.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(joints): add checks, recommendations, the kit and printable parts (spec assembly-joints, task 3)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 4 — Joints in the workbench: scene, mouse join, panels and card

`[x]`

Joints become visible and usable with the mouse: marks on the parts, the 接合 panel with the mouse join and the joint card, the 材料 select, the 列印設定 panel, the print preview, and assembly moves with their notice.

**Read first:** `src/App.tsx` (`commitObjectChange`, `moveObject`, `deleteObject`, `adjust`, `applyEdit`, `pick`, `onTransform`, the keyboard handler, the control column markup, the `SceneViewport` element); `src/scene/SceneViewport.tsx` (`Entry`, `sync`, `writeAttributes`, `syncSelection`, `projectPart`, the click handler); `src/scene/style.ts`; `src/workspace/ObjectPanel.tsx`; `src/ui/NumberField.tsx`; `src/agent/useAgentRun.ts` and `AgentPanel.tsx`; Tasks 1–3's exports (`shared/workspace.ts` joint ops, `shared/contact.ts` `planJoin` and `realignJoint`, `shared/features.ts`, `shared/joint-rules.ts`, `src/print/printable.ts`); `tests/e2e/workspace.spec.ts` (two-object setup); design §8, §11, §13, §14; requirements 6, 7, 10, 19, 47–57, 72, 76, 78, 79, 82, 87, 88.

**Build** (pure modules first, then the wiring):
- `src/joints/labels.ts`: the Traditional Chinese tables (materials, methods and parameters, faces, needs, joint states, notices of design §8.1).
- `src/joints/mouse-join.ts` (design §8.3): `MouseJoinState`, `MouseJoinEvent`, `mouseJoinStep`.
- `src/joints/card-model.ts` (design §8.4): `jointRows`, `jointCardModel` with the R55 actions, `derivedText`.
- `src/joints/printer-store.ts`: `loadPrinterProfile(storage)`, `savePrinterProfile(storage, profile)` (key `forgehand.printer.v1`).
- `src/scene/joint-marks.ts` (design §8.2): `PartMarks`, `buildPartMarks`, `markKey`.
- `src/scene/SceneViewport.tsx` (design §8.2): props `joints`, `marks`, `showJoints`, `joinPreview`, `printPreview`; marks attached to part nodes and re-attached after rebuilds; join preview placement and restore; the 可以接合 sprite; the print preview mesh; `data-joint-count`, `data-joints-json`, `data-snap`, `data-print-preview`; `projectFace` on the handle.
- `src/joints/JointPanel.tsx`, `JointCard.tsx`, `PrinterPanel.tsx` (design §8.4).
- `src/workspace/ObjectPanel.tsx`: the 材料 select and an `onMaterial` prop.
- `src/agent/useAgentRun.ts` and `AgentPanel.tsx`: expose and show the running `instruction` (design §8.4, 請代理建議).
- `src/App.tsx` (design §8.1, §8.3): the state and the derived `kit`; the commit helper and notices; the assembly notice in `moveObject`; the cascade suffix in `adjust`, `applyEdit` and `deleteObject`; the mouse join routing in `onPick`, Esc and agent start; 確認接合 through `joinObjects` and `newJoint`; 重新對齊 through `realignJoint`; the print preview through a dynamic `import('./print/printable')`; the panels in the control column after the 物件 panel.
- `src/styles.css`: only what the new panels need, reusing existing panel, button, notice and field classes.
- `README.md`: the "assembly joints" section (requirement 82) without the two-hand line (Task 6 adds it).

**Tests:**
- New `tests/unit/joint-ui.test.ts`: design §8.5.
- New `tests/e2e/joints.spec.ts`: design §8.5. Select every new control by exact name.
- E2E at the end: the full suite.

**Dependencies:** Task 3.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes with no change to any existing e2e file, and the report tells the reviewer how to try it by hand: `npm run dev`, 載入示範模型 twice, 新增接合, click the first object's 側邊電池, then the second object's 外殼, 確認接合; change 負重 and 拆裝 and watch the method change; 預覽「…」列印件; move the first object with 物件位置 and see both move.

**Session facts:**
- Start from a clean tree. Other specs run in parallel in this repo and also edit `src/App.tsx` and `src/scene/SceneViewport.tsx`; if `git status` shows uncommitted changes you did not make, stop and ask before editing.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of the task: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-joints-task4.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(joints): add the joint panel, mouse join and card (spec assembly-joints, task 4)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 5 — Agent tools for joints and materials

`[x]`

The agent can create, change and remove joints and set materials, sees joints and materials in its state, asks about load and disassembly, and the browser applies its joint changes as undo steps.

**Read first:** `shared/agent.ts`; `server/agent.ts` (`runAgent`, `workspaceSnapshot`, `AGENT_INSTRUCTIONS`); `server/agent-tools.ts`; `server/tools/registry.ts`, `helpers.ts`, `index.ts`, `set-transform.ts`, `get-project-state.ts`, `set-active-object.ts` (a small writing tool to copy); `src/agent/request.ts`, `apply-state.ts`, `useAgentRun.ts`; in `src/App.tsx`: `applyAgentWorkspace` and the `useAgentRun` options; `tests/unit/agent-tools-workspace.test.ts`, `tool-registry.test.ts`, `agent-loop.test.ts`, `apply-state.test.ts`; `tests/e2e/agent-panel.spec.ts` (how it routes `/api/agent`); Tasks 1–3's exports; design §9; requirements 20, 64–66, 79, 85.

**Build:**
- `shared/agent.ts` (design §9): `AgentRequestSchema.printer` (optional) and the default in `validateAgentRequest`; `ObjectSummarySchema.material`; `JointSummarySchema` and `GetProjectStateDetailSchema.joints`; `JointToolDetailSchema`.
- `server/agent-tools.ts`: `AgentWorkingState.printer`; `server/agent.ts` sets it from the request.
- `server/tools/create-joint.ts`, `update-joint.ts`, `remove-joint.ts`, `set-material.ts` (design §9); register them in `server/tools/index.ts` after `remove_object`.
- `server/tools/set-transform.ts`: description and summary for assemblies.
- `server/tools/get-project-state.ts`: materials and joints.
- `server/agent.ts`: `workspaceSnapshot` lines for materials and joints; the `AGENT_INSTRUCTIONS` lines of design §9.
- `src/agent/request.ts`: `RunSnapshot.printer`, `buildAgentRequest` sends it; App's `getSnapshot` passes the profile.
- `src/agent/apply-state.ts`: `recordUndo` for joint changes.
- `src/App.tsx`: `applyAgentWorkspace` notices for joint and material changes, the cascade suffix, and opening the card for an added joint.

**Tests:**
- New `tests/unit/agent-joint-tools.test.ts`: design §9.
- Extend `tool-registry.test.ts` (the four tools, their labels and effects), `agent-loop.test.ts` (`AGENT_INSTRUCTIONS` names the tools; a request without `printer` runs with the defaults; the snapshot lists joints only when there are some), `apply-state.test.ts` (joint changes record undo; old payloads without `joint` still parse).
- `tests/e2e/joints.spec.ts` (extend): the routed agent case of design §9.
- E2E at the end: the full suite.

**Dependencies:** Task 3. It does not need Task 4's panels, but if Task 4 is done the card opening is checked in e2e; if not, the e2e case checks `data-joint-count` only.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and `git diff --stat tests/e2e/agent-panel.spec.ts` is empty.

**Session facts:**
- Start from a clean tree. Other specs run in parallel in this repo; if `git status` shows uncommitted changes you did not make, stop and ask before editing.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker; unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing. Run the full suite once at the end of the task: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-joints-task5.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- Do not add dependencies.
- The server never logs prompts, tool arguments or provider output; error texts returned to the model or the client are fixed Traditional Chinese strings without Zod text.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(agent): add joint and material tools (spec assembly-joints, task 5)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 6 — Two-fist join

`[x]`

Two fists hold two objects; bringing them together snaps the faces and shows 可以接合; releasing creates the joint. Every fist hold moves the whole assembly. This task extends `hand-manipulation`'s code from its Task 7.

**Read first:** `src/hands/*` as built by `hand-manipulation` Tasks 1–7, especially `join.ts`, `controller.ts`, `types.ts`, `text.ts`, `stats.ts`, `fist.ts`; `src/scene/hand-sessions.ts` (`createHoldSession`); `src/scene/SceneViewport.tsx` (`beginObjectHold`, `onObjectMove`, the join preview from Task 4); in `src/App.tsx`: `onObjectMove`, `moveObject`, the hand-control wiring; `tests/fixtures/synthetic-hand.ts` and `tests/e2e/fake-hands.ts` (fists); `.kiro/specs/hand-manipulation/design.md` §5.4, §5.5, §7.4, §9; `shared/contact.ts` (`snapCandidates`, `measurePair`, `alignTransform`, `snapStep`); design §10; requirements 58–63, 79, 83, 87.

**Build:**
- `src/hands/join.ts` (design §10.1): `assemble` in `TwoHandGesture`, `JoinContext`, the optional fourth argument, the `assemble` row.
- `src/hands/types.ts`: `GestureKind` `assemble`. `src/hands/text.ts`: the badges 手勢：可以接合 and 手勢：握住 {object name} for the joiner, and the debug line of design §10.5. `src/hands/stats.ts`: `assembles`, `joins`.
- `src/hands/controller.ts` (design §10.4): the port members `beginAssemble` and `sameAssembly`; the join context; the assemble flow without the owner freeze; release, loss and gate rules.
- `src/scene/hand-sessions.ts` (design §10.2, §10.3): `createHoldSession` over several roots; `createAssembleSession`.
- `src/scene/SceneViewport.tsx`: `beginObjectHold` collects the assembly's roots; `beginAssemble`; the prop `onAssemble`.
- `src/hands/useHandControl.ts`: the new port members.
- `src/App.tsx`: `onAssemble` → `joinObjects` with `newJoint` (opens the card), or both moves in one commit.
- `README.md`: one line on the two-fist join.
- `tasks.md` of this spec: fill in the manual list below if anything changed while building.

**Tests:**
- New `tests/unit/hand-assemble.test.ts`: design §10.6. Existing `hand-*.test.ts` files pass unchanged, except where a test lists the join rule's gestures (an extension).
- New `tests/e2e/assembly-hands.spec.ts`: design §10.6.
- E2E at the end: the full suite.

**Dependencies:** Task 4 (the join preview, the card) and `hand-manipulation` Task 7 (fists and holds). If `hand-manipulation` Task 7 is not done, do not start; report instead.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes with `hand-control.spec.ts` unchanged, and the report hands the user the manual list below.

### Manual check (user's laptop webcam)

Run `npm run dev`, 載入示範模型 twice, 開啟攝影機, and add `?hands=debug` to the URL.

1. **Two fists.** Make a fist over the first object and another over the second: both show filled squares; the second badge reads 手勢：握住 ….
2. **Snap.** Bring the second fist toward the first object until the faces glow and 可以接合 appears. Note the gap and angle in the debug line when it appears, and whether it flickers.
3. **Join.** Open one hand: the card opens with a recommended method; the 接合 panel lists one joint. One 復原 separates them again.
4. **Assembly move.** Join again, then hold the first object with one fist and move it: the second object moves with it during the drag, not only after release.
5. **Inert cases.** A second fist on an object already joined to the first one does nothing (手勢：另一手操作中).
6. **Speed.** Note the tracking rate with two fists and the 偵測 ms in the debug line.
7. **Optional real print.** Print the two parts of one M3 joint with the default profile (列印件預覽 shows what will print; the files come with `export`), press in the inserts and screw them together. Note whether the insert holes and the screw holes needed changes to 列印設定.

**Report:** whether `SNAP_DISTANCE_MM`, `SNAP_SETTLE_MS` or the release limits need tuning, and, after a print, which profile values changed.

**Session facts:**
- Start from a clean tree. Other specs run in parallel in this repo and also edit `src/hands/`, `src/App.tsx` and `src/scene/`; if `git status` shows uncommitted changes you did not make, stop and ask before editing.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing. Run the full suite once at the end of the task: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-joints-task6.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): join two objects with two fists (spec assembly-joints, task 6)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Cut order

**Only the user decides whether anything is cut.** A Kiro session never drops or simplifies a feature on its own, also not to save time: it reports the problem, and the reviewer asks the user. The list below is only a reference for that decision.

If time runs short, cut in this order. Joints with screws and magnets, assembly moves, the mouse join and the export interface (Tasks 1–4 without the cut items) always stay.

1. **Task 6, two-fist join**, when `hand-manipulation` Task 7 is cut or lands too late. Requirements 58–63 and the hold part of 87 are dropped; a fist move still commits through `setTransform`, so the assembly follows on release. Joints are made with the mouse or the agent.
2. **The 列印件預覽 in Task 4.** Requirement 49 and `data-print-preview` are dropped; `printablePart` stays for `export`, tested in Node.
3. **Task 5 reduced to `create_joint` and `update_joint`.** `remove_joint` and `set_material` are dropped; joints are removed and materials set in the panels.
4. **Glue and pins in the UI** (VISION §5). The schema and the rules keep them; the recommendation skips them and the card's 固定方式 select offers 熱壓螺母＋螺絲 and 磁鐵 only.

Dropping a task or item removes its README and manual-list lines; say so in the last report.

## Requirement-to-task map

The full map, with the parts of shared requirements, is design §12. In short:

| Task | Requirements |
|---|---|
| 1 | 1–9, 11, 14–18, 21, 65 (schemas), 70, 73, 75, 84–86 |
| 2 | 5 (`realignJoint`), 12, 13, 22–38, 76, 88 |
| 3 | 18, 39–46, 67–69, 71, 77, 78, 82 |
| 4 | 6, 7, 10, 19, 47–57, 72, 76, 78, 79, 82, 87, 88 |
| 5 | 20, 64–66, 79, 85 |
| 6 | 58–63, 79, 83, 87 |

Requirements 74, 80 and 81 apply to every task; 83 is this file.
