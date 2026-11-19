# Hand manipulation — Design

This design satisfies `requirements.md`. It follows the patterns of `agent-harness` and `workspace-v2`: pure modules unit-tested in Node (no DOM), thin React and Three.js wiring covered by Playwright, and one place for every rule. Requirement numbers (R…) refer to `requirements.md`; they are stable ids, so R73 and above were added on 2026-11-19.

Tasks 1 and 2 (T1, T2) were built under the 2026-11-15 version of this design and are committed. Their sections below describe what was built; where the two-hand version changes their code, the change is marked with the later task that makes it (T3–T9). §15 lists all of those changes.

## 1. Approach

The work splits into four layers, each depending only on the one above it:

```
tracking     useHandTracking: one worker per camera session, up to two hands per frame,
             frames out through a HandSource (R1–R7, R73, R74, R76)
               ├─ useArmTracking (try-on, unchanged behaviour) consumes the same frames
               └─ useHandControl (this spec) consumes them too
input        pure, per hand: landmark → screen mapping, One Euro cursor, pinch state machine,
             fist state machine (T7), picking and settling; hand slots (R12, R19–R23, R78, R79, R89, R90)
gestures     pure: gates, decisions, the two-hand HandController with a port interface, the join rule,
             pair geometry, drag/orbit/zoom/explode/rotate maths (R24–R42, R81–R87, R91–R98)
wiring       SceneViewport sessions, the overlay canvas, the status line, the debug panel,
             App state: camera image, gates, commits (R8–R18, R43–R46, R75–R77)
```

The **HandController** is the heart of the design. It is a plain class that receives every hand sample of a tracking frame and a tick per video frame. It keeps one **track** per hand slot (filter, pinch state, settled target, later fist state) and at most one **session**: the running gesture, its owner hand and an optional joining hand. It talks to the outside only through a small `HandPort` interface (pick, select, begin a grab, begin an orbit, press; with the fist also activate, begin a hold and the explode amount). Unit tests drive it with synthetic landmark sequences and a fake port, so every gesture rule, including the two-hand arbitration, is tested without a browser. In the app, `useHandControl` implements the port with `SceneViewport`'s imperative methods and App's callbacks.

A hand drag is a **scene session** owned by `SceneViewport`: it moves the part's (or, with a fist, the object's) scene node as a preview, exactly as the gizmo moves it, and on release calls the same callback the gizmo calls (`onTransform`), or for an object the 物件 panel's path. App commits it as one undo step. A two-hand gesture does not create a second scene session: it feeds a second input into the owner's session (zoom into the orbit session, rotation into the grab session, explode amount next to the hold session). Nothing in `shared/` changes except the optional state-change flag of T9.

The tracking worker file stays where it is (`src/try-on/arm.worker.ts`) and its protocol only gained an optional field (T1), so the existing try-on fake in `arm-try-on.spec.ts` keeps matching and working.

## 2. Module layout

```
src/try-on/arm-pose.ts             T1 ✓  ArmWorkerFrame gains `pose?: boolean`
src/try-on/arm.worker.ts           T1 ✓  pose only when the frame asks for it
                                   T3    numHands: TRACKED_HANDS
src/try-on/useArmTracking.ts       T1 ✓  consumes a HandSource; same return shape and texts
src/hands/useHandTracking.ts       T1 ✓  worker lifecycle, capture loop, watchdogs, HandSource, rate
                                   T3    capture-loop fallback when video-frame callbacks stall
src/hands/tracking-plan.ts         T1 ✓  trackingPlan, RateWindow;  T3 frameClockStep
src/hands/constants.ts             T2 ✓  P0 constants;  T3, T4, T6–T8 add theirs
src/hands/types.ts                 T2 ✓  Point, HandSample, Target, ScreenTarget, HandState
                                   T3    HandSlot, HandView per hand, OverlayFrame, GestureKind, palm; no HandMode
                                   T4    HandState 'join';  T7 'fist', 'hold', curl
src/hands/mapping.ts               T2 ✓  landmarkToClient, handSample;  T3 palm;  T7 curl
src/hands/one-euro.ts              T2 ✓  OneEuroFilter2D (one per hand, plus a palm filter per hand from T4)
src/hands/pinch.ts                 T2 ✓  pinchStep (unchanged; one state per hand)
src/hands/targets.ts               T2 ✓  pickTarget, settleStep (unchanged; one state per hand)
src/hands/skeleton.ts              T2 ✓  HAND_CONNECTIONS, drawHand
                                   T4    drawRing, drawBadge, badgeBox, drawLink;  T7 drawSquare;  T8 drawArc
src/hands/style.ts                 T2 ✓  T3: HAND_COLOUR, LINK_COLOUR, overlayStyle({ state }) without a mode;  T7 fist marks
src/hands/HandOverlay.tsx          T2 ✓  T3: draws up to two hands, per-hand attributes;  T5: marks, badges, link
src/hands/useHandControl.ts        T2 ✓  part 1 (skeleton of hands[0])
                                   T3    every hand, gate style, status line, debug numbers;  T5 the controller
src/hands/slots.ts                 NEW   T3 dedupeHands;  T4 assignHands
src/hands/gate.ts                  NEW   T3 handGate, speedStep
src/hands/text.ts                  NEW   T3 handStatus, trackingDebugLine;  T4 shortenName, badgeText, debugLine
src/hands/HandDebugPanel.tsx       NEW   T3 tracking numbers;  T5 gesture counters
src/hands/decide.ts                NEW   T4 decidePinch;  T7 decideFist
src/hands/pair.ts                  NEW   T4 pairSpan, pairAngle, angleDelta, beyondDeadZone
src/hands/join.ts                  NEW   T4 joinGesture (no rows);  T6, T7, T8 add one row each
src/hands/controller.ts            NEW   T4 HandController, HandPort, session interfaces
src/hands/stats.ts                 NEW   T4 HandStats
src/hands/drag.ts                  NEW   T4 dragPosition, orbitOffset;  T6 zoomRatio;  T7 explodeAmount;  T8 rotateAboutView
src/hands/fist.ts                  NEW   T7 curlRatio, fistStep
src/scene/hand-sessions.ts         NEW   T5 createGrabSession, createOrbitSession, grabStillValid;
                                         T6 orbit zoom;  T7 createHoldSession;  T8 grab rotation
src/scene/SceneViewport.tsx        EDIT  T5 hitTest, beginPartGrab, beginOrbit, busy and cancel rules, onTransform kind;
                                         T6 data-camera-target;  T7 beginObjectHold, onObjectMove
src/App.tsx                        EDIT  T1 ✓ 手勢 switch and tracking;  T2 ✓ overlay;
                                         T3 camera image toggle, slow state, gate, status line, debug panel;
                                         T5 controller wiring, onTransform kind, cancel notice;
                                         T7 object move, activation and explode from hands;  T8 move-and-rotate notice;
                                         T9 cameraHidden from agent events
src/styles.css                     EDIT  .hand-overlay (T2 ✓); T3 .hand-status, .hand-debug only if needed
src/agent/apply-state.ts, src/agent/useAgentRun.ts     EDIT  T9
shared/agent.ts                    EDIT  T9 StateChangeSchema.cameraHidden (optional), SetCameraImageDetailSchema
server/tools/set-camera-image.ts   NEW   T9
server/tools/index.ts, server/tools/helpers.ts, server/agent.ts   EDIT  T9
README.md                          EDIT  T1 ✓ privacy line;  T5 hand control section;  T6–T9 one line each
.kiro/steering/structure.md        EDIT  T1 ✓ a `src/hands/` line

tests/fixtures/synthetic-hand.ts   T1 ✓  syntheticHand, clientToNormalized;  T7 fist option
tests/unit/hand-tracking.test.ts   T1 ✓  trackingPlan, rate window;  T3 frameClockStep
tests/unit/hand-input.test.ts      T2 ✓  mapping, One Euro, pinch, picking, settling;
                                   T3    palm, dedupeHands, overlayStyle without a mode;  T4 assignHands
tests/unit/hand-gate.test.ts       NEW   T3 gates, speed, handStatus, trackingDebugLine
tests/unit/hand-controller.test.ts NEW   T4 decision, join rule, pair geometry, controller with a fake port,
                                         texts, stats, badge boxes;  T6–T8 extend
tests/unit/hand-drag.test.ts       NEW   T4 drag and orbit maths;  T6 zoom;  T7 object move and explode;  T8 rotate
tests/unit/hand-sessions.test.ts   NEW   T5 grab and orbit sessions, grabStillValid;  T6–T8 extend
tests/unit/hand-fist.test.ts       NEW   T7 curlRatio, fistStep
tests/e2e/fake-hands.ts            T1 ✓  installFakeHands, showHand, hideHand, fakeHandsLog;  T3 showHands;  T7 fists
tests/e2e/hand-control.spec.ts     T1 ✓, T2 ✓;  grows task by task (T3–T9)
tests/e2e/workbench.spec.ts        T1 ✓  installFakeHands only
tests/e2e/visual-backgrounds.spec.ts T1 ✓ installFakeHands only
```

`src/hands/` never imports `server/`. Pure modules (`mapping`, `one-euro`, `pinch`, `targets`, `slots`, `gate`, `decide`, `pair`, `join`, `controller`, `text`, `stats`, `drag`, `fist`, `style`, and `badgeBox` in `skeleton`) import only Three.js math classes and each other, so they run in Vitest under Node like `shared/bounds.ts`.

## 3. Shared tracking

### 3.1 Worker protocol (`arm-pose.ts`, `arm.worker.ts`)

