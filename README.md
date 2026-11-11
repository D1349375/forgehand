# Forgehand

**Develop hardware by talking and using your hands.** Forgehand is a new way of developing: like working with a coding agent in a terminal session, except you mostly speak, the results are 3D parts in your webcam view, and you adjust, assemble and even wear them with your own hands while the agent keeps helping.

> Status: early prototype. The text-to-3D workbench, part editing, exploded view and a webcam arm-tracking prototype work today. The agent harness, realtime voice and a general "attach to body" tool are being built next, with [Kiro](https://kiro.dev). See [docs/PRIOR_WORK.md](docs/PRIOR_WORK.md) for what existed before that.

## The idea

You describe a device ("a mechanical hand that runs from a glove up the forearm"). An agent with a tool harness turns that into parts you can see in the camera view. You grab and resize parts, assemble them, ask "is this assembly feasible?", split it into an exploded view to design the inside, ask for a weight and cost estimate, and say "put it on my hand" to see it follow your real forearm.

Wearing, exploded views and checks are **tools the agent calls**, the same way a coding agent opens a file. They are not hard-coded effects: they apply to whatever you designed.

```
voice / text + hands + pointing in the camera view
        │
realtime voice front end ── listens, can be interrupted, answers at once
        │
development agent (tool loop) ── understands intent, calls tools, reports real results
        │
shared project state ── parts, assemblies, selection, versions, checks
        │
camera view ── 3D parts over the webcam image, following your hands or body
```

## What works now

- **Text → 3D concept**: a description becomes a validated part model (boxes, cylinders, spheres, cones, tori, tubes) rendered as a translucent holographic object over the live webcam image.
- **Edit parts**: click to select, change size, position, rotation and colour, drag handles, undo/redo, or edit by text ("make the legs 50 cm and raise the top").
- **Exploded view**: computed locally from the part hierarchy and bounding boxes; no model call, no change to the data.
- **Arm tracking prototype**: MediaPipe hand and pose landmarks in a web worker (GPU with CPU fallback) drive a cuff on your forearm in the mirrored camera view, with smoothing, prediction and continuity rules measured on real recordings.
- **Interchangeable model back ends**: Codex CLI, Claude Code CLI or the OpenAI API behind one `ModelProvider` interface.

The UI is currently in Traditional Chinese; an English UI is planned.

## Run it locally

Requires Node.js 22.12+ and one model back end: a signed-in [Codex CLI](https://github.com/openai/codex) (default), Claude Code CLI (`MODEL_PROVIDER=claude`), or an OpenAI API key (`MODEL_PROVIDER=openai`).

```bash
npm ci
npm run build
npm start
```

Open http://127.0.0.1:5173. To change the back end, copy `.env.example` to `.env` and edit it. Keys are read only by the local server; `.env` is git-ignored. The server binds to `127.0.0.1` only.

`npm run dev` starts Vite with hot reload plus the API server.

## Tests

```bash
npm test
npx playwright install chromium
npm run test:e2e
```

Browser tests use a simulated camera and model service but render the real Three.js scene. They never call a real model. `npm run verify:real` and `npm run verify:edit` call the selected back end on purpose and use its quota.

## Privacy

The camera image stays in your browser. Hand tracking runs on your machine; only the MediaPipe model files are downloaded from Google. Model back ends receive text, not video.

## License

[MIT](LICENSE)
