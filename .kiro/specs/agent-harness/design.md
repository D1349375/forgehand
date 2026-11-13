# Agent Harness — Design

This design satisfies `requirements.md`. It reuses existing patterns where possible: the Zod authority in `shared/` (like `model.ts` / `edit.ts`), the `ModelProvider.run(task)` + `ModelTask<T>` shape, the `modelRoute` lifecycle in `app.ts`, and the undoable `commit` path in `App.tsx`.

## 1. Approach

A server-side loop drives the conversation. Each round the loop calls `ModelProvider.run(agentTask(...))` to get one `AgentStep`. If the step is a set of tool calls, the loop runs each tool against a working copy of the project state, collects structured results, emits SSE events, appends compact result summaries to the in-run history, and continues. If the step is a final reply, the run ends. State changes flow to the client as SSE events; the client applies them through its existing state setters and the undoable `commit` path.

The server holds a working copy of the model/selection/display state for the duration of one run only. It never persists state across requests (req 1: server is stateless). Cross-run context comes from the bounded history the client sends (req 23).

## 2. Data model — `shared/agent.ts`

All schemas live in `shared/` (req 27) so server and client share one Zod authority. The naming and structure mirror `model.ts` / `edit.ts`: a flat strict schema for what is sent to the model, plus `validate*` functions that do semantic checks and return a discriminated TypeScript type. This avoids top-level JSON-Schema unions, which the three back ends' strict structured-output modes handle inconsistently — the same "flat schema + semantic validation" pattern already used for `EditPlan`.

### 2.1 AgentStep

The model-facing step uses a fixed schema that does not grow with the tool count. Tool calls become `{ tool: string, argsJson: string }` — the tool name and a JSON-stringified argument object. Each tool parses `argsJson` with its own Zod schema registered in the tool registry (§5); a bad call returns `INVALID_ARGS` and the model corrects itself next round.

```ts
export const ToolCallSchema = z.strictObject({
  tool: z.string().trim().min(1).max(64),  // tool name; runTool looks it up in the registry
  argsJson: z.string().max(8000),          // JSON-stringified args, parsed by the tool's schema
  reason: z.string().trim().min(1).max(300).nullable(), // why the model chose this call (optional)
});

export const AgentStepSchema = z.strictObject({
  type: z.enum(['tool_calls', 'final']),
  note: z.string().trim().min(1).max(500).nullable(),  // short status for the user (tool_calls only)
  reply: z.string().trim().min(1).max(2000).nullable(), // final reply (final only)
  calls: z.array(ToolCallSchema).min(1).max(8).nullable(),
});
```

`validateAgentStep(input)` parses, then enforces consistency:
- `type === 'tool_calls'` → `calls` non-null and non-empty, `reply` null; tool names and `argsJson` are not checked here (`runTool` checks them at dispatch, §5), so `shared/` never imports the server-side registry.
- `type === 'final'` → `reply` non-null, `calls` null; a stray `note` is dropped (not rejected), so a harmless extra note costs no retry round.
- Returns `AgentToolCalls | AgentFinal`.

This fixed-schema form is strict-mode safe for all three back ends. The top-level node is a single object (no `anyOf`/`oneOf` at the root), and `argsJson` is a plain string so the schema never grows with the tool count. We send `z.toJSONSchema(AgentStepSchema, { target: 'draft-7' })` with `$schema` stripped, like `designJsonSchema()` / `editJsonSchema()`.

### 2.2 Tool results

Each tool returns a `ToolResult`. The `summary` + `detail` are what the model sees next round and what the UI renders (req 15). A local `ToolError` (invalid args, no model on screen, an `EditError` from `applyEditPlan`) is one result shape, not an exception (req 16). A provider abort or `GenerationError` from `provider.run` is **not** a `ToolResult` — it propagates and ends the run (see §4).

```ts
// Everything the client needs to build a full DisplayModel and commit it.
// Sent in the `state` event only, never in the `result` event or in history.
export const ModelStateChangeSchema = z.strictObject({
  kind: z.enum(['generated', 'edited']),  // generated = new lineage; edited = keep current lineage
  model: ModelSpecSchema,
  source: z.string(),                     // provider name (same as GenerationResult.source)
  providerModel: z.string(),              // provider model id (same as GenerationResult.model)
});

export const ToolResultSchema = z.strictObject({
  tool: z.string().trim().min(1).max(64),  // plain string: an UNKNOWN_TOOL result echoes the requested name
  ok: z.boolean(),
  // Compact, model/UI-facing summary. The model reads this; the UI renders it.
  summary: z.string().trim().min(1).max(1000),
  // Structured detail, one per tool, nullable. Validated by a per-tool detail schema.
  // detail NEVER contains a full ModelSpec — the model sees the current model only
  // through the compact per-round state snapshot in agentTask, and the full model
  // only inside an editTask call when edit_design actually runs.
  detail: z.unknown().nullable(),
  // Whether this result changed project state (and which). The loop emits a `state`
  // event from this. The `result` EVENT payload strips `stateChange.model` (see 2.4).
  stateChange: z.strictObject({
    model: ModelStateChangeSchema.nullable(),     // full model change to commit (undo step)
    selection: z.array(z.string()).max(64).nullable(),
    explode: z.number().min(0).max(1).nullable(),
    tryOn: z.boolean().nullable(),
  }).nullable(),
});
```

