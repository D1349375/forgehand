# Hand manipulation — Requirements

## Overview

Today hand tracking runs only during try-on: `useArmTracking` (`src/try-on/useArmTracking.ts`) starts the MediaPipe worker (`src/try-on/arm.worker.ts`, one hand plus pose) when 護臂試戴 is on, and `ArmTracker` (`src/try-on/arm-pose.ts`) turns each frame into a cuff pose. Everything else in the workbench is driven by the mouse: click to pick a part, the transform gizmo (`TransformControls` in `src/scene/SceneViewport.tsx`) to drag it, OrbitControls to turn the view.

This spec lets the user work with their hand in the webcam view. It is capability C4 in `docs/VISION.md` (§2, §4.9). Its P0 core: hand tracking runs whenever the camera is on, a hand skeleton is drawn over the camera view, and a pinch grabs and moves a part or, on empty space, turns the view. Two P1 gestures come last so they can be cut: rotate mode, then double-pinch zoom.

The pinch is the only action gesture, because a laptop webcam gives about one reliable "button". A **hand mode** (移動, later also 旋轉) decides what a pinch on a part does, as in Blender. A hand move works on parts, like the mouse gizmo: it uses the gizmo's commit path, and precision comes from zooming in, as with the mouse.

The tracking part is shared: `body-fit` (phase C) reuses it for try-on of any designed object, and later specs can read the raw landmarks.

Scope was decided with the user on 2026-11-15, and the drafts were reviewed the same day ("Decisions from review" at the end). No decision is open.

## Goals

- Hand tracking runs whenever the camera is on, with one worker shared by hand control and try-on, and a 手勢 switch turns hand control off.
- The user always sees whether the hand is seen, what mode it is in and what it is doing, without relying on colour alone.
- Pinch a part and drag it to move it, through the same commit path as the mouse gizmo; one gesture is one undo step.
- Pinch empty space and drag to turn the view.
- Hand control switches itself off, or to view-only, with a notice, when grabbing would be unsafe or too slow, and never blocks the mouse.
- Every gesture decision is a pure function, unit-tested with synthetic landmark sequences; e2e tests drive the app with a scripted fake landmark source; no test needs a webcam.
- The thresholds that need tuning on a real webcam are named constants in one place, and `?hands=debug` shows the numbers needed to tune them.
- No regression: with the camera off the workbench behaves exactly as today, and try-on behaves as today.

## Out of scope

- Moving or rotating whole objects by hand. The 物件 panel's number fields and the agent's `set_transform` do that; a later "object mode" is listed under "How later specs fit".
- Moving or rotating parts in the exploded view. The displayed part positions include the explode offset, so grabbing is off there (requirement 41); a later item is listed under "How later specs fit".
- Two-hand gestures. The worker tracks one hand (`numHands: 1`), and two raised hands tire the user quickly.
- Wrist-twist rotation. Palm-facing roll is ambiguous (`ROLL_FLIP_DOT` handling in `src/try-on/arm-pose.ts`).
- Resizing by hand, and any change to part dimensions by hand. Real size changes go through the agent or the number fields (§4.9 "Zoom and size are different things").
- Moving a part towards or away from the camera by hand. A drag moves it in the plane facing the camera; the user turns the view to move along another axis.
- Dragging whole objects with the mouse.
- Snapping parts (C9), picking candidate thumbnails (C3) or floating project cards (C17) by hand.
- Agent or voice control of the hand mode or the 手勢 switch, and any new agent tool. The agent request keeps sending only `cameraOn`.
- Any change to the try-on itself, the cuff, or `ArmTracker`'s placement logic. `body-fit` changes those.
- Any change to `ModelSpec`, `Part`, the workspace schema, the server or the provider adapters.
- English UI.

## Functional requirements

### Shared hand tracking

