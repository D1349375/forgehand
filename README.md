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

## Hand control

Turn the camera on (開啟攝影機) and move your hands in front of it. Hand control is on by default and has its own switch, 手勢. Both hands are tracked and drawn as skeletons over the view; one hand is enough for everything below. Each skeleton has a short badge that says what the hand is doing, so colour is never the only signal.

- **Grab and move a part**: point at a part until its ring appears, pinch thumb and index finger, move, and open the fingers. The part moves with your hand, its child parts follow, and 復原 (undo) puts it back in one step. A quick pinch without moving only selects the part.
- **Turn the view**: pinch on empty space and move. The view turns while you pinch and stays where it is when you let go.
- **Finer moves**: zoom in with the mouse wheel. The same hand movement then moves a part less.
- **A second hand** cannot start anything while the first hand is pinching; its pinch is shown as inactive until you open it.
- **View-only and off**: while the exploded view is open or the agent is running, a pinch only turns the view, and the status line under the camera says so. While the arm try-on (護臂試戴) runs, or when the tracker is too slow for gestures (under 10 frames per second), hand control is off and the mouse works as usual. The skeletons stay visible in both cases.
- **If tracking is lost** for more than about a third of a second during a drag, the part goes back to where it was and the status line says so.
- **隱藏鏡頭畫面** hides the camera image and keeps tracking and the skeletons running, for a plain backdrop. Turning the camera off and on shows the image again.
- Turn 手勢 off to use the mouse only. Everything above is local; no video or landmark leaves the browser.

Add `?hands=debug` to the address to show tracking numbers (delegate, frames per second, recognition time, pinch distance in mm) and gesture counters (drags, commits, cancels, losses). `?hands-min-fps=<number>` changes the speed threshold for slow machines (0 switches the speed check off).

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

The e2e suite starts its own server on ports 5197/8797 (override with `E2E_PORT` / `E2E_API_PORT`) and stops with an error if those ports are taken. Browser tests use a simulated camera and model service but render the real Three.js scene. They never call a real model. `npm run verify:real` and `npm run verify:edit` call the selected back end on purpose and use its quota.

## Privacy

The camera image stays in your browser. Hand tracking runs on your machine whenever the camera is on; turning the camera on downloads the MediaPipe hand and pose model files from Google's public model storage, and the video and the hand landmarks never leave the browser. Model back ends receive text, not video.

## Credits

- [manifold-3d](https://github.com/elalish/manifold) 3.2.1 (Apache-2.0) builds the printable geometry of joint parts (holes, pockets and bosses). It loads only when a printable part is built, and its WebAssembly file ships with the app, so nothing is fetched from the network.

## License

[MIT](LICENSE)
