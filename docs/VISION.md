# Forgehand: vision, capabilities and agent architecture

> Status: planning document, 2026-11-13. Drafted with Claude Code from the author's description of the workbench, plus a short feasibility review. Each capability below becomes its own Kiro spec in `.kiro/specs/`; the specs and the implementation are done with Kiro. Items marked **verify** were not confirmed and need a spike before a spec commits to them.

## 1. The workbench in one session

The user is designing a bracelet. They talk to the agent and use their hands in the webcam view.

0. On arrival they talk to their personal AI: "I still have a few products unfinished." It lists them. "Bring up the bracelet." The bracelet project opens where they left off (§4.7).
1. "Make five candidate bracelets." The agent generates five concepts. They appear as small thumbnails in a tray at the bottom right of the camera view.
2. The user pinches one thumbnail and drags it to the centre. It grows to full size. They pinch and drag to move or rotate it, and double-pinch a part to zoom in on the details.
3. "Make it steel and show me." The material changes. "And send an agent to check whether steel still works." A background agent starts, runs a weight, cost and feasibility check, and reports back when it is done, while the user keeps working.
4. "Show me the exploded view" (or a gesture). The parts separate. The user pulls individual parts out to look at them, and snaps parts together like building blocks. Parts that cannot connect refuse and spring back.
5. "Put it on my hand." The bracelet attaches to the wrist and follows it live. The user adjusts size and position until it fits.
6. "Export it." The user gets a 3D file for printing, an exploded-view image, or a dimensioned drawing, whichever they need.

The same workbench should work for other products: shoes fitted to the foot when the camera sees the feet, glasses or a helmet fitted to the head, an object placed in front of the camera and scanned into an editable model, or the user's own body measured and shown as a rough mannequin to design around.

**Freedom comes from general, composable tools, not from many narrow ones.** A coding agent is flexible with read, edit and run. Forgehand's equivalent is a small set of general tools (generate, edit, place, attach, analyse, export) that work on any object the user designed, plus a harness that can add tools without growing the per-round prompt.

## 2. Capability map

Priority: **P0** needed for the hackathon demo, **P1** strong demo value if time allows, **P2** after the hackathon or stretch.

| # | Capability | What the user does | How it works | Feasibility | Priority |
|---|---|---|---|---|---|
| C1 | Agent harness | Talks to the agent; sees progress; cancels | Server-side tool loop (done: tasks 1–4), tool registry, client tools, background jobs | Built on existing code | P0 |
| C2 | Workspace with several objects | Has more than one object on screen | Project state v2: objects with their own model, transform, material, anchor | Data-model change, no new technology | P0 |
| C3 | Candidates tray | "Make five candidates"; picks one | N generations in parallel (bounded), thumbnails rendered from the same Three.js scene | Latency: N model calls; show each as it lands | P1 |
| C4 | Hand manipulation | A hand skeleton drawn over the camera view; pinch a part to move or rotate it in the current mode, pinch empty space to orbit the view, double-pinch to zoom in on a part (see §4.9) | Hand landmarks (already tracked) → smoothed cursor → pinch state machine → screen-space raycast into the scene → the gizmo's commit path | Hand tracking exists; gestures are new code | P1 (skeleton overlay moves into `body-fit`) |
| C5 | Materials and appearance | "Make it steel" | Material presets: PBR look + density + price per kg; per object or per part | Three.js `MeshPhysicalMaterial`; data table | P1 |
| C6 | Analysis tools | Weight, cost, feasibility | Local: volume × density, simple geometry checks (task 9) | Local and cheap | P1 |
| C7 | Background agents (jobs) | "Send an agent to check …, report back" | Child agent run with a read-only tool set; job events; report card | Harness feature; reuses the loop | P1 |
| C8 | Exploded view and part inspection | Explode, pull parts out, isolate | Existing `explode.ts`; isolate/highlight tools; grab individual parts (C4) | Mostly exists | P0 (exists) |
| C9 | Snap assembly | Drags a part onto another; wrong fits spring back | Connectors on parts (type, size, gender); compatibility rules; snap animation | New data and rules; demo-friendly | P2 |
| C10 | Body fit | "Put it on my hand / head / foot" | Body anchors from MediaPipe: hand + pose (wrist, forearm), face transform matrix (head), pose heel and foot-index (foot) | Hand/forearm exists; head and foot are new anchors | P0 hand/wrist, P1 head, P2 foot |
| C11 | Export | GLB/STL/OBJ, exploded image, drawing, BOM | Three.js exporters; canvas capture; orthographic views to SVG; CSV | Exporters ship with three; printable STL needs a union (see §3.3) | P0 files and image, P1 BOM, P2 drawings |
| C12 | Scan a real object | Holds a bowl up: "scan this" | Tier 1: vision model approximates it with primitives. Tier 2: revolve objects from the silhouette (lathe). Tier 3: optional image-to-3D service | Needs image input to providers (**verify**) and explicit consent | P2 |
| C13 | Body measurement and avatar | "Measure me and show my body" | Pose world landmarks → segment lengths → mannequin from primitives; scale from a known height or reference object | Approximate; must be calibrated and labelled as an estimate | P2 |
| C14 | Import model files | Import a GLB/STL as a reference | Import meshes as non-editable reference objects (saving and reopening work is C17) | Three.js loaders exist | P2 |
| C15 | Voice | Speaks instead of typing; can interrupt | Push-to-talk speech-to-text into the same agent run; later a realtime voice front end | Browser speech APIs send audio to a vendor (**privacy**) | P1 push-to-talk, P2 realtime |
| C16 | English UI | Judges read the screen | i18n of existing strings | Mechanical | P0 |
| C17 | Personal AI, projects and memory | Starts by talking to a personal assistant: "I still have a few products unfinished." "Bring up the bracelet." The project opens, or the projects float as cards in the camera view to pick from | A home agent with project tools; each project keeps its workspace, its own memory and its sessions; a small shared memory about the user; long sessions are summarised (see §4.8) | Local files on the user's machine; same harness with a different tool set | P1 (core), P2 (hand-picked floating cards) |

