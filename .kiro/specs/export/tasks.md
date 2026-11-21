# Export: a printable kit — Tasks

Implementation order is **1 → 5**. Task 1 builds the file writers (STL, 3MF, zip, GLB, escaping) from plain data and depends on nothing that is unfinished, so it can start right away. Tasks 2 and 3 need `assembly-joints` (AJ) Tasks 2–3 (`jointFeatures`, `touching`, `checkJoints`, `jointBom`, `assemblyNotes`, manifold-3d and `printablePart`). Task 4 adds the browser dialog, the exploded image and the downloads; Task 5 the agent tool, the README and the manual checks. Requirement numbers refer to `requirements.md` (stable ids); section numbers (§) refer to `design.md`. Each task is meant for one fresh Kiro session with Claude Sonnet 5.5 that starts without memory, so each one lists what to read first and repeats the session facts.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

## Parallel sessions and file ownership

Other Kiro sessions work in this same working tree at the same time. On 2026-11-20, `assembly-joints` Task 2 and `hand-manipulation` Task 5 were running, with uncommitted changes in `shared/assembly.ts`, `shared/workspace.ts`, `shared/joint-constants.ts`, `src/App.tsx`, `src/hands/*`, `src/scene/SceneViewport.tsx` and `src/scene/hand-sessions.ts`. Their uncommitted changes are expected and are not yours.

| Spec | Owns (creates or edits) | Export tasks that also edit some of these |
|---|---|---|
| `hand-manipulation` (Tasks 5–9) | `src/hands/**`, `src/scene/hand-sessions.ts`, the hand parts of `src/scene/SceneViewport.tsx` and `src/App.tsx`, `tests/unit/hand-*.test.ts`, `tests/e2e/hand-control.spec.ts`, `tests/e2e/fake-hands.ts`, `tests/fixtures/synthetic-hand.ts` | 4 (`App.tsx`, `SceneViewport.tsx`) |
| `assembly-joints` (Tasks 2–6) | `shared/joint*.ts`, `shared/contact.ts`, `shared/features.ts`, `shared/kit.ts`, `shared/assembly.ts`, `shared/workspace.ts`, `shared/materials.ts`, `shared/standard-parts.ts`, `shared/printer.ts`, `src/print/**`, `src/joints/**`, `src/scene/joint-marks.ts`, `src/workspace/ObjectPanel.tsx`, `server/tools/*-joint.ts`, `server/tools/set-material.ts`; Task 3: `package.json`, `package-lock.json`; Tasks 4 and 6: `src/App.tsx`, `src/scene/SceneViewport.tsx`; Task 5: `shared/agent.ts`, `server/agent.ts`, `server/agent-tools.ts`, `server/tools/index.ts`, `server/tools/helpers.ts`, `src/agent/*`; `README.md` | 1 (`package.json`), 3 (`src/print/printable.ts`), 4 (`App.tsx`, `SceneViewport.tsx`), 5 (`shared/agent.ts`, `server/agent.ts`, `server/tools/index.ts`, `helpers.ts`, `src/agent/*`, `README.md`) |
| `export` (this spec) | `src/export/**`, `shared/export-plan.ts`, `server/tools/prepare-export.ts`, `tests/unit/export-*.test.ts`, `tests/fixtures/export-workspace.ts`, `tests/e2e/export.spec.ts`, `.kiro/specs/export/**` | — |

