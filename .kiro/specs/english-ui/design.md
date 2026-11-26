# English UI with a language switch — Design

This design satisfies `requirements.md`. Requirement ids (R…, N…) refer to `requirements.md`; task numbers (T1–T6) refer to `tasks.md`. It follows the patterns of `export` and `assembly-joints`: pure modules unit-tested in Node, thin React wiring covered by Playwright, and one place for every rule. File paths and function names are from the code on 2026-11-26 (commit `ab8d750`); anything not verified there is marked **assumption**.

## 1. Approach

```
core       shared/i18n: Lang, LangSchema, langFromHeader, defineText, format helpers, contentLang
           src/i18n: language store, LanguageProvider, useLang                          (T1, new files only)
plumbing   the switch, <html lang>, Accept-Language on every /api call, langOf(state),
           instruction language lines, designTask/editTask/agentTask per language        (T2)
shared +   tables for joints, kit, materials, workspace, edit, model, export plan, demo;
server     server errors, tool names and summaries, snapshot; GenerationError keys     (T3)
workbench  App.tsx, agent panel, scene, objects panel: tables, UiText notices, switch rules (T4)
features   hands (status, badges, debug), joints panel and card, printer settings,
           export dialog and kit documents                                               (T5)
turn on    ENGLISH_UI_READY, content-language notice and hint, set_texts (P2),
           English e2e, strict scan, READMEs, manual checks                               (T6)
```

Five ideas carry the design:

1. **Tables per area, both languages side by side.** Each area has one small module that holds the zh-TW and the English text of every key next to each other. There is no central catalogue that every spec has to edit, so two sessions working on different areas never touch the same table (R53).
2. **The type checker enforces completeness.** `defineText` derives the English side's type from the Chinese side, so a missing key or a different parameter list is a compile error (R47). A run-time test catches what types cannot (empty text, CJK in English).
3. **The language is a parameter.** Pure text functions take `lang: Lang`; long-lived objects and request state hold it with a zh-TW default (R54). There is no global, because Vitest runs with `isolate: false` and the server serves concurrent requests.
4. **Data carries codes; text is rendered at the edge.** Findings, workspace errors, edit errors and generation errors carry a code and parameters; the browser or the route turns them into text in the right language (R55). Notices in React state are descriptors, so they re-render after a switch (R38).
5. **Extraction is moving, not rewriting.** Every zh-TW string moves into a table byte for byte (R45), so every existing test, including every e2e selector, keeps working. The suite also pins its browser locale to zh-TW (R44).

## 2. Module layout

```
shared/i18n/lang.ts            T1  Lang, LANGS, LangSchema, langFromHeader, HTML_LANG, isLang
shared/i18n/define.ts          T1  Shape<T>, defineText, Localized, localized
shared/i18n/format.ts          T1  quote, joinList, colon, paren, plural, seconds, hasCjk
shared/i18n/content.ts         T1  contentLang(model)  (used from T6)
shared/i18n/joints.ts          T3  faces, methods, needs, findings, reasons, side names, feature labels
shared/i18n/kit.ts             T3  standard-part labels, glue names, assembly notes
shared/i18n/materials.ts       T3  material labels
shared/i18n/workspace.ts       T3  WorkspaceError texts, contact texts
shared/i18n/model.ts           T3  model validation texts, EditError texts, describeChanges words
shared/i18n/export-plan.ts     T3  export summary note, machined feature labels, missing-part text
shared/i18n/demo.ts            T3  demo model names, summary, assumptions
shared/i18n/agent.ts           T3  unknown tool label

server/i18n/instructions.ts    T2  language lines of the design, edit and agent instructions; quoted UI names
server/i18n/errors.ts          T3  ServerMessageKey, SERVER_TEXT (every sanitized error), serverText
server/i18n/tools.ts           T3  tool display names and summaries, INVALID_ARGS texts
server/i18n/snapshot.ts        T3  snapshot and agentTask labels

src/i18n/lang-store.ts         T1  ENGLISH_UI_READY, LANG_STORAGE_KEY, detectLang, loadLang, saveLang, initialLang, switchVisible
src/i18n/LanguageProvider.tsx  T1  LangContext, LanguageProvider, useLang
src/i18n/ui-text.ts            T1  UiText, ui, raw, renderUiText
src/i18n/api.ts                T2  apiHeaders(lang)
src/i18n/LanguageSwitch.tsx    T2  the two-button switch;  T4 disabled state and the switched notice
src/i18n/app.ts                T4  App.tsx texts (also try-on lines, camera errors, request errors)
src/i18n/agent.ts              T4  agent panel, run log, request errors, resultText lines
src/i18n/scene.ts              T4  canvas name, render errors, join cue
src/i18n/workspace.ts          T4  objects panel, object-panel validation, app-rules notices
src/i18n/hands.ts              T5  hand status, badges, debug line
src/i18n/joints.ts             T5  joints panel, card, printer settings, mouse join, notices
src/i18n/export.ts             T5  export dialog, dialog-model, findings, BOM, sheet, 3MF names
src/i18n/content.ts            T6  switched notice, per-object hint, translate button and instruction

server/tools/set-texts.ts      T6  (P2) the text-only tool of R36
shared/workspace.ts            T6  (P2) setObjectTexts operation (additive)

tests/unit/i18n-files.ts           T1 (TABLE_FILES; T3–T5 add converted modules)
tests/unit/i18n-core.test.ts       T1     tests/unit/i18n-tables.test.ts   T1
tests/unit/i18n-scan.test.ts       T1 (report) / T6 (strict)
tests/unit/i18n-server.test.ts     T2, T3 extend
tests/unit/i18n-text.test.ts       T3, T4, T5 extend (English cases per area)
tests/unit/readme-sync.test.ts     T6
tests/e2e/english.spec.ts          T6
```

Dependency direction: `shared/i18n/lang.ts`, `define.ts`, `format.ts` import nothing from the project, so every layer can use them. `shared/i18n/<area>.ts` may import `shared/` types. `server/i18n/*` imports `shared/`. `src/i18n/*` imports `shared/`. Nothing in `src/` imports `server/` (unchanged rule).

## 3. Task 1 — Core and guards (R1, R18, R47, R48, R53, R54, R56)

### 3.1 Language (`shared/i18n/lang.ts`)

```ts
export const LANGS = ['zh-TW', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const LangSchema = z.enum(LANGS);
export const HTML_LANG: Record<Lang, string> = { 'zh-TW': 'zh-Hant-TW', en: 'en' };
export const isLang = (value: unknown): value is Lang => LangSchema.safeParse(value).success;
/** R19: the first tag decides; en* → 'en'; anything else, or no header, → 'zh-TW'. Never throws. */
export function langFromHeader(header: string | undefined): Lang;
```