Per-tool `detail` schemas (in `shared/agent.ts`): e.g. `GenerateDesignDetail { source, providerModel, status }` (no `model` — the model goes only in `stateChange.model`), `EditDesignDetail { changes, explanation }`, `GetProjectStateDetail { parts, selection, explode, tryOn }`, `ExplodeViewDetail { amount }`, `WearOnArmDetail { tryOn, cameraOn, message }`, `EstimateDetail { totalKg, totalCost, perPart }`, `FeasibilityDetail { issues }`, `ToolErrorDetail { code, message }`.

### 2.3 Request, turns, and history

```ts
// One prior turn the client sends for context (req 23): instruction + final reply only.
export const AgentTurnSchema = z.strictObject({
  instruction: z.string().trim().min(1).max(4000),
  reply: z.string().trim().min(1).max(2000),
});

export const AgentRequestSchema = z.strictObject({
  instruction: z.string().trim().min(1).max(4000),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  model: z.union([z.null(), z.unknown().refine(v => v !== undefined)]),  // required key; null = empty scene; missing/undefined = structural error
  selectedPartIds: z.array(...).max(64),     // must be empty when model is null
  explode: z.number().min(0).max(1),
  tryOn: z.boolean(),
  cameraOn: z.boolean(),                     // wear_on_arm needs this (req: tool never starts camera)
  history: z.array(AgentTurnSchema).max(10), // bounded (req 23)
});
```

`model` is a required field: an explicit `null` means the scene is empty (the working copy starts `model = null`); a missing key or an explicit `undefined` is a structural error (INVALID_REQUEST, before SSE headers); any non-null value is validated by `validateModel` and, on failure, becomes `INVALID_MODEL` with a fixed sanitized Traditional Chinese message (no Zod detail leaked). Tools that need a model return a `ToolError` when it is null (see §5); `generate_design` works with or without a model.

### 2.4 SSE events

Events the server writes over the stream. Defined in `shared/agent.ts` so the client parses them with the same authority.

```
// SSE event name → data
// status   { note }                       model's status note for the round
// tool     { tool, argsJson }               a tool call is starting
// result   { ...ToolResult }              a tool finished, with stateChange.model stripped to null
// state    { model?, selection?, explode?, tryOn? }   a state change to apply (client commits model)
// final    { reply }                      run ended with a final reply
// error    { message }                    run ended on failure (sanitized, Traditional Chinese)
// done     {}                             terminal marker, always last (except cancel, which emits nothing)
```

`state` is separate from `result` so a model change carries the full `ModelSpec` exactly once — in the `state` event (as a `ModelStateChange`), for the client to `commit`. The `result` event carries the same `ToolResult` but with `stateChange.model` stripped to `null`, so the big payload is never duplicated. The compact `summary` + `detail` in `result` is all the model and UI need from a finished tool; the round history sent to the model stores only that compact form (`{ ok, summary, detail }`), never a full `ModelSpec` or a `stateChange`.

## 3. Module layout

New files only; no existing file is moved. The server never imports `src/` (req 36).

