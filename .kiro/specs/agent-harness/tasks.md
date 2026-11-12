# Agent Harness — Tasks

Implementation order follows the design: shared schemas → tools → loop → `/api/agent` route → frontend hook and panel → e2e test → deferred tools last. Each task has its own tests and must keep `npm run check` (type check + build + unit tests) green before it is marked done (req 30). Tests never call a real model back end; they inject a fake `ModelProvider` (req 29).

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

---

## Task 1 — `shared/agent.ts`: schemas and validators

`[x]`

Create `shared/agent.ts` with the Zod authority for the agent contract. Both server and client import it.

**Build:**
- `ToolCallSchema`, `AgentStepSchema` (flat-nullable, strict — see design §2.1).
- `ModelStateChangeSchema` (`{ kind: 'generated'|'edited', model: ModelSpecSchema, source, providerModel }`).
- `ToolResultSchema` (`{ tool, ok, summary, detail, stateChange }` — `stateChange.model` is `ModelStateChangeSchema.nullable()`).
- `AgentTurnSchema`, `AgentRequestSchema` (`model` is `nullable()`; `selectedPartIds` must be empty when `model` is null — enforced in `validateAgentRequest`, not the raw schema).
- Per-tool detail schemas: `GenerateDesignDetail` (no `model` field), `EditDesignDetail`, `GetProjectStateDetail`, `ExplodeViewDetail`, `WearOnArmDetail`, `ToolErrorDetail`. (`EstimateDetail`/`FeasibilityDetail` are stubbed here, implemented in Task 9.)
- `validateAgentStep(input)`: parse + consistency rules (type/calls/reply, per-tool arg presence, all other args null). Returns `AgentToolCalls | AgentFinal`.
- `validateAgentRequest(input)`: parse + semantic checks (selection empty when model null; selection ⊆ parts when model present). Returns typed request with `model: ModelSpec | null`.
- `agentJsonSchema()`: `z.toJSONSchema(AgentStepSchema, { target: 'draft-7' })` with `$schema` stripped, matching `designJsonSchema()`/`editJsonSchema()`.
- SSE event-name constants and a `serializeSseEvent(name, data)` helper (pure string builder: `event: <name>\ndata: <json>\n\n`).

**Tests** (`tests/unit/agent.test.ts`):
- `validateAgentStep` accepts a valid `tool_calls` step (one call, `generate_design` with `prompt`, all other args null) and a valid `final` step.
- Rejects: `tool_calls` with empty/null `calls`, `final` with `calls`, `final` with null `reply`, `tool_calls` with non-null `reply`.
- Per-tool arg presence: `edit_design` requires `instruction`; `select_parts` requires `partIds`; `explode_view` requires `amount`; `wear_on_arm` requires `enabled`; `get_project_state` requires all args null; each rejects when a required arg is null or a non-required arg is non-null.
- `agentJsonSchema()` is a single top-level object (no `anyOf`/`oneOf` at the root), every property `required`, `$schema` stripped. Nullable fields' nested `anyOf: [T, { type: 'null' }]` are expected and present (same as `editJsonSchema()`'s five) — assert they exist inside `args`/`stateChange`, not at the root.
- `ModelStateChangeSchema` round-trips a generated and an edited change; rejects a `model` that fails `ModelSpecSchema`.
- `validateAgentRequest` accepts `model: null` with empty selection; rejects `model: null` with non-empty selection; rejects an invalid model (non-null but bad parts) with `INVALID_MODEL`; rejects a selection referencing a part not in the model.
- `serializeSseEvent` produces the exact frame format for a given name and data.

**Dependencies:** none (uses existing `shared/model.ts`, `shared/edit.ts`, `shared/schema.ts`).
**Done when:** `npm run check` passes and the above tests are green.

---

## Task 2 — `server/agent-tools.ts`: local tools and dispatch

`[x]`

Create the tool registry with the working-copy type and the locally-computable tools. Model-calling tools (`generate_design`, `edit_design`) are added in Task 3.