**Why export is P0:** a workbench whose designs cannot leave it has no practical use. A GLB/STL file and an exploded-view image are the minimum; assembly by snapping (C9) is a nice interaction but not required to make the result usable.

## 3. Research notes

### 3.1 Body anchors (C10, C13)

- `@mediapipe/tasks-vision` 1.2.2, already a dependency, includes the Hand, Pose and Face Landmarkers. Hand and pose run today in `src/try-on/arm.worker.ts`.
- **Head:** the Face Landmarker can output a facial transformation matrix (`outputFacialTransformationMatrixes`) that maps a canonical face model onto the detected face. A head-worn object modelled around the canonical face can be placed with that matrix. Google does not publish a Three.js example, so units and axes must be checked in a spike (**verify**).
- **Foot:** the Pose Landmarker includes heel and foot-index landmarks, enough for a coarse foot anchor (position, direction, rough length). Toe-level fit is out of reach.
- **Body size:** pose world landmarks are hip-centred, metre-like estimates, not calibrated measurements. Published work on monocular body measurement finds pose-only methods sensitive to calibration and camera position, and sets scale from a known measurement or a reference object. Forgehand should ask for the user's height (or a reference object such as an A4 sheet at the same distance) and always label the result as an estimate.
- Avoid SMPL-style body models in the product; their licences restrict commercial use. A mannequin built from Forgehand's own primitives keeps everything editable and licence-clean.

### 3.2 Scanning (C12)

- **Tier 1, primitives from a photo:** send one still frame and the prompt to a vision-capable model and ask for a `ModelSpec`, the same contract as text generation. The result is editable immediately. Today no provider adapter sends images (`server/codex.ts`, `server/claude.ts`, `server/app-server.ts` and the OpenAI adapter are text-only). Adding an `images` field to `ModelTask` is needed; whether each CLI accepts an image in this isolated mode must be tested (**verify**).
- **Tier 2, revolve objects:** bowls, cups and vases are surfaces of revolution. Segment the object (MediaPipe Image Segmenter or Interactive Segmenter), take half the silhouette as a profile and build a `LatheGeometry`. This runs locally and works well for exactly the bowl example. It needs a new primitive type (`lathe` with a profile), which is a schema change.
- **Tier 3, general mesh:** open image-to-3D models exist. TRELLIS.2 (Microsoft) is reported as MIT-licensed; Hunyuan3D's licence is reported differently by different sources (including regional exclusions); TripoSR is MIT but rough. They need a GPU server (reported roughly 6–16 GB VRAM) and return meshes, not editable parts. Treat this as an optional external provider, after reading each licence file.
- **Privacy:** today "model back ends receive text, not video". Scanning sends a still image. It must be an explicit, per-scan user action with a visible notice, and README's privacy section must change when it ships.