1. Hand tracking runs while the camera is on and either the 手勢 switch is on (requirement 8) or try-on is active. It stops, terminating the worker, when the camera turns off or the page unloads. With the camera off, no tracking code runs and nothing is downloaded.
2. One tracking worker serves hand control and try-on. Turning try-on on or off while the camera and 手勢 are on does not restart the worker or reload a model.
3. Pose inference runs only while try-on is active. Outside try-on each frame runs only the hand landmarker. Whether the pose model is loaded at start or on first use is a design choice; either way the first try-on frame must not hit the worker's per-frame watchdog.
4. Raw landmarks are exposed for later specs through one small client API: the latest frame (image landmarks, metric world landmarks, handedness, body landmarks when pose ran, frame size, capture time) plus the tracker status and delegate. Consumers read it from a ref or subscribe to it; a new frame never causes a React re-render by itself.
5. Try-on consumes the same frames through `ArmTracker`, unchanged. The try-on status line (`data-testid="try-on-status"`), its texts and its stats (`try-on-stats`) behave as today, and `tests/e2e/arm-try-on.spec.ts` passes unchanged. Its fake worker is routed by URL, so the worker stays reachable at a URL that its route pattern matches (`src/try-on/arm.worker.ts` in dev, `assets/arm.worker-*.js` in a build), and its message protocol stays compatible: a frame without `world` landmarks or without `body` is still valid.
6. Tracking failures (load error, track error, load timeout) never affect the camera, the scene or the mouse. They only turn hand control off with a notice (requirement 43).
7. Frames are flipped before tracking exactly as today when the video is shown mirrored, so landmarks are in display space for both front and rear cameras.

### 手勢 switch

8. A 手勢 toggle button in the camera toolbar turns hand control on and off. It has `aria-pressed`, is on by default, and is shown only while the camera is on. It is session state: turning the camera off resets it to on.
9. With 手勢 off: no hand-only inference runs while try-on is off (whether the worker is kept idle or terminated is a design choice); the hand overlay, the hand status line and the hand-mode buttons (requirement 56) are hidden; no gesture acts; the hand-mode keys do nothing; and the mouse works as today.
10. Try-on works with 手勢 off exactly as it does today; tracking then runs for try-on only, and the overlay stays hidden.
11. The button's accessible name, 手勢, does not match an existing test selector. Because the P1 mode buttons (手勢移動, 手勢旋轉) contain 手勢, new e2e tests select all three with exact names.

### Hand overlay and badge

12. Whenever the camera and 手勢 are on and a hand is tracked, its skeleton (the 21 landmarks and the standard hand connections) is drawn over the camera view, including while hand control is off or view-only and during try-on. It lies on the user's hand in the displayed video: the mapping from normalised landmarks to screen positions accounts for the mirrored display and the `object-fit: cover` crop (`coverFrameBounds`). The mapping is one pure function shared with picking (requirement 22).
13. The skeleton is hidden within `HAND_LOST_MS` of the last frame that contained a hand.
14. **Skeleton colour = hand mode.** Each mode (移動, and 旋轉 once requirement 56 lands) has its own colour. The colours are colour-blind-safe as a pair, and differ from the part-edge cyan (`HOLOGRAM.edgeColor` `#69eaff`) and the selection amber (`SELECTION.edgeColor` `#ffc53d`) in `src/scene/style.ts`.
15. **State is shown by shape, not colour:** thin lines and no ring = tracked; a hollow ring at the cursor = over a part or an on-screen button; a filled ring = grabbed or turning the view; grey dashed lines = hand control off or view-only and not turning the view ("locked"). The locked style replaces the mode colour.
16. A short Traditional Chinese badge is drawn next to the hand, so colour is never the only signal:

    | State | Badge |
    |---|---|
    | tracked | 手勢：移動 |
    | over a part | 手勢：移動 · 對準 {part name} |
    | over an on-screen button | 手勢：移動 · 對準 {button label} |
    | grabbed | 手勢：移動 · 已抓取 |
    | turning the view | 手勢：轉動視角 |
    | locked | 手勢：暫停 |

    In rotate mode (requirement 56) 移動 becomes 旋轉. A part name longer than 12 characters is cut to its first 12 characters followed by 「…」.
