# Body fit: millimetres, a fit map and the agent that makes it fit — Requirements

> Status: draft for review, 2026-11-26. Written from `docs/VISION.md` §4.11 (decided with the user on 2026-11-25), capability C10 in §2, §3.1, the demo path in §5 and the risk "Try-on quality today (C10)" in §6. The open decisions are listed at the end; `design.md` and `tasks.md` build on this draft and follow the recommendations until the user decides otherwise.

## Overview

Today's try-on (`src/try-on/`, `src/scene/arm-preview.ts`) draws a fixed stand-in cuff on the forearm. Its size is in knuckle widths (`palmWidth` in `ArmPose`), not millimetres; it never shows the user's design; the far side is masked by a tapered proxy cylinder (`occluder` in `createArmPreview`), not by the real arm; and in the author's test of 2026-11-13 the forearm tracking still lost the arm and the cuff did not feel worn (VISION §6). The agent tool `wear_on_arm` (`server/tools/wear-on-arm.ts`) says so honestly: 「目前顯示預設護臂，尚未套用你的設計」.

This spec turns try-on into **body fit** (C10): the user's own object from the workspace sits on their wrist at true size, the wrist is measured in millimetres, the workbench shows per angle where the object presses, fits or is loose, and the agent changes the design until it fits. The deepest case for Forgehand is an object that has to fit a body (VISION §4.11, "Positioning"), so this is the step of the demo path between joining the parts and exporting the printable kit (VISION §5): 「put it on my wrist, measure the wrist and see the fit map → ask the agent to make it fit and watch the map turn green → export the printable kit → the printed bracelet on the real wrist」.

Everything that sees the camera runs in the browser. Model back ends receive only text and model data.

**Numbering.** Requirement numbers are stable ids, because `design.md` and `tasks.md` refer to them. Priorities: P0 hand and wrist (R1–R86), P1 head (R87–R98), P2 foot (R99–R107), as VISION §2 C10 decided.

## Goals

- Every size the fit uses is in millimetres and always shown with where it came from: 相機估計, 卡片校正 or 捲尺.
- The wrist is measured as an ellipse (width and thickness) from the camera, and the user can check it against a tape measure.
- Any object from the workspace can be worn on the wrist at true size, moved along the arm and tilted by hand.
- The user sees per angle whether the object presses, fits or is loose, with numbers, and the colours never carry the state alone.
- The worn object looks worn: the real arm hides its far side, it casts a soft contact shadow, and its brightness follows the video.
- The agent can make the design fit from the measurement and a chosen clearance, and the map turns green.
- The fit maths is covered by property-based tests.
- The user validates it on their own body: camera estimate versus tape, and a printed bracelet worn on the real wrist.
- Head-worn objects (P1, after a spike) and a coarse foot anchor (P2) reuse the same measurement and fit model.
- No regression: with the camera off, or with fitting off, the workbench behaves as today.

## Out of scope

These items are placed elsewhere by `docs/VISION.md`; nothing here is cut for time.

- Toe-level foot fit (VISION §3.1: "Toe-level fit is out of reach"); the foot anchor is coarse by design (R99–R107).
- A body avatar or full-body measurement (C13, P2, its own spec).
- SMPL-style body models (VISION §3.1: licences restrict commercial use).
- Rings on a finger (VISION §4.11 "Later": "Rings can reuse the same method on a finger").
- Scanning a real object (C12) and sending any image to a model back end.
- Saving measurements across sessions in project or shared memory (C17, cut on 2026-11-19 apart from save and reopen; see decision 5).
- The full-screen layout, the panels' placement and the agent data card frame: `workbench-ui` owns them (R80–R82).
- The `shell` primitive itself: `design-fidelity` adds it (R84).
- English strings: `english-ui` translates them later (R83).
- Printing. The user prints the fitted bracelet with the kit from `export`; this spec only exports through the existing dialog.

## Functional requirements

### Starting and stopping body fit

1. A 試戴 toggle button (`type="button"`, `aria-pressed`) starts and stops body fit on the wrist. It replaces today's 護臂試戴 button (decision 4). It is disabled while an agent run is active, like today's button, and when the workspace has no object, with the title 「請先建立或載入一個物件。」.
2. Starting body fit turns the camera on if it is off, exactly as `toggleTryOn` in `src/App.tsx` does today, and wears the **active object**. The fit panel (R76) lets the user wear another object of the workspace.
3. Body fit is session state: it is not in the workspace, it is never an undo step, and it ends when the camera turns off, when the worn object is removed from the workspace, or when the user presses 試戴 again.
4. While body fit is on, the worn object is hidden on the stage of the 3D scene (display only; the `ModelSpec` and the transform are unchanged) and drawn on the wrist instead (R33). It reappears on the stage when fitting stops.
5. Body fit reuses the shared tracking of `hand-manipulation`: one worker (`src/try-on/arm.worker.ts`), the `HandSource` of `useHandTracking`, and pose requested through `wantPose`, as try-on does today. It never starts a second worker.
6. Hand control stays off during body fit, as `handGate` already decides for try-on (`hand-manipulation` R40, reason `try-on`). The adjustment gestures of R37–R41 are body fit's own and run only while body fit is on.

### Scale: millimetres with an honest source

7. **Three scale sources.** Every length the fit uses has one of three sources, stored with the value:
   - **相機估計** (`estimate`): from the metric hand world landmarks. Their scale comes from a statistical hand model, so an unusual hand size shifts it.
   - **卡片校正** (`card`): calibrated with an ID-1 card (85.60 × 53.98 mm, ISO/IEC 7810) held at the wrist inside a guide frame (R11–R17).
   - **捲尺** (`tape`): typed in from a tape measure or a paper strip (R25–R28). This is the most accurate source and the check for the other two.
8. Every number shown in the fit panel, the fit card and the agent's tool results carries its source next to it, for example 「手腕 165 mm（相機估計）」. A number is never shown without its source.
9. **Estimate.** The image scale at the wrist (mm per frame pixel) is the ratio of metric to image length over the palm bones, the method `screenPalmWidth` in `src/try-on/arm-pose.ts` already uses for the cuff (`SCALE_BONES`), converted to millimetres. It is smoothed over time and shown with its spread (R73).
10. When the card calibration has been done in this session, its correction factor (R15) multiplies every estimate, and the source of every camera-measured length becomes 卡片校正.

### Card calibration