```
shared/agent.ts        NEW  AgentStep, ToolCall, ToolResult, ModelStateChange, AgentRequest,
                            AgentTurn, SSE event helpers, validateAgentStep.
                            Re-uses ModelSpecSchema/PartSchema from model.ts and applyEditPlan from edit.ts.
server/agent.ts        NEW  runAgent(provider, req, opts, emit, clientSignal): the loop, round logic,
                            compact history accumulation, round/timeout/cancel handling, retry-once.
server/agent-tools.ts  NEW  tool execution entry point: AgentWorkingState, result helpers, and
                            runTool(call, state, provider, signal) = registry lookup + argsJson
                            validation + dispatch (see section 5).
server/tools/          NEW  the tool registry (registry.ts, helpers.ts, index.ts) and one file per
                            tool. Each tool: (args, ctx, signal) => ToolResult on a server-side working
                            copy. generate/edit delegate to provider.run(designTask/editTask); the rest
                            are pure local functions.
server/agent-events.ts NEW  SSE writer: serialize events, set SSE headers, write frames. (Reusable by voice later.)
server/app.ts          EDIT add the /api/agent route + agentRoute lifecycle (reuses the existing
                            activeRequests concurrency counter and sanitized errors).
src/agent/types.ts     NEW  exported DisplayModel type (moved out of App.tsx so agent helpers can import it
                            without pulling DOM code); imported by App.tsx, useAgentRun, apply-state.ts.
src/agent/AgentPanel.tsx   NEW  the conversation panel (instruction input, progress log, final reply, cancel).
src/agent/useAgentRun.ts   NEW  POST /api/agent with fetch + ReadableStream; parse SSE frames; apply state events.
src/agent/sse.ts           NEW  pure SSE frame parser (no DOM; unit-tested in Node).
src/agent/apply-state.ts   NEW  pure applyStateEvent(event, current, { requestId, now, newLineage }): turns a
                            state event into commit/setSelected/setExplode/setTryingOn args (no DOM; unit-tested in Node).
src/App.tsx                EDIT render AgentPanel; expose setters/commit so useAgentRun applies state events;
                            disable manual editing + generate/edit forms + undo/redo while an agent run is active.
```

`shared/agent.ts` exports `agentJsonSchema()` (draft-7, `$schema` stripped) for the `ModelTask` schema, matching `designJsonSchema()` / `editJsonSchema()`.

## 4. Agent loop — `server/agent.ts`

```
runAgent(provider, req, { maxRounds=6, totalTimeoutMs }, emit, clientSignal):
  timeoutSignal = AbortSignal.timeout(totalTimeoutMs)
  runSignal = AbortSignal.any([clientSignal, timeoutSignal])   // → every provider.run and tool
  state = working copy: { model: req.model == null ? null : validateModel(req.model),
                          selection: req.model == null ? [] : req.selectedPartIds∩parts,
                          explode: req.explode, tryOn: req.tryOn, cameraOn: req.cameraOn }
  rounds = []   // compact: [{ call: { tool, argsJson }, result: { ok, summary, detail } }]
  try:
    for round in 0..maxRounds-1:
      if runSignal.aborted → throw ABORTED
      emit('status', note?) // none on first round
      task = agentTask(history=req.history, rounds, state, instruction=req.instruction)
      step = getStep(provider, task, runSignal)   // validateAgentStep(await provider.run(task, runSignal));
                                                   // retry once on validation failure (re-check abort first),
                                                   // else throw a sanitized error. Throws on abort/GenerationError.
      if step is final:
        emit('final', step.reply); emit('done'); return
      emit('status', step.note)            // model's note for this round
      for call in step.calls:
        emit('tool', { tool, argsJson })
        result = runTool(call, state, provider, runSignal)   // ToolError for bad args / no model / local EditError;
                                                              // THROWS abort/GenerationError → propagates, ends run
        emit('result', stripModel(result))                   // ToolResult with stateChange.model = null
        if result.stateChange:
          apply stateChange to `state`                       // model already validated by the tool
          emit('state', result.stateChange)                  // carries full model exactly once
        rounds.push({ call: { tool: call.tool, argsJson: call.argsJson }, result: { ok: result.ok, summary: result.summary, detail: result.detail } })
      // loop continues: next round sees the accumulated compact rounds + a fresh snapshot
    // reached maxRounds without a final reply
    emit('error', sanitized zh-TW "agent did not finish"); emit('done')   // earlier rounds' changes already emitted+applied (req 9, 18)
  catch (ABORTED or GenerationError):
    if clientSignal.aborted → return                                    // client cancel/disconnect: emit nothing
    if timeoutSignal.aborted → emit('error', sanitized zh-TW timeout); emit('done')   // so the client does not hang
    else → emit('error', sanitized GenerationError.message); emit('done')              // provider failure mid-run
```