**Rules for every task** (repeated in each task's session facts):
- Create and edit only the files the task lists under **Build** and **Tests**. Never revert, reformat, stage or "fix" a file you did not change, and never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`.
- Before the first edit of a file another spec owns (the right column above), run `git status --short <file>`. If it shows changes, another session is still working on it: stop and ask. Do not wait in a loop.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them; the task is then not done until the reviewer confirms.
- Only one session runs Playwright at a time, because the suite needs ports 5197/8797. If they are taken, another session is running e2e: wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.

---

## Task 1 — File writers: STL, 3MF, zip and GLB

`[x]`

Everything that turns plain data into bytes: mesh helpers and the print frame, binary STL, the 3MF package with its plate layout, the zip, the GLB, and the escaping and number formats every document uses. Pure code in `src/export/`; nothing changes on screen. No dependency on unfinished `assembly-joints` tasks.

**Read first:** `shared/model.ts` (`Part`, `ModelSpec`); `shared/workspace.ts` (`SceneObject`, `ObjectTransform`; read only); `shared/materials.ts` (`MaterialId`); `src/scene/geometry.ts` (`buildModel`, `createPartGeometry`, `disposeObject`); `node_modules/three/examples/jsm/exporters/GLTFExporter.js` (`parseAsync`, `binary`, how `userData` becomes `extras`) and its types in `node_modules/@types/three/examples/jsm/exporters/GLTFExporter.d.ts`; `node_modules/fflate/lib/index.d.ts` (`zipSync`, `unzipSync`, `strToU8`, `ZipOptions` with `level` and `mtime`); `vitest.config.ts`; design §1, §2, §3, §9 (T1), §13; requirements 10–13, 20, 23–28, 45–48, 64, 68, 70.

**Build:**
- **Dependency first.** Run `git status --short package.json package-lock.json`; if either shows changes, stop and ask (AJ Task 3 installs manifold-3d into the same files). Then `npm install fflate@0.8.3 --save-exact`. `npm ls fflate` must show the top-level `fflate@0.8.3` (the same version `@types/three` already pulls in) and the lockfile diff must add no other package.
- `src/export/constants.ts`: `PLATE_GAP_MM = 5`, `PLATE_ROW_MM = 220`, `MESH_KEY_MM = 0.001`, `STL_HEADER_BYTES = 80` (later tasks add theirs).
- `src/export/format.ts` (design §3.6): `xmlEscape`, `htmlEscape`, `mdCell`, `csvField`, `csvRow`, `formatMm`, `formatSize`, `formatCm3`, `formatDate`, `base64`, `fmtNumber`.
- `src/export/mesh.ts` (design §3.1): `MeshData`, `meshBounds`, `meshVolume`, `MeshProblem`, `meshProblems`, `PRINT_FRAME`, `toPrintFrame`, `meshKey` (FNV-1a 64 over the canonical integer list).
- `src/export/stl.ts` (design §3.2): `writeStl`.
- `src/export/zip.ts` (design §3.4): `KitFile`, `zipFiles`, `kitZipName`.
- `src/export/threemf.ts` (design §3.3): `ThreeMfObject`, `layoutPlate`, `threeMfModelXml`, `write3mf`, using the exact namespace, content-type and relationship strings of §3.3.
- `src/export/glb.ts` (design §3.5): `buildGlbScene`, `writeGlb`.

**Tests:**
- New `tests/unit/export-writers.test.ts`: the T1 cases of design §9. Build test meshes by hand (a closed cube with outward winding, an open box, a flipped cube) in a small helper inside the test file. Read 3MF and zip output back with `unzipSync` and check the XML with string and regular-expression checks (Node has no `DOMParser`; do not add a parser).
- `writeGlb` is not unit-tested (Node has no `FileReader`); Task 4 checks its bytes in e2e.
- E2E: none.

**Dependencies:** none. AJ Task 1 (`SceneObject.material`) has landed.

**Done when:** `npm run check` passes, the tests above are green, `npm ls fflate` shows `fflate@0.8.3` at the top level, and the report gives the lockfile diff summary and confirms no other package was added.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. Before the first edit of `package.json` or `package-lock.json`, check `git status --short` for them; if they show changes, stop and ask.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests. Never run `verify:real` or `verify:edit`.
- This is the only task that adds a dependency: `fflate@0.8.3`, exact. Leave the `package.json` and `package-lock.json` changes in the working tree with the code, so the reviewer commits them together.
- Everything in this task is pure and runs in Node: no DOM, no renderer, no React. `writeGlb` is the only function that needs a browser.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(export): add STL, 3MF, zip and GLB writers (spec export, task 1)`).
- User-facing strings and file contents are Traditional Chinese; code, comments and reports are English.

---

## Task 2 — Kit plan and documents: scope, BOM and assembly sheet

`[x]`

What is printed, bought or machined; the scope; step numbers and joint labels; the summary the agent will use; the findings table; the BOM as CSV and Markdown; the assembly sheet as HTML. Pure code; nothing changes on screen.

**Read first:** Task 1's `src/export/format.ts`; `shared/kit.ts` (`jointBom`, `assemblyNotes`, `BomItem`, re-exports), `shared/joint-rules.ts` (`checkJoints`, `Finding`, `FindingCode`), `shared/features.ts` (`jointFeatures`, `FeatureSet`, `JointFeature`) from AJ Tasks 2–3; `shared/assembly.ts` (`assemblyOf`); `shared/joint.ts`; `shared/materials.ts`; `shared/workspace.ts` (`Workspace`, `WorkspaceError`); `tests/fixtures/joint-workspace.ts` (`demoPair`, `twoBoxes`, `fixtureJoint`); AJ design §6.3–§6.4 (BOM labels, note templates, part naming); design §4, §5, §9 (T2); requirements 1, 4, 5, 9, 13, 16, 18, 19, 22, 29–39, 56, 63.

