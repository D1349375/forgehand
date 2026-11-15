# Hand manipulation — Tasks

Implementation order is **1, 2, 3, 4, 5, 6, 7**: shared tracking and the 手勢 switch → input pipeline and the skeleton overlay → pure gestures → scene and App wiring (pinch-move, orbit) → ring, badge, status line, debug panel and the rest of the P0 checks → P1 rotate mode → P1 double-pinch zoom. Tasks 1–5 are the P0 core; Tasks 6 and 7 are P1 and can be cut (see "Cut order" at the end). Requirement numbers refer to `requirements.md`; section numbers (§) refer to `design.md`. Each task is meant for one fresh Kiro session that starts without memory, so each one lists what to read first and repeats the session facts.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

---

## Task 1 — Shared hand tracking and the 手勢 switch

`[x]`

Hand tracking runs whenever the camera is on, through one worker that try-on and hand control share, and a 手勢 button turns hand control off. Nothing is drawn yet. This task also builds the test tools every later task uses: a synthetic hand and a scripted fake worker for e2e.

**Read first:** `src/try-on/useArmTracking.ts`, `src/try-on/arm.worker.ts`, `src/try-on/arm-pose.ts` (`ArmWorkerFrame`, `LandmarkFrame`, `HandLandmarks`, `ArmTracker`); in `src/App.tsx`: `camera`, `startCamera`, `stopCamera`, `toggleTryOn`, `tryOnActive`, the `useArmTracking` call, the `.stage-toolbar` markup and the try-on status line; `tests/e2e/arm-try-on.spec.ts` (the worker route pattern and its fake); `tests/e2e/workbench.spec.ts` and `tests/e2e/visual-backgrounds.spec.ts` (where they open the camera); `.kiro/steering/structure.md`; the privacy section of `README.md`; design §1, §2, §3, §11.1, §11.3; requirements 1–11, 44, 50, 51, 53, 54, 63, 66.

**Build:**
- `src/try-on/arm-pose.ts`: `ArmWorkerFrame` gains `pose?: boolean` (design §3.1).
- `src/try-on/arm.worker.ts`: run pose only when `pose !== false` and `POSE_INTERVAL_MS` has passed; with `pose === false` send `body: []` and reset `lastPose`. Model loading and warm-up stay exactly as they are.
- `src/hands/tracking-plan.ts` (pure): `trackingPlan({ running, needed, started })` → `{ worker: 'start' | 'keep' | 'stop' | 'none', sendFrames }` and a `RateWindow` class (`add(now)`, returns the frames-per-second of each completed 1 s window) (design §3.2).
- `src/hands/useHandTracking.ts` (design §3.2): move the worker lifecycle, capture loop, load timeout and per-frame watchdog out of `useArmTracking` with their logic unchanged. Create the worker with `new URL('../try-on/arm.worker.ts', import.meta.url)` so the dev URL and the build asset name (`arm.worker-*.js`) still match the route in `arm-try-on.spec.ts`. Follow `trackingPlan`: start on first need, keep the worker while the camera stays on, send no frames while not needed, terminate when the camera turns off and on unmount. Put `pose: wantPose` (read from a ref) into each frame. Expose `HandSource` (`latest`, `subscribe`, `onTick`, `rate`, `delegate`) and `status: TrackerStatus`; listeners run synchronously in `onmessage`, and the hook calls `setState` only for status changes. `onRate(fps, now)` is called once a second.
- `src/try-on/useArmTracking.ts` (design §3.3): becomes `useArmTracking(source, trackerStatus, enabled)` with the same return shape, `ArmTrackingStatus` values, `validUntil` rule and once-a-second stats as today.
- `src/App.tsx` (design §3.4): `handsOn` state (default `true`, reset to `true` in `stopCamera` and when the camera fails to start); `useHandTracking(videoRef, { running: camera === 'on', needed: handsOn || tryOnActive, wantPose: tryOnActive, mirrored })`; `useArmTracking(tracking.source, tracking.status, tryOnActive)`; the 手勢 button in the first `.stage-toolbar` button group after 護臂試戴, only while `camera === 'on'`, `type="button"`, `aria-pressed={handsOn}`, the `active` class when on. No other App change.
- `tests/fixtures/synthetic-hand.ts` (design §11.1): `syntheticHand({ cursor, pinchM, size?, side?, world? })` and `clientToNormalized(point, view, video)` (the inverse of the cover mapping, for the e2e helper).
- `tests/e2e/fake-hands.ts` (design §11.3): `installFakeHands(context, { delegate?, replyDelayMs? })`, `showHand(page, clientPoint, pinchM)`, `hideHand(page)`, `fakeHandsLog(page)`. The fake worker uses the same route pattern as `arm-try-on.spec.ts`, a `BroadcastChannel('forgehand-fake-hands')`, closes every bitmap, and ignores fields it does not know.
- `tests/e2e/workbench.spec.ts` and `tests/e2e/visual-backgrounds.spec.ts`: add `await installFakeHands(context)` where they open the camera (or in a `beforeEach`). No other change to these files. Do not touch `arm-try-on.spec.ts` or `live-cli.spec.ts`.
- `README.md` privacy section: one sentence that turning the camera on downloads the MediaPipe hand and pose model files from Google's public model storage (video and landmarks stay in the browser).
- `.kiro/steering/structure.md`: a `src/hands/` line ("hand tracking source, gesture logic (pure) and hand-control wiring"); mention `tests/fixtures/`.

