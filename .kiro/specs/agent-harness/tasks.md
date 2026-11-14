# Agent Harness — Tasks

Implementation order follows the design: shared schemas → tools → loop → `/api/agent` route → frontend hook and panel → e2e test → deferred tools last. Each task has its own tests and must keep `npm run check` (type check + build + unit tests) green before it is marked done (req 31). Tests never call a real model back end; they inject a fake `ModelProvider` (req 30).

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

---

## Task 1 — `shared/agent.ts`: schemas and validators

`[x]`

Create `shared/agent.ts` with the Zod authority for the agent contract. Both server and client import it.

**Build:**
- `ToolCallSchema` with `{ tool: string, argsJson: string, reason: nullable }` — no per-tool arg fields; the tool registry validates the tool name and each tool parses `argsJson`.
- `AgentStepSchema` (fixed schema, same as before but `ToolCallSchema` changed).
- `ModelStateChangeSchema` (`{ kind: 'generated'|'edited', model: ModelSpecSchema, source, providerModel }`).
- `ToolResultSchema` (`{ tool, ok, summary, detail, stateChange }` — `stateChange.model` is `ModelStateChangeSchema.nullable()`).
- `AgentTurnSchema`, `AgentRequestSchema` (`model` is `nullable()`; `selectedPartIds` must be empty when `model` is null — enforced in `validateAgentRequest`, not the raw schema).
- Per-tool detail schemas: `GenerateDesignDetail` (no `model` field), `EditDesignDetail`, `GetProjectStateDetail`, `ExplodeViewDetail`, `WearOnArmDetail`, `ToolErrorDetail`.
- `validateAgentStep(input)`: parse + consistency rules (type/calls/reply). Tool name validation (check against the registry) is done in `server/agent-tools.ts` dispatch, not here.
- `validateAgentRequest(input)`: parse + semantic checks (selection empty when model null; selection ⊆ parts when model present). Returns typed request with `model: ModelSpec | null`.
- `agentJsonSchema()`: `z.toJSONSchema(AgentStepSchema, { target: 'draft-7' })` with `$schema` stripped, matching `designJsonSchema()`/`editJsonSchema()`.
- SSE event-name constants and a `serializeSseEvent(name, data)` helper (pure string builder: `event: <name>\ndata: <json>\n\n`).

**Tests** (`tests/unit/agent.test.ts`):
- `validateAgentStep` accepts a valid `tool_calls` step (one call with `tool` string and `argsJson` string) and a valid `final` step.
- Rejects: `tool_calls` with empty/null `calls`, `final` with `calls`, `final` with null `reply`, `tool_calls` with non-null `reply`.
- `agentJsonSchema()` is a single top-level object (no `anyOf`/`oneOf` at the root), every property `required`, `$schema` stripped, `argsJson` is a plain string (no nested object schema that grows with tool count).
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
- `runTool(call, state, provider, signal): ToolResult` — dispatch by `call.tool`; each tool validates its own args via the per-tool validator from `shared/agent.ts`; bad args → `ToolResult { ok:false, detail: ToolErrorDetail { code: 'INVALID_ARGS', message } }` with no `stateChange` (req 16).
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

`[x]`

Create the loop, the `agentTask` builder, and `AGENT_INSTRUCTIONS`.

**Build:**
- `runAgent(provider, req, { maxRounds=6, totalTimeoutMs }, emit, clientSignal)` per design §4. Inside, build `timeoutSignal = AbortSignal.timeout(totalTimeoutMs)` and `runSignal = AbortSignal.any([clientSignal, timeoutSignal])`, passed to every `provider.run`/`runTool`. Working copy starts `model: req.model == null ? null : validateModel(req.model)`; selection starts `[]` when model is null else `req.selectedPartIds ∩ parts`.
- Each round: check `runSignal.aborted` → throw an abort sentinel; build `agentTask(history, rounds, state, instruction)`; `await provider.run(task, runSignal)`; `validateAgentStep`; retry once on validation failure (re-check `runSignal.aborted` first, end via the cancel/timeout path if already aborted); on second failure emit sanitized `error` + `done`.
- On `final`: `emit('final', reply)`, `emit('done')`, return.
- On `tool_calls`: `emit('status', note)`; for each call `emit('tool', {tool, argsJson})`, `runTool(...)` (throws on provider abort/`GenerationError`), `emit('result', stripModel(result))` (a copy with `stateChange.model = null`); if `result.stateChange` set, apply it to the working copy and `emit('state', result.stateChange)`; push compact `{ call: {tool, argsJson}, result: {ok, summary, detail} }` to `rounds`.
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

