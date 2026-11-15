# Project structure

Three layers, separated by what may import what:

```
shared/    Zod schemas, validation, and pure geometry helpers that use only Three.js math classes, imported by BOTH server and src.
           model.ts        PartSchema, ModelSpecSchema, GeneratedDesignSchema, validateModel/validateDesign
           edit.ts         EditPlanSchema, applyEditPlan, editConflicts, describeChanges, EditError
           schema.ts        converts Zod schemas to portable JSON Schema (draft-7) for model back ends
           bounds.ts       worldMatrices, partBoxes, modelBox, objectBox (Three.js math only, runs in Node)
           workspace.ts    Workspace schema, validation, operations, placement
           demo.ts         a hand-written ModelSpec for the "load demo" button
server/    Express API + model provider adapters. Imports shared/. Never imported by src/.
           index.ts        entry point: ports, spawns Vite in dev, signal handling
           app.ts          createApp(): routes /api/status /api/generate /api/edit, security headers, timeout/concurrency
           provider.ts     ModelProvider interface, OpenAI adapter, MODEL_INSTRUCTIONS, designTask/editTask
           model-host.ts   selects provider from MODEL_PROVIDER env (codex|claude|openai)
           codex.ts        Codex CLI exec adapter + runCommand subprocess runner
           app-server.ts   Codex CLI long-running app-server adapter
           claude.ts       Claude Code CLI adapter
src/       React frontend + Three.js. Imports shared/. Never imports server/.
           App.tsx         main UI: prompt/edit forms, camera, undo/redo, conflict handling
           main.tsx, styles.css, index.html
           scene/          Three.js: geometry.ts (buildModel), explode.ts, SceneViewport.tsx, style.ts, arm-preview.ts
           try-on/         MediaPipe arm tracking: arm-pose.ts (ArmTracker), arm.worker.ts, useArmTracking.ts
tests/
           unit/           Vitest (server-app, edit, model, scene, etc.)
           e2e/            Playwright (workbench, edit-select, explode, arm-try-on, captured-models, ...)
scripts/   verify-real-provider.ts, verify-real-edit.ts
artifacts/ JSON output from verify:* scripts (local/ is git-ignored)
docs/      PRIOR_WORK.md
```

## Architecture rules
- **`shared/` is the contract.** Both `src/` and `server/` validate every model and edit plan through the same Zod schemas. Never duplicate validation logic on one side.
- **`ModelProvider`** is one interface (`provider.ts`) behind three adapters. All adapters run tasks through `ModelTask<T>` with the same `instructions` + `schema` + `parse`. An edit can never use different units, axes, or primitive rules than generation — they share the same instruction text.
- **Strict security posture.** The server binds to `127.0.0.1` only, rejects non-loopback origins, sets `no-store` / `nosniff`, never logs provider error bodies, keys, prompts, or raw CLI diagnostics, and sanitizes all error messages returned to the client. Subprocesses are spawned with `shell: false`; user text goes via stdin or temp files, never in arguments.
- **Geometry conventions.** Units are meters, Y is up, rotation in degrees (XYZ Euler). Primitives: box, sphere, cylinder, cone, torus, tube. Parent transforms position/rotation children but never scale child dimensions. See `MODEL_INSTRUCTIONS` in `provider.ts`.
- **Edit plans return only changed parts** (`upsert`/`remove`); the browser re-applies them to its latest model and resolves conflicts with any manual changes made while the request was in flight.
- **Exploded view is display-only** (`scene/explode.ts`); it never mutates the `ModelSpec`.
- **Three.js resources are explicitly disposed** (`disposeObject` in `geometry.ts`) to avoid leaks on model swap.
