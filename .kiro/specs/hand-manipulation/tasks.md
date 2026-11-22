# Hand manipulation — Tasks

Implementation order is **1 → 9**, then Task 10, which was added on 2026-11-22 after the first test on the user's laptop (release timing and pinch thresholds). The join with two pinches and the fist-knob rotate of the same decision are a later Task 11 that is not written yet. Tasks 1 and 2 are done; they were written and built for the 2026-11-15 version of the spec and are kept as written. Tasks 3–5 finish the P0 core: both hands and the hidden camera image → the pure two-hand gesture core → scene and App wiring with the rest of the feedback and checks. Tasks 6–9 are P1, in this order: two-hand zoom, fist, two-hand rotate, agent switch for the camera image. They are cut from the end (see "Cut order"). Requirement numbers refer to `requirements.md` (stable ids: 73 and above were added on 2026-11-19, 56–62 were removed); section numbers (§) refer to `design.md`. Where the text of Tasks 1–2 names a requirement or a design section that has changed since, the current version applies to the later tasks. Design §15 lists every change that later tasks make to the code of Tasks 1–2. Each task is meant for one fresh Kiro session that starts without memory, so each one lists what to read first and repeats the session facts.

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
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
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

`[x]`

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
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task2.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): add the input pipeline and skeleton overlay (spec hand-manipulation, task 2)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 3 — Both hands, the hidden camera image and the status line

`[x]`

The worker tracks two hands and both skeletons are drawn; a 隱藏鏡頭畫面 button hides the camera image while tracking continues; the hand-control gates, the hand status line and the `?hands=debug` panel (tracking numbers) appear. No gesture acts yet. This task changes code from Tasks 1–2 (design §15).

**Read first:** `src/hands/*` (Tasks 1–2), especially `types.ts`, `mapping.ts`, `style.ts`, `HandOverlay.tsx`, `useHandControl.ts`, `useHandTracking.ts`, `tracking-plan.ts`, `constants.ts`; `src/try-on/arm.worker.ts` (`numHands`); in `src/App.tsx`: `camera`, `startCamera`, `stopCamera`, the `<video>` element and its classes, the `.stage-toolbar` markup, the 手勢 button, the try-on status line and stats, `agentActive`, `explode`, the `useHandTracking` and `useHandControl` calls; `src/styles.css` (`.viewport`, `.camera-video`, `.camera-video.visible`, `.hand-overlay`); `tests/e2e/fake-hands.ts`, `tests/fixtures/synthetic-hand.ts`, `tests/e2e/hand-control.spec.ts`; `tests/e2e/arm-try-on.spec.ts` (it selects 關閉攝影機 and 即時攝影機背景 without `exact`); `tests/unit/hand-input.test.ts` (the overlay style test); design §3.1, §3.2, §3.5, §4.1–§4.3, §4.7, §5.1, §5.7, §8.1–§8.4, §11, §15; requirements 12–15, 18, 40, 41, 43–45, 47, 52, 53, 73–78.

**Build:**
- `src/hands/constants.ts`: `TRACKED_HANDS = 2` and `DUPLICATE_HAND_PX = 40` (design §4.1); remove the header comment's mention of `ROTATE_DEG_PER_PX`, `DOUBLE_TAP_MS` and `DOUBLE_TAP_PX`.
- `src/try-on/arm.worker.ts`: `numHands: TRACKED_HANDS` (imported from `../hands/constants`). Nothing else changes in the worker.
- `src/hands/tracking-plan.ts`: `frameClockStep` (design §3.2). `src/hands/useHandTracking.ts`: while the worker is ready, an interval of `VIDEO_FRAME_STALL_MS` (500, a local constant) asks `frameClockStep` and, on a switch, moves the capture loop from `requestVideoFrameCallback` to `requestAnimationFrame` for the rest of the camera session; the interval is cleared in `stop()`.
- `src/hands/types.ts` (design §4.2): remove `HandMode`; add `HandSlot`, `GestureKind` and `OverlayFrame`; reshape `HandView` (`slot`, `state`, `targetKey`, `points`, `cursor`, `palm`, `badge`); add `HandSample.palm`.
- `src/hands/mapping.ts`: `handSample` adds `palm` (the mean of client points 0, 5, 9, 13, 17).
- `src/hands/slots.ts`: `dedupeHands` (design §4.7). `assignHands` comes in Task 4.
- `src/hands/style.ts` (design §8.1): `HAND_COLOUR`, `LINK_COLOUR`, `LOCKED_COLOUR`; `overlayStyle({ state })` with a `mark` field (`none`, `ring-hollow`, `ring-filled`; the squares come with Task 7). No mode.
- `src/hands/gate.ts` (design §5.1): `Gate`, `handGate`, `SpeedState`, `initialSpeedState`, `speedStep`.
- `src/hands/text.ts` (design §5.7): `handStatus` with every state and text of requirement 43 (the `cancelled` state becomes reachable when Task 5 passes `cancelledAt`), and `trackingDebugLine`.
- `src/hands/HandOverlay.tsx` (design §8.2): `draw(frame: OverlayFrame)` draws the skeleton of every hand in the frame; the attributes `data-hand-count`, `data-hand-state` and `data-hand-target` (slot 0), `data-hand2-state` and `data-hand2-target` (slot 1), and `data-gesture` (`none` for now), each written only when it changes; `data-hand-mode` removed.
- `src/hands/useHandControl.ts` (design §8.3, T3 part): takes `tracker` and `gate`; per frame, `handSample` for every hand of `frame.hands`, `dedupeHands`, and draw them in frame order as `tracked`, or `locked` when the gate is not `full`; per tick, clear after `HAND_LOST_MS` without a hand; return the status from `handStatus` (React state only when it changes) and a `debug` ref with the tracking numbers.
- `src/hands/HandDebugPanel.tsx` (design §8.4): only with `?hands=debug`; every 500 ms it reads the debug ref and the source (`delegate`, `rate`, the latest frame's inference ms) and shows `trackingDebugLine`.
- `src/App.tsx`: `cameraHidden` state (default `false`, reset in `stopCamera` and on a failed start); the 隱藏鏡頭畫面 button after 手勢 while the camera is on (`type="button"`, `aria-pressed`, the `active` class, enabled during agent runs); the video's class and `data-image-hidden` (design §3.5); `slow` state from `speedStep` fed by `onRate`; `gate = handGate({ tryOn: tryOnActive, slow, agentActive, exploded: explode > 0 })`; the hand status line under `.stage-toolbar` (design §8.4); `HandDebugPanel` with `?hands=debug`.
- `src/styles.css`: `.hand-status` and `.hand-debug` only if the existing `notice` and `small-muted` classes are not enough. Hiding the video uses the existing `.camera-video` rule (opacity 0 without `visible`).
- `tests/e2e/fake-hands.ts` (design §11.3): `FakeHand` and `showHands(page, hands)`; the channel message `{ type: 'hands', hands }` (the fake worker still accepts `{ type: 'hand' }`); `showHand` and `hideHand` become wrappers.
- `tests/e2e/hand-control.spec.ts`: remove the `data-hand-mode` assertion from the T2 case; change nothing else in the T1 and T2 cases.

**Tests:**
- `tests/unit/hand-tracking.test.ts` (extend): `frameClockStep` (design §11.2).
- `tests/unit/hand-input.test.ts` (extend): `handSample.palm`; `dedupeHands`; the overlay style test now checks one hand colour for every state except `locked`, a link colour different from it, and both different from `#69eaff` and `#ffc53d`.
- New `tests/unit/hand-gate.test.ts`: `handGate` priority, `speedStep` in both directions with the hold, `handStatus` priority and texts, `trackingDebugLine`.
- `hand-control.spec.ts`, Task 3 cases (design §11.3): two hands; the hidden camera image (opacity 0, still playing, frames keep growing, skeleton still drawn, reset by camera off and on, try-on still tracks); the hint line; 手勢 off hides the status line; a slow fake gives 「太慢」 and `locked`; a CPU fake at a good rate gives no 「太慢」; `?hands=debug` shows the delegate and the hand count.
- While developing, probe once in a scratch test (do not keep it) whether a `requestVideoFrameCallback` registered on the hidden video fires in the headless shell, and report the answer.
- E2E while developing: `hand-control.spec.ts`, `arm-try-on.spec.ts` (unchanged, must pass), `workbench.spec.ts`, `visual-backgrounds.spec.ts`. At the end: the full suite.

**Dependencies:** Task 2.

**Done when:** `npm run check` passes, the tests above are green, `git diff --stat tests/e2e/arm-try-on.spec.ts` is empty, and the full e2e suite passes. In the report, tell the reviewer that **two hands and the hidden image can now be checked on the real webcam**: `npm run dev`, open `/?hands=debug`, 開啟攝影機, wait for the models; raise one hand and note the frames per second and recognition ms in the debug line; raise both hands and note them again; press 隱藏鏡頭畫面 and check that both skeletons still follow and the rate does not drop. If the rate with two hands stays below 10 frames per second, the user should hear about it before Task 4 starts (the fallback is `TRACKED_HANDS = 1`, design §3.1).

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task3.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): track both hands and hide the camera image (spec hand-manipulation, task 3)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 4 — Two-hand gesture core (pure)