**Build:**
- `AgentWorkingState` type: `{ model: ModelSpec | null; selection: string[]; explode: number; tryOn: boolean; cameraOn: boolean }`.
- `runTool(call, state, provider, signal): ToolResult` — dispatch by `call.tool`; each tool validates its own args via the per-tool validator from `shared/agent.ts`; bad args → `ToolResult { ok:false, detail: ToolErrorDetail { code: 'INVALID_ARGS', message } }` with no `stateChange` (req 15).
- `select_parts`: validates `partIds` ⊆ current parts; when `state.model` is null → `ToolError { code: 'NO_MODEL' }`; else sets `state.selection` and returns `stateChange.selection`.
- `get_project_state`: works with or without a model; returns `GetProjectStateDetail` (parts summary, selection, explode, tryOn); no `stateChange`.
- `explode_view`: validates `amount ∈ [0,1]`; when `state.model` is null → `NO_MODEL`; else sets `state.explode` and returns `stateChange.explode`.
- `wear_on_arm`: reads `enabled`; when `state.model` is null → `NO_MODEL`; `enabled && !cameraOn` → `ok:false` summary "請先開啟攝影機再試戴", no `tryOn` change; `enabled && cameraOn` → `stateChange.tryOn = true`; `!enabled` → `stateChange.tryOn = false`.
- A `noModelError()` helper and a shared `invalidArgs()` helper.

**Tests** (`tests/unit/agent-tools.test.ts`):
- `select_parts`: changes selection and returns `stateChange.selection`; rejects partIds not in the model (`INVALID_ARGS`); returns `NO_MODEL` when `state.model` is null.
- `get_project_state`: returns the snapshot and no state change; works with `model: null` (empty parts).
- `explode_view`: sets explode for valid `amount` (0, 0.5, 1); rejects out-of-range (`INVALID_ARGS`); returns `NO_MODEL` when model is null.
- `wear_on_arm`: `cameraOn:false` + `enabled:true` → `ok:false`, no `tryOn` in `stateChange`; `cameraOn:true` + `enabled:true` → `stateChange.tryOn = true`; `enabled:false` → `stateChange.tryOn = false`; `NO_MODEL` when model is null.
- Bad-args path for each tool (missing required arg) → `ok:false`, `INVALID_ARGS`, no `stateChange`.

**Dependencies:** Task 1.
**Done when:** `npm run check` passes and the above tests are green.

---

## Task 3 — `server/agent-tools.ts`: model-calling tools

`[x]`

Add `generate_design` and `edit_design` to the registry. They delegate to `provider.run(designTask(...))` / `provider.run(editTask(...))` with the passed `signal`, and translate results into `ToolResult` with a `ModelStateChange`.

**Build:**
- `generate_design(call, state, provider, signal)`: requires `prompt`; calls `provider.run(designTask(prompt), signal)`; `validateDesign` the raw result; `status === 'ready'` → `ok:true`, `stateChange.model = { kind:'generated', model, source: provider.name, providerModel: provider.model }`, `detail = GenerateDesignDetail { source, providerModel, status }` (no `model` in detail); `status === 'approximation'`/`'unsupported'` → `ok:false`, no `stateChange`, detail carries `status` + explanation. Works with or without `state.model`.
- `edit_design(call, state, provider, signal)`: requires `instruction`; when `state.model` is null → `NO_MODEL`; calls `provider.run(editTask(state.model, instruction, state.selection), signal)`; `validateEditPlan`; `status === 'applied'` → `applyEditPlan(state.model, plan)`; on a local `EditError` → `ToolError` no state change; on success → `stateChange.model = { kind:'edited', model: <result of applyEditPlan>, source, providerModel }`, `detail = EditDesignDetail { changes, explanation }`; `status === 'clarify'`/`'unsupported'` → `ok:false`, no `stateChange`, detail carries explanation.
- **An abort or a `GenerationError` from `provider.run` is NOT caught inside these tools** — it propagates to the loop and ends the run (Task 4). Only local failures (bad args, `NO_MODEL`, `EditError` from `applyEditPlan`) become `ToolResult`s.
- Wire both into `runTool` dispatch.