## Task 4b — Tool registry and schema migration

`[x]`

Migrate from the flat-args `AgentStep` to the tool-registry architecture. `ToolCallSchema` becomes `{ tool, argsJson, reason }`; each tool defines its own Zod args schema and parses `argsJson`. The tool list in `AGENT_INSTRUCTIONS` is generated from the registry. This task changes the schema, moves the six working tools into the registry, fixes the loop for the new call shape, and updates all tests. Client tools, home-scope tools, background jobs, and the deferred materials/estimate/feasibility tools are out of scope.

**Build:**
- `shared/agent.ts`:
  - `ToolCallSchema` becomes `{ tool: z.string().trim().min(1).max(64), argsJson: z.string().max(8000), reason: nullable }`. The tool-name enum and the flat `args` object are gone, as are `ToolName`, `ToolCallArgs`, and `validateToolCallArgs`.
  - `ToolResultSchema.tool` becomes a plain string, because an `UNKNOWN_TOOL` result echoes the requested name.
  - `validateAgentStep` still checks `type`/`calls`/`reply` consistency but not tool names or args; `runTool` does that at dispatch.
  - `agentJsonSchema()` needs no code change; `tool` and `argsJson` are plain strings, every property is required, there is no `anyOf`/`oneOf` at the root, and `$schema` is stripped.
  - Export `PartIdSchema` so `select_parts` can reuse the part-id format.
- `server/tools/registry.ts`:
  - `defineTool(def)` registers and returns the definition; registering a duplicate name throws.
  - Types: `ToolDefinition<TArgs>` (`name`, `category`, `description`, `args`, `side: 'server' | 'client'`, `scope: 'project' | 'home'`, `effects: 'read-only' | 'writes-scene' | 'writes-project' | 'writes-memory' | 'uses-camera' | 'sends-image' | 'long-running'`, `run`) and `ToolContext` (`{ state, provider }`).
  - `getTool(name)`, `listTools({ scope, side })` (registration order, omitted filters match everything), and `argsShapeText(schema)` (for example `partIds: string[]`, an empty string for `{}`).
  - `createToolRegistry()` returns a fresh registry with the same three functions; the module-level functions use one default instance. Tests that register extra tools use a fresh registry so they do not change the shared one.
- `server/tools/helpers.ts`: `ok`, `fail`, `noModel`, `requireRun`, and `NO_MODEL_MESSAGE` (`'目前沒有模型，請先生成設計。'`, unchanged).
- `server/tools/<name>.ts`: one file per working tool (`generate_design`, `edit_design`, `select_parts`, `get_project_state`, `explode_view`, `wear_on_arm`), each exporting its `defineTool(...)` result with a `z.strictObject` args schema (`get_project_state` takes `{}`). Behavior is unchanged from Tasks 2 and 3.
- `server/tools/index.ts`: imports the six tools; the import order is the order the model sees.
- `server/agent-tools.ts` stays the single entry point: `AgentWorkingState`, the re-exported result helpers, and `runTool(call, state, provider, signal)`:
  - unknown tool → `ToolError` `UNKNOWN_TOOL` (the message lists the registered tools);
  - `JSON.parse` failure, a non-object, or a Zod failure on `argsJson` → `ToolError` `INVALID_ARGS` with a short Traditional Chinese message (what was wrong plus the expected signature, never a raw Zod dump);
  - otherwise call the tool's `run`. `runTool` never mutates the working state, and an abort or `GenerationError` from `provider.run` still propagates.
