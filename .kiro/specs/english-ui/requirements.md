# English UI with a language switch — Requirements

> Status: draft for review, 2026-11-26. Capability C16 in `docs/VISION.md` (§2, P0; §5 phase D). `design.md` and `tasks.md` build on this version. The open decisions are at the end; each has a recommendation, and the requirements below follow the recommendations until the user decides otherwise.

## Overview

Forgehand is judged by an international audience, but every user-facing string is Traditional Chinese today. A scan of the code on 2026-11-26 found 691 code lines with CJK characters outside comments (366 in `src/`, 126 in `shared/`, 199 in `server/`), in about 70 files, plus the language lines of the three model instruction texts (`MODEL_INSTRUCTIONS` and `EDIT_INSTRUCTIONS` in `server/provider.ts`, `AGENT_INSTRUCTIONS` in `server/agent.ts`). The tests depend on that text: the e2e specs select controls by exact Traditional Chinese accessible names (for example `getByRole('button', { name: '載入示範模型', exact: true })` in `tests/e2e/workbench.spec.ts`), and many unit tests compare Chinese messages.

This spec adds a full English UI and a language switch. The user picks 繁體中文 or English; the choice survives a reload; every string the user sees follows it, including the hand badges, the hand debug panel, the joint card, the export dialog, the server's sanitized errors, the tool names in the agent panel, the agent's own replies, the names the model gives new parts, and the files of the exported kit. Content that already exists in the other language is kept as it is, and the UI says so.

The approach is a small in-house set of typed string tables, one per area, with both languages side by side, and an explicit language parameter wherever text is built. No dependency is added (decision 1). The first two tasks build the core and the language plumbing and can land early, so that the other specs being built now (`workbench-ui`, `design-fidelity`, `body-fit`) can put new strings into the tables from the start. The string extraction tasks run late, after those specs have finished with the same files.

**Numbering.** Requirement ids (R1, R2, …) are stable, because `design.md` and `tasks.md` refer to them.

**Terms.**
- **Language**: `zh-TW` (Traditional Chinese, shown as 繁體中文) or `en` (English, shown as English).
- **User-facing string**: any text a person can read in the running product: visible text, accessible names and descriptions, `title` attributes, placeholders, the page title, text drawn on canvases or sprites, notices and errors shown in the browser (including server messages that reach it), the agent panel, the hand debug panel (`?hands=debug`), and the content of exported files. Model-facing text (instructions, the workspace snapshot, tool summaries) is treated the same way, because it shapes what the user reads (R24).
- **Not user-facing**: code comments, identifiers, part and object ids, test names, the developer scripts `scripts/verify-real-*.ts`, standard designations (M3, ISO 4762), material abbreviations (PLA, PETG), units (mm, cm³), and brand words (Forgehand, Codex CLI, Claude Code CLI, OpenAI API).
- **User content**: text the user typed or a model wrote into the workspace: object and part names, summaries, assumptions, explanations, agent replies and instructions.
- **Table**: a typed string module with both languages (design §3).

## Goals

- A judge who opens Forgehand in an English browser sees an English workbench without doing anything, and a Taiwanese user sees Traditional Chinese.
- One click switches the whole UI, without a reload and without losing work; the choice is remembered.
- The agent and the generation and edit services answer in the chosen language.
- An exported kit (BOM, assembly sheet, 3MF names) is in the language that was active at export time.
- No screen mixes two UI languages. User content made in the other language is the only exception, and the UI says so.
- Every existing test keeps passing with its Chinese names and messages; English is covered by table checks, unit tests and a short English e2e spec that adds at most about 3 minutes to the 25-minute suite.
- The other specs can add strings while this spec is built, without merge conflicts and without a second extraction pass.

## Out of scope

`docs/VISION.md` places these elsewhere:

- Voice input and spoken replies (C15, `voice`); this spec only makes sure the agent's text replies follow the language.
- Saving and reopening projects (C17, `projects-memory`). No workspace is stored across reloads today (the only `localStorage` use is the printer profile, `src/joints/printer-store.ts`). When C17 stores workspaces, R33–R36 apply to them unchanged.
- Changes to the generation rules themselves (`design-fidelity`, VISION §4.10: "The English UI spec changes the language line of `MODEL_INSTRUCTIONS` separately from these rules.").

Nothing else is excluded. Languages other than these two are not part of C16.

## Functional requirements

### Language choice

