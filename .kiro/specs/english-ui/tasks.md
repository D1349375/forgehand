# English UI with a language switch — Tasks

Implementation order is **T1 → T2 → (the other specs' tasks on the same files) → T3 → T4 → T5 → T6**. T1 creates only new files and can start now. T2 is small and should land early, before `workbench-ui`, `design-fidelity` and `body-fit` add more instruction lines, tools and requests, so they build on `langOf` and the instruction functions. T3–T5 move the existing strings into tables and run late, after the other specs have finished with the same files. T6 turns English on, adds the content-language notice, the English e2e spec and the READMEs, and ends with the manual checks. Requirement ids (R…, N…) refer to `requirements.md`; section numbers (§) refer to `design.md`. Each task is meant for one fresh Kiro session with Claude Sonnet 5.5 that starts without memory, so each one lists what to read first and repeats the session facts.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

## Parallel sessions and file ownership

Other Kiro sessions work in this same working tree at the same time. On 2026-11-26 the specs `workbench-ui`, `design-fidelity` and `body-fit` were being written; their tasks will edit many of the files below. The full table is design §10. In short:

| Spec | Edits (from its draft of 2026-11-26 and VISION §4.9–§4.11; confirm in its `tasks.md`) | english-ui tasks that also edit some of these |
|---|---|---|
| `workbench-ui` | its T3–T7: `src/App.tsx`, `src/styles.css`, `src/workbench/**` (strings in `src/workbench/text.ts`), `src/agent/AgentPanel.tsx`, `src/workspace/ObjectPanel.tsx`, `src/joints/JointPanel.tsx`, `src/joints/PrinterPanel.tsx`, `src/hands/text.ts`; `shared/workspace.ts` (pull a part out, `MESSAGES`); `README.md` | T2 (`App.tsx`, the HUD slot), T3 (`shared/workspace.ts`), T4 (`App.tsx`, `src/workbench/text.ts`, agent panel, objects panel), T5 (joints panels, `src/hands/text.ts`), T6 (`App.tsx`, `shared/workspace.ts`, `README.md`) |
| `design-fidelity` | `server/provider.ts` (rule blocks), `server/agent.ts`, `shared/model.ts`, `shared/joint.ts`, `src/scene/geometry.ts`, `src/print/printable.ts`, `src/fidelity/**`, mounts in `src/App.tsx`, `shared/fidelity-text.ts`, `src/export/findings.ts` (`COMPONENT_SEALED`), a research tool, `README.md` | T2 (`provider.ts`, `agent.ts`), T3 (`shared/*`, `shared/fidelity-text.ts`, tools), T4 (`App.tsx`, `geometry.ts`), T5 (`printable.ts`, `src/fidelity/**`, `src/export/*`) |
| `body-fit` | `shared/fit*.ts` (strings in `shared/fit-text.ts`), `shared/demo-bracelet.ts`, `src/fit/**`, `server/tools/attach-to-body.ts`, `server/tools/fit-to-body.ts`, `shared/agent.ts`, `server/tools/index.ts`, state and mounts in `src/App.tsx`, `src/styles.css`, `README.md` | T2 (`agent.ts`), T3 (`shared/fit-text.ts`, the bracelet demo, tools, `shared/agent.ts`), T4 (`App.tsx`), T5 (`src/fit/**`) |
| `english-ui` (this spec) | `shared/i18n/**`, `server/i18n/**`, `src/i18n/**`, `src/main.tsx`, `playwright.config.ts`, `tests/unit/i18n-*.test.ts`, `tests/unit/readme-sync.test.ts`, `tests/e2e/english.spec.ts`, `README.zh-TW.md`, `.kiro/specs/english-ui/**` | — |

**Rules for every task** (repeated in each task's session facts):
- Create and edit only the files the task lists under **Build** and **Tests**. Never revert, reformat, stage or "fix" a file you did not change, and never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`.
- Before the first edit of a file another spec also edits (table above, design §10), run `git status --short <file>`. If it shows changes, another session is still working on it: stop and ask. Do not wait in a loop.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them; the task is then not done until the reviewer confirms.
- Only one session runs Playwright at a time, because the suite needs ports 5197/8797. If they are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.

---

## Task 1 — Core: languages, tables, store, provider and guards

`[ ]` · P0 · Requirements: R1, R18, R47, R48 (report mode), R53, R54, R56

The building blocks every later task and every other spec uses: the `Lang` type and header parser, `defineText` and the format helpers, the content-language test, the browser language store, the React provider and the notice descriptors, and three guard tests. New files only; nothing changes on screen.

**Read first:** `.kiro/steering/*.md`; design §1, §2, §3, §9, §12; requirements R1–R4, R9, R18, R19, R35, R47, R48, R53, R54; `src/joints/printer-store.ts` (the storage pattern to copy); `shared/printer.ts` (a small Zod module in `shared/`); `vitest.config.ts` (`isolate: false`, Node environment); `tsconfig.json`; one existing test that uses a fake storage, `tests/unit/joint-ui.test.ts` (search for `PRINTER_STORAGE_KEY`).

**Build:**
- `shared/i18n/lang.ts` (design §3.1): `LANGS`, `Lang`, `LangSchema`, `HTML_LANG`, `isLang`, `langFromTag`, `langFromHeader`.
- `shared/i18n/define.ts` (§3.2): `Shape`, `defineText`, `Localized`, `localized`.
- `shared/i18n/format.ts` (§3.3): `quote`, `joinList`, `colon`, `paren`, `plural`, `seconds`, `hasCjk`.
- `shared/i18n/content.ts` (§8.2): `contentLang`, `differsFromUi` (pure; used from T6).
- `src/i18n/lang-store.ts` (§3.4): `ENGLISH_UI_READY = false`, `LANG_STORAGE_KEY = 'forgehand.lang.v1'`, `detectLang`, `loadLang`, `saveLang`, `initialLang`, `switchVisible`.
- `src/i18n/LanguageProvider.tsx` (§3.5): `LanguageProvider`, `useLang`. Not mounted yet (T2).
- `src/i18n/ui-text.ts` (§3.6): `UiText`, `ui`, `raw`, `renderUiText`.
- `tests/unit/i18n-files.ts` (§3.7): `TABLE_FILES` (the three `i18n/` folders for now).

**Tests:**
- New `tests/unit/i18n-core.test.ts`: the cases of design §3.7, plus `contentLang` and `differsFromUi` (Chinese demo names → zh-TW; English names → en; mixed `USB-C 插座` → zh-TW; an English name with a Chinese assumption → zh-TW for `contentLang`, and for `differsFromUi(model, 'zh-TW')` false only when the name or a part name has CJK).
- New `tests/unit/i18n-tables.test.ts` (§3.7), with a small example table defined inside the test file so the test has something to check before T3.
- New `tests/unit/i18n-scan.test.ts` (§3.7) with `STRICT = false`. It prints the file list and the total (expect about 690 lines in about 70 files on 2026-11-26).
- E2E: none.

**Dependencies:** none.

**Done when:** `npm run check` passes, the three new test files are green, the scan test prints its list without failing, and the report gives the scan total per layer (`src/`, `shared/`, `server/`).

**Session facts:**
- Other Kiro sessions work in this working tree at the same time (see "Parallel sessions and file ownership"). Their uncommitted changes are expected. This task creates only new files; edit nothing else. Never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No dependencies: no i18n library, no glob package (use `node:fs`), no jsdom (decision 1, R56).
- No global "current language" anywhere: Vitest runs every file in one context (`isolate: false`), so module state leaks between tests (R54).
- The project uses TypeScript 7 (`typescript@7.0.2`); if a conditional type of `Shape` does not infer as design §3.2 expects, simplify the helper but keep the guarantee "English must have the same keys and parameter types", and say how in the report.
- Do not commit; the reviewer commits (suggested message: `feat(i18n): add language core, string tables and guards (spec english-ui, task 1)`).
- Code, comments and reports are English.

---

## Task 2 — Language choice end to end, and the model's language

`[ ]` · P0 · Requirements: R2–R9, R19, R23, R25, R44, R59

The language becomes real: the provider is mounted, the switch exists (hidden until T6 unless the URL has `?lang=`), `<html lang>` and the title follow it, every `/api/*` request carries `Accept-Language`, and the server builds the generation, edit and agent instructions with the matching language line. The visible UI strings stay Chinese until T3–T5, which is why the switch is gated (R9).

**Read first:** design §4, §9.1, §12; requirements R2–R9, R19, R23, R25, R44, R59; `src/main.tsx`; in `src/App.tsx`: the top bar (search `className="topbar"`), the generate and edit `fetch` calls, the status fetch (`/api/status`), `useAgentRun(…)` options; `src/agent/useAgentRun.ts`, `src/agent/request.ts` (`buildAgentRequest`); `server/app.ts` (`createApp`, the three POST routes, `/api/status`); `server/provider.ts` (`ModelProvider`, `MODEL_INSTRUCTIONS`, `designTask`, `EDIT_INSTRUCTIONS`, `editTask`, `GEOMETRY_RULES`); `server/agent.ts` (`runAgent`, `agentTask`, `AGENT_INSTRUCTIONS`); `server/agent-tools.ts` (`AgentWorkingState`); `server/tools/helpers.ts`; `server/tools/joint-helpers.ts` (`printerOf`, the pattern for `langOf`); `server/tools/generate-design.ts`, `edit-design.ts`; the `generate:` lines of `server/codex.ts`, `server/claude.ts`, `server/app-server.ts`, `server/model-host.ts`; `playwright.config.ts`; `tests/unit/server.test.ts`, `server-edit.test.ts`, `server-agent.test.ts` (fake providers); Task 1's files.

**Build:**
- `src/main.tsx`: mount `LanguageProvider` with `initialLang(…)` (§4.1).
- New `src/i18n/LanguageSwitch.tsx` (§4.1); render it in the top bar of `src/App.tsx`, or, if `workbench-ui` has landed, in the language switch slot of its HUD's first row (its requirement 4); say which in the report. Props `disabled` and `disabledReason` exist but are passed as `false` / `''` until T4.
- New `src/i18n/api.ts`: `apiHeaders(lang)`; use it in every `/api/*` fetch of `src/App.tsx` and `src/agent/useAgentRun.ts` (the hook gets `lang` in its options). The status fetch re-runs on a language change.
- `server/app.ts`: the language middleware and passing `lang` to the three routes (§4.2). Error texts unchanged.
- New `server/i18n/instructions.ts` (§4.2): `LANGUAGE_LINE`, `UI_NAMES`.
- `server/provider.ts`: `modelInstructions(lang)`, `editInstructions(lang)`; `MODEL_INSTRUCTIONS` and `EDIT_INSTRUCTIONS` stay exported as the zh-TW variants; `designTask(prompt, lang)`, `editTask(model, instruction, selectedPartIds, lang)`; `ModelProvider.generate(prompt, signal, lang?)`; the OpenAI adapter's `generate`.
- `server/agent.ts`: `agentInstructions(lang)`; `AGENT_INSTRUCTIONS = agentInstructions('zh-TW')`; `runAgent` options gain `lang?: Lang` and put it into the working state; `agentTask` uses `langOf(state)`.
- `server/agent-tools.ts`: `AgentWorkingState.lang?: Lang`. `server/tools/helpers.ts`: `langOf`.
- `server/tools/generate-design.ts`, `edit-design.ts`: pass `langOf(state)`.
- `server/codex.ts`, `server/claude.ts`, `server/app-server.ts`, `server/model-host.ts`: the `generate` line only.
- `playwright.config.ts`: `use.locale: 'zh-TW'` (§4.3).

**Tests:**
- New `tests/unit/i18n-server.test.ts` (design §4.4).
- Extend `tests/unit/i18n-core.test.ts` with `apiHeaders`.
- Existing unit tests stay unchanged; if one fails because a signature changed, add the missing `'zh-TW'` argument only, and list the file in the report.
- E2E: run `tests/e2e/workbench.spec.ts` and `tests/e2e/agent-panel.spec.ts` (they route `/api/*`). Confirm the pinned locale once with `page.evaluate(() => navigator.language)` in a temporary local spec that you delete before the report, and report the value (expected `zh-TW`).

**Dependencies:** Task 1. The files `src/App.tsx`, `server/provider.ts`, `server/agent.ts`, `server/app.ts` must be clean in `git status`; if another session is editing them, stop and ask.

**Done when:** `npm run check` passes, the tests above are green, the two e2e specs pass, the report confirms that `MODEL_INSTRUCTIONS`, `EDIT_INSTRUCTIONS` and `AGENT_INSTRUCTIONS` are byte-identical to before (compare with `git diff`; only the language-line slot moved into a template), and `switchVisible('?lang=en', false)` is true while `switchVisible('', false)` is false (unit test).

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/App.tsx`, `src/agent/useAgentRun.ts`, `server/provider.ts`, `server/agent.ts`, `server/agent-tools.ts`, `server/tools/helpers.ts` are shared with other specs: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- Keep every user-facing zh-TW string exactly as it is (R45). This task changes no visible Chinese text.
- Requests without `Accept-Language` must behave exactly as today (R19, R59): the default is `zh-TW`.
- `GEOMETRY_RULES` is filtered from `MODEL_INSTRUCTIONS` by line prefixes in two files; keep those lines unchanged and language-free.
- The Claude adapter passes the instructions as the `--system-prompt` argument; that is instruction text, not user text, and stays as it is. User text still goes through stdin or temp files (`.kiro/steering/structure.md`).
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"`. Never download browsers (no `npx playwright install`). Never download MediaPipe models in tests.
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(i18n): add the language switch and the model's answer language (spec english-ui, task 2)`).
- User-facing strings stay Traditional Chinese in this task; code, comments and reports are English.

---

## Task 3 — Shared and server strings

`[ ]` · P0 · Requirements: R13 (shared part), R20–R22, R24, R26, R27 (server), R32, R37, R45, R46 (server), R55, R57, R59

Every string in `shared/` and `server/` moves into tables with English next to it: joint findings and reasons, face, material and standard-part labels, kit notes, workspace, edit and model errors, the export summary, the demo model, every sanitized server error, every tool display name and summary, and the agent's snapshot. Rules return codes; text is rendered at the edge.

**Read first:** design §3.2, §5, §9, §11, §12; requirements R13, R20–R27, R32, R37, R45, R46, R55, R57; every file of the **Build** list; the scan output of `npx vitest run tests/unit/i18n-scan.test.ts` for `shared/` and `server/`; the `tasks.md` of `workbench-ui`, `design-fidelity` and `body-fit` (check that their tasks on these files are done); `tests/unit/joint-rules.test.ts`, `agent-joint-tools.test.ts`, `agent-loop.test.ts`, `server-agent.test.ts`, `tool-registry.test.ts`, `export-plan.test.ts`, `edit.test.ts`, `model.test.ts`, `workspace.test.ts`.

**Build:**
- Tables (design §2): `shared/i18n/joints.ts`, `kit.ts`, `materials.ts`, `workspace.ts`, `model.ts`, `export-plan.ts`, `demo.ts`, `agent.ts`; `server/i18n/errors.ts`, `tools.ts`, `snapshot.ts`.
- `shared/joint-rules.ts`: `Finding.params`, `findingText`, reason codes and `reasonText` (§5.1). `Finding.message` stays zh-TW.
- `shared/joint.ts`, `materials.ts`, `standard-parts.ts`, `kit.ts`, `contact.ts`, `workspace.ts`, `edit.ts`, `model.ts`, `export-plan.ts`, `demo.ts`, `agent.ts`: as design §5.1. Existing zh-TW fields and constants that tests read stay with their values.
- `server/provider.ts`: `GenerationError(code, message: string | ServerText, status)`, `errorText` (§5.2); the OpenAI adapter's texts as `ServerText`.
- `server/app.ts`, `server/agent.ts`, `server/agent-tools.ts`, `server/codex.ts`, `server/claude.ts`, `server/app-server.ts`, `server/model-host.ts`: every sanitized text as a `ServerText` key, rendered with the request language (§5.2); `/api/status` `reason` per request; `model: 'cli-default'` marker (R27).
- `server/index.ts`, `server/model-host.ts`: English terminal and configuration texts (R26).
- `server/tools/registry.ts`: `label: Localized`, checked 1–40 characters per language; every `server/tools/*.ts`: display name pair and summaries from `TOOL_TEXT[langOf(state)]` (§5.3); `server/tools/joint-helpers.ts` reuses `shared/i18n/joints.ts`.
- `server/agent.ts`: `workspaceSnapshot`, `jointSnapshotLines` and `agentTask` labels from `server/i18n/snapshot.ts` (§5.4); the `tool` event label in the request language.
- Internal texts English (R57): the `refine` message and `validateAgentStep` errors in `shared/agent.ts`.
- Other specs' shared and server text modules, converted in place (design §10, second table): `shared/fidelity-text.ts`, `shared/fit-text.ts`, the `TEXT` constants of their new tool files, `shared/demo-bracelet.ts` (per-language names), and their additions to `shared/workspace.ts` `MESSAGES`. Keep paths and export names; add each converted file to `TABLE_FILES` in `tests/unit/i18n-files.ts`.

**Tests:**
- Extend `tests/unit/i18n-server.test.ts` and create `tests/unit/i18n-text.test.ts` with the T3 cases of design §5.5.
- Existing tests: only add `'zh-TW'` where a signature gained `lang`, and read `label['zh-TW']` where a test read a tool's `label`. Expected texts never change (R45). List every touched test file in the report with "call arguments only".
- `i18n-scan.test.ts` must list no file in `shared/` or `server/` after this task (still report mode).
- E2E at the end: `tests/e2e/agent-panel.spec.ts`, `joints.spec.ts`, `export.spec.ts`, `workbench.spec.ts` (they show server texts and shared labels).

**Dependencies:** Task 2. The other specs' tasks that edit `shared/` or `server/` files of the Build list are done (check their `tasks.md`); if one is not, stop and report which.

**Done when:** `npm run check` passes, the tests above are green, the four e2e specs pass, the scan shows no `shared/` or `server/` file, and the report lists the touched existing tests.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. Most files in this task are shared with other specs: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- **Move, do not rewrite** (R45): every zh-TW string keeps every character. Where two places held the same text (method labels in `src/joints/labels.ts`, `shared/export-plan.ts` and `server/tools/joint-helpers.ts`; glue names in `shared/kit.ts` and `shared/standard-parts.ts`), make one key with that text. If two copies differ, keep both texts and report it.
- English wording follows the glossary in design §11. Brand words (Forgehand, Codex CLI, Claude Code CLI, OpenAI API), standard designations (M3, ISO 4762), material abbreviations (PLA) and CLI commands (`codex login`, `claude auth login`) stay as they are in both languages.
- The server never logs prompts, tool arguments, provider output or raw CLI diagnostics; error texts returned to the model or the client are fixed texts without Zod text (`.kiro/steering/structure.md`). Nothing about this changes.
- Requests without `Accept-Language` must behave exactly as today (R19).
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- E2E: set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and `PLAYWRIGHT_GPU=1` as in Task 2; never download browsers or MediaPipe models.
- No real model calls; never run `verify:real` or `verify:edit`. Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(i18n): localize shared rules and server texts (spec english-ui, task 3)`).
- Code, comments and reports are English.

---

## Task 4 — Workbench strings and switch behaviour

`[ ]` · P0 · Requirements: R10, R11, R15–R17, R27 (browser), R38, R39, R40 (join cue), R46 (browser), R60, N3

The main screen in both languages: `App.tsx`, the agent panel, the 3D view, the objects panel, and everything `workbench-ui` added there. Notices become descriptors so they re-render on a switch; server texts and the agent log are cleared on a switch; the switch is disabled while a request runs.

**Read first:** design §3.6, §6, §9, §11, §12; requirements R7, R10, R11, R15–R17, R27, R34, R38–R40, R46, R60, N3; `src/App.tsx` (all of it); `src/agent/AgentPanel.tsx`, `labels.ts`, `run-reducer.ts`, `request.ts`, `useAgentRun.ts`; `src/scene/SceneViewport.tsx` (`onError` calls, the canvas `aria-label`, the join-cue sprite around the text 可以接合); `src/scene/geometry.ts`; `src/workspace/ObjectPanel.tsx`, `object-panel.ts`, `app-rules.ts`; every file `workbench-ui` created (its `tasks.md`); the scan output for `src/`; Task 1's `ui-text.ts`; Task 3's `workspaceErrorText`, `editErrorText`, `demoModelFor`, `unknownToolLabel`; `tests/unit/run-reducer.test.ts`, `app-rules.test.ts`, `object-panel.test.ts`; `tests/e2e/workbench.spec.ts`, `edit-select.spec.ts`, `agent-panel.spec.ts`, `workspace.spec.ts`.

**Build:**
- Tables: `src/i18n/app.ts`, `agent.ts`, `scene.ts`, `workspace.ts` (design §6).
- `src/App.tsx`: every string from the tables; shown-text state as `UiText` (§3.6, §6.1); `demoModelFor(lang)`; the `cli-default` marker; R46 for the adjust failure.
- Switch behaviour (§6.2): `LanguageSwitch` `disabled` and `disabledReason` (R7); the effect on a switch (clear raw texts, `agent.clearDisplay()`, the pending-decision line, R34's short notice).
- `src/agent/*` (§6.3): tables, `resultText(result, lang)`, the reducer's data-only entries, `clearDisplay`.
- `src/scene/SceneViewport.tsx`: `labels` prop with the canvas name, the error texts and the join cue (§6.4). `src/scene/geometry.ts`: internal texts English (R57).
- `src/workspace/*` (§6.4).
- `src/workbench/text.ts` (workbench-ui's module), converted in place into a `defineText` table with English; add it to `TABLE_FILES`. Its components keep their imports; if they build text outside the module, move that text in and give the functions `lang`.
- `src/styles.css` only if English text overflows at 1440 × 1000 or in the one-column layout (N3); check `git status` first.

**Tests:**
- Extend `tests/unit/i18n-text.test.ts` with design §6.5.
- `tests/unit/run-reducer.test.ts`: update to the new entry shape (§6.3); report the change. Other existing tests: call arguments only.
- The scan lists no file of this task's Build list.
- E2E at the end: the full suite, in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-english-ui-task4.log`), with a timeout of at least 30 minutes; read the file when it finishes.

**Dependencies:** Task 3. `workbench-ui`'s tasks that edit `src/App.tsx`, `src/agent/*`, `src/scene/SceneViewport.tsx` or `src/workspace/*` are done (check its `tasks.md`); if one is not, stop and report which.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes without edits to any existing e2e spec (`git diff --stat tests/e2e` shows nothing), and `http://…/?lang=en` shows the main screen in English (one screenshot at 1440 × 1000 attached to the report from a throw-away Playwright check or the trace).

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/App.tsx`, `src/styles.css`, `src/agent/*`, `src/scene/*` and `src/workspace/*` are shared with `workbench-ui` and other specs: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- **Move, do not rewrite** (R45). Every e2e spec selects controls by exact zh-TW names; if one fails, find the string that changed and restore it. Never edit an existing e2e spec.
- React pitfall: `setMessage(lang => …)` is taken as an updater. Always store a `UiText` object: `setMessage(ui(lang => APP_TEXT[lang].demoLoaded))` (design §3.6).
- The decorative English labels (FORGEHAND, LIVE WORKSPACE, AGENT, SELECT & ADJUST, MODEL DETAILS, CONCEPT / 01, EDIT THIS CONCEPT, CREATE A CONCEPT) stay English in both languages (decision 7); do not move them into tables unless the user decided otherwise.
- User content (names, summaries, assumptions, replies) is never put into a table and never translated.
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- E2E: set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and `PLAYWRIGHT_GPU=1` as in Task 2; never download browsers or MediaPipe models. The full suite takes about 25 minutes on this 2-core laptop.
- No real model calls; never run `verify:real` or `verify:edit`. Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(i18n): localize the workbench, agent panel and 3D view (spec english-ui, task 4)`).
- Code, comments and reports are English.

---

## Task 5 — Hands, joints, printer settings and the export kit

`[ ]` · P0 · Requirements: R12, R13 (browser part), R14, R28–R31, R40 (badges), R57, N3

The feature panels and the kit files in both languages: the hand status line, badges and debug line; the joints panel, the joint card and the printer settings; the export dialog and the BOM, assembly sheet and 3MF; and whatever `body-fit` and `design-fidelity` added to these areas.

**Read first:** design §3, §7, §9, §11, §12; requirements R12–R14, R28–R31, R40, R57, N3; `src/hands/text.ts`, `controller.ts` (constructor options, the `badge:` line), `useHandControl.ts`, `HandDebugPanel.tsx`; `src/joints/labels.ts`, `card-model.ts`, `JointCard.tsx`, `JointPanel.tsx`, `PrinterPanel.tsx`, `mouse-join.ts`; `src/print/printable.ts`; `src/export/ExportDialog.tsx`, `dialog-model.ts`, `findings.ts`, `bom.ts`, `sheet.ts`, `threemf.ts`, `pieces.ts`, `prepare.ts`; the files `body-fit` and `design-fidelity` added under `src/` (their `tasks.md`); the scan output; `.kiro/specs/export/requirements.md` R13, R16, R29–R39 (the kit texts); `tests/unit/hand-gate.test.ts`, `hand-controller.test.ts`, `joint-ui.test.ts`, `export-docs.test.ts`, `export-dialog.test.ts`, `export-writers.test.ts`; `tests/e2e/hand-control.spec.ts`, `joints.spec.ts`, `export.spec.ts`.

**Build:**
- Tables: `src/i18n/hands.ts`, `joints.ts`, `export.ts` (design §7).
- `src/hands/*` (§7.1): `lang` in the text functions; `HandController` option `lang` and `setLang`; `useHandControl` and `HandDebugPanel` pass `useLang().lang`.
- `src/joints/*` (§7.2): tables, `findingText` in every display, `askAgentText(a, b, lang)`.
- `src/export/*` (§7.3): tables, `lang` in `KitInput` and the writers, `<html lang>` and `xml:lang`, `sameSnapshot` with `lang`.
- `src/print/printable.ts`, the `AbortError` text of `src/export/pieces.ts`: English internal texts (R57).
- `src/fidelity/**` and `src/fit/**`: their components read `shared/fidelity-text.ts` and `shared/fit-text.ts` (converted in Task 3) with `useLang()`; any text they still build inline moves into those modules. `design-fidelity`'s `COMPONENT_SEALED` finding moves with the other export findings. `workbench-ui`'s additions to `src/hands/text.ts` move with the existing hand texts.
- `src/styles.css` only if English text overflows (N3); check `git status` first.

**Tests:**
- Extend `tests/unit/i18n-text.test.ts` with design §7.4.
- Existing tests: call arguments only (`'zh-TW'`). List the files.
- The scan lists no file at all (still report mode); if a file remains, it is either a Task 4 file another spec changed after Task 4 (move it now and report) or an entry for `SCAN_ALLOWED` with a reason (report it).
- E2E at the end: the full suite, as in Task 4.

**Dependencies:** Task 4. The other specs' tasks on `src/hands/*`, `src/joints/*`, `src/print/*`, `src/export/*` and `src/try-on/*` are done (check their `tasks.md`); if one is not, stop and report which.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes with `git diff --stat tests/e2e` empty, the scan list is empty or every remaining line is justified, and the report includes the English BOM header row and the first lines of an English `assembly.html` from a unit test's output.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/hands/*`, `src/joints/*`, `src/print/*`, `src/export/*`, `src/styles.css` are shared with other specs: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- **Move, do not rewrite** (R45). The export e2e unpacks the zip and the joints and hand e2e read badges and notices in Chinese; never edit an existing e2e spec.
- Kit file paths never change (R29). `bom.csv` keeps the byte-order mark, CRLF and the formula guard (R30). Every model-written name stays escaped in XML, HTML, Markdown and CSV in both languages.
- The hand controller runs per video frame: build badge text only where it is built today; do not allocate tables per frame (they are constants).
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- E2E: set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and `PLAYWRIGHT_GPU=1` as in Task 2; never download browsers or MediaPipe models.
- No real model calls; never run `verify:real` or `verify:edit`. Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(i18n): localize hand control, joints and the export kit (spec english-ui, task 5)`).
- Code, comments and reports are English.

---

## Task 6 — Turn English on: content language, English e2e and READMEs

`[ ]` · P0 (R9, R34, R41, R43, R48 strict, R50, R52) · P1 (R35, R42) · P2 (R36, built last)

English becomes the default for English browsers; the scan becomes strict; the switch notice tells the user that earlier content keeps its language and the details panel marks such an object; the English e2e spec runs in the default suite; both READMEs are updated. Last, the P2 translate button and its text-only tool. The task ends with the manual checks.

**Read first:** design §8, §9, §10, §12; requirements R9, R33–R36, R41–R43, R48, R50, R52, N1–N4; `src/i18n/lang-store.ts`; `tests/unit/i18n-scan.test.ts`; `shared/i18n/content.ts`; in `src/App.tsx`: the model details panel (search `MODEL DETAILS`) and the switch effect of Task 4; `src/joints/labels.ts` `askAgentText` and the 請代理建議 path (the pattern for a fixed agent instruction); `shared/workspace.ts` (an existing operation such as `renameObject`, and `WorkspaceError`); `server/tools/edit-design.ts` (a `model` state change); `server/tools/index.ts`; `tests/e2e/workbench.spec.ts`, `export.spec.ts`, `agent-panel.spec.ts`, `fake-hands.ts` (routing and fixture patterns); `README.md`; `docs/zh/PITCH.zh-TW.md` (tone of the existing Chinese docs); `.kiro/steering/product.md`, `hackathon.md`, `tech.md`.

**Build (in this order):**
1. `src/i18n/lang-store.ts`: `ENGLISH_UI_READY = true`. `tests/unit/i18n-scan.test.ts`: `STRICT = true`; `SCAN_ALLOWED` empty or each entry with a reason.
2. `src/i18n/content.ts` and `src/App.tsx`: R34's notice with both variants; R35's line in the model details panel using `differsFromUi` (§8.2).
3. New `tests/e2e/english.spec.ts` (§8.5), with English fixtures inside the file or in a new `tests/fixtures/english-workspace.ts`.
4. `README.md` (R41) and new `README.zh-TW.md` (R42); new `tests/unit/readme-sync.test.ts` (R43).
5. Steering proposal: write the proposed new lines for `.kiro/steering/product.md` (the language paragraph), `hackathon.md` ("Language" section) and `tech.md` (the i18n conventions of design §12) **into the report only**. Do not edit steering; the user decides.
6. **P2, last:** `shared/workspace.ts` `setObjectTexts`; new `server/tools/set-texts.ts`, registered last in `server/tools/index.ts`; one rule line in `AGENT_INSTRUCTIONS` (`server/agent.ts`); the translate button next to R35's line (§8.3). Tests for it: `setObjectTexts` (only texts change; unknown object and part ids rejected; geometry, ids and joints identical), `set_texts` via the fake provider (label pair, summary in both languages, `writes-scene`, one undo step in `apply-state`), and one e2e step inside test 4 of `english.spec.ts` (a routed `set_texts` state frame renames the demo parts and 復原 / Undo restores them). If time is short, report before starting step 6; the user decides.

**Tests:**
- `tests/e2e/english.spec.ts`: six tests (§8.5); report the run time.
- `tests/unit/readme-sync.test.ts`; `tests/unit/i18n-scan.test.ts` strict and green.
- Extend `tests/unit/i18n-core.test.ts` with `initialLang` for `ready: true` (stored choice and browser now apply).
- E2E at the end: the full suite once, as in Task 4; report its total time next to the 25-minute baseline.

**Dependencies:** Task 5.

**Done when:** `npm run check` passes; the strict scan is green; the full e2e suite passes with `git diff --stat tests/e2e` showing only `english.spec.ts` (and a new fixture file if any); the English spec takes about 3 minutes or less (report the number); `npm run build` output shows the main chunk size before (from the last commit) and after (N2); the report includes the steering proposal and hands the user the manual list below.

### Manual check (user's machine)

Run `npm run dev` and open the address it prints. These steps spend model quota in steps 3–5; run them only when you want to.

1. **Default and switch.** Open the page in a browser set to English (or with `?lang=en`): the whole workbench is English. Press 繁體中文: everything is Chinese, and the status line says 已切換為繁體中文。. Reload: still Chinese. Press English again. Open `?hands=debug` with the camera on: the debug line is English.
2. **Hands and joints in English.** Turn on the camera, load the demo twice (Load demo model), point at a part: the badge reads Hand: pointing at …. Join the two objects with Add joint, read the joint card (method, load, disassembly, findings), open Printer settings.
3. **Real generation in English.** With English active, type a description in **Chinese** (for example 一個有兩個按鈕的藍色遙控器) and press Generate 3D draft: the object name, part names and assumptions come back in English (R25).
4. **Real agent reply in English.** In the agent panel, ask "Make the housing orange and show the exploded view": tool names (Edit design, Exploded view) and the reply are English. Switch to 繁體中文: the log is cleared with R39's line; ask 把它收回: the reply is Chinese, and the English object shows the hint 這個物件的名稱與說明是英文。.
5. **Translate (P2, if built).** Press 翻譯成中文: the names change to Chinese, the geometry does not move, and 復原 restores the English names.
6. **Kit in English.** Switch to English, Export kit, Download full kit, unzip. Open `bom.csv` in a spreadsheet (headers English, Chinese names of older objects intact), `bom.md`, `assembly.html` (English, prints to A4), and `kit.3mf` in your slicer (piece names P01 … in English).
7. **Layout.** In English, look at the top bar, the parts panel, the joint card and the export dialog at your normal window size and with a narrow window: no text runs out of its box. Take one screenshot of each problem you find.
8. **READMEs.** Read the "Language" section of `README.md` and open `README.zh-TW.md` from its link.

**Report:** anything shown in the wrong language (with a screenshot), whether the real generation and reply came back in English, how long the switch felt, the layout problems, and the kit files that looked wrong.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Their uncommitted changes are expected. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. `src/App.tsx`, `shared/workspace.ts`, `server/agent.ts`, `server/tools/index.ts` and `README.md` are shared with other specs: check `git status --short` for each before its first edit and stop and ask if it shows changes.
- Do not edit `.kiro/steering/*` or `docs/PRIOR_WORK.md`; write the steering proposal into the report.
- `README.md` must still let a judge install and run the project from it alone (`.kiro/steering/hackathon.md`). Keep the MIT `LICENSE` untouched.
- E2E: set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and `PLAYWRIGHT_GPU=1` as in Task 2; never download browsers or MediaPipe models. The English spec uses `test.use({ locale: 'en-US' })`; every other spec keeps the pinned `zh-TW` locale.
- `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests; never run `verify:real` or `verify:edit`. The manual check's model steps are the user's own action. Do not add dependencies.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Only the user decides cuts: do not drop step 6 or any other item on your own; report if it does not fit.
- Do not commit; the reviewer commits (suggested message: `feat(i18n): turn on the English UI and document both languages (spec english-ui, task 6)`).
- Code, comments and reports are English.

---

## Cut order

**Only the user decides whether anything is cut.** A Kiro session never drops or simplifies a feature on its own; it reports the problem, and the reviewer asks the user. Reference order (requirements, "Priorities and build order"):

1. **Translate on request** (Task 6 step 6, R36). The hint of R35 stays and says "You can ask the agent to translate them" without a button.
2. **Per-object hint** (Task 6 step 2, R35). R34's notice stays.
3. **Full Chinese README** (Task 6 step 4, R42). `README.md` links to `docs/zh/` for the pitch and vision; the sync test is dropped.
4. **English debug line** (Task 5, R12's `?hands=debug` part). The debug panel stays Chinese and is excluded from the scan by one `SCAN_ALLOWED` entry with that reason.

Dropping an item removes its README and manual-list lines; say so in the last report.

## Requirement-to-task map

The full map is design §13. In short:

| Task | Waits for | Requirements |
|---|---|---|
| 1 | nothing | R1, R18, R47, R48 (report), R53, R54, R56 |
| 2 | Task 1; clean shared files | R2–R9, R19, R23, R25, R44, R59 |
| 3 | Task 2; other specs' `shared/` and `server/` tasks | R13 (shared), R20–R22, R24, R26, R27, R32, R37, R45, R46, R55, R57, R59 |
| 4 | Task 3; workbench-ui | R10, R11, R15–R17, R27, R38–R40, R46, R60, N3 |
| 5 | Task 4; other specs' feature tasks | R12, R13 (browser), R14, R28–R31, R40, R57, N3 |
| 6 | Task 5 | R9, R33–R36, R41–R43, R48 (strict), R50–R52, N1, N2, N4 |

R45, R58 and N5–N8 apply to every task.