17. The overlay never receives pointer events, so mouse clicks, the gizmo and OrbitControls work through it. The badge is `aria-hidden`; the reasons hand control is off are announced through the hand status line (requirement 43).
18. The overlay element exposes its state for tests: `data-testid="hand-overlay"`, `data-hand-state` (`none`, `tracked`, `hover`, `grab`, `orbit`, `locked`), `data-hand-mode` (`translate`, `rotate`) and `data-hand-target` (the settled target: `{objectId}:{partId}` for a part, `screen:{id}` for an on-screen button, or empty).

### Cursor and pinch

19. The cursor comes from a stable point of the hand, `CURSOR_POINT` (default: the midpoint of the thumb tip and the index tip, landmarks 4 and 8, where the pinch closes), and is smoothed with a One Euro filter (`CURSOR_MIN_CUTOFF`, `CURSOR_BETA`). The filter is a pure function of the point sequence and its timestamps and resets when the hand is lost.
20. The pinch distance is the distance between the thumb tip and the index tip in the metric world landmarks. A pinch **engages** when the distance stays below `PINCH_ENGAGE_M` (0.03 m) for `PINCH_ENGAGE_FRAMES` (2) consecutive tracking frames, and **releases** when it stays above `PINCH_RELEASE_M` (0.05 m) for `PINCH_RELEASE_FRAMES` (3) consecutive frames. Between the two thresholds the state does not change. A frame without world landmarks never engages a pinch; the skeleton is still drawn.
21. The pinch state machine is a pure function: (state, one tracking frame or a "no hand" frame, timestamp) → (next state, events). Its events are at least: hand found, hand lost, pinch engaged, pinch released, tap (engaged and released without leaving the dead zone of requirement 29), and, with requirement 60, double tap.

### Picking and targets

22. Hand picking has two kinds of targets. **On-screen targets** (in this spec only the hand-mode buttons of requirement 56) are checked first, in screen space, against their on-screen rectangles. If none is under the cursor, a ray is cast from the cursor's canvas position into the scene, against the same part surfaces of all objects that a mouse click uses, and the nearest hit is taken. Hand picking does not cycle through parts behind each other the way repeated clicks do. On-screen targets are a list that later specs can add to (candidate thumbnails, floating project cards) without changing the picking, pinch or settling code.
23. The **settled target** changes only after a new raw target (an on-screen target, a part, or empty space) has held for `HOVER_SETTLE_MS` (150 ms). The badge, the ring and `data-hand-target` show the settled target, and a pinch acts on the settled target at the moment it engages, so the small cursor movement while the fingers close does not change what is grabbed. The settling rule is a pure function.
24. A pinch whose settled target is a part of the **active object** selects that part alone, as a plain click does, and grabs that part.
25. A pinch whose settled target is a part of an **inactive object** makes that object active, selects that part alone, and grabs that part, all in the same gesture. Making the object active follows the workspace rules (clears the selection, resets explode, turns off the gizmo) and is not an undo step.
26. A pinch whose settled target is empty space turns the view (requirement 35). It never changes the active object or the selection.
27. A pinch whose settled target is an on-screen target presses it if the pinch is a tap (requirement 29); a drag that starts on an on-screen target does nothing. Pressing works when hand control is fully on or view-only, not when it is off. Apart from that, with no objects on stage, a pinch does nothing.
28. The decision "what does this pinch do" is one pure function of the settled target, the active object id and the hand-control gates (requirements 40–42), returning `press(targetId)`, `grab(objectId, partId)`, `orbit`, or `none`.

### Pinch-move (P0)