- `server/agent.ts`: the loop needs two small changes because `call.args` no longer exists. The `tool` event is `{ tool, argsJson }`, and the compact round history stores `argsJson` (`{ call: { tool, argsJson }, result: { ok, summary, detail } }`). `AGENT_INSTRUCTIONS` stays in this file; only its tool-list section is generated from `listTools({ scope: 'project', side: 'server' })`, one new sentence explains `{ tool, argsJson }`, and every existing rule line and `GEOMETRY_RULES` stay.

**Tests** (`tests/unit/agent.test.ts`, `agent-tools.test.ts`, `agent-tools-model.test.ts`, `agent-loop.test.ts`, `tool-registry.test.ts`):
- `agent.test.ts`: remove the per-tool arg presence tests (they move to the tool tests); use `{ tool, argsJson, reason }` calls; assert that `validateAgentStep` does not check tool names or args, rejects an empty or over-long `tool`, an over-long `argsJson`, and the old flat `args`; assert `agentJsonSchema()` has `tool` and `argsJson` as plain strings (no enum, no nested object) and contains no tool names.
- `agent-tools.test.ts` and `agent-tools-model.test.ts`: each call is `{ tool, argsJson: JSON.stringify(args) }`. `INVALID_ARGS` for every tool with bad JSON, a missing required arg, and a wrong type (plus a non-object and a stray key for `get_project_state`), checked to leave state untouched and never reach the provider. `UNKNOWN_TOOL` for names that are not registered, including the deferred `estimate_weight_cost` and `check_feasibility`. The messages are Traditional Chinese with the expected signature and contain no Zod text.
- `tool-registry.test.ts`: `listTools` filters by scope and side and keeps registration order; a duplicate name throws and leaves the registry unchanged; the default registry holds exactly the six tools; the tool list in `AGENT_INSTRUCTIONS` is exactly those six lines; `argsShapeText` per tool.
- `agent-loop.test.ts`: the fake provider's `run` calls `task.parse(raw)` on the scripted value and turns a parse failure into `GenerationError('INVALID_MODEL', …)`, as `server/codex.ts` does. New tests: round 1's first step is invalid, the retry is valid, and the run completes (status, tool, result, final, done; no error); the `tool` event is `{ tool, argsJson }` and the next round's input records `argsJson`; an unknown tool and a bad `argsJson` become failed results and the run continues. The timeout and cancel tests use a model call that rejects when aborted.
- `AGENT_INSTRUCTIONS` still contains the six tool names and every geometry rule.

**Dependencies:** Tasks 1–4.
**Done when:** `npm run check` passes and all updated tests are green.

---

## Task 5 — `server/agent-events.ts` + `server/app.ts`: the `/api/agent` route

`[x]`

Add the SSE writer and the `/api/agent` route with the `agentRoute` lifecycle.

**Build:**
- `server/agent-events.ts`:
  - `setSseHeaders(res)`: status 200, Content-Type `text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Connection: keep-alive`, then `flushHeaders()`.
  - `createEmitter(res)` returns `{ emit(name, data), close(), closed }`. `emit` writes `serializeSseEvent(name, data)` and, after `done`, ends the response. It never writes once the response has ended, the response or socket is destroyed, the emitter is closed, or a write has thrown.
- `server/app.ts`:
  - `POST /api/agent` handler, in this order and all before any SSE header:
    1. `validateAgentRequest(req.body)`. A structural failure → 400 `INVALID_REQUEST`; an `AgentRequestError` → 400 `INVALID_MODEL` or `INVALID_SELECTION` with `requestId`. The body is `{ error: { code, message }, requestId }`, as in `/api/edit`, with fixed Traditional Chinese messages (the response never echoes a part id or Zod text).
    2. `activeRequests >= 3` → 429 `BUSY` JSON, as in `modelRoute`.
    3. `agentRoute(res, work)` with `work = (signal, emit) => runAgent(provider, req, { maxRounds, totalTimeoutMs }, emit, signal)`.
  - `agentRoute(res, work)` sends the SSE headers and creates the emitter. `res` `close` → `controller.abort()` (the `clientSignal`). It increments `activeRequests` and decrements it in `finally`, after `runAgent` has settled (the provider has stopped). `runAgent` emits every terminal event itself, and builds the combined run signal itself so it can tell a client cancel (silent) from the total-run timeout (`error` + `done`).
  - Final bound, like `modelRoute`'s `terminationGraceMs`: if `runAgent` has not settled `terminationGraceMs` after the total-run timeout, `agentRoute` aborts, emits the sanitized timeout `error` + `done`, ends the stream and releases the slot. Output from a late `runAgent` is dropped because the emitter is closed. An unexpected throw gets the same sanitized `error` + `done` backstop.
  - `AppOptions.agentMaxRounds` (default 6) and `AppOptions.agentTotalTimeoutMs` (default 600000). `MODEL_TIMEOUT_MS` (`timeoutMs`) still bounds one model call only.