**Tests:**
- `tests/unit/hand-tracking.test.ts`: every `trackingPlan` case (not running → none/stop; running and needed for the first time → start; running, started, not needed → keep without frames; camera off → stop); `RateWindow` over synthetic timestamps; `syntheticHand` puts the midpoint of landmarks 4 and 8 on the cursor, gives the requested world distance between 4 and 8, and drops `world` with `world: false`; `clientToNormalized` round trip on a view wider and a view taller than the video.
- New `tests/e2e/hand-control.spec.ts`, Task 1 cases (design §11.3): camera on with try-on off → the fake receives frames with `pose: false`; 手勢 off → the frame count stops growing; try-on with 手勢 off → `try-on-status` reaches `tracking` and frames carry `pose: true`; toggling try-on on and off does not post a second `ready`; camera off and on again → 手勢 is pressed again.
- E2E while developing: `arm-try-on.spec.ts` (unchanged, must pass), `workbench.spec.ts`, `visual-backgrounds.spec.ts`, `hand-control.spec.ts`. At the end: the full suite.

**Dependencies:** none.

**Done when:** `npm run check` passes; `arm-try-on.spec.ts` passes without any change to it (`git diff --stat tests/e2e/arm-try-on.spec.ts` is empty); the only changes to `workbench.spec.ts` and `visual-backgrounds.spec.ts` are the helper import and calls; the full e2e suite passes.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task1.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): share hand tracking while the camera is on (spec hand-manipulation, task 1)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 2 — Input pipeline and the skeleton overlay

`[ ]`

The pure input code (mapping, cursor filter, pinch state machine, picking and settling) and a hand skeleton drawn over the camera view. No gesture acts yet.

**Read first:** `src/hands/useHandTracking.ts` and `src/hands/tracking-plan.ts` (Task 1); `src/try-on/arm-pose.ts` (`coverFrameBounds`, landmark types); `src/try-on/useArmTracking.ts` (how frames are flipped before tracking); in `src/App.tsx`: the `.viewport` markup and the `SceneViewport` element; `src/scene/style.ts` (`HOLOGRAM`, `SELECTION` colours); `tests/fixtures/synthetic-hand.ts` and `tests/e2e/fake-hands.ts` (Task 1); design §4, §8.1, §8.2, §11.2, §11.3; requirements 9, 12–15, 17–23, 47–49, 52, 64.