- **R1. Two languages.** The product supports exactly `zh-TW` and `en`. The type `Lang = 'zh-TW' | 'en'` and the Zod schema `LangSchema` live in `shared/i18n/lang.ts` and are the only definition.
- **R2. Default language (decision 2).** On first visit the language comes from the browser: if the first entry of `navigator.languages` (or `navigator.language`) starts with `zh` (any region, including `zh-CN`, because only Traditional Chinese exists), the language is `zh-TW`; otherwise `en`. With no browser language, `en`.
- **R3. Stored choice.** A choice the user makes in the switch is stored in `localStorage` under `forgehand.lang.v1` as `"zh-TW"` or `"en"`, and wins over R2 on every later visit. A missing, invalid or unreadable value is ignored; when storage is blocked the choice lasts for the page session, like the printer profile (`savePrinterProfile` in `src/joints/printer-store.ts`).
- **R4. URL override.** `?lang=en` or `?lang=zh-TW` sets the language for that page load (for the demo video, screenshots and tests). It is not stored. An unknown value is ignored.
- **R5. The switch.** A language switch is always visible in the top bar (or, once `workbench-ui` has replaced the top bar, in the place its design gives global settings). It is a group of two toggle buttons with `aria-pressed`, each named in its own language: 繁體中文 and English. The group's accessible name is 介面語言 in zh-TW and Interface language in en. These names do not collide with any existing selector.
- **R6. Switching is immediate.** Pressing the other language re-renders every visible string in the new language within one render, without a page reload and without changing the workspace, the undo history, the selection, the camera, hand tracking, the try-on or the exploded view. A switch is never an undo step.
- **R7. Switching while busy (decision 6).** While a generation, an edit or an agent run is in progress, both buttons are disabled with the description 生成、修改或代理執行中，完成後才能切換語言。 / You can switch the language when the current generation, edit or agent run is finished. An answer therefore always arrives in the language it was asked in.
- **R8. Document language.** `<html lang>` is `zh-Hant-TW` for zh-TW and `en` for en, and `document.title` is `Forgehand｜3D 概念工作台` / `Forgehand | 3D concept workbench`. Both update on a switch.
- **R9. Feature gate until done.** Until the last task (T6) turns English on, the default stays `zh-TW` for everyone and the switch is shown only when the page has a `?lang=` parameter, so the product never shows a half-translated screen while the extraction tasks are in progress. One named constant (`ENGLISH_UI_READY` in `src/i18n/lang-store.ts`) controls this.

### What the UI translates

- **R10. Workbench.** Every string of `src/App.tsx` and the components it renders: top bar, stage labels and captions, camera and try-on controls and statuses, undo and redo, exploded view controls, the generate and edit forms, their placeholders and counters, the approximation, clarify, conflict and edit-summary boxes, the parts panel and its fields, the model details panel, the service status, the footer, and the default prompt (一個紅色、有四條腿的小桌子 / A small red table with four legs).
- **R11. Notices and status lines.** Every notice set from the browser (for example 已載入預先建立的示範模型，這不是 AI 生成結果。 / Loaded the prepared demo model. It was not generated by AI.) and every client-side error text (camera errors, request failures, validation failures, render errors) follows the current language, and a notice that is already on screen changes language on a switch (R38).
- **R12. Hand control.** The status line under the camera (`handStatus` in `src/hands/text.ts`), the hand badges (`badgeText`, for example 手勢：對準 外殼 / Hand: pointing at Housing), the `?hands=debug` line (`trackingDebugLine`, `debugLine`), and the 可以接合 / Ready to join cue drawn as a sprite in `src/scene/SceneViewport.tsx`.
- **R13. Joints and printing.** The 接合 / Joints panel, the joint card, the mouse-join status lines, all labels of `src/joints/labels.ts` and `src/joints/card-model.ts`, the 列印設定 / Printer settings panel, the 預覽「…」列印件 / Preview "…" print piece button, and the joint findings and recommendation reasons of `shared/joint-rules.ts`, the face labels of `shared/joint.ts` (右面 / Right face …), the material labels of `shared/materials.ts`, the glue and insert labels of `shared/standard-parts.ts`, and the standard-part labels and assembly notes of `shared/kit.ts`.
- **R14. Export dialog.** Every string of `src/export/ExportDialog.tsx` and `src/export/dialog-model.ts`, and the export findings of `src/export/findings.ts`.
- **R15. Agent panel.** The panel's fixed texts (`src/agent/AgentPanel.tsx`: 交給代理處理 / Hand it to the agent, 執行 / Run, 取消 / Cancel, the status words), the fixed result lines of `resultText` (`src/agent/labels.ts`), the 進行中 / In progress line of `src/agent/run-reducer.ts`, the client error texts of `src/agent/request.ts` and `src/agent/useAgentRun.ts`, and the tool display names (R21).
- **R16. 3D view.** The canvas accessible name and the render errors of `src/scene/SceneViewport.tsx`, and any error of `src/scene/geometry.ts` that reaches the screen.
- **R17. Objects panel.** `src/workspace/ObjectPanel.tsx`, the validation texts of `src/workspace/object-panel.ts` and the notices of `src/workspace/app-rules.ts`.
- **R18. Formatting.** Each language has its own punctuation and number phrasing, from one set of helpers (`shared/i18n/format.ts`): quotes (「外殼」 / “Housing”), list separators (、 / , ), colons and parentheses (full-width in zh-TW, ASCII in en), and English singular and plural (1 part / 2 parts) through `Intl.PluralRules`. Numbers, units and decimal places are the same in both languages.