`[x]`

Every gesture rule for one and two hands as pure code with unit tests: hand slots, what a pinch does, which hand owns a gesture and when the other hand may join, the pair geometry, the drag and orbit maths, the badge texts, the debug counters, and the drawing helpers for rings, badges and the line between the hands. Nothing is wired into the scene.

**Read first:** `src/hands/*` (Tasks 1–3), especially `types.ts`, `slots.ts`, `pinch.ts`, `targets.ts`, `gate.ts`, `text.ts`, `style.ts`, `skeleton.ts`, `constants.ts`; `tests/fixtures/synthetic-hand.ts`; `src/scene/SceneViewport.tsx` (the gizmo's rounding in `dragging-changed`, the OrbitControls setup and limits); `shared/model.ts` (part position and rotation limits); design §4.7, §5, §6.1, §6.2, §8.1, §8.2, §11.2; requirements 16, 21, 24–31, 33, 35, 37–42, 45, 48, 49, 78–86.

**Build:**
- `src/hands/constants.ts`: `HAND_MATCH_PX = 160`, `TWO_HAND_MIN_SPAN_PX = 60`.
- `src/hands/types.ts`: `HandState` gains `'join'`.
- `src/hands/slots.ts`: `assignHands` (design §4.7).
- `src/hands/decide.ts` (design §5.2): `decidePinch(target, { objectCount, gate })` as in the table.
- `src/hands/pair.ts` (design §5.3): `pairSpan`, `pairAngle`, `angleDelta`, `beyondDeadZone`.
- `src/hands/join.ts` (design §5.4): `OwnerGesture`, `JoinInput`, `TwoHandGesture`, `JoinRule`, and `joinGesture` with no rows (it returns `null` for every input).
- `src/hands/stats.ts` (design §5.6): `HandStats` and its update functions.
- `src/hands/controller.ts` (design §5.5): `HandPort` (`pick`, `select`, `beginGrab`, `beginOrbit`, `press`), `GrabSession` (`preview`, `rebase`, `commit`, `cancel`), `OrbitSession` (`preview`, `rebase`, `end`), and `HandController` with the constructor option `join`, `setGate`, `setObjectCount`, `frame(samples, now)`, `tick`, `reset`, `stats` and `onCancelled`. It owns two tracks (cursor and palm filters, pinch state, settle state), at most one session, and the inert slots, and handles the events exactly as design §5.5 lists them; it returns an `OverlayFrame` with each hand's state (design §8.1), `badge` from `badgeText`, `gesture`, and `link` while a joiner exists. The P1 members (`zoom`, `rotate`, holds, explode) are added by their tasks.
- `src/hands/text.ts` (design §5.7): `shortenName`, `badgeText` with the rows of requirement 16, `debugLine`.
- `src/hands/skeleton.ts` (design §8.2): `drawRing`, `drawBadge`, the pure `badgeBox(cursor, textWidth, canvasSize, avoid?)`, and `drawLink`.
- `src/hands/drag.ts` (design §6.1, §6.2): `dragPosition` and `orbitOffset`, using Three.js math classes only.

**Tests:**
- `tests/unit/hand-input.test.ts` (extend): `assignHands` (design §11.2).
- New `tests/unit/hand-controller.test.ts`, the Task 4 list of design §11.2, including every two-hand case: an inert second pinch, a free second hand when the first pinch decided `none`, both hands engaging in one frame, and, with a test join rule, joining, freezing, the joiner's span and angle, re-basing after the joiner leaves, the owner's release, a lost joiner and the frame's `link`. Drive the controller with `syntheticHand` sequences mapped through `handSample` (or `HandSample`s built directly) and a fake port that records every call and returns fake sessions.
- New `tests/unit/hand-drag.test.ts`, the Task 4 list of design §11.2.
- No e2e changes; this task does not touch the browser.

**Dependencies:** Task 3.

**Done when:** `npm run check` passes and the tests above are green.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file, give it a timeout of at least 15 minutes, and read the file when it finishes. This task does not touch the browser; no e2e run is needed.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): add the two-hand gesture controller and drag maths (spec hand-manipulation, task 4)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 5 — Wiring: pinch-move, orbit and the rest of the P0 core