**Build:**
- `src/hands/constants.ts`: every P0 constant of design §4.1 with its default, exported by name (`ROTATE_DEG_PER_PX`, `DOUBLE_TAP_MS`, `DOUBLE_TAP_PX` come with Tasks 6 and 7).
- `src/hands/types.ts` (design §4.2): `Point`, `HandMode`, `HandSample`, `Target`, `ScreenTarget`, `HandState`, and `targetKey(target)`.
- `src/hands/mapping.ts` (design §4.3): `landmarkToClient`, `handSample` (both `CURSOR_POINT` options; `pinchM` from world landmarks 4 and 8, `null` without them; `null` for a hand with fewer than 21 finite points). No mirror branch.
- `src/hands/one-euro.ts` (design §4.4): `OneEuroFilter2D` with `filter(point, timeMs)` and `reset()`.
- `src/hands/pinch.ts` (design §4.5): `PinchState`, `initialPinchState()`, `pinchStep(state, input, now)` with the events `found`, `lost`, `engage`, `drag-start`, `release` (no double tap yet).
- `src/hands/targets.ts` (design §4.6): `pickTarget(point, screenTargets, scenePick)` (screen targets first, the last matching one wins) and `settleStep`.
- `src/hands/style.ts` (design §8.1): `MODE_COLOURS`, `LOCKED_COLOUR`, `overlayStyle({ state, mode })` for every `HandState` (the `ring` field is used from Task 5).
- `src/hands/skeleton.ts`: `HAND_CONNECTIONS` (the 21 MediaPipe hand connections) and `drawHand(ctx, points, style)` with the dark outline.
- `src/hands/HandOverlay.tsx` (design §8.2): the overlay canvas with an imperative handle `draw({ state, mode, targetKey, points })` and `clear()`; backing store sized to the box × `devicePixelRatio` on resize; `data-testid="hand-overlay"`, `aria-hidden="true"`, `data-hand-state`, `data-hand-mode`, `data-hand-target` written only when they change.
- `src/hands/useHandControl.ts`, part 1: while enabled, subscribe to the source and `onTick`; per frame read the video rect, build a `HandSample` from `frame.hands[0]`, filter the cursor, and draw the skeleton as `tracked` (mode `translate`, target empty); clear and set `none` after `HAND_LOST_MS` without a hand (from `onTick`).
- `src/App.tsx`: render `<HandOverlay>` inside `.viewport`, after `SceneViewport`, while `camera === 'on' && handsOn`; call `useHandControl` with `enabled = camera === 'on' && handsOn`.
- `src/styles.css`: `.hand-overlay` (`position:absolute; inset:0; pointer-events:none`, above the scene canvas, not mirrored).

**Tests:**
- `tests/unit/hand-input.test.ts`, the Task 2 list of design §11.2: mapping for a wider and a taller view than the video and the round trip with `clientToNormalized`; `handSample` with both cursor points and without world landmarks; the One Euro cases; every `pinchStep` rule (thresholds, frame counts, between thresholds, one-frame spikes, `null` distance, dead zone tap versus drag, loss shorter and longer than `TRACKING_LOSS_MS` while engaged, `HAND_LOST_MS` while idle, `found` after `lost`); `pickTarget` prefers a screen target over the scene; `settleStep` timing, and the cursor drift while the fingers close keeps the target; `overlayStyle` gives the two mode colours, grey dashes for `locked`, and colours different from `#69eaff` and `#ffc53d`.
- `hand-control.spec.ts`, Task 2 cases: with the camera on and a fake hand, the overlay has `data-hand-state="tracked"` and `data-hand-mode="translate"`; after `hideHand` it returns to `none`; 手勢 off removes the overlay; camera off removes it.
- E2E at the end: the full suite.

**Dependencies:** Task 1.

**Done when:** `npm run check` passes, the tests above are green, and the full e2e suite passes. In the report, tell the reviewer that **the skeleton can now be checked on the user's real webcam**: `npm run dev`, 開啟攝影機, wait for the models to load (about 20–30 s the first time), raise a hand; the skeleton should lie on the hand and follow it without visible lag. For the tracking rate, turn on 護臂試戴 briefly and read the try-on stats line (每秒 … 幀 · 辨識 … ms). This lets the user test tracking speed and accuracy before the gesture tasks.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task2.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): add the input pipeline and skeleton overlay (spec hand-manipulation, task 2)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 3 — Gestures: gates, decision, controller and drag maths (pure)

`[ ]`

Every gesture rule as pure code with unit tests: what a pinch does, when hand control is off or view-only, how a drag maps to a part position and an orbit to a camera position, the badge and status texts, and the debug counters. Nothing is wired into the UI.