### 3.3 Export (C11)

- Three.js ships `GLTFExporter`, `STLExporter`, `OBJExporter`, `PLYExporter` and `USDZExporter` (present in `node_modules/three/examples/jsm/exporters/`). GLB is the best general format; STL is what 3D-printing users expect.
- Forgehand models are overlapping primitives. Exporting them as-is gives a valid file for viewing, but a slicer may not like intersecting shells. For a print-ready STL, union the parts first (for example with a CSG library such as `three-bvh-csg`, a new dependency to evaluate).
- Exploded-view image: render the current scene (with explode applied) to a PNG.
- Drawings: orthographic front, side and top views to SVG with overall dimensions from the bounding boxes. PDF can come later.
- BOM: part list with primitive, dimensions, material, estimated mass and cost as CSV.

### 3.4 Voice (C15)

- The browser's speech recognition in Chrome sends audio to Google's servers, which conflicts with the current privacy statement unless the user is told. A server-side speech-to-text through the configured provider, or a realtime voice API, keeps one privacy story. The SSE event stream built in the harness is the transport voice will reuse.

## 4. Architecture

### 4.1 Layers

```
model (brain, swappable)   Codex CLI | Claude Code CLI | OpenAI API — returns one AgentStep per round
        │
harness (Forgehand)        loop, limits, cancel, validation, tool registry, jobs, event stream
        │
tools                      server tools (pure, on the project state)
                           client tools (camera, tracking, gestures, capture, files — run in the browser)
        │
project state              workspace: objects, candidates, selection, display, body anchors, jobs
```

### 4.2 Project state v2 (C2)

Today the browser holds one `DisplayModel`. The workbench needs a workspace:

```ts
Workspace {
  objects: SceneObject[]        // what is on stage
  candidates: Candidate[]       // the tray (C3)
  activeObjectId: string | null
  selection: { objectId, partIds[] }
  display: { explode, isolate[], camera view }
  body: { anchor: 'none' | 'hand' | 'wrist' | 'forearm' | 'head' | 'foot', objectId | null }
  jobs: JobSummary[]            // background agents (C7)
}
SceneObject {
  id, lineage, name
  model: ModelSpec              // unchanged contract
  transform: { position, rotation, scale }
  material: MaterialId | null   // object default; parts may override
  source: 'generated' | 'edited' | 'scanned' | 'imported'
}
```

`ModelSpec` and `Part` stay the contract shared with the model back ends. New optional part fields come with their features: `material` (C5), `connectors` (C9), a `lathe` primitive with a profile (C12). Undo/redo becomes per workspace. This is a separate spec because it touches `App.tsx`, the scene and the agent state events.

### 4.3 Tool registry (C1)

The current `AgentStep` puts every tool's arguments into one flat object (`shared/agent.ts`). That is fine for 8 tools and does not scale to 30: every tool adds fields the model sees every round, and adding a tool touches five places.

Change to a registry:

```ts
defineTool({
  name: 'set_material',
  category: 'appearance',
  description: 'Sets the material of an object or of selected parts.',
  args: z.strictObject({ objectId: z.string(), material: MaterialIdSchema, partIds: z.array(PartId).nullable() }),
  side: 'server',                 // or 'client'
  scope: 'project',               // or 'home' (§4.7)
  effects: 'writes-scene',        // read-only | writes-scene | writes-project | writes-memory | uses-camera | sends-image | long-running
  run: (args, ctx) => ToolResult,
})
```