`[x]`

The controller drives the real scene: one hand pinches a part to move it through the gizmo's commit path, or pinches empty space to turn the view; a second hand's pinch is inert. The overlay draws rings, badges and the line between the hands; the status line shows the cancel notice; the debug panel shows the gesture counters. README and the manual webcam list finish the P0 core.

**Read first:** `src/scene/SceneViewport.tsx` (all of it: `pointerUp` picking, the gizmo's `dragging-changed`, `fit`, `zoom`, the keyboard handler, `sync`, `ensureExplosion`, `applyExplosionShown`, `syncSelection`); `src/scene/scene-sync.ts` (`planSceneSync`); in `src/App.tsx`: `pick`, `onTransform`, `updatePart`, `agentActive`, `explode`, `setExplodeAmount`, the hand status line, the `window.__forgehandScene` hook; `src/hands/*` (Tasks 1–4); `tests/e2e/edit-select.spec.ts` (`projectPart` usage); `tests/e2e/agent-panel.spec.ts` (how `/api/agent` is routed); `shared/demo.ts` (外殼 `housing` and its children); `README.md`; design §5.5, §6, §7.1–§7.3, §7.5, §8, §11.3, §12; requirements 15–18, 22, 24–39, 41, 43, 45, 46, 52–55, 64, 70, 72, 81, 85; the "Manual webcam check" below.

**Build:**
- `src/scene/hand-sessions.ts` (design §7.2, §7.3): `createGrabSession` (stored position and rotation from the model; `preview` with `dragPosition` from the node's live `parent.matrixWorld`; `rebase`; `commit` once and only when the rounded value differs, with `kind: 'translate'`; `cancel` restores), `createOrbitSession` (`preview`, `rebase`, `end`), and the pure `grabStillValid(plan, nextActiveId, objectId)`.
- `src/scene/SceneViewport.tsx` (design §7.1–§7.3):
  - one `hitsAt(point)` helper shared by the click handler and `hitTest`; the surface list is rebuilt in `sync`, not per call;
  - `hitTest` (with `objectName`), `beginPartGrab`, `beginOrbit` on the handle;
  - mouse-busy tracking (OrbitControls `start`/`end`, `gizmo.dragging`); `beginPartGrab` refuses while busy or while the exploded view is shown or animating;
  - `ensureExplosion(entry)` before a grab on a non-active object;
  - `gizmo.enabled = false` while a grab session runs;
  - in `sync`, invalidate a live session with `grabStillValid`; after `sync` and `applyExplosionShown`, a valid session re-applies its last preview;
  - `onTransform` gains `kind: 'translate' | 'rotate'`; the gizmo passes its mode.
- `src/hands/useHandControl.ts`, T5 part (design §8.3): own a `HandController`; implement `HandPort` with `sceneRef.current` (`hitTest` → `Target`, `beginPartGrab`, `beginOrbit`), an empty screen-target list, and `onPick`; push `gate` and `objectCount` into it; call `tick` from `onTick`; `reset()` on `visibilitychange` to hidden, on disable and on unmount; `onCancelled('loss')` sets `cancelledAt` for the status line (cleared after `CANCEL_NOTICE_MS`); draw each `OverlayFrame`; the debug ref carries `stats`.
- `src/hands/HandOverlay.tsx`: draw the mark of each hand (`drawRing`), its badge (`badgeBox` with `avoid` for the second hand), and the link line when `frame.link` is set.
- `src/hands/HandDebugPanel.tsx`: `debugLine` with the gesture counters.
- `src/App.tsx` (design §7.5): `onTransform(objectId, id, position, rotation, kind)` with the active-object check and the notice by `kind`; `onPick = (objectId, partId) => pick(objectId, partId, false)`; pass `objectCount` and `sceneRef` to `useHandControl`.
- `README.md`: a short "Hand control" section in English (requirement 70): turn the camera on; the 手勢 switch; 隱藏鏡頭畫面; both hands are tracked, one hand is enough; pinch a part to grab and move it; pinch empty space to turn the view; zoom in for finer moves; the view-only and off states; `?hands=debug`.
- Check the "Manual webcam check" list below against what was built, correct it if anything differs, and hand it to the user in the report.

**Tests:**
- New `tests/unit/hand-sessions.test.ts` (design §11.2): on a small Three.js node tree (object root rotated, parent part rotated, child part) a grab session's `preview` moves only the grabbed node and the child follows in world space; `rebase`; `commit` calls the callback once with the position rounded to 5 decimals and the stored rotation; a commit at the start position calls nothing; `cancel` restores the stored position; `grabStillValid` for an empty plan with the same active id (valid), a plan that rebuilds or moves anything (invalid), and another active id (invalid).
- `tests/unit/hand-controller.test.ts` (extend): the cancel notice clears after `CANCEL_NOTICE_MS` in `handStatus`.
- `hand-control.spec.ts`, Task 5 cases (design §11.3).
- E2E while developing: `hand-control.spec.ts`, `edit-select.spec.ts` (gizmo and picking), `explode.spec.ts`. At the end: the full suite.

**Dependencies:** Task 4.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes with no change to existing specs other than `hand-control.spec.ts`, and the report contains the manual webcam list for the user, with any corrections made.

### Manual webcam check (user's laptop)

Run `npm run dev`, open the app with `?hands=debug` in the URL. Note the numbers asked for; they decide which constants in `src/hands/constants.ts` to change.

1. **Start-up.** 開啟攝影機. The status line shows the loading text, then the 「把手舉到鏡頭前…」 hint. Note how long loading takes.
2. **Rate, one and two hands.** With one hand in view, note the delegate, frames per second and recognition ms in the debug line. Raise both hands and note them again. Below 10 frames per second for 2 s, hand control locks with the 「太慢」 line (expected; report it, together with both numbers).
3. **Skeletons.** Raise one hand, then both, in normal light. Each skeleton lies on its hand, in the same colour, each with the badge 手勢：待命. Move the hands quickly and slowly: note any lag or jitter of the cursors.
4. **Hand identity.** Bring the hands close together, apart again, and cross them briefly. Note whether a duplicate skeleton appears on one hand, and whether the badges or rings jump from one hand to the other.
5. **Hidden camera image.** Press 隱藏鏡頭畫面: the camera image gives way to the plain backdrop, both skeletons still follow the hands, and the frames per second stay as in step 2. Turn the camera off and on: the image shows again.
6. **Hover.** Hold one hand still over 外殼 of the demo. The hollow ring and 手勢：對準 外殼 appear after a short moment and do not flicker between parts.
7. **Pinch-move.** Pinch, move a few centimetres, open the fingers. The part moves with the hand, its children follow, and one 復原 restores it. Note false pinches (a grab you did not mean) and missed pinches; the debug line shows the pinch distance in mm.
8. **Precision.** Zoom in with the mouse wheel and repeat step 7: the same hand movement now gives a smaller move.
9. **Tap.** Pinch and release without moving on another part: it becomes selected, and 復原 does not gain a step.
10. **Orbit.** Pinch on empty space and move: the view turns; open the fingers: it stays.
11. **Second hand.** While one hand moves a part, pinch with the other hand: nothing else happens, and the second hand shows grey dashes with 手勢：另一手操作中. Release both.
12. **Tracking loss.** Pinch-drag a part, then pull the hand out of the frame quickly. The part goes back and the cancel notice shows. Note how often drags are cancelled in normal use (debug: 拖曳中遺失, 取消). If short, unintended losses cancel many drags, consider `ON_TRACKING_LOSS = 'keep'` or a longer `TRACKING_LOSS_MS`.
13. **Dim light.** Repeat steps 3, 6 and 7 in dim light. Note what gets worse.
14. **View-only.** Open 爆炸圖: a pinch turns the view, never grabs, and the notice says so. Close it again.
15. **手勢 switch.** Turn 手勢 off: the skeletons and the status line disappear and the mouse works as usual; 護臂試戴 still works. Turn it on again.
16. **Two-hand zoom** (Task 6). Pinch empty space with one hand, then pinch with the other and move the hands apart: the view zooms in; together: it zooms out; the second hand shows 手勢：雙手縮放 and a line joins the hands. Let go with the second hand and move the first: the view turns from where it is, with no jump. Note whether small hand tremor zooms (then raise `ZOOM_DEAD_ZONE_PX`).
17. **Fist** (Task 7). Note the curl ratio in the debug line (曲度) for an open hand, a pinch and a fist. Make a fist over the demo object: a hollow square, then a filled one with 手勢：握住 …; move it: the whole object moves; open the hand; one 復原 restores it. Note false fists during pinches and missed fists (then change `FIST_ENGAGE_RATIO`, `FIST_RELEASE_RATIO` or `FIST_ENGAGE_MS` (was `FIST_ENGAGE_FRAMES` before Task 10), or set `FIST_ENABLED = false`).
18. **Pull apart** (Task 7). Hold the object with a fist and pinch with the other hand; move the pinch away: the object explodes; back: it closes. Repeat with 爆炸圖 already open: the fist still moves the object.
19. **Two-hand rotate** (Task 8). Pinch a part with one hand, then pinch with the other and move it around the first: the part turns the same way on screen, the second hand shows 手勢：雙手旋轉 …° and an arc. Let go with the second hand, move the first a little, let go: one 復原 restores both the turn and the move. Note whether the part turns when you did not mean it to (then raise `ROTATE_DEAD_ZONE_DEG`).
20. **Agent** (Task 9). With the camera on, ask the agent 「把鏡頭畫面藏起來」: the image hides, 隱藏鏡頭畫面 is pressed, and the skeletons keep following; ask it to show the image again.
21. **Release timing and thresholds** (Task 10). With `?hands=debug` the line shows the pinch engage and release thresholds (捏合門檻 40／55 mm) next to the measured pinch distance. Pinch, drag and release several times and note any overshoot on release: the part should stop where the fingers started to open, and the 復原 step should return it. Repeat the two-fist join (two objects, a fist on each, bring them together until 可以接合 shows, open one fist) and note whether it joins on release. Note any missed or false pinches with the new thresholds, and the distance in the debug line at each. Hold the fingers between 40 and 55 mm and note that the part freezes and does not release.
22. **Report.** Which constants to change, and to what (pinch thresholds and times, `DRAG_GAIN`, `ORBIT_DEG_PER_PX`, cursor filter, `TRACKING_LOSS_MS` or `ON_TRACKING_LOSS`, `DUPLICATE_HAND_PX`, `HAND_MATCH_PX`, `ZOOM_DEAD_ZONE_PX`, the fist ratios and times, `EXPLODE_DEAD_ZONE_PX`, `EXPLODE_FULL_FRACTION`, `ROTATE_DEAD_ZONE_DEG`, or `TRACKED_HANDS = 1` if two hands are too slow).

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task5.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): move parts and turn the view by pinching (spec hand-manipulation, task 5)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 6 — P1: two-hand zoom

`[x]`

While one hand turns the view, the other hand pinches and the change in distance between the two cursors zooms the view. Display only.

**Read first:** `src/hands/controller.ts`, `join.ts`, `pair.ts`, `drag.ts`, `text.ts`, `constants.ts`; `src/scene/hand-sessions.ts` (orbit sessions); `src/scene/SceneViewport.tsx` (`zoom`, `fit`, `controls.minDistance` and `maxDistance`, the render loop that writes `data-camera-position`); `tests/e2e/hand-control.spec.ts` and `tests/e2e/fake-hands.ts` (`showHands`); design §5.4, §5.5, §6.3, §7.3, §11; requirements 31, 82–88, 70, 72.

**Build:**
- `src/hands/constants.ts`: `ZOOM_DEAD_ZONE_PX = 12`.
- `src/hands/join.ts`: the row `orbit` + `pinch` → `zoom` when the gate is not `off`.
- `src/hands/drag.ts` (design §6.3): `zoomRatio`.
- `src/hands/controller.ts`: `OrbitSession.zoom(ratio)`; a `zoom` joiner calls it from `zoomRatio` on every joiner move; the badge row 手勢：雙手縮放 in `text.ts`; `gesture` `zoom`.
- `src/scene/hand-sessions.ts`: the orbit session's `zoom(ratio)` (design §7.3) with the OrbitControls distance limits; `rebase` after a zoom keeps the new distance.
- `src/scene/SceneViewport.tsx`: write `data-camera-target` next to `data-camera-position`.
- `README.md`: one line on two-hand zoom.
- Add these lines to the "Manual webcam check" in Task 5, before "Report": **Two-hand zoom.** Pinch empty space with one hand, then pinch with the other and move the hands apart: the view zooms in; together: it zooms out; the second hand shows 手勢：雙手縮放 and a line joins the hands. Let go with the second hand and move the first: the view turns from where it is, with no jump. Note whether small hand tremor zooms (then raise `ZOOM_DEAD_ZONE_PX`).

**Tests:**
- `tests/unit/hand-drag.test.ts` (extend): `zoomRatio` (spreading gives a ratio below 1, the dead zone, the minimum span).
- `tests/unit/hand-controller.test.ts` (extend), with the real `joinGesture`: orbit + pinch joins as `zoom`, works at `view-only`, is inert at `off`; the orbit preview holds still while zooming; the joiner's release re-bases the orbit; a grab + pinch stays inert.
- `tests/unit/hand-sessions.test.ts` (extend): `zoom` keeps the viewing direction and clamps to the distance limits.
- `hand-control.spec.ts`, the cases of requirement 88.
- E2E at the end: the full suite.

**Dependencies:** Task 5.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and the manual list has the new lines.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task6.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): zoom the view with both hands (spec hand-manipulation, task 6)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 7 — P1: fist to hold, move and explode an object

