# Body fit — Tasks

Implementation order: **T1 ∥ T2 → T3 → T4 → T5 → T6 → T7**. T1 (pure fit maths in `shared/`) and T2 (the worker's segmenter and the measurement core) touch no common file and can run in two sessions at once. T3–T6 complete the P0 hand and wrist fit; T7 adds the head (P1, only after the spike and the user's go) and the foot (P2). Requirement numbers (R…) refer to `requirements.md`; section numbers (§) refer to `design.md`. Each task is meant for one fresh Kiro session with Claude Sonnet 5.5 that starts without memory, so each one lists what to read first and repeats the session facts. The open decisions of `requirements.md` are followed as recommended unless the user has decided otherwise; a task that depends on an undecided item says so and asks first.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

## Parallel sessions and file ownership

Other Kiro sessions (`workbench-ui`, `design-fidelity`, `english-ui`) work in this same working tree at the same time; their uncommitted changes are expected and are not yours. The full table is design §14. In short:

| Spec | Owns or edits | Body-fit tasks that also edit some of these |
|---|---|---|
| `workbench-ui` | the layout: `src/App.tsx`, `src/styles.css`, panels and slots, likely `src/scene/SceneViewport.tsx` and agent data cards | T3, T4, T6 (`App.tsx`, `styles.css`), T4, T5 (`SceneViewport.tsx`) |
| `design-fidelity` | `shared/model.ts` (`shell`), `src/scene/geometry.ts`, `server/provider.ts`, possibly `server/tools/*` and `shared/agent.ts` | T1 (reads `shared/model.ts`; the `shell` row of `PRIMITIVE_INSIDE`), T6 (`shared/agent.ts`, `server/tools/index.ts`) |
| `english-ui` | every user-facing string, `MODEL_INSTRUCTIONS`' language line | T3–T6 (`App.tsx` strings) |
| `hand-manipulation` (done as of 2026-11-26) | `src/hands/**`, `src/try-on/arm.worker.ts`, `tests/e2e/fake-hands.ts`, `tests/fixtures/synthetic-hand.ts` | T2, T7 (`arm.worker.ts`, `arm-pose.ts`, `useHandTracking.ts`) |
| `body-fit` (this spec) | `shared/fit*.ts`, `shared/ellipse.ts`, `shared/body.ts`, `shared/demo-bracelet.ts`, `src/fit/**`, `server/tools/attach-to-body.ts`, `server/tools/fit-to-body.ts`, `tests/unit/fit-*.test.ts`, `tests/fixtures/fit-*.ts`, `tests/e2e/fake-body.ts`, `tests/e2e/body-fit.spec.ts`, `.kiro/specs/body-fit/**` | — |