11. 卡片校正 in the fit panel shows a guide frame over the camera view, drawn at the wrist of the worn side, oriented along the forearm, and sized to the card as the current estimate expects it. A short instruction says 「把一張信用卡大小的卡片平貼在手腕背面，長邊沿著手臂，對齊框線。」.
12. The guide frame follows the wrist while the user positions the card. When the card is inside the frame and the hand is still for `CARD_STILL_MS` (1 s), the browser freezes the current frame on screen (the still frame is drawn in the browser only and never leaves it; R108).
13. On the frozen frame, the card's edges are found automatically inside the guide (decision 9). The found edges are drawn over the still frame, and the user can drag each of the four edges to correct them, by mouse or by keyboard (arrow keys move the focused edge by 1 px). 確認 accepts, 重拍 unfreezes and tries again, 取消校正 leaves the calibration unchanged.
14. When automatic detection finds no card with enough contrast, the guide is placed at the expected card size and the notice 「沒有自動找到卡片邊緣，請手動拖曳四條邊對齊卡片。」 is shown.
15. Accepting computes the **correction factor** `k`: the card's millimetres per pixel (85.60 mm over the long edge, 53.98 mm over the short edge, averaged, with the depth correction of design §6.3) divided by the estimate's millimetres per pixel measured on the same frame. `k` applies from then on (R10).
16. A factor outside `CARD_K_MIN`–`CARD_K_MAX` (0.75–1.33), or a card whose measured aspect ratio differs from 85.60 / 53.98 by more than `CARD_ASPECT_TOLERANCE` (6 %), is rejected with 「卡片尺寸量起來不合理，請讓卡片平貼並正對鏡頭後重拍。」 and `k` stays unchanged.
17. The result line shows the factor in plain words, for example 「校正完成：相機估計原本偏大 4%。」, and 清除校正 returns to 相機估計.

### Wrist width and thickness

18. **Model.** The wrist cross-section is an ellipse with width `w` (thumb side to little-finger side) and thickness `t` (back of the hand to the palm). Thickness is typically 0.6 to 0.7 of width (VISION §4.11).
19. **Mask.** Width and thickness are read from the body-skin class (index 2) of the MediaPipe multiclass selfie segmenter (`selfie_multiclass_256x256.tflite`, decision 2), run in the tracking worker on a crop around the wrist (design §4.2). The mask never leaves the worker and the page (R108).
20. **Line across the forearm.** On each measured frame the width is read along lines across the forearm axis (perpendicular to it on screen) at offsets along the arm from `PROFILE_MIN_MM` (−20 mm, toward the hand) to `PROFILE_MAX_MM` (+60 mm, toward the elbow) every `PROFILE_STEP_MM` (5 mm), measured from the band's default position (R30). The width at an offset is the skin run that contains the forearm axis, with sub-pixel edges from the mask's confidence.
21. **Guided steps.** 量手腕 runs these steps, each with a picture-free text instruction and a progress ring:
    1. 「手掌朝向鏡頭，手腕放鬆，保持不動。」 gives the width profile.
    2. 「把手腕轉 90°，讓拇指朝上。」 gives the thickness profile from the same lines.
    3. Only when the worn object is a closed ring (R47): 「把拇指收向小指，手掌朝向鏡頭。」 gives the hand's passage width at the knuckles.
22. A step records only while its pose holds: the palm normal (from the world landmarks) within `PALM_FACING_DEG` (25°) of the camera axis for step 1 and 3, within 25° of perpendicular to it for step 2, the forearm axis within `FOREARM_FLAT_DEG` (30°) of the image plane, and the wrist still (speed below `STILL_MM_PER_S`, 15 mm/s). While the pose does not hold, the step says what to change (「請把手掌正對鏡頭」, 「請把手腕轉成拇指朝上」, 「請把手臂放平，和螢幕平行」, 「請保持不動」).
23. A step completes after `MEASURE_FRAMES` (7) accepted frames. Each offset's value is the median of its frames; frames further than 3 median absolute deviations from the median are dropped. If fewer than 5 frames remain, or the spread (R73) of the width at the band position is above `MEASURE_SPREAD_MM` (3 mm), the step says 「量測不穩定，請保持不動再試一次。」 and restarts.
24. The result shows width, thickness and the ellipse circumference at the band position, each with its source, for example 「寬 58 mm · 厚 39 mm · 周長 155 mm（相機估計）」, and a 重新量測 button. The circumference is the ellipse perimeter (design §6.1).

### Tape measure

25. 捲尺輸入 accepts the wrist circumference in millimetres or centimetres (a unit switch, default mm), from 100 to 300 mm, and optionally the width and thickness from 30 to 120 mm. A value outside the range is refused with 「請輸入 100–300 mm 之間的數值。」 (or the range of the field).
26. With a tape circumference, the fit uses it: the camera's ellipse shape (the ratio `t / w`) is kept and scaled so its perimeter equals the tape value; with no camera shape, `t = 0.65 w` (`DEFAULT_THICKNESS_RATIO`) is assumed and labelled 「厚度依一般比例估計」.
27. When both a camera measurement and a tape value exist, the panel shows the camera estimate's error against the tape, for example 「相機估計 155 mm，捲尺 165 mm，相機偏小 10 mm（6.1%）」. This is the validation number of R111.
28. Typed values are shown with source 捲尺 and are used instead of the camera values they replace.

### Wearing any designed object

29. **Ring axis.** The worn object's ring axis is found from its parts (design §6.4): the `tube` or `torus` part with the largest inner diameter between `RING_MIN_MM` (35 mm) and `RING_MAX_MM` (130 mm) gives the axis and the centre; with no such part, the object's smallest bounding-box axis through the box centre is used. The fit panel shows which was used (「依零件「錶帶」的環形定位」 or 「依物件外形定位」) and lets the user pick another tube or torus part, or another axis (X, Y, Z), as 環形零件.
30. **Default placement.** The ring axis lies along the forearm; the object's face (design §6.4: the direction from the ring centre toward the bulk of its other exterior parts, else the object's +Y) points to the back of the hand; the band centre sits `DEFAULT_BAND_OFFSET_MM` (20 mm) from the wrist landmark toward the elbow, just past the wrist bone (the ulnar styloid) where watch makers place a case without pressing on it.
31. The anchor follows the worn wrist on every rendered frame with the smoothing and prediction of R42–R46. The worn side is chosen when body fit starts (the hand `ArmTracker` locks first) and shown as 戴在左手 or 戴在右手, with a switch.
32. **True size.** The object is drawn at its real size: model metres times 1000 give millimetres, and the scale of R7–R10 gives screen size. It never uses knuckle-width units.
33. **Look.** While worn, the object is drawn opaque, lit, in its part colours (decision 11), not in the hologram style of `src/scene/style.ts`.
34. **Mirror.** When the video is shown mirrored (`data-mirrored="true"`), the worn object is drawn mirrored too, so it matches what a real mirror would show. The fit maths always works in unmirrored body coordinates.
35. **Placement values.** The placement is three values in session state: 位置 (slide along the arm, −40 to +60 mm from the default), 傾斜 (tilt about the axis across the wrist, −30° to +30°) and 轉動 (turn about the forearm, −180° to +180°). The fit panel has a number field and ±buttons for each, and 回到預設位置.
36. Placement changes never change the workspace and are never an undo step (R3).

### Moving and tilting by hand

