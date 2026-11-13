# Agent Harness — Requirements

## Overview

Forgehand today turns a text description into a 3D concept model, and edits it, through single-turn structured-output calls to a model back end. The user wants an **agent** that can take a free-form instruction and autonomously call a set of tools — generate, edit, select, explode, wear, estimate, check — to reach a goal, reporting real progress as it works. This spec defines the server-side agent loop and its first tool set.

The agent loop lives entirely on the **Forgehand server**. Each round, the model returns one structured `AgentStep` (validated by a new Zod schema in `shared/`): either one or more tool calls, or a final reply to the user. Tools are Forgehand-implemented functions that operate on the project state. The model never calls tools directly; the three back ends (Codex CLI, Claude Code CLI, OpenAI API) keep their current isolation settings (all native tool calling, MCP, network, and shell access disabled), so the agent loop works against any of them without changes.

The server is **stateless**. All project state — the model, undo/redo history, selection, explode amount and try-on state — lives in the browser (`App.tsx`). The client sends the current state with each `/api/agent` request, and the server returns state changes as SSE events for the client to apply.

## Goals

- A server-side agent loop that orchestrates multiple model rounds through the existing `ModelProvider.run(task)` interface.
- A first tool set that lets the agent generate, edit, inspect, explode, wear, estimate, and check a concept model.
- Real-time, cancelable progress streamed to a frontend agent conversation panel.
- Results that come only from actual tool execution, never fabricated by the model.
- No regression to the existing `/api/generate` and `/api/edit` flows or their tests.

## Out of scope

- The general "attach to body" tool. `wear_on_arm` in this spec only wraps the existing arm-tracking try-on; a general attach-to-body tool is a separate spec.
- Realtime voice front end. The streaming mechanism built here will be reused by it later, but voice itself is out of scope.
- English UI. The current UI stays Traditional Chinese; English UI is a separate spec.
- Re-enabling any back end's native tool calling, MCP, network, or shell access.
- Client tools (side: 'client'). These require a round-trip to the browser and are deferred to a later spec (VISION.md §4.4).
- Background jobs (long-running tools). These are deferred to a later spec (VISION.md §4.5).
- Home-scope tools (scope: 'home'). Multi-project support is deferred to a later spec (VISION.md §4.7).
- Materials, weight, cost estimation, and feasibility checks. These are moved to a separate materials-analysis spec.

## Functional requirements

### State ownership

1. Project state lives in the browser. The model, undo/redo history, selection, explode amount and try-on state are all in `App.tsx`; the server is stateless.
2. The client sends the current state with each `/api/agent` request.
3. Every state change a tool makes — new model, edited model, selection, explode amount, try-on — is streamed to the client as an SSE event, and the client applies it.
4. Model changes go through the existing undoable commit path, one undo step per model change, exactly as today's generate and edit flows do.

### Agent loop

5. The server runs an agent loop that, each round, sends the conversation history plus the current project state to the model via `ModelProvider.run(task)` and receives one `AgentStep`.
6. An `AgentStep` is either:
   - one or more tool calls to execute this round, each with a tool name and arguments, plus an optional short status note for the user; or
   - a final reply to the user, ending the run.
7. The agent loop executes every requested tool call, collects each tool's real result, appends those results to the conversation history, and continues to the next round.
8. The loop ends when the model returns a final reply, or when it reaches a configurable maximum number of rounds. The default maximum is 6.
9. When the maximum is reached without a final reply, the loop ends with an explicit notice to the user that the agent did not finish, and reports the last status it had.
10. A whole run has a configurable total time limit. When it is exceeded, the run ends the same way as reaching the round limit: the round in progress is discarded and earlier rounds' changes stay.
11. If the model returns an `AgentStep` that fails Zod validation, the loop retries that round once. If it fails again, the run ends with a sanitized error message in Traditional Chinese.

### Tools

