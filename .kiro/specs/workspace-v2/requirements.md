# Workspace v2 — Requirements

## Overview

Today the browser holds exactly one object: a single `DisplayModel` in `src/App.tsx` with its own undo/redo stack, part selection, explode amount and try-on flag. Generating a new design replaces it. The agent request (`AgentRequestSchema` in `shared/agent.ts`) sends that one `model`, and `state` events change that one model.

This spec turns the single object into a **workspace**: several objects on stage at once, each with its own model and its own position and rotation, and one **active object** that editing, selection and the exploded view act on. It is capability C2 in `docs/VISION.md` (§2, §4.2).

The workspace is plain, versioned JSON validated by one Zod schema in `shared/`. Later specs build on it: `export` (export the active object or the whole workspace), `projects-memory` (save and reopen a workspace), `materials-analysis` (a material per object or per part), `candidates-tray`, `body-fit` (attach an object to a body anchor) and `hand-manipulation`. The data is shaped so those fit later, but none of them is built here.

Two small items ride along:
- **E2E isolation.** The Playwright suite gets its own ports and never reuses a running server, because it has twice tested an unrelated app that was listening on port 5173. This is the first task.
- **Tool labels.** `defineTool` gets a Traditional Chinese `label` that the `tool` SSE event carries, so the client no longer keeps its own label map (a known follow-up from `agent-harness`).

## Goals

- Several objects on stage; generating adds an object instead of replacing the scene.
- One active object; clicking any object's part makes it active.
- One undo/redo stack for the whole workspace.
- A small object list to switch, rename, delete and move objects.
- The agent sees the workspace, can target an object by id, and can switch, move and remove objects.
- A workspace format that later specs can save, export and extend without another data-model change.
- An e2e suite that cannot silently test the wrong app.
- No regression: with one object the workbench behaves as it does today, and the existing e2e suite passes.

## Out of scope

- **Object scale.** An object has a position and a rotation, no scale. Real size changes go through `edit_design` (part dimensions) or the part number fields, so millimetres stay true for export and for weight analysis later. Hand or agent "make it bigger" keeps working through `edit_design`.
- Candidates tray, background jobs, materials, body anchors and attach-to-body, saving or reopening workspaces, export, hand gestures.
- Dragging whole objects with a gizmo or by hand. Number fields are enough here; dragging comes with `hand-manipulation`.
- Selecting parts in more than one object at once, grouping, duplicating, aligning or snapping objects.
- An edit that changes several objects in one call. `edit_design` changes one object.
- Any change to the try-on itself. It still shows the stand-in cuff, not the user's design; `body-fit` replaces it.
- Changes to `ModelSpec`, `Part`, `/api/generate`, `/api/edit`, `designTask`, `editTask` or the provider adapters. Model back ends never see object transforms.
- English UI.

## Functional requirements

### E2E isolation

1. The Playwright web server runs the app on its own ports: frontend `5197` and API `8797`, passed to `npm run dev` as `PORT` and `API_PORT`. This applies to the default run and to the `RUN_LIVE_CLI=1` run.
2. Playwright never reuses an existing server, on CI or locally. If one of its ports is already taken, the run fails with a clear error instead of testing whatever listens there.
3. `use.baseURL` and `webServer.url` come from the same port value, so they cannot drift apart.
4. `PLAYWRIGHT_BASE_URL` keeps its current meaning: no web server is started and that URL is used.
5. The full e2e suite passes while the user's own dev server (or an unrelated app) is running on `5173` and `8787`, and the running dev server is not affected.

### Workspace data

6. `shared/workspace.ts` defines `WorkspaceSchema`:
   `Workspace = { version: 1, objects: SceneObject[], activeObjectId: string | null, selection: { objectId: string | null, partIds: string[] }, display: { explode: number } }`.
7. `SceneObject = { id, model: ModelSpec, transform: { position, rotation }, source, providerModel, edited, createdAt }`:
   - `id` replaces today's `lineage`. It is stable across edits of the object; a new object gets a new id. Whoever creates the object creates its id: the browser for objects the user adds, the server for objects the agent adds (requirement 41).
   - `model` is an unchanged `ModelSpec`.
   - `source` and `providerModel` mean what they mean in today's `DisplayModel` (provider name or `demo`, and the provider's model id).
   - `edited` drives the existing 「· 已修改」 source label.
   - `createdAt` is an ISO 8601 timestamp, so later specs can order objects and projects.
   - The object's name is `model.name` (see open question 1).