**Read first:** `src/hands/*` (Tasks 1–2), especially `pinch.ts`, `targets.ts`, `types.ts`, `constants.ts`, `style.ts`; `tests/fixtures/synthetic-hand.ts`; `src/scene/SceneViewport.tsx` (the gizmo's rounding in `dragging-changed`, OrbitControls setup); `shared/model.ts` (part position and rotation limits); design §5, §6.1, §6.2, §8.1, §11.2; requirements 16, 24–31, 33, 35, 37–43, 45, 48, 49.

**Build:**
- `src/hands/gate.ts` (design §5.1): `handGate({ tryOn, slow, agentActive, exploded })` with the priority try-on, slow (`off`), agent, exploded (`view-only`). The delegate is not an input (requirement 40). `SpeedState`, `initialSpeedState()`, `speedStep(state, fps, now)` with `MIN_CONTROL_FPS` and `SPEED_HOLD_MS` in both directions.
- `src/hands/decide.ts` (design §5.2): `decidePinch(target, { objectCount, gate })` as in the table.
- `src/hands/stats.ts` (design §5.4): `HandStats` and its update functions.
- `src/hands/controller.ts` (design §5.3): `HandPort`, `GrabSession`, `OrbitSession`, `HandView`, `HandController` with `setGate`, `setMode`, `setObjectCount`, `frame`, `tick`, `reset`, `stats`, `onCancelled`. It owns the `OneEuroFilter2D`, the `PinchState` and the `SettleState`. `HandView.state` follows design §8.1.
- `src/hands/text.ts` (design §5.5): `shortenName`, `badgeText`, `handStatus`, `debugLine`, with the string tables of requirements 16 and 43 (「太慢」 only for `slow`).
- `src/hands/style.ts`: complete `overlayStyle(view)` with the `ring` field (`hollow` for `hover`, `filled` for `grab` and `orbit`).
- `src/hands/drag.ts` (design §6.1, §6.2): `dragPosition` and `orbitOffset`, using Three.js math classes only.

**Tests:**
- `tests/unit/hand-controller.test.ts`, the Task 3 list of design §11.2. Drive the controller with `syntheticHand` sequences mapped through `handSample` (or `HandSample`s built directly) and a fake port that records every call and returns fake sessions.
- `tests/unit/hand-drag.test.ts`, the Task 3 list of design §11.2, including: no jump at offset 0; a child part under a rotated parent and a rotated object root lands where expected (transform back to world and compare); halving the camera distance halves the move per pixel (requirement 31); rounding to 5 decimals and the ±100 clamp; `orbitOffset` keeps the distance and clamps the polar angle.
- No e2e changes; this task does not touch the browser.

**Dependencies:** Task 2.

**Done when:** `npm run check` passes and the tests above are green.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file, give it a timeout of at least 15 minutes, and read the file when it finishes. This task does not touch the browser; no e2e run is needed.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): add the gesture controller and drag maths (spec hand-manipulation, task 3)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 4 — Wiring: pinch-move and orbit in the scene

`[ ]`

The controller drives the real scene: a pinch on a part grabs it and a drag moves it through the gizmo's commit path; a pinch on empty space turns the view. The overlay shows the hand state in its line style and data attributes; the cursor ring and the badge come in Task 5.