29. A grab becomes a drag when the filtered cursor leaves a dead zone of `DRAG_DEAD_ZONE_PX` around its position at engage. A grab released inside the dead zone is a tap: it only selects (requirements 24–25) and creates no undo step.
30. During a drag the grabbed part moves in the plane that passes through the grabbed point and faces the camera. The movement is relative to the pinch start: the cursor's offset since engage, times `DRAG_GAIN`, is converted to a world offset at the grabbed point's depth, then into the part's parent frame (its parent part, or the object root for a root part, including the object's transform), and added to the part's position at engage. The part therefore never jumps when the pinch engages. The mapping is a pure function of the camera, the parent frame's world matrix, the start position, the grabbed point and the cursor offset.
31. **Precision comes from zooming in, as with the mouse.** Because the offset is converted at the grabbed point's depth, one screen pixel is a smaller move when the camera is closer. Zooming in (mouse wheel, the zoom buttons, or the P1 double tap of requirement 61) gives finer moves. There is no separate precision mode.
32. A drag is a preview: only the part's scene node moves while the hand drags, as during a gizmo drag, and its child parts follow it exactly as they do with the gizmo. The workspace is not changed during the drag. On release the final position is committed once through the same path as the gizmo (`onTransform` → the part update of the active object), as one undo step, with the notice 已移動零件，可按「復原」回到上一步。 Child parts' stored positions stay relative to their parent and are unchanged. A drag that ends where it started commits nothing.
33. The committed position is rounded to 5 decimals, as the gizmo rounds it, and kept within ±100 m per axis (the `Part` position limit), so the commit always passes validation. The part's rotation and the object's transform are unchanged by a move.
34. During a drag the mouse gizmo cannot be dragged, and a mouse drag that is already running blocks a new pinch; the two never move the scene at the same time.

### Turning the view (P0)

35. A pinch on empty space turns the camera around the orbit target while the pinch is held: horizontal cursor movement changes the azimuth and vertical movement the polar angle, relative to the pinch start, with gain `ORBIT_DEG_PER_PX`, within OrbitControls' existing limits. It changes no data, creates no undo step, and shows no notice.
36. Turning the view by hand counts as a user view change: a later resize keeps the view instead of reframing, as after a mouse orbit, and 重設視角 frames all objects as today.

### Tracking loss and cancel

37. If the hand is lost during a drag, the preview holds still. If the hand returns within `TRACKING_LOSS_MS` (300 ms), the drag continues. Otherwise the policy constant `ON_TRACKING_LOSS` decides: `'cancel'` (default) puts the part back where it was at engage, commits nothing and shows 手部追蹤中斷，已取消這次移動。; `'keep'` commits the last preview position through the part update path as one undo step. Changing the default is a one-line change to that constant.
38. A hand lost while turning the view simply stops the turn; the view stays where it is.
39. A drag is also cancelled and the part put back, with no commit and no undo step, when, before release: grabbing turns off (hand control fully off or view-only, requirements 40–41), 手勢 is switched off, the camera turns off, the page is hidden, or the workspace changes from any other source (undo, redo, the 物件 panel, a part field, an agent `state` event, the active object changing, or the grabbed part or its object being removed or replaced).

### When hand control is off

40. Hand control is fully off (no grab, no view turning) while: try-on is active; or the measured hand-tracking rate stays below `MIN_CONTROL_FPS` (10 frames per second) for `SPEED_HOLD_MS` (2 s). It counts as fast enough again after the rate stays at or above the floor for `SPEED_HOLD_MS`. The delegate does not matter: one hand without pose may be fast enough on the CPU, and a GPU start-up failure that falls back to the CPU must not remove gestures while the rate is fine. The delegate is still shown in the debug panel (requirement 45). The skeleton is still drawn, in the locked style.
41. While an agent run is active, or while the exploded view is open (explode above 0, or still animating back to assembled), hand control is **view-only**: a pinch on empty space or on any part turns the view, and grabbing is off. In the exploded view the displayed part positions include the explode offset, so committing a hand drag would write that display offset into the model; the gizmo is disabled there for the same reason. The skeleton shows the mode colour while turning the view and the locked style otherwise.
42. Hand control returns to full control by itself when the reason ends. A pinch that is still held at that moment does nothing until it is released.
43. A hand status line (`role="status"`, `data-testid="hand-status"`, `data-state`) below the camera view shows at most one Traditional Chinese line while the camera and 手勢 are on, in this priority:

    | Situation | Text |
    |---|---|
    | tracker loading | 正在載入手部追蹤模型（第一次約 20–30 秒）。 |
    | load or track error | 手部追蹤無法使用，仍可用滑鼠操作。 |
    | tracking too slow (requirement 40) | 這台電腦的手部追蹤太慢，手勢已停用；骨架仍會顯示，請用滑鼠操作。 |
    | try-on active | (nothing: the try-on status line already shows) |
    | agent run active | 代理執行中，手勢只能轉動視角。 |
    | exploded view open | 爆炸圖開啟中，手勢只能轉動視角；收回後即可抓取零件。 |
    | drag cancelled by tracking loss (for about 4 s) | 手部追蹤中斷，已取消這次移動。 |
    | no hand seen yet | 把手舉到鏡頭前：捏合拇指與食指可抓取零件，捏住空白處可轉動視角。 |

    With the camera off or 手勢 off the line is not rendered. Design may refine the wording; the states stay.