- `server/agent.ts`: export `AGENT_TIMEOUT_MESSAGE`, shared by the loop and the route's final bound.
- `server/index.ts` and `.env.example`: `AGENT_MAX_ROUNDS` (integer 1–20, default 6) and `AGENT_TOTAL_TIMEOUT_MS` (integer ≥ 1000, default 600000), validated at startup, documented in Traditional Chinese like the other variables.
- `/api/generate` and `/api/edit` and their tests are untouched.

**Tests** (`tests/unit/server-agent.test.ts`, supertest against `createApp` with a fake provider whose `run` calls `task.parse` like the real adapters):
- Success stream: 200, `text/event-stream`, `no-store`, `nosniff`; frames `status`, `tool` (`{ tool, argsJson }`), `result`, `state`, `final`, `done` in order; the `result` frame's `stateChange.model` is null; the `state` frame carries the model change; the full model appears once in the stream.
- `model: null` accepted: a `generate_design` round produces a `generated` `state` event.
- `timeoutMs` (the single-call limit) does not bound the whole run.
- Plain JSON with no event-stream header, and the provider never called: 400 `INVALID_REQUEST` (empty body, unknown field, blank instruction, bad request id, missing `model` key), 400 `INVALID_MODEL`, 400 `INVALID_SELECTION` (unknown part, selection with no model; the id is not echoed), 403 for a non-loopback `Origin`, 413 for a body over 128 kB.
- 429 `BUSY` as plain JSON when three runs are held.
- Client abort: the held run's signal is aborted, the other runs are not, and a new run is accepted once the aborted one has settled.
- Mid-stream `GenerationError` on round 2 → sanitized `error` then `done`. An unexpected `Error` carrying a secret → fixed message, no provider text in the stream.
- Total-run timeout → timeout `error` then `done`. The slot stays held until a provider that was told to stop has stopped, then the held runs end with the timeout error. A provider that ignores cancellation is ended by the final bound and its slot is released.
- `createEmitter` unit tests with a stub response: frames, end after `done`, no writes after `done`/`close`/end, no writes or `end` when the socket or response is destroyed, no writes after a throwing write.

**Dependencies:** Tasks 1–4b.
**Done when:** `npm run check` passes and the above tests are green.

---

## Task 6 — `src/agent/types.ts` + `src/agent/sse.ts` + `src/agent/apply-state.ts`: pure frontend helpers

`[x]`

Pure, DOM-free functions unit-tested in Node (no jsdom/happy-dom).

**Build:**
- `src/agent/types.ts`: export the `DisplayModel` type (`{ model: ModelSpec; source: string; providerModel: string; requestId: string; startedAt: number | null; lineage: string; edited: boolean }`) moved out of `App.tsx`, so agent helpers can import it without pulling DOM code. `App.tsx` is not touched here; Task 7b switches its import.
- `src/agent/sse.ts`: `parseSseStream(chunk: string, carry: string): { frames: SseFrame[]; carry: string }`. It accumulates a streaming string, splits on a blank line, parses `event:`/`data:` lines (multi-line `data` joined with `\n`), accepts `\r\n` and `\r` line endings (a trailing `\r` is held back in case the `\n` comes in the next chunk), skips comment lines and frames without `data`, and returns complete frames plus any partial tail to carry. `SseFrame = { event: string; data: string }`.
- `src/agent/apply-state.ts`: `applyStateEvent(event, current, { requestId, now, newLineage }): { commitArg?: DisplayModel; selection?: string[]; explode?: number; tryOn?: boolean }`. The payload is validated with `StateChangeSchema` from `shared/agent.ts` (extracted from `ToolResultSchema` for this); an invalid payload returns `{}`. The `state` event carries all four fields, with `null` for "no change", so a `null` field is left out of the result. The `ModelStateChange` payload carries no `requestId`, `startedAt` or `lineage`; the caller supplies them so tests are deterministic and App keeps its `crypto.randomUUID()` lineage convention:
  - `model.kind === 'generated'` → `commitArg = { model, source, providerModel, requestId, startedAt: now, lineage: newLineage, edited: false }` (new lineage → `commit` resets selection/explode).
  - `model.kind === 'edited'` → `commitArg = { ...current, model, source, providerModel, requestId, startedAt: now, edited: true }` (keeps lineage); `current === null` → no `commitArg`.
  - passes through `selection`/`explode`/`tryOn` when not `null`, including `[]`, `0` and `false`.