**Build:**
- `shared/export-plan.ts` (design §4): `ExportScopeSchema`, `scopeWorkspace`, `PartClass`, `classifyPart`, `METHOD_KIND_LABELS`, `jointLabel`, `stepNumbers`, `BoughtRow`, `boughtRows`, `MachinedRow`, `machinedRows`, `ExportSummarySchema`, `exportSummary`. Three.js math classes only; no import from `src/`.
- `src/export/findings.ts` (design §5.1): `ExportFindingCode`, `ExportFinding`, `EXPORT_MESSAGES` (the R16 table, exact strings), `exportMessage`, `jointFindings`, `unconfirmedFindings`, `classFindings`, `featuresSkippedJoints`, `sortFindings`.
- `src/export/bom.ts` (design §5.2): `PieceInfo`, `StandardRow`, `Bom`, `buildBom`, `bomCsv`, `bomMarkdown`.
- `src/export/sheet.ts` (design §5.3): `assemblySheetHtml`.
- `tests/fixtures/export-workspace.ts`: builders reused by Tasks 3–5: the demo pair with one screw joint, a metal object, an object with an interior part, a part name with hostile characters (`=cmd|' /C calc'!A0 <script>|`), and hand-built `PieceInfo` lists.

**Tests:**
- New `tests/unit/export-plan.test.ts` and `tests/unit/export-docs.test.ts`: the T2 cases of design §9.
- E2E: none.

**Dependencies:** AJ Tasks 2 and 3 (`jointFeatures`, `checkJoints`, `jointBom`, `assemblyNotes`). If either is not marked `[x]` in `.kiro/specs/assembly-joints/tasks.md`, do not start; report instead. Task 1 (`format.ts`).

**Done when:** `npm run check` passes and the tests above are green, and the report includes one sample `bom.csv` and the first lines of `bom.md` for the demo pair, so the reviewer can read the Traditional Chinese text.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. This task edits no file another spec owns.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests. Never run `verify:real` or `verify:edit`.
- Do not add dependencies.
- `shared/export-plan.ts` is imported by the server in Task 5: Three.js math classes only, no DOM, no `src/` imports.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(export): add the kit plan, BOM and assembly sheet (spec export, task 2)`).
- User-facing strings and file contents are Traditional Chinese; code, comments and reports are English.

---

## Task 3 — Print pieces and the kit

`[x]`

Parts that overlap or touch are fused into print pieces unless a joint separates them; joint features are cut after the union; pieces move to the print frame; identical pieces are counted; the export findings are computed; `prepareKit` assembles every file. Runs in Node with the real manifold-3d WASM.

**Read first:** `src/print/manifold.ts` and `src/print/printable.ts` (AJ Task 3: `loadManifold`, `printablePart`, how primitives and features are built, how objects are deleted); `tests/unit/printable.test.ts` (how the WASM is loaded in Node); `shared/contact.ts` (`localFace`, `worldFace`, `touching`), `shared/joint-constants.ts` (`CONTACT_GAP_MM`), `shared/joint.ts` (`CONTACT_FACES`); `shared/bounds.ts` (`worldMatrices`, `partBoxes`); Tasks 1–2's modules (`mesh.ts`, `stl.ts`, `threemf.ts`, `zip.ts`, `export-plan.ts`, `findings.ts`, `bom.ts`, `sheet.ts`); `tests/fixtures/export-workspace.ts`; design §6, §9 (T3), §12; requirements 6–12, 14, 17, 20–22, 64, 65, 69.

**Build:**
- `src/print/printable.ts` (design §6.1, an AJ file): run `git status --short src/print/printable.ts` first; if it shows changes, stop and ask. Export `primitiveSolid` and `featureSolids` and make `printablePart` use them, with no change in behaviour. If AJ already exports equivalents, use those and change nothing.
- `src/export/constants.ts`: add `FUSE_PARTS = true`, `FUSE_MIN_MM3 = 1`, `LARGE_PIECE_MM = 250`.
- `src/export/pieces.ts` (design §6.2): `PieceBuild`, `PiecesResult`, `buildPieces` with the steps 1–10, progress, `yieldNow`, abort and the `owned` list deleted in a `finally`.
- `src/export/prepare.ts` (design §6.3): `KitInput`, `KitSummary`, `PreparedKit`, `prepareKit`, `kitZip`.

**Tests:**
- New `tests/unit/export-pieces.test.ts`: the T3 cases of design §9, with the real WASM loaded as `printable.test.ts` does. Count live Manifold objects through a small wrapper around the module to check the abort case.
- `tests/unit/printable.test.ts` passes unchanged.
- A timing run (not an assertion): a synthetic workspace of 8 objects with 64 boxes each; report the time of `buildPieces`.
- E2E: none.

**Dependencies:** AJ Tasks 2 and 3, and Task 2. If AJ Task 3 is not marked `[x]`, do not start; report instead.

**Done when:** `npm run check` passes, the tests above are green, `printable.test.ts` is unchanged and green, and the report gives the timing of the 8 × 64 case and the piece list (numbers, names, counts, volumes) for the demo pair with one screw joint.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/print/printable.ts` belongs to `assembly-joints`: check `git status --short` for it before the first edit and stop and ask if it shows changes.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests. Never run `verify:real` or `verify:edit`.
- Do not add dependencies.
- Every `Manifold` and `CrossSection` must be deleted, also on abort and failure.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time. If fusion itself cannot be made reliable, report it: the documented fallback is `FUSE_PARTS = false` (one piece per part), and the reviewer decides.
- Do not commit; the reviewer commits (suggested message: `feat(export): build print pieces and the kit (spec export, task 3)`).
- User-facing strings and file contents are Traditional Chinese; code, comments and reports are English.