### Server and agent

- **R19. How the server learns the language (decision 3).** The browser sends `Accept-Language: en` or `Accept-Language: zh-TW` on every `/api/*` request, from one helper. The server reads it once per request with `langFromHeader` (`shared/i18n/lang.ts`): the first language tag decides, a tag starting with `en` gives `en`, anything else (including a missing header) gives `zh-TW`. Existing clients and tests that send no header therefore get today's behaviour.
- **R20. Sanitized errors.** Every error message the server returns or streams is a fixed text in the request language: the JSON errors of `server/app.ts` (including `INVALID_JSON`, `REQUEST_TOO_LARGE`, `NOT_FOUND`, `ORIGIN_REJECTED` and `BUSY`), the `error` events of `/api/agent` (`AGENT_TIMEOUT_MESSAGE` and the others in `server/agent.ts`), every `GenerationError` message of the adapters (`server/provider.ts`, `server/codex.ts`, `server/claude.ts`, `server/app-server.ts`, `server/model-host.ts`), and the `reason` of `/api/status`. A message is chosen by its code and parameters, never by translating text, and never contains provider output, Zod text, prompts or keys (the security posture in `.kiro/steering/structure.md` is unchanged).
- **R21. Tool display names.** Each registered tool has a display name in both languages (for example 準備匯出 / Prepare export, 生成設計 / Generate design). `defineTool` checks that each is 1–40 characters, as it does for `label` today (`server/tools/registry.ts`), and the `tool` event carries the name in the request language.
- **R22. Tool summaries.** Every tool's `summary` and its fixed error texts (`server/tools/*.ts`, `server/agent-tools.ts`, `server/tools/helpers.ts`, `server/tools/joint-helpers.ts`) are written in the request language. User content inside them (object and part names) is quoted as it is.
- **R23. Instructions.** `MODEL_INSTRUCTIONS`, `EDIT_INSTRUCTIONS` and `AGENT_INSTRUCTIONS` stay English, except their language lines, which name the request language: "All user-facing names, summary, assumptions, and explanation use English." or "… use Traditional Chinese (繁體中文)." The agent instructions also quote UI names in the request language (press Download full kit / 下載完整套件; hide or show the camera image / 隱藏或顯示鏡頭畫面). The edit rule that lists the words for "this" keeps both languages' words ("this", "it", "these", "這個", "它", "這些"), because a user may type either. The geometry rules (`GEOMETRY_RULES`) are unchanged and shared, so an edit still uses the same units and primitives as generation.
- **R24. Model-facing text.** The per-round workspace snapshot (`workspaceSnapshot`), the history and tool-log labels of `agentTask` (使用者： / User:, 回覆： / Reply:, 工具呼叫 / Tool call, 結果 / Result) and the joint lines of the snapshot are in the request language, so the model sees one language besides user content.
- **R25. Answer language (decision 4).** Generation, edits and the agent answer in the request language, also when the user types in the other language. New part names, summaries, assumptions, explanations, notes and final replies are therefore in the UI language.
- **R26. Server terminal output (decision 11).** The startup lines of `server/index.ts` and the configuration errors of `server/index.ts` and `server/model-host.ts` are English, because they are read in a terminal by whoever runs the project from the README. They are not localized per request.
- **R27. Model label.** The model name shown in the service status for a CLI without a configured model (today the literal CLI 設定預設 from `server/model-host.ts`) is shown as CLI 設定預設 / CLI default by the browser; the server sends a language-neutral marker instead of the Chinese text.

### Export kit