`ArmWorkerFrame` gained one optional field (T1):

```ts
export interface ArmWorkerFrame { bitmap: ImageBitmap; width: number; height: number; timestamp: number; pose?: boolean }
```

The worker runs pose only when `pose !== false` and the existing `POSE_INTERVAL_MS` has passed; otherwise it sends `body: []` and resets `lastPose`, so the next try-on frame runs pose at once. A missing field keeps the old behaviour. The flag rides on the frame, not on a separate message, because the try-on fake in `arm-try-on.spec.ts` treats every message as a frame and would fail on a message without a bitmap (R5). The worker still loads and warms both models at start (R3); §14 lists lazy pose loading as a later improvement.

**Two hands (T3, R73).** `HandLandmarker.createFromOptions` gets `numHands: TRACKED_HANDS` (2, from `src/hands/constants.ts`) instead of 1. Nothing else in the worker changes: it already maps every detected hand into `hands`, and `ArmTracker` already ranks candidates over all hands of a frame, so try-on keeps working and its fake (one hand) is unaffected. The handedness label is still passed through for try-on, which uses it as a hint; hand control ignores it (R78), because frames are mirrored before tracking and MediaPipe documents that a mirrored image inverts the labels.

**Expected cost (R74).** The imported prototype measured, on the user's 2-core laptop with Intel HD 620, a median of 34 ms per frame for one hand plus pose on the GPU, and 552 ms for two hands plus pose on the CPU (`docs/PRIOR_WORK.md`). With `numHands: 2`, MediaPipe's tracking re-runs palm detection while fewer hands are tracked than allowed (its `minHandPresenceConfidence` rule re-triggers detection), so with one hand in view palm detection probably runs on every frame instead of only after a loss, and a second hand adds a second landmark pass. Our estimate, not a measurement: about 1.5–2× the one-hand inference time on the GPU, roughly 50–70 ms, which with one frame in flight gives about 14–20 frames per second. That is above `MIN_CONTROL_FPS` (10) but leaves less margin. The speed gate stays unchanged (§5.1). The T3 report asks the reviewer to measure one and two hands on the real webcam with `?hands=debug`; if two hands are too slow, `TRACKED_HANDS = 1` restores the old cost and two-hand gestures simply never start.

### 3.2 `useHandTracking` (`src/hands/useHandTracking.ts`)

The worker lifecycle, the capture loop, the load timeout and the per-frame watchdog moved here from `useArmTracking` (T1) with their logic unchanged (frame interval 30 ms, longest edge 640 px, mirrored copy, one frame in flight).

```ts
export type TrackerStatus = 'off' | 'loading' | 'ready' | 'load-error' | 'track-error';
export interface TrackedFrame extends LandmarkFrame {
  requestedAt: number; capturedAt: number; receivedAt: number; inferenceMs: number; pose: boolean;
}
export interface HandSource {
  latest(): TrackedFrame | null;
  subscribe(listener: (frame: TrackedFrame) => void): () => void;
  onTick(listener: (now: number) => void): () => void;
  rate(): number | null;
  delegate(): TrackingDelegate | null;
}
export function useHandTracking(videoRef, options: { running; needed; wantPose; mirrored; onRate? }): { source: HandSource; status: TrackerStatus };
```

`trackingPlan` (pure, `tracking-plan.ts`) decides the worker's life: start on first need, keep it while the camera stays on, send no frames while not needed, stop with the camera (R1, R2, R9, R66). Listeners run synchronously in the worker's `onmessage`; the hook calls `setState` only for status changes (R4, R64).

**Capture-loop fallback (T3, R76).** Chromium may stop calling `requestVideoFrameCallback` for a video it does not paint, and whether an `opacity: 0` video counts as painted is not specified. The loop therefore checks its own clock. A pure helper in `tracking-plan.ts`:

```ts
export type FrameClock = 'video-frame' | 'animation-frame';
export function frameClockStep(input: { clock: FrameClock; lastCallbackAt: number | null; now: number; playing: boolean }): FrameClock;
```

returns `'animation-frame'` when the clock is `'video-frame'`, the video is playing (`readyState >= 2`, not paused) and no video-frame callback has arrived for `VIDEO_FRAME_STALL_MS` (500 ms, a local constant of the hook, not a tuning constant); otherwise it keeps the clock. A `setInterval` of `VIDEO_FRAME_STALL_MS` runs while the worker is ready and asks `frameClockStep`; on a switch it cancels the pending video-frame callback and schedules `captureFrame` with `requestAnimationFrame` for the rest of the camera session. The existing `video.currentTime === lastVideoTime` check already skips repeated video frames, so the rAF loop sends no duplicates; ticks and the watchdog are unchanged. The interval is cleared in `stop()` (R66). The code path is the one already used when `requestVideoFrameCallback` is missing, so the fallback is small.

### 3.3 `useArmTracking` as a consumer

```ts
export function useArmTracking(source: HandSource, tracker: TrackerStatus, enabled: boolean):
  { sample: RefObject<ArmSample | null>; status: ArmTrackingStatus; stats: ArmTrackingStats | null };
```

Unchanged since T1. It subscribes while try-on is active and runs `ArmTracker.update(frame, frame.capturedAt)` on every frame, with all of its hands (R5, R73).

### 3.4 App: the 手勢 switch and tracking (R8–R11)

Built in T1: `handsOn` (default `true`, reset in `stopCamera` and on a failed start); `useHandTracking(videoRef, { running: camera === 'on', needed: handsOn || tryOnActive, wantPose: tryOnActive, mirrored, onRate })`; the 手勢 button after 護臂試戴 while the camera is on. T3 passes `onRate` (§5.1).

### 3.5 The camera image (T3, R75–R77)

```ts
const [cameraHidden, setCameraHidden] = useState(false);   // reset to false in stopCamera and on a failed start
```

- **Button.** After 手勢 in the first `.stage-toolbar` group, only while `camera === 'on'`: `<button type="button" className={`button ${cameraHidden ? 'active' : ''}`} aria-pressed={cameraHidden}>隱藏鏡頭畫面</button>`. It is not disabled during agent runs (it changes no data). The name contains none of 開啟攝影機, 關閉攝影機, 取消開啟, 即時攝影機背景, 手勢, 護臂試戴, 提高背景對比 (R75); new tests use `exact: true`.
- **Hiding.** The video's class becomes `camera-video ${camera === 'on' && !cameraHidden ? 'visible' : ''} ${mirrored ? 'mirrored' : ''}`. The existing rule `.camera-video { opacity: 0 }` without `visible` hides it, so the viewport's own background and grid, the same backdrop as with the camera off, show through. `srcObject`, `play()` and the element stay as they are; no `display: none`. The video gets `data-image-hidden="true|false"` for tests. The capture loop keeps running through §3.2's fallback if needed.
- **Unchanged.** The 3D scene, the overlay, the try-on cuff, the status lines and `mirrored`.
- **Agent (T9).** `useAgentRun` gets `setCameraHidden(hidden)`; App applies it only while `camera === 'on'` (§10).

## 4. Input pipeline (pure)

### 4.1 Constants (`constants.ts`, R47)

| Constant | Default | Task | Meaning |
|---|---|---|---|
| `CURSOR_POINT` | `'pinch-midpoint'` | T2 ✓ | `'pinch-midpoint'` (landmarks 4 and 8) or `'index-knuckle'` (landmark 5) |
| `CURSOR_MIN_CUTOFF` / `CURSOR_BETA` / `CURSOR_D_CUTOFF` | 1.0 Hz / 0.01 / 1.0 Hz | T2 ✓ | One Euro filter |
| `PINCH_ENGAGE_M` / `PINCH_ENGAGE_FRAMES` | 0.03 m / 2 | T2 ✓ | R20 |
| `PINCH_RELEASE_M` / `PINCH_RELEASE_FRAMES` | 0.05 m / 3 | T2 ✓ | R20 |
| `HOVER_SETTLE_MS` | 150 | T2 ✓ | R23 |
| `HAND_LOST_MS` | 300 | T2 ✓ | a hand's skeleton hides; its filter and an idle pinch reset |
| `DRAG_DEAD_ZONE_PX` | 8 | T2 ✓ | R29, also the fist move (R92) |
| `DRAG_GAIN` | 1.5 | T2 ✓ | R30, also the fist move |
| `ORBIT_DEG_PER_PX` | 0.4 | T2 ✓ | R35 |
| `TRACKING_LOSS_MS` | 300 | T2 ✓ | R37, R84 |
| `ON_TRACKING_LOSS` | `'cancel'` | T2 ✓ | R37 |
| `MIN_CONTROL_FPS` / `SPEED_HOLD_MS` | 10 / 2000 | T2 ✓ | R40 |
| `CANCEL_NOTICE_MS` | 4000 | T2 ✓ | R43 |
| `BADGE_NAME_MAX` | 12 | T2 ✓ | R16 |
| `TRACKED_HANDS` | 2 | T3 | R73; 1 restores one-hand tracking |
| `DUPLICATE_HAND_PX` | 40 | T3 | R78; palm centres closer than this are one hand |
| `HAND_MATCH_PX` | 160 | T4 | R78; farther than this from a tracked slot is a new hand |
| `TWO_HAND_MIN_SPAN_PX` | 60 | T4 | R83, R87, R96 |
| `ZOOM_DEAD_ZONE_PX` | 12 | T6 | R87 |
| `FIST_ENABLED` | `true` | T7 | R89 |
| `FIST_ENGAGE_RATIO` / `FIST_ENGAGE_FRAMES` | 1.0 / 3 | T7 | R89 |
| `FIST_RELEASE_RATIO` / `FIST_RELEASE_FRAMES` | 1.25 / 3 | T7 | R89 |
| `EXPLODE_DEAD_ZONE_PX` | 12 | T7 | R93 |
| `EXPLODE_FULL_FRACTION` | 0.5 | T7 | R93; spreading by half the view height goes from 0 to fully exploded |
| `ROTATE_DEAD_ZONE_DEG` | 5 | T8 | R96 |