---

## Task 4 — The export dialog, the exploded image and downloads

`[x]`

The 匯出套件 button, the export dialog with progress, findings, the summary and every download, the off-screen exploded image with step badges, the GLB in the browser, and the e2e test.

**Read first:** `src/App.tsx` (the stage toolbar markup, `sceneRef`, `agentActive`, the `printer` state if AJ Task 4 added it, `applyAgentWorkspace`); `src/scene/SceneViewport.tsx` (`SceneHandle`, `View`, the `controls` target; `ensureExplosion` for the explosion maths); `src/scene/explode.ts` (`computeExplosion`, `explodedOffsets`); `src/scene/geometry.ts`; `src/print/manifold.ts`; Tasks 1–3's modules, especially `prepare.ts` and `glb.ts`; `shared/contact.ts` (`localFace`, `worldFace`); `tests/e2e/workspace.spec.ts` (two-object setup) and `tests/e2e/agent-panel.spec.ts` (how `/api/agent` is routed); design §7, §9 (T4), §12; requirements 1–3, 14, 15, 18, 20–22, 40–44, 47, 49–55, 60, 61, 65, 66.

**Build** (pure modules first, then the wiring):
- `src/export/constants.ts`: add `IMAGE_WIDTH = 1600`, `IMAGE_HEIGHT = 1200`, `SEPARATION_FACTOR = 0.3`.
- `src/export/dialog-model.ts` (design §7.2): `defaultScope`, `scopeChoiceVisible`, `SnapshotKey`, `snapshotKey`, `sameSnapshot`, `fileRows`, `problemBanner`, `summaryLines`.
- `src/export/kit-image.ts` (design §7.4): `ImageLayout`, `explodedLayout`, `renderKitImage`.
- `src/export/download.ts` (design §7.5): `downloadBytes`.
- `src/export/ExportDialog.tsx` (design §7.3), default export, so `React.lazy` can load it.
- `src/scene/SceneViewport.tsx`: `viewDirection()` on `SceneHandle` (design §7.1). Nothing else in this file.
- `src/App.tsx` (design §7.1): `exportRequest`, the 匯出套件 button, the lazy dialog in `Suspense`.
- `src/styles.css` (design §7.6): `.export-dialog`, `.export-findings`, reusing the existing panel, button, notice and field classes.

**Tests:**
- New `tests/unit/export-dialog.test.ts`: the pure dialog model and `explodedLayout` (design §9, T4).
- New `tests/e2e/export.spec.ts`: design §9 (T4). Create the joint with a routed `/api/agent` stream whose `state` frame carries a `joint` `add` change, so the test does not need AJ Task 4's panels. Unpack the zip in the test with `fflate.unzipSync`. Select every control by its exact name. Log the time from opening the dialog to `data-export-state="ready"`.
- `npm run build` output: confirm `fflate`, `GLTFExporter`, manifold-3d and `src/export/` are not in the main chunk, and report the chunk sizes.
- E2E at the end: the full suite.