37. While body fit is on, the **other hand** (not the worn one) can adjust the placement. A pinch (the thresholds of `src/hands/constants.ts`: engage below `PINCH_ENGAGE_M`, release above `PINCH_RELEASE_M`, counted in time) that starts within `ADJUST_REACH_MM` (60 mm on the wrist's scale) of the worn object grabs it.
38. Dragging along the forearm on screen slides the object (位置) by the dragged distance in millimetres at the wrist's scale, so 1 cm of hand motion along the arm moves it 1 cm. Dragging across the forearm tilts it (傾斜) by `TILT_DEG_PER_MM` (0.5°/mm). The first `ADJUST_DEAD_ZONE_MM` (4 mm) of motion picks the direction, so one drag is either a slide or a tilt.
39. A fist of the other hand twisted like a knob (the fist detection of `src/hands/fist.ts`, the roll measure of `hand-manipulation` Task 11) turns the object about the forearm (轉動), one degree per degree of twist.
40. While adjusting, a short badge next to the object says 「調整位置 +12 mm」, 「調整傾斜 8°」 or 「轉動 30°」. Release keeps the value. Tracking loss of the adjusting hand for longer than `TRACKING_LOSS_MS` keeps the value reached (an adjustment is not a design change, so there is nothing to revert).
41. The adjusting hand never moves the anchor: the anchor follows only the worn wrist (R31).

### Tracking stability

42. The anchor's position, forearm direction and roll are each smoothed with a One Euro filter (`src/hands/one-euro.ts`) tuned for a still wrist, and predicted past the recognition delay as `createArmPreview.update` does today (`MAX_PREDICT_MS`).
43. Once the wrist is measured, the on-screen size comes from the measurement and the smoothed scale, not from the frame-to-frame palm width, so the object does not grow and shrink with landmark noise.
44. A brief loss of the worn hand (up to `FIT_HOLD_MS`, 600 ms, or two tracking intervals at the measured rate, whichever is longer) keeps the object in place with a frozen pose; after that it fades out over 180 ms, as the cuff does today. It reappears without a jump when the hand is found again.
45. The fixes for the jumps found in `docs/PRIOR_WORK.md` stay in force: the hand-axis and elbow directions are blended (`ELBOW_BLEND_MS`), a hand-only side change must hold `SIDE_SWITCH_FRAMES`, and half-turn roll flips are rejected (`ROLL_FLIP_DOT`). The worn side is locked: a second hand never takes the anchor over (R31).
46. **Measured on recordings.** A landmark recorder (`?fit=record`) saves the tracked landmark frames (no image, no mask) of a session to a JSON file through a download the user starts. A replay tool runs a recording through the anchor in Node and reports: the share of hand frames with a placed object, the 99th-percentile frame-to-frame rotation, the RMS jitter of a still wrist in millimetres, and the spread of the scale. The targets are R75. Recordings are never committed (decision 13).

### Fit map and numbers

47. **Closure.** The object is a **closed ring** (the inner profile is closed all around), an **open ring** (an opening wider than `OPEN_GAP_DEG`, 15°) or **no ring** (no part surrounds the axis). The user can mark a closed ring as 有扣環或可打開 (it opens to put on); the panel shows 開合方式 with these three choices.
48. **Inner profile.** For `FIT_ANGLES` (72) angles around the ring axis and `FIT_SLICES` (3) slices across the band width (both edges and the middle), the distance from the axis to the first solid point of any part of the object is computed from the parts' primitives in the object's own frame (design §6.4). This works for every primitive, including the `shell` primitive once it exists (R84).
49. **Arm section.** The arm's cross-section at each slice comes from the measured width and thickness profiles (R20) at that slice's position along the arm, widened by the tilt (design §6.2).
50. **Gap.** For each angle, the gap is the inner profile's distance minus the arm section's distance in the same direction, taking the smallest over the slices. A positive gap is room; a negative gap is overlap.
51. **Classes.** Each angle is one class:
    - **合適** (green, `#009E73`): gap from 0 to the chosen clearance's radial gap (R55) plus `LOOSE_MARGIN_MM` (2 mm).
    - **壓迫** (red, `#D55E00`): gap below 0.
    - **偏鬆** (amber, `#E69F00`): gap above the green range: loose enough to slide.
    The hues are the Okabe–Ito palette, readable with the common forms of colour blindness.
52. **Cannot pass.** A closed ring without a clasp whose inner perimeter is smaller than the hand's passage perimeter (from step 3 of R21, or typed) is **套不過手掌**: the whole map is red, and the panel says 「封閉手環的內圍小於手掌最寬處，戴不進去。可加大內圍或改成有扣環。」.
53. **On the object.** The map is drawn on the worn object as a coloured ribbon along the inner rim at both band edges, coloured per angle, hidden behind the real arm like the object (R58).
54. **Numbers.** The panel shows, each with its source: inner perimeter, wrist circumference and spare, for example 「內圍 180 mm · 手腕 165 mm（捲尺）· 餘量 15 mm」; the tightest point with its gap and side, for example 「最緊 1.5 mm（手背側）」; the loosest; and the angle ranges of each class, for example 「壓迫：拇指側 60°–110°」. Sides are named 手背側 (0°), 拇指側 (90°), 掌心側 (180°) and 小指側 (270°), with 0° at the back of the hand. An open ring shows 「開口 40°（小指側）」 instead of an inner perimeter; a non-ring object shows 「這個物件沒有環繞手腕的部分，只顯示位置。」 and no map.
55. **Clearance.** The fit panel offers 貼合, 舒適 and 寬鬆 (`CLEARANCE_PRESETS_MM`: 6, 13 and 25 mm of circumference, decision 10) and 自訂 (0 to 40 mm). The default is 舒適. The radial gap of a clearance is the uniform outward offset of the wrist ellipse that adds that much perimeter (design §6.2).
56. **Fit dial.** Next to the numbers, a small diagram draws the wrist ellipse and the inner profile seen along the arm, coloured per angle with the same classes, with the side names; it has a text alternative listing the class ranges. The same diagram is used by the fit card (R69).
57. The fit (profile, gaps, classes, numbers) is recomputed when the model, the placement, the measurement, the clearance or the closure changes, never per tracking frame.

### Looks worn

58. **Occlusion by the real arm.** The far side of the worn object is hidden where the real arm covers it: a depth proxy of the measured arm (the elliptic profile of R20; before a measurement, the default profile of design §6.5) is drawn depth-only, and only where the segmentation mask shows body skin or clothes (classes 2 and 4) at that screen point. The near side stays drawn over the arm. `DEFAULT_BACK_OPACITY` (0.3, today's constant in `src/scene/arm-preview.ts`) keeps a faint far side; `?armBack=0..1` still overrides it (decision 12).
59. The mask is moved with the predicted wrist between segmenter results, so it does not lag behind a moving arm. A mask older than `MASK_MAX_AGE_MS` (1.5 s) is not used; the proxy then hides the far side alone, as today.
60. **Contact shadow.** A soft dark band is drawn on the skin just beyond both band edges and under the object, strongest where the gap is smallest, fading over `SHADOW_WIDTH_MM` (6 mm), and only where the mask shows skin or clothes.
61. **Brightness.** The worn object's lighting follows the brightness of the video around the wrist: the mean luma of the wrist crop (design §4.2) scales the light intensity between `LIGHT_MIN` (0.4) and `LIGHT_MAX` (1.6) of the default, smoothed with `LIGHT_TAU_MS` (500 ms).
62. The canvas exposes for tests `data-fit-occlusion` (`mask`, `proxy` or `off`), `data-fit-shadow` (`on` or `off`) and `data-fit-light` (the current factor, two decimals).

### Agent

63. **`attach_to_body`.** A server tool `attach_to_body({ objectId: string | null, anchor: 'wrist' | 'off' })`, label 試戴, category `body`, effect `uses-camera`, replaces `wear_on_arm` (decision 4). `objectId` null means the active object. It never starts the camera: with the camera off it returns 「請先開啟攝影機再試戴。」 like `wear_on_arm` today. Errors: `NO_MODEL`, `UNKNOWN_OBJECT`. P1 adds `head` (R96) and P2 adds `foot` (R106) to the enum; a value is registered only when it is built, so the model never sees an anchor that does not exist.
64. Its state change sets `tryOn` (true for an anchor, false for `off`) and a new optional, nullable session field `StateChange.bodyFit: { anchor, objectId }`, so existing payloads stay valid. Like `tryOn`, it never changes the workspace and is never an undo step.
65. **The request carries the measurement.** While body fit is on, the browser sends an optional `body` field in the agent request (decision 6): the worn side, the wrist width, thickness and circumference with their sources, the profile at the band position, the passage width, the placement, the closure, the ring part and the current fit summary (R54). Never an image, a mask or landmarks.
66. **`fit_to_body`.** A server tool `fit_to_body({ objectId: string | null, clearance: 'snug' | 'comfort' | 'loose' | null, clearanceMm: number | null, ringPartId: string | null })`, label 調整尺寸, category `body`, effect `writes-scene`. It changes the design so that the inner perimeter is the wrist circumference plus the clearance (default the panel's clearance, else 舒適), with the inner shape following the wrist ellipse, and for a closed ring without a clasp at least the passage perimeter (design §6.6). Errors: `NO_MODEL`, `UNKNOWN_OBJECT`, `NO_MEASUREMENT` (「還沒有手腕尺寸。請先在試戴面板量測手腕或輸入捲尺數值。」), `NO_RING` (no ring part and no axis), `FIT_OUT_OF_RANGE` (the new sizes break `PartSchema` limits).
67. **How it changes the design (decision 7).** When the ring is a `tube` or `torus` part, the tool resizes it locally and moves the parts attached to it outward by the same amount (design §6.6), with no model call: one `object` change of op `model`, like `edit_design`, so it is one undo step. Otherwise it calls the edit task (`editTask` in `server/provider.ts`) with a generated instruction that states the target inner width and thickness in millimetres and the axis, then checks the result with the same fit maths.
68. Its result reports the fit before and after, computed by the shared fit functions, never stated by the model: 「已調整：內圍 171 mm，手腕 165 mm（捲尺），餘量 6 mm（貼合）。全部角度合適。」. If the result still has a red or amber angle, the summary says which side and offers another try.
69. **Fit card.** The tool result's detail is a fit summary before and after (`FitToBodyDetail`). The browser shows it as a fit card: the numbers of R54 for before and after and the fit dial of R56 (R82).
70. The browser applies the state change of `fit_to_body` through the existing agent path (`src/agent/apply-state.ts`), and the fit map recomputes (R57), so the map turns green on screen without a new measurement.
71. **調整為合適尺寸.** The fit panel has a button that runs the same local resize of R67 in the browser, without the agent, as one undo step (decision 8). For a ring that is not a tube or torus, the button is disabled with the title 「這個形狀請交給 AI 調整。」 and the panel suggests asking the agent.
72. `AGENT_INSTRUCTIONS` says, in English: `attach_to_body` shows the user's own object on their wrist; sizes are estimates unless their source is card or tape, and the agent must name the source when it quotes a size; the agent cannot measure, the user measures in the fit panel; `fit_to_body` needs a measurement; after `fit_to_body`, report the fit numbers from the tool result.

### Feedback and debug

73. **Spread.** Every camera-measured value has a spread: the median absolute deviation of its frames, times 1.4826, in millimetres. The panel shows it after the value, 「± 1.2 mm」.
74. `?fit=debug` shows a debug line under the fit panel: tracking rate, segmenter time and interval, mask age, scale source and factor `k`, current scale spread, anchor jitter over the last 2 s, and the fit recompute time.
75. **Stability targets** (checked on the user's recordings, R46): at least 98 % of hand frames place the object; 99th-percentile frame-to-frame rotation at most 20°; still-wrist RMS jitter at most 2 mm; scale spread at most 3 % over a 10 s still hold. They are reported, not enforced; if a target is missed, the user decides whether to tune.

### Panel and texts

76. **Fit panel.** One panel holds, in this order: the worn object and side; 尺寸來源 with the current source; 量手腕; 卡片校正; 捲尺輸入; 環形零件 and 開合方式; 位置, 傾斜, 轉動; 餘量 (clearance); the numbers and the fit dial; 調整為合適尺寸; and 結束試戴. Sections that do not apply (卡片校正 before any measurement step can run, 開合方式 for a non-ring object) are disabled with a short reason.
77. The panel exposes for tests: `data-fit-state` (`off`, `loading`, `searching`, `worn` or `error`), `data-fit-source` (`estimate`, `card` or `tape`), `data-fit-summary` (JSON of the fit summary) and `data-fit-step` (`idle`, `width`, `thickness`, `passage`, `card` or `done`).
78. The fit status line replaces today's try-on status line (`data-testid="try-on-status"`, same test id and `data-state` values `off`, `loading`, `searching`, `tracking`, `load-error`, `track-error`), with fit texts; `try-on-stats` keeps its format.
79. New accessible names avoid the texts existing tests select without `exact`: not 取消, 取消選取, 取消這次生成, 取消接合, 刪除零件, 刪除物件, 復原, 重做, 載入示範模型, 生成 3D 草案, 關閉匯出 or 匯出套件.

### Dependencies on other specs

80. **workbench-ui: panel slot.** Body fit needs a slot for the fit panel (about 320 px wide, scrolls, visible together with the camera view and the agent panel) that appears only while fitting. Until the slot exists, the panel renders in the control column above the agent panel, as the export dialog does today.
81. **workbench-ui: overlay layer.** The card guide (R11–R14), the measuring line and the adjustment badge (R40) need a layer over the camera view, in the video's coordinates (`coverFrameBounds`), above the 3D canvas and below the hand overlay, that receives pointer events only inside the guide. Until it exists, body fit adds its layer inside `.viewport`.
82. **workbench-ui: agent data card.** The fit card (R69) needs the agent data card slot: a component that takes a validated tool detail and renders it on the video or in the agent panel. Until it exists, the fit panel shows the latest fit card under its numbers.
83. **english-ui.** All new user-facing strings live in one table, `shared/fit-text.ts`, used by the browser and the server tools, so `english-ui` replaces one file.
84. **design-fidelity: `shell`.** The fit needs, for every primitive, a pure inside test in the part's local frame that matches `createPartGeometry`. For `shell` (a closed hollow box), the outer box is what touches the skin, so the fit treats `shell` like `box`; the enclosed void is never reachable from the ring axis. What body fit needs from `design-fidelity` is therefore: the `shell` dimensions mean the outer size, and the `shell` row in the fit's per-primitive table (`Record<Primitive, …>`, the same pattern as `shared/joint.ts`). Until `shell` lands, nothing changes; when it lands, the type check fails until the row (as `box`) is added, which is the intended reminder. A bracelet's inner surface comes from `tube` and `torus` parts, which exist today.
85. **hand-manipulation.** Body fit reads the pinch, fist and One Euro modules (`src/hands/pinch.ts`, `fist.ts`, `one-euro.ts`, `constants.ts`) without changing them, extends the worker protocol additively (R5, design §4.1), and keeps `tests/e2e/arm-try-on.spec.ts` and `hand-control.spec.ts` passing (R112).
86. **export.** The fitted object is exported through the existing dialog with no change. The fit card and the panel never write files.

### Head (P1, after a spike)

87. **Spike first.** Before any head code, a spike measures the Face Landmarker's facial transformation matrix (`outputFacialTransformationMatrixes`, `FaceLandmarkerResult.facialTransformationMatrixes`) on the user's laptop: its units and axes against the Three.js view, its behaviour on the mirrored frame, its jitter on a still head, the cost per frame next to two hands and the segmenter, and the warm-up time. It runs only after the user says go (decision 15), because it downloads the face model and uses the webcam. Its results are written to `.kiro/specs/body-fit/spike-head.md` with a go or no-go for the matrix.
88. **Anchor.** With a go, head-worn objects are placed with the transformation matrix; with a no-go, with a head frame built from the face landmarks (design §11.2). The anchor is the head; the ring axis is vertical through the head for headbands and helmets.
89. **Scale.** 相機估計 for the head comes from the iris: the visible iris diameter of adults is about 11.7 mm (`IRIS_DIAMETER_MM`, an assumption to check in the spike), measured on the iris landmarks. 卡片校正 holds the card flat on the forehead inside the same guide. 捲尺 is the head circumference above the eyebrows.
90. **Head size.** The face width at the cheekbones (face landmarks 234 and 454) is measured with the scale; the head ellipse uses breadth from the face width plus `HEAD_BREADTH_EXTRA_MM` (14 mm) and length from breadth over `CEPHALIC_INDEX` (0.8). Both constants are assumptions, labelled 「依一般比例估計」, and the panel recommends the tape.
91. **Fit.** The ring fit of R47–R57 applies to headbands and helmets at the band plane (above the eyebrows, tilted with the head). For glasses (an object whose ring search finds no ring and whose width runs across the face), the panel compares the object's inner width at the temples with the face width: 「鏡框內寬 138 mm · 臉寬 142 mm（相機估計）· 太窄 4 mm」.
92. **Occlusion.** The head's far side is hidden where the mask shows face skin, hair or body skin (classes 3, 1 and 2), with a head proxy ellipsoid sized from R90.
93. **Steps.** 量頭部 asks for 「臉正對鏡頭，保持不動。」 and records like R22–R23 (head yaw within 15°).
94. **Worker.** The face landmarker loads only when the head anchor first starts, in the same worker, and runs only while the head anchor is on; the hand landmarker keeps running for the adjusting hand.
95. The head reuses the placement values (位置 moves the band up and down, 傾斜 tilts it front to back, 轉動 turns it) and the hand adjustments of R37–R41.
96. `attach_to_body` gains `anchor: 'head'`; `fit_to_body` uses the head measurement when the worn anchor is the head; the request's `body` field carries the head measurement.
97. The 試戴 button keeps the wrist; the fit panel gets 戴在：手腕 / 頭部 as a choice.
98. Head stability targets: the same as R75, measured on a head recording.

### Foot (P2)

99. **Anchor.** A coarse foot anchor from the pose landmarks of the chosen side: ankle (27, 28), heel (29, 30) and foot index (31, 32), for position, direction and rough length (VISION §3.1).
100. **Pose world landmarks.** The worker adds the pose world landmarks to the frame (an optional field) while the foot anchor is on.
101. **Scale.** 相機估計 from the pose world landmarks (hip-centred, metre-like estimates, VISION §3.1); 捲尺 as a typed foot length in millimetres (180–330 mm) or an EU shoe size converted with `EU_SIZE_MM` (6.67 mm per size; an assumption, labelled); 卡片校正 with the card laid on the floor beside the foot inside the guide (decision 16).
102. **Foot size.** Length from heel to toe; width typed, or `FOOT_WIDTH_RATIO` (0.38) of the length, labelled 「依一般比例估計」.
103. **Fit.** A shoe-like object (its longest axis along the foot) is compared by length and width: toe room 「前端餘量 12 mm」 against `TOE_ROOM_MM` (10–15 mm, assumption) and width room, classed with the same colours. No per-angle ring map: toe-level fit is out of scope.
104. **Steps.** 量腳 asks the user to step back until the whole foot is in view: 「請退後到鏡頭看得到整隻腳，腳跟到腳尖側面朝向鏡頭。」.
105. **Occlusion.** The foot's far side is hidden where the mask shows body skin or clothes, with a box proxy of the foot size.
106. `attach_to_body` gains `anchor: 'foot'`; `fit_to_body` changes the length and width of a shoe-like object through the edit task (no local resize, because shoes are not rings).
107. The fit panel gets 戴在：腳部.

## Non-functional requirements

108. **Privacy.** Camera frames, the frozen calibration frame, segmentation masks and landmarks stay in the browser (page and worker). Nothing about them is sent to the local server or a model back end, or logged. The agent request carries only the numbers of R65, and only while body fit is on (decision 6). Recordings (R46) are written only when the user starts a download and are never uploaded. README's privacy section adds: the segmenter (and later the face model) is downloaded from Google's public model storage when fitting first starts; measurements are numbers sent to the model back end only during an agent run while fitting.
109. **Frame-time budget** on the dev laptop (2 cores, 8 GB, integrated GPU; two hands tracked at about 9–10 fps with 70–90 ms recognition, VISION §4.9):
     - **Worker, fitting on.** The hand landmarker on every frame, pose every 200 ms (`POSE_INTERVAL_MS`, about 27 ms on the GPU per `docs/PRIOR_WORK.md`), the segmenter every `SEGMENT_INTERVAL_MS` (333 ms, about 3 Hz), and the crop luma (under 1 ms). The tracking rate must stay at or above 6 fps median while fitting, above the 5 fps gesture gate (`MIN_CONTROL_FPS`). The segmenter's cost on this GPU is unknown (Google lists 71 ms on a Pixel 6 GPU and 218 ms on its CPU); if the rate falls below 6 fps for 2 s, the interval doubles up to 1000 ms (adaptive back-off).
     - **Worker, measuring.** During a measure step the segmenter runs on every frame for at most 3 s per step; the rate may fall to about 4 fps while the wrist is held still.
     - **Main thread.** Body fit adds at most 4 ms per rendered frame on average: anchor update and smoothing under 0.5 ms, the mask texture upload (64 KB) under 1 ms at the segmenter's rate, the depth proxy, shadow and ribbon passes under 2.5 ms. The fit recompute (R57) takes at most 8 ms and runs at most 10 times a second while a placement drag is active. No tracking frame causes a React render; the numbers update at most 4 times a second.
     - **Loading.** The segmenter loads lazily on the first fit, with a warm-up on a blank frame like the hand and pose models; the status says 「正在載入量測模型…」. Target: ready within 15 s after the download.
     - **Head (P1).** The spike measures the face landmarker's cost; head mode runs the hand landmarker for the adjusting hand at most every second frame if the rate would fall below 6 fps.
     - **CPU fallback.** On the CPU delegate the segmenter runs at most once a second and the status says 「目前使用 CPU，遮擋與量測會比較慢。」.
     T2 measures these numbers on the laptop once the user allows the model download (decision 2); design states how.
110. **Resources.** The segmenter and the face landmarker are closed when the camera turns off (the worker terminates, as today). Mask textures, the proxy, the shadow, the ribbon and the worn object's Three.js resources are disposed with `disposeObject` when fitting stops or the object changes.
111. **Validation by the user.** The manual check list (tasks.md) includes: the tape-measured wrist versus the camera estimate, with and without card calibration, with the error recorded in `.kiro/specs/body-fit/validation.md`; and a printed fitted bracelet worn on the real wrist, with the result (fits, presses, loose, where) recorded there.
112. **Compatibility.** With the camera off, or with body fit off, the workbench behaves as today apart from the renamed 試戴 button. Existing e2e specs pass unchanged, except `tests/e2e/arm-try-on.spec.ts`, whose button name and cuff expectations change with decision 4 (named in tasks.md). Existing unit tests change only where they assert the tool list, the `wear_on_arm` tool, or the exact shape of `StateChange` or the agent request; tasks.md names each file. If any other existing test needs a change, the task stops and reports.
113. **Tests.** Every task has Vitest unit tests; pure modules are tested in Node; no jsdom or happy-dom. Tests never call a real model back end and never download a model: e2e uses a scripted worker with synthetic hands and synthetic masks. The ellipse, circumference, gap, clearance and resize maths have property-based tests (R114).
114. **Property-based tests.** Random sizes within body ranges and these invariants at least: the ellipse perimeter lies between `π(a+b)` and `π√(2(a²+b²))` and equals `2πa` for a circle; it grows with either semi-axis; a polygon of the sampled ellipse converges to it; scaling every length by `s` scales every gap and perimeter by `s`; a larger clearance never makes any gap smaller; more tilt never makes the smallest gap larger; after the local resize the spare equals the clearance within 0.3 mm and no angle is red at the default placement; the classes are monotone in the gap; the mask width measure recovers a synthetic band's width within one mask pixel at any angle. Whether this uses a library is decision 1.
115. **Dependencies.** No new runtime dependency: the segmenter and the face landmarker are tasks of `@mediapipe/tasks-vision` 1.2.2, already installed. A property-testing dev dependency only if the user chooses it (decision 1).
116. **Language.** Spec, design, tasks and code comments in English; user-facing strings in Traditional Chinese, in `shared/fit-text.ts`, with no mixed languages on one screen.
117. `npm run check` (type check + build + unit tests) passes before a task is marked done, and the real result is reported.
118. **README** gets a short "body fit" section: what 試戴 does, the three scale sources, measuring the wrist, the card calibration, the tape, the fit map and its colours, the clearance presets, asking the agent to make it fit, `?fit=debug`, and the model download; the privacy line of R108. The project still installs and runs from the README alone.
119. `tasks.md` has at most 7 tasks, each small enough for one fresh Kiro session with Claude Sonnet 5.5, with "Read first", "Build", "Tests", "Done when" and "Session facts", and ends with the manual check list. `design.md` maps every requirement to a task.

## Priorities and build order

| Priority | Requirements | Tasks |
|---|---|---|
| P0 hand and wrist | R1–R86, R108–R119 | T1 fit maths · T2 worker segmenter and measurement core · T3 scale, calibration and measuring panel · T4 wearing any object, adjusting and stability · T5 looks worn · T6 agent, fit card, README |
| P1 head | R87–R98 | T7 part A, after the spike and the user's go |
| P2 foot | R99–R107 | T7 part B |

Order: T1 and T2 can run in parallel (they share no file); T3 needs both; T4 needs T1–T3; T5 needs T4; T6 needs T4 (and T1's resize). T7 needs T6. If time runs short, only the user decides what is cut (VISION §5 names the body-fit head anchor in its reference cut order).

## Decisions

Open decisions for the user. Each has the options and a recommendation; `design.md` and `tasks.md` follow the recommendation until the user decides.

1. **Property-based testing library (R114).** `package.json` has no property-testing library today (dependencies checked on 2026-11-26).
   - A: add `fast-check` (MIT) as an exact-pinned dev dependency in T1; shrinking shows the smallest failing case.
   - B: no dependency; a seeded random generator in `tests/fixtures/fit-random.ts` runs each invariant over a few hundred cases and prints the seed and the case on failure.
   - **Recommendation: A**, because shrinking makes failures in the gap maths readable. T1 asks before installing. B is the fallback if the user prefers no new package.
2. **Segmenter model file and source (R19).** `selfie_multiclass_256x256.tflite`, float32, 16.37 MB (16,371,837 bytes), categories 0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others; licence Apache-2.0 (stated in Google's model card, as quoted on the model page); official sources: the MediaPipe Image Segmenter page (https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter) links `https://huggingface.co/litert-community/MediaPipe-ImageSegmenter-Selfie-Multiclass`, whose files it says are byte-identical to Google's `storage.googleapis.com/mediapipe-models` copy (version `/1/`). The exact Google storage path (expected `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite`, following the pattern of the hand and pose URLs in `arm.worker.ts`) was **not verified**; T2 checks it before use. The model card lists "pixel-perfect masks" as out of scope, which is why measurements carry a spread and are checked against the tape.
   - A: download at runtime from Google's storage on the first fit, like the hand and pose models today.
   - B: download at runtime from the Hugging Face mirror.
   - C: commit the file under `public/` (16 MB in the repo, Apache-2.0 notice in README).
   - **Recommendation: A**, the same privacy story and loading path as the existing models. Measuring its speed on the laptop (R109) needs the download once; T2 asks before it.
3. **Face landmarker model file and source (R87, P1).** `face_landmarker.task`, float16, 3.76 MB (3,758,596 bytes), Apache-2.0 (Google's model cards), official source listed on the Face Landmarker page (https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker) and `https://huggingface.co/litert-community/MediaPipe-FaceLandmarker`, byte-identical to Google's storage copy (version `/1/`). Expected Google path, **not verified**: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`. **Recommendation:** the same as decision 2 (runtime download from Google's storage), and only after the spike's go (decision 15). Foot (P2) uses the pose model that is already downloaded today (`pose_landmarker_lite`); no new file.
4. **Retire the stand-in cuff and `wear_on_arm` (R1, R63).**
   - A: 試戴 wears the user's object; `attach_to_body` replaces `wear_on_arm`; the cuff code (`src/scene/arm-preview.ts`) goes; the named tests change (`tool-registry.test.ts`, `agent-tools.test.ts`, `agent-loop.test.ts`, `agent.test.ts`, `run-reducer.test.ts`, `arm-try-on.spec.ts`).
   - B: keep 護臂試戴 and `wear_on_arm` with the cuff, and add body fit beside them.
   - **Recommendation: A.** Two try-on modes and two tools would confuse the user and the model, and the cuff was always a stand-in (`docs/PRIOR_WORK.md`).
5. **Where measurements live (R3).**
   - A: session only, in browser memory; lost on reload.
   - B: also in `localStorage` on this machine, with a 清除量測 button.
   - C: in the workspace (a schema change owned by `workspace-v2`).
   - **Recommendation: A** for this spec. Body sizes are personal data; saving them belongs with shared memory (C17) and needs its own consent wording. B is a small change if the user wants it for the demo.
6. **Send measurement numbers to the model back end (R65).**
   - A: yes, only while body fit is on, as numbers in the request; README says so.
   - B: no; the server tool receives them but the model sees only 「已量測」 and the fit classes.
   - **Recommendation: A.** The agent needs the numbers to explain the fit, and they are text, consistent with "model back ends receive only text and model data". B is possible but the agent's replies would be vague.
7. **How `fit_to_body` changes the design (R67).**
   - A: local resize for `tube` and `torus` rings (instant, no quota, exact), the edit task for other shapes.
   - B: always the edit task (8–80 s per call, `docs/PRIOR_WORK.md`, and the model may miss the numbers).
   - C: local resize only; other shapes return `NO_RING`.
   - **Recommendation: A.**
8. **A local 調整為合適尺寸 button (R71).** **Recommendation: yes.** It uses the same function as the tool, is instant and keeps the demo working without a model call; the agent stays the path for spoken requests and other shapes.
9. **Card edge finding (R13).**
   - A: manual only: the user drags the four edges on the frozen frame.
   - B: automatic only.
   - C: automatic first, manual correction always available.
   - **Recommendation: C.** Automatic alone fails on low contrast (a white card on pale skin); manual alone is slower. It is the largest single piece of T3; if the user wants T3 smaller, A is the fallback and B is dropped.
10. **Clearance presets (R55).** 貼合 6 mm, 舒適 13 mm, 寬鬆 25 mm of circumference over the wrist. These follow common bracelet sizing advice (about a quarter, a half and one inch over the wrist), which was **not checked against a published standard**. **Recommendation:** use them, and adjust after the printed bracelet (R111).
11. **Look of the worn object (R33).** A: opaque, lit, part colours. B: the hologram style. **Recommendation: A**, because "looks worn" is the goal; the fit map ribbon and the fit dial carry the technical view.
12. **Far-side opacity (R58).** Keep today's `DEFAULT_BACK_OPACITY` 0.3 (user feedback 2026-11-12: a fully hidden back looked fake), or 0 now that the real mask is used. **Recommendation:** keep 0.3 and compare with `?armBack=0` in the manual check.
13. **Landmark recordings (R46).** A: never committed; unit tests use synthetic noisy sequences. B: commit one short recording of the author's hand. **Recommendation: A.** Hand landmarks are body data and the repo will be public.
14. **A demo bracelet.** There is no bracelet in the code: 載入示範模型 loads 雙鏡頭概念裝置 (`shared/demo.ts`). VISION's demo uses a generated smart bracelet.
    - A: add a hand-written bracelet `ModelSpec` (`shared/demo-bracelet.ts`: a `tube` band, a case, an interior battery and board) used by the tests and by a 載入示範手環 button in the fit panel.
    - B: tests use a fixture only; the demo relies on the agent generating the bracelet.
    - **Recommendation: A**, so the demo and the manual checks do not depend on a model call. The button's final place is `workbench-ui`'s call.
15. **Head spike go (R87).** The spike downloads the 3.76 MB face model and uses the webcam; it costs no model quota. **Recommendation:** run it at the start of T7 once the P0 tasks are reviewed; the user says go.
16. **Foot scale sources (R101).** A: estimate and tape only. B: also the card on the floor. **Recommendation: B**, because it reuses the card guide and gives the foot an honest calibrated source; it is the last item of T7.
17. **Segmenter too slow (R109).** If T2's measurement shows the rate below 5 fps even at 1 Hz:
    - A: use the mask only for measuring (still hand) and occlude with the measured proxy alone.
    - B: use the landscape selfie segmenter (person/background only, 144 × 256, float16; Google lists about 34 ms on a Pixel 6) for occlusion, keeping the multiclass model for measuring.
    - C: measure from the tape only.
    - **Recommendation:** decide after the measurement; A first, because it adds no download.
18. **Adjustment gestures (R37–R39).** Pinch-drag along the arm slides, across tilts; a fist knob turns. **Recommendation:** use these; they reuse the pinch and the fist knob the user already knows from `hand-manipulation` Task 11.
19. **Schedule (risk).** Evidence: phase C ends 2026-11-29 (VISION §5); today is 2026-11-26. `export` took about two days for 5 tasks (spec approved 11/20, task 5 committed 11/22 00:30); `hand-manipulation` Tasks 10–12 took 11/22–11/26. Body fit has 6 P0 tasks while `workbench-ui`, `design-fidelity` and `english-ui` run at the same time and edit `src/App.tsx` and `src/scene/SceneViewport.tsx` too. The segmenter's speed on the laptop is unknown, and printing the bracelet needs printer time. **Recommendation:** run T1 and T2 in parallel now; ask the user before the T2 download so the speed is known on day one; schedule the print right after T6. The user decides any cut.

## Decisions from review (2026-11-26)

Reviewed with the user and Claude Code. The user accepted every recommendation under "Decisions" above, plus these points. Where this section and the text above differ, this section wins.

1. **Decision 1 (A) approved:** add `fast-check` as a dev dependency pinned exactly to **4.10.2** (MIT; published 2026-09-19; 4.10.3 and 4.11.0 were less than two weeks old on 2026-11-26, so they are not used). Its only dependency, `pure-rand`, is MIT.
2. **Decision 2 (A) approved:** runtime download from Google's model storage. The URL `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite` was checked by the reviewer with a HEAD request on 2026-11-26: HTTP 200, 16,371,837 bytes. The user allows the download in their own browser for T2's speed measurement. Sessions and tests still never download it.
3. **Decisions 3 and 15 approved:** `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` checked the same way: HTTP 200, 3,758,596 bytes. The head spike runs at the start of T7, after the P0 tasks are reviewed.
4. **Decision 14 amended:** the hand-written bracelet (`shared/demo-bracelet.ts`) is built, but there is no 載入示範手環 button. It is the second option (智慧手環) of `workbench-ui`'s demo selector next to the one 載入示範模型 button. If `workbench-ui` has not built the selector when T4 runs, T4 adds that selector next to today's demo button, and `workbench-ui` moves it.
5. **Strings:** once `english-ui` Task 1 has landed and the steering is updated, new strings go into a bilingual table (`english-ui` R58) instead of plain zh-TW in `shared/fit-text.ts`.
6. **Tool count:** `find_tools` is not built now (15 tools today, about 21 after the four specs); see VISION §4.3 note of 2026-11-26.
7. **`agent-platform`** (being written) will add a client tool that lets the agent start the wrist measurement after the user confirms in the browser. Keep "start a measurement step" a plain function that the panel button calls, so that tool can call it too.
8. **Schedule (decision 19):** the user keeps the full plan; T1 and T2 may start now.

## Decisions from review of Task 1 (2026-11-27)

Decided by the user after the Task 1 session's report; this section wins over the text above and over `design.md`.

9. **Resize for the widest slice across the band.** Design §6.6 sized the ring for the arm at the band position only. On a tapered arm a wide band then presses at its elbow-side edge right after 調整為合適尺寸 (example kept as a test in `tests/unit/fit-resize.test.ts`: 40 mm band, 6 mm clearance, taper 0.12 → `presses` with the spare still 6 mm; with the default taper this starts at about 33 mm of band width for snug and 70 mm for comfort). The resize must instead take, for each ring axis, the largest arm semi-axis over the `FIT_SLICES` slices (with tilt and roll as in §6.2), so no angle is red after a resize; the wrist-side edge is then looser by the taper (about 2.3 mm across for the example). The spare reported after a resize is the clearance at the widest slice. A ring is a straight tube or torus and cannot follow the taper, so this is the user's choice of "never too tight" over "even gap". To be built by a later body-fit task (Task 6, which wires `fit_to_body` and 調整為合適尺寸 to the resize, or a small fix task before it); the test above then flips to `fits`, and the "no red angle after resize" property must hold on tapered arms too.
10. **Design corrections found by Task 1's property tests** (kept in code, `design.md` not edited): the cone inside test is `hypot(x/dx, z/dz) ≤ 0.5·(0.5 − y/dy)` (§6.4 wrote twice that; checked against `ConeGeometry(0.5, 1)` by the reviewer); the body angle is `sign·(θ + roll)` (§6.4 wrote `sign·θ + roll`, which contradicts §6.2 when `sign` is −1; Task 4 must check this against the roll sign it measures); the scaling invariant is exact only for a straight arm without tilt, because the edge slices sit a fixed 0.5 mm inside the band edge.

## Decisions from review of Task 2 (2026-11-28)

Recorded by the reviewer after the Task 2 session's report and diff; this section wins over the text above and over `design.md`.

11. **Real-device budget (design §4.4), measured on the dev laptop on 2026-11-28.** Segmenter alone: median 108 ms (p90 127) when segmenting every frame, 129.9 and 134.4 ms (p90 about 158–165) at the 333 ms cadence, so the soft 120 ms target is missed by about 10–14 ms at the cadence. Tracking rate with two hands: 8.84 fps median (min 5.85) with masks, against 8.16 fps without; 5.22 fps median (min 2.58) when segmenting every frame. Warm-up: 10.7 s from `loading` to `ready` on the first run (16 MB download), 5.7 s cached. The model URL loads. Decision 17 is **not triggered** (its trigger is a rate below 5 fps even at 1 Hz). Limits of the measurement: the temporary harness started the 333 ms interval after each reply, so masks arrived at about 1.7 Hz, not 3 Hz (the true 3 Hz rate lies between 8.84 and 5.22 fps and is unmeasured); one hand pose only; the wrist widths it printed are meaningless (no measuring pose). Task 3 must measure the rate at a true 3 Hz and the minimum during a burst with its real flow.
12. **`segment: null` behaves like no `segment`.** Design §4.1 says a frame without a crop reports the luma of the whole image; Task 2's rule "a frame without `segment` produces exactly today's messages" wins: luma is reported only for a requested crop. Task 3 sends a crop whenever it needs the luma.
13. **The fake worker draws its own masks.** Design §4.2 said the test page generates the masks; `tests/e2e/fake-body.ts` instead inlines the `tests/fixtures/fit-mask.ts` functions and draws the mask for each requested crop, because the crop moves every frame and a round trip from the test would lag.
14. **`palmFacing` is unsigned** (0–90°, palm or back of the hand toward the camera both count): the full wrist width shows either way, and no handedness label is involved.
15. **For Task 3:** (a) keep the `segment` ref set until a frame comes back with `luma`, and start the 333 ms interval from that frame; a request made on one tick only is dropped while the worker is busy. (b) `useHandTracking` ignores the `segmenter` state message today; Task 3 needs a small optional callback (or similar) to show 「正在載入量測模型…」 or that the model could not load. (c) **Bug in `robustMedian` (`shared/fit.ts`, Task 1):** when 4 or more of 7 values are identical the MAD is 0, only the identical values survive, and fewer than `MEASURE_MIN_KEPT` (5) kept frames make the step `unstable`. Task 3 fixes it with a unit test (for example, when the MAD is 0, keep the values within a small absolute tolerance instead of exactly equal ones).

## Decisions from review of Task 3 (2026-11-28)

Recorded by the reviewer after the Task 3 session's report and diff; this section wins over the text above and over `design.md`.

16. **The real-device rate check moves to Task 4** (user decision). Item 11 asked Task 3 for the tracking rate at a true 3 Hz cadence and the minimum during a 3 s burst. Task 4 measures it instead, with its `?fit=debug` line and the full wearing pipeline (occlusion and fit map running), which are the numbers that matter; no temporary harness. Task 4 asks the user before the ~60 s webcam run, and reports the median and minimum at 3 Hz, the minimum during a burst, and whether the panel's wrist width looks sensible.
17. **Stillness at a low frame rate.** The 300 ms speed window (`STILL_WINDOW_MS`) never held enough frames below about 6.7 fps, so a step stayed 「請保持不動」 forever (seen in e2e at about 3 fps). The window is now at least about three frames long; unit-tested.
18. **`robustMedian` with a zero MAD** keeps the values within `MAD_ZERO_TOLERANCE` (0.5 mm, about one mask pixel) of the median (item 15c fixed; tests in `fit-gaps.test.ts`).
19. **Left for Task 4:** `data-fit-state` already reads `worn` while the arm is tracked although nothing is worn yet; `data-fit-summary` is not rendered; step 3 (passage) is always offered because whether the object is a closed ring is known only in Task 4. Task 4 makes these real.
20. **The segmenter runs during every try-on** (R109, about every 333 ms), so the first try-on loads the 16 MB model.