`langFromHeader` takes at most the first 100 characters, splits on `,`, trims the first tag, drops a `;q=` part and compares case-insensitively. It is the only parser (browser detection in §3.4 reuses the same tag rule through `langFromTag`).

### 3.2 Tables (`shared/i18n/define.ts`)

```ts
/** A leaf is a string or a function of one flat params object. */
// `never` accepts any one-parameter function; the flat-params rule below is checked by review and by the sample test (§3.7).
type Leaf = string | ((params: never) => string);
type Tree = { readonly [key: string]: Leaf | Tree };
/** The English side has the same keys; literal strings widen to string; functions keep their parameters. */
export type Shape<T> =
  T extends string ? string
  : T extends (params: infer P) => string ? (params: P) => string
  : { readonly [K in keyof T]: Shape<T[K]> };
export function defineText<const T extends Tree>(table: { readonly 'zh-TW': T; readonly en: Shape<T> }):
  Readonly<Record<Lang, Shape<T>>>;
/** A pair for a single value, for example a tool display name. */
export type Localized = Readonly<Record<Lang, string>>;
export const localized = (zh: string, en: string): Localized => ({ 'zh-TW': zh, en });
```

Example (the shape every area table follows):

```ts
// src/i18n/hands.ts (T5)
export const HAND_TEXT = defineText({
  'zh-TW': {
    status: { loading: '正在載入手部追蹤模型（第一次約 20–30 秒）。', /* … */ },
    badge: { hover: (p: { name: string }) => `手勢：對準 ${p.name}`, waiting: '手勢：待命', /* … */ },
  },
  en: {
    status: { loading: 'Loading the hand tracking model (about 20–30 s the first time).', /* … */ },
    badge: { hover: p => `Hand: pointing at ${p.name}`, waiting: 'Hand: ready', /* … */ },
  },
});
// use: HAND_TEXT[lang].badge.hover({ name })
```

Rules for every table (they are also the instructions for the other specs, §12):
- One file per area, named after the area, in the layer of R53. Keys are camelCase English words that say what the text is for (`demoLoaded`, not `msg12`).
- Parameters are one flat object of strings, numbers or booleans. Lists are joined by the caller with `joinList(lang, items)`, names are quoted by the caller with `quote(lang, name)` or inside the message. This keeps the run-time sample test (§9.2) simple.
- A zh-TW text moved from code keeps every character, including full-width punctuation (R45).
- English follows the glossary (§11): one term per concept, sentence case, a full stop at the end of sentences, none on button labels.
- User content is never put into a table.

### 3.3 Format helpers (`shared/i18n/format.ts`)

| Helper | zh-TW | en |
|---|---|---|
| `quote(lang, s)` | `「s」` | `“s”` |
| `joinList(lang, items)` | `a、b、c` | `a, b, c` |
| `colon(lang)` | `：` | `: ` |
| `paren(lang, s)` | `（s）` | ` (s)` |
| `plural(lang, n, one, other)` | `other` with the number (Chinese has no plural) | `Intl.PluralRules('en')` picks `one` or `other` |
| `seconds(lang, n)` | `{n} 秒` | `{n} s` |
| `hasCjk(s)` | `/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/` | same |

Numbers are formatted by the callers as today (`toFixed`, `formatMm`, `formatCm3` in `src/export/format.ts`), identical in both languages (R18).

### 3.4 Browser store (`src/i18n/lang-store.ts`)

```ts
export const ENGLISH_UI_READY = false;              // T6 sets true (R9)
export const LANG_STORAGE_KEY = 'forgehand.lang.v1';
export function detectLang(languages: readonly string[]): Lang;      // R2: zh* → zh-TW, else en, [] → en
export function loadLang(storage: Pick<Storage, 'getItem'> | null): Lang | null;   // invalid → null
export function saveLang(storage: Pick<Storage, 'setItem'> | null, lang: Lang): void; // blocked → ignored
/** R2–R4, R9: ?lang= wins for this load; otherwise, only when `ready`, the stored choice, then the browser; otherwise zh-TW. */
export function initialLang(input: { search: string; storage: Pick<Storage, 'getItem'> | null; languages: readonly string[]; ready?: boolean }): Lang;
/** R9: the switch shows when English is ready or the URL has ?lang=. */
export function switchVisible(search: string, ready?: boolean): boolean;
```

Same storage pattern as `loadPrinterProfile` / `savePrinterProfile` (`src/joints/printer-store.ts`): a `Storage`-like argument, so tests need no DOM. Before T6 a stored value is ignored unless the URL has `?lang=`, so a developer who pressed English once during T2–T5 does not see a half-translated UI on the next plain visit; from T6 the stored value always applies (R3).

### 3.5 React context (`src/i18n/LanguageProvider.tsx`)

```ts
export interface LangState { lang: Lang; setLang(lang: Lang): void }
export function LanguageProvider({ children, initial }: { children: ReactNode; initial: Lang }): JSX.Element;
export function useLang(): LangState;     // throws outside the provider (a wiring bug, caught by e2e)
```

`setLang` saves (R3), sets `document.documentElement.lang` to `HTML_LANG[lang]` and `document.title` (R8), and re-renders the tree. An effect does the same once on mount. T1 creates the provider; T2 mounts it in `src/main.tsx`.

### 3.6 Notice descriptors (`src/i18n/ui-text.ts`)

```ts
/** A notice in React state. `lang` is null for text rendered from a table (any language), or the language raw server text was written in. */
export interface UiText { readonly lang: Lang | null; readonly render: (lang: Lang) => string }
export const ui = (render: (lang: Lang) => string): UiText => ({ lang: null, render });
export const raw = (text: string, lang: Lang): UiText => ({ lang, render: () => text });
export const renderUiText = (text: UiText | null, lang: Lang): string => (text ? text.render(lang) : '');
```

Pitfall for T4: `setMessage(lang => …)` would be taken by React as an updater function. State always holds a `UiText` object: `setMessage(ui(lang => APP_TEXT[lang].demoLoaded))`.

### 3.7 Guards