8. `validateWorkspace(input)` parses the schema and enforces:
   - object ids are unique and match the id format;
   - every model passes `validateModel`;
   - at most `MAX_OBJECTS` objects (8, see requirement 17);
   - `activeObjectId` is `null` exactly when there are no objects, and otherwise names an existing object;
   - `selection.objectId` is `null` or equals `activeObjectId`, and every selected part id exists in that object's model; with `objectId` `null`, `partIds` is empty;
   - `display.explode` is within 0–1.
9. `transform.position` is in metres within ±100 m per axis and `transform.rotation` is in degrees (XYZ Euler) within ±360°, the same units, axes and limits as part position and rotation. The transform positions and rotates the whole model and never scales it.
10. A workspace is plain JSON: no class instances, functions, `Date` objects or Three.js objects. `validateWorkspace(JSON.parse(JSON.stringify(workspace)))` returns an equal workspace. The `version` field lets later specs migrate saved workspaces.
11. Session state stays outside the workspace: the undo/redo history, try-on, camera, transform mode (移動/旋轉 handle), request timing, and open dialogs or notices.

### Workspace operations

12. Every workspace change goes through pure functions in `shared/`: add an object, replace an object's model, remove an object, set an object's transform, set the active object, set the selection, set the explode amount. The server's agent working copy and the browser use the same functions, so both sides compute identical results. Each function returns a new, valid workspace and never mutates its input. Ids and timestamps are passed in, so tests are deterministic.
13. Adding an object makes it active, clears the selection and resets explode to 0.
14. A new object is placed beside the existing objects so their bounding boxes do not overlap: offset along +X past the right edge of the existing objects, with a small gap, keeping Y and Z at 0. One shared, deterministic function computes the bounds and the offset from the models and existing transforms. The first object in an empty workspace sits at the origin with zero rotation, as models do today.
15. Removing the active object makes the object before it in the list active (or the first object if it was first), clears the selection and resets explode. Removing the last object leaves an empty workspace, and the empty-scene view returns.
16. Switching the active object clears the selection, resets explode to 0 and turns off the transform handle.
17. A workspace holds at most `MAX_OBJECTS = 8` objects, so the agent request and the scene stay small. At the limit, adding fails with a Traditional Chinese message; the generate button and 載入示範模型 are disabled with a short notice; the agent's `generate_design` fails before it calls the model, so no quota is spent.

### Undo and redo

18. One undo/redo stack covers the workspace, with today's limit of 50 steps.
19. Each of these is one undo step: adding an object (generate, accepted approximation, demo, agent), any change to one object's model (manual field edit, gizmo drag, part delete, rename, AI edit, agent edit), a transform change, and removing an object.
20. These are not undo steps, unchanged from today: switching the active object, selection, explode, try-on.
21. Undo and redo restore the objects and the active object as they were when the step was recorded. The selection keeps only parts that still exist in the restored active object. Explode is kept when the active object stays the same, otherwise reset, as today's `restore` does.
22. Adding the first object to an empty workspace with an empty undo history does not create an undo step, as today: there is nothing to go back to. Three existing e2e tests rely on 復原 staying disabled after the first 載入示範模型.

### Stage (browser)

23. The scene renders every object at its transform. Inactive objects are drawn dimmer than the active object and stay clickable. During try-on the scene keeps drawing every object as it does today, and the stand-in cuff is drawn as it is now; nothing else changes.
24. Clicking a part of the active object behaves as today: select, Shift-click to add or remove, repeated clicks cycle through parts under the pointer. Clicking a part of another object makes that object active and selects only that part, with or without Shift. Clicking empty space clears the selection and keeps the active object.
25. The exploded view applies to the active object only; other objects stay assembled. It stays display-only and never changes a model.
26. The transform handle drags parts of the active object only. A part's position and rotation stay relative to its parent part, or to the object's origin for a root part, as today.
27. Camera framing (see open question 3): the view frames all objects when an object is added or removed; editing, switching the active object and changing a transform keep the user's view; 重設視角 frames all objects. With one object the framing is the same as today.
28. Only objects whose model or transform changed are rebuilt or moved; switching the active object or the selection does not rebuild geometry. Three.js resources of removed or replaced objects are disposed with `disposeObject`.
29. The canvas attributes `data-model-name`, `data-part-count`, `data-selected-ids`, `data-model-json` and `data-explode` keep their meaning and describe the active object; with no objects they behave as they do today with no model. A new `data-object-count` gives the number of objects and `data-active-object-id` the active id. `SceneHandle.projectPart(id)` measures a part of the active object.

### Controls (browser)

