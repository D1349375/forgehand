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
- **Zoom with two hands**: while one hand turns the view, pinch with the other and move the hands apart to zoom in or together to zoom out. Let go with the second hand and the first keeps turning the view from where it is.
- **Fist**: make a fist over an object to hold the whole object (a filled square shows at your palm), move it and open your hand; 復原 puts it back in one step. While you hold it, pinch with the other hand and move it away from the fist to pull the object apart (exploded view), or toward the fist to close it again. A fist also works while the exploded view is open.
- **A second hand** cannot start anything while the first hand is pinching; its pinch is shown as inactive until you open it.
- **View-only and off**: while the exploded view is open or the agent is running, a pinch only turns the view, and the status line under the camera says so. While the arm try-on (護臂試戴) runs, or when the tracker is too slow for gestures (under 10 frames per second), hand control is off and the mouse works as usual. The skeletons stay visible in both cases.
- **If tracking is lost** for more than about a third of a second during a drag, the part goes back to where it was and the status line says so.
- **隱藏鏡頭畫面** hides the camera image and keeps tracking and the skeletons running, for a plain backdrop. Turning the camera off and on shows the image again.
- Turn 手勢 off to use the mouse only. Everything above is local; no video or landmark leaves the browser.

Add `?hands=debug` to the address to show tracking numbers (delegate, frames per second, recognition time, pinch distance in mm) and gesture counters (drags, commits, cancels, losses). `?hands-min-fps=<number>` changes the speed threshold for slow machines (0 switches the speed check off).

## Assembly joints

Objects in the workspace can be joined, so a design says how its parts are fixed together and what to buy and print.

- **Four fixing methods** suit printed prototypes: screws with heat-set inserts (M2 or M3), disc magnets, dowel pins (press fit on both sides, or press on one side and sliding on the other) and glue (CA, two-part epoxy, or solvent for ABS). Sizes come from published standards and datasheets (ISO 4762 screws, ISO 273 clearance holes, ISO 8734 pins, CNC Kitchen inserts), listed with their sources in `shared/standard-parts.ts`.
- **Join with the mouse**: press 新增接合, click a part of one object, then a part of another. The faces that face each other are aligned and the cue 可以接合 shows. 換一組面 steps through the other facing faces, 確認接合 creates the joint (one undo step) and opens its card, and 取消接合 or Esc puts everything back. Joined objects form an assembly and move together, whether you move one in the 物件 panel or with the agent.
- **The joint card** lists the recommendation with its reasons. Set 負重 (load) and 拆裝 (how often it is taken apart) and the method follows, until you choose a method yourself (確認方式). The card shows the derived parts (screw length, insert and hole sizes), the checks (for example 已分開, with 重新對齊 to bring the faces back together) and 預覽「…」列印件, which builds the printable part with its holes, pockets and bosses cut. Nothing is stored in a joint except your choices: holes and lengths follow the part dimensions and the printer profile.
- **Materials**: each object has a 材料 (PLA, PETG, ABS, TPU, nylon, resin, aluminium or steel). It decides which glue and which method the recommendation prefers. A part marked as an internal component is treated as a bought part and never gets holes.
- **Printer profile**: 列印設定 holds the tolerances of your printer in millimetres (sliding and press fit per side, hole and depth compensation, extra clearance for PETG). The values are starting points. Print a tolerance test piece first, then adjust them; the holes, markers and checks follow at once. The profile is stored in your browser, not in the design.

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