- **R28. Kit language.** The kit is written in the language that is active when the dialog prepares it: `bom.csv` headers and category values (列印件 / Printed, 外購件 / Bought, 加工件 / Machined, 標準件 / Standard), `bom.md`, `assembly.html` (with `<html lang="zh-Hant-TW">` or `<html lang="en">`, and the image `alt`), the 3MF `xml:lang` attribute and piece names (「P01 外殼」（雙鏡頭概念裝置） / P01 Housing (Dual-lens concept device)), and the export findings inside the files.
- **R29. File names unchanged.** Every path in the kit stays the same in both languages (`assembly.html`, `exploded.png`, `bom.csv`, `bom.md`, `kit.3mf`, `workspace.glb`, `stl/P01-{part id}.stl`, `forgehand-kit-{yyyyMMdd-HHmm}.zip`). They are already ASCII (export R13, R20).
- **R30. CSV encoding unchanged.** `bom.csv` keeps UTF-8 with a byte-order mark, CRLF and the formula guard in both languages (export R33).
- **R31. A switch re-prepares.** The language is part of the dialog's snapshot (export R2): a switch while the dialog is open discards the prepared kit and prepares it again before a download is allowed, with the notice of export R2 in the new language.
- **R32. Agent summary.** `prepare_export`'s summary (`exportSummary` in `shared/export-plan.ts`, and `server/tools/prepare-export.ts`) follows the request language.

### Content that already exists in the other language