`[x]`

A fist on an object holds the whole object; moving the fist moves it, committed through the workspace's object transform on release. While the fist holds it, the other hand pinches and the change in distance to the fist sets the explode amount. Works in the exploded view.

**Read first:** `src/hands/*` (Tasks 1–6 as built), especially `controller.ts`, `join.ts`, `decide.ts`, `mapping.ts`, `pinch.ts`, `style.ts`, `skeleton.ts`, `text.ts`; `src/scene/hand-sessions.ts`; `src/scene/SceneViewport.tsx` (object roots, `placeRoot`, `entries`, the explode animation and `explodeShown`); in `src/App.tsx`: `moveObject`, `commitObjectChange`, `activateObject`, `setExplodeAmount`; `shared/workspace.ts` (`setTransform`, `ObjectTransformSchema`, `setActiveObject`); `tests/fixtures/synthetic-hand.ts`; `tests/e2e/fake-hands.ts`; `tests/e2e/explode.spec.ts`; design §4.2, §5.2, §6.4, §6.5, §7.4, §7.5, §8.1, §8.2, §9, §11; requirements 15, 18, 41, 43, 45, 47, 82, 89–95, 70, 72.

**Build:**
- `src/hands/constants.ts`: `FIST_ENABLED`, `FIST_ENGAGE_RATIO`, `FIST_RELEASE_RATIO`, `FIST_ENGAGE_FRAMES`, `FIST_RELEASE_FRAMES`, `EXPLODE_DEAD_ZONE_PX`, `EXPLODE_FULL_FRACTION` (design §4.1).
- `src/hands/fist.ts` (design §9.1): `curlRatio`, `FistState`, `fistStep`.
- `src/hands/types.ts`: states `fist` and `hold`; `HandSample.curl`. `src/hands/mapping.ts`: `handSample` fills `curl` with `curlRatio`.
- `src/hands/decide.ts`: `decideFist` (design §5.2).
- `src/hands/join.ts`: the row `hold` + `pinch` → `explode` (gate `full`, or `view-only` with reason `exploded`).
- `src/hands/drag.ts`: `explodeAmount` (design §6.5); the object move uses `dragPosition` (design §6.4).
- `src/hands/controller.ts` (design §9.2, §9.3): the constructor option `fistEnabled` (default `FIST_ENABLED`); a fist state per track; fist-like frames feed `pinchM: null`; a fist cancels an unmoved pinch of the same hand; hold sessions; the explode joiner; the port members `activate`, `beginHold`, `explodeAmount`, `setExplode`; `HoldSession`.
- `src/hands/style.ts` and `skeleton.ts`: `square-hollow` and `square-filled` marks and `drawSquare` at the palm centre.
- `src/hands/text.ts`: the badges 手勢：握拳, 手勢：握住 {object name} and 手勢：拉開 {n}%; the 爆炸圖 status line of requirement 94 when fists are enabled; curl ratio and fist state in the debug line.
- `src/scene/hand-sessions.ts`: `createHoldSession` (design §7.4). `src/scene/SceneViewport.tsx`: `beginObjectHold` (not refused in the exploded view; does not refuse because another hold runs) and the `onObjectMove(objectId, position)` prop.
- `src/hands/useHandControl.ts`: the new port members, from the inputs `onActivate`, `explodeAmount` and `setExplode`.
- `src/App.tsx` (design §7.5): `onObjectMove` → `moveObject(objectId, { position })`; `onActivate` → `activateObject`; `explodeAmount` reads `store.current().display.explode`; `setExplode` → `setExplodeAmount`.
- `tests/fixtures/synthetic-hand.ts`: the `fist` option (design §11.1). `tests/e2e/fake-hands.ts`: `FakeHand.fist`.
- `README.md`: one line on the fist (hold and move an object; pull apart with the other hand).
- Add these lines to the "Manual webcam check" in Task 5, before "Report": **Fist.** Note the curl ratio in the debug line for an open hand, a pinch and a fist. Make a fist over the demo object: a hollow square, then a filled one with 手勢：握住 …; move it: the whole object moves; open the hand; one 復原 restores it. Note false fists during pinches and missed fists. **Pull apart.** Hold the object with a fist and pinch with the other hand; move the pinch away: the object explodes; back: it closes. Repeat with 爆炸圖 already open: the fist still moves the object.