30. The generate form (生成 3D 草案), an accepted approximation (接受近似並建立) and 載入示範模型 each add a new object. None of them replaces an existing object.
31. The edit form, part list, part fields, part delete, explode controls, model caption and details panel act on the active object. The `/api/edit` request sends the active object's model and selection; the API is unchanged.
32. An AI edit from the edit form applies only if its target object still exists and is still active when the answer arrives. Otherwise it is not applied, and the user sees today's messages (目前顯示的已是另一個物件，這次 AI 修改沒有套用。 and 等待期間已換成另一個模型，這次修改沒有套用。); `tests/e2e/edit-select.spec.ts` checks the first one. Conflict detection against manual changes made while waiting works as today, on the target object.
33. A new 物件 panel in the control column lists every object (name and part count), marks the active one (`aria-pressed`), and lets the user:
    - make an object active by clicking it;
    - rename the active object (a text field that changes `model.name`; one undo step; validated like the part name field);
    - delete an object (刪除物件; one undo step);
    - move the active object with number fields: position X/Y/Z in mm and rotation X/Y/Z in degrees. Each committed field is one undo step; out-of-range or non-numeric input is rejected as the part fields reject it.
34. New controls use accessible names that do not match existing test selectors: not 刪除零件, 復原, 重做, 載入示範模型, 生成 3D 草案, 修改指示, or any part name.
35. While an agent run is active, the 物件 panel's controls are disabled along with the other manual controls (the existing `agentActive` gate), and clicking a part of another object does nothing.
36. All new user-facing strings are Traditional Chinese.

### Agent

37. `AgentRequest` carries `workspace` instead of `model`, `selectedPartIds` and `explode`. It keeps `instruction`, `requestId`, `tryOn`, `cameraOn` and `history`. The server validates the workspace with `validateWorkspace` before any SSE byte; a failure is a plain JSON 400 with a fixed Traditional Chinese message that never echoes an id or Zod text.
38. `/api/agent` accepts JSON bodies up to 512 kB, because the request now carries up to 8 models. `/api/generate` and `/api/edit` keep the 128 kB limit. `server/app.ts` installs the 128 kB parser globally before any route, so the agent route's own limit must take effect before that parser runs. A unit test shows that a valid 200 kB request to `/api/agent` is accepted while the same size to `/api/edit` is rejected with 413.
39. The server's working copy for a run is a `Workspace`. The loop applies each tool's change with the shared operations from requirement 12.
40. `edit_design`, `select_parts`, `explode_view` and `get_project_state` take an optional `objectId`; without it they use the active object. A call to a tool with effect `writes-scene` whose `objectId` names a non-active object first makes that object active, so the user sees what the agent changes. Read-only tools never change the active object: `get_project_state(objectId)` only reads that object. An unknown `objectId` returns a `ToolError` with code `UNKNOWN_OBJECT` and no state change. In an empty workspace the tools that need an object return `NO_MODEL`, as today.
41. `generate_design` adds a new object and makes it active. When it succeeds, the server creates the object's id, its `createdAt` and its placed transform (requirement 14), so the model can refer to the new object by id later in the same run ("generate, then edit that object"). The tool result gives the model that id; the same id appears in later rounds' snapshots, and, because the browser adds exactly that object, in the workspace of later turns. At the object limit it returns `OBJECT_LIMIT` without calling the model.
42. Three new tools, all server-side, project scope, local (no model call), effect `writes-scene`:
    - `set_active_object(objectId)`: makes an object active (requirement 16).
    - `set_transform(objectId, position?, rotation?)`: sets the object's position (metres) and/or rotation (degrees); at least one is required. It never scales.
    - `remove_object(objectId)`: removes an object (requirement 15). Undoable in the browser.
43. `wear_on_arm` keeps its current arguments and behaviour (see open question 2).
44. `get_project_state` returns a summary of every object (id, name, part count, transform, which is active) plus the parts, selection and explode of the target object.
45. The per-round state snapshot sent to the model lists every object briefly and the parts of the active object only. The model sees a full `ModelSpec` only inside `editTask`, for the object being edited, as today.
46. `state` events carry small, validated workspace changes. One tool call changes at most one object (add, model change, transform change or removal), plus optionally the active object, selection, explode and try-on. An added object travels as the complete `SceneObject` the server created (id, model, transform, source, providerModel, edited, createdAt). A full `ModelSpec` appears in a `state` event only when an object is added or its model changes; transform, removal and active-object changes carry no model. `result` events never carry a model, as today.
47. The browser applies each `state` event with the same shared operations and checks the result with `validateWorkspace`. For an added object it adds exactly the `SceneObject` from the event and never creates its own id, timestamp or placement. Each object change in a `state` event is one undo step. An invalid payload, or one whose result fails validation, is ignored, as today.
48. `AGENT_INSTRUCTIONS` says, in English: `generate_design` adds a new object and does not replace the scene; objects are referred to by id; pass `objectId` when the user means an object that is not active; ask when it is unclear which object the user means; call `remove_object` only when the user asks to remove something; transforms are in metres and degrees; size changes go through `edit_design`, never through transforms.