T3 removes the header comment's mention of `ROTATE_DEG_PER_PX`, `DOUBLE_TAP_MS` and `DOUBLE_TAP_PX`, which are no longer added.

### 4.2 Types (`types.ts`)

T2 built `Point`, `HandMode`, `HandState`, `HandSample`, `Target`, `ScreenTarget`, `HandView` and `targetKey`. T3 reshapes them for two hands:

```ts
export interface Point { x: number; y: number }                  // client (CSS) pixels
export type HandSlot = 0 | 1;
export type HandState = 'none' | 'tracked' | 'hover' | 'grab' | 'orbit' | 'locked'
  | 'join'                 // T4: the second hand of a two-hand gesture
  | 'fist' | 'hold';       // T7
export interface HandSample {
  points: Point[];          // the 21 landmarks in client pixels, for drawing
  cursor: Point;            // unfiltered CURSOR_POINT
  palm: Point;              // T3: mean of landmarks 0, 5, 9, 13, 17; used for slots and the fist
  pinchM: number | null;    // world distance 4–8 in metres; null without world landmarks
  curl?: number | null;     // T7: curl ratio (§9.1); null without world landmarks
}
export type Target = { kind: 'empty' } | { kind: 'screen'; id: string; label: string }
  | { kind: 'part'; objectId: string; partId: string; label: string; hit: { x: number; y: number; z: number } };
export interface ScreenTarget { id: string; label: string; left: number; top: number; right: number; bottom: number }
export type GestureKind = 'none' | 'grab' | 'orbit' | 'press' | 'zoom' | 'hold' | 'explode' | 'rotate';
export interface HandView {
  slot: HandSlot; state: HandState; targetKey: string;
  points: readonly Point[]; cursor: Point; palm: Point;
  badge: string | null;                       // drawn from T5
}
export interface OverlayFrame {
  hands: readonly HandView[];                 // at most two, in slot order
  gesture: GestureKind;
  link: { from: Point; to: Point } | null;    // the line between the hands (R86)
  arc: { centre: Point; fromDeg: number; toDeg: number } | null;   // T8
}
```

`HandMode` and `HandView.mode` are removed (there is no hand mode). `targetKey` is unchanged.

### 4.3 Mapping (`mapping.ts`, R7, R12)

Built in T2. Landmarks arrive in display space, because the frame is flipped before tracking when the video is mirrored (R7). The mapping only undoes `object-fit: cover`:

```ts
export function landmarkToClient(point, view, video): Point;
export function handSample(hand: HandLandmarks, view, video, cursorPoint = CURSOR_POINT): HandSample | null;
```

T3 adds `palm` (the mean of the client points 0, 5, 9, 13 and 17: the wrist and the four knuckles, which stay still while the fingers curl). T7 adds `curl` (§9.1). `handSample` still returns `null` for a hand with fewer than 21 finite points.

### 4.4 One Euro filter (`one-euro.ts`, R19)

Built in T2: `OneEuroFilter2D` (Casiez et al., CHI 2012) with `filter(point, timeMs)` and `reset()`. From T4 each track owns two: one for the cursor and one for the palm centre (the slot matching and the fist use the palm). A track's filters reset when its hand has been missing for `HAND_LOST_MS`.

### 4.5 Pinch state machine (`pinch.ts`, R20, R21, R29)

Built in T2 and unchanged: `pinchStep(state, input, now)` with the events `found`, `lost`, `engage`, `drag-start` and `release { tap }`. Thresholds count only tracking frames; `null` distance never engages; a hand back within the time-out continues the same pinch. Each track has its own `PinchState`. The double-tap event of the 2026-11-15 version is not added. T7 feeds `pinchM: null` for fist-like frames (§9.2), which the machine already treats as "no distance".

### 4.6 Picking and settling (`targets.ts`, R22, R23)

Built in T2 and unchanged: `pickTarget(point, screen, scene)` checks on-screen targets first (the last registered rectangle that contains the point wins), then the scene; `settleStep` settles a new raw target after `HOVER_SETTLE_MS`. Each track has its own `SettleState`. This spec registers no on-screen targets, so the port passes an empty list; the `screen` kind and the `press` action stay for later specs (R22).

### 4.7 Hand slots (`slots.ts`, R78)

```ts
export function dedupeHands(samples: readonly HandSample[], minPx = DUPLICATE_HAND_PX): HandSample[];      // T3
export function assignHands(slots: readonly (Point | null)[], samples: readonly HandSample[],
  maxJumpPx = HAND_MATCH_PX): Array<number | null>;                                                         // T4
```

- `dedupeHands` keeps the first of two samples whose palm centres are closer than `minPx` (MediaPipe sometimes reports one hand twice when `numHands` is above 1).
- `assignHands` gets, per slot, the last filtered palm centre of a tracked hand (`null` for a free slot) and returns, per slot, the index of the sample it takes. With two samples and two tracked slots it takes the pairing with the smaller total palm movement. A tracked slot takes a sample only within `maxJumpPx`; a sample that no tracked slot takes goes to the lowest free slot; a sample left over when both slots are taken is dropped (the frame cannot hold more than `TRACKED_HANDS` hands after `dedupeHands`). A slot whose hand is missing gets `null` and keeps its state until its time-outs.
- T3 has no identity yet: it draws the deduplicated hands in frame order. T4's controller owns slot assignment.

Hands that cross each other may swap slots; two-hand gestures are short, and the owner's cursor is filtered, so a swap shows as a jump in the line between the hands. The manual check looks for it (§12).

## 5. Gestures (pure)

### 5.1 Gates (`gate.ts`, T3, R40–R42)

```ts
export type GateLevel = 'full' | 'view-only' | 'off';
export type GateReason = 'try-on' | 'slow' | 'agent' | 'exploded';
export interface Gate { level: GateLevel; reason: GateReason | null }
export function handGate(input: { tryOn: boolean; slow: boolean; agentActive: boolean; exploded: boolean }): Gate;
export interface SpeedState { slow: boolean; since: number | null }
export function initialSpeedState(): SpeedState;
export function speedStep(state: SpeedState, fps: number, now: number): SpeedState;
```

Priority: try-on, then slow (both `off`), then agent, then exploded (both `view-only`). The delegate is not an input (R40). `speedStep` is fed once a second from `onRate`; it flips to slow after `fps < MIN_CONTROL_FPS` has held for `SPEED_HOLD_MS`, and back after `fps >= MIN_CONTROL_FPS` has held as long. Before the first full second after `ready` the rate is unknown and counts as fast. The fist needs the reason too: it is allowed at `full` and at `view-only` with reason `exploded` (R94).

### 5.2 Decisions (`decide.ts`)

```ts
export type PinchAction = { kind: 'press'; id: string } | { kind: 'grab'; objectId: string; partId: string; hit: Vector }
  | { kind: 'orbit' } | { kind: 'none' };
export function decidePinch(target: Target, context: { objectCount: number; gate: Gate }): PinchAction;          // T4
export type FistAction = { kind: 'hold'; objectId: string; hit: Vector } | { kind: 'none' };
export function decideFist(target: Target, context: { objectCount: number; gate: Gate }): FistAction;            // T7
```

| Gate | Screen target | Part | Empty space |
|---|---|---|---|
| `full` | press (on tap) | grab | orbit |
| `view-only` | press (on tap) | orbit | orbit |
| `off` | none | none | none |

With `objectCount === 0`, parts and empty space give `none`. `decideFist` returns `hold` for a part target (its object) when the gate is `full`, or `view-only` with reason `exploded`, and `none` otherwise.

### 5.3 Pair geometry (`pair.ts`, T4, R83)

```ts
export function pairSpan(a: Point, b: Point): number;                 // CSS px
export function pairAngle(a: Point, b: Point): number;                // degrees, atan2(b.y − a.y, b.x − a.x); screen y grows down, so positive is clockwise
export function angleDelta(fromDeg: number, toDeg: number): number;   // wrapped to (−180, 180]
export function beyondDeadZone(delta: number, deadZone: number): number;   // sign(delta) · max(0, |delta| − deadZone)
```

Each two-hand gesture reads exactly one: zoom and explode `pairSpan`, rotate `pairAngle`. The rotate gesture accumulates `angleDelta` frame by frame (so a full turn does not wrap back to 0) and holds the angle still while `pairSpan < TWO_HAND_MIN_SPAN_PX`.

### 5.4 The join rule (`join.ts`, R82)

```ts
export type OwnerGesture = 'press' | 'grab' | 'orbit' | 'hold';
export interface JoinInput { kind: 'pinch' | 'fist'; target: Target }
export type TwoHandGesture = 'zoom' | 'rotate' | 'explode';           // assembly-joints adds 'assemble'
export type JoinRule = (owner: OwnerGesture, joiner: JoinInput, gate: Gate) => TwoHandGesture | null;
export const joinGesture: JoinRule;
```

T4 ships `joinGesture` with no rows: it always returns `null`, so in P0 a second hand is always inert. Each P1 task adds one row:

| Task | Owner | Joiner | Gate | Result |
|---|---|---|---|---|
| T6 | `orbit` | `pinch` | not `off` | `zoom` |
| T7 | `hold` | `pinch` | `full`, or `view-only` with reason `exploded` | `explode` |
| T8 | `grab` | `pinch` | `full` | `rotate` |

The rule receives the joiner's target although no row of this spec reads it; `assembly-joints` adds `hold` + `fist` on another object → `assemble`. The controller takes the rule as a constructor option (default `joinGesture`), so T4's unit tests exercise joining, freezing, hand-off and re-basing with a test rule before any P1 row exists.

### 5.5 The controller (`controller.ts`, T4)

```ts
export interface HandPort {
  pick(point: Point): Target;                          // pickTarget([], point, SceneHandle.hitTest)
  select(objectId: string, partId: string): void;      // App.pick(objectId, partId, false)
  beginGrab(objectId: string, partId: string, hit: Vector): GrabSession | null;
  beginOrbit(): OrbitSession | null;
  press(id: string): void;
  activate?(objectId: string): void;                   // T7: App.activateObject
  beginHold?(objectId: string, hit: Vector): HoldSession | null;   // T7
  explodeAmount?(): number;                            // T7: the active object's explode amount
  setExplode?(amount: number): void;                   // T7: App.setExplodeAmount
}
export interface GrabSession {
  preview(offset: Point): boolean;   // false = no longer valid
  rebase(): void;                    // the current preview becomes the start of the next offsets
  rotate?(angleDeg: number): boolean;  // T8: rotation about the view axis since the joiner engaged
  commit(): void; cancel(): void;
}
export interface OrbitSession { preview(offset: Point): void; rebase(): void; zoom?(ratio: number): void /* T6 */; end(): void }
export interface HoldSession { preview(offset: Point): boolean; rebase(): void; commit(): void; cancel(): void }   // T7

export class HandController {
  constructor(port: HandPort, options?: { join?: JoinRule });
  setGate(gate: Gate): void;
  setObjectCount(count: number): void;
  frame(samples: readonly HandSample[], now: number): OverlayFrame;
  tick(now: number): OverlayFrame | null;    // null when nothing changed
  reset(): void;                             // cancel and forget: 手勢 off, camera off, page hidden
  readonly stats: HandStats;
  onCancelled?: (reason: 'loss' | 'gate' | 'external') => void;
}
```

**State.** Two tracks, one per slot: `{ cursorFilter, palmFilter, pinch: PinchState, settle: SettleState, fist?: FistState, cursor, palm, points, seen }`. At most one session:

```ts
type Session = {
  owner: HandSlot;
  kind: OwnerGesture;
  scene: GrabSession | OrbitSession | HoldSession | null;    // null: the port refused; the pinch is inert until release
  pressId?: string;
  ref: Point;                       // the owner's point the offsets are measured from (engage point, or the point at the last re-base)
  joiner: { slot: HandSlot; gesture: TwoHandGesture; startSpan: number; lastAngle: number; angle: number; startValue: number } | null;
};
```

plus a set of inert slots (pinches that may not act until released).

**One `frame` call.**
1. `dedupeHands`, then `assignHands` with each track's filtered palm; each slot gets its sample or "no hand".
2. Per slot in order 0, 1: filter the cursor and the palm; unless that hand's pinch is engaged, `pick` the raw target at the cursor and `settleStep` it; `pinchStep`.
3. Handle the events of slot 0, then slot 1:
   - `engage` with no session: `decidePinch(settled)`. `grab` → `select`, then `beginGrab`; `orbit` → `beginOrbit`; `press` → remember the id; the hand owns the new session, `ref` = engage point. `none` → nothing until release; the hand owns nothing (R81).
   - `engage` while the other hand owns a session without a joiner: `join(session.kind, { kind: 'pinch', target: settled }, gate)`. A result makes this hand the joiner: record `startSpan`, the angle, and `startValue` (the explode amount for `explode`); the owner's one-hand preview holds still. `null` → the hand is inert.
   - `engage` while a joiner exists, or while this hand is inert: inert.
   - Owner moves (after `drag-start`) with no joiner: `scene.preview(cursor − ref)`; a `false` return cancels (`external`).
   - Joiner moves: zoom → `orbit.zoom(ratio)` (§6.3); explode → `port.setExplode(explodeAmount(…))` (§6.5); rotate → `grab.rotate(angle)` (§6.6).
   - Owner `release`: grab → commit when it moved or rotated, else cancel (a tap only selects, R29); orbit → `end()`; press → `port.press(id)` on a tap; hold → commit when moved. A joiner still engaged becomes inert. The session ends.
   - Joiner `release`, or joiner `lost`: the joiner leaves; its effect stays; `scene.rebase()` and `ref` = the owner's current point (R84).
   - Owner `lost { engaged: true }`: grab or hold → `ON_TRACKING_LOSS === 'cancel' ? cancel() : commit()`, `onCancelled('loss')` on cancel (R37); orbit → `end()` (R38); a joiner becomes inert.
   - Inert `release` or `lost`: the slot is free again.
4. Build the `OverlayFrame` (§8.1): per hand its state and badge, `gesture`, and `link` from the owner's point to the joiner's cursor while a joiner exists.

**Gates.** `setGate` cancels a grab when the level leaves `full`, ends an orbit (and its zoom) when it becomes `off`, and cancels a hold when the fist is no longer allowed (§5.1). A joiner whose row no longer allows its gesture leaves (as on release). A pinch held across a gate change does nothing until it is released (R42).

**Why one session.** One running gesture keeps the arbitration a single `if`: the first hand to engage owns; the other hand can only join through the rule (R81). `assembly-joints` keeps this shape: its `assemble` row starts a second hold for the joiner inside the same session.

### 5.6 Stats (`stats.ts`, T4, R45)

`HandStats` holds plain counters the controller updates on events: `drags`, `commits`, `cancels`, `dragLosses` (owner missing at least one frame during a drag), `longestDragGapMs`, `twoHand` (joins, by gesture), `inert` (inert pinches), plus per hand the latest `pinchM`, pinch state, settled target key and (T7) curl and fist state. No timers, no logging (R46).

### 5.7 Texts (`text.ts`, R16, R43, R45)

```ts
export type HandStatusState = 'hidden' | 'loading' | 'error' | 'slow' | 'agent' | 'exploded' | 'cancelled' | 'hint';
export function handStatus(input: { tracker: TrackerStatus; gate: Gate; cancelledAt: number | null; now: number; handSeen: boolean;
  fistEnabled?: boolean /* T7: the exploded line of R94 */ }): { state: HandStatusState; text: string };      // T3
export function trackingDebugLine(input: { delegate; fps; inferenceMs; hands: number; pinchMm: (number | null)[] }): string;   // T3
export function shortenName(name: string, max = BADGE_NAME_MAX): string;         // T4: by code points, '…' when cut
export function badgeText(view: { state: HandState; target: Target; gesture: GestureKind; value: number | null; objectName?: string }): string;   // T4
export function debugLine(stats: HandStats, tracking: …): string;                 // T4
```

All strings are the tables of R16 and R43, written once here; the P1 tasks add their rows (R88, R95, R98). T3 already writes every R43 state; `cancelled` only appears once T5 passes `cancelledAt`. `handStatus` returns `hidden` for try-on (the try-on line already shows) and when nothing applies after a hand has been seen. Debug lines are Traditional Chinese (for example 「GPU · 每秒 22 幀 · 辨識 48 ms · 2 隻手 · 捏合 24／61 mm · 手勢 grab · 拖曳 3／完成 2／取消 1／拖曳中遺失 1（最長 420 ms）· 雙手 1 · 無效捏合 2」).

## 6. Geometry (pure, `drag.ts`)

### 6.1 Moving a part (T4, R30, R31, R33)

```ts
export function dragPosition(input: {
  camera: { matrixWorld: Matrix4; fovDeg: number }; viewportHeight: number;
  parentWorld: Matrix4; start: Vector3; hit: Vector3; offset: Point; gain?: number;
}): Vector;     // new local position, rounded to 5 decimals and clamped to ±100 per axis
```

1. Depth of the grabbed point along the camera's forward axis: `d = (hit − cameraPosition) · forward`.
2. World size of one pixel at that depth: `k = 2 · d · tan(fov / 2) / viewportHeight`. A closer camera gives a smaller `d` and a finer move per pixel (R31).
3. World offset in the camera plane: `Δ = right · (offset.x · gain · k) − up · (offset.y · gain · k)`.
4. New local position: `parentWorld⁻¹ · (parentWorld · start + Δ)`. Parents never scale children, so `parentWorld` is rigid and the inverse is exact.

### 6.2 Turning the view (T4, R35)

```ts
export function orbitOffset(start: Vector3, offset: Point, degPerPx: number,
  limits: { minPolar: number; maxPolar: number; minAzimuth: number; maxAzimuth: number }): Vector3;
```

`Spherical.setFromVector3(start)`; `theta −= offset.x · degPerPx`, `phi −= offset.y · degPerPx` (radians), clamped to the limits and to `[ε, π − ε]` as OrbitControls does; returns the new camera − target vector.

### 6.3 Two-hand zoom (T6, R87)

```ts
export function zoomRatio(input: { startSpan: number; span: number; deadZonePx: number; minSpanPx: number }): number;
```