Key points:
- **Round history vs. session history.** The model input each round = the client-sent `history` (last ≤10 prior turns) + the in-run compact `rounds` (call + `{ ok, summary, detail }`) + the current `instruction` + a compact current-state snapshot. The snapshot is a `get_project_state`-style summary (part ids/names/primitives/key dimensions, selection, explode, tryOn) of the working copy, sent once per round. The rounds array never stores a full `ModelSpec` or a `stateChange`, so history does not grow with model size. The model sees the current model only through that per-round snapshot, and the full model only when `edit_design` actually runs (inside `editTask`).
- **One combined signal for time limit and cancel (req 10, 18).** `runAgent` builds `runSignal = AbortSignal.any([clientSignal, AbortSignal.timeout(totalTimeoutMs)])` and passes it into every `provider.run` and `runTool`. A timeout or cancel therefore aborts the in-flight `provider.run` directly — CLI processes are stopped, not merely raced — and the current round is discarded. Earlier rounds' `state` events were already sent and applied and stay (the client can undo them).
- **Errors and timeouts end the run; cancel is silent.** An abort or a `GenerationError` from `provider.run` (inside the agent step or inside `generate_design`/`edit_design`) is NOT turned into a `ToolResult` — it propagates and ends the run. The loop then distinguishes why: on the **total-run timeout** it emits a sanitized Traditional Chinese timeout `error` + `done` (so the client does not hang); on **client cancel/disconnect** it emits nothing (the connection is gone); on any other `GenerationError` it emits a sanitized `error` + `done`. Only local tool failures (bad args, no model, `EditError` from `applyEditPlan`) become `ToolResult`s.
- **Retry once (req 11).** Only for Zod/semantic validation failure of `AgentStep`, not for provider transport errors (those are `GenerationError`s, surfaced sanitized). A retry first re-checks `runSignal.aborted`; if it has already aborted, the run ends via the cancel/timeout path instead of retrying.
- **No fabrication (req 15).** The model only sees `ToolResult`s produced by `runTool`; the loop never lets the model assert facts without a result.

`agentTask(...)` is a `ModelTask<AgentStep>`: `kind: 'agent'`, `instructions: AGENT_INSTRUCTIONS`, `schema: agentJsonSchema()`, `input: <composed string>`, `parse: validateAgentStep`.

### 4.1 Agent instructions (`AGENT_INSTRUCTIONS`)

System prompt, English rules, user-facing strings in Traditional Chinese. It lists the tools, their required args, and the rules: use real tool results, never fabricate, call `get_project_state` before editing if unsure, prefer local tools, return `final` when done, return `note` to narrate. It notes that `generate_design` works on an empty scene and that tools which need an existing model return an error when none is present. It reuses the geometry/units lines from `MODEL_INSTRUCTIONS` so edits stay consistent (same trick `EDIT_INSTRUCTIONS` uses).

## 5. Tool registry — `server/tools/` + `server/agent-tools.ts`

Tools are defined once with `defineTool` and stored in a registry. The registry drives dispatch (name lookup in `runTool`) and the tool list in `AGENT_INSTRUCTIONS` (generated). It does not drive the `AgentStep` schema: that schema is fixed, and `shared/` never imports the server-side registry.

File layout:

```
server/tools/registry.ts           defineTool, ToolDefinition, ToolContext, getTool, listTools({ scope, side }),
                                   argsShapeText, createToolRegistry (a fresh registry, for tests)
server/tools/helpers.ts            ok / fail / noModel / requireRun, NO_MODEL_MESSAGE
server/tools/<tool-name>.ts        one file per tool; exports its defineTool(...) result
server/tools/index.ts              imports the six tools; registration order = the order the model sees
server/agent-tools.ts              single entry point: AgentWorkingState, re-exported result helpers, runTool
```

```ts
interface ToolDefinition<TArgs> {
  name: string;
  category: string;  // 'design' | 'inspect' | 'view' | 'body' | 'analysis' | 'export' | 'jobs' | 'home' | 'memory' | ...
  description: string;  // one-line, shown in AGENT_INSTRUCTIONS
  args: z.ZodType<TArgs>;  // z.strictObject(...); get_project_state takes {}
  side: 'server' | 'client';
  scope: 'project' | 'home';
  effects: 'read-only' | 'writes-scene' | 'writes-project' | 'writes-memory' | 'uses-camera' | 'sends-image' | 'long-running';
  run(args: TArgs, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult>;
}

interface ToolContext {
  state: AgentWorkingState;   // { model, selection, explode, tryOn, cameraOn }
  provider: ModelProvider;
}

function defineTool<TArgs>(def: ToolDefinition<TArgs>): ToolDefinition<TArgs>;  // registers and returns def; a duplicate name throws
```

`ToolResult.detail` stays `unknown`, as in §2.2; the per-tool detail types in `shared/agent.ts` are applied inside each tool, so `ToolDefinition` has no detail type parameter. `ToolResult.tool` is a plain string, because an `UNKNOWN_TOOL` result echoes the name the model asked for.

**Registration.** Each tool file calls `defineTool` at module load, and `server/tools/index.ts` imports the six working tools in the order the model should see them. `server/agent-tools.ts` imports `./tools`, so any code that can call `runTool` has the tools registered.

**Generated instructions.** `AGENT_INSTRUCTIONS` stays in `server/agent.ts`. Only its tool-list section is generated, from `listTools({ scope: 'project', side: 'server' })`; every rule line and the geometry rules are unchanged. One new sentence explains that each call is `{ tool, argsJson }` and that `argsJson` is a JSON object string.

```ts
const TOOL_LIST = listTools({ scope: 'project', side: 'server' })  // client and home tools are out of scope for now
  .map(t => `- ${t.name}(${argsShapeText(t.args)}): ${t.description}`)
  .join('\n');
```