**Read first:** `src/scene/SceneViewport.tsx` (all of it: `pointerUp` picking, the gizmo's `dragging-changed`, `fit`, `zoom`, the keyboard handler, `sync`, `ensureExplosion`, `applyExplosionShown`, `syncSelection`); `src/scene/scene-sync.ts` (`planSceneSync`); in `src/App.tsx`: `pick`, `onTransform`, `updatePart`, `adjust`, `agentActive`, `explode`, `setExplodeAmount`, the `window.__forgehandScene` hook; `src/hands/*` (Tasks 1–3); `tests/e2e/edit-select.spec.ts` (`projectPart` usage); `shared/demo.ts` (外殼 `housing` and its children); design §5.3, §6, §7, §8.3, §11.3; requirements 15, 17, 18, 22, 24–36, 39–41, 52, 53, 55, 64.

**Build:**
- `src/scene/hand-sessions.ts` (design §7.2, §7.3): `createGrabSession` (stored position and rotation from the model; `preview` with `dragPosition` from the node's live `parent.matrixWorld`; `commit` once and only when the rounded value differs; `cancel` restores), `createOrbitSession`, and the pure `grabStillValid(plan, nextActiveId, objectId)`.
- `src/scene/SceneViewport.tsx` (design §7.1–§7.3):
  - one `hitsAt(point)` helper shared by the click handler and `hitTest`; the surface list is rebuilt in `sync`, not per call;
  - `hitTest`, `beginPartGrab`, `beginOrbit` on the handle;
  - mouse-busy tracking (OrbitControls `start`/`end`, `gizmo.dragging`); `beginPartGrab` refuses while busy or while the exploded view is shown or animating;
  - `ensureExplosion(entry)` before a grab on a non-active object;
  - `gizmo.enabled = false` while a grab session runs;
  - in `sync`, invalidate a live session with `grabStillValid`; after `sync` and `applyExplosionShown`, a valid session re-applies its last preview;
  - `onTransform` gains `kind: 'translate' | 'rotate'`; the gizmo passes its mode.
- `src/hands/screen-targets.ts`: a `ScreenTargets` registry (`set`, `delete`, `rects()`, `press(id)`), empty in this task.
- `src/hands/useHandControl.ts`, part 2 (design §8.3): own a `HandController`; implement `HandPort` with `sceneRef.current` (`hitTest` → `Target`, `beginPartGrab`, `beginOrbit`), `screenTargets`, and `onPick`; push `gate`, `mode` (`'translate'`) and `objectCount` into it; call `tick` from `onTick`; `reset()` on `visibilitychange` to hidden, on disable and on unmount; draw each `HandView` with the line style of its state and write `data-hand-state` and `data-hand-target`. No ring, no badge.
- `src/App.tsx` (design §7.4, §8.3): `onTransform(objectId, id, position, rotation, kind)` with the active-object check and the notice by `kind`; `slow` state from `speedStep` fed by `onRate`; `gate = handGate({ tryOn: tryOnActive, slow, agentActive, exploded: explode > 0 })`; `onPick = (objectId, partId) => pick(objectId, partId, false)`.

**Tests:**
- `tests/unit/hand-sessions.test.ts`: on a small Three.js node tree (object root rotated, parent part rotated, child part) a grab session's `preview` moves only the grabbed node and the child follows in world space; `commit` calls the callback once with the position rounded to 5 decimals and the stored rotation; a commit at the start position calls nothing; `cancel` restores the stored position; `grabStillValid` for an empty plan with the same active id (valid), a plan that rebuilds or moves anything (invalid), and another active id (invalid).
- `hand-control.spec.ts`, Task 4 cases (design §11.3): pinch-drag-release on a part with children (the demo's 外殼; use `window.__forgehandScene.hitTest` to find a client point that hits it) changes only that part's position in `data-model-json`, `projectPart` of a child moves with it, `data-object-json` is unchanged, and one 復原 restores it; a pinch on a part of a second, inactive object (load the demo twice) makes it active, selects that part and moves it; a tap selects without enabling 復原; a pinch on empty space changes `data-camera-position` and nothing else; with 手勢 off a pinch does nothing and a mouse click still selects.
- E2E while developing: `hand-control.spec.ts`, `edit-select.spec.ts` (gizmo and picking), `explode.spec.ts`. At the end: the full suite.

**Dependencies:** Task 3.

**Done when:** `npm run check` passes, the tests above are green, and the full e2e suite passes with no change to existing specs.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task4.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): move parts and turn the view by pinching (spec hand-manipulation, task 4)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 5 — Ring, badge, status line, debug panel and the P0 checks

`[ ]`

Finish the P0 core: the cursor ring and the zh-TW badge on the overlay, the hand status line with its notices, the `?hands=debug` panel, the README section, the remaining P0 e2e cases, and the manual webcam list for the user.

**Read first:** `src/hands/*` (Tasks 1–4), especially `text.ts`, `style.ts`, `skeleton.ts`, `HandOverlay.tsx`, `useHandControl.ts`, `controller.ts` (`onCancelled`); in `src/App.tsx`: the try-on status line and its stats (the pattern to follow); `README.md`; `tests/e2e/agent-panel.spec.ts` (how `/api/agent` is routed); design §5.5, §8.1–§8.4, §11.3, §12; requirements 9, 15–17, 37, 40, 41, 43, 45, 46, 52, 54, 70, 72; the "Manual webcam check" below.

**Build:**
- `src/hands/skeleton.ts`: `drawRing(ctx, cursor, style)` and `drawBadge(ctx, cursor, text, canvasSize)`, with a pure `badgeBox(cursor, textWidth, canvasSize)` that places the badge 16 px right of and above the cursor and keeps it inside the canvas.
- `HandOverlay.draw` and `useHandControl`: draw the ring for `hover`, `grab` and `orbit`, and the badge with `badgeText(view)` (design §8.2).
- `src/hands/useHandControl.ts`: return `status` from `handStatus` (recomputed only when the tracker status, the gate, a loss cancel or the first hand changes; the cancel notice clears after `CANCEL_NOTICE_MS`) and `stats`.
- `src/App.tsx`: the hand status line under `.stage-toolbar` (design §8.4), only while the camera and 手勢 are on and the state is not `hidden`, `warning` style for `error`, `slow` and `cancelled`; render `HandDebugPanel` when `?hands=debug`.
- `src/hands/HandDebugPanel.tsx` (design §8.4): `debugLine(stats, …)` every 500 ms, including the delegate.
- `src/styles.css`: `.hand-status`, `.hand-debug` only if the existing `notice` and `small-muted` classes are not enough.
- `README.md`: a short "Hand control" section in English (requirement 70): turn the camera on; the 手勢 switch; pinch a part to grab and move it; pinch empty space to turn the view; zoom in for finer moves; the view-only and off states; `?hands=debug`.
- Check the "Manual webcam check" list below against what was built, correct it if anything differs, and hand it to the user in the report.

**Tests:**
- `tests/unit/hand-controller.test.ts` (extend): `badgeBox` near each canvas edge; `handStatus` clears the cancel notice after `CANCEL_NOTICE_MS`.
- `hand-control.spec.ts`, Task 5 cases (design §11.3): a hand lost mid-drag for longer than `TRACKING_LOSS_MS` puts the part back and shows 手部追蹤中斷，已取消這次移動。; the exploded view makes a pinch on a part turn the view (`data-camera-position` changes, `data-model-json` unchanged) with the 爆炸圖 notice; an active agent run (an `/api/agent` route held open until the test releases it) does the same with the 代理 notice; `installFakeHands(context, { replyDelayMs: 150 })` shows the 「太慢」 line and `data-hand-state="locked"` after `SPEED_HOLD_MS`; `installFakeHands(context, { delegate: 'CPU' })` with no delay keeps hand control on (a pinch-drag still moves a part); the 「把手舉到鏡頭前…」 hint shows before the first hand; `?hands=debug` shows `hand-debug` with the delegate; no gesture in this file requests `/api/generate`, `/api/edit` or `/api/agent` (except the held agent run, which the test starts with the agent panel).
- E2E at the end: the full suite.

**Dependencies:** Task 4.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and the report contains the manual webcam list for the user, with any corrections made.

### Manual webcam check (user's laptop)

Run `npm run dev`, open the app, and use `?hands=debug` in the URL. Note the numbers asked for; they decide which constants in `src/hands/constants.ts` to change.

1. **Start-up.** 開啟攝影機. The status line shows the loading text, then the 「把手舉到鏡頭前…」 hint. Note how long loading takes.
2. **Rate.** In the debug line, note the delegate, frames per second and recognition ms. Below 10 frames per second for 2 s, hand control locks with the 「太慢」 line (expected; report it).
3. **Skeleton.** Raise a hand in normal light. The skeleton lies on the hand, in the 移動 colour, with the badge 手勢：移動. Move the hand quickly and slowly: note any lag or jitter of the cursor ring.
4. **Hover.** Hold the hand still over 外殼 of the demo. The hollow ring and 手勢：移動 · 對準 外殼 appear after a short moment and do not flicker between parts.
5. **Pinch-move.** Pinch, move a few centimetres, open the fingers. The part moves with the hand, its children follow, and one 復原 restores it. Note false pinches (a grab you did not mean) and missed pinches; the debug line shows the pinch distance in mm.
6. **Precision.** Zoom in with the mouse wheel and repeat step 5: the same hand movement now gives a smaller move.
7. **Tap.** Pinch and release without moving on another part: it becomes selected, and 復原 does not gain a step.
8. **Orbit.** Pinch on empty space and move: the view turns; open the fingers: it stays.
9. **Tracking loss.** Pinch-drag a part, then pull the hand out of the frame quickly. The part goes back and the cancel notice shows. Note how often drags are cancelled in normal use (debug: 拖曳中遺失, 取消). If short, unintended losses cancel many drags, consider `ON_TRACKING_LOSS = 'keep'` or a longer `TRACKING_LOSS_MS`.
10. **Dim light.** Repeat steps 3–5 in dim light. Note what gets worse.
11. **View-only.** Open 爆炸圖: a pinch turns the view, never grabs, and the notice says so. Close it again.
12. **手勢 switch.** Turn 手勢 off: the skeleton and the status line disappear and the mouse works as usual; 護臂試戴 still works. Turn it on again.
13. **Report.** Which constants to change, and to what (pinch thresholds, `DRAG_GAIN`, `ORBIT_DEG_PER_PX`, cursor filter, `TRACKING_LOSS_MS` or `ON_TRACKING_LOSS`).

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task5.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): add the hand badge, status line and debug panel (spec hand-manipulation, task 5)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 6 — P1: rotate mode and the on-screen mode buttons

`[ ]`

A second hand mode, 旋轉, rotates the pinched part. The mode is switched by hand with two on-screen buttons in the camera view (which are also normal buttons for the mouse), or with the optional G and R keys. 重設視角's shortcut moves from R to Home.

**Read first:** `src/hands/*` (Tasks 1–5), especially `controller.ts` (`setMode`, `press`), `targets.ts`, `screen-targets.ts`, `drag.ts`, `style.ts`, `text.ts`; `src/scene/hand-sessions.ts` and the keyboard handler in `src/scene/SceneViewport.tsx`; in `src/App.tsx`: `stopCamera`, the window `keydown` handler, the `.viewport` markup; `src/styles.css` (`.stage-label` spans the top of the viewport); `tests/e2e/visual-backgrounds.spec.ts` (viewport screenshots); design §6.3, §9, §11.2, §11.3; requirements 11, 14, 22, 27, 55–59, 70, 72.

**Build:**
- `src/hands/constants.ts`: `ROTATE_DEG_PER_PX`.
- `src/hands/drag.ts` (design §6.3): `rotateEuler`.
- `src/scene/hand-sessions.ts`: the `rotate` kind (`preview` with `rotateEuler`; `commit` passes the new rotation and the stored position).
- `src/App.tsx` (design §9): `handMode` state, reset to `'translate'` in `stopCamera`, passed to `useHandControl`; a separate window `keydown` listener for G and R (camera and 手勢 on, no modifier, focus not in a text field), using a pure `handModeKey(event)` helper in `src/hands/keys.ts`.
- `src/hands/HandModeButtons.tsx` (design §9): two real buttons 手勢移動 and 手勢旋轉 with `aria-pressed`, at least 88 × 48 CSS pixels, in a `.hand-modes` group at the top-right of `.viewport`, below the stage label, shown while the camera and 手勢 are on. Each registers with `ScreenTargets` through a ref callback (ids `mode-translate`, `mode-rotate`) so a pinch tap presses it.
- `src/scene/SceneViewport.tsx`: the canvas key handler resets the view on `Home` instead of `r`.
- `README.md`: one line on rotate mode, the on-screen buttons and G/R; Home for 重設視角.
- Add these lines to the "Manual webcam check" in Task 5, before "Report": **Mode buttons by hand.** Hover 手勢旋轉 (ring and 手勢：移動 · 對準 手勢旋轉), pinch-tap it: the skeleton turns to the 旋轉 colour. **Rotate.** Pinch-drag a part sideways and up and down; it turns about its own centre; one 復原 restores it. **Keys.** G and R switch the mode; Home on the canvas resets the view.

**Tests:**
- `tests/unit/hand-drag.test.ts` (extend): `rotateEuler` turns about world Y for a horizontal offset even under a rotated parent; the result stays within ±180°; rounding to 2 decimals.
- `tests/unit/hand-sessions.test.ts` (extend): a rotate session commits the stored position unchanged.
- `tests/unit/hand-controller.test.ts` (extend): a tap on a screen target calls `press`, a drag that starts on it does not, pressing works when view-only and not when off; `setMode` during a drag applies to the next grab; `handModeKey` ignores text fields and modifiers; the 旋轉 badge texts.
- `hand-control.spec.ts`, the cases of requirement 59.
- E2E at the end: the full suite. If `visual-backgrounds.spec.ts` fails because of the new buttons, stop and report instead of editing it.

**Dependencies:** Task 5.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and the manual list has the new lines.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task6.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): add rotate mode and on-screen mode buttons (spec hand-manipulation, task 6)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 7 — P1: double-pinch zoom