**Tests:**
- New `tests/unit/hand-fist.test.ts` (design §11.2).
- `tests/unit/hand-input.test.ts` (extend): `handSample.curl` for the synthetic open hand and fist.
- `tests/unit/hand-controller.test.ts` (extend): fist-like frames never engage a pinch; a fist cancels an unmoved pinch and nothing is committed; a moved pinch blocks a fist; a fist on a part of an inactive object calls `activate` then `beginHold`; a fist on empty space holds nothing; a fist while another gesture runs is inert; the explode join reads the distance from the palm, starts from `explodeAmount()`, calls `setExplode` only when the rounded value changes, and re-bases the hold after it ends; the gates of requirement 94; `fistEnabled: false` leaves pinches exactly as without fists.
- `tests/unit/hand-drag.test.ts` (extend): the object move (world parent frame, rounding, clamp) and `explodeAmount` (dead zone, clamp, rounding).
- `tests/unit/hand-sessions.test.ts` (extend): a hold session moves only the object root, commits once with the rounded position, restores on cancel, and is not refused while exploded.
- `hand-control.spec.ts`, the cases of requirement 95.
- E2E at the end: the full suite.

**Dependencies:** Task 5 (Task 6 is not required).

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and the manual list has the new lines.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task7.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): hold, move and explode objects with a fist (spec hand-manipulation, task 7)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 8 — P1: two-hand rotate