**Tests** (`tests/unit/agent-tools-model.test.ts`, fake `ModelProvider` with scripted `run`):
- `generate_design` ready → `ok:true`, `stateChange.model.kind === 'generated'`, detail has `status` and no `model` field, `source`/`providerModel` come from the provider; state's working model becomes the new model.
- `generate_design` approximation/unsupported → `ok:false`, no `stateChange.model`.
- `generate_design` works when `state.model` is null.
- `generate_design` passes the `signal` through to `provider.run`.
- `edit_design` applied → `ok:true`, `stateChange.model.kind === 'edited'`, `stateChange.model.model` equals the post-`applyEditPlan` model, detail has `changes`/`explanation`; `clarify`/`unsupported` → `ok:false`, no state change.
- `edit_design` on an `EditError` from `applyEditPlan` → `ToolError`, no state change.
- `edit_design` with `state.model` null → `NO_MODEL`.
- `edit_design` passes `state.model`/`instruction`/`state.selection` into `editTask` (assert via the fake provider capturing the task `input`).
- Propagation: when the fake provider's `run` throws an `AbortError`/`GenerationError`, both `generate_design` and `edit_design` re-throw (do not return a `ToolResult`).

**Dependencies:** Tasks 1, 2.
**Done when:** `npm run check` passes and the above tests are green.

---

## Task 4 — `server/agent.ts`: the agent loop

`[ ]`

Create the loop, the `agentTask` builder, and `AGENT_INSTRUCTIONS`.

**Build:**
- `runAgent(provider, req, { maxRounds=6, totalTimeoutMs }, emit, clientSignal)` per design §4. Inside, build `timeoutSignal = AbortSignal.timeout(totalTimeoutMs)` and `runSignal = AbortSignal.any([clientSignal, timeoutSignal])`, passed to every `provider.run`/`runTool`. Working copy starts `model: req.model == null ? null : validateModel(req.model)`; selection starts `[]` when model is null else `req.selectedPartIds ∩ parts`.
- Each round: check `runSignal.aborted` → throw an abort sentinel; build `agentTask(history, rounds, state, instruction)`; `await provider.run(task, runSignal)`; `validateAgentStep`; retry once on validation failure (re-check `runSignal.aborted` first, end via the cancel/timeout path if already aborted); on second failure emit sanitized `error` + `done`.
- On `final`: `emit('final', reply)`, `emit('done')`, return.
- On `tool_calls`: `emit('status', note)`; for each call `emit('tool', {tool,args})`, `runTool(...)` (throws on provider abort/`GenerationError`), `emit('result', stripModel(result))` (a copy with `stateChange.model = null`); if `result.stateChange` set, apply it to the working copy and `emit('state', result.stateChange)`; push compact `{ call: {tool, args}, result: {ok, summary, detail} }` to `rounds`.
- On max rounds reached without final: `emit('error', sanitized zh-TW "agent did not finish")`, `emit('done')`.
- **Error/timeout/cancel handling:** an abort or `GenerationError` from `provider.run` or `runTool` propagates (not a `ToolResult`) and is caught by the loop, which distinguishes why: **client cancel** (`clientSignal.aborted`) → stop, emit nothing; **total-run timeout** (`timeoutSignal.aborted`) → emit a sanitized Traditional Chinese timeout `error` + `done`; **other `GenerationError`** → emit a sanitized `error` + `done`. Earlier rounds' `state` events were already emitted and stay.
- `agentTask(...)`: `ModelTask<AgentStep>` with `kind:'agent'`, `instructions: AGENT_INSTRUCTIONS`, `schema: agentJsonSchema()`, `input` = client `history` + compact `rounds` (no full ModelSpecs) + instruction + compact current-state snapshot (the `get_project_state`-style summary of the working copy), `parse: validateAgentStep`.
- `AGENT_INSTRUCTIONS`: English rules listing tools/required args, the empty-scene rule, "use real tool results, never fabricate", "call `get_project_state` before editing if unsure", "return `final` when done, `note` to narrate", reused geometry/units lines from `MODEL_INSTRUCTIONS`. User-facing strings in Traditional Chinese.
- `stripModel(result)`: returns a shallow copy with `stateChange` copied and `stateChange.model = null` (or `stateChange` nulled if it had no other fields).