`[ ]`

Two quick taps on a part frame that part; two quick taps on empty space frame all objects. Display only.

**Read first:** `src/hands/pinch.ts`, `controller.ts`, `constants.ts`, `drag.ts`, `useHandControl.ts`; `src/scene/SceneViewport.tsx` (`fit`, `projectPart`, `zoom`, `viewChanged`); `tests/e2e/workbench.spec.ts` (how 重設視角 framing is checked); design §6.4, §10, §11.2, §11.3; requirements 21, 60–62, 70, 72.

**Build:**
- `src/hands/constants.ts`: `DOUBLE_TAP_MS`, `DOUBLE_TAP_PX`.
- `src/hands/pinch.ts`: `lastTap` and the `double-tap` event (design §10). Single taps still act at once.
- `src/hands/controller.ts`: on `double-tap`, unless the gate is `off`, call `port.frame(target)` for a part or empty space; nothing more for a screen target.
- `src/hands/drag.ts` (design §6.4): `frameBox`.
- `src/scene/SceneViewport.tsx`: `frameTarget(objectId?, partId?)` on the handle (a part: its surface box through `frameBox`; no arguments: `fit()`); sets `viewChanged`; damping off for that one update as `fit()` does.
- `src/hands/useHandControl.ts`: implement `port.frame`.
- `README.md`: one line on double-pinch zoom.
- Add these lines to the "Manual webcam check" in Task 5, before "Report": **Double-pinch.** Two quick pinch-taps on a small part: the view zooms to it; two on empty space: the view frames everything again. Note whether ordinary taps are taken for double taps.