`[x]`

While one hand grabs a part, the other hand pinches and moves around it; the change in the angle between the two cursors rotates the part about the camera's view axis. Committed once with the move, through the gizmo's path.

**Read first:** `src/hands/controller.ts`, `join.ts`, `pair.ts`, `drag.ts`, `text.ts`, `skeleton.ts`, `HandOverlay.tsx`, `constants.ts`; `src/scene/hand-sessions.ts` (grab sessions); `src/scene/SceneViewport.tsx` (the `onTransform` call, the keyboard handler: R stays 重設視角); in `src/App.tsx`: `onTransform` and its notices; `shared/model.ts` (rotation limits); design §5.3–§5.5, §6.6, §7.2, §7.5, §8.2, §11; requirements 55, 82, 96–98, 70, 72.

**Build:**
- `src/hands/constants.ts`: `ROTATE_DEAD_ZONE_DEG = 5`.
- `src/hands/join.ts`: the row `grab` + `pinch` → `rotate` when the gate is `full`.
- `src/hands/drag.ts` (design §6.6): `rotateAboutView`.
- `src/hands/controller.ts`: `GrabSession.rotate(angleDeg)`; a `rotate` joiner accumulates `angleDelta` between frames, holds the angle while `pairSpan < TWO_HAND_MIN_SPAN_PX`, subtracts `ROTATE_DEAD_ZONE_DEG` with `beyondDeadZone`, and calls `rotate`; `frame.arc` while rotating; the owner's release commits when the part moved or turned.
- `src/scene/hand-sessions.ts`: the grab session's rotation preview with `rotateAboutView` from the live parent and camera matrices; `commit` passes `kind` `translate`, `rotate` or `both` by what changed; `cancel` restores the rotation too.
- `src/App.tsx`: the `both` notice 已移動並旋轉零件，可按「復原」回到上一步。 (design §7.5).
- `src/hands/skeleton.ts` and `HandOverlay.tsx`: `drawArc` at the owner's cursor. `src/hands/text.ts`: the badge 手勢：雙手旋轉 {n}°.
- `README.md`: one line on two-hand rotate.
- Add these lines to the "Manual webcam check" in Task 5, before "Report": **Two-hand rotate.** Pinch a part with one hand, then pinch with the other and move it around the first: the part turns the same way on screen, the second hand shows 手勢：雙手旋轉 …° and an arc. Let go with the second hand, move the first a little, let go: one 復原 restores both the turn and the move. Note whether the part turns when you did not mean it to (then raise `ROTATE_DEAD_ZONE_DEG`).

**Tests:**
- `tests/unit/hand-drag.test.ts` (extend): `rotateAboutView` turns a projected point of the part the same way as the angle (clockwise on screen for a positive angle), under a rotated parent and a rotated object root; the result stays within ±180°; rounding to 2 decimals.
- `tests/unit/hand-controller.test.ts` (extend), with the real `joinGesture`: grab + pinch joins as `rotate` only at `full`; the move holds still while rotating; the angle accumulates across ±180°; a short span holds the angle; the dead zone; the joiner's release keeps the rotation and re-bases the move; the owner's release commits once.
- `tests/unit/hand-sessions.test.ts` (extend): a rotation keeps the stored position; `commit` reports `rotate` or `both`; `cancel` restores the rotation.
- `hand-control.spec.ts`, the cases of requirement 98.
- E2E at the end: the full suite.

**Dependencies:** Task 5 (Tasks 6 and 7 are not required).

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and the manual list has the new lines.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task8.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(hands): rotate parts with both hands (spec hand-manipulation, task 8)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 9 — P1: agent switch for the camera image

`[x]`

A server tool lets the agent hide or show the camera image, through a new optional state-change flag that the browser applies like `tryOn`.

**Read first:** `shared/agent.ts` (`StateChangeSchema`, the detail schemas); `server/tools/wear-on-arm.ts`, `registry.ts`, `helpers.ts` (`checkedChange`), `index.ts`; `server/agent.ts` (`AGENT_INSTRUCTIONS`, how the loop applies `stateChange`); `src/agent/apply-state.ts`, `src/agent/useAgentRun.ts`; in `src/App.tsx`: the `useAgentRun` call and `cameraHidden`; `tests/unit/tool-registry.test.ts`, `agent-tools.test.ts`, `apply-state.test.ts`, `agent-loop.test.ts`; `tests/e2e/agent-panel.spec.ts` (how `/api/agent` is routed and its event stream built); design §3.5, §10; requirements 54, 70, 72, 99, 100.

**Build:**
- `shared/agent.ts` (design §10): `cameraHidden: z.boolean().nullable().optional()` in `StateChangeSchema`; `SetCameraImageDetailSchema` and its type.
- `server/tools/set-camera-image.ts` (design §10): `set_camera_image`, label 鏡頭畫面; camera off → `ok: false` with 請先開啟攝影機。; no model check.
- `server/tools/index.ts`: export it after `wear_on_arm`. `server/tools/helpers.ts`: `checkedChange` strips `cameraHidden` together with `tryOn`.
- `server/agent.ts`: the `AGENT_INSTRUCTIONS` rule line of design §10.
- `src/agent/apply-state.ts`: `StateEffects.cameraHidden` when the event carries a boolean. `src/agent/useAgentRun.ts`: `AgentRunOptions.setCameraHidden`, called like `setTryingOn`.
- `src/App.tsx`: pass `setCameraHidden` that applies the value only while `camera === 'on'`.
- `README.md`: one line: the agent can hide or show the camera image.
- Add this line to the "Manual webcam check" in Task 5, before "Report": **Agent.** With the camera on, ask the agent 「把鏡頭畫面藏起來」: the image hides, 隱藏鏡頭畫面 is pressed, and the skeletons keep following; ask it to show the image again.