44. The 手勢 switch, the hand mode and the hand state are session state, outside the workspace (workspace-v2 requirement 11), and are never undo steps.

### Debug statistics

45. With `?hands=debug` in the page URL, a small panel shows: delegate, tracking frames per second, mean inference time, the current pinch distance in mm, the pinch state, the settled target, and counters for drags, commits, cancels, tracking losses during drags and the longest gap during a drag in ms. Without the parameter the panel is not rendered and the counters cost nothing visible.
46. The counters stay in the browser. They are never sent to the server or a model, and never logged to the console per frame.

### Constants

47. All tuning constants live in one module and are exported by name, so tuning on a real webcam touches one file: `CURSOR_POINT`, `CURSOR_MIN_CUTOFF`, `CURSOR_BETA`, `PINCH_ENGAGE_M`, `PINCH_ENGAGE_FRAMES`, `PINCH_RELEASE_M`, `PINCH_RELEASE_FRAMES`, `HOVER_SETTLE_MS`, `HAND_LOST_MS`, `DRAG_DEAD_ZONE_PX`, `DRAG_GAIN`, `ORBIT_DEG_PER_PX`, `TRACKING_LOSS_MS`, `ON_TRACKING_LOSS`, `MIN_CONTROL_FPS`, `SPEED_HOLD_MS`, and with the P1 tasks `ROTATE_DEG_PER_PX`, `DOUBLE_TAP_MS`, `DOUBLE_TAP_PX`. Defaults stated in this document are starting points; design fixes the others.

### Testability