`effective = startSpan + beyondDeadZone(span − startSpan, deadZonePx)`, and `ratio = max(startSpan, minSpanPx) / max(effective, minSpanPx)`. Spreading the hands (`span > startSpan`) gives `ratio < 1`, a nearer camera. The controller computes the ratio; the orbit session's `zoom(ratio)` (§7.3) sets `camera.position = target + offsetAtJoin.setLength(clamp(distanceAtJoin · ratio, controls.minDistance, controls.maxDistance))` and leaves the azimuth and polar angle alone.

### 6.4 Moving an object (T7, R92)

`dragPosition` with `parentWorld` = the scene's objects group `matrixWorld` (identity today), `start` = the object's stored `transform.position`, `hit` = the surface point under the palm centre at engage, and the palm centre's offset. The result is the object's new position (5 decimals, ±100 m, the `ObjectTransform` position limit).

### 6.5 Explode amount (T7, R93)

```ts
export function explodeAmount(input: { start: number; startSpan: number; span: number; deadZonePx: number;
  viewportHeight: number; fullFraction: number }): number;    // clamp to 0..1, rounded to 0.01
```

`start + beyondDeadZone(span − startSpan, deadZonePx) / (fullFraction · viewportHeight)`. The controller calls `port.setExplode` only when the rounded value changes (R64).

### 6.6 Rotating a part about the view axis (T8, R96)

```ts
export function rotateAboutView(input: { parentWorld: Matrix4; start: Euler /* local, radians, XYZ */;
  cameraWorld: Matrix4; angleDeg: number }): Vector;    // degrees, rounded to 2 decimals
```

The axis is the camera's forward direction in world space (its local −Z). `q = setFromAxisAngle(forward, angleDeg)`. Seen from the camera, a positive rotation about an axis that points away from the viewer turns clockwise, and `pairAngle` grows clockwise on screen (y down), so the same sign makes the part turn the way the hands turn; a unit test checks it by projecting a point of the part before and after. World start `w = parentQ · startQ`; new local `parentQ⁻¹ · q · w`, converted to XYZ Euler degrees, which lie within ±180°, so the ±360° limit always holds. The part turns about its own origin; its position is untouched.

## 7. Scene (`SceneViewport.tsx`, `hand-sessions.ts`)

### 7.1 Handle additions

```ts
export interface SceneHandle {
  reset(): void; zoomIn(): void; zoomOut(): void;
  projectPart(id: string, objectId?: string): { x: number; y: number } | null;
  hitTest(point: Point): { objectId: string; partId: string; name: string; objectName: string; hit: Vector } | null;   // T5
  beginPartGrab(objectId: string, partId: string, hit: Vector): GrabSession | null;     // T5
  beginOrbit(): OrbitSession | null;                                                     // T5
  beginObjectHold(objectId: string, hit: Vector): HoldSession | null;                    // T7
}
```

`hitTest` and the click handler share one `hitsAt(point)` helper (the surface list is rebuilt only in `sync`). `onTransform` gains a fifth parameter `kind: 'translate' | 'rotate' | 'both'`; the gizmo passes its own mode (T5), and a hand grab passes what changed (T8 adds `both`). T7 adds the prop `onObjectMove(objectId, position)`. T6 writes `data-camera-target` (the orbit target, 4 decimals) next to `data-camera-position` in the render loop.

### 7.2 Grab sessions (T5; rotation T8)

`beginPartGrab` returns `null` when: the object or part is unknown; the exploded view is shown or animating (`explodeTarget > 0 || explodeShown > 0`, the gizmo's test); the gizmo is dragging; or a mouse orbit is running (tracked between OrbitControls' `start` and `end` events) (R34, R41). Otherwise it:
- calls `ensureExplosion(entry)` first when the object is not active yet (explosion bases are captured from the node positions when first computed; computing them later, during the preview, would store the previewed position as the assembled one);
- records the part's stored position and rotation (from the model, so a move commits the stored rotation unchanged, R33);
- sets `gizmo.enabled = false` until the session ends (R34);
- returns `createGrabSession(…)`. `preview(offset)` sets the node's position from `dragPosition` with the node's live `parent.matrixWorld` and invalidates the render; child parts follow (R32). `rebase()` takes the current preview as the new start. T8: `rotate(angleDeg)` sets the node's rotation from `rotateAboutView` with the live parent and camera matrices; the position preview holds still meanwhile.

`commit` compares the rounded results with the stored values; when both are equal it does nothing, otherwise it calls `onTransform(objectId, partId, position, rotation, kind)` once, with `kind` = what changed (R32, R97). `cancel` puts the stored position and rotation back (R37, R39).

**Cancel rules (R39).** A pure `grabStillValid(plan, nextActiveId, objectId)` in `hand-sessions.ts`: `sync` marks a live session invalid when its plan builds, rebuilds, moves or removes any object, or when the new active id is not the session's object; the next `preview` returns `false` and the controller cancels. Activating the grabbed object (R25) changes only the active id to the session's own object and does not cancel. After `sync` and after `applyExplosionShown`, a valid session re-applies its last preview, because activation resets node positions to their explosion bases.

### 7.3 Orbit sessions (T5; zoom T6)

`beginOrbit` returns `null` while the mouse or the gizmo drags, or with no objects. It records `camera.position − controls.target` and sets `viewChanged = true` (R36). `preview` sets `camera.position = target + orbitOffset(…)`, calls `camera.lookAt(target)` and `controls.update()`, and invalidates. `rebase()` records the current offset as the new start. `end` does nothing else (R38). T6: `zoom(ratio)` as in §6.3, with `controls.minDistance` and `maxDistance`; `rebase()` after a zoom keeps the zoomed distance.

### 7.4 Hold sessions (T7, R91–R94)

`beginObjectHold(objectId, hit)` returns `null` for an unknown object, while the gizmo drags or a mouse orbit runs. It is **not** refused in the exploded view or during the explode animation, because it moves only the object's root, which the explode animation never touches. It does not refuse because another hold session runs, so `assembly-joints` can hold two objects. It records the stored `transform`, sets `gizmo.enabled = false`, and returns `createHoldSession(…)`: `preview(offset)` sets `entry.root.position` from §6.4 and invalidates; `rebase()`; `commit` calls `onObjectMove(objectId, position)` once when the rounded position changed; `cancel` restores the root. The same `grabStillValid` decides cancellation. The controller calls `port.activate(objectId)` before `beginHold` for an inactive object (activation resets explode for another object, which the explode pull then starts from).

### 7.5 App's commit paths

```ts
const TRANSFORM_NOTICE = { translate: '已移動零件，可按「復原」回到上一步。', rotate: '已旋轉零件，可按「復原」回到上一步。',
  both: '已移動並旋轉零件，可按「復原」回到上一步。' } as const;      // `both` from T8
function onTransform(objectId: string, id: string, position: Vector, rotation: Vector, kind: keyof typeof TRANSFORM_NOTICE) {
  if (agentActive || objectId !== store.current().activeObjectId) return;
  updatePart(id, { position, rotation }, TRANSFORM_NOTICE[kind]);
}
function onObjectMove(objectId: string, position: Vector) {          // T7
  if (agentActive) return;
  moveObject(objectId, { position });                               // the 物件 panel's path: setTransform, one undo step
}
```

The gizmo and the hand share `onTransform`, so a hand drag is one `commit` in the workspace store, one undo step, with the existing notices (R32, R97). A fist move uses the 物件 panel's `moveObject` (R92).

## 8. Overlay, status line and debug panel

### 8.1 The view and its style (`style.ts`, R14, R15)

The controller gives each hand its state: `grab`, `orbit` or `hold` for the owner while its session runs; `join` for the joiner; `locked` for an inert hand, when the gate is `off`, or at `view-only` while the hand is not turning the view, not over an on-screen target and (T7) not holding; `hover` when the settled target is a part (gate `full`) or an on-screen target; `fist` for a closed fist holding nothing (T7); `tracked` otherwise; `none` without a hand. Until T5, T3's hook sets `tracked` or `locked` from the gate alone.

```ts
export const HAND_COLOUR = '#CC79A7';   // Okabe–Ito reddish purple, both hands
export const LINK_COLOUR = '#D55E00';   // Okabe–Ito vermillion, the line between the hands
export const LOCKED_COLOUR = '#9AA3AD';
export function overlayStyle(view: { state: HandState }): { colour: string; dashed: boolean; lineWidth: number;
  mark: 'none' | 'ring-hollow' | 'ring-filled' | 'square-hollow' | 'square-filled' };
```

| State | Lines | Mark |
|---|---|---|
| `tracked` | 2 px | none |
| `hover` | 2 px | hollow ring at the cursor |
| `grab`, `orbit`, `join` | 3.5 px | filled ring at the cursor |
| `locked` | 2 px grey dashes | none |
| `fist` (T7) | 2 px | hollow rounded square at the palm centre |
| `hold` (T7) | 3.5 px | filled rounded square at the palm centre |

The two Okabe–Ito colours stay distinguishable with the common colour-vision deficiencies and differ from the part-edge cyan `#69eaff` and the selection amber `#ffc53d`. Every line has a 1 px dark outline so it reads on skin, on bright video and on the backdrop.

### 8.2 `HandOverlay` and drawing (`HandOverlay.tsx`, `skeleton.ts`)