**Dependencies:** Task 3. AJ Task 4 is not required (without it, the dialog uses `DEFAULT_PRINTER_PROFILE`).

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes with no change to any existing e2e file, and the report gives the chunk sizes, the measured preparation time of the e2e case, and how to try it by hand: `npm run dev`, 載入示範模型 twice, rotate the view, 匯出套件, read the findings, 下載完整套件, open `assembly.html` from the zip.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/App.tsx`, `src/scene/SceneViewport.tsx` and `src/styles.css` are shared with `hand-manipulation` and `assembly-joints`: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. This task's e2e spec does not turn the camera on.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Only one session runs Playwright at a time: if the ports are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/export.spec.ts`). Run the full suite once at the end of the task: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-export-task4.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time. If the step badges take more than an hour, say so in the report and keep building them; never drop or simplify a feature on your own (only the user decides cuts).
- Do not commit; the reviewer commits (suggested message: `feat(export): add the export dialog, exploded image and downloads (spec export, task 4)`).
- User-facing strings and file contents are Traditional Chinese; code, comments and reports are English.

---

## Task 5 — Agent tool, README and manual checks

`[ ]`

The agent can prepare an export: `prepare_export` summarises the kit and opens the dialog, and the user downloads. README explains the kit. The task ends with the manual checks in a real slicer and one real print.

**Read first:** `shared/agent.ts` (`StateChangeSchema`, tool detail schemas); `server/agent.ts` (`runAgent`, `AGENT_INSTRUCTIONS`); `server/agent-tools.ts` (`AgentWorkingState`, `printer` if AJ Task 5 added it); `server/tools/registry.ts`, `helpers.ts` (`checkedChange`, `ok`, `fail`, `noModel`), `index.ts`, `wear-on-arm.ts` (a tool with a session-state change), `get-project-state.ts`; `src/agent/apply-state.ts`, `useAgentRun.ts`; in `src/App.tsx`: the `useAgentRun` options and `exportRequest`; `tests/unit/tool-registry.test.ts`, `agent-loop.test.ts`, `apply-state.test.ts`; `tests/e2e/export.spec.ts`; `README.md`; Task 2's `shared/export-plan.ts`; design §8, §9 (T5); requirements 56–59, 61, 62, 66–68, 70, 73.

**Build:**
- `shared/agent.ts`: `StateChangeSchema.exportDialog` (design §8).
- `server/tools/helpers.ts`: `checkedChange` drops `exportDialog` with `tryOn`.
- `server/tools/prepare-export.ts` (design §8); register it last in `server/tools/index.ts`.
- `server/agent.ts`: the `AGENT_INSTRUCTIONS` lines of design §8.
- `src/agent/apply-state.ts`: `StateEffects.exportDialog`. `src/agent/useAgentRun.ts`: the `openExport` option.
- `src/App.tsx`: pass `openExport: scope => setExportRequest(scope)`.
- `README.md` (requirement 73): an "Export" section (what the kit contains; it runs locally and uploads nothing; the 3MF lays pieces flat for printing and the GLB keeps the assembled view; touching and overlapping parts become one print piece unless a joint separates them; print a tolerance test first and tune 列印設定), one line in the privacy section, and the `fflate` 0.8.3 (MIT) credit next to manifold-3d.

**Tests:**
- New `tests/unit/export-agent.test.ts`: design §9 (T5).
- Extend `tool-registry.test.ts` (`prepare_export`, label 準備匯出, effect `read-only`), `agent-loop.test.ts` (`AGENT_INSTRUCTIONS` names `prepare_export`), `apply-state.test.ts` (`exportDialog` parsed, `recordUndo` false, old payloads still parse).
- `tests/e2e/export.spec.ts` (extend): a routed stream with a `prepare_export` `tool`, `result` and `state` frame opens the dialog with the given scope; 復原 stays disabled.
- E2E at the end: the full suite.

**Dependencies:** Task 4. Preferably after AJ Task 5 (`printer` in the agent request and `AgentWorkingState.printer`); without it, the tool uses `DEFAULT_PRINTER_PROFILE` and says so in a code comment.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, `git diff --stat tests/e2e/agent-panel.spec.ts` is empty, and the report hands the user the manual list below.

### Manual check (user's machine)

Run `npm run dev`.

