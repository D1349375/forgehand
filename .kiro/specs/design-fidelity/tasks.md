# Design fidelity — Tasks

Implementation order is **1 → 6**. Task 1 builds the `shell` primitive everywhere a primitive is used and makes the demo housing hollow. Task 2 restructures the instructions into rule blocks and adds the honest-internals rules, the concept / detailed mode and the standard-parts reference table. Task 3 adds the fit checks and the computed numbers. Task 4 is the research sub-agent; its **step 0 is a spike that calls real back ends and runs only after the user says go**, and Tasks 5 and 6 do not wait for it. Task 5 adds the cutaway. Task 6 is the evaluation; its **real runs also wait for the user's go-ahead**. Requirement numbers refer to `requirements.md` (stable ids); section numbers (§) refer to `design.md`. Each task is meant for one fresh Kiro session that starts without memory, so each one lists what to read first and repeats the session facts.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

**Only the user decides cuts.** A session never drops, simplifies or postpones a requirement on its own, also not to save time; it reports the problem and the user decides. The priorities (P0: Tasks 1–2, P1: Tasks 3, 4, 6, P2: Task 5) only order the work.

**Decisions.** The tasks assume the recommended option of each decision in `requirements.md` ("Decisions"). If the user chose differently, the reviewer updates this file before the task starts.

## Parallel sessions and file ownership

Other Kiro sessions work in this same working tree at the same time (on 2026-11-26: the specs `workbench-ui`, `body-fit` and `english-ui` were being written, and their implementation will follow). Their uncommitted changes are expected and are not yours. The full table of shared files is design §11.