The `<canvas className="hand-overlay" data-testid="hand-overlay" aria-hidden="true">` built in T2 stays: inside `.viewport`, above the scene canvas, `pointer-events: none` (R17), not CSS-mirrored, backing store sized to the box × `devicePixelRatio`. From T3 its handle is `draw(frame: OverlayFrame)` and `clear()`:
- clear, then per hand `drawHand(points, style)` (T3); the mark and the badge (T5); the link line in `LINK_COLOUR` when `frame.link` is set (T5 draws it; P1 tasks set it); the angle arc (T8).
- Badges: a dark rounded rectangle with white 13 px text, 16 px right of and above the cursor, kept inside the canvas by the pure `badgeBox(cursor, textWidth, canvasSize, avoid?)`. When the second hand's badge would overlap the first's, `avoid` places it below its cursor.
- Attributes, written only when they change (R18): `data-hand-count`; `data-hand-state`, `data-hand-target` (slot 0); `data-hand2-state`, `data-hand2-target` (slot 1); `data-gesture`. `data-hand-mode` is removed in T3.
- A hand missing for `HAND_LOST_MS` disappears from the frame (R13); with no hands the canvas is cleared.

`drawRing`, `drawSquare`, `drawBadge`, `drawLink` and `drawArc` take a 2D context; their unit tests use a small recording fake context, and `badgeBox` is pure.

### 8.3 `useHandControl` (`src/hands/useHandControl.ts`)

```ts
export function useHandControl(input: {
  source: HandSource; tracker: TrackerStatus; enabled: boolean;       // camera on and 手勢 on
  gate: Gate; videoRef: RefObject<HTMLVideoElement | null>; overlayRef: RefObject<HandOverlayHandle | null>;
  // T5
  objectCount: number; sceneRef: RefObject<SceneHandle | null>; onPick: (objectId: string, partId: string) => void;
  // T7
  onActivate?: (objectId: string) => void; explodeAmount?: () => number; setExplode?: (amount: number) => void;
}): { status: { state: HandStatusState; text: string }; debug: RefObject<HandDebugNumbers> };
```

- **T3.** While enabled, per frame: read the video rect, `handSample` every hand of `frame.hands`, `dedupeHands`, and draw them in order with `tracked` or `locked` (from the gate). Per tick: clear after `HAND_LOST_MS` without a hand. The status line comes from `handStatus`, recomputed only when the tracker status, the gate or "a hand has been seen" changes. `debug` is a ref with the tracking numbers (hands in the last frame, pinch distance per hand), read by the debug panel without a render.
- **T5.** It owns a `HandController`; implements `HandPort` with `sceneRef.current` (`hitTest` → `Target`, `beginPartGrab`, `beginOrbit`), an empty screen-target list, and `onPick`; pushes `gate` and `objectCount` into it in effects; per frame `controller.frame(samples)` → `overlay.draw`; per tick `controller.tick`; `reset()` on `visibilitychange` to hidden, on disable and on unmount; `onCancelled('loss')` sets `cancelledAt` for the status line. `debug` then also carries the controller's `stats`.
- React state holds only the status line (R64).

App computes the gate:

```ts
const gate = handGate({ tryOn: tryOnActive, slow, agentActive, exploded: explode > 0 });
```

`slow` is React state set from `speedStep` in `onRate`, changing only when it flips (T3). During the explode animation back to 0 the gate is already `full`, but `beginPartGrab` still refuses (§7.2), so no offset can be committed.

### 8.4 Status line and debug panel (T3; T5 completes; R43, R45)

The status line renders under `.stage-toolbar`, next to the try-on line, as `<p className="notice hand-status" role="status" data-testid="hand-status" data-state={state}>` when the camera and 手勢 are on and the state is not `hidden`. `error`, `slow` and `cancelled` use the `warning` style.

`HandDebugPanel` renders only when `new URLSearchParams(location.search).get('hands') === 'debug'`: a `<p data-testid="hand-debug" className="small-muted">` that reads the debug ref every 500 ms with its own interval: in T3 `trackingDebugLine` (delegate, fps, inference ms, hands, pinch mm per hand), from T5 `debugLine` with the gesture counters. Without the parameter it is not mounted (R45, R46).

## 9. Fist (P1, T7)

### 9.1 Detection (`fist.ts`, R89)

```ts
export function curlRatio(world: readonly Landmark[] | undefined): number | null;
export interface FistState { engaged: boolean; streak: number; handSeenAt: number | null; engagePalm: Point | null; moved: boolean }
export type FistEvent = { type: 'fist-engage'; palm: Point } | { type: 'fist-move-start' } | { type: 'fist-release'; moved: boolean } | { type: 'fist-lost' };
export function fistStep(state: FistState, input: { kind: 'hand'; palm: Point; curl: number | null; pinchMoved: boolean } | { kind: 'none' } | { kind: 'tick' }, now: number):
  { state: FistState; events: FistEvent[] };
```

- `curlRatio`: for each of the index (5→8), middle (9→12), ring (13→16) and little (17→20) fingers, `|tip − wrist| / |knuckle − wrist|` on the world landmarks; the result is the largest of the four, so one extended finger means "not a fist". `null` without 21 finite world landmarks or with a degenerate knuckle distance. For orientation: an open hand gives about 1.8 (the synthetic hand: 1.88), a pinch with curled other fingers about 1.3–1.5 (the index stays the largest), a closed fist below 1.0. These are estimates from hand proportions; the manual check reads the real value in the debug line.
- `fistStep` is the pinch machine's pattern: below `FIST_ENGAGE_RATIO` for `FIST_ENGAGE_FRAMES` engages, above `FIST_RELEASE_RATIO` for `FIST_RELEASE_FRAMES` releases, nothing in between, `null` resets the streak, the same `TRACKING_LOSS_MS` / `HAND_LOST_MS` time-outs, and a move start after `DRAG_DEAD_ZONE_PX` of palm movement. `pinchMoved` blocks engaging (R90).
- `FIST_ENABLED = false`: `handSample` still computes `curl` for the debug line, but the controller never calls `fistStep` and never nulls `pinchM`.

### 9.2 Fist and pinch (R90)

In the controller, per hand and frame: when `curl < FIST_ENGAGE_RATIO`, the sample goes to `pinchStep` with `pinchM: null` (a fist-like frame never counts toward a pinch). A `fist-engage` on a hand whose pinch is engaged and has not moved cancels that pinch's session (grab → `cancel`, orbit → `end`, press → forgotten; nothing committed), resets its pinch state, and the fist proceeds. A hand whose pinch has moved passes `pinchMoved: true`, so it cannot engage a fist.

### 9.3 Holding (R91–R94)

On `fist-engage` with no session: `pick(palm)` (raw, no settling) → `decideFist`. `hold` → `port.activate(objectId)` when the object is not active, then `port.beginHold(objectId, hit)`; the hand owns a `hold` session with `ref` = the palm. `none` → the hand shows `fist` until it opens. On `fist-engage` while another hand owns a session: `join(owner, { kind: 'fist', target }, gate)`, which has no fist row in this spec, so the fist is inert. Moving the fist previews the hold (palm offset from `ref`); `fist-release` commits when moved, else cancels; loss follows R37. The explode row (T7) lets a pinch join a hold: `startSpan` from the palm to the pinch cursor, `startValue = port.explodeAmount()`, then `port.setExplode(explodeAmount(…))` on each change.

The 爆炸圖 status text of R94 replaces the P0 line when `FIST_ENABLED` is true (`handStatus` input `fistEnabled`).

## 10. Agent switch for the camera image (P1, T9, R99, R100)

- **Contract (`shared/agent.ts`).** `StateChangeSchema` gains `cameraHidden: z.boolean().nullable().optional()`. Optional keeps the strict schema accepting every existing payload: the tools return objects without the key, and `agent-panel.spec.ts` and `workspace.spec.ts` route `state` events without it. A `SetCameraImageDetailSchema = z.strictObject({ visible: z.boolean(), cameraOn: z.boolean(), message })` joins the detail schemas.
- **Tool (`server/tools/set-camera-image.ts`).** `defineTool({ name: 'set_camera_image', label: '鏡頭畫面', category: 'view', description, args: z.strictObject({ visible: z.boolean() }), side: 'server', scope: 'project', effects: 'uses-camera', run })`. With `state.cameraOn` false it returns `{ ok: false, summary: '請先開啟攝影機。', detail, stateChange: null }`, as `wear_on_arm` does; otherwise `ok` with 已隱藏鏡頭畫面（手部追蹤持續進行）。 or 已顯示鏡頭畫面。 and `{ activeObjectId: null, object: null, selection: null, explode: null, tryOn: null, cameraHidden: !visible }`. It does not check for a model. Description for the model: "shows or hides the live camera image behind the model; hand tracking and try-on keep running. Asks the user to turn the camera on if it is off."
- **Registration.** `server/tools/index.ts` exports it after `wear_on_arm`, so it is listed in `AGENT_INSTRUCTIONS` from the registry. `checkedChange` in `helpers.ts` strips `cameraHidden` together with `tryOn` before the dry run. The loop in `server/agent.ts` needs no state for it (it does not track the image).
- **`AGENT_INSTRUCTIONS`.** One rule line: "- set_camera_image only shows or hides the camera image; it changes no object. Use it when the user asks to hide or show the camera image (隱藏或顯示鏡頭畫面)."
- **Client.** `applyStateEvent` returns `cameraHidden` in `StateEffects` when it is a boolean; `useAgentRun` calls `options.setCameraHidden(value)`; App passes a setter that applies it only while `camera === 'on'` (R100). The request (`buildAgentRequest`) is unchanged.
- **Tests.** `tests/unit/agent-tools.test.ts`: camera on (both values), camera off, bad arguments. `tests/unit/tool-registry.test.ts`: its list of the nine tools, the label map and the effects map gain the tenth tool (an extension, R54). `tests/unit/apply-state.test.ts`: a payload with `cameraHidden`, and the existing payloads without it still parse. `tests/unit/agent-loop.test.ts`: `AGENT_INSTRUCTIONS` contains `set_camera_image`. E2E in `hand-control.spec.ts` (§11.3).