1. **Kit from the demo.** 載入示範模型 twice, join the two objects (新增接合 if AJ Task 4 is done, otherwise ask the agent), 匯出套件, read the findings, 下載完整套件. Unzip it.
2. **Slicer.** Open `kit.3mf` in PrusaSlicer, Bambu Studio or OrcaSlicer. Check: no unit or scale prompt; the number of objects on the plate equals the BOM's printed pieces times their counts; names read 「P01 …」; colours match the parts; one piece's size in the slicer equals its 尺寸 in `bom.md`; nothing overlaps on the plate; the slicer reports no mesh errors.
3. **STL.** Drag one `stl/P0n-….stl` into the slicer: same size, upright (the model's top faces up).
4. **GLB.** Open `workspace.glb` in Blender (File → Import → glTF 2.0) or another glTF viewer: assembled, part names, colours.
5. **Sheet.** Open `assembly.html` in the browser and print it to PDF: the image, the steps and the BOM fit A4; step numbers match the badges.
6. **Joint test piece (real print).** Make two small blocks of about 30 × 20 × 10 mm (generate them, or shrink two parts with the part fields), set both objects to PLA, join two 30 × 10 mm faces with 熱壓螺母＋螺絲 M3 ×1, and confirm the method. Export, slice P01 and P02 with your usual PLA settings, and print them. Press in one CNC Kitchen M3×5.7 insert with a soldering iron and fasten the parts with the M3 screw the BOM names. Note whether the insert went in without cracking or wobbling, whether the screw passed the clearance hole freely, and whether the head sat in its counterbore. If a fit was wrong, change 列印設定, export again and reprint.
7. **Agent.** Ask the agent 「幫我匯出可以列印的套件」: it calls `prepare_export`, the dialog opens, and the reply asks you to press 下載完整套件 and mentions the problems.

**Report:** the slicer and version used, any mesh errors or wrong sizes, the result of the test print (which 列印設定 values changed, if any), and whether the agent reply was accurate.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `shared/agent.ts`, `server/agent.ts`, `server/tools/index.ts`, `server/tools/helpers.ts`, `src/agent/*`, `src/App.tsx` and `README.md` are shared with `assembly-joints` Task 5 and other specs: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Only one session runs Playwright at a time: if the ports are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- Run single spec files while developing. Run the full suite once at the end of the task: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-export-task5.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`. The manual check's agent step is the user's own action.
- Do not add dependencies.
- The server never logs prompts, tool arguments or provider output; error texts returned to the model or the client are fixed Traditional Chinese strings without Zod text.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(agent): add prepare_export and document the kit (spec export, task 5)`).
- User-facing strings and file contents are Traditional Chinese; code, comments and reports are English.

---

## Cut order

**Only the user decides whether anything is cut.** A Kiro session never drops or simplifies a feature on its own, also not to save time: it reports the problem, and the reviewer asks the user. The list below is only a reference for that decision.

If time runs short, cut in this order (requirement 67, `docs/VISION.md` §5). The STL files, the 3MF and the BOM always stay.

1. **Step badges in the image** (Task 4, requirement 42). `explodedLayout` returns no badges; the steps keep their numbers.
2. **The agent tool** (Task 5, requirements 56–59). README and the manual list stay; the manual list drops step 7.
3. **The image in the assembly sheet** (Task 4, requirements 40–44). `renderImage` is not passed; the sheet keeps its text steps and the kit has no `exploded.png`.
4. **The assembly sheet** (Task 2's `sheet.ts`, requirements 35–39). The kit keeps `bom.md`, which lists the parts; the steps are dropped.

**Fallback for fusion** (decision 1): if Task 3 cannot make fusion reliable, set `FUSE_PARTS = false`: one piece per printed part. The findings `FUSED` and `JOINT_FUSED` then never appear; everything else stays.

Dropping an item removes its README and manual-list lines; say so in the last report.

## Requirement-to-task map

The full map is design §10. In short:

| Task | Waits for | Requirements |
|---|---|---|
| 1 | nothing | 10–13 (helpers), 20 (zip), 23–28, 45–48, 64, 68, 70 |
| 2 | AJ Tasks 2–3; Task 1 | 1, 4, 5, 9, 13, 16, 18, 19, 22, 29–39, 56 (summary), 63 |
| 3 | AJ Tasks 2–3; Task 2 | 6–12, 14, 17, 20–22, 64, 65, 69 |
| 4 | Task 3 | 1–3, 14, 15, 18, 20–22, 40–44, 47, 49–55, 60, 61, 65, 66 |
| 5 | Task 4; preferably AJ Task 5 | 56–59, 61, 62, 66 (manual), 67, 68, 70, 73 |

Requirements 71 and 72 apply to every task; 74 is this file.