**Rules for every task** (repeated in each task's session facts):
- Create and edit only the files the task lists under **Build** and **Tests**. Never revert, reformat, stage or "fix" a file you did not change, and never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. Do not commit.
- Before the first edit of a file another spec touches (the table above, design §14), run `git status --short <file>`. If it shows changes, another session is still working on it: stop and ask. Do not wait in a loop.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- Only one session runs Playwright at a time (ports 5197/8797). If they are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start. Run e2e with `PLAYWRIGHT_GPU=1` (the laptop's fake camera runs at 1–2 fps on SwiftShader). The full suite takes about 25 minutes; run only the specs the task names.

---

## Task 1 — Fit maths and property tests

`[x]` · P0 · R18, R26, R47–R52, R54 (texts), R55, R57 (pure part), R66–R67 (resize), R73 (spread maths), R83, R84, R113–R116

The pure core in `shared/`: ellipse and perimeter, the clearance offset, the arm section with tilt and roll, exact inside tests for every primitive, the ring axis and face, the inner profile, gaps, classes, the fit summary, the tape combination and the local ring resize. Nothing changes on screen.

**Read first:** `shared/model.ts` (`PartSchema`, the primitive enum); `src/scene/geometry.ts` (`createPartGeometry`: how each primitive is built, centred and scaled — the inside tests must match it); `shared/bounds.ts` (`worldMatrices`, `modelBox`); `shared/edit.ts` (`EditPlanSchema`, `applyEditPlan`, `validateEditPlan`); `shared/model.ts` (`validateModel`); `shared/joint.ts` (the `Record` over the primitive enum and its `shell` comment: the same pattern); `shared/assembly.ts` (`assemblyOf`, `objectMatrix`); `vitest.config.ts`; design §1, §2, §3, §5.4, §6, §12.1 (T1); requirements R18, R26, R47–R57, R66–R67, R84, R114.

**Build:**
- **Decision 1 first.** If the user chose A (`fast-check`): run `git status --short package.json package-lock.json`; if either shows changes, stop and ask. Then ask the user to confirm the install, and run `npm install --save-dev --save-exact fast-check@<current 4.x>`; report the exact version and that the lockfile adds only `fast-check` and its dependencies. If the user chose B or has not decided, write `tests/fixtures/fit-random.ts` (a seeded generator; a failing case prints the seed and the values) and add no package.
- `shared/fit-constants.ts`: every T1 constant named in the requirements and design §6 (`FIT_ANGLES` 72, `FIT_SLICES` 3, `LOOSE_MARGIN_MM` 2, `CLEARANCE_PRESETS_MM` { snug 6, comfort 13, loose 25 }, `RING_MIN_MM` 35, `RING_MAX_MM` 130, `OPEN_GAP_DEG` 15, `DEFAULT_THICKNESS_RATIO` 0.65, `DEFAULT_BAND_OFFSET_MM` 20, `PROFILE_MIN_MM` −20, `PROFILE_MAX_MM` 60, `PROFILE_STEP_MM` 5, `PROFILE_REACH_MM` 90, `PASSAGE_SHAPE` 0.95, `ATTACH_GAP_MM` 1, `DEFAULT_TAPER` 0.12, placement ranges), each with a one-line comment that says where the number comes from or that it is an assumption.
- `shared/fit-text.ts`: every user-facing string of R24–R28, R47, R52, R54, R66, R68, R71 and the side and source labels (`sideLabel`, `sourceLabel`, `formatMeasured`), as one table of Traditional Chinese strings and small template functions. Later tasks add their rows here, never inline.
- `shared/body.ts` (design §3): the Zod schemas and types.
- `shared/ellipse.ts` (design §6.1): `ellipseRadius`, `ellipsePerimeter`, `polygonPerimeter`, `rayEllipse`, `offsetForPerimeter`.
- `shared/fit-geometry.ts` (design §6.4): `PRIMITIVE_INSIDE`, `ringCandidates`, `faceDirection`, `ringFrame`, `innerProfile` (with a call counter option for the cost test).
- `shared/fit.ts` (design §5.4, §6.2, §6.5, §6.7): `wristEllipse`, `armSection`, `effectiveClearance`, `fitGaps`, `classify`, `fitSummary`, `robustMedian` and `spread` (shared by T2's measurement and this summary).
- `shared/fit-resize.ts` (design §6.6): `resizeRing`, `FitResizeError`. No `realignJoint` call here (T6 does it).
- `tests/fixtures/fit-bracelet.ts`: models built with `PartSchema`-valid parts: a tube band; a torus band; a band root with a case child (and interior battery and board under the case); a case root with a band child; an open C cuff of boxes; an object with no ring; a ring with a part across the axis.

**Tests:**
- New `tests/unit/fit-ellipse.test.ts`, `fit-geometry.test.ts`, `fit-gaps.test.ts`, `fit-resize.test.ts`: the T1 cases of design §12.1 and every invariant of design §6.8. The inside tests are compared with ray–mesh parity on `createPartGeometry` meshes (Three.js `Mesh.raycast` runs in Node).
- E2E: none.

**Dependencies:** none. If `design-fidelity` has already added `shell` to `PartSchema`, add its row to `PRIMITIVE_INSIDE` as `box` (R84) and a test for it.

**Done when:** `npm run check` passes, the tests above are green, every invariant of design §6.8 has a property test, and the report gives: the number of generated cases per invariant, the inner-profile cost for the band-and-case fixture (inside-test count and time), and the decision-1 outcome (package added with its version, or the local generator).

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Edit only the files listed above; never revert, reformat or stage anything else; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`. Before editing `package.json` or `package-lock.json`, check `git status --short` for them; if they show changes, stop and ask.
- `shared/` code uses only Three.js math classes: no DOM, no renderer, no `src/` imports. The server imports these files in T6.
- Lengths in this module are millimetres; models are metres. Convert at the boundary (×1000) and name variables with their unit (`widthMm`).
- Angles in `FitSummary` are body angles (0° 手背側, 90° 拇指側, 180° 掌心側, 270° 小指側); the maths takes the side sign as a parameter (design §6.4).
- If `npm run check` fails only in files you did not touch, report them and do not fix them. `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests. Never run `verify:real` or `verify:edit`. Installing a package needs the user's confirmation.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(fit): add fit maths, inner profiles and ring resize (spec body-fit, task 1)`).
- User-facing strings are Traditional Chinese, all in `shared/fit-text.ts`; code, comments and reports are English.

---

## Task 2 — Worker segmenter and measurement core

`[x]` · P0 · R5, R9, R19, R20, R22–R23 (pure), R59 (mask data), R61 (luma), R85, R108, R109, R110

The tracking worker gains the multiclass selfie segmenter on a rotated wrist crop and a crop luma; the hook forwards them; pure modules measure the scale, the width across the forearm, the pose checks and the medians; a scripted fake worker serves e2e tests. Nothing visible changes yet.

**Read first:** `src/try-on/arm.worker.ts` (models, `wasmFiles`, GPU/CPU fallback, warm-up, `POSE_INTERVAL_MS`, the message loop); `src/try-on/arm-pose.ts` (`ArmWorkerFrame`, `ArmWorkerResult`, `LandmarkFrame`, `SCALE_BONES`, `screenPalmWidth`, `ArmTracker`, `coverFrameBounds`); `src/hands/useHandTracking.ts` (`TrackedFrame`, `HandSource`, how `pose` rides on a frame); `src/hands/tracking-plan.ts`; `src/try-on/useArmTracking.ts`; `node_modules/@mediapipe/tasks-vision/vision.d.ts` (`ImageSegmenter`, `segmentForVideo`, `ImageSegmenterOptions` with `outputConfidenceMasks`, `MPMask.getAsFloat32Array`, `close`); `tests/e2e/fake-hands.ts` and `tests/e2e/arm-try-on.spec.ts` (the worker route pattern); `tests/fixtures/synthetic-hand.ts`; `.kiro/specs/hand-manipulation/requirements.md` R1–R7, R63–R66; design §4, §5.1–§5.3, §12; requirements R5, R19–R23, R59, R61, R108–R110.

**Build:**
- `src/try-on/arm-pose.ts`: the additive protocol of design §4.1 (types only). Run `git status --short` on it first (HM file).
- `src/try-on/arm.worker.ts` (HM file, check `git status` first): lazy `ImageSegmenter` on the first `segment` request, warm-up, the rotated crop into a 256 × 256 `OffscreenCanvas`, confidence masks 2 and 4 to bytes, every `MPMask` closed, transferred buffers, `luma`, the `segmenter` state message, and no change at all for frames without `segment` (design §4.2). The model URL is the constant of design §4.2; mark it with a comment that it was verified, or **not**, in this task.
- `src/hands/useHandTracking.ts` (HM file, check first): an optional `segment` ref option sent with each frame, `mask` and `luma` copied into `TrackedFrame`; nothing else.
- `src/fit/mask.ts`, `src/fit/measure.ts`, `src/fit/cadence.ts` (design §4.3, §5.1–§5.3): `SkinMask`, `sample`, `maskToFrame`, `frameToMask`; `mmPerPx`, `widthAcross`, `palmFacing`, `forearmFlat`, `stillness`, `MeasureStep`; `segmentPlan`. Constants go into `shared/fit-constants.ts` (`SEGMENT_SIZE` 256, `CROP_SIDE_MM` 160, `SEGMENT_INTERVAL_MS` 333, `SEGMENT_MAX_INTERVAL_MS` 1000, `MEASURE_BURST_MS` 3000, `FIT_MIN_FPS` 6, `MEASURE_FRAMES` 7, `MEASURE_SPREAD_MM` 3, `PALM_FACING_DEG` 25, `FOREARM_FLAT_DEG` 30, `STILL_MM_PER_S` 15, `AXIS_SEARCH_MM` 10).
- `tests/fixtures/fit-mask.ts`: synthetic skin and clothes masks for a given crop: a forearm band of a given width along an axis, anti-aliased edges, an optional sleeve region.
- `tests/e2e/fake-body.ts`: the scripted worker of design §12.2 (`installFakeBody`, `showBody(page, { hands, maskWidthMm, sleeve })`), route pattern identical to `fake-hands.ts`; it answers `segment` frames with a mask the page side builds with `fit-mask.ts`, posts `segmenter: ready`, and answers `luma` (default 0.45).

**Tests:**
- New `tests/unit/fit-measure.test.ts`, `fit-cadence.test.ts`, `fit-worker-protocol.test.ts` (design §12.1, T2), including the `widthAcross` property test of design §6.8.
- E2E: `arm-try-on.spec.ts` and `hand-control.spec.ts` must pass unchanged (protocol and hook changes). No new e2e spec yet; `fake-body.ts` is first used in T3.

**Real-device measurement (needs the user's go, decision 2):** after the tests pass, ask the user whether to run the page with the real worker once. With a go, start `npm run dev` and, because `?fit=debug` only arrives in T4, request `segment` frames for 60 s from a temporary local harness (never committed, deleted afterwards); record the median segmenter time, the tracking rate with two hands while segmenting every 333 ms and every frame, the warm-up time, and whether the model URL resolved. Report the numbers against design §4.4. Without a go, report that the budget is unmeasured.

**Dependencies:** none (parallel with T1). `robustMedian` and `spread` live in `shared/fit.ts` (T1); if T1 has not landed, put them in `src/fit/measure.ts` and leave a note for the reviewer to move them.

**Done when:** `npm run check` passes; the unit tests above are green; `arm-try-on.spec.ts` and `hand-control.spec.ts` pass with `PLAYWRIGHT_GPU=1`; a frame without `segment` produces exactly today's messages (unit test); and the report states the budget numbers or that they are unmeasured.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. Edit only the files listed above. `arm.worker.ts`, `arm-pose.ts` and `useHandTracking.ts` belong to `hand-manipulation`: check `git status --short` on each before the first edit; if it shows changes, stop and ask. Never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`.
- Camera frames and masks never leave the browser: no `fetch`, no logging of masks or landmarks, no new server route (R108).
- Tests never download a model: unit tests use synthetic masks, e2e uses `fake-body.ts`. The real segmenter (16.37 MB) is downloaded only for the measurement above, and only after the user says go.
- The segmenter must never slow hand tracking when nobody asks for a mask: no segmenter is created and no crop is drawn for frames without `segment`.
- If `npm run check` fails only in files you did not touch, report them and do not fix them. `npm run check` must pass before the task is marked `[x]`; report the real result.
- Only one session runs Playwright at a time; wait and retry at most three times if the ports are busy.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(fit): segment the wrist in the tracking worker (spec body-fit, task 2)`).
- Code, comments and reports are English.

---

## Task 3 — Scale sources, card calibration and the measuring panel

`[ ]` · P0 · R7, R8, R10–R17, R21, R24–R28, R73, R76–R81

The fit panel with its scale source, the guided wrist measurement (width, thickness, passage), the card calibration with the guide frame and the frozen frame, and the tape input with the error line. Body fit can be opened and measured; the object is not worn yet (T4).

**Read first:** T1's `shared/body.ts`, `shared/fit.ts` (`wristEllipse`), `shared/fit-text.ts`, `shared/fit-constants.ts`; T2's `src/fit/measure.ts`, `mask.ts`, `cadence.ts`, `tests/e2e/fake-body.ts`, `tests/fixtures/fit-mask.ts`; `src/App.tsx` (camera state, `toggleTryOn`, `useHandTracking` options, how `ExportDialog` is mounted in `.control-column`, the try-on status line); `src/try-on/useArmTracking.ts`; `src/hands/useHandTracking.ts` (`HandSource`); `src/hands/HandOverlay.tsx` (how an overlay sits over the video); `tests/fixtures/synthetic-hand.ts` (`clientToNormalized`); design §5, §6.3, §7, §12; requirements R7–R28, R73, R76–R81. Check whether `.kiro/specs/workbench-ui/` defines the panel slot and overlay layer of R80–R81; if it does and they exist in the code, mount there instead of the fallbacks.

**Build:**
- `src/fit/card.ts` (design §6.3): `cardGuide`, `findCardEdges`, `cardFactor`, the depth correction; constants `CARD_STILL_MS` 1000, `CARD_K_MIN` 0.75, `CARD_K_MAX` 1.33, `CARD_ASPECT_TOLERANCE` 0.06, `CARD_EDGE_CONFIDENCE` 2.5, `ASSUMED_HFOV_DEG` 65 in `shared/fit-constants.ts`.
- `src/fit/store.ts`, `src/fit/useBodyFit.ts` (design §7).
- `src/fit/FitPanel.tsx`: the sections of R76 that exist in this task (object and side read-only, 尺寸來源, 量手腕 with its steps, 卡片校正, 捲尺輸入, 餘量 choice), the test attributes of R77, and 結束試戴. Sections T4 adds are not rendered yet.
- `src/fit/CardGuide.tsx`: the guide, the frozen frame, draggable and keyboard-movable edges, 確認, 重拍, 取消校正 (R11–R14), in the overlay layer.
- `src/App.tsx` (shared file, check first): a fit session state started and stopped by the existing try-on button for now (renamed in T4), the `segment` ref passed to `useHandTracking`, the panel and guide mounted (workbench-ui slots if present, else the fallbacks of R80–R81).
- `src/styles.css` (shared file, check first): panel, guide and handle styles.
- New strings into `shared/fit-text.ts`.

**Tests:**
- New `tests/unit/fit-card.test.ts`, `fit-store.test.ts` (design §12.1, T3).
- New `tests/e2e/body-fit.spec.ts`: with `fake-body.ts`, the demo model loaded, the try-on button pressed: (1) step 1 with a palm-facing synthetic hand and a 58 mm synthetic band records and shows a width with 相機估計; (2) step 2 with a turned hand shows the thickness and the circumference; (3) a hand that moves keeps the step waiting with 「請保持不動」; (4) typing 165 mm shows source 捲尺 and the error line; (5) out-of-range input is refused; (6) the card guide appears, a still hand freezes the frame, and keyboard edge moves change `data-fit-source` to `card` after 確認 with a synthetic card painted into the fake camera canvas; (7) no request is made to `/api/*` during any of this.
- E2E to run: `body-fit.spec.ts`, `arm-try-on.spec.ts`.

**Dependencies:** T1 and T2 marked `[x]`.

**Done when:** `npm run check` passes; the unit tests and the two e2e specs pass with `PLAYWRIGHT_GPU=1`; the report includes a screenshot of the panel after a measurement and a tape entry, so the reviewer can read the Traditional Chinese text.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. `src/App.tsx` and `src/styles.css` are also edited by `workbench-ui` and `english-ui`: check `git status --short` before the first edit; if they show changes, stop and ask. Keep the App change small (state, one ref, mount points).
- The frozen calibration frame is an `ImageBitmap` in the page; it is closed when the guide closes and is never sent anywhere (R108).
- Every number shown carries its source (R8). Strings come from `shared/fit-text.ts`.
- New accessible names avoid the selectors listed in R79.
- If `npm run check` fails only in files you did not touch, report them and do not fix them. `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls; no model download (e2e uses `fake-body.ts`).
- Only one session runs Playwright at a time; wait and retry at most three times if the ports are busy.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(fit): measure the wrist and calibrate with a card (spec body-fit, task 3)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 4 — Wearing any object, adjusting by hand, stability and the fit map

`[ ]` · P0 · R1–R4, R6, R29–R46, R53, R54, R56, R57, R74, R75, R112

The user's own object (and its joined objects) is worn on the wrist at true size, placed near the wrist bone, moved and tilted by the other hand or the panel, kept stable, and coloured with the fit map; the numbers and the fit dial appear in the panel; the stand-in cuff is retired; the demo bracelet exists.

**Read first:** `src/scene/arm-preview.ts` (everything: smoothing, prediction, hold and fade, the far-side ghost, the overlay camera — it is replaced); `src/scene/SceneViewport.tsx` (the animation loop around `createArmPreview`, `data-arm-preview`, object entries and how meshes are shown); `src/try-on/arm-pose.ts` (`ArmTracker`, `ArmPose`, `coverFrameBounds`, the jump fixes); `src/try-on/useArmTracking.ts`; `src/hands/pinch.ts`, `fist.ts`, `one-euro.ts`, `mapping.ts` (`handSample`), `constants.ts`; `src/scene/geometry.ts` (`buildModel`, `disposeObject`); `shared/assembly.ts` (`assemblyOf`, `objectMatrix`); `shared/demo.ts` (how the demo object is shaped and loaded); `tests/e2e/arm-try-on.spec.ts`; T1–T3's modules; `docs/PRIOR_WORK.md` (the recording study); design §6.4, §8, §12; requirements R1–R6, R29–R46, R53–R57, R74–R75, R112.

**Build:**
- `src/fit/anchor.ts`, `placement.ts`, `adjust.ts`, `recorder.ts` (design §8.1, §8.2, §8.4, §8.6); constants (`FIT_HOLD_MS` 600, `ADJUST_REACH_MM` 60, `ADJUST_DEAD_ZONE_MM` 4, `TILT_DEG_PER_MM` 0.5, One Euro settings) in `shared/fit-constants.ts`.
- `src/fit/wear-view.ts`, `src/fit/fit-ribbon.ts` (design §8.3, §8.5), keeping `DEFAULT_BACK_OPACITY` 0.3 and the `?armBack` override.
- `src/fit/FitDial.tsx`; `src/fit/FitPanel.tsx` adds 戴在左手/右手, 環形零件, 開合方式, 位置/傾斜/轉動 with fields, ±buttons and 回到預設位置, the numbers of R54, the dial, the adjustment badge text, 載入示範手環, and `?fit=debug` / `?fit=record`.
- `shared/demo-bracelet.ts` (design §8.7), if decision 14 is A.
- `src/scene/SceneViewport.tsx` (shared file, check first): `bodyView` prop replaces `tryOn`; `createWearView` replaces `createArmPreview` at the same place; worn objects hidden on the stage; `data-fit-worn`.
- `src/try-on/useArmTracking.ts` (HM consumer file, check first): exposes the latest `ArmPose` for the anchor; status texts become the fit status texts of R78 (same test id and states).
- `src/App.tsx` (shared file, check first): the button 試戴 (decision 4; R1–R3), the worn object and assembly, the adjusting hand fed to `adjust.ts`, the fit recompute on change (R57).
- Delete `src/scene/arm-preview.ts` (decision 4); nothing else imports it after the change.
- `tests/fixtures/fit-sequence.ts`: synthetic noisy landmark sequences (still wrist, slow move, fast move, a 400 ms loss, a handedness flip, a half-turn roll flip).

**Tests:**
- New `tests/unit/fit-anchor.test.ts`, `fit-adjust.test.ts`, `fit-placement.test.ts`, `fit-replay.test.ts` (design §12.1, T4); the replay test of a real recording is skipped unless `FIT_RECORDING` is set.
- `tests/e2e/body-fit.spec.ts` adds: wearing the demo bracelet shows `data-fit-worn` and hides it on the stage; the stage object reappears after 結束試戴; the number fields move the placement and change `data-fit-summary`; a synthetic second hand pinching near the object and moving along the arm changes 位置 by about the moved millimetres; the undo button stays disabled through all of it (no workspace change); a tape value of 150 mm with the demo bracelet shows 偏鬆 and of 200 mm shows 壓迫.
- `tests/e2e/arm-try-on.spec.ts` (decision 4): change only the button name (`試戴`) and keep every other assertion (tracking, `data-arm-preview` visible, lost and reacquired, camera off, model unchanged, no model request). If any other assertion has to change, stop and report.
- E2E to run: `body-fit.spec.ts`, `arm-try-on.spec.ts`, `hand-control.spec.ts`, `workspace.spec.ts`.

**Dependencies:** T1–T3 marked `[x]`; decisions 4 and 14 answered (ask if not).

**Done when:** `npm run check` passes; the unit tests and the four e2e specs pass with `PLAYWRIGHT_GPU=1`; `fit-replay.test.ts` reports the four metrics of R75 on the synthetic sequences and they meet the targets; the report includes a screenshot of the worn demo bracelet with the fit map and the panel numbers.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. `src/App.tsx`, `src/scene/SceneViewport.tsx`, `src/styles.css` and `src/try-on/useArmTracking.ts` are shared: check `git status --short` before the first edit of each; if it shows changes, stop and ask. Keep edits small and at the places design §8.3 names.
- Placement and wearing are session state: never a workspace change, never an undo step (R3, R36).
- The worn object is a second view of the model: never mutate the `ModelSpec` or the object transform for display. Dispose every Three.js resource with `disposeObject`.
- Landmark recordings are personal data: never commit one (decision 13); the recorder only offers a download.
- If `npm run check` fails only in files you did not touch, report them and do not fix them. `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls; no model download.
- Only one session runs Playwright at a time; wait and retry at most three times if the ports are busy.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(fit): wear any object on the wrist with a fit map (spec body-fit, task 4)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Task 5 — Looks worn: occlusion by the real arm, contact shadow, light from the video

`[ ]` · P0 · R58–R62

The mask hides the far side of the worn object behind the real arm (skin or sleeve), a soft contact shadow sits where the object meets the skin, and the lighting follows the video's brightness.

**Read first:** T4's `src/fit/wear-view.ts`, `anchor.ts`, `fit-ribbon.ts`; T2's `src/fit/mask.ts` and the `mask`/`luma` fields of `TrackedFrame`; `src/scene/SceneViewport.tsx` (how `bodyView` is passed); `src/scene/style.ts` (render order conventions); `tests/e2e/fake-body.ts`, `tests/fixtures/fit-mask.ts`; `tests/e2e/visual-backgrounds.spec.ts`; design §9, §12.2; requirements R58–R62, R109.

**Build:**
- `src/fit/occlusion.ts` (mask texture, UV matrix, shift, age, the proxy and its shader), `src/fit/shadow.ts`, `src/fit/light.ts` (design §9); constants `MASK_MAX_AGE_MS` 1500, `SHADOW_WIDTH_MM` 6, `SHADOW_MAX` 0.35, `LIGHT_MIN` 0.4, `LIGHT_MAX` 1.6, `LIGHT_MID` 0.45, `LIGHT_TAU_MS` 500.
- `src/fit/wear-view.ts`: wire them in; `data-fit-occlusion`, `data-fit-shadow`, `data-fit-light` (R62).
- `src/scene/SceneViewport.tsx` (shared file, check first): pass the latest mask and luma into the wear view, if T4's `bodyView` does not already carry them.

**Tests:**
- New `tests/unit/fit-occlusion.test.ts`, `fit-light.test.ts` (design §12.1, T5).
- `tests/e2e/body-fit.spec.ts` adds: with a fake mask, `data-fit-occlusion="mask"`; without masks for 1.5 s, `proxy`; `data-fit-shadow="on"` while worn; changing the fake `luma` from 0.45 to 0.2 lowers `data-fit-light` toward 0.44 within 2 s; the pixel check of design §12.2 (far-side pixel inside the arm mask at ghost level, outside it at full colour). If the pixel check is flaky after two or three attempts, stop and report.
- E2E to run: `body-fit.spec.ts`, `arm-try-on.spec.ts`, `visual-backgrounds.spec.ts`.

**Dependencies:** T4 marked `[x]`.

**Done when:** `npm run check` passes; the unit tests and the three e2e specs pass with `PLAYWRIGHT_GPU=1`; the report includes two screenshots (mask occlusion on and `?armBack=0`) and the debug line's main-thread time for the extra passes (design §4.4 budget: under 2.5 ms; measured with `PLAYWRIGHT_GPU=1` and labelled as a test-machine number, not the user's laptop).

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. `src/scene/SceneViewport.tsx` is shared: check `git status --short` before editing; if it shows changes, stop and ask.
- The mask is camera-derived data: it stays in the page and the GPU; never read it back except in the test helper (R108).
- Dispose the mask texture, the proxy, the shadow and their materials with the view (R110).
- If `npm run check` fails only in files you did not touch, report them and do not fix them. `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls; no model download.
- Only one session runs Playwright at a time; wait and retry at most three times if the ports are busy.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(fit): occlude by the real arm with shadow and matching light (spec body-fit, task 5)`).
- Code, comments and reports are English.

---

## Task 6 — The agent closes the loop: attach_to_body, fit_to_body, the fit card, README

`[ ]` · P0 · R63–R72, R82, R86, R108 (README), R111, R117, R118

`attach_to_body` replaces `wear_on_arm`; `fit_to_body` resizes the ring from the measurement and a clearance (locally for tube and torus, through the edit task otherwise); the request carries the measurement; the fit card shows before and after; 調整為合適尺寸 runs the same resize; README documents body fit. Ends the P0 part with the full e2e suite.

**Read first:** `server/tools/wear-on-arm.ts`, `edit-design.ts` (the edit path and `checkedChange`), `prepare-export.ts` (a session-state change), `registry.ts`, `index.ts`, `helpers.ts` (`checkedChange` strips session fields); `server/agent.ts` (`AGENT_INSTRUCTIONS`, how the working state is built from the request, the state line around line 200); `server/agent-tools.ts` (`AgentWorkingState`); `server/provider.ts` (`editTask`); `shared/agent.ts` (`StateChangeSchema`, `AgentRequestSchema`, detail schemas); `shared/contact.ts` (`realignJoint`); `src/agent/apply-state.ts`, `useAgentRun.ts`, `request.ts`, `AgentPanel.tsx`; the tests that name `wear_on_arm` (`tests/unit/tool-registry.test.ts`, `agent-tools.test.ts`, `agent-loop.test.ts`, `agent.test.ts`, `run-reducer.test.ts`); `README.md`; T1's `shared/fit-resize.ts`, `fit.ts`; T4's `FitPanel.tsx`; design §6.6, §10, §12; requirements R63–R72, R82, R86, R108, R111, R118. Check `.kiro/specs/workbench-ui/` for the agent data card slot (R82).

**Build:**
- `shared/agent.ts` (shared file, check first): `bodyFit` in `StateChangeSchema`, `body` in `AgentRequestSchema` and `AgentRequest`, `AttachToBodyDetailSchema`, `FitToBodyDetailSchema`; remove `WearOnArmDetailSchema`.
- `server/tools/attach-to-body.ts`, `server/tools/fit-to-body.ts` (design §10); delete `server/tools/wear-on-arm.ts`; register in `server/tools/index.ts`; `helpers.ts` strips `bodyFit` in `checkedChange`; `server/agent.ts` keeps `body` in the working state, adds the state-line text and the instruction lines of R72.
- `src/agent/apply-state.ts`, `useAgentRun.ts`, `request.ts`: the `bodyFit` effect and the `body` field (only while fitting).
- `src/fit/FitCard.tsx` and its mount (workbench-ui's data card slot, or under the panel's numbers); `src/fit/FitPanel.tsx`: 調整為合適尺寸 (decision 8) committing through the workspace store as one undo step.
- `src/App.tsx` (shared file, check first): pass the fit store to the agent options.
- Strings into `shared/fit-text.ts`.
- `README.md` (shared file, check first): the body-fit section and the privacy line (R108, R118).
- `.kiro/specs/body-fit/validation.md`: an empty table for the user's validation (R111): date, light, distance, side, tape, camera estimate, card-calibrated estimate, errors, printed bracelet result.

**Tests:**
- New `tests/unit/fit-agent.test.ts` (design §12.1, T6), with a fake `ModelProvider`.
- Update only the `wear_on_arm` lines of `tool-registry.test.ts`, `agent-tools.test.ts`, `agent-loop.test.ts`, `agent.test.ts` and `run-reducer.test.ts` to `attach_to_body` / 試戴 (decision 4), and add `fit_to_body` where the test lists every tool. `agent-client-events.test.ts` uses `wear_on_arm` only as a sample event label and stays unchanged. If any other existing test needs a change, stop and report.
- `tests/e2e/body-fit.spec.ts` adds: a routed `/api/agent` stream whose `state` frame (an `object` change with the resized bracelet) turns `data-fit-summary`'s state to `fits` and shows the fit card; the request body sent while fitting contains `body` with numbers and no image or mask field; 調整為合適尺寸 turns the map green and 復原 restores the previous size.
- E2E to run: `body-fit.spec.ts`, `agent-panel.spec.ts`, `arm-try-on.spec.ts`, then the **full suite once** (about 25 minutes) to close P0.

**Dependencies:** T4 marked `[x]` (T5 should be `[x]` before the full suite); decisions 4, 6, 7 and 8 answered (ask if not).

**Done when:** `npm run check` passes; the unit tests and the full e2e suite pass with `PLAYWRIGHT_GPU=1`; the report lists every existing test file changed and why, includes one real `fit_to_body` result summary from the unit test, and reminds the user of the manual check list below (tape, card, printed bracelet).

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. `shared/agent.ts`, `server/agent.ts`, `server/tools/index.ts`, `server/tools/helpers.ts`, `src/agent/*`, `src/App.tsx` and `README.md` are shared: check `git status --short` before the first edit of each; if one shows changes, stop and ask.
- The fit numbers in tool results come from `fitSummary`, never from the model (VISION §4.10). The server recomputes the fit from the request's measurement; it never trusts the browser's `fit` field.
- The agent request carries numbers only: no image, no mask, no landmarks (R65, R108).
- `fit_to_body`'s resize path makes no provider call; the edit path makes exactly one. Tests use a fake `ModelProvider`; never run `verify:real` or `verify:edit`.
- If `npm run check` fails only in files you did not touch, report them and do not fix them. `npm run check` must pass before the task is marked `[x]`; report the real result.
- Only one session runs Playwright at a time; the full suite holds the ports for about 25 minutes, so tell the user before starting it.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested message: `feat(agent): attach objects to the body and fit them to the wrist (spec body-fit, task 6)`).
- User-facing strings are Traditional Chinese; model-facing instructions, code, comments and reports are English.

---

## Task 7 — Head (P1, after the spike) and foot (P2)

`[ ]` · P1 (part A), P2 (part B) · R87–R107

Part A puts head-worn objects (headbands, helmets, glasses) on the head with the face transformation matrix (or a landmark frame), measures the head, and runs the same fit. Part B adds a coarse foot anchor and a length and width fit. The two parts may run as two sessions; part B starts only after part A is reviewed or the user skips A.

**Read first:** T2's worker changes and `fake-body.ts`; T4's `anchor.ts`, `placement.ts`, `wear-view.ts`; T5's `occlusion.ts`; T6's tools; `node_modules/@mediapipe/tasks-vision/vision.d.ts` (`FaceLandmarker`, `FaceLandmarkerOptions.outputFacialTransformationMatrixes`, `FaceLandmarkerResult.facialTransformationMatrixes`, `Matrix`; `PoseLandmarkerResult.worldLandmarks`); `docs/VISION.md` §3.1; design §11, §12; requirements R87–R107.

**Part A — Step 0, the spike (only after the user says go, decision 15):**
- Ask the user: the spike downloads `face_landmarker.task` (3.76 MB, Apache-2.0, decision 3) and uses the webcam; it costs no model quota. Without a go, stop here and report.
- With a go: throwaway code only (a local branch of the worker or a temporary page, deleted afterwards, never committed), as design §11.1. Write `.kiro/specs/body-fit/spike-head.md` with: matrix units and axes, mirror behaviour, still-head jitter, cost per frame with two hands and with the segmenter, warm-up time, iris-scale versus card agreement, and a go or no-go for the matrix. Report and wait for the user's review before building.

**Part A — Build (P1):**
- `src/try-on/arm.worker.ts`, `arm-pose.ts`, `useHandTracking.ts` (HM files, check first): face landmarker loaded on the first head frame, run only while the head anchor is on, results in an optional `face` field; hands every second frame when the rate would fall below 6 fps (R109).
- `src/fit/head.ts`: head frame (matrix or landmarks, per the spike), iris scale, card on the forehead, face width, head ellipse, glasses width check (design §11.2–§11.3); constants `IRIS_DIAMETER_MM` 11.7, `HEAD_BREADTH_EXTRA_MM` 14, `CEPHALIC_INDEX` 0.8.
- `FitPanel.tsx`: 戴在：手腕 / 頭部, 量頭部; `wear-view.ts`: head proxy and mask classes of R92.
- `shared/agent.ts`, `server/tools/attach-to-body.ts`, `fit-to-body.ts`: `head` anchor and head measurement (check `git status` first on shared files).
- Strings into `shared/fit-text.ts`; README one line.

**Part B — Build (P2):**
- Worker: pose world landmarks in an optional `bodyWorld` field while the foot anchor is on (R100).
- `src/fit/foot.ts`: foot frame, length from pose world landmarks, typed length or EU size, card on the floor (decision 16), width ratio, toe and width room (R101–R103); constants `EU_SIZE_MM` 6.67, `FOOT_WIDTH_RATIO` 0.38, `TOE_ROOM_MM` 12 (range 10–15).
- `FitPanel.tsx`: 戴在：腳部, 量腳; `wear-view.ts`: foot box proxy; tools: `foot` anchor, `fit_to_body` through the edit task for shoes.
- README one line.

**Tests:**
- New `tests/unit/fit-head.test.ts` (part A) and `fit-foot.test.ts` (part B) with synthetic face and pose landmarks; `fit-agent.test.ts` gains the new anchors.
- `tests/e2e/fake-body.ts` gains synthetic face and pose answers; `body-fit.spec.ts` adds a head case (part A) and a foot case (part B).
- E2E to run: `body-fit.spec.ts`, `arm-try-on.spec.ts`, `hand-control.spec.ts`.

**Dependencies:** T6 marked `[x]`; for part A, the spike's go and the user's review of `spike-head.md`.

**Done when (each part):** `npm run check` passes; the unit tests and the three e2e specs pass with `PLAYWRIGHT_GPU=1`; the report gives the measured cost with the new model on (part A) and includes a screenshot of the worn object.

**Session facts:**
- Other Kiro sessions work in this working tree at the same time. The worker files, `shared/agent.ts`, the tools index and `README.md` are shared: check `git status --short` before the first edit; if one shows changes, stop and ask.
- The spike's code is never committed; only `spike-head.md` stays. No download without the user's go.
- A new anchor value is registered in the tool's enum only when it is built (R63).
- Head and foot sizes are estimates unless calibrated or typed; every value shows its source (R8).
- If `npm run check` fails only in files you did not touch, report them and do not fix them. `npm run check` must pass before the task is marked `[x]`; report the real result.
- No real model calls in tests; never run `verify:real` or `verify:edit`.
- Only one session runs Playwright at a time; wait and retry at most three times if the ports are busy.
- If a test is flaky, or a failure cannot be fixed within two or three attempts, stop and report.
- Do not commit; the reviewer commits (suggested messages: `feat(fit): fit head-worn objects (spec body-fit, task 7)` and `feat(fit): add a coarse foot anchor (spec body-fit, task 7)`).
- User-facing strings are Traditional Chinese; code, comments and reports are English.

---

## Manual check list (user's laptop, after T6; head and foot lines after T7)

Use the real webcam (no `PLAYWRIGHT_GPU` involved), normal room light, the laptop on a table. Record every number in `.kiro/specs/body-fit/validation.md`. The first real fit downloads the segmenter (16.37 MB) from Google's model storage.

**Tracking and budget**
1. Open `/?fit=debug`, turn the camera on, press 試戴 with the demo bracelet (載入示範手環). Note the tracking rate, segmenter time and interval with one hand, then with the second hand in view. Expected: rate at or above 6 fps (R109). Note the load time until the measure steps become available.
2. Hold the wrist still for 10 s: note the anchor jitter and the scale spread in the debug line (targets R75). Move the arm slowly, then quickly; turn the wrist; hide the hand for a moment. Note whether the bracelet jumps, lags or disappears.
3. With `?fit=record`, record one minute of normal use, download it, and run the replay test with `FIT_RECORDING=<path>`; note the four metrics. Do not commit the file.

**Measurement (tape measure, ID-1 card)**
4. Measure the wrist with a tape just past the wrist bone (where a watch sits). Note the value.
5. 量手腕: steps 1 and 2 (and 3 for a closed ring). Note width, thickness, circumference and spread (相機估計). Repeat twice; note the repeatability.
6. 卡片校正 with a bank card on the back of the wrist; check the found edges; accept. Repeat step 5; note the circumference (卡片校正) and the factor shown.
7. Type the tape value into 捲尺輸入; note the error line for the estimate and for the card-calibrated estimate (R27). Try in dim light and with a sleeve pulled near the wrist; note any failure.

**Wearing and the fit map**
8. Check that the bracelet sits just past the wrist bone with its case on the back of the hand, at a size that looks real next to the arm. Slide it along the arm and tilt it with the other hand (pinch and drag), turn it with a fist knob, and with the number fields. Note anything that feels wrong.
9. Check the map against reality: with a tape value 10 mm larger than the bracelet's inner perimeter, the map should be red; with the bracelet much larger, amber. Read the numbers (內圍, 手腕, 餘量, 最緊) and compare with the fixture's design.
10. Looks worn: is the far side hidden behind the arm? Compare `?armBack=0` with the default 0.3 (decision 12). Is the contact shadow visible but not dirty? Turn the room light down: does the bracelet darken with the video? Is the mirrored drawing acceptable (risk "Mirror handedness")?

**The agent and the print**
11. Ask the agent 「幫我把手環調整成適合我的手腕，舒適一點」. Check the map turns green, the fit card shows before and after, and 復原 undoes it. Try 調整為合適尺寸 too.
12. Export the kit (匯出套件), print the band (and case), assemble, and wear it. Note: does it go on, does it press anywhere (which side), is it loose; compare with the fit map's prediction. Adjust the clearance presets (decision 10) if needed.

**Head (after T7 part A)**
13. 頭部: measure the head circumference with a tape above the eyebrows; run 量頭部; compare. Wear a generated headband; check the far side hides behind the head and the fit map.

**Foot (after T7 part B)**
14. 腳部: step back until the foot is in view; compare the camera foot length with a ruler; wear a generated shoe outline; read the toe room.

## Order and cut

Build order: T1 ∥ T2, then T3, T4, T5, T6 (P0), then T7 part A (P1), then T7 part B (P2). Nothing in this spec is cut or simplified without the user. VISION §5's reference cut order names the body-fit head anchor; the user decides whether and when to apply it. Schedule evidence is in decision 19 of `requirements.md`.

## Requirement-to-task map

| Requirements | Task |
|---|---|
| R1–R4, R6 | T4 |
| R5 | T2 |
| R7, R8, R10–R17 | T3 |
| R9 | T2 |
| R18 | T1 |
| R19, R20, R22, R23 | T2 (core), T3 (flow) |
| R21, R24, R25, R27, R28 | T3 |
| R26 | T1 (maths), T3 (input) |
| R29–R46 | T4 |
| R47–R52, R55 | T1 (maths), T4 (display) |
| R53, R54, R56, R57 | T4 (T1 the texts and the pure recompute) |
| R58–R62 | T5 (R59 and R61 data from T2) |
| R63–R72 | T6 (R66–R67 resize maths from T1) |
| R73 | T1 (maths), T3 (display) |
| R74, R75 | T4 |
| R76–R79 | T3 (T4, T6 add sections) |
| R80, R81 | T3 |
| R82 | T6 |
| R83 | T1 (every task adds strings) |
| R84 | T1 |
| R85 | T2 |
| R86 | T6 |
| R87–R98 | T7 part A |
| R99–R107 | T7 part B |
| R108 | T2 (worker), T6 (README) |
| R109, R110 | T2 (measured), T4–T5 (main thread) |
| R111 | T6 (`validation.md`), manual check list |
| R112–R119 | every task |