48. The landmark-to-screen mapping, the One Euro filter, the pinch state machine, the hover settling, the pinch decision, the drag mapping into the parent frame, the orbit mapping, the tracking-loss policy, the speed gate and (P1) the rotate mapping and double-tap detection are pure functions or small classes with no DOM, React, worker or WebGL dependency. Each has Vitest unit tests fed with synthetic landmark sequences built by a shared test helper (for example "hand at screen point p with pinch distance d at time t").
49. Unit tests cover at least: engage and release at the thresholds and frame counts; no state change between the thresholds; one-frame spikes ignored; a frame without world landmarks never engages; tap versus drag at the dead zone; a settled target that ignores a raw target held for less than `HOVER_SETTLE_MS`; the cursor drift while the fingers close does not change the grabbed target; a drag with no jump at engage; a drag on a rotated camera moves the part in the camera plane; a drag of a child part under a rotated parent and a rotated object root gives the right position in the parent frame; the same cursor offset gives a smaller move with the camera closer to the grabbed point; loss shorter than `TRACKING_LOSS_MS` continues, longer cancels, and `'keep'` commits; each gate of requirements 40–42; the landmark-to-screen mapping with a cover crop for a view wider and a view taller than the video (landmarks are already in display space, requirement 7, so the mapping has no mirror branch); an on-screen target is picked before a part behind it.
50. E2E tests never use a webcam or download a MediaPipe model. They inject a scripted fake landmark source at the tracking boundary by routing the worker URL, as `tests/e2e/arm-try-on.spec.ts` already does, and the test sends it landmark sequences (pinch, move, release, lose the hand). The app has no test-only code path for this.
51. Every e2e spec that turns the camera on uses a fake tracking worker, through one shared helper in `tests/e2e/`, so the default suite stays offline and deterministic. The only allowed change to existing spec files is installing that helper (in `workbench.spec.ts` and `visual-backgrounds.spec.ts`); `arm-try-on.spec.ts` keeps its own fake and does not change; `live-cli.spec.ts` (opt-in, `RUN_LIVE_CLI=1`) may use the real worker. If any other existing e2e test needs a change, the task stops and reports instead of editing it.
52. A new e2e spec covers at least:
    - the overlay appears with the camera on and disappears with it off;
    - the 手勢 switch: off hides the overlay and the hand status line, a pinch then does nothing and mouse picking still works; try-on still works with 手勢 off; turning the camera off and on again resets it to on;
    - hover, then pinch-drag-release moves the pinched part: only that part's position changes in `data-model-json`, a child part follows on screen (`projectPart`), `data-object-json` is unchanged, and one 復原 restores it;
    - a pinch on a part of an inactive object makes that object active, selects that part and moves it;
    - a tap selects without an undo step (復原 stays as it was);
    - a pinch on empty space turns the view (`data-camera-position` changes) and leaves `data-model-json` and `data-object-json` unchanged;
    - a hand lost mid-drag for longer than `TRACKING_LOSS_MS` puts the part back;
    - the exploded view and an active agent run make it view-only;
    - a fake tracker that answers slower than `MIN_CONTROL_FPS` locks hand control with the 「太慢」 notice, while a CPU `ready` at a good rate keeps hand control on;
    - `?hands=debug` shows the panel;
    - no gesture makes a `/api/generate`, `/api/edit` or `/api/agent` request.

### Compatibility

53. With the camera off the workbench looks and behaves exactly as today. With the camera on and no hand in view it behaves as today plus the 手勢 button, the overlay canvas and the hand status line.
54. Every existing e2e spec passes, with only the change allowed by requirement 51. Existing unit tests pass unchanged, including `tests/unit/arm-pose.test.ts`.
55. Mouse picking, Shift-click, click cycling, the gizmo and its 拖曳移動 / 拖曳旋轉 buttons, OrbitControls, the zoom buttons, 重設視角 and the keyboard shortcuts keep working while the camera is on, except for the key change of requirement 56.

### Rotate mode (P1)

56. A second hand mode, 旋轉, rotates the grabbed part instead of moving it. The hand mode is its own session state, default 移動, separate from the gizmo's `transformMode` (decision 2). Switching it works by hand alone:
    - Two buttons, 手勢移動 and 手勢旋轉, are drawn in a top corner of the camera view while the camera and 手勢 are on. They are on-screen targets (requirement 22): a pinch tap on one switches the mode, with the same settling and pinch rules as parts, and the ring and badge show when the hand is over one.
    - They are also real buttons for the mouse and the keyboard, with `aria-pressed`, so they stay accessible. They are large enough to hit with the hand cursor (at least 88 × 48 CSS pixels).
    - The keys G (移動) and R (旋轉) are optional shortcuts while the camera and 手勢 are on and focus is not in a text field. Because R means 重設視角 on the focused 3D canvas today, that shortcut moves to the Home key; the 重設視角 button is unchanged.

    The mode resets to 移動 when the camera turns off. If rotate mode is cut, none of this is added.