**Tests** (`tests/unit/agent-loop.test.ts`, fake provider returning scripted `AgentStep`s via a queue):
- Multi-round success: round 1 returns `tool_calls` (one local tool, e.g. `get_project_state`), round 2 returns `final` → emits `status`, `tool`, `result`, `final`, `done` in order; the `result` event has `stateChange.model === null`; loop ends.
- Model-change round: round 1 returns `generate_design` (fake provider yields a ready design), round 2 `final` → a `state` event with `model.kind === 'generated'` is emitted exactly once; the working copy's model is updated for round 2's snapshot.
- Max-rounds end: provider always returns `tool_calls` → after `maxRounds` the loop emits `error` ("did not finish") + `done`; earlier `state` events were already emitted.
- Total-run timeout: pass `totalTimeoutMs` tiny; the `AbortSignal.timeout` aborts the in-flight `provider.run` (fake provider rejects on abort) → loop emits a sanitized zh-TW timeout `error` + `done` and ends; earlier `state` events were already emitted.
- Client cancel mid-round: abort `clientSignal` after round 1 starts → loop ends and emits nothing (no `error`, no `done`); the in-flight `provider.run` was called with the combined `runSignal` (now aborted).
- Provider `GenerationError` mid-run: the fake provider's `run` throws a non-abort `GenerationError` → loop emits a sanitized `error` + `done` (no provider body leaked) and ends; earlier `state` events were already emitted.
- Retry-once: provider returns an invalid `AgentStep` (fails `validateAgentStep`) on round 1, valid on the retry → round completes; if invalid twice → `error` + `done` (sanitized message, no provider body leaked).
- Fabrication guard: the `rounds` pushed to history are exactly `{ call, result: { ok, summary, detail } }` with no `stateChange` and no full `ModelSpec`; the `agentTask` input for round 2 contains the compact snapshot but no accumulated full model.
- Each `provider.run` call receives the combined `runSignal` (the fake provider records the signal).

**Dependencies:** Tasks 1, 2, 3.
**Done when:** `npm run check` passes and the above tests are green.

---

## Task 5 — `server/agent-events.ts` + `server/app.ts`: the `/api/agent` route

`[ ]`

Add the SSE writer and the `/api/agent` route with the `agentRoute` lifecycle.