## 11. Testing strategy

### 11.1 Synthetic hands (`tests/fixtures/synthetic-hand.ts`)

Built in T1:

```ts
export function syntheticHand(options: { cursor: { x: number; y: number }; pinchM: number; size?: number; side?: 'left' | 'right';
  world?: boolean; fist?: boolean /* T7 */ }): HandLandmarks;
export function clientToNormalized(point, view, video): { x: number; y: number };
```

It builds a flat, open hand around a normalised cursor point (landmarks 4 and 8 centred on it, `pinchM` apart in the world landmarks; palm 8 cm). T7 adds `fist: true`: the four fingertips are placed 35 % of the way from their knuckle to the wrist (curl ratio about 0.65) and the thumb tip 6 cm from the index tip (no pinch), and `cursor` then places the palm centre instead of the pinch midpoint.

### 11.2 Unit tests (Vitest, Node, no DOM)

- `hand-tracking.test.ts`: T1 ✓ `trackingPlan` and `RateWindow`; T3 `frameClockStep` (keeps the video-frame clock while callbacks arrive, switches after `VIDEO_FRAME_STALL_MS` while playing, never switches while paused or not ready, never switches back).
- `hand-input.test.ts`: T2 ✓ mapping, One Euro, pinch, picking, settling, overlay style. T3: `handSample.palm`; `dedupeHands` (close palms → one, far palms → two); the overlay style test changes to one hand colour, a link colour different from it, and no mode. T4: `assignHands` (two hands moving keep their slots; a new hand takes the free slot; a jump beyond `HAND_MATCH_PX` is a new hand; a missing hand leaves its slot `null`; the cheaper pairing wins).
- `hand-gate.test.ts` (T3): `handGate` priority for every reason; `speedStep` both directions with the 2 s hold; `handStatus` priority and texts; `trackingDebugLine`.
- `hand-controller.test.ts` (T4): `decidePinch` table including no objects; `pairSpan`, `pairAngle`, `angleDelta` wrap-around, `beyondDeadZone`; `joinGesture` returns `null` for every input; the controller with a fake port (records calls, returns fake sessions): grab on the active object; grab on an inactive object calls `select` then `beginGrab` in one gesture; tap selects and cancels; drag previews offsets from the engage point and commits once; `beginGrab` returning `null` makes the pinch inert; `preview` returning `false` cancels; loss within and beyond `TRACKING_LOSS_MS`; `'keep'` commits; gate changes cancel a grab and end an orbit; a pinch held across a gate change stays inert; `reset` cancels; **two hands:** a second pinch while the first grabs is inert (state `locked`, badge 另一手操作中, no port call); a second pinch while the first hand's pinch decided `none` starts its own gesture; both engaging in one frame → slot 0 owns; with a test join rule: joining freezes the owner's preview, the joiner's span and angle are measured from the owner's point, the joiner's release re-bases the owner (no jump on the next preview), the owner's release ends everything and leaves the joiner inert until it releases, a lost joiner leaves like a release, the frame's `link` is set while joined; `badgeText` for every state with a 13-character name; stats counters; `badgeBox` near each canvas edge and with `avoid`; the draw helpers against a recording context. T6–T8 add their rows and mappings through the real `joinGesture`.
- `hand-drag.test.ts`: T4 `dragPosition` (no jump at offset 0; a camera looking down −Z moves +X for a rightward offset; a rotated camera moves in its own plane; a child under a rotated parent and a rotated object root lands on the expected local position, checked by transforming back to world; halving the camera distance halves the move per pixel; rounding and the ±100 clamp) and `orbitOffset` (keeps the distance, turns the azimuth for a horizontal offset, clamps the polar angle). T6 `zoomRatio`; T7 the object move and `explodeAmount`; T8 `rotateAboutView`.
- `hand-sessions.test.ts` (T5): on a small Three.js node tree (object root rotated, parent part rotated, child part) a grab session's `preview` moves only the grabbed node and the child follows in world space; `rebase` makes the next offset start from the current preview; `commit` calls the callback once with the position rounded to 5 decimals and the stored rotation; a commit at the start position calls nothing; `cancel` restores; `grabStillValid` for an empty plan with the same active id (valid), a plan that rebuilds or moves anything (invalid), another active id (invalid). T6–T8 extend it.
- `hand-fist.test.ts` (T7): `curlRatio` for the synthetic open hand, pinch and fist, and `null` without world landmarks; `fistStep` engage and release at the ratios and frame counts, no change between, spikes, time-outs, `pinchMoved` blocks engaging.

### 11.3 E2E (`tests/e2e/fake-hands.ts`, `hand-control.spec.ts`)

Built in T1: the helper routes the worker URL with the same pattern as `arm-try-on.spec.ts` and fulfils it with a scripted worker that answers every frame with the latest hands it received on `BroadcastChannel('forgehand-fake-hands')`, posts `ready` with a chosen delegate, can delay replies (`replyDelayMs`), closes every bitmap and counts frames.

T3 extends it for two hands:

```ts
export interface FakeHand { at: { x: number; y: number } /* client px */; pinchM: number; fist?: boolean /* T7 */ }
export async function showHands(page: Page, hands: readonly FakeHand[]): Promise<void>;   // [] hides all hands
export async function showHand(page, at, pinchM): Promise<void>;   // = showHands([{ at, pinchM }])
export async function hideHand(page): Promise<void>;               // = showHands([])
```

The channel message becomes `{ type: 'hands', hands: HandLandmarks[] }`; the fake worker still accepts the old `{ type: 'hand', hand }`. Hands are answered in array order, so in a test the first hand shown is slot 0. The app has no test-only branch: the only seam is the worker URL (R50).