57. In 旋轉 mode a drag rotates the part about its own origin, relative to the pinch start: horizontal cursor movement turns it about the world up axis, vertical movement about the camera's horizontal axis, with gain `ROTATE_DEG_PER_PX`. The result is expressed as the part's rotation in its parent frame, in XYZ Euler degrees rounded to 2 decimals and within ±360°, and committed once on release through the same part path as the gizmo, as one undo step, with the notice 已旋轉零件，可按「復原」回到上一步。 The part's position is unchanged and its child parts follow it. Preview, dead zone, tracking loss, cancel and gates work as for moving.
58. The skeleton colour, the badge (手勢：旋轉 …) and `data-hand-mode` follow the mode. A mode change during a drag applies to the next grab, not to the current one.
59. The new buttons' accessible names do not match existing test selectors (拖曳移動, 拖曳旋轉, 復原, 重做, 重設視角, 載入示範模型, and the others listed in workspace-v2 requirement 34). E2E covers: a pinch tap on 手勢旋轉 switches the mode (`data-hand-mode`, `aria-pressed`) and a following drag changes only the pinched part's rotation, with one 復原 step; a drag that starts on a mode button changes nothing; a mouse click and the R and G keys switch the mode; Home resets the view on the focused canvas.

### Double-pinch zoom (P1)

60. Two taps (requirement 29) within `DOUBLE_TAP_MS` whose positions are within `DOUBLE_TAP_PX` of each other form a double tap. The first tap still acts as a tap; nothing waits to tell a single tap from a double tap.
61. A double tap on a part frames that part: the orbit target moves to the part's centre and the camera distance fits the part's bounds, with the zoom limits widened as needed. A double tap on empty space frames all objects, as 重設視角 does. Both are display only: no data change, no undo step. The mouse wheel and the zoom buttons keep working. E2E covers a double tap on a part (the part projects near the canvas centre, `data-model-json` unchanged, 復原 unchanged) and a double tap on empty space (the view returns to the framing of 重設視角).
62. A double tap is allowed in view-only states (requirement 41) and is off when hand control is fully off (requirement 40).

## Non-functional requirements

63. **Privacy.** The camera image and the landmarks stay in the browser. No frame, landmark, gesture or debug counter is sent to the local server or to a model back end. The hand and pose model files are downloaded from Google's public model storage when tracking first starts (today: when try-on starts); README says so in its privacy section.
64. **Speed.** Gestures never wait for the server or a model (VISION §4.6). A tracking frame causes no React re-render unless the hand state, the settled target, the mode or the status changes. The scene re-renders only when a drag, a view turn or a highlight change needs it; the overlay is a separate 2D canvas.
65. **Dependencies.** No new dependency. The One Euro filter and the gesture logic are small local code; MediaPipe Tasks Vision 1.2.2 and Three.js are already there.
66. **Resources.** The worker, its models, any `OffscreenCanvas` and every listener are released when the camera turns off and on unmount. Three.js resources follow the existing `disposeObject` rule.
67. **Tests.** Every task has Vitest unit tests; pure modules are tested in Node; no jsdom or happy-dom is added. Tests never call a real model back end, and no test needs a webcam (requirements 48–52).
68. `npm run check` (type check + build + unit tests) passes before a task is marked done, and the real result is reported.
69. Spec, design, task files and code comments are English; user-facing strings are Traditional Chinese, with no mixed languages on one screen.
70. README gets a short "hand control" section: turn the camera on, the 手勢 switch, the pinch gestures (grab a part, turn the view), zooming in for finer moves, the off and view-only states, and `?hands=debug`. The project still installs and runs from the README alone.
71. `tasks.md` has at most 7 tasks, each small enough for one fresh Kiro session with Claude Sonnet 5.5 (roughly one module plus its tests), with "Read first", "Build", "Tests", "Done when" and "Session facts" as in `workspace-v2`. The P1 tasks are last: rotate mode, then double-pinch zoom. Cut order if time runs short: double-pinch zoom first, then rotate mode; the overlay, the 手勢 switch, pinch-move and orbit stay. `design.md` maps every requirement to a task.
72. The last P0 task ends with a short manual test list for the user's own laptop webcam (normal and dim light, the 手勢 switch, pinch-move of a part at two zoom levels, orbit, a deliberate tracking loss, the debug counters), so the user can decide whether to tune constants or flip `ON_TRACKING_LOSS`. Each P1 task adds the lines for its own gesture, so the list stays complete whichever tasks are cut.