- The model-facing step becomes `{ type, note, reply, calls: [{ tool, argsJson }] }`. Its JSON schema no longer grows with the tool count, so it stays portable across the three back ends. Each tool parses `argsJson` with its own Zod schema; a bad call returns `INVALID_ARGS` and the model corrects itself next round.
- The tool list in the instructions is generated from the registry (name, one-line description, argument shape). Unimplemented tools are simply not registered, so the model never sees them.
- `effects` drives policy: background jobs may only use `read-only` tools; `uses-camera` and `sends-image` tools always need the user's action in the browser.
- When the catalogue grows past about 20 tools, add a `find_tools(query)` tool and send only the core tools plus what the model asked for.

### 4.4 Client tools

Many workbench tools can only run in the browser: start tracking for a body anchor, read a pinch, capture a still frame for a scan, measure the body from pose landmarks, write an export file. The loop stays on the server (it holds the provider and the CLI processes), so a client tool works as a round trip:

1. The loop emits `client_call { callId, tool, args }` on the event stream and waits.
2. The browser runs the tool and POSTs `{ runId, callId, result }` to `/api/agent/client-result`.
3. The loop continues with that `ToolResult`. A per-call timeout and run cancel apply as usual.

Anything that needs the camera or sends an image requires a visible user action (a confirm button), never the agent alone.

### 4.5 Background agents (C7)

- A `start_job({ kind, instruction, objectId })` tool starts a child agent run with a restricted, read-only tool set (analysis, measurement, checks) and a snapshot of the object. The main run continues immediately.
- The server keeps jobs in memory for the session, within the existing concurrency limit, and emits `job_started`, `job_progress`, `job_done` events on a session stream. The UI shows a job card; the finished report appears in the conversation.
- `get_job_result(jobId)` lets the main agent use the report in a later turn.
- A job never changes the scene. If it recommends a change, the user or the main agent applies it.

### 4.6 Speed

The CLI back ends take seconds per call (8–80 s per AI edit in `docs/PRIOR_WORK.md`). The workbench must stay responsive:

- Everything that can be local is local: explode, isolate, materials, analysis, export, body anchors, gestures.
- A round can request several tools; candidates generate in parallel up to the concurrency limit, each shown as it finishes.
- Gestures and direct manipulation never wait for the model.

### 4.7 Personal AI, projects, sessions and memory (C17)

The idea follows a personal assistant in the style of a film AI butler, and borrows its structure from Claude Code and Codex: a project holds work, a session is one conversation inside a project, sessions can be resumed or switched, and memory is split by scope so each round only carries what it needs.

**Concepts**

| Concept | Holds | Coding-agent equivalent |
|---|---|---|
| Home | The personal AI the user talks to on arrival; lists projects and their status | Picking a repo and a session to resume |
| Project | One product: workspace state (§4.2), project memory, sessions, exports | A repository with its own `CLAUDE.md` / `AGENTS.md` |
| Session | One conversation in a project: turns, a rolling summary, the run log | One Claude Code / Codex session, resumable |
| Shared memory | Facts about the user that apply to every project: units, style preferences, body measurements (wrist, head, foot size), preferred materials | User-level memory file |
| Project memory | Decisions and constraints for this product: "must fit a 17 cm wrist", "no exposed screws", chosen material | Project memory file |

**Flow**

1. The app opens at Home. The home agent sees the project list (name, one-line status, last change) and shared memory, nothing else.
2. "I still have a few products unfinished." The agent answers from the list. "Bring up the bracelet." It calls `open_project`, and the workbench switches to that project's workspace and its latest session. Alternatively the projects appear as cards in the camera view; the user picks one by click, voice, or later by hand.
3. Inside a project, the project agent has the design tools. "Back to home" or "switch to the shoe" moves between projects. "New session" starts a fresh conversation in the same project.

**Context budget per round.** The CLI back ends are stateless per call (each request starts a fresh, isolated thread), so everything the model knows is sent every round. Memory design is therefore also latency and cost design:

```
round input = shared-memory index (short) + project memory + session summary
            + last N turns + compact workspace snapshot + this run's tool log
```

- When a session grows past a threshold, older turns are folded into the session summary (compaction), the same idea as Claude Code's automatic compaction.
- Memory entries are short facts with a scope and a source. The agent adds them with `remember(scope, fact)` and removes them with `forget(id)`; it should only save what will matter later, not every turn.
- The user can open a memory panel, read every entry and edit or delete it. Memory is data shown to the model, never instructions that override the rules.
- Background jobs (§4.5) get a snapshot of the object and the project memory, not the conversation.