- `tests/unit/i18n-core.test.ts`: `langFromHeader` (missing, `en`, `en-US,en;q=0.9`, `zh-TW`, `zh-CN`, `fr`, a 10 kB header), `detectLang`, `loadLang`/`saveLang` with a fake and a throwing storage, `initialLang` (every source, with and without `ready`), `switchVisible`, every format helper in both languages, `hasCjk`.
- `TABLE_FILES` (exported from the scan test's helper, `tests/unit/i18n-files.ts`): every file under `src/i18n/`, `shared/i18n/` and `server/i18n/`, plus the area text modules of other specs once they are converted (`src/workbench/text.ts`, `shared/fidelity-text.ts`, `shared/fit-text.ts`; R53). A converted module is added to the list by the task that converts it.
- `tests/unit/i18n-tables.test.ts`: takes every file of `TABLE_FILES` (Node `fs`, no glob dependency), imports it, and checks every export made by `defineText` (they are recognisable as objects with exactly the keys `zh-TW` and `en`): same key tree; no empty leaf; every function leaf called with a sample object returns a non-empty string without `undefined` or `NaN`; no CJK in English leaves except the allow list `EN_CJK_ALLOWED` (the language name 繁體中文, the instruction words 這個, 它, 這些, and the zh-TW instruction language line's 繁體中文). The sample object is a `Proxy` that returns `1` for any key, which works because parameters are flat (§3.2). With no tables yet (T1), the test checks the T1 example table in the test file itself.
- `tests/unit/i18n-scan.test.ts` (R48): reads every `.ts`, `.tsx` and `.html` file in `src/`, `shared/`, `server/` and `index.html`; skips `TABLE_FILES`; skips comment-only lines (trimmed line starts with `//`, `*`, `/*` or `/**`); reports each remaining line with a CJK character as `file:line`. `STRICT = false` until T6: the test logs the list and the count per file and passes. `SCAN_ALLOWED` names exact `file + substring` pairs that may stay (expected to be empty after T5; R57 turns internal texts English). A code line with a trailing CJK comment counts as a match; move the comment to its own line.

## 4. Task 2 — Language choice and model language (R2–R9, R19, R23, R25, R44)

### 4.1 Browser

- `src/main.tsx`: wraps `<App />` in `<LanguageProvider initial={initialLang({ search: location.search, storage, languages: navigator.languages, ready: ENGLISH_UI_READY })}>`.
- `src/i18n/LanguageSwitch.tsx`: `<div role="group" aria-label={…}>` with two `<button type="button" aria-pressed lang>` named 繁體中文 and English (R5, N4). The group name comes from a one-key table in the same file (介面語言 / Interface language). Shown when `switchVisible(location.search, ENGLISH_UI_READY)`. Props: `disabled: boolean`, `disabledReason: string` (T4 passes the busy state, R7).
- `src/App.tsx`: renders `<LanguageSwitch />` in the top bar `<header className="topbar">` (line 768 today). If `workbench-ui` has replaced the top bar when T2 runs, put it where that spec's design places global settings and say so in the report.
- `src/i18n/api.ts`: `apiHeaders(lang): Record<string, string>` returns `{ 'Accept-Language': lang }`. Every `/api/*` fetch uses it: the generate, edit and status fetches in `src/App.tsx`, and the agent fetch in `src/agent/useAgentRun.ts` (the hook gets `lang` through its options). The status fetch re-runs when the language changes, so the `reason` line is in the current language (R20).

### 4.2 Server

- `server/app.ts`: a small middleware before the routes sets `res.locals.lang = langFromHeader(req.get('accept-language'))`. `/api/generate` calls `provider.generate(prompt, signal, lang)`; `/api/edit` calls `run(editTask(model, instruction, selectedPartIds, lang), signal)`; `/api/agent` calls `runAgent(provider, agentRequest, { maxRounds, totalTimeoutMs, lang }, emit, signal)`. Error texts stay as they are in T2; T3 localizes them.
- `server/provider.ts`: `ModelProvider.generate(prompt, signal, lang?: Lang)`. `designTask(prompt, lang)` and `editTask(model, instruction, selectedPartIds, lang)` use `modelInstructions(lang)` and `editInstructions(lang)`. The exported constants `MODEL_INSTRUCTIONS` and `EDIT_INSTRUCTIONS` stay as the zh-TW variants, so `GEOMETRY_RULES` (filtered from `MODEL_INSTRUCTIONS` by line prefix, in both `provider.ts` and `agent.ts`) and existing tests keep working.
- `server/i18n/instructions.ts`:

```ts
export const LANGUAGE_LINE = {
  design: localized('… use Traditional Chinese.', '… use English.'),   // replaces line 2 of MODEL_INSTRUCTIONS
  edit:   localized('All user-facing names, explanation, summary and assumptions use Traditional Chinese.',
                    'All user-facing names, explanation, summary and assumptions use English.'),
  agent:  localized('- All user-facing text (notes and final replies) must be in Traditional Chinese (繁體中文), also when the user writes in another language.',
                    '- All user-facing text (notes and final replies) must be in English, also when the user writes in another language.'),
};
export const UI_NAMES = { downloadKit: localized('下載完整套件', 'Download full kit'), cameraImage: localized('隱藏或顯示鏡頭畫面', 'hide or show the camera image') };
```

  The design line keeps today's wording around the language name ("Return only the requested structured design. All user-facing names, summary, assumptions, and explanation use …"). The "also when the user writes in another language" part implements decision 4; the design and edit lines get the same clause. The instruction texts are built as templates with one `${LANGUAGE_LINE.design[lang]}` slot, so `design-fidelity`'s edits to the rule lines and this slot are on different lines. `design-fidelity` (its requirement 14) plans to split `server/provider.ts` into named rule blocks and to replace the regular-expression copy `GEOMETRY_RULES`, keeping the language line as its own block. If that has landed when T2 runs, T2 turns that block into `LANGUAGE_LINE[…][lang]` and builds the instruction texts from the blocks per language; the guarantee stays that generation and edits share the same rule blocks.
- `server/agent.ts`: `agentInstructions(lang)` builds the text with `LANGUAGE_LINE.agent[lang]` and `UI_NAMES`; `AGENT_INSTRUCTIONS` stays exported as `agentInstructions('zh-TW')`. `agentTask(history, rounds, state, instruction)` uses `agentInstructions(langOf(state))`. `runAgent` puts `options.lang` into the working state.
- `server/agent-tools.ts`: `AgentWorkingState.lang?: Lang`; `server/tools/helpers.ts`: `export const langOf = (state: AgentWorkingState): Lang => state.lang ?? 'zh-TW'` (next to the existing helpers; `printerOf` is in `joint-helpers.ts`).
- `server/tools/generate-design.ts`, `edit-design.ts`: pass `langOf(state)` into `designTask` and `editTask`.
- Adapters `server/codex.ts`, `server/claude.ts`, `server/app-server.ts`, the OpenAI adapter in `server/provider.ts`, and the failing stub in `server/model-host.ts`: `generate: (prompt, signal, lang) => run(designTask(prompt, lang ?? 'zh-TW'), signal)`. No other adapter change: every adapter already takes `task.instructions` per task (`--system-prompt` for Claude, the prompt text for Codex exec, `baseInstructions` for the app-server thread).

### 4.3 Playwright

`playwright.config.ts`: `use.locale: 'zh-TW'` in the top-level `use` (R44). Assumption: `devices['Desktop Chrome']` sets no locale, so the top-level value applies; T2 verifies by reading `navigator.language` in one existing spec run (no new test file).

### 4.4 Tests (T2)

`tests/unit/i18n-server.test.ts` (new): with a fake provider that records each `ModelTask`, `POST /api/generate`, `/api/edit` and `/api/agent` (supertest) without a header record the zh-TW language line, and with `Accept-Language: en` the English one; `agentInstructions('en')` names Download full kit; `MODEL_INSTRUCTIONS`, `EDIT_INSTRUCTIONS` and `AGENT_INSTRUCTIONS` equal their zh-TW function results; both instruction variants keep the `GEOMETRY_RULES` lines. Unit test for `apiHeaders`. E2E: the existing specs that use `/api/*` routes (`workbench.spec.ts`, `agent-panel.spec.ts`) pass unchanged.

## 5. Task 3 — Shared and server strings (R13 shared part, R20–R22, R24, R26, R27, R32, R37, R45, R46, R55, R57)

### 5.1 Shared rules return codes

- `shared/joint-rules.ts`: `Finding` becomes `{ jointId, severity, code, params, message }` where `params: FindingParams` (today's `MessageParams`) and `message` stays the zh-TW text, so existing tests and `findingLine` keep working until T5. New `findingText(finding, lang)` renders from `JOINT_TEXT[lang].findings`. `FINDING_MESSAGES` moves into `shared/i18n/joints.ts`. Recommendation reasons (`ASSUMPTION_REASON`, `KIND_REASON`, `REASON_SLIDE`, `REASON_TAPPED`, `reasonInsertUnsuitable`) become codes on the recommendation plus `reasonText(reason, lang)`. **Exception to "data carries codes":** keeping `message` avoids rewriting the 102 Chinese lines of `tests/unit/joint-rules.test.ts`; T5 switches every display to `findingText`.
- `shared/joint.ts` `FACE_LABELS`, `shared/materials.ts` `label`, `shared/standard-parts.ts` labels, `shared/kit.ts` (`jointBom` labels, `assemblyNotes` sentences, `GLUE_NOTE_NAMES`): the tables get `lang`-taking accessors (`faceLabel(face, lang)`, `materialLabel(id, lang)`, `jointBom(ws, profile, lang)`, `assemblyNotes(ws, profile, lang)`); the existing `label` fields stay as the zh-TW value for the existing tests, and every new call site uses the accessor.
- `shared/workspace.ts`: `WorkspaceError` keeps `code`; `MESSAGES` moves to `shared/i18n/workspace.ts`; new `workspaceErrorText(code, lang)`. `shared/contact.ts` texts likewise.
- `shared/edit.ts`: `EditError(code, params?)` with `editErrorText(error, lang)`; `describeChanges(before, after, changes, lang)`. `shared/model.ts`: `validateModel` and `validateDesign` throw `ModelError(code, params?)` with `modelErrorText`; Zod issues are never turned into text (R46).
- `shared/export-plan.ts`: `METHOD_KIND_LABELS`, `MISSING_PART`, the machined feature labels and the summary note take `lang`; `exportSummary(ws, scope, profile, lang)`.
- `shared/demo.ts`: `demoModelFor(lang)`; `demoModel` stays as `demoModelFor('zh-TW')` (R37).
- `shared/agent.ts`: `UNKNOWN_TOOL_LABEL` becomes `unknownToolLabel(lang)`; the old constant stays as the zh-TW value. The `refine` message and the `validateAgentStep` errors become English (R57); they are never shown (the route returns fixed texts, and the loop retries on a validation failure).

### 5.2 Server errors (`server/i18n/errors.ts`)

```ts
export type ServerMessageKey = 'SERVICE_ERROR' | 'TIMEOUT' | 'CLI_UNAVAILABLE' | /* … one key per distinct text today */ ;
export interface ServerText { key: ServerMessageKey; params?: Readonly<Record<string, string | number>> }
export const SERVER_TEXT = defineText({ 'zh-TW': { SERVICE_ERROR: '模型服務暫時無法完成，請稍後重試。', … }, en: { SERVICE_ERROR: 'The model service could not finish. Please try again later.', … } });
export const serverText = (text: ServerText, lang: Lang): string;
```

`GenerationError(code, message: string | ServerText, status)`: with a `ServerText` it keeps it as `text` and sets `message` to the zh-TW rendering (so existing `toThrow` and `message` assertions are unchanged); with a plain string (test fakes only, never production code, which the scan of R48 enforces) `text` is null. New `errorText(error, lang)`: `serverText(error.text, lang)` or, for a plain string, the string. Every route and the agent loop use `errorText(error, res.locals.lang)` / `errorText(error, langOf(state))` where they use `error.message` today. The keys are not the `code`s: one code has several texts today (`CLI_UNAVAILABLE` has four), and the key table says which.

Texts with a CLI name (`${label} 回應逾時…` in `server/codex.ts`) take `{ label }` as a parameter; `label` is a brand word (Codex CLI).

`/api/status`: `statusMessage` becomes `statusText: ServerText | undefined`; the route renders it with the request language. `model-host.ts` sends `model: 'cli-default'` instead of CLI 設定預設; the browser maps that marker in T4 (R27).

`server/index.ts` and `server/model-host.ts` configuration errors and startup lines become English literals (R26), for example `Forgehand local server: http://127.0.0.1:${port}` and `PORT must be an integer from 1024 to 65535`.

### 5.3 Tools (`server/i18n/tools.ts`)

- `ToolDefinition.label: Localized`. `defineTool` checks 1–40 characters for both languages. `server/agent.ts` emits `label: getTool(call.tool)?.label[lang] ?? unknownToolLabel(lang)`.
- Every tool builds its `summary` from `TOOL_TEXT[langOf(state)]`. User content inside (object and part names) is inserted with `quote(lang, name)`.
- `server/agent-tools.ts` `UNKNOWN_TOOL` and `INVALID_ARGS` texts, `server/tools/helpers.ts` `NO_MODEL_MESSAGE` and `UNKNOWN_OBJECT`, `server/tools/joint-helpers.ts` (`LOAD_TEXT`, `DISASSEMBLY_TEXT`, `UNKNOWN_NEED_TEXT`, `methodText`, `sideText`, derived-size texts) take `lang`. The joint helpers reuse `shared/i18n/joints.ts` instead of their own copies (R45: one key, same zh-TW text).
- Display names (zh-TW unchanged, English new): 生成設計 / Generate design, 修改設計 / Edit design, 檢視目前狀態 / Check current state, 選取零件 / Select parts, 爆炸圖 / Exploded view, 切換物件 / Switch object, 移動物件 / Move object, 移除物件 / Remove object, 護臂試戴 / Arm try-on, 鏡頭畫面 / Camera image, 建立接合 / Create joint, 設定接合 / Update joint, 移除接合 / Remove joint, 設定材料 / Set material, 準備匯出 / Prepare export, 其他步驟 / Other step; T6 adds 更新名稱與說明 / Update names and notes.

### 5.4 Snapshot (`server/i18n/snapshot.ts`)

`workspaceSnapshot(state)` and `jointSnapshotLines(state)` render with `langOf(state)` (R24): 工作區沒有物件。 / The workspace has no objects., 【目前物件】 / [active], 已選取 / Selected, 爆炸圖程度 / Explode amount, 試戴 / Try-on, and the joint line. `agentTask`'s labels (先前對話 / Earlier conversation, 本次工具執行記錄 / Tool log of this run, 目前狀態 / Current state, 使用者指示 / User instruction, 使用者 / User, 回覆 / Reply, 工具呼叫 / Tool call, 結果 / Result) come from the same table.

### 5.5 Tests (T3)

Existing server tests send no header and keep their zh-TW assertions (R45). New cases in `tests/unit/i18n-server.test.ts` and `tests/unit/i18n-text.test.ts`: every `ServerMessageKey` renders in both languages; a provider failure through `/api/generate` with `Accept-Language: en` returns the English text and the same code and status; `GET /api/status` with the header returns an English `reason`; an agent run with `lang: 'en'` emits English tool labels, summaries and error events; the snapshot in English; `findingText`, `workspaceErrorText`, `editErrorText`, `modelErrorText`, `jointBom`, `assemblyNotes`, `exportSummary` and `demoModelFor` in English; `demoModelFor('en')` has the same ids and geometry as `demoModel`. Existing tests that call a function whose signature gained `lang` get `'zh-TW'` as the new argument, and nothing else in them changes.

## 6. Task 4 — Workbench strings (R10, R11, R15–R17, R27 browser, R38, R39, R40 cue, R46 browser)

### 6.1 App

- `src/i18n/app.ts` holds every text of `src/App.tsx` (about 136 lines today), grouped as `topbar`, `stage`, `camera`, `tryOn` (the `TRY_ON_TEXT`-style table at lines 60–65), `transformNotice` (lines 55–57), `generate`, `edit`, `conflict`, `parts`, `details`, `service`, `footer`, `errors`. `providerLabel` stays (brand words); `sourceLabel` uses `APP_TEXT[lang].stage.source*`; the `cli-default` model marker renders as CLI 設定預設 / CLI default.
- Every `useState` for a shown text (`message`, `error`, `adjustError`, `objectError`, `cameraError`, `renderError`, `clarify`, and the joint error states) holds `UiText | null` (§3.6). `setError(cause.message)` for a server response becomes `setError(raw(cause.message, lang))`; client texts use `ui(…)`.
- `WorkspaceError` messages are rendered with `workspaceErrorText(cause.code, lang)`, `EditError` with `editErrorText`; the adjust failure of line 511 drops the appended raw text (R46).
- `loadDemo` uses `demoModelFor(lang)` and `providerModel: APP_TEXT[lang].demoSource`.
- The default prompt is set from the table when the page opens and is not changed by a later switch (it is the user's input once on screen).

### 6.2 Switch behaviour (R7, R34, R38, R39)

`LanguageSwitch` gets `disabled={busy !== null || agentActive}` and the reason of R7. On a switch, `App` (through a `useEffect` on `lang`):
1. leaves every `ui(…)` text alone (it re-renders);
2. clears every `raw(…)` text whose `lang` differs (errors, the edit summary), and the agent panel's display state through `agent.clearDisplay()` (new in `useAgentRun`: resets `log`, `reply`, `error` and the shown instruction; keeps `turns`), then shows R39's line in the agent panel;
3. keeps a pending approximation or conflict, renders its buttons in the new language and adds 這段說明是英文。 / This explanation is in Chinese. above its explanation;
4. sets the status line to R34's text (T6 adds the object-count variant; T4 shows the short one).

### 6.3 Agent panel

`src/i18n/agent.ts`: the `STATUS_TEXT` of `AgentPanel.tsx`, the panel texts, `CONNECTION_LOST` and the request-failure texts of `useAgentRun.ts`, `errorMessageFromBody`'s fallbacks (`src/agent/request.ts`), and the `resultText` lines (`src/agent/labels.ts`). `run-reducer.ts` stores data, not fixed words: a tool entry has `text: null` and the panel renders 進行中 / In progress; a result entry stores `ok`, the server `summary` and the error `code`, and `resultText(result, lang)` runs at render time. The reducer's label fallback uses `unknownToolLabel(lang)` at render time. Existing reducer tests that assert `text: '進行中'` are updated to the new entry shape (the shown text is asserted through `resultText`/the panel helper instead); this is the only test whose expected data changes, and the report lists it.

### 6.4 Scene and objects panel

- `src/i18n/scene.ts`: the canvas `aria-label`, the three `onError` texts and the `可以接合 / Ready to join` sprite text. `SceneViewport` gets a `labels: SceneLabels` prop from `App` (so the viewport needs no context); the sprite is rebuilt when `labels.joinCue` changes. `src/scene/geometry.ts` errors are internal (`buildModel` failures reach the user only through `SceneViewport`'s fixed `onError` text): they become English code text (R57). **Assumption** checked by T4: no `geometry.ts` message is shown directly.
- `src/i18n/workspace.ts`: `ObjectPanel.tsx`, `object-panel.ts` validation (`renameObject` throws an error with a code; the panel renders it), `app-rules.ts` notices.

### 6.5 Tests (T4)

`tests/unit/i18n-text.test.ts` adds English cases for the app tables with parameters (elapsed seconds, part counts with plural, the conflict text), `resultText(result, 'en')`, the reducer's new entry shape, `renameObject` error codes, `app-rules` notices in English. E2E: the whole suite once at the end of the task (it exercises every moved zh-TW string).

## 7. Task 5 — Hands, joints and export (R12, R13 browser, R14, R28–R31, R40 badges, R57)

### 7.1 Hands

`src/i18n/hands.ts`: `TEXTS` of `src/hands/text.ts`, every badge, the debug words (每秒 / fps, 辨識 / inference, 隻手 / hands, 捏合 / pinch, 捏合門檻 / pinch threshold, 速度門檻 / speed gate, 遺失門檻 / loss limit, 曲度 / curl, 握拳 / fist, 是/否 / yes/no, 拖曳 / drags, 完成 / done, 取消 / cancelled, 拖曳中遺失 / lost while dragging, 最長 / longest, 雙手 / two-hand, 無效捏合 / inert pinches, 接合 / join, 間隙 / gap, 角度 / angle, 重疊 / overlap, 偵測 / detect). `handStatus(input, lang)`, `badgeText(view, lang)`, `trackingDebugLine(input, lang)`, `debugLine(stats, tracking, lang)` take `lang`. `HandController` gets `lang?: Lang` in its constructor options (default zh-TW, R54) and `setLang(lang)`; `useHandControl` passes `useLang().lang` and calls `setLang` on a change, so the next frame's badge is in the new language (R40). `shortenName` is unchanged (user content).

### 7.2 Joints and printer settings

`src/i18n/joints.ts`: everything in `src/joints/labels.ts` (it becomes thin accessors over `shared/i18n/joints.ts` plus the client-only notices and mouse-join lines), `card-model.ts` texts (derived sizes such as `M3×8 螺絲 ×2` / `M3×8 screw ×2`), the `FieldSelect` labels of `JointCard.tsx`, `JointPanel.tsx`, `PrinterPanel.tsx` field labels and note, and `askAgentText(a, b, lang)`. Displays use `findingText` instead of `finding.message`.

### 7.3 Export

- `src/i18n/export.ts`: `ExportDialog.tsx` texts, `dialog-model.ts` (`fileRows` labels 下載 {path} / Download {path}, `problemBanner`, the summary lines), `EXPORT_MESSAGES` of `findings.ts`, the BOM texts and headers of `bom.ts`, the sheet texts of `sheet.ts`, and the piece name format of `pieces.ts` (`{name}（含 {n} 個零件）` / `{name} (fused from {n} parts)`).
- `prepareKit` input (`KitInput` in `src/export/prepare.ts`) gains `lang`; `buildBom`, `bomCsv`, `bomMarkdown`, `assemblySheetHtml`, `threeMfModelXml` and `write3mf` take it; `sheet.ts` writes `<html lang="${HTML_LANG[lang]}">`; `threemf.ts` writes `xml:lang="${lang}"`. File paths do not change (R29).
- `ExportDialog` includes `lang` in its snapshot comparison (`sameSnapshot` in `dialog-model.ts`), so a switch re-prepares (R31).
- `src/print/printable.ts` and the `AbortError` text of `src/export/pieces.ts` become English (R57).

### 7.4 Tests (T5)

English cases in `tests/unit/i18n-text.test.ts`: hand status per state, every badge state, the debug line; joint labels, card texts, `askAgentText`; every export finding; `bomCsv` header row and category values in English with the byte-order mark and CRLF unchanged; `bomMarkdown` headings; `assemblySheetHtml` with `lang="en"` and English headings and a hostile English part name still escaped; `threeMfModelXml` with `xml:lang="en"`; `sameSnapshot` false when only `lang` differs. Existing tests (`hand-*.test.ts`, `joint-ui.test.ts`, `export-*.test.ts`) get `'zh-TW'` where a signature gained it. E2E: the whole suite once at the end.

## 8. Task 6 — Turn it on, content language, tests and README (R9, R34–R36, R41–R43, R48 strict, R50, R52)

### 8.1 Turn on

`ENGLISH_UI_READY = true`; `i18n-scan.test.ts` `STRICT = true` with an empty or justified `SCAN_ALLOWED` (each entry with a one-line reason). From then on R2 applies to every visitor.

### 8.2 Content language (R34, R35)

- `shared/i18n/content.ts` (T1 creates it): `contentLang(model: Pick<ModelSpec, 'name' | 'summary' | 'assumptions' | 'parts'>): Lang` returns `zh-TW` when the name, summary, assumptions or any part name has a CJK character, else `en`. `differsFromUi(model, lang)` applies R35's rule (for en: any CJK; for zh-TW: no CJK in the name and every part name).
- R34's notice with the object-count variant; R35's line in the model details panel, from `src/i18n/content.ts`.

### 8.3 Translate on request (R36, P2)

- `shared/workspace.ts`: `setObjectTexts(ws, objectId, texts)`; validates names (1–500 characters as `PartSchema`), only for part ids of that object; leaves every other field identical; throws `WorkspaceError('UNKNOWN_OBJECT')` / `INVALID_SELECTION`-style codes as the existing operations do. Additive; check `git status` first (owned by `workbench-ui` and `assembly-joints`).
- `server/tools/set-texts.ts`: args `z.strictObject({ objectId, name: string | null, summary: string | null, assumptions: string[] | null, parts: { partId, name }[] })`, effect `writes-scene`, label 更新名稱與說明 / Update names and notes, registered last; its state change is a `model` change of that object made by `setObjectTexts`, so the browser applies it like `edit_design` and it is one undo step.
- `AGENT_INSTRUCTIONS`: "To translate names and notes, call set_texts; never use edit_design for translation."
- The button 翻譯成中文 / Translate to English next to R35's line runs the agent with the instruction of R36 through the existing `agent.start` path (as 請代理建議 does). It is disabled with the switch's busy rule.

### 8.4 README (R41–R43)

`README.md`: English labels with the Chinese label at the first mention per section; a "Language" section; a link line at the top: "中文說明：[README.zh-TW.md](README.zh-TW.md)". `README.zh-TW.md`: full translation, same sections, link back. `tests/unit/readme-sync.test.ts` compares the number of `## ` headings.

### 8.5 English e2e (R50)

`tests/e2e/english.spec.ts`, `test.use({ locale: 'en-US' })`, routes as in `workbench.spec.ts` and `export.spec.ts`, at most 6 tests:

1. **Default and chrome.** `html[lang="en"]`, the title, Load demo model, Generate 3D draft; after loading the demo, `document.body.innerText` has no CJK character.
2. **Switch and reload.** Press 繁體中文: 載入示範模型 visible, `html[lang="zh-Hant-TW"]`, R34's notice; reload: still Chinese; press English. With a routed `/api/generate` that waits, the switch is disabled with R7's reason.
3. **Requests.** Routed `/api/generate`, `/api/edit` and `/api/status` receive `accept-language: en`; an English routed design shows English names.
4. **Agent.** A routed `/api/agent` stream with an English `tool` label, `result` summary and `final` reply; the panel's fixed words are English; after pressing 繁體中文 the log is gone and R39's line is shown.
5. **Export.** Two demo objects and a routed agent `state` frame with a joint (the fixture of `export.spec.ts`), Export kit, the findings in English, Download full kit; the unpacked `bom.csv` first header is Category, `assembly.html` has `lang="en"`, `kit.3mf` has `xml:lang="en"`.
6. **Hand badge.** With `tests/e2e/fake-hands.ts`, one hand over a part shows a badge starting with Hand:.

Run time is measured and reported; the target is 3 minutes (R50).

## 9. Test strategy

### 9.1 How the existing suite keeps working

- **Pinned locale** (R44, T2): the suite's browser reports `zh-TW`, so R2 gives Chinese.
- **Identical Chinese** (R45): every moved string keeps its exact text, so every `getByRole(…, { name, exact: true })` still matches. The extraction tasks never edit an existing e2e spec; if one fails, the task finds the string that changed and restores it.
- **Server defaults** (R19): supertest requests without a header get zh-TW, so the server tests keep their assertions.
- **Signatures** (decision 8): unit tests that call a changed function get one `'zh-TW'` argument; their expected values stay. Each task's report lists the test files it touched and confirms with `git diff` that only call arguments changed (plus the reducer entry shape of §6.3).

### 9.2 How English is tested

- **Types**: `defineText` (§3.2).
- **Tables** (`i18n-tables.test.ts`): key parity, empty leaves, CJK in English, sample calls (§3.7).
- **Strays** (`i18n-scan.test.ts`): report until T6, strict after.
- **Units**: English cases per area in `i18n-text.test.ts` and `i18n-server.test.ts` (§4.4, §5.5, §6.5, §7.4).
- **E2E**: six English tests (§8.5), run in the default suite.
- **Manual** (§10 of `tasks.md`): the real app, a real agent reply, a real export.

### 9.3 Time budget

The full suite takes about 25 minutes on the laptop. This spec adds one spec file of at most 6 tests (target 3 minutes) and no second pass over the existing specs: English is never run against the 13 existing e2e files. Unit tests add a few seconds.

## 10. File ownership

"Other spec" lists the specs that edit the file too. For `workbench-ui`, `design-fidelity` and `body-fit` the entries come from their drafts of 2026-11-26 (`workbench-ui` requirement 86 and its dependency list, `design-fidelity` requirements 14 and 75, `body-fit` requirement 83 and its `tasks.md` table) and from VISION §4.9–§4.11 where the drafts say nothing ("expected"). `workbench-ui` had no `tasks.md` yet; each task re-checks against the other specs' `tasks.md` before starting.

Other specs' area text modules, converted in place (R53):

| Module (owner) | Converted by | Notes |
|---|---|---|
| `src/workbench/text.ts` (workbench-ui) | T4 | layout, panels, tray, cards |
| `shared/fidelity-text.ts` (design-fidelity) | T3 | fit messages, readout, badge, stale note, modes, research labels, tool labels |
| `shared/fit-text.ts` (body-fit) | T3 | used by the browser and `attach-to-body.ts`, `fit-to-body.ts` |
| `TEXT` constants of new tool files (workbench-ui, design-fidelity, body-fit) | T3 | become `TOOL_TEXT` entries or `defineText` in place |
| `shared/demo-bracelet.ts` (body-fit) | T3 | per-language names like `demoModelFor` (R37) |
| `COMPONENT_SEALED` in `src/export/findings.ts` (design-fidelity) | T5 | with the other export findings |
| `src/hands/text.ts` additions (workbench-ui) | T5 | with the existing hand texts |
| `shared/workspace.ts` `MESSAGES` additions (workbench-ui) | T3 | with the existing workspace errors |

| File(s) | english-ui task | Other spec (status) |
|---|---|---|
| `shared/i18n/lang.ts`, `define.ts`, `format.ts`, `content.ts`, `src/i18n/lang-store.ts`, `LanguageProvider.tsx`, `ui-text.ts`, `tests/unit/i18n-core.test.ts`, `i18n-tables.test.ts`, `i18n-scan.test.ts` | T1 (new); T6 edits `lang-store.ts`, `i18n-scan.test.ts` | — (others import them) |
| `src/main.tsx`, `src/i18n/api.ts`, `src/i18n/LanguageSwitch.tsx`, `server/i18n/instructions.ts`, `playwright.config.ts`, `tests/unit/i18n-server.test.ts` | T2 (T4 edits the switch) | — |
| `src/App.tsx` | T2 (switch, headers), T4 (strings), T6 (notice, hint, button) | workbench-ui (its T3–T7), design-fidelity (mounts only, its `src/fidelity/`), body-fit (state, one ref, mount points), assembly-joints and export (done) |
| `src/workbench/**`, `src/fidelity/**`, `src/fit/**` | T4 (`src/workbench/**`), T5 (`src/fidelity/**`, `src/fit/**`): strings only | workbench-ui, design-fidelity, body-fit (owners) |
| `src/agent/useAgentRun.ts` | T2 (header), T4 | workbench-ui (agent panel, expected) |
| `server/app.ts` | T2 (middleware), T3 (errors) | — |
| `server/provider.ts` | T2 (language line, signatures), T3 (errors) | design-fidelity (rules, expected) |
| `server/agent.ts` | T2 (instructions), T3 (snapshot, errors), T6 (one rule, P2) | design-fidelity (research tool line), body-fit (fit tool lines), expected |
| `server/agent-tools.ts`, `server/tools/helpers.ts` | T2 (`lang`, `langOf`), T3 | body-fit (new tools use helpers, expected) |
| `server/tools/generate-design.ts`, `edit-design.ts` | T2, T3 | — |
| `server/codex.ts`, `claude.ts`, `app-server.ts`, `model-host.ts`, `index.ts` | T2 (signature), T3 (errors) | — |
| `server/tools/registry.ts`, every `server/tools/*.ts` | T3 | body-fit (`wear-on-arm.ts`, new fit tool), design-fidelity (`research-reference.ts`), expected |
| `shared/joint-rules.ts`, `joint.ts`, `kit.ts`, `materials.ts`, `standard-parts.ts`, `contact.ts`, `export-plan.ts` | T3 | design-fidelity (`joint.ts` shell row; standard-parts, expected) |
| `shared/workspace.ts` | T3 (messages), T6 (P2 op) | workbench-ui (pull a part out, expected) |
| `shared/edit.ts`, `shared/model.ts`, `shared/demo.ts`, `shared/agent.ts` | T3 | design-fidelity (`model.ts` shell), body-fit (`agent.ts` StateChange), expected |
| `shared/i18n/*.ts` area tables, `server/i18n/errors.ts`, `tools.ts`, `snapshot.ts` | T3 | others add keys after T3 |
| `src/agent/AgentPanel.tsx`, `labels.ts`, `run-reducer.ts`, `request.ts` | T4 | workbench-ui (expected) |
| `src/scene/SceneViewport.tsx`, `src/scene/geometry.ts` | T4 | workbench-ui, design-fidelity (`geometry.ts` shell), body-fit (arm preview), expected |
| `src/workspace/*` | T4 | workbench-ui (expected) |
| `src/i18n/app.ts`, `agent.ts`, `scene.ts`, `workspace.ts` | T4 | others add keys after T4 |
| `src/hands/text.ts`, `controller.ts`, `useHandControl.ts`, `HandDebugPanel.tsx` | T5 | hand-manipulation (done), body-fit (tracking, expected) |
| `src/joints/*`, `src/print/printable.ts` | T5 | design-fidelity (`printable.ts` shell, expected) |
| `src/export/*` | T5 | design-fidelity (BOM of shell parts, expected) |
| `src/i18n/hands.ts`, `joints.ts`, `export.ts` | T5 | others add keys after T5 |
| `src/i18n/content.ts`, `server/tools/set-texts.ts`, `tests/e2e/english.spec.ts`, `tests/unit/readme-sync.test.ts`, `README.zh-TW.md` | T6 | — |
| `README.md` | T6 | every spec adds sections (workbench-ui, design-fidelity, body-fit, expected) |
| Existing unit tests that call changed functions | T3, T4, T5 (call arguments only) | owned by their specs |
| `src/styles.css` | T4/T5 only if English text overflows (N3) | workbench-ui (expected) |

## 11. Glossary (one English term per concept)

| zh-TW | English | | zh-TW | English |
|---|---|---|---|---|
| 物件 | object | | 零件 | part |
| 工作區 | workspace | | 代理 | agent |
| 生成 3D 草案 | Generate 3D draft | | 載入示範模型 | Load demo model |
| 修改目前模型 | Edit current model | | 生成新物件 | New object |
| 套用修改 | Apply edit | | 復原 / 重做 | Undo / Redo |
| 開啟攝影機 / 關閉攝影機 | Turn on camera / Turn off camera | | 手勢 | Hand control |
| 隱藏鏡頭畫面 | Hide camera image | | 護臂試戴 | Arm try-on |
| 爆炸圖 | exploded view | | 拆開程度 | Explode amount |
| 放大 / 縮小 / 重設視角 | Zoom in / Zoom out / Reset view | | 刪除零件 / 刪除物件 | Delete part / Delete object |
| 接合 | joint | | 新增接合 / 確認接合 | Add joint / Confirm joint |
| 換一組面 | Next face pair | | 取消接合 | Cancel joint |
| 可以接合 | Ready to join | | 顯示接合 | Show joints |
| 確認方式 / 改用建議 | Confirm method / Use recommendation | | 重新對齊 | Realign |
| 請代理建議 | Ask the agent | | 刪除接合 / 收合 | Delete joint / Collapse |
| 熱壓螺母＋螺絲 | Heat-set insert + screw | | 磁鐵 / 定位銷 / 膠合 | Magnet / Dowel pin / Glue |
| 負重 / 拆裝 | Load / Disassembly | | 輕 / 中 / 重 | Light / Medium / Heavy |
| 不拆 / 偶爾 / 經常 | Never / Sometimes / Often | | 待確認 / 已確認 / 有問題 | Pending / Confirmed / Problem |
| 錯誤 / 警告 / 提示 | Error / Warning / Note | | 列印設定 | Printer settings |
| 列印件 | print piece (BOM: Printed) | | 外購件 / 加工件 / 標準件 | Bought component / Machined part / Standard part |
| 匯出套件 / 下載完整套件 | Export kit / Download full kit | | 關閉匯出 / 停止準備 | Close export / Stop preparing |
| 整個工作區 / 目前物件的組合件 | Whole workspace / Active object's assembly | | 交給代理處理 | Hand it to the agent |
| 執行 / 取消 | Run / Cancel | | 代理回覆 | Agent reply |
| 手勢：… | Hand: … | | 未指定 | Not set |
| 鋁 / 鋼 / 尼龍 / 樹脂 | Aluminium / Steel / Nylon / Resin | | 右面 / 左面 / 頂面 / 底面 / 前面 / 後面 | Right / Left / Top / Bottom / Front / Back face |

The English names never equal an existing Chinese selector, so the English and Chinese selectors cannot collide. T4 and T5 may improve a wording; they then update this table in the same task.

## 12. Parallel-session rules

For the sessions of this spec (repeated in each task's session facts):
- Create and edit only the files the task lists. Never revert, reformat, stage or "fix" a file you did not change; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`.
- Before the first edit of a file that another spec also edits (§10), run `git status --short <file>`. If it shows changes, another session is working on it: stop and ask. Do not wait in a loop.
- Before T3, T4 or T5 starts, read the `tasks.md` of `workbench-ui`, `design-fidelity` and `body-fit` and check that every task that edits the same files is marked done. If one is not, stop and report which.
- Only one session runs Playwright at a time (ports 5197/8797). If the ports are taken, wait a few minutes and try again, at most three times, then report.

For the other specs, once T1 has landed (proposed for their session facts; the user decides, question 1):
- New user-facing strings go into a table of the area (§2, §3.2) with both languages. If unsure of the English, write a plain sentence; T4–T6 review the wording against the glossary.
- Text-building functions take `lang: Lang`. Components read it with `useLang()`. Server tools read it with `langOf(state)`; new tool display names are `localized(zh, en)` (after T3).
- New notices in React state are `UiText` values (after T4).
- Do not change an existing zh-TW string while moving it.

## 13. Requirement-to-task map

| Task | Waits for | Requirements |
|---|---|---|
| T1 | nothing | R1, R18, R47, R48 (report), R53, R54, R56; N6, N7 |
| T2 | T1; clean `src/App.tsx`, `server/provider.ts`, `server/agent.ts`, `server/app.ts` | R2–R9, R19, R23, R25, R44, R59 |
| T3 | T2; the other specs' tasks on `shared/` and `server/` files done | R13 (shared), R20–R22, R24, R26, R27 (server), R32, R37, R45, R46 (server), R55, R57, R59 |
| T4 | T3; workbench-ui's tasks on its files done | R10, R11, R15–R17, R27 (browser), R38, R39, R40 (cue), R46 (browser), R60, N3 |
| T5 | T4; the other specs' tasks on hands, joints, export done | R12, R13 (browser), R14, R28–R31, R40 (badges), R57, N3 |
| T6 | T5 | R9 (on), R34–R36, R41–R43, R48 (strict), R50–R52, N1, N2, N4 |

R45, R58 and N5–N8 apply to every task.

## 14. Risks

- **Schedule** (decision 12): the extraction is about 70 files in the last week; three other specs edit the same files until then. Mitigation: T1 and T2 early; the extraction tasks are each one area; the reference cut order in `requirements.md`.
- **Hidden Chinese text in tests' data**: some e2e routes return Chinese model data (`tests/e2e/representative-prompts.ts`, fixtures). That is user content and stays; the English e2e uses its own English fixtures.
- **Text that is both data and display**: `Finding.message`, `Material.label` and the standard-part `label` keep their zh-TW values for compatibility (§5.1). A display that still reads them shows Chinese in the English UI; the English e2e (body text without CJK) and T5's switch to `findingText` catch it. The strict scan does not, because these fields are in tables.
- **Layout** (N3): English labels are 2–3 times longer than Chinese ones. T4 and T5 may need small CSS changes in a file `workbench-ui` owns; they check `git status` first.
- **Accept-Language** (decision 3): if a browser refused to let `fetch` set the header, the server would fall back to zh-TW silently. The English e2e checks the header the route receives.
- **Model compliance**: a model may still answer in the instruction's language despite R25. The manual check asks for an English generation and reply typed in Chinese.
