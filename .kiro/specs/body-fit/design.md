# Body fit — Design

This design satisfies `requirements.md`. It follows the patterns of `hand-manipulation`, `assembly-joints` and `export`: pure modules unit-tested in Node, thin React and Three.js wiring covered by Playwright, and one place for every rule. Requirement numbers (R…) refer to `requirements.md`; task numbers (T1–T7) refer to `tasks.md`; "HM" means `hand-manipulation`, "AJ" `assembly-joints`. Names marked **(assumption)** were not verified against running code or a published source and must be checked by the task that uses them.

## 1. Approach

```
fit maths      shared/fit*.ts: ellipse, perimeter, clearance offset, arm section with tilt, primitive inside tests,
               ring axis, inner profile, gaps, classes, summary, local resize                         (T1, pure, Node)
worker         arm.worker.ts gains the multiclass segmenter on a wrist crop, the crop luma, pose world
               landmarks (P2) and the face landmarker (P1); useHandTracking forwards masks              (T2)
measurement    src/fit/measure.ts: scale estimate, mask widths across the forearm, pose checks, medians;
               src/fit/card.ts: card edges and the correction factor                                  (T2 core, T3)
panel          FitPanel: sources, 量手腕, 卡片校正, 捲尺, clearance, numbers, fit dial                  (T3, T4)
wearing        src/fit/wear-view.ts replaces arm-preview.ts: the user's object at true size on the wrist,
               anchor smoothing, adjustment gestures, fit ribbon, recorder and replay                  (T4)
looks worn     mask-gated depth proxy, contact shadow, light from the video                            (T5)
agent          attach_to_body replaces wear_on_arm, fit_to_body, request.body, fit card, README        (T6)
head, foot     spike → head anchor and fit (P1); foot anchor and length fit (P2)                       (T7)
```

Five ideas carry the design:

1. **One body frame, in millimetres.** Every measurement and every fit runs in a body frame at the band position: origin on the forearm axis, `Y` along the forearm toward the hand, `Z` toward the back of the hand, `X` across. All maths is in millimetres; model metres are converted once at the boundary (×1000). The screen only enters through one number, the scale in mm per frame pixel, with its source.
2. **The fit is computed from the model, never stated by a model.** The inner profile is sampled from the parts' primitives with exact inside tests, so the fit works for any object, the server can compute it for `fit_to_body`, and the numbers the agent reports come from the same function as the panel (VISION §4.10: "every number shown is computed from the model").
3. **Measure slowly, track quickly.** The mask is expensive and runs at about 3 Hz on a crop around the wrist; landmarks run on every frame. Measurements are medians over still frames and are frozen once taken; the per-frame path only places the object.
4. **The worn object is a second view of the same model.** `wear-view.ts` builds the object with `buildModel` and its own materials in the overlay scene that today holds the cuff; the workspace object is untouched and only hidden on the stage while worn (R4).
5. **The agent closes the loop with a local rule.** `fit_to_body` resizes a tube or torus ring locally (instant, exact, one undo step) and falls back to the edit task for other shapes; the browser's 調整為合適尺寸 runs the same function (R67, R71).

## 2. Module layout

```
shared/fit-constants.ts     T1  every named constant of the requirements (FIT_ANGLES, FIT_SLICES, LOOSE_MARGIN_MM, CLEARANCE_PRESETS_MM,
                                RING_MIN_MM, RING_MAX_MM, OPEN_GAP_DEG, DEFAULT_THICKNESS_RATIO, DEFAULT_BAND_OFFSET_MM, PROFILE_*,
                                CARD_*, ...); later tasks add theirs
shared/fit-text.ts          T1  every user-facing fit string (browser and server), plus side names and source labels (R83)
shared/body.ts              T1  ScaleSource, Measured, WristMeasurement, Placement, Closure, FitSummary, BodySnapshot (Zod)
shared/ellipse.ts           T1  ellipseRadius, ellipsePerimeter, polygonPerimeter, rayEllipse, offsetForPerimeter
shared/fit-geometry.ts      T1  PRIMITIVE_INSIDE (Record<Primitive, InsideTest>), ringCandidates, ringFrame, innerProfile
shared/fit.ts               T1  armSection, fitGaps, classify, fitSummary, effectiveClearance, wristEllipse (tape combination)
shared/fit-resize.ts        T1  resizeRing (tube, torus, attached parts) → EditPlan; FitResizeError
src/try-on/arm.worker.ts    T2  segmenter on a wrist crop, luma, cadence fields;  T7 face landmarker, pose world landmarks
src/try-on/arm-pose.ts      T2  protocol types (additive): ArmWorkerFrame.segment, crop; result mask, luma;  T7 face, bodyWorld
src/hands/useHandTracking.ts T2 forwards `segment`/`crop` per frame and `mask`/`luma` into TrackedFrame (additive)
src/fit/measure.ts          T2  mmPerPx, widthAcross, palmFacing, forearmFlat, stillness, MeasureStep, robustMedian, spread
src/fit/mask.ts             T2  SkinMask type, sample, maskToFrame, frameToMask (pure)
src/fit/cadence.ts          T2  segmentPlan: when to ask the worker for a mask (interval, back-off, measuring burst)
src/fit/card.ts             T3  cardGuide, findCardEdges (pure, on a grey image), cardFactor, depth correction
src/fit/store.ts            T3  the fit session store (measurement, calibration, tape, clearance, placement, closure), no React
src/fit/useBodyFit.ts       T3  React hook: subscribes to HandSource, runs measure steps, exposes store snapshots ≤ 4 Hz
src/fit/FitPanel.tsx        T3  the panel (R76); T4 adds placement, ring, closure, numbers; T6 the fit card
src/fit/CardGuide.tsx       T3  overlay: guide frame, frozen frame, draggable edges (R11–R14)
src/fit/FitDial.tsx         T4  SVG fit dial with a text alternative (R56)
src/fit/anchor.ts           T4  bodyFrame from ArmTracker pose + scale, AnchorSmoother (One Euro), hold and fade (R42–R45)
src/fit/placement.ts        T4  default placement (ring axis, face, offset), apply slide/tilt/roll, object→body matrix, mirror
src/fit/adjust.ts           T4  adjustment gestures of the other hand (pinch slide/tilt, fist knob) — pure state machine
src/fit/recorder.ts         T4  ?fit=record: frames → JSON download;  replay(frames) → stability metrics (Node)
src/fit/wear-view.ts        T4  replaces src/scene/arm-preview.ts: overlay scene, the worn object, fit ribbon;  T5 occlusion, shadow, light
src/fit/fit-ribbon.ts       T4  ribbon geometry along the inner rims, vertex colours per angle
src/fit/occlusion.ts        T5  mask texture, mask shift, the arm depth proxy and its shader (alpha test on the mask)
src/fit/shadow.ts           T5  contact shadow decal
src/fit/light.ts            T5  LightFollower: luma → light factor, smoothed
src/fit/FitCard.tsx         T6  the fit card (before/after numbers + dial) for the data card slot
src/fit/head.ts, foot.ts    T7  head and foot anchors and measurements
src/scene/arm-preview.ts    T4  deleted (decision 4); its smoothing constants move to src/fit/anchor.ts
src/scene/SceneViewport.tsx T4  prop `bodyView` replaces `tryOn`; hides worn objects on the stage;  T5 passes the mask
src/try-on/useArmTracking.ts T4 kept as the status/stats source; returns the ArmTracker pose for the anchor
src/App.tsx                 T3 fit state and panel mount;  T4 試戴 button, worn object;  T6 agent options
src/styles.css              T3, T4  fit panel, guide and badge styles
shared/agent.ts             T6  StateChange.bodyFit, AgentRequest.body, AttachToBodyDetail, FitToBodyDetail
server/tools/attach-to-body.ts, fit-to-body.ts  T6 NEW;  wear-on-arm.ts T6 DELETED
server/tools/index.ts, helpers.ts, server/agent.ts  T6 EDIT (registration, strip bodyFit in checkedChange, state line, instructions)
src/agent/apply-state.ts, useAgentRun.ts, request.ts  T6 EDIT (bodyFit effect, body field)
shared/demo-bracelet.ts     T4  the hand-written demo bracelet (decision 14)
README.md                   T6  body-fit section and privacy line
package.json                T1  fast-check only if decision 1 = A

tests/unit/fit-ellipse.test.ts, fit-geometry.test.ts, fit-gaps.test.ts, fit-resize.test.ts   T1
tests/unit/fit-measure.test.ts, fit-cadence.test.ts, fit-worker-protocol.test.ts             T2
tests/unit/fit-card.test.ts, fit-store.test.ts                                                T3
tests/unit/fit-anchor.test.ts, fit-adjust.test.ts, fit-placement.test.ts, fit-replay.test.ts  T4
tests/unit/fit-occlusion.test.ts, fit-light.test.ts                                           T5
tests/unit/fit-agent.test.ts                                                                  T6
tests/unit/fit-head.test.ts, fit-foot.test.ts                                                 T7
tests/fixtures/fit-bracelet.ts   T1 (bracelet models: tube band, torus band, band+case child, case+band child, open C cuff, no ring)
tests/fixtures/fit-random.ts     T1 (only if decision 1 = B: seeded generator)
tests/fixtures/fit-mask.ts       T2 (synthetic skin masks from a synthetic hand and a forearm band)
tests/fixtures/fit-sequence.ts   T4 (synthetic noisy landmark sequences for replay)
tests/e2e/fake-body.ts           T2 (scripted worker: synthetic hands + synthetic masks; same route pattern as fake-hands.ts)
tests/e2e/body-fit.spec.ts       T3 (T4–T7 add cases)
```