**Storage.** Projects, sessions and memory are files on the user's machine under a local data directory (git-ignored), read and written only by the local server, consistent with the loopback-only server and the privacy model. Nothing is uploaded.

**Tools.** Home: `list_projects`, `open_project`, `create_project`, `archive_project`, `remember`, `forget`. Project: the design tools plus `remember`, `forget`, `new_session`, `go_home`. The registry (§4.3) gets a `scope: 'home' | 'project'` field so each agent only sees its own tools.

### 4.8 Tool catalogue v1

| Tool | Category | Side | Effects | Priority |
|---|---|---|---|---|
| `generate_design` (exists) | design | server | writes-scene | P0 |
| `edit_design` (exists) | design | server | writes-scene | P0 |
| `generate_candidates(prompt, count)` | design | server | writes-scene | P1 |
| `place_candidate(candidateId)` | design | server | writes-scene | P1 |
| `set_transform(objectId, …)` | design | server | writes-scene | P1 |
| `get_project_state` (exists) | inspect | server | read-only | P0 |
| `select_parts` (exists) | inspect | server | writes-scene | P0 |
| `isolate_parts(partIds)` | view | server | writes-scene | P1 |
| `explode_view` (exists) | view | server | writes-scene | P0 |
| `set_material(objectId, material, partIds?)` | appearance | server | writes-scene | P1 |
| `estimate_weight_cost` (task 9) | analysis | server | read-only | P1 |
| `check_feasibility` (task 9) | analysis | server | read-only | P1 |
| `start_job` / `get_job_result` | jobs | server | long-running | P1 |
| `attach_to_body(objectId, anchor)` (generalises `wear_on_arm`) | body | client | uses-camera | P0 hand/wrist, P1 head |
| `export_model(format)` / `export_image` | export | client | read-only | P0 |
| `export_bom` | export | client | read-only | P1 |
| `list_projects` / `open_project` / `create_project` / `archive_project` | home | server | writes-project | P1 |
| `new_session` / `go_home` | project | server | writes-project | P1 |
| `remember(scope, fact)` / `forget(id)` | memory | server | writes-memory | P1 |
| `snap_parts(a, b)` | assembly | server | writes-scene | P2 |
| `scan_object(mode)` | capture | client | sends-image | P2 |
| `measure_body()` / `show_body_avatar()` | body | client | uses-camera | P2 |

### 4.9 Hand control (C4)

Decided with the user on 2026-11-14, after an independent design review of the repo.

**One gesture, explicit mode.** A laptop webcam gives about one reliable "button": the pinch. So the pinch is the only action gesture, and the mode decides what it does, as in Blender.
- Pinch on a part: select it and move or rotate it in the current mode. Pinch on empty space: orbit the view (no data change, no undo step).
- The mode is the existing `transformMode` (移動 / 旋轉), switched by the existing buttons, new G/R keys, and later the agent or voice.
- Wrist-twist rotation and two-hand gestures are out: palm-facing roll is ambiguous (`src/try-on/arm-pose.ts`), the worker tracks one hand, and two raised hands tire the user quickly.

**What the user sees.**
- The hand skeleton is drawn over the camera view whenever the hand is tracked, so the user always knows whether the hand is seen.
- **Skeleton colour = mode** (two or three colour-blind-safe hues; not the cyan already used for part edges). State is shown separately by line weight and a cursor ring: thin = tracked, hollow ring = over a part, filled = grabbed, grey dashed = locked.
- A short zh-TW badge next to the hand, e.g. 「手勢：移動 · 已抓取」, so colour is never the only signal.

**Zoom and size are different things.**
- *Looking at details* is view zoom and never changes the model: double-pinch a part to frame it, double-pinch empty space to reset the view. The mouse wheel and the zoom buttons stay.
- *Changing the real size* (the whole object, or stretching one dimension) is not a hand gesture in this version: the user cannot show which axis or how many millimetres with one pinch. It goes through the agent ("整體放大 1.5 倍", "握把拉長 2 公分"; the agent asks when the axis is unclear) or the number fields. Later option: a 尺寸 mode where the drag direction picks the axis, with a live mm readout.