**Tests:**
- `tests/unit/hand-input.test.ts` (extend): a double tap within `DOUBLE_TAP_MS` and `DOUBLE_TAP_PX`; not when too slow or too far; the first tap still emits `release` with `tap: true`; three taps give one double tap.
- `tests/unit/hand-controller.test.ts` (extend): `frame` is called for a part and for empty space, in `full` and `view-only`, never when `off`.
- `tests/unit/hand-drag.test.ts` (extend): `frameBox` centres the box, keeps the viewing direction, and lowers `minDistance` for a small box.
- `hand-control.spec.ts`, the cases of requirement 61.
- E2E at the end: the full suite.

**Dependencies:** Task 5 (Task 6 is not required).

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and the manual list has the new lines.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"`. Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task7.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): frame a part by double-pinching (spec hand-manipulation, task 7)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Cut order

If time runs short, drop whole tasks in this order. The P0 core (Tasks 1–5: the overlay, the 手勢 switch, pinch-move and orbit) always stays.

1. **Task 7, double-pinch zoom.** Requirements 60–62 and the double-tap event in requirement 21 are dropped; zooming stays with the mouse wheel and the zoom buttons, which also give finer hand moves (requirement 31).
2. **Task 6, rotate mode.** Requirements 56–59 are dropped: the hand only moves parts, no mode buttons or G/R keys are added, and 重設視角 keeps its R shortcut. The mouse gizmo still rotates parts.

Dropping a task removes its README and manual-list lines; say so in the last report.