- `shared/agent.ts`: export `StateChangeSchema`, and the payload schemas of the simple events (`StatusEventSchema`, `ToolEventSchema`, `FinalEventSchema`, `ErrorEventSchema`), so the client parses events with the same authority as the server.

**Tests** (`tests/unit/sse.test.ts`, `tests/unit/apply-state.test.ts`):
- `parseSseStream`: one full frame; a frame split across two chunks (empty frames + carry, then the frame); multi-line `data`; several frames in one chunk with a trailing partial carried; `\r\n` and bare `\r`; a `\r\n` split between chunks; the same frames however the stream is cut, down to one character per chunk; comments and data-less frames skipped.
- `applyStateEvent` generated: `commitArg` with `lineage === newLineage`, `edited:false`, `startedAt === now`, `requestId` from the param.
- `applyStateEvent` edited: reuses `current.lineage`, `edited:true`, `requestId`/`startedAt` replaced, `current` not mutated.
- `applyStateEvent` edited with `current === null` → no `commitArg`.
- `applyStateEvent` with only `selection`/`explode`/`tryOn` → returns those, no `commitArg`; all-null → `{}`.
- Invalid payloads (null, a string, `{}`, an unknown field, out-of-range explode, a bad part id, an unknown model kind, a model that fails `ModelSpecSchema`) → `{}`.
- `DisplayModel` is imported (type-only) from `src/agent/types.ts` (no DOM pulled into the Node test).

**Dependencies:** Task 1 (for the `ModelStateChange` type). `DisplayModel` comes from the new `src/agent/types.ts` created here.
**Done when:** `npm run check` passes and the above tests are green.

---

## Task 7a — `src/agent/useAgentRun.ts` + `src/agent/AgentPanel.tsx` (and the pure modules behind them)

`[x]`

The hook and panel, with every decision that does not need a DOM moved into pure modules that are unit-tested in Node. The hook only does I/O.