**Behaviour.**
- On automatically when the camera is on. Off (skeleton still shown) while an agent run is active, while the exploded view is open, during try-on, and on the CPU fallback (about 2 fps in `docs/PRIOR_WORK.md`), with a notice.
- Cursor from a stable point (the index knuckle or the thumb–index midpoint), smoothed with a One Euro filter; relative mapping with gain from the pinch start, so the part does not jump.
- Pinch hysteresis on the metric world landmarks (engage below about 3 cm for 2 frames, release above about 5 cm for 3 frames); a hover target changes only after about 150 ms.
- A drag previews like the gizmo and commits once on release through `onTransform`, so one gesture is one undo step.
- **Tracking lost mid-drag: cancel and revert by default** (after about 300 ms). This is a named constant, and debug stats (`?hands=debug`) count losses during drags; if losses are frequent in real use, switch the default to keep the change.

**Split between specs.**
- `body-fit` takes the shared part: hand tracking runs whenever the camera is on (not only during try-on), raw landmarks are exposed, pose is skipped when not needed, and the skeleton overlay and badge are drawn. The overlay also helps debug try-on tracking.
- `hand-manipulation` keeps the gestures: the pinch state machine, picking, pinch-move, empty-space orbit, rotate mode, double-pinch zoom. Cut order inside it if time runs short: rotate mode, then orbit, then move.

## 5. Hackathon plan

Deadline: 2026-12-04 14:00 PT (2026-12-05 06:00 Taiwan). About three weeks remain. Each spec below is created and implemented in Kiro, reviewed task by task, and committed with the spec task in the message.

| Phase | Dates (Taiwan) | Specs |
|---|---|---|
| A | 11/13 – 11/17 | `agent-harness`: fix the task 4 retry bug, insert a tool-registry task before task 5, then tasks 5–8 (route, panel, e2e) |
| B | 11/17 – 11/23 | `workspace-v2` (C2), `export` (C11 files and image, P0), `projects-memory` (C17 core: home agent, projects, sessions, memory, compaction), `materials-analysis` (C5, C6, task 9 moved here) |
| C | 11/23 – 11/29 | `body-fit` (C10: shared hand tracking and the skeleton overlay from §4.9, then generalise try-on to any designed object on hand/wrist, then head), `candidates-tray` (C3), `background-jobs` (C7), `hand-manipulation` (C4) |
| D | 11/29 – 12/03 | `english-ui` (C16), push-to-talk voice if time allows (C15), README and privacy update, demo video, Devpost submission, make the repo public |
| After | — | snap assembly (C9), scanning (C12), body avatar (C13), floating project cards picked by hand, drawings, realtime voice |

If time runs short, cut in this order: `hand-manipulation`, `background-jobs`, `candidates-tray`, then the floating-cards part of `projects-memory`. Export and body fit stay (including the hand skeleton overlay, which lives in `body-fit`).

Demo path for the video, using only P0/P1: "I have unfinished products" → open the bracelet project → candidates → pick one → steel → background feasibility report → exploded view → put it on my wrist → export STL.

## 6. Open questions and risks

- **Latency of candidates:** five generations through a CLI may take minutes. Option: one call that returns several small variants, at the cost of a larger schema.
- **Image input per provider (C12):** untested in the isolated CLI modes.
- **Head anchor units (C10):** the face transformation matrix needs a spike before the spec.
- **Try-on quality today (C10):** in the author's own test (2026-11-13) the forearm tracking still loses the arm and the cuff does not feel worn. The `body-fit` spec must cover tracking stability and realism, not only "attach any object": hand and arm occlusion (a person-segmentation mask so the far side of the object hides behind the arm), a contact shadow, matching light, scale from metric world landmarks, and smoothing measured on recordings like `docs/PRIOR_WORK.md` did.
- **Hand control (C4):** whether tracking is stable enough for drags on the user's laptop is unknown; the cancel-on-loss default may need to flip (§4.9). Changing real size by hand is deferred.
- **Printable export:** union of primitives needs a CSG dependency; decide in the `export` spec.
- **Credits and time:** Kiro credits are sufficient at the observed ~12 credits per task with Claude Sonnet 4.5; time is the real limit. Phase D is fixed; cut P1 items from phases B and C first.