`hand-control.spec.ts` grows with the tasks:
- T1 ✓, T2 ✓ as built. T3 removes the T2 case's `data-hand-mode` assertion (the only change to existing cases).
- T3: two hands → `data-hand-count` 2 and ink near both points, one hidden → 1; the 隱藏鏡頭畫面 button appears only with the camera on, pressing it sets `aria-pressed`, the video's computed opacity is 0 while `paused` is false and `currentTime` advances, fake frames keep growing, the overlay still has ink on the hand, `data-image-hidden` is `true`; camera off and on → shown again and not pressed; try-on with the image hidden reaches `tracking`; the hint line before the first hand; 手勢 off hides the status line; a fake with `replyDelayMs: 150` shows the 「太慢」 line and `data-hand-state="locked"` after `SPEED_HOLD_MS`; a CPU `ready` with no delay shows no 「太慢」 line and `tracked`; `?hands=debug` shows `hand-debug` with the delegate and the hand count. While developing, the task also probes once (in a scratch test, not committed) whether a `requestVideoFrameCallback` registered on the hidden video fires in the headless shell, and reports the answer.
- T5: hover then pinch-drag-release on 外殼 (`housing`) of the demo: only `housing`'s position changes in `data-model-json`, `projectPart('battery')` moves with it, `data-object-json` is unchanged, one 復原 restores it; a pinch on a part of a second (inactive) object activates it, selects the part and moves it; a tap selects without an undo step; a pinch on empty space changes `data-camera-position` only; a second hand's pinch while the first drags is inert (`data-hand2-state="locked"`, only the first hand's move is committed); with 手勢 off a pinch does nothing and a mouse click still selects; a hand lost mid-drag for longer than `TRACKING_LOSS_MS` puts the part back and shows the cancel notice; the exploded view and an active agent run (an `/api/agent` route held open until the test releases it) make a pinch on a part turn the view, with their notices; `?hands=debug` shows the gesture counters; no gesture requests `/api/generate`, `/api/edit` or `/api/agent` (except the held agent run). The full suite runs.
- T6–T9: the cases of R88, R95, R98 and R100.

Two-hand steps under SwiftShader take longer (two filters, two settles); tests poll attributes with `expect.poll` and never sleep for fixed times, except where a test proves that something stays unchanged.

## 12. Task plan and requirement map

Nine tasks (R71). Tasks 1–2 are done; Tasks 3–5 finish the P0 core; Tasks 6–9 are P1 in the order of R71 and are cut from the end.

| Task | Content | Requirements |
|---|---|---|
| 1 ✓ | Shared tracking: worker `pose` flag, `useHandTracking` + `trackingPlan`, `useArmTracking` as consumer, 手勢 switch in App, synthetic hand fixture, `fake-hands.ts` and its install in two specs, README privacy line, structure.md | 1–8, 9 (inference, worker), 10, 11 (switch name), 44 (switch), 50, 51, 53 (camera off), 54, 63, 66 |
| 2 ✓ | Input pipeline: constants, types, mapping, One Euro, pinch machine, picking and settling, skeleton drawing, `HandOverlay`, `useHandControl` part 1 (one skeleton) | 9 (overlay hidden), 12 (one hand), 13, 14 (first colour), 15 (lines), 17 (overlay), 18 (state), 19–23, 47, 48, 49 (input), 52 (overlay), 64 (overlay) |
| 3 | Both hands and the hidden camera image: worker `numHands: 2`, `palm`, `dedupeHands`, capture-loop fallback, camera image toggle, overlay for two hands and its attributes, one hand colour, gates and speed, status line, debug panel (tracking numbers), `showHands` | 12 (both hands), 13, 14, 15 (tracked, locked), 18 (count, slot attributes), 40 (slow), 41 (gate), 43 (status line), 44, 45 (tracking numbers), 47 (`TRACKED_HANDS`, `DUPLICATE_HAND_PX`), 48 (stall rule, duplicates), 52 (two hands, hidden image, 手勢 status, slow, CPU, debug), 53, 63, 64, 66, 73–77, 78 (duplicates) |
| 4 | Two-hand gesture core, pure: `assignHands`, decision, pair geometry, join rule (no rows), `HandController` with arbitration and hand-off, drag and orbit maths, badge texts, debug line, stats, ring, badge and link drawing helpers | 16, 21 (per hand), 24–31 (rules, maths), 33, 35 (maths), 37, 38, 39 (controller side), 40–42 (controller side), 45 (counters), 47 (`HAND_MATCH_PX`, `TWO_HAND_MIN_SPAN_PX`), 48, 49, 78 (slots), 79–84, 86 (frame link) |
| 5 | Wiring: grab and orbit sessions with re-base, `SceneViewport` `hitTest` and busy and cancel rules, `onTransform` kind, `useHandControl` with the controller, rings, badges and link drawn, cancel notice, full debug panel, README hand section, remaining P0 e2e, full suite, manual webcam list | 15 (marks), 16 (badges drawn), 17, 18 (targets, gesture), 22 (scene), 24–36 (wiring), 37 (e2e), 39 (scene side), 41 (e2e), 43 (cancel notice), 45, 46, 52 (rest), 54, 55, 64, 70, 72, 81 (e2e), 85 |
| 6 | P1 two-hand zoom: join row, `zoomRatio`, orbit `zoom`, `data-camera-target`, badge, e2e, README and manual lines | 31 (two-hand zoom), 82 (zoom row), 86, 87, 88, 70, 72 |
| 7 | P1 fist: `curlRatio`, `fistStep`, fist and pinch precedence, `decideFist`, hold sessions and `onObjectMove`, explode row and `explodeAmount`, fist marks and badges, exploded status text, synthetic fist, e2e, README and manual lines | 15 (squares), 18 (fist states), 41 (fist when exploded), 43 (exploded line), 45 (curl), 47 (fist constants), 82 (explode row), 89–95, 70, 72 |
| 8 | P1 two-hand rotate: join row, `rotateAboutView`, grab `rotate`, `both` notice, arc, e2e, README and manual lines | 55 (R stays), 82 (rotate row), 96–98, 70, 72 |
| 9 | P1 agent switch: `set_camera_image`, optional `cameraHidden`, `AGENT_INSTRUCTIONS` line, client apply, unit tests, e2e, README and manual lines | 54 (tool lists), 99, 100, 70, 72 |

Requirements 65 and 67–69 apply to every task; 71 is satisfied by `tasks.md` itself. Requirements 56–62 are removed.

**Manual webcam list.** `tasks.md` carries it under its own heading in Task 5, so it exists even if every P1 task is cut. Task 5 checks it against what was built and hands it to the user; Tasks 6–9 add their lines (R72). Task 3 also asks the reviewer for an early webcam check of two hands, their tracking rate and the hidden camera image, because the cost of the second hand is the largest unknown.

## 13. Key decisions

- **A pure controller behind a port, now for two hands.** All timing, hysteresis, decisions, arbitration and cancel rules live in one class with no DOM, so every rule in R19–R42 and R78–R98 has a unit test with synthetic landmark sequences.
- **The first hand owns; the second only joins (Guiard).** Guiard's kinematic chain model says the non-dominant hand sets the frame of reference and the dominant hand acts within it (Y. Guiard, *Journal of Motor Behavior* 19(4), 1987). The owner holds the frame (a part, an object, the view) and the joiner acts on it. Roles go by order, not by handedness, so left-handed users and swapped labels need no special case.
- **One number per two-hand gesture.** Zoom and explode read only the distance, rotate only the angle, each with a dead zone. This is what Apple's visionOS uses for two-hand zoom and rotate (pinch with both hands, drag apart or together, or in a circle; Apple Human Interface Guidelines, "Gestures"), and it keeps a sloppy two-hand motion from changing two things at once.
- **Hand-off as in Meta's Interaction SDK.** A `Grabbable` there switches between a one-grab and a two-grab transformer as hands join and leave. Here the joiner's release re-bases the owner's session, so the one-hand gesture continues without a jump; the owner's release ends the gesture, and the joiner never takes it over.
- **Two-hand gestures feed the owner's session.** No second scene session exists for zoom, rotate or explode, so commits stay one undo step and cancel rules stay those of the owner's gesture.
- **The join rule is a table that P1 tasks extend.** Cutting a P1 task removes its row and nothing else; `assembly-joints` adds a fist row.
- **Hide the image with opacity, keep the loop alive with a clock check.** The video keeps playing and stays in the page; if the browser stops video-frame callbacks for an unpainted video, the capture loop falls back to animation frames.
- **Sessions in the scene, commit through the existing callbacks.** The preview moves the node the gizmo (or the 物件 panel) would move, so child parts follow for free, and the commit path is the existing one, with its undo, notices and validation.
- **One worker per camera session, the worker URL as the only test seam, pinch on world landmarks, precision by depth** (unchanged from the 2026-11-15 design).

## 14. Risks and later improvements

- **Cost of the second hand.** The 50–70 ms estimate (§3.1) is not measured. If the user's laptop falls below `MIN_CONTROL_FPS` with two hands allowed, hand control locks with the 「太慢」 line during the demo. Task 3's report asks for an early measurement; the fallback is `TRACKED_HANDS = 1`, which keeps all P0 one-hand gestures.
- **Video-frame callbacks on a hidden video.** Covered by the fallback (§3.2) and an e2e check that frames keep arriving, but headless Chromium may behave differently from the user's browser; the manual list checks the rate with the image hidden.
- **Slot swaps when hands cross or touch.** Possible with position-only matching; two-hand gestures are short. The manual list checks it; `HAND_MATCH_PX` and `DUPLICATE_HAND_PX` are the knobs.
- **Fist reliability.** The curl thresholds are estimates. `FIST_ENABLED = false` removes the fist and leaves pinch gestures unchanged; the debug line shows the curl ratio for tuning.
- **Task size.** Task 5 (wiring and the rest of P0) and Task 7 (fist: detection, holds and explode) are the largest. Task 3 took the status line, gates and debug panel and Task 4 the drawing helpers so that Task 5 stays within one session; Task 7 has no P0 dependency beyond Task 5 and can be cut whole.
- **Tuning time is not a task.** Plan about half a day after Task 5, and again after Task 7, for the manual list and constant changes.
- **E2E timing under SwiftShader.** Two-hand steps double the filter and settle latency per step; tests poll attributes, but `hand-control.spec.ts` may take several minutes.
- **Later: lazy pose loading** (§3.1), to make hand control ready about 4 s sooner on each camera start.

## 15. Changes to the code of Tasks 1–2

Tasks 1 and 2 stay as committed; these changes are made by later tasks:

| File (built in) | Change | Task |
|---|---|---|
| `src/try-on/arm.worker.ts` (T1) | `numHands: 1` → `TRACKED_HANDS` (2) | T3 |
| `src/hands/useHandTracking.ts` (T1) | capture-loop fallback to `requestAnimationFrame` when video-frame callbacks stall; interval cleared in `stop()` | T3 |
| `src/hands/tracking-plan.ts` (T1) | adds `frameClockStep` | T3 |
| `src/hands/constants.ts` (T2) | header comment no longer promises `ROTATE_DEG_PER_PX` and the double-tap constants; new constants per §4.1 | T3, T4, T6–T8 |
| `src/hands/types.ts` (T2) | `HandMode` and `HandView.mode` removed; `HandView` per hand (`slot`, `cursor`, `palm`, `badge`); `OverlayFrame`, `GestureKind`, `HandSlot`; `HandSample.palm`; states `join`, then `fist`, `hold`; `HandSample.curl` | T3, T4, T7 |
| `src/hands/mapping.ts` (T2) | `handSample` adds `palm`, then `curl` | T3, T7 |
| `src/hands/style.ts` (T2) | `MODE_COLOURS` → `HAND_COLOUR` and `LINK_COLOUR`; `overlayStyle({ state })` without a mode; `ring` field → `mark` with fist squares | T3, T7 |
| `src/hands/HandOverlay.tsx` (T2) | `draw(view)` → `draw(frame)` for up to two hands; `data-hand-mode` removed; `data-hand-count`, `data-hand2-state`, `data-hand2-target`, `data-gesture` added; marks, badges, link | T3, T5 |
| `src/hands/useHandControl.ts` (T2) | uses every hand of the frame, not `hands[0]`; gate, status and debug outputs; then the controller | T3, T5 |
| `src/hands/skeleton.ts` (T2) | `drawHand` unchanged; ring, square, badge, link and arc helpers added | T4, T7, T8 |
| `src/hands/pinch.ts`, `targets.ts`, `one-euro.ts` (T2) | no change; instantiated per hand | — |
| `tests/e2e/fake-hands.ts` (T1) | one hand → `showHands` for up to two hands (message `hands`), old helpers kept as wrappers; fists | T3, T7 |
| `tests/fixtures/synthetic-hand.ts` (T1) | `fist` option | T7 |
| `tests/e2e/hand-control.spec.ts` (T1, T2) | the T2 case's `data-hand-mode` assertion removed | T3 |
| `tests/unit/hand-input.test.ts` (T2) | the overlay style test no longer expects two mode colours | T3 |