**Build:**
- `server/agent-events.ts`: `setSseHeaders(res)` (Content-Type `text/event-stream`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Connection: keep-alive`) and `createEmitter(res)` returning an `emit(name, data)` that writes `serializeSseEvent(name, data)` and flushes; plus a `close` to end the response.
- `server/app.ts`:
  - `agentRoute(res, requestId, work)` — `res.close` → `controller.abort()` (the `clientSignal`), increments `activeRequests`, runs `work(clientSignal)`, decrements `activeRequests` in `finally` (after `work` settles = provider stopped). Concurrency (`activeRequests >= 3`) is rejected by the handler before streaming. `runAgent` emits all terminal SSE events itself; the route only wraps the call so an unexpected throw still ends the stream with a sanitized `error` + `done` backstop, and always releases `activeRequests`.
  - `POST /api/agent` handler: parse `AgentRequestSchema` → 400 `INVALID_REQUEST` JSON (pre-stream); `validateAgentRequest` → 400 `INVALID_MODEL` / `INVALID_SELECTION` JSON (pre-stream); concurrency `>= 3` → 429 `BUSY` JSON (pre-stream); then `setSseHeaders`, `agentRoute(res, requestId, async (clientSignal) => { await runAgent(provider, req, { maxRounds, totalTimeoutMs }, emit, clientSignal); })`. `runAgent` builds the combined `runSignal` itself so it can distinguish client cancel from the total-run timeout.
  - Add `agentMaxRounds` and `agentTotalTimeoutMs` to `AppOptions`/env (defaults 6 and a configured total). The existing `MODEL_TIMEOUT_MS` is not applied to the whole run.
- `/api/generate` and `/api/edit` are untouched.

**Tests** (`tests/unit/server-agent.test.ts`, supertest against `createApp` with a fake provider):
- Success stream: POST a valid request (model present) → 200, `text/event-stream`, frames arrive (`status`, `tool`, `result`, `state`, `final`, `done`); the `result` frame's `stateChange.model` is null; the `state` frame carries the `ModelStateChange`.
- `model: null` accepted: POST with `model: null` and empty selection → stream starts and a `generate_design` round produces a `generated` `state` event.
- 429 on concurrency: fire 4 concurrent requests → one gets 429 `BUSY` JSON (not an SSE event), status 429, before any `event-stream` header.
- 400 `INVALID_REQUEST`: malformed body → 400 JSON, no SSE.
- 400 `INVALID_MODEL`: non-null but invalid model → 400 JSON, no SSE.
- 400 `INVALID_SELECTION`: selection referencing a missing part, or non-empty selection with `model: null` → 400 `INVALID_SELECTION` JSON, no SSE.
- Origin rejection: non-loopback origin → 403 JSON (existing middleware).
- Body > 128 kB → 413 JSON (existing handler).
- Total-run timeout over the wire: set `agentTotalTimeoutMs` tiny in `AppOptions` (fake provider holds the call) → the stream ends with an `error` event (sanitized zh-TW timeout) + `done`; no hang.
- Client cancel over the wire: abort the supertest request mid-stream → the fake provider's `run` sees `signal.aborted`; the stream ends with no further `error`/`done` event (cancel is silent).
- Mid-stream sanitized error: fake provider throws a non-abort `GenerationError` on round 2 → `error` event with a sanitized Traditional Chinese message (no provider body/key) then `done`; response ends.

**Dependencies:** Tasks 1–4.
**Done when:** `npm run check` passes and the above tests are green.

---

## Task 6 — `src/agent/types.ts` + `src/agent/sse.ts` + `src/agent/apply-state.ts`: pure frontend helpers

`[ ]`

Pure, DOM-free functions unit-tested in Node (no jsdom/happy-dom).

**Build:**
- `src/agent/types.ts`: export the `DisplayModel` type (`{ model: ModelSpec; source: string; providerModel: string; requestId: string; startedAt: number | null; lineage: string; edited: boolean }`) moved out of `App.tsx`, so agent helpers can import it without pulling DOM code. `App.tsx` is updated to import it from here in Task 7b.
- `src/agent/sse.ts`: `parseSseStream(chunk: string, carry: string): { frames: SseFrame[]; carry: string }` — accumulates a streaming string, splits on `\n\n`, parses `event:`/`data:` lines (multi-line `data` joined), returns complete frames and any partial tail to carry. `SseFrame = { event: string; data: string }`.
- `src/agent/apply-state.ts`: `applyStateEvent(event, current, { requestId, now, newLineage }): { commitArg?: DisplayModel; selection?: string[]; explode?: number; tryOn?: boolean }` — given a parsed `state` event payload, the current `DisplayModel | null`, and deterministic `requestId`/`now`/`newLineage`. The `ModelStateChange` payload carries none of those three; the caller supplies them so tests are deterministic and App keeps its `crypto.randomUUID()` lineage convention by passing `newLineage` in:
  - `model.kind === 'generated'` → `commitArg = { model, source, providerModel, requestId, startedAt: now, lineage: newLineage, edited: false }` (new lineage → `commit` resets selection/explode).
  - `model.kind === 'edited'` → `commitArg = { ...current, model, source, providerModel, requestId, startedAt: now, edited: true }` (keeps lineage); `current === null` → no `commitArg`.
  - passes through `selection`/`explode`/`tryOn` when present.

**Tests** (`tests/unit/sse.test.ts`, `tests/unit/apply-state.test.ts`):
- `parseSseStream`: one full frame in one chunk → parsed; a frame split across two chunks → first call returns empty frames + carry, second call returns the frame; multi-line `data` → joined with `\n`; multiple frames in one chunk → all parsed; trailing partial → carried.
- `applyStateEvent` generated: returns a `commitArg` with `lineage === newLineage`, `edited:false`, `startedAt === now`, `requestId` from the param; the new lineage triggers `commit`'s selection/explode reset.
- `applyStateEvent` edited: returns a `commitArg` reusing `current.lineage`, `edited:true`, `requestId`/`startedAt` replaced by the params, other display fields preserved.
- `applyStateEvent` edited with `current === null` → no `commitArg`.
- `applyStateEvent` with only `selection`/`explode`/`tryOn` → returns those, no `commitArg`.
- `DisplayModel` is imported (type-only) from `src/agent/types.ts` (no DOM pulled into the Node test).

**Dependencies:** Task 1 (for the `ModelStateChange` type). `DisplayModel` comes from the new `src/agent/types.ts` created here.
**Done when:** `npm run check` passes and the above tests are green.

---

## Task 7a — `src/agent/useAgentRun.ts` + `src/agent/AgentPanel.tsx`

`[ ]`

The DOM-coupled hook and panel. Verified by `npm run check` (types + build) here and by the e2e in Task 8.

**Build:**
- `src/agent/useAgentRun.ts`: `useAgentRun({ commit, setSelected, setExplode, setTryingOn, getDisplay, getTurns, pushTurn })` → `{ run, cancel, active, log, reply }`. `run(instruction)` POSTs `/api/agent` with `AgentRequest` (`model: display?.model ?? null`, selection filtered to current parts, explode, tryOn, `camera === 'on'`, last ≤10 turns, a fresh `requestId`). Reads the `ReadableStream`, feeds chunks to `parseSseStream`, dispatches: `status`/`tool`/`result` → append to `log` (result rendered from `summary`+`detail`); `state` → `applyStateEvent(event, display, { requestId, now: performance.now(), newLineage: crypto.randomUUID() })` then call `commit`/`setSelected`/`setExplode`/`setTryingOn`; `final` → set `reply`, push `{ instruction, reply }` to turns, end; `error` → set sanitized message, end; `done` → end. `cancel` aborts the fetch (`AbortController`). Imports `DisplayModel` from `src/agent/types.ts`.
- `src/agent/AgentPanel.tsx`: instruction textarea, "執行" button (disabled while `active` or empty instruction), scrollable progress log, final reply area, "取消" button while `active`. All strings Traditional Chinese. Exposes `agentActive` to the parent for control disabling (Task 7b).

**Tests:** none unit (DOM-coupled). Verification = `npm run check` (types + build) + the e2e in Task 8.

**Dependencies:** Tasks 1, 5, 6.
**Done when:** `npm run check` passes (types + build); full green requires Task 7b + Task 8.

---

## Task 7b — `src/App.tsx`: wiring and disabling controls during a run

`[ ]`

Wire the panel into the app and disable manual interaction during a run.

**Build:**
- `src/App.tsx`: replace the local `DisplayModel` type with an import from `src/agent/types.ts`; render `<AgentPanel>` in the control column; expose `commit`, `setSelected`, `setExplode`, `setTryingOn`, current `display`, and a bounded turns list (≤10) to `useAgentRun`. Add `agentActive` (from `useAgentRun`) gating the existing `disabled` props for the generate form, edit form, manual adjustment fields, transform handles, undo/redo buttons, explode slider, and selection picking (req 26). The camera toggle stays enabled. Existing prompt/edit forms are retained (req 25). Keep the existing `crypto.randomUUID()` lineage convention by passing it into `applyStateEvent` via `useAgentRun`'s `newLineage`.

**Tests:** none unit. Verification = `npm run check` (types + build) + the e2e in Task 8 (which asserts controls are disabled during a run and re-enable after cancel).

**Dependencies:** Tasks 6, 7a.
**Done when:** `npm run check` passes (types + build) and Task 8's e2e is green.

---

## Task 8 — `tests/e2e/agent-panel.spec.ts`: agent panel e2e

`[ ]`

Playwright e2e using route interception with a scripted SSE body, following the existing `tests/e2e` pattern (`page.route('**/api/agent', ...)` returning a hand-built SSE response).

**Build:**
- Route `**/api/status` to a configured fake (existing pattern).
- Route `**/api/agent` to fulfill with a scripted SSE body: a `status` frame, a `tool` frame (`generate_design`), a `result` frame (no `stateChange.model`), a `state` frame carrying a `generated` `ModelStateChange` built from a **distinct `ModelSpec` with a different `name` and a different part count from `demoModel`** (so the "scene updated" and "undo reverts" assertions can tell the two models apart), then a `final` frame and `done`.
- Assertions:
  - The panel shows progress lines as frames arrive (`status`, tool, result, final).
  - The `state` event updates the 3D model to the distinct model — assert via the canvas `data-model-name`/`data-part-count` attributes (as the existing tests do); the name and part count differ from the pre-run model.
  - Undo works afterwards: click "復原" → reverts to the previous model (start from `loadDemo` so undo has a prior state; assert the name/part count return to `demoModel`'s).
  - Controls are disabled during the run: a held-response case (stream `status` + `tool`, then hold) asserts the generate form, edit form, undo/redo, explode slider, and manual adjustment are disabled while `active`.
  - Cancel works: in the held-response case, click "取消" → the run ends and the controls re-enable.

**Tests:** this file is the test.
**Dependencies:** Task 7b.
**Done when:** `npm run check` passes and `npx playwright test tests/e2e/agent-panel.spec.ts` is green.

---

## Task 9 — Deferred tools: `estimate_weight_cost` and `check_feasibility`

`[ ]`

Implement last; drop without affecting the loop or other tools if time runs short.

**Build:**
- `estimate_weight_cost(call, state, provider, signal)`: requires no model call; when `state.model` is null → `NO_MODEL`; compute each part's bounding-box volume × `densityKgPerM3` (default a sensible material density, adjustable via `material` arg); return `EstimateDetail { totalKg, totalCost, perPart }`; no `stateChange`. Add `densityKgPerM3`/`material` arg validation to the per-tool validator.
- `check_feasibility(call, state, provider, signal)`: when `state.model` is null → `NO_MODEL`; local geometry checks (floating parts — no support below; unreasonable interpenetration; dimensions out of the 0.001–100 m range); return `FeasibilityDetail { issues }`; no `stateChange`.
- Wire both into `runTool` dispatch (their enum entries and arg fields already exist from Task 1; the instructions already list them).
- Extend `AGENT_INSTRUCTIONS` notes only if needed (the tools are already listed).

**Tests** (`tests/unit/agent-tools-deferred.test.ts`):
- `estimate_weight_cost`: returns sensible `totalKg`/`totalCost`/`perPart` for a scripted model; uses the provided `densityKgPerM3`; uses the default when omitted; `NO_MODEL` when model null; bad `densityKgPerM3` (out of range) → `INVALID_ARGS`.
- `check_feasibility`: flags a floating part and an out-of-range dimension; returns empty `issues` for a well-formed model; `NO_MODEL` when model null.
- Neither tool sets a `stateChange` and neither calls `provider.run`.

**Dependencies:** Tasks 1, 2.
**Done when:** `npm run check` passes and the above tests are green.

---

## Notes for every task

- Run `npm run check` before marking a task done; report the real result (req 30).
- Tests use a fake `ModelProvider` and never call a real back end (req 29).
- Keep user-facing strings in Traditional Chinese; spec/code/comments in English (req 31).
- Commit messages: conventional commits naming the spec task, e.g. `feat(agent): add agent schemas (spec agent-harness, task 1)` (hackathon rules).
- `/api/generate` and `/api/edit` and their tests stay untouched (req 20).