`argsShapeText(schema)` builds the signature from the schema's JSON Schema (`z.toJSONSchema`, input side): `name: type` per property, with `?` after an optional name and `[]` after an array type. Examples: `prompt: string`, `partIds: string[]`, `amount: number`, `enabled: boolean`, and an empty string for `{}`. It is for display only; validation uses the schema itself.

**Dispatch.** `runTool(call, state, provider, signal)`:
- Tool name not in the registry → `ToolError { code: 'UNKNOWN_TOOL' }`; the message lists the registered tool names.
- `JSON.parse(call.argsJson)` throws, or the result is not a JSON object, or `tool.args.safeParse` fails → `ToolError { code: 'INVALID_ARGS' }`. The message is short Traditional Chinese: what was wrong (not valid JSON, missing parameter X, parameter X has a wrong value) plus the expected signature. It never forwards Zod's message text.
- Otherwise → `tool.run(args, { state, provider }, signal)`. Semantic checks that need the working copy (`NO_MODEL`, part ids that are not in the model) happen inside `run`.

`runTool` never mutates the working state; the loop applies each result's `stateChange`. A provider abort or `GenerationError` from `provider.run` (in `generate_design`/`edit_design`) is **not** caught here. It propagates and ends the run (see §4). Bad args produce `ToolResult { ok:false, summary, detail: ToolErrorDetail }` (req 16) with no state change.

The per-tool result detail schemas (`GenerateDesignDetail`, `EditDesignDetail`, etc.) stay in `shared/agent.ts`.

| Tool | Args | Calls model? | State change | Result detail |
|---|---|---|---|---|
| `generate_design` | `prompt` | yes (`designTask`) | `model` (kind `generated`, new lineage client-side) | source, providerModel, status |
| `edit_design` | `instruction` | yes (`editTask` + `applyEditPlan`) | `model` (kind `edited`, keeps lineage) + `selection` (added+updated) | changes (added/updated/removed), explanation |
| `select_parts` | `partIds` | no | `selection` | the new selection |
| `get_project_state` | — | no | none | parts summary, selection, explode, tryOn |
| `explode_view` | `amount` (0–1) | no | `explode` | amount; **server validates only**, browser computes layout (req 14/36) |
| `wear_on_arm` | `enabled` | no | `tryOn` only if `state.cameraOn` | tryOn, cameraOn, message; if camera off → ok:false, summary asks user to turn on camera, no `tryOn` change (req: tool never starts camera) |
| `estimate_weight_cost` *(deferred)* | `densityKgPerM3?`, `material?` | no | none | totalKg, totalCost, perPart (volume × density, default material adjustable) |
| `check_feasibility` *(deferred)* | — | no | none | issues[] (floating parts, unreasonable interpenetration, out-of-range) |

**Empty-scene rule.** `edit_design`, `select_parts`, `explode_view`, `wear_on_arm`, `estimate_weight_cost`, and `check_feasibility` each return a `ToolError` (`ok:false`, `detail: ToolErrorDetail { code: 'NO_MODEL', message: '目前沒有模型，請先 generate_design。' }`) with no `stateChange` when the working copy's `model` is null. `generate_design` works with or without a model (an existing model is ignored; it always produces a kind `generated` change with a new lineage). `get_project_state` works with no model (returns an empty snapshot).