**Build:**
- `src/agent/events.ts`: `parseAgentEvent(frame)` → a typed `AgentEvent` (`status`, `tool`, `result`, `state`, `final`, `error`, `done`) or `null` for an unknown event, unreadable JSON, or a payload that fails its shared schema. The `tool` event keeps only the tool name: `argsJson` is dropped before the UI can see it.
- `src/agent/labels.ts`: `toolLabel(tool)` maps the six tools to Traditional Chinese labels (`generate_design` → 生成設計, `edit_design` → 修改設計, `select_parts` → 選取零件, `get_project_state` → 檢視目前狀態, `explode_view` → 爆炸圖, `wear_on_arm` → 護臂試戴; anything else → 其他步驟). `resultText(result)` returns the tool result's `summary`, except for a failed `UNKNOWN_TOOL` or `INVALID_ARGS` result, whose summary is written for the model and names tools and arguments; those get a plain explanation.
- `src/agent/run-reducer.ts`: `agentRunReducer(state, action)` over `{ status: 'idle' | 'running' | 'done' | 'error' | 'cancelled', log, reply, error }` with actions `start`, `event`, `fail` (HTTP error, lost connection, stream ended without `done`) and `cancel`. Log entries hold friendly labels and user-facing text only. Once a run has ended, every action except `start` is ignored. A `state` event changes no reducer state.
- `src/agent/request.ts`: `buildAgentRequest(instruction, snapshot, turns, requestId)` (`model: display?.model ?? null`, selection filtered to parts in the model, explode, tryOn, `cameraOn`, last ≤10 turns) and `errorMessageFromBody(body, status)` (the server's Traditional Chinese `error.message`, else a fixed message).
- `src/agent/stream.ts`: `readAgentStream(body, signal, onFrame)` reads the response with a streaming `TextDecoder` and `parseSseStream`, and returns whether `done` was seen. It stops delivering frames once the signal aborts.
- `src/agent/useAgentRun.ts`: `useAgentRun({ commit, setSelected, setExplode, setTryingOn, getSnapshot, getTurns, pushTurn })` → `{ run, cancel, active, status, log, reply, error }`. `getSnapshot()` returns `{ display, selectedPartIds, explode, tryOn, cameraOn }`; this replaces the `getDisplay` named earlier because the request needs the whole workbench state, not just the display. `run(instruction)` POSTs `/api/agent` with a fresh `requestId` and an `AbortController`. If the response is not `text/event-stream`, it reads the JSON error body (400/429) and shows its message. Otherwise it feeds the stream to the reducer; `state` events go through `applyStateEvent` and then `commit`, `setSelected`, `setExplode`, `setTryingOn` (commit first). The hook tracks the display it has committed itself, so two `state` events in one chunk build on each other. `final` also calls `pushTurn({ instruction, reply })`. `cancel()` aborts the fetch. A stream that ends without `done` is an error. One run at a time.
- `src/agent/AgentPanel.tsx`: `<AgentPanel agent={useAgentRun(...)} />` with an instruction textarea, a 執行 button (disabled while running or empty), a status line, the progress log, the final reply, and a 取消 button while running. All strings are Traditional Chinese; tools appear only by their labels. The parent calls `useAgentRun` and passes the result in, so it can read `agent.active` to disable manual controls (Task 7b).
- `src/styles.css`: only the `.agent-*` rules the panel needs, in the existing style.

**Tests** (Node, no DOM): `tests/unit/run-reducer.test.ts` (every event type; an error after a partial run, then `done`; `fail`; cancel; late actions ignored after the run ended; no raw tool name or argument text in the log; the model-facing failure messages replaced), `tests/unit/agent-client-events.test.ts` (`parseAgentEvent` for every event and invalid payloads, `argsJson` dropped, `buildAgentRequest` accepted by `AgentRequestSchema`, `errorMessageFromBody`), `tests/unit/agent-stream.test.ts` (a multi-byte character split across chunks, a stream cut before `done`, abort stops delivery). The hook and panel themselves are covered by `npm run check` (types + build) and the e2e in Task 8.
**Dependencies:** Tasks 1, 5, 6.
**Done when:** `npm run check` passes (types + build); full green requires Task 7b + Task 8.

---

## Task 7b — `src/App.tsx`: wiring and disabling controls during a run

`[x]`

Wire the panel into the app and disable manual interaction during a run.

**Build:**
- `src/App.tsx` imports `DisplayModel` from `src/agent/types.ts` (the local copy is gone) and renders `<AgentPanel agent={agent} disabled={Boolean(busy)} />` at the top of the control column, above the generate/edit panel.
- `useAgentRun` is called with `commit` (a wrapper, below), `setSelected`, `setExplode` (the existing `setExplodeAmount`, so a non-zero amount also drops the transform handle), `setTryingOn`, `getSnapshot()` (`display` from `currentDisplay.current`, `selected`, `explode`, `tryingOn`, `camera === 'on'`), and a turns list kept in a ref: `getTurns` and `pushTurn` keep the latest 10.
- `commitFromAgent(next)` mirrors what `applyResult`/`applyEdit` do around `commit`: it clears a stale approximation, conflict dialog, edit summary, clarify notice, timing and render error, calls `commit`, switches to the edit tab for a newly generated model, and sets a short status message.
- One flag, `agentActive` (= `agent.active`), gates everything manual:
  - Generate form and edit form: both textareas, both submit buttons, and the error notice's retry button.
  - Part fields: name, colour, all nine number fields, the translate/rotate buttons, 刪除, 取消選取, and the part list buttons.
  - The scene: `pick` and `onTransform` return early, and the scene gets `transformMode={null}` during a run so no drag handle is shown (the mode comes back afterwards).
  - Undo, redo, and the keyboard handler (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y, Escape, Delete) all do nothing.
  - The explode toggle and slider, the try-on toggle, and both 載入示範模型 buttons.
  - 套用 AI 修改, 保留手動調整, 接受近似並建立 and 取消近似 in the conflict and approximation dialogs.
  - The functions behind these controls (`generate`, `edit`, `loadDemo`, `undo`, `redo`, `toggleTryOn`, `updatePart`, `removeSelected`) also return early, so no path bypasses the disabled attribute.
- The camera on/off button stays enabled, so the user can turn the camera on when `wear_on_arm` asks. View-only controls (zoom, reset view, contrast) stay enabled.
- The reverse: `AgentPanel` takes `disabled`, and App passes `busy`, so 執行 is disabled while a generate or edit request is in flight, with a short explanation.
- `NumberField` gains a `disabled` prop.
- `tests/e2e/edit-select.spec.ts`: the click-to-select test now calls `scrollIntoViewIfNeeded()` on the canvas before it measures it. The new agent panel makes the control column taller, so clicking the part list scrolls the page and the old measurement pointed off the canvas.

**Tests:** none new. Verification = `npm run check` (types + build + unit tests), the existing Playwright suite (28 tests, all green), and Task 8's e2e, which asserts controls are disabled during a run and re-enabled after cancel.
**Dependencies:** Tasks 6, 7a.
**Done when:** `npm run check` passes and the existing e2e suite is green. Task 8 adds the agent e2e.

---

## Task 8 — `tests/e2e/agent-panel.spec.ts`: agent panel e2e

`[x]`

Playwright e2e using route interception with a scripted SSE body, following the existing `tests/e2e` pattern (`page.route('**/api/agent', ...)` returning a hand-built SSE response).

**Build:**
- Route `**/api/status` to a configured fake (existing pattern).
- Route `**/api/agent` to fulfill with a scripted SSE body: a `status` frame, a `tool` frame (`generate_design`), a `result` frame (no `stateChange.model`), a `state` frame carrying a `generated` `ModelStateChange` built from a **distinct `ModelSpec` with a different `name` and a different part count from `demoModel`** (so the "scene updated" and "undo reverts" assertions can tell the two models apart), then a `final` frame and `done`.
- Assertions:
  - The panel shows progress lines as frames arrive (`status`, tool, result, final).
  - The `state` event updates the 3D model to the distinct model — assert via the canvas `data-model-name`/`data-part-count` attributes (as the existing tests do); the name and part count differ from the pre-run model.
  - Undo works afterwards: click "復原" → reverts to the previous model (start from `loadDemo` so undo has a prior state; assert the name/part count return to `demoModel`'s).
  - Controls are disabled during the run: a held-response case (the route does not respond at all, so the hold happens before any frame; the handler is released and aborted after the assertions) asserts the edit form, undo, explode button and slider, part list buttons, and a part number field are disabled while `active`, and that 執行 is disabled.
  - Cancel works: in the held-response case, click "取消" → the status text starts with 已取消 and the controls re-enable (the edit textarea is checked and filled, because a submit button also needs text).
  - Error responses: `/api/agent` returning `400` and `429` JSON `{ error: { code, message } }` shows the message in `agent-error` and leaves the controls enabled.

**Tests:** this file is the test.
**Dependencies:** Task 7b.
**Done when:** `npm run check` passes and `npx playwright test tests/e2e/agent-panel.spec.ts` is green.

---

## Notes for every task

- Run `npm run check` before marking a task done; report the real result (req 31).
- Tests use a fake `ModelProvider` and never call a real back end (req 30).
- Keep user-facing strings in Traditional Chinese; spec/code/comments in English (req 32).
- Commit messages: conventional commits naming the spec task, e.g. `feat(agent): add agent schemas (spec agent-harness, task 1)` (hackathon rules).
- `/api/generate` and `/api/edit` and their tests stay untouched (req 21).