### Tool labels

49. `defineTool` requires a `label`: a short Traditional Chinese name for the user, for example 生成設計.
50. The `tool` SSE event carries `{ tool, label, argsJson }`. For a tool name that is not registered, the server sends the label 其他步驟.
51. The client shows the label from the event. The tool-name map in `src/agent/labels.ts` is removed; `resultText` stays. The client still never shows `argsJson`.

### Compatibility

52. Every existing e2e spec passes. The only existing e2e file that may change is `tests/e2e/agent-panel.spec.ts`, and only where it builds the old request body or scripted `tool`/`state` frames. If any other existing e2e test needs a change, the task stops and reports instead of editing the test.
53. Existing unit tests change only where their subject changes (agent request, state changes, tool arguments, tool labels, history). `/api/generate` and `/api/edit` and their tests stay untouched.
54. With one object, the workbench looks and behaves as today, except that the 物件 panel appears.

## Non-functional requirements

55. `shared/` stays the single Zod authority: the workspace schema, its validator, the workspace operations and the agent state-change schema live there and are used by both server and browser.
56. Every task has unit tests (Vitest). Pure modules are tested in Node; no jsdom or happy-dom is added. Browser wiring is covered by e2e tests.
57. Tests never call a real model back end. Unit tests use a fake `ModelProvider`; e2e tests route `/api/*`.
58. `npm run check` (type check + build + unit tests) passes before a task is marked done, and the real result is reported.
59. Spec, design, task files and code comments are English; user-facing strings are Traditional Chinese, with no mixed languages on one screen.
60. The security posture is unchanged: loopback-only server, origin check, `no-store`/`nosniff`, sanitized errors, no logging of prompts or provider output, and the server never imports `src/`.
61. Undo history shares unchanged objects between snapshots (structural sharing), so 50 steps of an 8-object workspace stay cheap.
62. `tasks.md` has at most 10 tasks, Task 1 being e2e isolation. Each is small enough for one fresh Kiro session with Claude Sonnet 5.5 (roughly one module plus its tests), and the list ends with a cut order for when time runs short. `design.md` maps every requirement to a task.

## How later specs fit (not built here)

- **export:** every object has its model and transform, so "export the active object" and "export the whole workspace" are both possible from the workspace alone.
- **projects-memory:** a project saves a `version: 1` workspace as JSON and reopens it through `validateWorkspace`.
- **materials-analysis:** adds an optional `material` to `SceneObject` and to `Part`. No object scale means dimensions stay real for weight and cost.
- **candidates-tray:** candidates are a separate list; `objects` stays "what is on stage", and placing a candidate is an add.
- **body-fit:** adds an optional anchor per object; the transform becomes the offset from the anchor.
- **hand-manipulation:** a hand drag commits through the same "set transform" operation, one undo step per drag.

## Decisions from review

The open questions of the first draft were reviewed on 2026-11-14. All recommendations were accepted; the requirements above already reflect them.

1. **One name.** No separate `SceneObject.name`; the object's name is `model.name`, and renaming in the 物件 panel changes `model.name`. `edit_design` can rename it too, and `data-model-name` and export use it.
2. **`wear_on_arm` unchanged.** The try-on shows a stand-in cuff, not any object, so an `objectId` would do nothing; `body-fit` replaces the tool with `attach_to_body(objectId, anchor)`.
3. **Camera framing.** Frame all objects when an object is added or removed, keep the view otherwise, frame all on 重設視角. Zooming to one object comes with `hand-manipulation`.
4. **512 kB for `/api/agent` only.** Real generated models are 1.0–2.3 kB of JSON (`artifacts/real-provider-2026-11-11.json`), but eight models at the 64-part limit plus history can exceed 128 kB. The global 128 kB parser in `server/app.ts` must not run first for this route (requirement 38).
5. **Shared bounds code.** `worldMatrices` and `partBoxes` move from `src/scene/explode.ts` to `shared/bounds.ts` (Three.js math classes only, no rendering), and `explode.ts` imports them. `.kiro/steering/structure.md` then describes `shared/` as "Zod schemas, validation, and pure geometry helpers that use only Three.js math classes".
6. **Undo snapshot scope.** A snapshot holds `objects` and `activeObjectId` only; selection and explode follow requirement 21.
7. **Pending AI edit.** Applies only if its target is still the active object (requirement 32).
8. **Object limit.** 8, as one exported constant.
9. **Agent targeting a non-active object.** Only `writes-scene` tools make the target active first; read-only tools never change the active object (requirement 40).
10. **E2E ports.** Defaults `5197`/`8797`, overridable with `E2E_PORT` and `E2E_API_PORT`.