**Tests:**
- `tests/unit/agent-tools.test.ts` (extend): `set_camera_image` with the camera on (both values: `ok`, the summary, `cameraHidden`), with the camera off (`ok: false`, no state change), and bad arguments.
- `tests/unit/tool-registry.test.ts` (extend): the tool list, the label map and the effects map include `set_camera_image` (`鏡頭畫面`, `uses-camera`); the argument shape `visible: boolean`.
- `tests/unit/apply-state.test.ts` (extend): a payload with `cameraHidden` sets the effect; the existing payloads without it still parse and set none.
- `tests/unit/agent-loop.test.ts` (extend): `AGENT_INSTRUCTIONS` contains `set_camera_image`.
- `hand-control.spec.ts`: the case of requirement 100 (camera on; a routed `/api/agent` stream with a `state` event carrying `cameraHidden: true` → `data-image-hidden="true"` and the button pressed).
- E2E while developing: `agent-panel.spec.ts` (unchanged, must pass), `workspace.spec.ts`, `hand-control.spec.ts`. At the end: the full suite.

**Dependencies:** Task 3 (the hidden camera image). It does not need Tasks 4–8.

**Done when:** `npm run check` passes, the tests above are green, `git diff --stat tests/e2e/agent-panel.spec.ts` is empty, the full e2e suite passes, and the manual list has the new line.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). Run the full suite once at the end of a task that touches the browser: start it in the background with its output in a file (for example `npx playwright test *> artifacts/local/e2e-hand-task9.log`), give it a timeout of at least 15 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time.
- Do not commit; the reviewer commits (suggested message: `feat(agent): add a camera image switch (spec hand-manipulation, task 9)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 10 — Release timing and pinch thresholds (after the webcam test)

`[x]`

The first test on the user's laptop (2026-11-22, VISION §4.9) found that a closed pinch measures about 26 mm (half open about 58 mm, open about 100 mm), so the 30 mm engage threshold misses pinches; that one hand tracks at about 9–10 fps; and that a release takes 3 frames (about 0.3 s) while the opening hand keeps dragging the object, so pinch-move, the view turn and the two-fist join overshoot or fail on release. This task widens the thresholds, counts engage and release in time instead of frames, freezes the running gesture the moment a hand starts to open, keeps a ready snap latched through the release, lowers the speed gate to 5 fps and shows the thresholds in the debug line. The join with two pinches and the fist-knob rotate of the same decision are a later task (Task 11) and are not built here. Requirements 101–107 (design §16).

**Read first:** `docs/VISION.md` §4.9, the note "Updated 2026-11-22 (first webcam test on the user's laptop)"; requirements 20, 40, 45, 47, 89 and 101–107; design §4.1, §4.5, §5.5, §9.1 and §16; `src/hands/constants.ts`, `pinch.ts`, `fist.ts`, `controller.ts` (`frame`, `follow`, `stepAssemble`, `leaveJoiner`, `onFistRelease`, `commitSession`), `text.ts` (`trackingDebugLine`), `HandDebugPanel.tsx`, `gate.ts`; `src/scene/hand-sessions.ts` (`rebase` of grab, orbit and hold sessions, `createAssembleSession`); `tests/unit/hand-input.test.ts`, `hand-fist.test.ts`, `hand-controller.test.ts`, `hand-assemble.test.ts`, `hand-gate.test.ts`; `tests/e2e/hand-control.spec.ts` (`dragBy`, `pinchOnce`, `attempts`, the T3 speed cases) and `fake-hands.ts` (`handsUrl`); `README.md` ("Hand control").

**Build:**
- `src/hands/constants.ts`: `PINCH_ENGAGE_M` 0.03 → 0.04, `PINCH_RELEASE_M` 0.05 → 0.055 (R103); remove `PINCH_ENGAGE_FRAMES`, `PINCH_RELEASE_FRAMES`, `FIST_ENGAGE_FRAMES` and `FIST_RELEASE_FRAMES`; add `PINCH_ENGAGE_MS` (80), `PINCH_RELEASE_MS` (60), `FIST_ENGAGE_MS` (150), `FIST_RELEASE_MS` (60) and `MIN_GESTURE_FRAMES` (2) (R104); `MIN_CONTROL_FPS` 10 → 5 (R105). `HAND_LOST_MS`, `TRACKING_LOSS_MS` and `?hands-loss-ms` stay.
- `src/hands/pinch.ts` and `fist.ts` (design §16.1): the pure `holdStep` (exported from `pinch.ts`), and a `streakSince` field next to `streak` in `PinchState` and `FistState`; engage and release go through it. A frame that does not qualify, without a distance or curl ratio, or without a hand restarts the count; a tick does not count.
- `src/hands/controller.ts` (design §16.2, §16.3): `isOpening`, `Session.frozen`, `updateFreeze` (first in `follow`) and `resume`; while frozen, skip the owner's preview, `stepAssemble` and the joiner's zoom, rotate and explode; hold the cursor (pinch) and the palm (fist) at their engage points while a hand opens; `leaveJoiner` clears the flag after its own re-base; an assemble resumes by shifting both palm references. The ready snap is not asked while frozen, so it stays latched (R102).
- `src/hands/text.ts` and `HandDebugPanel.tsx` (R106): `trackingDebugLine` takes `pinchThresholdsMm` and appends 捏合門檻 40／55 mm; the panel passes the constants.
- `README.md`: the speed statement (under 5 frames per second), one sentence on the thresholds and the freeze, and the thresholds in the `?hands=debug` list.
- `.kiro/specs/hand-manipulation/`: this task, the changes sections of `requirements.md` and `design.md`, and the manual-list item below.

**Tests (R107):**
- `tests/unit/hand-input.test.ts`: the constants (new names and values; the four frame constants no longer exist); `pinchStep` in time at 20, 33, 50, 100 and 200 ms spacing (2 frames at 10 fps, 4 at 30 fps, release in 2 and 3), the 26, 40 and 58 mm cases, one noisy frame, a lone frame after a long gap with a long loss window, the release threshold of 55 mm; `holdStep`.
- `tests/unit/hand-fist.test.ts`: the same in time for the fist.
- `tests/unit/hand-controller.test.ts`: engage and release at 10 and 30 fps through the controller; a single noisy frame; the freeze for a grab, an orbit, a hold, a zoom, a rotate and an explode (nothing is previewed while the hand opens, the confirmed release commits the frozen state); the resume after closing again (one re-base, the first offset is zero, nothing jumps); a tap that does not become a drag while the fingers open.
- `tests/unit/hand-assemble.test.ts`: the latched snap with either fist opening (`commit(true)` on release, `joins` 1, the scene not asked meanwhile), the scene asked again after a resume, the offsets after a resume equal those before the freeze, a plain fist hold freezes too.
- `tests/unit/hand-gate.test.ts`: the default gate of 5 (9 fps never locks, 4 fps does) and the thresholds in the debug line.
- `tests/e2e/hand-control.spec.ts`: opening while the hand is still moving commits where the hand started to open (one undo step restores it).
- Existing tests changed only where they encode the old numbers or frame counts: `hand-input.test.ts` (the constants tests; the `pinchStep` cases and the "keeps the grabbed target" case, whose 16 ms frame spacing and 2- and 3-frame counts no longer engage or release); `hand-controller.test.ts` (`FRAME_MS` 33 → 40, so that the new 80 ms engage takes the 3 closing frames the helpers hard-code and the 60 ms release takes 3; the frame-count constants it imported are computed locally from the new ms constants; a `frameMs` option and the `pinch` helper's closing frames come from the same computation); `hand-assemble.test.ts` and `hand-fist.test.ts` (the imported frame-count constants are computed locally from the new ms constants at 33 ms spacing, and three timestamps of spike cases were put in order); `hand-gate.test.ts` (an invalid-value case `5fps` became `7fps`, because 5 is now the default); `hand-control.spec.ts` (the slow-tracker case delays each answer by 300 ms instead of 150 ms, because the gate is 5 fps, and the CPU case also checks the thresholds in the debug line).
- E2E while developing: `hand-control.spec.ts`. At the end: the full suite.

**Dependencies:** Tasks 1–9.

**Done when:** `npm run check` passes, the tests above are green, the full e2e suite passes, and the manual list has the new item.

**Session facts:**
- E2E: in PowerShell, first set `$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"` and `$env:PLAYWRIGHT_GPU = "1"` (software WebGL saturates this 2-core machine and starves the fake camera, so hand gestures time out). Playwright's own Chromium revision is not installed; never download browsers (no `npx playwright install`).
- Never download MediaPipe models in tests. Every e2e spec that turns the camera on uses a fake worker (`installFakeHands` from `tests/e2e/fake-hands.ts`, or the own fake in `arm-try-on.spec.ts`); unit tests never load MediaPipe.
- Open hand e2e pages with `handsUrl()`. Start each attempt with no hand in either slot, and compare debug counters with their values at the start of the successful attempt.
- The e2e suite starts its own server on ports 5197/8797 and fails if they are taken. Never stop a process you did not start. No other Kiro session runs in this working tree; never run `git checkout`, `restore`, `stash`, `reset` or `clean`.
- Run single spec files while developing (`npx playwright test tests/e2e/<name>.spec.ts`). The full suite (85 tests) takes about 15–21 minutes: run it once at the end, in the background, with its output in a file (`npx playwright test *> artifacts/local/e2e-hand-task10.log`), with a timeout of at least 30 minutes, and read the file when it finishes.
- `npm run check` (type check + build + unit tests) must pass before the task is marked `[x]`; report the real result and numbers.
- No real model calls in tests: unit tests use a fake `ModelProvider`, e2e tests route `/api/*`. Never run `verify:real` or `verify:edit`.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report instead of investigating for a long time. Never drop or simplify a feature on your own; report instead.
- Do not commit; the reviewer commits (suggested message: `fix(hands): faster release, freeze on opening and wider pinch thresholds (spec hand-manipulation, task 10)`).
- Files are LF. User-facing strings are Traditional Chinese; code, comments, documents and reports are English.

---

## Cut order

**Only the user decides whether anything is cut.** A Kiro session never drops or simplifies a feature on its own, also not to save time: it reports the problem, and the reviewer asks the user. The list below is only a reference for that decision.

If time runs short, drop whole tasks from the end, in this order. The P0 core (Tasks 1–5: both skeletons, the hidden camera image, the 手勢 switch, one-hand pinch-move and orbit) always stays. Each P1 task depends only on Task 5 (Task 9 only on Task 3), so cutting one never blocks another.

1. **Task 9, agent switch.** Requirements 99–100 are dropped. The camera image is hidden only with the 隱藏鏡頭畫面 button; the server does not change.
2. **Task 8, two-hand rotate.** Requirements 96–98 are dropped, and the `rotate` join row is absent. Parts are rotated with the gizmo's 拖曳旋轉 and the 角度 fields; R stays 重設視角 either way.
3. **Task 7, fist.** Requirements 89–95 are dropped, and the `explode` join row is absent. Whole objects move through the 物件 panel; the exploded view opens with the 爆炸圖 button and slider; the 爆炸圖 status line keeps its P0 text.
4. **Task 6, two-hand zoom.** Requirements 87–88 are dropped, and the join rule has no rows, so a second hand is always inert. Zooming stays with the mouse wheel and the zoom buttons, which also give finer hand moves (requirement 31).

Dropping a task removes its README and manual-list lines; say so in the last report.

## Requirement-to-task map

The full map, with the parts of shared requirements, is design §12. In short:

| Task | Requirements |
|---|---|
| 1 ✓ | 1–8, 9, 10, 11, 44, 50, 51, 53, 54, 63, 66 |
| 2 ✓ | 9, 12–15, 17–23, 47–49, 52, 64 |
| 3 | 12–15, 18, 40, 41, 43–45, 47, 48, 52, 53, 63, 64, 66, 73–78 |
| 4 | 16, 21, 24–31, 33, 35, 37–42, 45, 47–49, 78–84, 86 |
| 5 | 15–18, 22, 24–37, 39, 41, 43, 45, 46, 52, 54, 55, 64, 70, 72, 81, 85 |
| 6 | 31, 82, 86–88, 70, 72 |
| 7 | 15, 18, 41, 43, 45, 47, 82, 89–95, 70, 72 |
| 8 | 55, 82, 96–98, 70, 72 |
| 9 | 54, 99, 100, 70, 72 |
| 10 | 20, 40, 45, 47, 74, 89 (changed numbers), 101–107 |

Requirements 65 and 67–69 apply to every task; 71 is this file. Requirements 56–62 are removed.