**Rules for every task** (repeated in each task's session facts):
- Create and edit only the files the task lists under **Build** and **Tests**. Never revert, reformat, stage or "fix" a file you did not change, and never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`.
- Before the first edit of a file another spec also touches (design §11, right column), run `git status --short <file>`. If it shows changes, another session is still working on it: stop and ask. Do not wait in a loop.
- In `src/App.tsx`, only mount components and pass props; logic lives in `src/fidelity/`. If `workbench-ui` has landed with slots, mount into its slots and report where.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them; the task is then not done until the reviewer confirms.
- Only one session runs Playwright at a time (ports 5197/8797). If they are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.

---

## Task 1 — The `shell` primitive everywhere, and a hollow demo housing

`[ ]` · P0 · Requirements 1–13, 70–72, 74, 76, 77, 80, 81

A closed hollow box whose wall comes from `tubeRatio`: schema, shared helpers, display mesh, contact faces, thickness, printable solid, export, the rule line, and the demo housing.

**Read first:** `.kiro/steering/*.md`; `shared/model.ts` (`PartSchema`); `shared/agent.ts` (the local `primitive` enum, `PartSummarySchema`); `shared/bounds.ts` (`worldMatrices`, `partBoxes`, `modelBox`); `shared/joint.ts` (`CONTACT_FACES`, `faceShape`); `shared/contact.ts` (`localFace`); `shared/features.ts` (`partThickness`, the boss rule around `bossHeight` and `offsetMm: tI`); `shared/demo.ts`; `src/scene/geometry.ts` (`createPartGeometry`, `disposeObject`); `src/scene/style.ts` (`hologramPart`); `src/scene/explode.ts`; `src/print/printable.ts` (`primitiveSolid`, `tracker`, `printablePart`); `src/export/pieces.ts` (step 5, `COMPONENT_BLOCKED`), `src/export/findings.ts` (`EXPORT_MESSAGES`, severities, sort order), `src/export/mesh.ts` (`meshProblems`, `meshVolume`); `server/provider.ts` (`MODEL_INSTRUCTIONS`, the `GEOMETRY_RULES` filter) and `server/agent.ts` (its own filter); `tests/fixtures/joint-workspace.ts` (`demoPair`); `tests/unit/printable.test.ts` (loading the WASM in Node), `scene.test.ts`, `joint-data.test.ts` (lines 200–210), `joint-contact.test.ts` (line 45), `export-pieces.test.ts` (lines 190–205, 375); `tests/e2e/export.spec.ts` (lines 128, 211–213); `.kiro/specs/assembly-joints/requirements.md` 21, 30, 33, 45; design §3, §9 (T1), §10, §11, §13; requirements 1–13, 70–72.

**Build:**
1. `shared/model.ts`: add `shell` to the primitive enum (R1).
2. `shared/agent.ts`: replace the local `primitive` enum with `PartSchema.shape.primitive` (R1).
3. `shared/hollow.ts` (new, design §3.1): `VOID_TOLERANCE_M`, `shellWall`, `innerBox`, `partVolume`, `InnerSurface`, `innerSurface`, `containedInVoid`, `voidExcess`. Three.js math only.
4. `shared/joint.ts`: `CONTACT_FACES.shell` as the box row (R6).
5. `shared/features.ts`: the shell branch of `partThickness` (R7, design §3.3). No other change.
6. `src/scene/geometry.ts`: the `shell` case with a local `concatIndexed` helper and inward inner faces (R4, design §3.2).
7. `src/print/printable.ts`: the `shell` case of `primitiveSolid` (R8, design §3.4).
8. `src/export/findings.ts` and `src/export/pieces.ts`: `COMPONENT_SEALED` (R10, design §3.5).
9. `server/provider.ts`: the primitive line and the `tubeRatio` sentence (R11, design §3.7). Do not restructure the rules (that is Task 2).
10. `shared/demo.ts`: the housing as a shell with a 2.0 mm wall, the battery at x = 0.0975, the new assumption line (R12, design §3.6).
11. `tests/fixtures/joint-workspace.ts`: `solidDemoModel` (a verbatim copy of today's demo), used only where a test's numbers depend on the solid housing (design §3.6, decision 4).
12. `README.md`: one line under the model description that a `shell` is a closed hollow box whose wall comes from `tubeRatio`, and that hollow housings export with an internal void.

**Tests:**
- New `tests/unit/hollow.test.ts` and the extensions in design §9 (T1): `model.test.ts`, `scene.test.ts` (add `shell` to the `it.each` list at line 11), `explode.test.ts`, `joint-data.test.ts` (shell face row), `joint-contact.test.ts` (add `shell` to the list at line 45; shell faces equal box faces), `joint-features.test.ts`, `printable.test.ts`, `export-pieces.test.ts` (add `shell` to the list at line 375; the shell cases), `export-docs.test.ts` (the new message), and a `get_project_state` case with a shell part.
- If `joints.spec.ts` or `assembly-hands.spec.ts` fails only because the battery moved, put the battery back at x = 0.099 instead of editing the test, and report it (decision 4); the demo then shows one `FLOATING_PART` notice, and Task 3's demo expectation changes accordingly.
- Run the whole unit suite after step 10. For each failing test, decide: if it fails only because the demo housing is now hollow (thickness, bosses, volumes, findings) or the battery moved, switch that test or its fixture to `solidDemoModel` without editing any expected value; list each one in the report. Any other failure: stop and report.
- `tests/e2e/export.spec.ts`: lines 128 and 211–213 now expect `COMPONENT_SEALED` and no `COMPONENT_BLOCKED` for the demo (R71).
- E2E: the **full suite** at the end (the demo is used everywhere). Run it in the background with output to a file (`npx playwright test *> artifacts/local/e2e-fidelity-task1.log`), timeout at least 30 minutes, then read the file.

**Dependencies:** none (AJ and export are done).

**Done when:** `npm run check` passes; the tests above are green; the full e2e suite passes; the report lists every test switched to `solidDemoModel` with the reason, the measured volume differences of `partVolume` against both meshes for every primitive, and confirms that `git diff --stat` shows no edited expected values in AJ or export tests other than the lists of R71.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `shared/joint.ts`, `shared/features.ts`, `src/print/printable.ts`, `src/export/*`, `tests/fixtures/joint-workspace.ts`, `tests/e2e/export.spec.ts` belong to AJ and export; `shared/agent.ts`, `shared/model.ts`, `shared/demo.ts`, `server/provider.ts`, `README.md` are shared: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera). Never download browsers (no `npx playwright install`) and never download MediaPipe models.
- The e2e suite starts its own server on ports 5197/8797. Only one session runs Playwright at a time: if the ports are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls. Never run `verify:real` or `verify:edit`.
- Do not add dependencies. Use three's own classes and manifold-3d, both installed.
- Units are metres in `shared/`, millimetres in `src/print/` and `src/export/`, as today.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(model): add the hollow shell primitive (spec design-fidelity, task 1)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 2 — Rule blocks, honest internals, concept / detailed mode, reference table

`[ ]` · P0 · Requirements 14–29, 70, 71, 74, 75, 77, 80, 81

The instructions become named blocks that reach generation, edits and the agent; the internals rules, the two modes end to end, and the standard-parts reference table with a verified source for every entry.

**Read first:** `.kiro/steering/*.md`; `server/provider.ts` (all of it after Task 1); `server/agent.ts` (`AGENT_INSTRUCTIONS`, `workspaceSnapshot`, `runAgent` state); `server/agent-tools.ts` (`AgentWorkingState`); `server/tools/generate-design.ts`, `edit-design.ts`, `helpers.ts`; `server/app.ts` (`RequestSchema`, `/api/generate`, `/api/edit`); `server/claude.ts`, `codex.ts`, `app-server.ts` (how `labelledInput` and `task.instructions` are used); `shared/agent.ts` (`AgentRequestSchema`, `validateAgentRequest`); `shared/edit.ts` (`EditRequestSchema`); `shared/standard-parts.ts` (`SCREWS`, `INSERTS`, the source-comment style); `src/joints/printer-store.ts` (storage pattern); `src/agent/request.ts`, `useAgentRun.ts`; in `src/App.tsx`: the prompt panel and `callModel`; `tests/unit/server-edit.test.ts` (line 80), `agent-loop.test.ts` (line 540), `server-claude.test.ts`, `server-codex.test.ts`, `server-app-server.test.ts`, `agent-tools-model.test.ts`, `joint-data.test.ts` (how numbers are pinned); design §4, §9 (T2), §10; requirements 14–29.

**Build:**
1. **Freeze the baseline first** (R24, design §4.5): `scripts/fidelity-baseline.ts` with `BASELINE_MODEL_INSTRUCTIONS`, a verbatim copy of `MODEL_INSTRUCTIONS` as it is before this task's edits.
2. `server/provider.ts`: the rule blocks (design §4.1), `FIDELITY_RULES` text (R15–R19, R28), `DETAILED_PART_CAP`, `DetailMode`, `DesignOptions`, `designTask(prompt, options)`, `editTask(..., options)`, `labelledInput` as in design §4.2, `GENERATOR_VERSION = 'controlled-primitives/1.1.0'`.
3. `server/agent.ts`: import `GEOMETRY_RULES` from `provider.ts` (remove the local filter); `state.detail`; the snapshot line for the mode; the R22 lines and the one-line pointer of R28.
4. `server/agent-tools.ts`: `AgentWorkingState.detail`.
5. `server/tools/generate-design.ts` (`detail` argument) and `edit-design.ts` (mode from state), design §4.3.
6. `shared/agent.ts`: `AgentRequestSchema.detail` and its default in `validateAgentRequest`. `shared/edit.ts`: optional `detail` in `EditRequestSchema`. `server/app.ts`: optional `detail` in both routes, `/api/generate` through `provider.run` when present.
7. `shared/standard-parts.ts`: `ReferenceCategory`, `ReferencePart`, `ReferencePartIdSchema`, `REFERENCE_PARTS`, `referenceLines` (design §4.4), filled per R27 and decision 12: read each source, write the value and a `source` note naming the table or line, set `checked` to today. **Before opening any source page or PDF, ask the user once whether you may (decision 12); if the answer is no, write only the entries whose values the user supplies.** An entry whose source you cannot open or that does not state the value is left out and listed in the report; never fill a value from memory, including the candidate values in R26.
8. `shared/fidelity-text.ts` (new): the mode labels and help text, and a header comment that every new user-facing string of this spec lives here.
9. `src/fidelity/settings.ts` and `src/fidelity/DetailModeSwitch.tsx` (design §4.3); `src/agent/request.ts` and `useAgentRun.ts` send `detail`; `src/App.tsx` mounts the switch in the prompt panel above 物件描述 and sends `detail` with generate and edit requests; `src/styles.css`: `.fidelity-mode`.
10. `README.md`: the two modes in the usage section (concept by default, detailed adds typical internals with typical sizes, capped at about 20 parts, slower).

**Tests:**
- New `tests/unit/fidelity-rules.test.ts` and `tests/unit/reference-parts.test.ts`: design §9 (T2).
- Existing adapter tests must stay green without edits: they prove design, edit and agent arguments are unchanged for concept mode.
- Extend `tests/unit/tool-registry.test.ts` only if the `generate_design` argument shape is asserted there.
- New `tests/e2e/fidelity.spec.ts`: the switch, persistence after reload, and `detail` in routed `/api/agent` and `/api/generate` request bodies.
- E2E: `fidelity.spec.ts`, `workbench.spec.ts`, `agent-panel.spec.ts`.

**Dependencies:** Task 1.

**Done when:** `npm run check` passes; the tests above are green; the three e2e specs pass; the report contains the final `FIDELITY_RULES` text, the size in characters of `MODEL_INSTRUCTIONS` and `EDIT_INSTRUCTIONS` before and after, the reference table as a list (id, value, source URL, what was read), and the entries left out with the reason.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `server/provider.ts`, `server/agent.ts`, `server/agent-tools.ts`, `server/app.ts`, `shared/agent.ts`, `shared/edit.ts`, `shared/standard-parts.ts`, `src/agent/*`, `src/App.tsx`, `src/styles.css`, `README.md` are shared: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- Step 1 comes before any instruction edit; if it was forgotten, stop and report (the baseline can then only be rebuilt from git history, which the reviewer does).
- The language line of the instructions stays a separate line: `english-ui` changes it alone.
- Reading a source page is not a model call, but it may count as a download under the user's rules: ask first (step 7). Never save the pages.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers or MediaPipe models. One Playwright session at a time (ports 5197/8797); wait and retry at most three times; never stop a process you did not start.
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- The server never logs prompts, instructions or provider output; error texts returned to the client are fixed Traditional Chinese strings.
- Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(agent): add internals rules, detail modes and reference parts (spec design-fidelity, task 2)`).
- User-facing strings are Traditional Chinese; instructions, code, comments and reports are English.

---

## Task 3 — Fit checks, the size readout, the badge and the stale note

`[ ]` · P1 · Requirements 30–41, 70, 74–78, 80, 81

Pure checks and numbers in `shared/fit-checks.ts`, in the tool results and the agent's rules, and in the browser for the active object.

**Read first:** `.kiro/steering/*.md`; `shared/hollow.ts` (Task 1); `shared/bounds.ts`; `shared/fidelity-text.ts` (Task 2); `shared/agent.ts` (`GenerateDesignDetailSchema`, `EditDesignDetailSchema`, `ToolResultSchema`); `server/tools/generate-design.ts`, `edit-design.ts`; `server/agent.ts` (`AGENT_INSTRUCTIONS`, the round history); `src/agent/apply-state.ts`, `useAgentRun.ts` (where `state` changes are applied); in `src/App.tsx`: `applyResult`, `applyEdit`, `loadDemo`, the details panel, the stage footer, undo/redo; `tests/unit/agent-tools-model.test.ts` (tool test style); `tests/e2e/edit-select.spec.ts` (manual edits), `agent-panel.spec.ts` (routed streams); design §5, §9 (T3); requirements 30–41.

**Build:**
- `shared/fit-checks.ts` (new, design §5.1): constants, `FitFinding`, `fitChecks`, `overallSizeMm`, `formatSizeMm`, `assumptionsStale`.
- `shared/fidelity-text.ts`: `FIT_MESSAGES`, `fitSummaryText`, readout, badge, stale and notice strings.
- `shared/agent.ts`: `sizeMm?` and `fit?` in both detail schemas (design §5.2). `server/tools/generate-design.ts`, `edit-design.ts`: compute and return them, and append the summary text. `server/agent.ts`: the R36 lines.
- `src/fidelity/SizeReadout.tsx`, `ConceptBadge.tsx`, `FitNotices.tsx`, `StaleNote.tsx`, `baselines.ts` (design §5.3).
- `src/App.tsx`: the baseline map and its four recording points, the stale flag, and mounting the components (details panel and stage footer). `src/styles.css`: `.fidelity-size`, `.fidelity-badge`, `.fidelity-fit`, `.fidelity-stale`.
- `tests/fixtures/fidelity-models.ts` (new): the models of design §9.
- `README.md`: the size readout, the badge, the fit notices and that nothing is repaired automatically.

**Tests:**
- New `tests/unit/fit-checks.test.ts`: design §9 (T3), including the 64-part timing (report the measured time).
- Tool tests for `sizeMm`, `fit` and the summary (in a new `describe` of `tests/unit/agent-tools-model.test.ts` or a new file); `agent-loop.test.ts` checks the R36 lines.
- `tests/e2e/fidelity.spec.ts` (extend): design §9 (T3).
- E2E: `fidelity.spec.ts`, `workbench.spec.ts`, `edit-select.spec.ts`, `agent-panel.spec.ts`.

**Dependencies:** Tasks 1 and 2.

**Done when:** `npm run check` passes; the tests above are green; the four e2e specs pass; the report includes a screenshot description or the text of the details panel for the demo (readout, badge, 沒有配置提醒。) and the measured `fitChecks` time for 64 parts.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `shared/agent.ts`, `server/agent.ts`, `src/agent/*`, `src/App.tsx`, `src/styles.css`, `README.md` are shared: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- The fit checks are advisory: never block an action, never call a model to repair, never change the model.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers or MediaPipe models. One Playwright session at a time (ports 5197/8797); wait and retry at most three times; never stop a process you did not start.
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls. Never run `verify:real` or `verify:edit`.
- Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(fidelity): add fit checks and computed size (spec design-fidelity, task 3)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 4 — Research sub-agent (spike first)

`[ ]` · P1 · Requirements 48–61, 70, 71, 74, 75, 77, 78, 80, 81

**Read first:** `.kiro/steering/*.md`; `server/provider.ts` (`ModelTask`, `ModelProvider`, `designTask`, `editTask`, after Task 2); `server/claude.ts`, `server/codex.ts`, `server/app-server.ts` (every isolation flag, `SAFE_CONFIG`, the effective-config check), `server/model-host.ts`; `server/agent.ts`, `server/agent-tools.ts`, `server/tools/registry.ts`, `index.ts`, `helpers.ts`, `generate-design.ts`, `edit-design.ts`; `shared/agent.ts`; `server/app.ts` (the agent route's error mapping); `src/agent/AgentPanel.tsx`, `useAgentRun.ts`, `request.ts`; `tests/unit/server-claude.test.ts`, `server-codex.test.ts`, `server-app-server.test.ts`, `tool-registry.test.ts`, `agent-loop.test.ts`; `.kiro/specs/agent-harness/requirements.md` (out of scope: network stays disabled); design §6, §9 (T4), §14; requirements 48–61.

### Step 0 — Spike (**real back ends; only after the user says go**)

Ask the user: 「研究子代理的前置測試會實際呼叫 Claude Code CLI 與 Codex CLI 上網搜尋，每個 CLI 最多 2 次（加上各 1 次確認設計流程仍然隔離），會用到額度。可以開始嗎？」 Wait for a yes. Without it, do nothing else in this task and report that Task 4 waits.

After the yes:
1. Write the draft `RESEARCH_INSTRUCTIONS` and the brief JSON schema to files in a new empty folder under `%TEMP%` (they are not code yet). Use the query `18650 鋰電池 尺寸 規格書`.
2. Run the Claude and Codex commands of design §6.1 from that empty folder, passing the instructions, schema and query only through files or stdin. At most two attempts per CLI. Save the raw outputs under `artifacts/local/research-spike/` (git-ignored); never paste them into code, logs or the report beyond what §14 needs.
3. For Codex with the app-server transport, check whether a research thread can run with web search on while the other `SAFE_CONFIG` values hold (design §6.1).
4. For each CLI that produced a brief, run one normal design call with today's isolated settings (for example `npm run verify:real` with `VERIFY_CASES=P01` and the matching `MODEL_PROVIDER`), to confirm the design path is unchanged. This is one real call per CLI and is part of the same go-ahead.
5. Validate each brief against the draft schema, list its URLs, and ask the user to open two of them per CLI and say whether they support the numbers.
6. Fill design §14 (one row per CLI and transport) and set `RESEARCH_SPIKE` in the report. Then follow the branch of R51 / design §6.6: both fail → build only §6.6 and stop for the user's decision; one or both pass → continue with the Build list for the passing adapters.

**Build** (after step 0, per its result):
- `shared/research.ts` (new, design §6.2).
- `server/provider.ts`: `ModelTask.kind` `research`, `ModelTask.web`, `ModelProvider.research`, `RESEARCH_SPIKE`, `RESEARCH_INSTRUCTIONS`, `researchTask`, `RESEARCH_TIMEOUT_MS`, `RESEARCH_MAX_PER_RUN`, `MAX_SESSION_REFERENCES`; `DesignOptions.reference` and the `REFERENCE_FACTS` block in both task inputs (R58).
- `server/claude.ts`, `server/codex.ts`, `server/app-server.ts`: the web path for `task.web` only, with exactly the flags §14 recorded (design §6.3); the OpenAI adapter rejects research.
- `server/tools/registry.ts` (`uses-network`), `server/tools/research-reference.ts` (new), `server/tools/index.ts` (register last, only when the spike passed for at least one CLI), `server/agent-tools.ts` (`research`, `researchCalls`, `references`), `server/agent.ts` (state from the request, the R55 instruction lines), `server/tools/generate-design.ts` and `edit-design.ts` (`referenceId`, detail field).
- `shared/agent.ts`: request fields `research`, `references`, `ResearchDetailSchema`, `AgentRequestError` code `INVALID_REFERENCES`; `server/app.ts`: map it to 400 with its fixed message.
- `shared/fidelity-text.ts`: the switch label and help, 參考來源, the tool label and the error messages.
- `src/fidelity/settings.ts` (`loadResearch`, `saveResearch`), `ResearchSwitch.tsx`, `ReferenceSources.tsx`; `src/agent/useAgentRun.ts`, `request.ts` (research flag, the last three briefs, `onReferenceUsed`); `src/agent/AgentPanel.tsx` (sources of a research result); `src/App.tsx` (the switch next to the mode switch, the per-object sources map, `ReferenceSources` in the details panel); `src/styles.css`.
- `README.md`: the reference switch, what it sends and that it is off by default (R61); or, after a failed spike, that references are not available.

**Tests:**
- New `tests/unit/research.test.ts`: design §9 (T4).
- Adapter tests: new cases for research arguments; the existing cases for design, edit and agent stay unchanged and green (R48).
- `tool-registry.test.ts` (the tool, its label and effect), `agent-loop.test.ts` (instruction lines only when registered).
- `tests/e2e/fidelity.spec.ts` (extend): design §9 (T4).
- E2E: `fidelity.spec.ts`, `agent-panel.spec.ts`.

**Dependencies:** Task 2 (`DesignOptions`). Step 0 needs the user's go-ahead; Tasks 5 and 6 do not wait for this task.

**Done when:** design §14 is filled; `npm run check` passes; the tests above are green; the two e2e specs pass; the report states the spike result per CLI and transport, the flags used, which branch of R51 was taken, and the quota the spike used as the CLIs reported it. After a failed spike: §6.6 is built, `npm run check` passes, and the report asks the user to decide (decision 9).

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `server/provider.ts`, `server/agent.ts`, `server/agent-tools.ts`, `server/app.ts`, `server/tools/index.ts`, `server/tools/registry.ts`, `shared/agent.ts`, `src/agent/*`, `src/App.tsx`, `src/styles.css`, `README.md` are shared: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- **Real model calls happen only in step 0, only after the user's yes, and only as listed there.** Unit tests use a fake `ModelProvider`; e2e tests route `/api/*`.
- Never give the main agent, the design call or the edit call web access; only `task.web` changes an adapter's flags (R48).
- User text and model text never go into subprocess arguments: use stdin or temporary files, `shell: false`.
- The server never logs queries, briefs, page content, prompts or CLI diagnostics; error texts are fixed Traditional Chinese strings without provider or Zod detail.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers or MediaPipe models. One Playwright session at a time (ports 5197/8797); wait and retry at most three times; never stop a process you did not start.
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report. The spike has a hard limit of two attempts per CLI.
- Do not commit; the reviewer commits (suggested message: `feat(agent): add the isolated research_reference sub-agent (spec design-fidelity, task 4)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 5 — Cutaway

`[ ]` · P2 · Requirements 42–47, 73–77, 80, 81

One section plane through the active object, display only, with picking that ignores the removed half.

**Read first:** `.kiro/steering/*.md`; `src/scene/SceneViewport.tsx` (`SceneHandle.viewDirection`, `hitsAt`, `hitTest`, how part materials are created and rebuilt, the render loop, renderer creation); `src/scene/style.ts` (materials per part); `src/export/kit-image.ts` (its own renderer and materials); in `src/App.tsx`: the explode toolbar and the active-object changes; `tests/e2e/explode.spec.ts`, `edit-select.spec.ts`, `export.spec.ts`; design §7, §9 (T5); requirements 42–47.

**Build:**
- `src/fidelity/cutaway.ts` (new, pure, design §7): `CutAxis`, `cutAxis`, `cutPlane`, `inRemovedHalf`.
- `src/fidelity/CutawayToggle.tsx` (new); its label in `shared/fidelity-text.ts`.
- `src/scene/SceneViewport.tsx`: the `cutaway` prop, the stored axis, one preallocated plane updated per frame, `localClippingEnabled`, clipping planes on the active object's materials (also after a rebuild), the `hitsAt` filter, `data-cutaway`.
- `src/App.tsx`: cutaway state, the toggle in the explode toolbar, reset on an active-object change. `src/styles.css`: `.fidelity-cutaway`.
- `README.md`: one line on the cutaway (display only, cuts the active object through its centre, facing you).

**Tests:**
- New `tests/unit/cutaway.test.ts`: design §9 (T5).
- `tests/e2e/fidelity.spec.ts` (extend): design §9 (T5).
- E2E: `fidelity.spec.ts`, `explode.spec.ts`, `edit-select.spec.ts`, `export.spec.ts`, `hand-control.spec.ts`.

**Dependencies:** Task 1 (a hollow demo makes the cut meaningful). Independent of Tasks 3 and 4.

**Done when:** `npm run check` passes; the tests above are green; the five e2e specs pass; the report notes that `git diff` of `SceneViewport.tsx` touches only the cutaway code and `hitsAt`.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/scene/SceneViewport.tsx`, `src/App.tsx`, `src/styles.css`, `README.md` are shared with hand-manipulation, AJ, export, `workbench-ui` and `body-fit`: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- The cutaway is display state: no workspace change, no undo step, nothing sent to the server, no effect on the export files.
- No allocation per frame in the render loop.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers or MediaPipe models. One Playwright session at a time (ports 5197/8797); wait and retry at most three times; never stop a process you did not start.
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls. Never run `verify:real` or `verify:edit`.
- Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(scene): add a cutaway view (spec design-fidelity, task 5)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 6 — Evaluation: six products, before and after, both CLIs

`[ ]` · P1 · Requirements 62–69, 77, 80, 81

The prompts, the metrics, the runner switches, the summary and the replay screenshots are built and tested without any model call. The real runs **wait for the user's go-ahead**.

**Read first:** `.kiro/steering/*.md`; `scripts/verify-real-provider.ts` (all of it), `scripts/fidelity-baseline.ts` (Task 2); `tests/e2e/representative-prompts.ts`, `captured-models.spec.ts`; `shared/fit-checks.ts` (Task 3); `server/provider.ts` (`designTask`, options); `.gitignore` (`artifacts/local/`); design §8, §9 (T6), §15; requirements 62–69.

**Build:**
- `tests/e2e/fidelity-prompts.ts` (new, R62).
- `shared/fit-checks.ts`: `fidelityMetrics` (R63).
- `scripts/fidelity.ts` (new): `fidelityTask(prompt, env)` (pure task choice), `fidelitySummary`, `scoreTemplate` (R64, R66, design §8).
- `scripts/verify-real-provider.ts`: the `VERIFY_SET`, `VERIFY_RULES`, `VERIFY_DETAIL` switches, the fidelity artifact, the summary and the score template (design §8). Without the switches, byte-identical behaviour.
- `tests/e2e/fidelity-replay.spec.ts` (new, opt-in with `REVIEW_FIDELITY=1`).
- `README.md`: how to run the evaluation (the commands below), that it spends quota, and where the summary is.

**Tests:**
- New `tests/unit/fidelity-eval.test.ts`: design §9 (T6).
- E2E: the **full suite** at the end (last task of the spec); `fidelity-replay.spec.ts` is skipped without `REVIEW_FIDELITY=1`.

### Real runs (**only after the user says go**)

Ask the user: 「評估要實際呼叫模型：6 個產品 × 2 套規則（基準、新規則詳細模式）× 2 個 CLI，共 24 次，每次約 50–120 秒，會用到額度。要不要另外加跑新規則的概念模式 12 次？可以開始嗎？」 Wait for a yes and the answer about the extra 12 calls. Then run, one at a time (PowerShell):

```
$env:VERIFY_SET='fidelity'; $env:MODEL_PROVIDER='claude'; $env:VERIFY_RULES='baseline'; npm run verify:real
$env:VERIFY_SET='fidelity'; $env:MODEL_PROVIDER='claude'; $env:VERIFY_RULES='current'; $env:VERIFY_DETAIL='detailed'; npm run verify:real
$env:VERIFY_SET='fidelity'; $env:MODEL_PROVIDER='codex'; $env:VERIFY_RULES='baseline'; npm run verify:real
$env:VERIFY_SET='fidelity'; $env:MODEL_PROVIDER='codex'; $env:VERIFY_RULES='current'; $env:VERIFY_DETAIL='detailed'; npm run verify:real
```

(and, if approved, the two `VERIFY_DETAIL='concept'` runs). Clear `VERIFY_DETAIL` between runs. A failed call is recorded as failed and not retried without asking. Then run `$env:REVIEW_FIDELITY='1'; npx playwright test tests/e2e/fidelity-replay.spec.ts`, ask the user to score every design 1–5 in `artifacts/fidelity-scores-{date}.json`, rerun the summary (the runner's report mode or `npx tsx -e` calling `fidelitySummary` on the artifact), and copy the table into design §15 with the date, CLI versions and the number of calls spent.

**Dependencies:** Tasks 2 and 3 (rules, metrics); Task 5 for the cutaway screenshots (without it the replay saves assembled and exploded views only, and the report says so). Independent of Task 4.

**Done when:** `npm run check` passes; the unit tests are green; the full e2e suite passes; and, after the user's go-ahead, design §15 holds the summary, the scores and the call count. If the user has not yet said go, the task is reported as "built, runs pending" and stays `[~]`.

### Manual check (user's machine)

Run `npm run dev`. Items marked **(quota)** call a real model.

1. **Hollow demo.** 載入示範模型. The housing shows two outlines (outer and inner); 爆炸圖 moves the board out of it; the details panel shows 外框 寬 195 × 深 129 × 高 177 mm (the whole demo: housing, side battery, lens tubes and stand), 概念設計・尺寸為暫定 and 沒有配置提醒。
2. **Slicer check of a hollow part.** 匯出套件 with the demo, unzip, open `kit.3mf` and the housing's STL in PrusaSlicer, Bambu Studio or OrcaSlicer. Check: no mesh errors; the slice preview shows a 2 mm wall and an empty interior (not solid infill); the reported volume or filament estimate matches the BOM's volume; the findings list 外購件「內部電路概念件」被封在…裡面 (`COMPONENT_SEALED`) and no 重疊 (`COMPONENT_BLOCKED`).
3. **Joint on a wall.** Load the demo twice, join the two housings with 熱壓螺母＋螺絲 M3 ×1, open 列印件預覽: the boss grows inside the wall, not outside.
4. **Stale note.** Change the housing's 尺寸 by hand: the stale note appears and the readout changes; 復原 hides the note again.
5. **Detailed mode (quota).** Set 細節程度 to 詳細 and ask the agent 「做一個藍牙喇叭」. Check: a shell housing, typical internals with generic names (典型…), the assumption 內部配置為同類產品的典型配置…, at most about 20 parts, fit notices if any, and the agent's reply quoting the computed size.
6. **Ask for internals (quota).** In 概念 mode ask 「做一條智慧手環」, then 「加入典型內部零件」: the agent edits the object (or asks once first), and the internals appear inside the shell.
7. **Cutaway.** 剖面檢視 on the speaker: the near half is removed, the internals are visible, a click on the cut-away side selects nothing, and the export image is not cut.
8. **References (quota; only if Task 4's spike passed).** Turn on 允許上網查參考資料 and ask 「先查一下藍牙喇叭常見的內部零件尺寸，再照參考做一個」. Check: 參考來源 links open real pages that support the numbers; the design uses the facts; the details panel lists the sources for the new object. Then turn the switch off and ask again: the agent says research is off and uses the built-in sizes.
9. **Reference table.** Open `shared/standard-parts.ts` and spot-check at least five `REFERENCE_PARTS` entries against their `sourceUrl`.

**Report:** the slicer and version, whether the void and the volume were right, any mesh errors, the agent's behaviour in items 5–8, and any reference number that did not match its source.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `scripts/verify-real-provider.ts`, `shared/fit-checks.ts` and `README.md`: check `git status --short` before the first edit and stop and ask if it shows changes.
- `verify:real` is the only way to call a real back end, and only after the user's yes in "Real runs". Unit tests never call a model; `fidelityTask` is tested as a pure function.
- Artifacts under `artifacts/` (not `local/`) are committed by the reviewer; screenshots under `artifacts/local/` stay local. Never commit secrets, keys or raw CLI diagnostics.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers or MediaPipe models. One Playwright session at a time (ports 5197/8797); wait and retry at most three times; never stop a process you did not start. Run the full suite in the background with output to `artifacts/local/e2e-fidelity-task6.log` and a timeout of at least 30 minutes.
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `test(eval): measure design fidelity on six products (spec design-fidelity, task 6)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Requirement-to-task map

The full map is design §12. In short:

| Task | Priority | Waits for | Requirements |
|---|---|---|---|
| 1 | P0 | nothing | 1–13, 70–72, 74, 76, 77, 80, 81 |
| 2 | P0 | Task 1; the user's yes to read sources | 14–29, 70, 71, 74, 75, 77, 80, 81 |
| 3 | P1 | Tasks 1–2 | 30–41, 70, 74–78, 80, 81 |
| 4 | P1 | Task 2; the user's go-ahead for step 0 | 48–61, 70, 71, 74, 75, 77, 78, 80, 81 |
| 5 | P2 | Task 1 | 42–47, 73–77, 80, 81 |
| 6 | P1 | Tasks 2–3 (Task 5 for cutaway screenshots); the user's go-ahead for the runs | 62–69, 77, 80, 81 |

Requirements 79 and 82 apply to every task and to these documents.