## How later specs fit (not built here)

- **body-fit:** subscribes to the shared tracking (requirement 4) instead of starting its own worker, requests pose through the same switch try-on uses (requirement 3), and can show the overlay to debug try-on tracking.
- **Object mode** (like Blender's Object Mode): a hand mode in which a pinch grabs the whole object instead of the part and commits through the workspace `setTransform` operation, one undo step per drag. It adds a grab kind to the pinch decision (requirement 28) and a mode button; the drag mapping (requirement 30) works unchanged in the object's parent frame, which is the world.
- **Parts in the exploded view:** grabbing a part while exploded, either committing the move without the explode offset or pulling the part out for display only (VISION §1 step 4, "pull individual parts out to look at them").
- **candidates-tray** and **projects-memory** (floating cards): thumbnails and cards register as on-screen targets (requirement 22) with their own press action; the cursor, the pinch state machine, the settling and the picking order are reused unchanged.
- **english-ui:** the badge, status and debug strings are plain string tables, replaced like the rest of the UI.
- **Voice or agent mode switching:** sets the same hand-mode state (requirement 56) and the 手勢 switch.
- **A later 尺寸 mode** (VISION §4.9) adds another hand mode with its own drag mapping and a live mm readout.
- **Experimental: the finger chooses the mode.** A thumb–middle-finger pinch rotates and a thumb–index pinch moves, so no mode switch is needed. Try it only after the pinch thresholds are tuned on the user's webcam: the middle-finger pinch is a second distance on the same state machine, but two pinches close to each other may be confused by the tracker.

## Decisions from review

The decisions were reviewed on 2026-11-15, in two rounds. The requirements above already reflect the outcome.

1. **Rejected: a pinch moves the whole object.** A pinch on a part moves that part (requirements 24–25, 29–34, 37, 39). The user prefers part-level moves, as in Blender, through the same commit path as the mouse gizmo (`onTransform` → the part update; the position is in the parent part's frame and child parts follow). Precision comes from zooming in, as with the mouse (requirement 31). A pinch on a part of an inactive object makes the object active, selects that part and grabs it in the same gesture; activation is not an undo step. Whole-object moves by hand are out of scope and come later as an object mode.
2. **Accepted with a change: a separate hand mode, switched by hand.** The hand mode is its own session state, default 移動, not the gizmo's `transformMode`: that one defaults to `null`, is reset when the active object changes, when the exploded view opens, on Escape and on some undos, and its buttons appear only with exactly one part selected. Switching must work by hand alone, so the mode buttons are on-screen targets in the camera view that a pinch tap presses, and also real buttons for the mouse (requirement 56). This made hand picking two-kind (on-screen targets first, then parts), designed so later specs can add targets (requirement 22). G and R stay as optional keyboard shortcuts, so 重設視角's shortcut moves from R to Home. All of it belongs to the P1 rotate task; if rotate mode is cut, no mode control is added.
3. **Accepted: view-only in the exploded view and during an agent run.** Turning the view changes no data, so it stays allowed there; grabbing is off (requirement 41). In the exploded view grabbing would also commit the explode offset into the model.
4. **Accepted with a change: "too slow" is measured only.** Hand control is fully off when the rate stays below `MIN_CONTROL_FPS` (10) for `SPEED_HOLD_MS` (2 s), whatever the delegate (requirement 40). Below about 10 fps the 2- and 3-frame pinch hysteresis alone takes 200–300 ms, and a drag visibly stutters. The CPU delegate alone no longer turns hand control off (changed in the design review): one hand without pose may be fast enough on the CPU, and a GPU start-up failure that falls back to the CPU should not remove gestures while the rate is fine.

Also changed in review: the status line says 代理 instead of AI 助理 (requirement 43); the badge keeps the part name, shortened after 12 characters (requirement 16); a 手勢 switch was added (requirements 8–11); an experimental finger-chooses-the-mode variant was listed under "How later specs fit".

## Decisions to confirm

None.