Dependency direction: `shared/fit-constants.ts`, `shared/ellipse.ts` ← `shared/fit-geometry.ts` ← `shared/fit.ts` ← `shared/fit-resize.ts`; `shared/body.ts` holds the schemas both sides use. `shared/` uses only Three.js math classes and imports `shared/model.ts`, `shared/bounds.ts` (`worldMatrices`), `shared/edit.ts` (`applyEditPlan`, `EditPlan`), `shared/assembly.ts` (`assemblyOf`, `objectMatrix`) and `shared/contact.ts` (`realignJoint`, T6). `src/fit/` imports `shared/` and `src/hands/` pure modules (`pinch.ts`, `fist.ts`, `one-euro.ts`, `constants.ts`, `mapping.ts`) and `src/try-on/arm-pose.ts` (`ArmTracker`, types, `coverFrameBounds`). Nothing in `src/hands/` imports `src/fit/`.

## 3. Data shapes

All in `shared/body.ts` (T1), Zod schemas with `z.infer` types; lengths in millimetres, angles in degrees.

```ts
type ScaleSource = 'estimate' | 'card' | 'tape';
/** A value with where it came from and, for camera values, its spread (R8, R73). */
interface Measured { mm: number; source: ScaleSource; spreadMm: number | null }

interface ProfileSlice { offsetMm: number; width: Measured | null; thickness: Measured | null }

interface WristMeasurement {
  side: 'left' | 'right';
  width: Measured; thickness: Measured;          // at the band's default position (offset 0)
  circumference: Measured;                       // ellipse perimeter, or the tape value
  profile: ProfileSlice[];                       // PROFILE_MIN_MM..PROFILE_MAX_MM step PROFILE_STEP_MM
  passage: Measured | null;                      // hand passage width at the knuckles (step 3), or typed
  thicknessAssumed: boolean;                     // t = DEFAULT_THICKNESS_RATIO · w (R26)
  cameraCircumferenceMm: number | null;          // kept for the error line of R27
}

interface Calibration { k: number; at: string; spreadPct: number }   // R15

type Closure = 'closed' | 'open' | 'clasp';
interface Placement { slideMm: number; tiltDeg: number; rollDeg: number }   // R35, ranges enforced by the schema
interface RingChoice { kind: 'part'; partId: string } | { kind: 'axis'; axis: 'x' | 'y' | 'z' }

type FitClass = 'fits' | 'presses' | 'loose';
interface FitSummary {
  state: 'fits' | 'presses' | 'loose' | 'mixed' | 'cannot-pass' | 'open' | 'no-ring';
  innerMm: number | null;            // inner perimeter at the narrowest slice; null for open or no ring
  wrist: Measured;                   // the circumference used
  spareMm: number | null;            // innerMm − wrist.mm
  clearanceMm: number;               // effective clearance (§6.2)
  minGap: { mm: number; angleDeg: number }; maxGap: { mm: number; angleDeg: number };
  classes: string;                   // FIT_ANGLES characters: 'g' fits, 'r' presses, 'a' loose, '-' open
  openingDeg: number | null; openingAtDeg: number | null;
  ringPartId: string | null;
}

/** What the browser sends in the agent request while fitting (R65). Never images, masks or landmarks. */
interface BodySnapshot {
  anchor: 'wrist';                   // T7 adds 'head' | 'foot' and their measurements
  objectId: string;
  wrist: WristMeasurement | null;
  calibration: Calibration | null;
  placement: Placement; closure: Closure; ring: RingChoice | null;
  clearance: { preset: 'snug' | 'comfort' | 'loose' | 'custom'; mm: number };
  fit: FitSummary | null;
}
```