12. A tool is a Forgehand-implemented function that takes arguments and the current project state, and returns a structured result. Tools that can be computed locally (explode, get state, select) never call the model.
13. **Tool registry**: tools are defined once with `defineTool({ name, category, description, args (Zod schema), side: 'server' | 'client', scope: 'project' | 'home', effects, run })`. The registry drives everything: the `AgentStep` schema (calls become `{ tool, argsJson }`), the tool list in `AGENT_INSTRUCTIONS` (generated from the registry), and dispatch. Each tool validates its own `argsJson` with its Zod schema; bad args return `INVALID_ARGS`.
14. The first tool set (all scope `'project'`, side `'server'`):
    - **`generate_design`** — produces a new concept model from a text description. Reuses the existing `designTask`.
    - **`edit_design`** — applies a text edit instruction to the current model. Reuses the existing `editTask` and `applyEditPlan`.
    - **`select_parts`** — sets the current part selection.
    - **`get_project_state`** — returns the current parts, selection, and display state (e.g. explode amount).
    - **`explode_view`** — sets the explode amount (0–1). On the server this only validates the amount and records it; the browser computes the exploded layout exactly as it does today. The server must not import `src/` (including `scene/explode.ts`); explode layout stays a browser-side concern. Changes display state only, never the `ModelSpec`.
    - **`wear_on_arm`** — toggles the existing arm-tracking try-on. It must never start the camera by itself: if the camera is off, the tool returns a result asking the user to turn it on, and try-on starts only after the user does. Video never leaves the browser.
15. Every tool result the agent reports to the user must come from the tool's actual execution. The agent may summarize a result, but must not state facts the tool did not produce. Tool results shown in the UI are rendered from the tool's structured result object, not from the model's text — so a test can verify a displayed result by asserting on the structured tool output, not by parsing prose.
16. Tool arguments are validated by each tool's registered Zod schema, and tool results by the result schemas in `shared/`. A tool that receives invalid arguments returns a structured error rather than throwing the loop.

### Streaming and cancellation

17. The agent reports its progress to the frontend in real time, per step: the model's status note, each tool call as it starts and finishes, and the final reply.
18. The transport is Server-Sent Events (SSE). The streaming mechanism is built so that the later realtime-voice feature can reuse it.
19. The user can cancel a run at any time. Changes already applied in earlier rounds stay, because they were validated and are undoable; the round in progress is discarded. Ending on a timeout, the round limit, or an error follows the same rule.

### API

20. A new `/api/agent` endpoint accepts a user instruction, the current model, selection, and display state, and streams the agent run.
21. `/api/generate` and `/api/edit` continue to work unchanged, and their existing tests pass without modification.
22. The request body stays under the existing 128 kB JSON body limit in `app.ts`.
23. A run counts toward the existing concurrency limit in `app.ts`.
24. The client sends a bounded history of previous turns in the same session — the user's instructions and the agent's final replies, not full tool details, capped (e.g. the last 10) — so a follow-up like "make the legs longer" can refer to an earlier run.

### Frontend

25. A new agent conversation panel lets the user enter an instruction, watch streamed progress, and read the agent's final reply.
26. The existing generate and edit forms are retained.
27. While an agent run is active, manual editing, the generate/edit forms, and undo/redo are disabled. The user can only watch or cancel. This avoids conflicts with manual edits made during the run.

## Non-functional requirements

28. The `AgentStep` schema and all tool argument/result schemas live in `shared/`, so both server and client validate with the same Zod authority, consistent with the existing `model.ts` / `edit.ts` contract.
29. The agent loop works against any `ModelProvider` (codex, claude, openai) without provider-specific branching, so switching back ends later requires no change to the loop.
30. Every task in `tasks.md` has unit tests. Tests never call a real model back end; they use a fake `ModelProvider` that returns scripted `AgentStep`s. Only `npm run verify:real` / `npm run verify:edit` may call a real back end, and only when the user asks.
31. `npm run check` (type check + build + unit tests) passes before a task is considered done, and the real result is reported.
32. Spec, design, and task files are written in English. UI strings the user sees stay Traditional Chinese; no language mixing within one screen.

## Constraints & conventions

33. The agent loop is built on the existing `ModelProvider.run(task)` and `ModelTask<T>` shape; the `AgentStep` is a new `ModelTask` parse target alongside the existing design/edit tasks.
34. All existing security posture is preserved: the server stays loopback-only, rejects non-loopback origins, sets `no-store` / `nosniff`, never logs provider bodies/keys/prompts, and sanitizes error messages returned to the client.
35. Locally-computable tools (`explode_view`, `estimate_weight_cost`, `check_feasibility`, `get_project_state`, `select_parts`) must not call the model, to keep latency and cost down.
36. The explode amount and wear/try-on toggle are display state only, like the existing `explode` and `tryingOn` state in `App.tsx`; they never become part of the `ModelSpec` or undo history.
37. The server must not import `src/`. Browser-only concerns (Three.js, MediaPipe, explode layout, camera) stay in the browser; the server only validates arguments and records display-state values.