- **R33. Never translated silently (decision 5).** Switching never changes user content. Object and part names, summaries, assumptions, joint side names (built from object and part names) and agent history stay as they were written.
- **R34. The switch says so.** When the workspace has at least one object at the moment of a switch, the status line shows 已切換為繁體中文。之前產生的物件名稱、零件名稱與說明會保留原本的語言，需要時可以請代理翻譯。 / Switched to English. Object names, part names and notes made earlier keep their original language. You can ask the agent to translate them. With an empty workspace it shows 已切換為繁體中文。 / Switched to English.
- **R35. Per-object hint.** The model details panel shows, for the active object, 這個物件的名稱與說明是英文。 / This object's names and notes are in Chinese. when its name, part names, summary or assumptions look like the other language: for en, any CJK character; for zh-TW, no CJK character at all in the object name and every part name together. The test is a pure function (`contentLang` in `shared/i18n/content.ts`).
- **R36. Translate on request (P2).** Next to the hint of R35, a button 翻譯成中文 / Translate to English starts an agent run with a fixed instruction (請把「{object}」的物件名稱、零件名稱、說明與假設翻譯成繁體中文，其他內容都不要改。 / Translate the object name, part names, summary and assumptions of "{object}" into English. Change nothing else.). A new server tool `set_texts({ objectId, name, summary, assumptions, parts: [{ partId, name }] })`, effect `writes-scene`, display name 更新名稱與說明 / Update names and notes, changes only these text fields of one object, so geometry, ids, colours and joints cannot change; the result is one undo step. Regenerating the model in the other language is not offered (decision 5).
- **R37. Demo model per language.** 載入示範模型 / Load demo model loads the demo in the current language (`shared/demo.ts`: 雙鏡頭概念裝置 / Dual-lens concept device, 外殼 / Housing, …), and so does any other demo a spec adds (for example `body-fit`'s `shared/demo-bracelet.ts`). Part ids and geometry are identical in both languages. A demo already in the workspace keeps its names (R33).

### What happens to transient text on a switch

- **R38. Client notices re-render.** Notices and errors created in the browser are stored as message descriptors, not as finished text, so they re-render in the new language (design §4.3).
- **R39. Server text is cleared.** Text that came from the server in the old language (an error shown from a response body, the agent log, the agent's note and reply, the clarify and approximation explanations, the edit summary) is removed from the screen on a switch, and the agent panel shows 已切換語言，先前的執行紀錄已清除；代理仍記得先前的對話。 / Language changed. The earlier run log was cleared; the agent still remembers the conversation. The agent history sent to the server (`AgentTurn[]`) is kept. A pending approximation or conflict decision is not cleared: its buttons switch language, and its explanation stays visible with the line 這段說明是英文。 / This explanation is in Chinese., so the user can still decide (decision 6).
- **R40. Canvas text.** The join cue sprite and the hand badges are redrawn with the new language on the next frame.

### README

- **R41. English README.** `README.md` stays the English README. Where it names a control, it uses the English label, with the Chinese label in parentheses at its first mention in each section, so users of either UI can find it (for example "Export kit (匯出套件)"). It gains a short "Language" section: the switch, the default, `?lang=`, that existing content is not translated, and the translate button.
- **R42. Chinese README (decision 10).** A full Traditional Chinese README lives at the repository root as `README.zh-TW.md` (decided 2026-11-26: not under `docs/zh/`, which is git-ignored and holds internal notes, so a README there would never be published), and is linked from the first lines of `README.md`; it links back.
- **R43. Kept in sync.** Both READMEs have the same sections in the same order. A unit test compares their `##` heading counts and fails when one file gains or loses a section. A change to one README updates the other in the same commit.

### Tests

- **R44. Existing e2e unchanged.** Every existing e2e spec passes without edits. The Playwright config pins the browser locale to `zh-TW` (`use.locale`), so the default language of R2 is Chinese in the suite on every machine, also on a judge's English machine.
- **R45. Chinese text unchanged.** Moving a string into a table never changes its zh-TW text, so every existing assertion stays valid. Where two tables held the same text (for example the method labels in `src/joints/labels.ts`, `shared/export-plan.ts` and `server/tools/joint-helpers.ts`), they become one key with that text. The only zh-TW change allowed is R46.
- **R46. No raw internal text on screen.** Internal error text that reaches the screen today (a Zod message or a `validateModel` message appended to 這個調整未通過資料驗證，未套用。 in `src/App.tsx`, and to the `INVALID_EDIT` message in `server/app.ts`) is replaced by a fixed message for its code in the current language. If an existing test asserts the appended raw text, the task stops and reports.
- **R47. Table completeness.** The type checker rejects a table whose English side lacks a key or has a different parameter list. A unit test also walks every table at run time: both languages have the same keys, no text is empty, English text has no CJK character (except the language name 繁體中文 and the instruction words of R23), and every message function returns a non-empty string for sample parameters.
- **R48. Scan for strays (decision 9).** A unit test scans `src/`, `shared/`, `server/` and `index.html` for CJK characters outside the tables, outside comment-only lines and outside a short, named allow list. Until T6 it reports the files that still contain such strings without failing; from T6 it fails on any match.
- **R49. Unit tests in English.** Every task adds unit tests for its text in English next to the existing Chinese ones: at least one case per message function family, the server's header parsing and default, the instructions' language line per task kind, tool names and summaries, localized `GenerationError` messages, the BOM, sheet and 3MF language, and the content-language test of R35.
- **R50. English e2e.** One new spec, `tests/e2e/english.spec.ts`, with at most 6 tests and a target of 3 minutes on the user's laptop, runs with `locale: 'en-US'` and covers: the default from the browser; the switch, the stored choice after a reload and the disabled switch during a request; the `Accept-Language` header on generate, edit and agent requests; an agent run with routed English events; the export kit in English (unpacked from the downloaded zip); and one hand badge in English with the fake hands of `tests/e2e/fake-hands.ts`. Model responses are routed, as in every other spec.
- **R51. No real model calls.** Unit tests use a fake `ModelProvider`; e2e tests route `/api/*`. The real English reply is a manual check (R52).
- **R52. Manual check.** The last task ends with a list for the user: switch languages in the real app, a real agent reply and a real generation in English, an exported kit opened in English, and a look at the layout with English text (design §9).

### Architecture

- **R53. Where tables live.** A string lives in the lowest layer that uses it: `shared/i18n/` for text used by both the browser and the server (joints, kit, materials, workspace and edit errors, export summary, demo), `server/i18n/` for server-only text (errors, tool names and summaries, snapshot, instruction language lines), `src/i18n/` for browser-only text. One table file per area, so specs that work on different areas never edit the same table. The area text modules that other specs create (`src/workbench/text.ts`, `shared/fidelity-text.ts`, `shared/fit-text.ts`, and the `TEXT` constant of each new tool file) are converted into tables in place, keeping their paths and export names, so their importers do not change.
- **R54. Language parameter (decision 8).** Pure functions that build text take the language as an explicit, required parameter (`lang: Lang`), so the type checker finds every call site. Long-lived objects and request state take it as an optional field that defaults to `zh-TW`, following the existing `printer` pattern (`AgentWorkingState.printer` and `printerOf` in `server/tools/joint-helpers.ts`): `AgentWorkingState.lang` with `langOf(state)`, and the `HandController` options. There is no global "current language" variable: Vitest runs with `isolate: false` (`vitest.config.ts`), so a global would leak between test files, and the server serves concurrent requests.
- **R55. Data carries codes, not text.** Shared rules return codes and parameters, and text is rendered at the edge: `Finding` gains `params` and its text comes from `findingText(finding, lang)`; `WorkspaceError` already has a `code`; `EditError` and the model validation errors gain codes; `GenerationError` carries a message key and parameters.
- **R56. No new dependency (decision 1).** The tables, the React context and the format helpers are in-house code. No i18n library is added unless the user chooses one in decision 1.
- **R57. Internal texts in English.** Error texts that never reach the screen (`validateAgentStep` errors in `shared/agent.ts`, the Zod `refine` message there, `printablePart`'s error in `src/print/printable.ts`, the `AbortError` text in `src/export/pieces.ts`) become English code text, so the scan of R48 has nothing to allow.
- **R58. Other specs' strings.** From the moment T1 lands, new user-facing strings of any spec go into a table with both languages. Strings that other specs add as plain zh-TW literals before that, or by mistake, are moved by T3–T5, which run after those specs' tasks on the same files (see "Dependencies").

### Compatibility

- **R59.** Requests without `Accept-Language` behave exactly as today (R19). `ModelSpec`, `Part`, the workspace schema, `StateChange`, `/api/generate`, `/api/edit` and `/api/agent` bodies are unchanged. The only new tool is `set_texts` (R36), and it adds no field to any schema.
- **R60.** In zh-TW the workbench looks and behaves as today, except for the language switch, R34's notice after a switch and R46.

## Non-functional requirements

- **N1. Switch speed.** A switch re-renders within 200 ms on the user's laptop (2 cores, no GPU) with two demo objects; hand tracking keeps running.
- **N2. Bundle size.** Both languages are bundled (no lazy language files; about 700 short strings each). The last task reports the main chunk size before and after from `npm run build`.
- **N3. Layout.** English text is longer than Chinese. Buttons, badges (`BADGE_NAME_MAX` in `src/hands/constants.ts` still applies to user content only), panel headings and the export file list must not overflow at 1440 × 1000 (the e2e viewport) and in the one-column layout; the manual check includes screenshots of both.
- **N4. Accessibility.** Each language button is named in its own language and carries `lang` (`lang="zh-Hant-TW"` / `lang="en"`), so screen readers pronounce it right. State is never shown by colour alone (unchanged).
- **N5. Security and privacy.** `Accept-Language` is parsed strictly (R19) and never echoed. Nothing new is logged. Model back ends still receive only text and model data, never video. The translate run of R36 sends only the object's text and model data, like any edit.
- **N6. Language of documents.** This spec, code comments and commit messages are English. UI strings exist in both languages.
- **N7. Checks.** `npm run check` (type check, build, unit tests) passes before a task is marked done, and the real result is reported.
- **N8. Task size.** `tasks.md` has at most 6 tasks, each small enough for one fresh Kiro session with Claude Sonnet 5.5, with Read first, Build, Tests, Done when and Session facts.

## Dependencies on other specs

The three specs below were being written in parallel with this one. Their drafts in `.kiro/specs/` (read on 2026-11-26, 03:00–03:35; `workbench-ui` had no `tasks.md` yet) already plan for this spec: each keeps its new strings in one area text module, so this spec converts those modules in place instead of editing their components.

- **workbench-ui** (the full-screen workbench, the HUD and the parts tray; VISION §4.9). Its requirement 86 (decision 13) puts every string of the files it creates into `src/workbench/text.ts`, new hand badges into `src/hands/text.ts`, new workspace errors into the `MESSAGES` table of `shared/workspace.ts`, and new tool summaries into one `TEXT` constant at the top of each new tool file; strings left in `App.tsx` stay there. It reserves a slot for the language switch in the HUD's first row (its R4) and asks that this spec's string tasks run after its tasks T3–T7, which touch `App.tsx`, `styles.css`, `src/workbench/**`, `AgentPanel.tsx`, `ObjectPanel.tsx`, `JointPanel.tsx`, `PrinterPanel.tsx` and `src/hands/text.ts`. T2 puts the switch into that slot if it exists; T4 and T5 run after those tasks.
- **design-fidelity** (C18). Its requirement 75 keeps every new string in `shared/fidelity-text.ts`, except the `COMPONENT_SEALED` export finding in `src/export/findings.ts`. Its requirement 14 restructures `server/provider.ts` into named rule blocks, keeps the language line separate for this spec, and leaves the demo model's names in `shared/demo.ts` to this spec. T2 changes only that language line; T3 converts `shared/fidelity-text.ts` and runs after its tasks on `shared/` and `server/`.
- **body-fit** (C10). Its requirement 83 keeps every new string in `shared/fit-text.ts`, used by the browser and its tools (`server/tools/attach-to-body.ts`, `server/tools/fit-to-body.ts`); it also adds `shared/demo-bracelet.ts` and `src/fit/**`, and edits `src/App.tsx` and `src/styles.css`. T3 converts `shared/fit-text.ts` and the bracelet demo's names; T5 covers `src/fit/**`.
- **export** (C11, done) and **assembly-joints** (C9, done): their tables are extracted by T3 and T5. Export R55 and R71 say file contents are Chinese until this spec; R28 replaces that.
- **hand-manipulation** (C4, done through Task 12): `src/hands/text.ts` and the controller's badge are extracted by T5. If a later hand task is added, it follows R58.
- **agent-harness** (C1, done): the registry's `label` becomes a pair (R21).
- **Steering.** `.kiro/steering/product.md` ("All user-facing strings in code and model output should be written in Traditional Chinese") and `.kiro/steering/hackathon.md` ("keep existing UI strings in Traditional Chinese") contradict R58 once T1 lands. Every Kiro session reads steering, so the other specs' sessions will keep writing Chinese literals until these lines change. T6 proposes the new wording; the user decides when to apply it (question 1 in the report).

## Priorities and build order

| Priority | Requirements | Task |
|---|---|---|
| P0 | R1, R18 (helpers), R47, R48 (report mode), R53, R54, R56 | T1 core and guards |
| P0 | R2–R9, R19, R23, R25, R44 | T2 language choice and model language |
| P0 | R13 (shared part), R20–R22, R24, R26, R27 (server), R32, R37, R45, R46 (server), R55, R57 | T3 shared and server strings |
| P0 | R10, R11, R15, R16, R17, R27 (browser), R38, R39, R40 (cue), R46 (browser) | T4 workbench strings |
| P0 | R12, R13 (browser part), R14, R28–R31, R40 (badges), R57 | T5 hands, joints and export |
| P0 | R9 (turn on), R34, R41, R43, R48 (strict), R50, R52; **P1** R35, R42; **P2** R36 | T6 turn it on, tests, README |

Build order: **T1 now → T2 as soon as its shared files are clean → (the other specs' tasks on the same files) → T3 → T4 → T5 → T6.** T1 creates only new files and can run in parallel with anything. T2 is small and should land before the other specs add more instruction lines and tools, so they build on `langOf` and the instruction functions. T3–T5 are the extraction passes and run late (R58).

Reference cut order, only if the user decides to cut (nothing is cut automatically): R36 (translate button and tool), then R35 (per-object hint), then the full Chinese README of R42, then the English `?hands=debug` line of R12 (a tuning tool, not part of the demo).

## Decisions

Each decision lists the options and a recommendation. The requirements above follow the recommendations.

1. **String tables: in-house or a library.**
   - (a) **In-house typed tables** (recommended): one module per area with `{ 'zh-TW': …, en: … }`, checked by a `defineText` helper so both sides have the same keys and parameter types; message functions for parameters; plurals through the built-in `Intl.PluralRules`; a React context for the current language. Estimated 150–200 lines of core code. Works the same in `shared/`, `server/` and `src/` with no initialisation, and a missing key is a type error, not a runtime fallback.
   - (b) `i18next` + `react-i18next`: mature, plurals, interpolation, namespaces and tooling. Two dependencies, string keys at run time (typed keys need module augmentation), an initialised instance that the server would also need per request, and HTML escaping in interpolation on by default that must be turned off for React.
   - (c) FormatJS (`react-intl`, `@formatjs/intl` on the server): ICU message syntax, the standard for large products; heavier than needed for two languages and about 700 strings.
   - (d) Paraglide JS (inlang): compiles messages into typed, tree-shakable functions; adds a compiler step and a Vite plugin whose compatibility with Vite 8 is not verified.
   Bundle sizes of (b)–(d) were not measured (no installs in this session). With two fixed languages, no translators and no runtime language loading, a library mostly adds setup in the last week before the deadline. **Recommendation: (a).**
2. **Default language.** (a) **From the browser** (zh* → zh-TW, else en), a stored choice wins (recommended): judges get English, the author gets Chinese, nobody has to find the switch first. (b) Always English: simplest for judges, but the author's own demo starts in English. (c) Always zh-TW: today's behaviour; judges must find the switch. **Recommendation: (a).**
3. **How the server learns the language.** (a) **`Accept-Language` header** on every request (recommended): one mechanism for all routes, also `GET /api/status` and errors raised before the body is parsed; no schema change. (b) A `lang` field in the three request bodies: visible in the shared Zod contract, but `GET /api/status` and pre-parse errors still need another way. (c) A `?lang=` query parameter on every URL. **Recommendation: (a).** Assumption to verify in T2: `fetch` may set `Accept-Language` (it is a CORS-safelisted header, so it should be allowed); the e2e of R50 checks the header that reaches the route.
4. **Answer language when the user types in the other language.** (a) **Always the UI language** (recommended): keeps one language on screen and in new part names. (b) The language of the instruction: natural in conversation, but mixes languages in the workspace. **Recommendation: (a).**
5. **Existing content on a switch.** (a) **Leave it, say so** (R33–R35; recommended, P0/P1). (b) Also offer translation on request through a text-only tool (R36; recommended as P2): one agent run per object, no geometry risk because the tool can only change text. (c) Translate automatically on every switch: costs a model call per object per switch (8–80 s each per `docs/PRIOR_WORK.md`) and changes user content without asking. (d) Regenerate: changes geometry and ids. **Recommendation: (a) now, (b) as P2; reject (c) and (d).**
6. **Transient text and requests on a switch.** (a) **Disable the switch while a request runs; re-render client notices; clear server text and the agent log from the screen but keep the agent history** (R7, R38, R39; recommended). (b) Keep old-language server text with a marker: shows two languages at once. (c) Allow the switch during a request: the answer would come back in the old language. **Recommendation: (a).**
7. **Brand labels.** The UI already shows decorative English labels in the Chinese UI (FORGEHAND, VOICE & HAND 3D WORKBENCH, LIVE WORKSPACE, AGENT, SELECT & ADJUST, MODEL DETAILS, CONCEPT / 01, EDIT THIS CONCEPT, CREATE A CONCEPT in `src/App.tsx` and `src/agent/AgentPanel.tsx`). (a) **Keep them in both languages as part of the visual design** (recommended). (b) Translate them in zh-TW. **Recommendation: (a);** the user may prefer (b).
8. **How text functions get the language.** (a) **Required `lang` parameter in pure functions; optional field with a zh-TW default only on long-lived objects and request state** (R54; recommended). (b) A default `lang = 'zh-TW'` everywhere: fewer edits, but a forgotten call site silently stays Chinese in the English UI. (c) A global current language: leaks between Vitest files (`isolate: false`) and is wrong for concurrent server requests. **Recommendation: (a).** Cost: existing unit tests that call changed text functions get one extra `'zh-TW'` argument; their expected texts do not change (R45).
9. **When the stray-string scan becomes strict.** (a) **Report only until T6, strict from T6** (recommended while the other specs' sessions have not been told about the tables): a failing check in their sessions would stop them for a rule they cannot see. (b) Strict from T1, after the user adds the table rule to steering and to the other specs' session facts: catches new Chinese literals at once and saves T3–T5 work. **Recommendation: (a), switch to (b) as soon as the steering is updated** (question 1).
10. **README in two languages.** (a) English `README.md` plus a full translation at `docs/zh/README.zh-TW.md` (rejected in review: `docs/zh/` is git-ignored). (b) **`README.zh-TW.md` at the repo root** (a common GitHub convention, one more file at the root), kept in sync by a heading-count test (**chosen by the user on 2026-11-26**). (c) One bilingual README: long and hard for judges to read. **Decision: (b).** Note: `README.md` is already English today; it quotes Chinese control names (17 lines), which R41 changes.
11. **Server terminal output.** (a) **English only** (recommended): read by whoever follows the README. (b) Both languages on each line. (c) A `FORGEHAND_LANG` environment variable. **Recommendation: (a).**
12. **Schedule.** Evidence: the deadline is 2026-12-05 06:00 Taiwan time, nine days after this spec. VISION §5 puts `english-ui` in phase D (11/29–12/03), together with the README and privacy update, the demo video, the Devpost submission and making the repo public. Three other specs are being written today and will edit the same files until then. The extraction touches about 70 files and 691 code lines, and the tests have about 1,500 lines with Chinese text (most stay unchanged by R45, but call sites of changed functions get a `'zh-TW'` argument). The commit history shows 2–4 spec tasks per day (for example 2026-11-21 to 11-22: export Tasks 3–5 and hand-manipulation Tasks 8–9). Options: (a) **run T1 and T2 now, T3–T6 back to back from about 11/30, one full e2e run per extraction task** (recommended); (b) start the extraction now and accept conflicts with the other specs' sessions; (c) wait with all of it until the other specs are done, which leaves no room for a failed task. **Recommendation: (a);** if a task fails twice, the user decides between the reference cut order above and moving other phase-D work.

## Decisions from review (2026-11-26)

Reviewed with the user and Claude Code. The user accepted every recommendation under "Decisions" above, plus these points. Where this section and the text above differ, this section wins.

1. **Decision 10 → (b):** the Chinese README is `README.zh-TW.md` at the repository root (R42, the design and the tasks are updated). `docs/zh/` is git-ignored and holds internal notes, so a README there would never be published, its link would break on GitHub, and `readme-sync.test.ts` would fail on a fresh clone.
2. **Decision 7:** `workbench-ui` removes the decorative English labels (its R10, decision 15). Only the brand FORGEHAND stays; it is a name and is not translated. If `english-ui` runs before that, it leaves those labels alone.
3. **Question 1 (steering) approved:** as soon as Task 1 has landed (and after the `guard-rules` hook commit, which also edits `hackathon.md`), the reviewer changes `.kiro/steering/product.md` and `hackathon.md` to the table rule of R58. Decision 9 then switches to (b): the stray-string scan becomes strict at that point.
4. **Questions 2 and 3:** the default follows the browser (decision 2 (a)); the translate button stays P2.
5. **Demo:** `workbench-ui` adds a demo selector (雙鏡頭概念裝置, 智慧手環); R37 applies to both demos.
6. **Tool count:** `find_tools` is not built now; `set_texts` adds one more tool (VISION §4.3 note of 2026-11-26).
7. **Schedule (decision 12):** the user keeps the full plan; T1 may start now.