Angles in a `FitSummary` are **body angles**: 0° 手背側, 90° 拇指側, 180° 掌心側, 270° 小指側, for either arm (§6.4 maps ring angles to body angles with the arm's side).

## 4. Worker and tracking (T2; R5, R19, R59, R61, R100, R109, R110)

### 4.1 Protocol (additive, `src/try-on/arm-pose.ts`)

```ts
interface ArmWorkerFrame {          // existing fields unchanged
  bitmap; width; height; timestamp; pose?: boolean;
  /** Run the segmenter on this crop of the frame (frame pixels, already mirrored like the bitmap). Absent: no mask. */
  segment?: { x: number; y: number; size: number; angleDeg: number } | null;
}
type ArmWorkerResult = ... | ({ type: 'frame'; inferenceMs: number } & LandmarkFrame & {
  /** Present only when `segment` was asked: SEGMENT_SIZE² bytes, skin (class 2) and clothes (class 4) confidence ×255, two planes. */
  mask?: { size: number; crop: { x; y; size; angleDeg }; skin: Uint8Array; clothes: Uint8Array; ms: number; timestamp: number };
  /** Mean luma (0..1) of the crop when a crop was given, else of the whole frame, computed on a 16×16 downscale. */
  luma?: number;
});
```

A frame without `segment` behaves exactly as today, so `arm-try-on.spec.ts`'s and `fake-hands.ts`'s workers stay valid (HM R5). The mask buffers are transferred (`postMessage(message, [skin.buffer, clothes.buffer])`). `useHandTracking` gains an optional `segment` option (a ref read per frame, like `pose`) and copies `mask` and `luma` into `TrackedFrame` (two optional fields). Nothing else in the hook changes.

### 4.2 The wrist crop, the mask and the luma

- **Crop.** The page asks for a square crop centred on the band position (wrist landmark moved `DEFAULT_BAND_OFFSET_MM + slide` along the forearm toward the elbow), side `CROP_SIDE_MM` (160 mm) at the current scale, rotated so the forearm axis is vertical in the crop (`angleDeg`). Rotating the crop makes every measuring line a row of the mask. The worker draws the crop into a `SEGMENT_SIZE` (256) square `OffscreenCanvas` with `setTransform` and runs `ImageSegmenter.segmentForVideo(canvas, timestamp)` (VIDEO mode, `outputConfidenceMasks: true`, `outputCategoryMask: false`). Confidence masks 2 and 4 are read with `MPMask.getAsFloat32Array()`, quantised to bytes, and every `MPMask` is closed. With a 160 mm crop, one mask pixel is about 0.63 mm.
- **Why a crop.** On the whole 640 × 480 frame mapped to 256 × 256, one mask pixel would cover about 2.5 frame pixels (several millimetres at a laptop distance). `ImageProcessingOptions.regionOfInterest` exists in the 1.2.2 types, but whether `ImageSegmenter` honours it is **unverified** (the Interactive Segmenter's docs say it errors), so the worker crops itself.
- **Luma.** The crop is also drawn into a 16 × 16 canvas; the mean of `0.2126 R + 0.7152 G + 0.0722 B` (sRGB values, no linearisation) is `luma`. Cost well under 1 ms.
- **Loading.** The segmenter is created on the first frame that asks for `segment`, not at worker start, with the same `wasmFiles('segment')` trick the worker uses for hand and pose, and warmed on a blank 256 × 256 frame. Until it is ready, the worker answers frames without `mask` and posts `{ type: 'segmenter', state: 'loading' | 'ready' | 'error' }` (a new message type the page ignores when it does not know it). A load failure never stops hand tracking: body fit then reports `data-fit-occlusion="proxy"` and the measure steps say 「量測模型無法載入，請改用捲尺輸入。」.
- **Model URL** (decision 2, A): `modelBase + '/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite'` **(assumption: path to verify in T2 before the first real run)**.

### 4.3 Cadence (`src/fit/cadence.ts`, pure)

```ts
segmentPlan(state: { now; lastMaskAt; measuring: boolean; rateFps: number | null; delegate; intervalMs }) → { ask: boolean; intervalMs }
```

- Fitting, not measuring: ask when `now − lastMaskAt ≥ intervalMs`, starting at `SEGMENT_INTERVAL_MS` (333).
- Measuring a step: ask on every frame for at most `MEASURE_BURST_MS` (3000) per step.
- Back-off: when the rate has been below `FIT_MIN_FPS` (6) for `SPEED_HOLD_MS` (2000, HM's constant), double the interval up to `SEGMENT_MAX_INTERVAL_MS` (1000); halve it again after 5 s above 7 fps.
- CPU delegate: interval never below 1000 ms (R109).

### 4.4 Frame-time budget and how T2 measures it (R109)

| Path | Budget on the dev laptop | Measured by |
|---|---|---|
| Worker, fitting | tracking rate ≥ 6 fps median with hand every frame, pose every 200 ms, segmenter every 333 ms | `try-on-stats` rate and the `?fit=debug` line (segmenter ms, interval) over 60 s |
| Worker, measuring | ≥ 4 fps during a 3 s burst | the same, during a measure step |
| Segmenter alone | unknown; target ≤ 120 ms on the GPU (Google: 71 ms Pixel 6 GPU, 218 ms CPU) | `mask.ms`, median of 30 |
| Main thread | ≤ 4 ms per rendered frame added: anchor < 0.5 ms, mask upload < 1 ms, extra passes < 2.5 ms | `performance.now()` around `wearView.update` + `render`, averaged in the debug line |
| Fit recompute | ≤ 8 ms, ≤ 10 per second while dragging | timed in the debug line; unit test bounds the sample count |
| Load | segmenter ready ≤ 15 s after download | time from first `segment` request to `segmenter: ready` |

T2 builds and unit-tests everything with fakes. The real numbers need the 16 MB download once; T2 asks the user before running the page with the real worker (decision 2), records the numbers in its report, and if the segmenter misses the budget the user picks an option of decision 17.

## 5. Measurement (T2 core, T3 flow; R9, R18–R28, R73)

### 5.1 Scale estimate

`mmPerPx(hand, frame)` returns the millimetres per frame pixel at the hand: `Σ metric bone length (mm, x and y of world landmarks) / Σ image bone length (frame px)` over `SCALE_BONES`, the same ratio `screenPalmWidth` forms in `arm-pose.ts` (the bones lie roughly in the palm, and only the in-plane components are used, so the ratio is a scale at the palm's depth). With a calibration, the result is multiplied by `k` (R10). The value is smoothed with a One Euro filter (min cutoff 0.3 Hz, beta 0) and its spread is the MAD × 1.4826 of the last 20 values, as a percentage.

**Assumption:** the palm and the band position are at about the same depth. This holds when the forearm is roughly parallel to the screen (checked by R22's `FOREARM_FLAT_DEG`).

### 5.2 Width across the forearm (`widthAcross`)

Input: the skin plane of a mask (crop rotated so the forearm runs vertically, distal end up), the crop rect, the row of the line (from the offset along the arm), and the column of the forearm axis.

1. Sample the confidence along the row at 0.25 mask-pixel steps with linear interpolation.
2. From the axis column walk left and right to the first sample below 0.5; refine each edge to the 0.5 crossing by linear interpolation between the two samples around it. If the axis sample itself is below 0.5 (the axis is off the skin), search the nearest skin run within ±`AXIS_SEARCH_MM` (10 mm) and use it, else return null.
3. Width in mask px → frame px (`crop.size / SEGMENT_SIZE`) → mm (`mmPerPx`).

Because the crop is rotated to the forearm, the line is perpendicular to the axis on screen. Unit tests (property, R114) draw synthetic bands of random width and angle into a mask with anti-aliased edges and recover the width within one mask pixel.

### 5.3 Steps, pose checks and medians

- `palmFacing(world)` returns the angle between the palm normal (cross product of wrist→index-knuckle and wrist→little-knuckle in world coordinates, oriented toward the back of the hand by the hand's side) and the camera axis. Step 1 and 3 need ≤ 25°, step 2 needs 90° ± 25°.
- `forearmFlat(pose)` returns the angle between the forearm direction (from `ArmTracker`) and the image plane, from its z component; ≤ 30°.
- `stillness` is the wrist speed in mm/s over the last 300 ms at the current scale; below 15 mm/s.
- `MeasureStep` is a pure state machine: `idle → waiting(reason) → recording(n) → done | unstable`. Each accepted frame adds one width per profile offset. `robustMedian(values)` drops values more than 3 MAD from the median and returns the median of the rest with the spread (MAD × 1.4826).
- Step 2 reads the same lines for thickness. Step 3 reads one line across the knuckles (the row through landmarks 5 and 17 projected on the crop; the crop is re-centred on the knuckles for this step) for the passage width.

### 5.4 Combining camera, card and tape (`wristEllipse`, T1)

```
camera only:        a = w/2, b = t/2, source estimate or card
tape C_t + camera:  r = t/w (camera); solve w so ellipsePerimeter(w/2, r·w/2) = C_t; source tape
tape only:          r = DEFAULT_THICKNESS_RATIO (0.65), thicknessAssumed = true
typed w, t:         override the camera values, source tape
```

The profile slices are scaled by the same factor as the band slice when a tape value rescales the ellipse, so the taper measured by the camera is kept at the tape's size. The error line of R27 is `(C_camera − C_tape) / C_tape`.

## 6. Fit maths (T1; R18, R26, R47–R52, R54–R55, R66–R67, R84, R114)

### 6.1 Ellipse (`shared/ellipse.ts`)

- Radius in direction `φ` from the `a` axis: `r(φ) = a·b / √((b cos φ)² + (a sin φ)²)`.
- Perimeter, Ramanujan's second approximation: `h = ((a − b)/(a + b))²`, `P = π (a + b) (1 + 3h / (10 + √(4 − 3h)))`. Its relative error is about 0.1 % only for a degenerate ellipse (b → 0) and far smaller for wrist-like ratios; tests compare it with a 20 000-segment polygon to 1e-4 relative for `b/a ≥ 0.3`.
- `polygonPerimeter(points)` sums segment lengths of a closed polygon (used for the sampled inner profile).
- `rayEllipse(dir, centre, a, b, rotation)` returns the distance from the origin along `dir` to the ellipse boundary (the positive root of the quadratic), or `null` when the origin lies outside the ellipse.
- `offsetForPerimeter(a, b, extra)` returns `g` such that `P(a + g, b + g) = P(a, b) + extra`, by bisection on `[−min(a, b)/2, 60]` to 1e-4 mm. `P` grows strictly with `g`, so the root is unique; `g ≈ extra / 2π` (13 mm → about 2.07 mm).

### 6.2 Arm section, tilt and clearance (`shared/fit.ts`)

In the **ring frame** (origin at the ring centre, `y` along the ring axis, `z` toward the object's face, `x = y × z`), with the placement of R35:

- The arm's axis is the ring axis turned by the tilt `τ` about `x`. A slice plane `y = y_k` cuts the arm in an ellipse with semi-axes `A_k = w(s_k)/2` along `x` and `B_k = t(s_k) / (2 cos τ)` along `z`, centred at `(0, y_k tan τ)` in `(x, z)`, where `s_k = slide + y_k / cos τ` is the position along the arm and `w(s)`, `t(s)` are linear interpolations of the measured profile (§5.2; before a measurement, §6.5).
- The roll `ρ` turns the arm ellipse by `−ρ` about `y`.
- The arm distance in direction `θ` at slice `k` is `rayEllipse(d(θ), centre_k, A_k, B_k, −ρ)`. When it is `null` (extreme tilt on a wide band), the slice counts as pressing at that angle.
- **Effective clearance:** `c = clearance` for open rings and clasps; `c = max(clearance, passage perimeter − wrist circumference)` for a closed ring without a clasp, because it must pass over the hand. `passage perimeter = π · passage width · PASSAGE_SHAPE` (`PASSAGE_SHAPE` 0.95, **assumption**: the compressed hand's outline is flatter than a circle; checked against the user's own bangle in the manual check).
- The **radial clearance** is `g_c = offsetForPerimeter(a, b, c)` with `(a, b)` the band-position ellipse.

### 6.3 Card calibration maths (`src/fit/card.ts`, built in T3; R15–R16)

- `cardFactor(edges, mmPerPxEstimate, depth)`: long edge length `L` px and short edge `S` px (mean of the two opposite edges each); aspect check `|(L/S) / (85.60/53.98) − 1| ≤ CARD_ASPECT_TOLERANCE`; `mmPerPxCard = (85.60/L + 53.98/S) / 2`.
- **Depth correction:** the card lies on the back of the wrist, about `t/2` nearer the camera than the arm's centre line, where the silhouette width is read. The scale at the centre line is `mmPerPxCard · (z_card + t/2) / z_card`, with `z_card = f · 85.60 / L` and `f = (frameWidth / 2) / tan(ASSUMED_HFOV_DEG / 2)` (`ASSUMED_HFOV_DEG` 65°, **assumption** for laptop webcams; a 10° error in it changes the correction by under 1 % at 40–60 cm). Before a measurement, `t = 40 mm` is used.
- `k = mmPerPxCorrected / mmPerPxEstimate` on the frozen frame, accepted only within `[CARD_K_MIN, CARD_K_MAX]`.
- **Edge finding** (`findCardEdges`, pure): the frozen frame's guide region is converted to grey and rotated to the guide; Sobel gradients; for each of the four sides, the row (or column) of maximum mean gradient magnitude within ±25 % of the guide's side gives the edge; confidence is the peak's ratio to the median gradient. Below `CARD_EDGE_CONFIDENCE` (2.5) the edge falls back to the guide line and R14's notice is shown. Unit tests draw a card rectangle with noise at random sizes, offsets and contrasts.

### 6.4 Ring axis, face, inner profile (`shared/fit-geometry.ts`)

**Inside tests** in the part's local frame, matching `createPartGeometry` in `src/scene/geometry.ts` (centred, scaled to `dimensions`; `d = dimensions`):

| Primitive | Inside when |
|---|---|
| `box` | `|x| ≤ dx/2`, `|y| ≤ dy/2`, `|z| ≤ dz/2` |
| `sphere` | `(2x/dx)² + (2y/dy)² + (2z/dz)² ≤ 1` |
| `cylinder` | `|y| ≤ dy/2` and `(2x/dx)² + (2z/dz)² ≤ 1` |
| `cone` | `|y| ≤ dy/2` and `√((x/dx)² + (z/dz)²) ≤ 0.5 − y/dy` (apex at `+y`, as `ConeGeometry`) |
| `torus` | with `u = x/dx`, `v = y/dy`, `q = z · 0.25 / dz`: `(√(u² + v²) − 0.375)² + q² ≤ 0.125²` (axis `z`, inner diameter `0.5 · dx` by `0.5 · dy`) |
| `tube` | `|y| ≤ dy/2` and `tubeRatio/2 ≤ √((x/dx)² + (z/dz)²) ≤ 0.5` (axis `y`, inner diameter `tubeRatio · dx` by `tubeRatio · dz`) |
| `shell` (when `design-fidelity` adds it) | as `box`: the outer box touches the skin (R84) |

`PRIMITIVE_INSIDE` is a `Record<Primitive, InsideTest>`, so adding `shell` to `PartSchema` fails the type check until its row exists. A unit test compares every inside test with ray–mesh intersection parity on `createPartGeometry` meshes in Node (Three.js `Mesh.raycast` needs no renderer) on random points; segment counts of the meshes allow a tolerance of 1 % of the size.

**Ring candidates** (`ringCandidates(model)`): every `tube` (axis local `y`) and `torus` (axis local `z`) part whose inner diameters (mean of the two) lie in `[RING_MIN_MM, RING_MAX_MM]`, ordered by inner size, largest first; their centre and axis come from `worldMatrices(model)`. With none, the fallback axis is the model box's smallest extent through the box centre (`modelBox` in `shared/bounds.ts`). The user's `RingChoice` overrides both (R29).

**Face direction:** the volume-weighted mean position of the exterior parts that are not the ring part, projected perpendicular to the axis; if its length is under 2 mm, the model's `+y` projected; if that is degenerate too, the model's `+z`.

**Assemblies:** the worn set is `assemblyOf(ws, objectId)` (AJ). Parts of the other objects are placed in the worn object's frame through `objectMatrix` of their transforms relative to it, so a strap joined to a case is worn together (the demo path joins strap and case before 戴上).

**Inner profile** (`innerProfile(parts, ringFrame, bandHalfWidth)`): for `FIT_SLICES` slices at `y_k ∈ {−h + 0.5, 0, h − 0.5}` mm (`h` the band half-width: the ring part's half-height along the axis, or 10 mm for the fallback axis) and `FIT_ANGLES` directions `d(θ_j) = cos θ_j · z + sin θ_j · x`:

1. March from the axis outward in 1 mm steps up to `PROFILE_REACH_MM` (90 mm) until a point is inside any part (point transformed by each part's inverse world matrix; parts whose world box misses the slice are skipped).
2. Bisect the last step 6 times (1/64 mm).
3. No hit: `null` (open at this angle). Hit at 0 (the axis itself is inside a part): distance 0, which shows as pressing everywhere with 「環內有零件擋住」.

Cost: at most 3 × 72 × (90 + 6) ≈ 21 000 inside tests per part in range; the demo bracelet (6 parts) takes about 0.12 M tests, well under the 8 ms budget (bounded by a unit test that counts calls).

**Body angles:** a ring angle `θ` maps to a body angle by `θ_body = sign · θ + rollDeg` with `sign = +1` when the ring's `x` points to the thumb side of the worn arm and `−1` otherwise; `placement.ts` (T4) gives the sign from the arm's side and the mirror state; the maths takes it as a parameter.

### 6.5 Default arm profile

Before any measurement, the fit uses `w = 60 mm`, `t = 40 mm` at the band position, widening by `DEFAULT_TAPER` (0.12 mm of width per mm toward the elbow) with source 相機估計 only if a camera scale exists; otherwise the panel shows 「尚未量測手腕」 and no map. These numbers (**assumption**, an average adult wrist) only drive the proxy of R58 before measuring.

### 6.6 Local resize (`shared/fit-resize.ts`, used by `fit_to_body` and 調整為合適尺寸)

Input: the worn model, the ring part, the wrist ellipse `(a, b)` at the band position, the effective clearance `c`, the roll.

1. `g = offsetForPerimeter(a, b, c)`; target inner semi-axes `(A, B) = (a + g, b + g)`.
2. Map the across (`x`) and face (`z`) directions of the ring frame to the ring part's local axes: for a tube, local `x` and `z`; for a torus, local `x` and `y`; the local axis within 10° of the ring frame's `x` after the roll takes `A`. If the roll is not within 10° of a multiple of 90°, the ring is resized with `A = B = (A + B)/2` and the result says 「環的方向不是正對手腕，已改成圓形內圈。」.
3. **Tube:** keep the wall along the `A` axis: `wall = (1 − tubeRatio) · d_A / 2`; `d_A' = 2A + 2·wall`; `tubeRatio' = 2A / d_A'`; `d_B' = 2B / tubeRatio'`. **Torus:** `d_A' = 4A`, `d_B' = 4B` (inner diameter is half the outer), `dz` unchanged.
4. **Attached parts.** `Δ(u)` is the change of the ring's outer radius in direction `u` (outer ellipse before and after). Every direct child of the ring part moves by `Δ(û) · û`, where `û` is its position's direction perpendicular to the axis in the ring's local frame; descendants follow through their parents. Every other part whose world box lies within `ATTACH_GAP_MM` (1 mm) of the ring's outer box and whose centre lies outside the ring's inner hole moves the same way in the object frame, unless it is an ancestor of the ring. If the ring has a parent (for example a case is the root and the band its child), the ring's own position moves by `−Δ(f) · f`, with `f` the face direction, so the band keeps touching the case.
5. The plan is an `EditPlan` with `status: 'applied'` and one `upsert` per changed part, applied with `applyEditPlan` (`shared/edit.ts`) and validated with `validateModel`. A dimension outside `PartSchema`'s range or a `tubeRatio` outside `[0.05, 0.95]` throws `FitResizeError('FIT_OUT_OF_RANGE')`.
6. **Joined objects** (T6): after the resize, each joint whose side is the resized object is re-aligned with `realignJoint` (`shared/contact.ts`), so a case joined to the strap follows it. `realignJoint` throws `CANNOT_ALIGN` or `LINKED` in some layouts; the tool then keeps the resized object and reports 「接合的物件沒有跟著移動，請檢查接合位置。」.

### 6.7 Gaps, classes and the summary (`fitGaps`, `classify`, `fitSummary`)

- `gap(θ) = min_k (inner_k(θ) − arm_k(θ))`; an angle with `inner = null` on every slice is open (`'-'`).
- Class: `presses` if `gap < 0`; `fits` if `0 ≤ gap ≤ g_c + LOOSE_MARGIN_MM`; `loose` otherwise.
- Closure: `open` when the open angles form a run of at least `OPEN_GAP_DEG`; `no-ring` when every angle is open or the ring search found nothing; otherwise `closed` (or `clasp` when the user said so).
- `innerMm`: the polygon perimeter of the inner points at the slice with the smallest perimeter. `cannot-pass`: closed without a clasp and `innerMm < passage perimeter`.
- `state`, in this order of precedence: `no-ring`; `cannot-pass`; `open` is a closure, not a state, so an open ring gets the state of its closed angles; `mixed` when both red and amber angles exist; `presses` when any angle is red; `loose` when any angle is amber; `fits` when every non-open angle is green. The summary's angle ranges of R54 come from runs of equal classes, named by the side of their middle angle.

### 6.8 Invariants under property tests (R114)

| Invariant | Generator |
|---|---|
| `π(a+b) ≤ P(a,b) ≤ π√(2(a²+b²))`, `P(a,a) = 2πa`, `P` symmetric and increasing in `a` and `b` | `a, b ∈ [10, 80]` mm |
| polygon of `n ≥ 360` sampled points within 0.05 % of `P` | same |
| `r(φ) ∈ [min(a,b), max(a,b)]`, `r(φ) = r(φ + π)` | same, `φ` any |
| `offsetForPerimeter` gives `P(a+g, b+g) − P(a,b) = extra` to 1e-3 mm and is increasing in `extra` | `extra ∈ [0, 40]` |
| scaling every length (wrist, model, clearance) by `s` scales every gap and perimeter by `s` | `s ∈ [0.5, 2]`, random tube ring |
| a larger clearance never makes any gap of the resized ring smaller | two clearances `c1 < c2` |
| more tilt never makes the smallest gap larger | `τ1 < τ2 ∈ [0°, 30°]`, band half-width `[3, 20]` mm |
| after `resizeRing`, `spare = c` within 0.3 mm and no angle presses at slide 0, tilt 0 | wrist `w ∈ [45, 80]`, `t/w ∈ [0.55, 0.8]`, tube and torus |
| `classify` is monotone in the gap | random gaps |
| inside tests agree with mesh parity (1 % tolerance) | random points in the box ×1.2, every primitive |
| `widthAcross` recovers a band's width within one mask pixel | width `[20, 120]` px, angle any, edge blur `[0, 2]` px |

## 7. Panel, calibration and the measuring flow (T3; R7–R17, R21–R28, R73, R76–R81, R83)

- **Store** (`src/fit/store.ts`): a plain mutable store like `createSourceStore` in `useHandTracking.ts`, holding the `WristMeasurement`, `Calibration`, tape values, clearance, placement, closure and ring choice, with `subscribe` and `snapshot()`; no React render per frame. Session only (decision 5): created when the camera turns on, cleared when it turns off.
- **`useBodyFit`** subscribes to the `HandSource`, runs the active `MeasureStep`, sets the `segment` request through `segmentPlan`, and publishes a React snapshot at most 4 times a second (R109).
- **`FitPanel`** (`data-testid="fit-panel"`) renders the sections of R76 with the test attributes of R77. Values show their source with `shared/fit-text.ts`'s `sourceLabel` (相機估計, 卡片校正, 捲尺) and the spread.
- **`CardGuide`** draws in the overlay layer (R81), in client pixels through the inverse of `coverFrameBounds` (as `clientToNormalized` in `tests/fixtures/synthetic-hand.ts` does for tests). It holds the frozen frame as an `ImageBitmap` drawn on its own canvas; the bitmap is closed when the guide closes. Edges are focusable handles (`role="slider"`, `aria-label` 「卡片上緣」 etc.).
- **Placement until `workbench-ui` lands:** the panel renders in `.control-column` above `AgentPanel` (as `ExportDialog` does) and the guide inside `.viewport` above the canvas. The component takes `{ store, source, onClose }` props only, so `workbench-ui` can mount it in its slot without changes.

## 8. Wearing any object (T4; R1–R6, R29–R46, R53, R56, R57, R74, R75, R112)

### 8.1 From tracking to the body frame (`anchor.ts`)

`ArmTracker` (`arm-pose.ts`, unchanged) gives per frame the side, the wrist point, the orientation (radial, forearm direction, normal) and `source`. `bodyFrame(pose, scale)` turns it into the body frame: `Y` = forearm direction toward the hand, `Z` = the back of the hand (the pose's normal oriented by the side), origin = wrist moved `DEFAULT_BAND_OFFSET_MM + slide` toward the elbow, scale = the smoothed mm per frame-height unit (the overlay's units are frame heights, as today). `AnchorSmoother` runs One Euro filters on position (min cutoff 1.0 Hz, beta 0.02) and on the direction and normal (as unit vectors, renormalised), then the prediction of `createArmPreview.update` (`MAX_PREDICT_MS`, velocity-based) and the hold and fade of R44. It holds the worn side (R45).

### 8.2 Placement and the mirror (`placement.ts`)

`objectToBody(model, ring, face, placement)` is the matrix that puts the ring frame on the body frame and applies slide (translation along `Y`), tilt (rotation about `X`) and roll (rotation about `Y`). Model metres → millimetres (×1000) → frame heights (÷ mm per frame height). When the video is mirrored, the final matrix is pre-multiplied by `diag(−1, 1, 1)` and the materials use `side: THREE.DoubleSide` (a reflection flips triangle winding); the fit maths uses the unreflected matrix (R34). `sign` for body angles (§6.4) comes from the arm side and the mirror.

### 8.3 The view (`wear-view.ts`)

`createWearView()` replaces `createArmPreview()` with the same shape (`update(sample, enabled, now)`, `render(renderer)`, `opacity`, `dispose`), so the change in `SceneViewport.tsx` is local to the lines that create and call it today. It holds an orthographic camera fitted with `coverFrameBounds`, as today; a group with the worn object built by `buildModel` with opaque `MeshStandardMaterial`s in part colours (R33) and a hemisphere plus a key light; the fit ribbon; and (T5) the proxy, the shadow and the light follower. `setModel(models, ring, fit)` rebuilds only when the model changes, disposing the old group with `disposeObject`. The canvas exposes `data-arm-preview` (`visible`/`hidden`, kept for `arm-try-on.spec.ts`) and `data-fit-worn` (the worn object id).

`SceneViewport` gets a `bodyView` prop `{ sample: ref, worn: { objectIds, models, ring, fit, placement } | null }` instead of `tryOn`, and hides the meshes of `worn.objectIds` on the stage while it is set (R4), without touching the workspace.

### 8.4 Adjusting by hand (`adjust.ts`, pure)

Inputs per frame: the other hand's `HandSample` (`mapping.ts`'s `handSample`), its pinch state (`pinchStep`), its fist state (`fistStep`) and roll, the anchor's screen position, forearm direction on screen, and mm per client pixel. States: `idle → armed (pinch within ADJUST_REACH_MM) → slide | tilt (after ADJUST_DEAD_ZONE_MM, by the larger component) → idle`; `knob` while a fist of the other hand is held. Output: a placement delta and a badge text. It never reads the worn hand. Because hand control is off during fitting (HM R40), there is no competing gesture.

### 8.5 Fit ribbon and the fit dial

`fit-ribbon.ts` builds a strip along the inner profile at each band edge slice (72 segments, 1.5 mm wide, 0.3 mm inside the inner surface) with vertex colours from the classes, drawn after the object with the same depth rules, so the arm hides it like the object (T5). `FitDial.tsx` draws the wrist ellipse and the inner profile (at the narrowest slice) in a 160 px SVG, with the four side names, coloured segments, a dashed outline for 壓迫 so it reads without colour, and a visually hidden text listing the ranges of R54.

### 8.6 Recorder and replay (`recorder.ts`, R46, R75)

`?fit=record` adds 開始記錄 / 停止並下載 to the debug line. The recorder keeps `{ t, width, height, hands, body }` of each `TrackedFrame` (no `mask`, no image) up to 5 minutes, and downloads `forgehand-fit-recording-{yyyyMMdd-HHmm}.json` through a Blob link. `replay(frames)` runs `ArmTracker` and `AnchorSmoother` in Node and returns the four metrics of R75; `scripts/` is not used (verify scripts are reserved for real back ends); the user runs it through a Vitest test that is skipped unless `FIT_RECORDING=<path>` is set, so the default suite never needs a recording.

### 8.7 The demo bracelet (decision 14)

`shared/demo-bracelet.ts` (T4): 「示範智慧手環」 with a `tube` band (inner 62 × 46 mm, 18 mm wide, wall 3 mm), a case (`box`, later `shell`) on the face side, a battery and a board (`role: 'interior'`) as children of the case, and a clasp block. The fit panel shows 載入示範手環 when the workspace has no ring object; the action adds the object like 載入示範模型 does.

## 9. Looks worn (T5; R58–R62)

- **Mask texture.** The latest mask's skin and clothes planes become one `THREE.DataTexture` (two channels, `RGFormat`, `UnsignedByteType`, linear filtering), updated in place when a new mask arrives (64 KB × 2). Its crop rect gives a matrix from frame-height units to mask UV.
- **Mask shift** (R59): the uniform `uShift` moves the mask's UV by the anchor's predicted screen motion since the mask's capture time, so the mask stays on the arm between results. A mask older than `MASK_MAX_AGE_MS` sets `uUseMask = 0`.
- **Depth proxy** (`occlusion.ts`): an elliptic tube along the body `Y` from −30 to +70 mm with the measured profile (`w(s)`, `t(s)`), 48 segments, drawn first with `colorWrite: false` and a `ShaderMaterial` that discards fragments whose screen point has `max(skin, clothes) < 0.5` in the mask. The object's far-side faces then fail the depth test exactly where the real arm is. With no mask, the proxy writes depth everywhere (today's behaviour). The far-side ghost of `arm-preview.ts` (back faces, `depthTest: false`, opacity × `DEFAULT_BACK_OPACITY`) is kept.
- **Contact shadow** (`shadow.ts`): two rings of the proxy surface from each band edge outward by `SHADOW_WIDTH_MM`, and the proxy surface under the band, drawn with multiply blending, opacity `SHADOW_MAX` (0.35) × `(1 − smoothstep(0, SHADOW_WIDTH_MM, distance))` × `(1 − clamp(gap/4 mm))` per angle (closer object, darker shadow), gated by the same mask.
- **Light** (`light.ts`): `LightFollower` maps `luma` to `factor = clamp(luma / LIGHT_MID, LIGHT_MIN, LIGHT_MAX)` with `LIGHT_MID` 0.45 and a first-order filter (`LIGHT_TAU_MS`); the hemisphere and key light intensities are multiplied by it.
- **Cost:** three extra draws (proxy, shadow, ribbon) of under 2 000 triangles each and one 128 KB texture update at 3 Hz fit the 2.5 ms of §4.4.

## 10. Agent (T6; R63–R72, R82, R86)

- **`shared/agent.ts`:** `StateChangeSchema` gains `bodyFit: BodyFitChangeSchema.nullable().optional()` with `{ anchor: 'wrist' | 'off', objectId: ObjectId | null }` (T7 widens the enum). `AgentRequestSchema` gains `body: BodySnapshotSchema.optional()`. New details `AttachToBodyDetailSchema { anchor, objectId, cameraOn, message }` and `FitToBodyDetailSchema { objectId, method: 'resize' | 'edit', before: FitSummary, after: FitSummary | null, changes, message }`. `WearOnArmDetailSchema` is removed with the tool.
- **`server/tools/attach-to-body.ts`:** as R63–R64; with the camera on it returns `tryOn: true` and `bodyFit`; `helpers.ts`'s `checkedChange` strips `bodyFit` with `tryOn`, `exportDialog` and `cameraHidden` before the dry run.
- **`server/tools/fit-to-body.ts`:** reads `state.body` (the request's `body`, kept in `AgentWorkingState` next to `tryOn`; **assumption**: the working state is built in `server/agent.ts` from the request, as `tryOn` is at line 46 today). It recomputes the fit with `fitSummary` from the snapshot's measurement and the current model (never trusting the browser's `fit`), then: tube or torus ring → `resizeRing` (§6.6) and an `object` change of op `model` plus `realignJoint` moves; otherwise → `editTask(target.model, instruction, ringPartIds)` with a generated English instruction (model-facing, so it lives in `fit-to-body.ts`, not in `fit-text.ts`): `Resize the opening of the part(s) that wrap the wrist so the inner opening is {2A} mm wide along the model's {acrossAxis} axis and {2B} mm along its {faceAxis} axis, measured inside; move attached parts with it; keep the look and every other dimension.`, then the same validation as `edit_design` and a new `fitSummary`. The tool never claims a fit the summary does not show.
- **Instructions and state line:** `server/agent.ts`'s per-round state text (today 「試戴：已開啟」, line 200) adds 「量測：手腕 165 mm（捲尺），貼合度：餘量 15 mm，壓迫 拇指側」 from the snapshot; `AGENT_INSTRUCTIONS` gets the English lines of R72.
- **Browser:** `apply-state.ts` returns a `bodyFit` effect; `useAgentRun` starts or stops fitting with it (like `setTryingOn`); `request.ts` adds `body` from the fit store while fitting. The fit card (`FitCard.tsx`) renders a `FitToBodyDetail`; it registers with `workbench-ui`'s data card slot when it exists, else the fit panel shows the latest card under its numbers.
- **Instant path:** 調整為合適尺寸 calls `resizeRing` in the browser and commits through the same workspace path as an agent `model` change (one undo step).

## 11. Head and foot (T7; R87–R107)

### 11.1 Spike (gated by the user's go)

A temporary branch of the worker (not merged; the spike writes only `.kiro/specs/body-fit/spike-head.md` and throwaway code that is deleted) creates `FaceLandmarker` (`numFaces: 1`, VIDEO, `outputFacialTransformationMatrixes: true`) beside hand and pose, logs per frame: the matrix, the inference time, and the landmarks 1, 234, 454 and the iris landmarks 468–477. The user holds still, turns the head ±30°, and moves 20 cm nearer. Questions answered: translation units (expected centimetres, **assumption**) and axes against the overlay's view space; whether the mirrored frame flips handedness; jitter (mm and degrees, still head); cost with two hands; warm-up time; whether the iris scale agrees with a card on the forehead.

### 11.2 Head frame

With a go, the head frame is the matrix converted to the overlay's units (the spike's result decides the conversion). With a no-go, it is built from landmarks: origin at the midpoint of 234 and 454, `x` from 234 to 454, `y` from the chin (152) to the forehead (10) orthogonalised, `z = x × y`; scale from the iris (R89).

### 11.3 Head measurement and fit

`head.ts`: iris diameter in px (mean of the horizontal spans of both irises) → `mmPerPx = IRIS_DIAMETER_MM / px` (source 相機估計); card on the forehead (the same `CardGuide`, depth correction with `t` = 0); tape circumference. Face width 234–454; head ellipse per R90. The ring fit of §6 runs with the head ellipse instead of the wrist (slices across the band, tilt front to back). Glasses: the object's inner width at the temple line (the inner profile along `x` at the ear plane) against the face width. Occlusion uses the mask classes of R92 and an ellipsoid proxy.

### 11.4 Foot

`foot.ts`: the pose world landmarks of the chosen side (`bodyWorld`, new optional field of the frame, filled only while the foot anchor is on) give heel → foot index for direction and length (metres → mm, source 相機估計), ankle for height. The object's longest axis aligns with the foot; length and width room are compared with the measured or typed foot (R101–R103); the agent resizes through the edit task. The camera view needs the whole foot: the panel shows R104's instruction until both heel and foot index are visible (`visibility ≥ 0.5`).

## 12. Test strategy

### 12.1 Unit and property tests (Vitest, Node, no DOM)

- **T1:** `fit-ellipse.test.ts` (perimeter bounds, polygon convergence, ray–ellipse, offset), `fit-geometry.test.ts` (inside tests vs mesh parity, ring candidates on `tests/fixtures/fit-bracelet.ts`, face direction, inner profile of a tube equals its analytic inner ellipse within 0.1 mm, open C cuff, no-ring, axis blocked), `fit-gaps.test.ts` (arm section with tilt and roll, classes, summary states, effective clearance for closed rings, cannot-pass), `fit-resize.test.ts` (tube and torus resize, child and attached parts moved, ring with a parent, out of range). The property invariants of §6.8.
- **T2:** `fit-measure.test.ts` (mm per px on synthetic hands of known size: `syntheticHand` lays out an 8 cm palm, `widthAcross` on `tests/fixtures/fit-mask.ts`, pose checks, robust median), `fit-cadence.test.ts`, `fit-worker-protocol.test.ts` (types round-trip: a frame without `segment` is unchanged).
- **T3:** `fit-card.test.ts` (edge finding on synthetic cards, factor, depth correction, aspect and range rejection), `fit-store.test.ts` (tape combination, sources, clearing).
- **T4:** `fit-anchor.test.ts` (body frame, hold and fade, side lock, prediction), `fit-adjust.test.ts`, `fit-placement.test.ts` (mirror, body-angle sign), `fit-replay.test.ts` (synthetic noisy sequences from `tests/fixtures/fit-sequence.ts` meet R75's targets; the real-recording test is skipped without `FIT_RECORDING`).
- **T5:** `fit-occlusion.test.ts` (mask UV matrix, shift, age), `fit-light.test.ts`.
- **T6:** `fit-agent.test.ts` (both tools with a fake `ModelProvider`; resize path makes no provider call; edit path calls the fake once and reports the recomputed fit; errors; `checkedChange` strips `bodyFit`; request schema with and without `body`).
- **T7:** `fit-head.test.ts`, `fit-foot.test.ts` with synthetic face and pose landmarks.

### 12.2 E2E (Playwright, fake camera, synthetic hands)

`tests/e2e/fake-body.ts` (T2) installs a scripted worker on the same route pattern as `fake-hands.ts` (so only one of them is installed per test). It answers frames with the hands posted on `BroadcastChannel('forgehand-fake-body')` and, for frames with `segment`, with a mask posted by the test, which builds it with `tests/fixtures/fit-mask.ts` from the requested crop (the fake worker echoes the crop). It also answers `luma`. No model is downloaded.

The full suite takes about 25 minutes on the laptop, so each task runs only the specs it can affect (with `PLAYWRIGHT_GPU=1`, per the user's rules):

| Task | Specs to run |
|---|---|
| T1 | none (pure) |
| T2 | `arm-try-on.spec.ts`, `hand-control.spec.ts` (worker protocol and hook changes) |
| T3 | `body-fit.spec.ts` (new: measure steps, tape, card guide), `arm-try-on.spec.ts` |
| T4 | `body-fit.spec.ts`, `arm-try-on.spec.ts` (updated per decision 4), `hand-control.spec.ts`, `workspace.spec.ts` (stage hiding) |
| T5 | `body-fit.spec.ts`, `arm-try-on.spec.ts`, `visual-backgrounds.spec.ts` |
| T6 | `body-fit.spec.ts`, `agent-panel.spec.ts`, `arm-try-on.spec.ts`, then the **full suite once** (end of P0) |
| T7 | `body-fit.spec.ts`, `arm-try-on.spec.ts`, `hand-control.spec.ts` |

Pixel checks (T5): the test takes `page.screenshot({ clip })` of two points on the far side of the ring, one inside and one outside the synthetic arm mask, and decodes them with a small PNG reader in the test helper using `node:zlib` (no new dependency); inside the mask the object colour must be at most the ghost level. If this proves flaky after two or three attempts, the task stops and reports (the attribute checks stay).

## 13. Task plan and requirement map

| Task | Priority | Requirements |
|---|---|---|
| T1 Fit maths and property tests | P0 | R18, R26, R47–R52, R54 (texts), R55, R57 (pure), R66–R67 (resize), R73 (spread maths), R83, R84, R113–R116 |
| T2 Worker segmenter and measurement core | P0 | R5, R9, R19, R20, R22–R23 (pure), R59 (mask data), R61 (luma), R85, R108, R109, R110 |
| T3 Scale sources, card calibration, measuring panel | P0 | R7, R8, R10–R17, R21, R24–R28, R73, R76–R81 |
| T4 Wearing any object, adjusting, stability, fit map | P0 | R1–R4, R6, R29–R46, R53, R54, R56, R57, R74, R75, R112 |
| T5 Looks worn | P0 | R58–R62 |
| T6 Agent, fit card, README | P0 | R63–R72, R82, R86, R108 (README), R111, R117, R118 |
| T7 Head (spike-gated) and foot | P1, P2 | R87–R107 |

R112, R113, R116, R117 and R119 apply to every task.

## 14. File ownership

| File | Body-fit tasks | Other specs that touch it |
|---|---|---|
| `shared/fit*.ts`, `shared/ellipse.ts`, `shared/body.ts`, `shared/demo-bracelet.ts` | T1 (T4 demo, T7 extends) | none (`english-ui` replaces `shared/fit-text.ts` later; `design-fidelity` adds the `shell` row to `PRIMITIVE_INSIDE`) |
| `src/fit/**` | T2–T7 | `workbench-ui` mounts `FitPanel`, `CardGuide`, `FitCard` in its slots (read only) |
| `src/try-on/arm.worker.ts`, `src/try-on/arm-pose.ts` | T2, T7 | `hand-manipulation` (its tasks are done as of 2026-11-26; any new HM task) |
| `src/hands/useHandTracking.ts` | T2 | `hand-manipulation` |
| `src/try-on/useArmTracking.ts` | T4 | `hand-manipulation` (consumer only) |
| `src/scene/arm-preview.ts` | T4 (deleted) | none |
| `src/scene/SceneViewport.tsx` | T4, T5 | `hand-manipulation`, `assembly-joints`, `export`, `workbench-ui` (likely), `design-fidelity` (likely, cutaway) |
| `src/App.tsx`, `src/styles.css` | T3, T4, T6 | `workbench-ui` (layout), `english-ui` (strings), `assembly-joints`, `hand-manipulation` |
| `shared/agent.ts`, `server/agent.ts`, `server/tools/index.ts`, `server/tools/helpers.ts`, `src/agent/*` | T6 | `workbench-ui` (data cards, likely), `design-fidelity` (research tool), `english-ui` |
| `server/tools/attach-to-body.ts`, `fit-to-body.ts`; `server/tools/wear-on-arm.ts` (deleted) | T6 | none |
| `tests/unit/fit-*.test.ts`, `tests/fixtures/fit-*.ts`, `tests/e2e/fake-body.ts`, `tests/e2e/body-fit.spec.ts` | T1–T7 | none |
| `tests/e2e/arm-try-on.spec.ts` | T4 | none (HM required it to pass unchanged; decision 4 changes it) |
| `tests/unit/tool-registry.test.ts`, `agent-tools.test.ts`, `agent-loop.test.ts`, `agent.test.ts`, `run-reducer.test.ts` | T6 (only the `wear_on_arm` lines) | any spec that registers a tool |
| `README.md` | T6 | every spec |
| `package.json`, `package-lock.json` | T1 (only if decision 1 = A) | any spec that adds a package |
| `.kiro/specs/body-fit/**` | all (T6 `validation.md`, T7 `spike-head.md`) | none |

## 15. Parallel-session rules

Other Kiro sessions (`workbench-ui`, `design-fidelity`, `english-ui`) work in the same tree at the same time. Every task repeats these rules in its session facts:

- Create and edit only the files the task lists. Never revert, reformat, stage or "fix" a file you did not change; never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean`; never commit.
- Before the first edit of a file another spec touches (the right column of §14), run `git status --short <file>`. If it shows changes, another session is working on it: stop and ask. Do not wait in a loop.
- Keep edits to shared files small and additive (a prop, a field, a mount point), so a parallel `workbench-ui` change merges cleanly.
- If `npm run check` fails only in files you did not touch, report the files and the error and do not fix them.
- Only one session runs Playwright at a time (ports 5197/8797). If they are taken, wait a few minutes and try again, at most three times, then report. Never stop a process you did not start.
- No real model calls, no `verify:real` or `verify:edit`, no model download unless the task says the user allowed it.

## 16. Risks

- **Segmenter speed.** No number exists for the multiclass model on an HD-class integrated GPU; Google lists 71 ms (GPU) and 218 ms (CPU) on a Pixel 6. At 9–10 fps with two hands (VISION §4.9), a 120 ms segmenter every third frame brings the rate to about 7 fps; a slower one triggers the back-off. Decision 17 holds the fallbacks.
- **Measurement accuracy.** No published accuracy exists for webcam wrist measurement (VISION §6). Error sources: the hand model's scale (unknown, corrected by the card), mask edges (about ±1 mask pixel, ±0.6 mm per edge with the 160 mm crop), sleeves and watches covering skin, and the ellipse model (a real wrist is closer to a rounded rectangle, so the ellipse perimeter may read low). The tape stays the reference and R27 shows the error every time.
- **Card depth and focal length.** The depth correction uses an assumed field of view; its effect is small (§6.3) but untested on the user's webcam.
- **Generated bracelets.** A model may build a band from boxes or with a `cylinder` instead of a `tube`; the fallback axis and the edit path handle it, but the local resize does not. The demo bracelet avoids this for the video.
- **Mirror handedness.** Drawing the object reflected is correct for a mirror but makes text or asymmetric parts read reversed, as in a real mirror; the user should confirm in the manual check.
- **Shared files.** `App.tsx` and `SceneViewport.tsx` are edited by three parallel specs; T4 and T6 are the riskiest merges.
- **Head matrix units.** Unknown until the spike (VISION §6).