Notes:
- `generate_design` / `edit_design` reuse `provider.run(designTask(prompt))` and `provider.run(editTask(model, instruction, selection))` and pass the run `signal` through. The working copy's current model/selection are passed in. A `generate_design` that returns `status !== 'ready'` becomes a `ToolResult` with `ok:false` and no `model` state change (approximation/unsupported surfaced to the model, not silently applied). `GenerateDesignDetail` carries only `{ source, providerModel, status }` — never the model. An abort or `GenerationError` from `provider.run` is NOT caught here — it propagates and ends the run (see §4).
- `edit_design` runs `applyEditPlan` on the working copy; a local `EditError` (the plan does not apply) returns a `ToolError` with no state change (the model can try again or clarify). On an applied edit it also sets `stateChange.selection` to `[...changes.added, ...changes.updated]` (mirroring `App.tsx`'s `applyEdit`), so the working copy and client never keep a selected part the edit removed. An abort or `GenerationError` from `provider.run` propagates and ends the run. Conflict-with-manual-change handling is not needed here because manual edits are disabled during a run (req 26).
- `wear_on_arm`: the request carries `cameraOn`. The tool never starts the camera (req 14). If `enabled && !cameraOn` → `ok:false`, summary "請先開啟攝影機再試戴", no `tryOn` change. If `enabled && cameraOn` → `stateChange.tryOn = true`. If `!enabled` → `stateChange.tryOn = false`.
- `explode_view` only validates `amount ∈ [0,1]` and sets `stateChange.explode`; the browser applies it via `setExplode` and computes layout as today (req 14/35/36). No `src/` import.

## 6. `/api/agent` endpoint — `server/app.ts`

Add a sibling to `modelRoute`: `agentRoute(res, requestId, work)`. It reuses the existing `activeRequests` counter (cap 3 → else 429, req 22), `res.close` → `controller.abort()` for client disconnect/cancel, the existing origin/CORS/no-store/nosniff middleware, and sanitized error handling. The existing 128 kB `express.json` limit already applies (req 21).

```
POST /api/agent
  // All request validation and concurrency rejection are PLAIN JSON HTTP responses
  // sent BEFORE any SSE byte is written (exactly like /api/generate's 400/429):
  parse AgentRequestSchema            → 400 INVALID_REQUEST JSON on failure
  if req.model != null:
    validateModel(req.model)           → 400 INVALID_MODEL JSON on failure
    selection ⊆ model.parts            → 400 INVALID_SELECTION JSON on failure
  else:
    selectedPartIds must be empty      → 400 INVALID_SELECTION JSON on failure
  if activeRequests >= 3               → 429 BUSY JSON
  // --- streaming starts here ---
  set SSE headers: Content-Type text/event-stream; Cache-Control no-store;
                   X-Content-Type-Options nosniff; Connection keep-alive
  agentRoute(res, requestId, async (clientSignal) => {
    await runAgent(provider, req, { maxRounds, totalTimeoutMs }, emit, clientSignal)
  })   // runAgent builds runSignal = AbortSignal.any([clientSignal, AbortSignal.timeout(totalTimeoutMs)]) itself,
       // so it can distinguish client cancel from the total-run timeout (see §4).
```

`emit(name, data)` writes `event: <name>\ndata: <json>\n\n`. On any terminal condition (final / error / done), flush and end the response. **Only failures that occur after streaming has started** (provider error mid-run, `AgentStep` invalid after retry, round/timeout limit reached) are reported as an `error` event followed by `done` — except client cancel/disconnect, which emits nothing. Request-validation errors (bad body, invalid model, invalid selection) and concurrency rejection (429) are plain JSON status responses sent before the SSE headers, consistent with the existing `/api/generate` 400/429 — they never appear as SSE events.

`agentRoute` lifecycle mirrors `modelRoute`: it increments `activeRequests` before streaming and decrements it in a `finally` block that runs only after `runAgent` has settled — i.e. after the last in-flight `provider.run` has been aborted and awaited, so the concurrency slot is held until the provider has actually stopped. `runAgent` builds the combined `runSignal` (`clientSignal` OR `AbortSignal.timeout(totalTimeoutMs)`) and passes it into every `provider.run`, so a timeout or cancel aborts the CLI process directly rather than just racing the loop, and `runAgent` can tell the two apart to decide whether to emit a timeout `error`+`done` or nothing (cancel). **The single-call `MODEL_TIMEOUT_MS` (180 s) from `modelRoute` is not applied to the whole run**; the run is bounded only by its own larger `totalTimeoutMs`. `maxRounds` and `totalTimeoutMs` come from `AppOptions` / env (defaults 6 and a configured total).

`/api/generate` and `/api/edit` are untouched (req 20); their tests run unchanged.

## 7. Frontend — `src/agent/`

### 7.1 `useAgentRun`

`EventSource` is GET-only and cannot send the request body, so this uses `fetch` with a `ReadableStream` response and the pure SSE frame parser in `src/agent/sse.ts`. The hook:
- POSTs `AgentRequest` (current model via `display?.model ?? null`, selection, explode, tryOn, `camera === 'on'`, last ≤10 turns).
- Reads the stream, dispatches events to handlers:
  - `status` → append note to the progress log.
  - `tool` → append "calling <tool>" line.
  - `result` → append the rendered result (from `ToolResult.summary` + `detail`, not the model's text — req 15).
  - `state` → apply via the pure `applyStateEvent(event, currentDisplay, { requestId, now, newLineage })` helper (`src/agent/apply-state.ts`), where `requestId` is the run's id, `now` is `performance.now()`, and `newLineage` is `crypto.randomUUID()` (keeping App's existing lineage convention). The `ModelStateChange` payload itself carries no `requestId`/`startedAt`/`lineage` — the client supplies them, so the helper is deterministic and unit-testable:
    - `model.kind === 'generated'` → `commit({ model, source, providerModel, requestId, startedAt: now, lineage: newLineage, edited: false })` — new lineage, so `commit` resets selection/explode (req 4).
    - `model.kind === 'edited'` → `commit({ ...currentDisplay, model, source, providerModel, requestId, startedAt: now, edited: true })` — keeps the current lineage (no selection/explode reset); returns no `commitArg` if `currentDisplay` is null.
    - `selection` → `setSelected`; `explode` → `setExplode`; `tryOn` → `setTryingOn`.
  - `final` → set the agent's final reply, end run.
  - `error` → show sanitized message, end run.
  - `done` → end run.
- Exposes `{ run, cancel, active, log, reply }`. `cancel` aborts the fetch; the server's `res.close` fires `clientSignal` abort, which ends the loop (req 18).
- `DisplayModel` is exported from `src/agent/types.ts` (moved out of `App.tsx`), imported by `App.tsx`, `useAgentRun`, and `apply-state.ts`.

### 7.2 `AgentPanel`

A new panel in the control column: instruction textarea, "執行" button, a scrollable progress log (status/tool/result lines), the final reply, and a "取消" button while active. It uses `useArmTracking`-style status text. UI strings are Traditional Chinese (req 31). The existing prompt/edit forms stay (req 25).

### 7.3 Disable manual interaction during a run (req 26)

While `active`, `App.tsx` disables: the generate form, the edit form, manual part adjustment fields, transform handles, undo/redo buttons, and the explode slider. The camera toggle stays enabled (so the user can turn the camera on for `wear_on_arm`). This is a single `agentActive` boolean gating the existing `disabled` props, mirroring how `busy` already disables the generate button. Selection picking is disabled too.

### 7.4 Turns for follow-ups (req 23)

`App.tsx` keeps a bounded list (≤10) of `{ instruction, reply }` from completed agent runs and passes it as `history`. Tool details are not stored — only the user's instruction and the agent's final reply — so "make the legs longer" after a prior run has context without a huge payload (and stays under 128 kB, req 21).

## 8. Testing strategy

Unit tests (Vitest, fake `ModelProvider`, never a real back end — req 29). **No jsdom or happy-dom is added** — the frontend pieces that need a DOM are covered by the Playwright e2e test below; everything unit-tested in `src/agent` is a pure function.

- `shared/agent.ts`: `validateAgentStep` accepts valid tool_calls/final; rejects type/call mismatches; a call is `{ tool, argsJson }` and neither the tool name nor the args are checked there; `agentJsonSchema` has `tool` and `argsJson` as plain strings; `agentJsonSchema` is a single top-level object (no `anyOf`/`oneOf` at the root), every property `required`, `$schema` stripped (nullable fields' nested `anyOf` are expected, as in `editJsonSchema()`); `ModelStateChangeSchema` round-trips; `AgentRequestSchema` accepts `model: null`.
- `server/agent-tools.ts`: each tool with a scripted working copy — generate returns ready→model state change (kind `generated`, detail has no model); edit applies and changes model (kind `edited`); select changes selection; get_project_state returns snapshot (works with null model too); explode_view validates 0–1 (rejects out of range) and emits explode only; wear_on_arm with `cameraOn:false` returns `ok:false` no tryOn, with `cameraOn:true` emits tryOn; **every model-required tool returns a `NO_MODEL` ToolError when `state.model` is null**; bad `argsJson` (not JSON, missing arg, wrong type, stray key) → `INVALID_ARGS` ToolError for every tool, an unregistered name → `UNKNOWN_TOOL`, both with no state change and without reaching the provider; **an abort/GenerationError from `provider.run` propagates (not a ToolResult)**. Deferred tools get basic tests when implemented.
- `server/tools/registry.ts`: `listTools` filters by scope and side and keeps registration order; a duplicate name throws; the default registry holds exactly the six tools; the generated tool list in `AGENT_INSTRUCTIONS` has exactly those six lines; `argsShapeText` output per tool. Registry unit tests use `createToolRegistry()` so they never add to the shared registry.
- `server/agent.ts`: the loop with a fake provider returning scripted `AgentStep`s. The fake's `run` calls `task.parse` on the scripted value and turns a parse failure into `GenerationError('INVALID_MODEL', …)`, as `server/codex.ts` does, so the retry path is exercised the way real adapters trigger it — multi-round (tool_calls then final), max-rounds end, retry-once on invalid step then sanitized error, fabrication guard (result always from tool), history sent to the model contains no full `ModelSpec` (assert on `agentTask` input). Three termination cases: **total-run timeout** (the `AbortSignal.timeout` aborts the in-flight `provider.run`; the loop emits a sanitized zh-TW timeout `error`+`done`), **client cancel** (the `clientSignal` aborts mid-round; the loop emits nothing), and **provider `GenerationError`** (a non-abort `GenerationError` from `provider.run` propagates; the loop emits a sanitized `error`+`done`). In all three, earlier `state` events were already emitted.
- `server/app.ts` (`/api/agent`): supertest against `createApp` with an injected fake provider — success stream, 429 on concurrency (plain JSON, pre-stream), 400 on invalid request/invalid model/invalid selection (plain JSON, pre-stream), `model: null` accepted, origin rejection, sanitized error event mid-stream, body > 128 kB rejected. SSE frames parsed from the response stream.
- `src/agent/sse.ts`: the SSE frame parser as a pure function in Node — splits a streamed string into `{ event, data }` frames, handles partial chunks, multi-line `data`, and the terminal `done` event.
- `src/agent/apply-state.ts`: `applyStateEvent(event, current, { requestId, now, newLineage })` as a pure function in Node — given a state event and a current `DisplayModel | null` plus deterministic `requestId`/`now`/`newLineage`, returns the `commit` argument (uses `newLineage` for `generated`, keeps `current.lineage` for `edited`) and the `selection`/`explode`/`tryOn` values to set; asserts `generated` resets selection/explode and `edited` keeps them; `edited` with `null` current → no `commitArg`. `DisplayModel` is imported (type-only) from `src/agent/types.ts`.

E2E test (Playwright, req 29 — follows the existing route-interception pattern in `tests/e2e`):

- `tests/e2e/agent-panel.spec.ts`: route `**/api/agent` to fulfill with a scripted SSE body (a `status` frame, a `tool` frame, a `result` frame, a `state` frame carrying a `generated` `ModelStateChange` built from a **distinct ModelSpec with a different name and part count from `demoModel`**, then a `final` frame and `done`). Assertions: the panel shows progress lines as frames arrive; the `state` event updates the 3D model to the distinct model (assert via the canvas `data-model-name`/`data-part-count` attributes as the existing tests do); undo works afterwards (reverts to the previous model); the generate/edit forms, manual adjustment, undo/redo, and explode slider are disabled while `active`; and cancel aborts the run and re-enables the controls. A second case streams a `tool` frame then holds the response to assert controls stay disabled mid-run and the cancel button returns them.

## 9. Key decisions

- **Fixed-schema `AgentStep` with `{ tool, argsJson }`, not a flat args object.** The schema no longer grows with the tool count. Each tool parses its own `argsJson` with a registered Zod schema. Strict-mode safe across all three back ends: every property is `required`, `argsJson` is a plain string. The top level stays a single object (no `anyOf`/`oneOf` at the root).
- **Tool registry as the single source of truth.** `defineTool` registers name, description, args schema, side, scope, effects, and run. The tool list in `AGENT_INSTRUCTIONS` is generated from the registry, so adding a tool is one `defineTool` call with no schema/validator/instructions changes elsewhere.
- **No client tools, background jobs, or home scope in this spec.** They are deferred to later specs (§4.4, §4.5, §4.7 in VISION.md). This spec builds the foundation: the registry, the server-side project-scoped tools, and the fixed-schema `AgentStep`.
- **Tool result is the single source of truth.** The model sees `ToolResult` summaries; the UI renders `ToolResult` detail; tests assert on `ToolResult`. The model's `note` is narration only.
- **The full `ModelSpec` is sent exactly once, in the `state` event.** A model change carries a `ModelStateChange` (`{ kind, model, source, providerModel }`) giving the client everything `commit` needs (the client supplies `requestId`/`startedAt`/`lineage`); the `result` event strips `stateChange.model`; the round history stores only `{ ok, summary, detail }`. The model sees the current model through the compact per-round state snapshot, and the full model only inside an `editTask` when `edit_design` runs.
- **Empty scene is a first-class state.** `AgentRequest.model` is nullable; the working copy starts `null`; model-required tools return a `NO_MODEL` `ToolError`, and `generate_design` works with or without a model.
- **One combined `AbortSignal` for the whole run; cancel is silent.** `AbortSignal.any([clientSignal, totalTimeout])` goes into every `provider.run`, so a timeout or cancel actually stops the CLI process. The `activeRequests` slot is held until the provider has stopped, like `modelRoute`. The single-call 180 s timeout is not applied to the whole run. A total-run timeout emits a sanitized `error`+`done`; a client cancel emits nothing; any other `GenerationError` emits a sanitized `error`+`done`.
- **Request validation is pre-stream; run errors are SSE events.** Bad body / invalid model / invalid selection / 429 are plain JSON before SSE headers; only post-stream failures use `error` + `done` (cancel emits nothing).
- **Server never imports `src/`.** `explode_view` validates and records only; `wear_on_arm` never touches the camera; layout and tracking stay browser-side.
- **Reuses, not rewrites.** `designTask`/`editTask`/`applyEditPlan`/`validateModel`/`commit`/`activeRequests` are reused; `/api/generate` and `/api/edit` are unchanged.

