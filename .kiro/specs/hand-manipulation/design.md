# Hand manipulation — Design

This design satisfies `requirements.md`. It follows the patterns of `agent-harness` and `workspace-v2`: pure modules unit-tested in Node (no DOM), thin React and Three.js wiring covered by Playwright, and one place for every rule. Requirement numbers (R…) refer to `requirements.md`.

## 1. Approach

The work splits into four layers, each depending only on the one above it:

```
tracking     useHandTracking: one worker per camera session, frames out through a HandSource (R1–R7)
               ├─ useArmTracking (try-on, unchanged behaviour) consumes the same frames
               └─ useHandControl (this spec) consumes them too
input        pure: landmark → screen mapping, One Euro cursor, pinch state machine, picking, settling (R12, R19–R23)
gestures     pure: gates, pinch decision, HandController with a port interface, drag/orbit/rotate maths (R24–R42)
wiring       SceneViewport grab and orbit sessions, the overlay canvas, the status line, App state (R8–R18, R43–R46)
```

The **HandController** is the heart of the design. It is a plain class that receives one hand sample per tracking frame and a tick per video frame, and talks to the outside only through a small `HandPort` interface (pick, select, begin a grab, begin an orbit, press). Unit tests drive it with synthetic landmark sequences and a fake port, so every gesture rule is tested without a browser. In the app, `useHandControl` implements the port with `SceneViewport`'s new imperative methods and App's existing `pick` callback.

A hand drag is a **session** owned by `SceneViewport`: it moves the part's scene node as a preview, exactly as the gizmo moves it, and on release calls the same `onTransform` callback the gizmo calls. App commits it through `updatePart`, as one undo step. Nothing in `shared/` changes.

The tracking worker file stays where it is (`src/try-on/arm.worker.ts`) and its protocol only gains an optional field, so the existing try-on fake in `arm-try-on.spec.ts` keeps matching and working.

## 2. Module layout

```
src/try-on/arm-pose.ts             EDIT  ArmWorkerFrame gains `pose?: boolean` (T1)
src/try-on/arm.worker.ts           EDIT  runs pose only when the frame asks for it (T1)
src/try-on/useArmTracking.ts       EDIT  consumes a HandSource; same return shape and texts (T1)
src/hands/useHandTracking.ts       NEW   worker lifecycle, capture loop, watchdogs, HandSource, rate (T1)
src/hands/tracking-plan.ts         NEW   trackingPlan, RateWindow, pure (T1)
src/hands/constants.ts             NEW   every tuning constant (T2; T6 and T7 add theirs)
src/hands/types.ts                 NEW   Point, HandSample, Target, ScreenTarget, HandMode (T2)
src/hands/mapping.ts               NEW   landmarkToClient, handSample (T2)
src/hands/one-euro.ts              NEW   OneEuroFilter2D (T2)
src/hands/pinch.ts                 NEW   pinchStep state machine (T2; T7 adds double tap)
src/hands/targets.ts               NEW   pickTarget, targetKey, settleStep (T2)
src/hands/skeleton.ts              NEW   HAND_CONNECTIONS, drawHand (T2); drawRing, drawBadge (T5)
src/hands/style.ts                 NEW   MODE_COLOURS, overlayStyle (T2; T3 completes)
src/hands/HandOverlay.tsx          NEW   overlay <canvas> with an imperative draw handle (T2)
src/hands/useHandControl.ts        NEW   T2: maps frames and draws the skeleton; T4: runs the controller
src/hands/gate.ts                  NEW   handGate, speedStep (T3)
src/hands/decide.ts                NEW   decidePinch (T3)
src/hands/controller.ts            NEW   HandController, HandPort, GrabSession, OrbitSession (T3)
src/hands/text.ts                  NEW   badgeText, shortenName, handStatus, debugLine (T3)
src/hands/stats.ts                 NEW   HandStats accumulator (T3)
src/hands/drag.ts                  NEW   dragPosition, orbitOffset (T3); rotateEuler (T6)
src/hands/screen-targets.ts        NEW   ScreenTargets registry (T4, empty; T6 registers the mode buttons)
src/hands/HandDebugPanel.tsx       NEW   ?hands=debug panel (T5)
src/hands/HandModeButtons.tsx      NEW   手勢移動 / 手勢旋轉 in the camera view (T6)
src/hands/keys.ts                  NEW   handModeKey, pure (T6)
src/scene/hand-sessions.ts         NEW   createGrabSession, createOrbitSession (T4; T6 rotate; T7 frameBox)
src/scene/SceneViewport.tsx        EDIT  hitTest, beginPartGrab, beginOrbit, cancel rules, onTransform kind (T4);
                                         Home key (T6); frameTarget (T7)
src/App.tsx                        EDIT  手勢 switch and tracking (T1); overlay (T2); controller, gates, status line (T4);
                                         debug panel (T5); hand mode, buttons, keys (T6)
src/styles.css                     EDIT  .hand-overlay, .hand-status, .hand-debug, .hand-modes rules only
README.md                          EDIT  privacy line (T1); hand control section (T5; T6 and T7 add a line each)
.kiro/steering/structure.md        EDIT  a `src/hands/` line (T1)

tests/fixtures/synthetic-hand.ts   NEW   syntheticHand(): 21 image + 21 world landmarks with a given pinch (T1)
tests/unit/hand-tracking.test.ts   NEW   trackingPlan, rate window (T1)
tests/unit/hand-input.test.ts      NEW   mapping, One Euro, pinch, picking, settling (T2)
tests/unit/hand-controller.test.ts NEW   gates, decision, controller with a fake port, texts, stats (T3)
tests/unit/hand-drag.test.ts       NEW   drag and orbit maths (T3); rotate maths (T6); framing maths (T7)
tests/unit/hand-sessions.test.ts   NEW   grab sessions on a Three.js node tree, grabStillValid (T4); rotate sessions (T6)
tests/e2e/fake-hands.ts            NEW   installFakeHands, showHand, hideHand, fakeHandsLog (T1)
tests/e2e/hand-control.spec.ts     NEW   grows task by task (T1–T7)
tests/e2e/workbench.spec.ts        EDIT  installFakeHands only (T1)
tests/e2e/visual-backgrounds.spec.ts EDIT installFakeHands only (T1)
```

`src/hands/` never imports `server/`. Pure modules (`mapping`, `one-euro`, `pinch`, `targets`, `gate`, `decide`, `controller`, `text`, `stats`, `drag`, `style`) import only Three.js math classes and each other, so they run in Vitest under Node like `shared/bounds.ts`.

## 3. Shared tracking

### 3.1 Worker protocol (`arm-pose.ts`, `arm.worker.ts`)

`ArmWorkerFrame` gains one optional field:

```ts
export interface ArmWorkerFrame { bitmap: ImageBitmap; width: number; height: number; timestamp: number; pose?: boolean }
```

The worker runs pose only when `pose !== false` and the existing `POSE_INTERVAL_MS` has passed; otherwise it sends `body: []` and resets `lastPose`, so the next try-on frame runs pose at once. A missing field keeps today's behaviour. The flag rides on the frame, not on a separate message, because the try-on fake in `arm-try-on.spec.ts` treats every message as a frame and would fail on a message without a bitmap (R5).

The worker still loads and warms both models at start (R3). Loading pose lazily would make hand control ready about 4 s sooner, but the first try-on frame would then block on a download and a shader compile inside the frame handler and could hit the 10 s watchdog. Keeping today's start-up is the low-risk choice; §14 lists it as a later improvement.

### 3.2 `useHandTracking` (`src/hands/useHandTracking.ts`)

The worker lifecycle, the capture loop, the load timeout and the per-frame watchdog move here from `useArmTracking` with their logic unchanged (frame interval 30 ms, longest edge 640 px, mirrored copy, one frame in flight).

```ts
export type TrackerStatus = 'off' | 'loading' | 'ready' | 'load-error' | 'track-error';
export interface TrackedFrame extends LandmarkFrame {
  requestedAt: number;   // the video-frame callback time the frame was captured at
  capturedAt: number;    // performance.now() at capture
  receivedAt: number;
  inferenceMs: number;
  pose: boolean;         // pose was requested for this frame
}
export interface HandSource {
  latest(): TrackedFrame | null;
  subscribe(listener: (frame: TrackedFrame) => void): () => void;
  /** Called on every video frame while running, with or without a result; drives time-outs. */
  onTick(listener: (now: number) => void): () => void;
  /** Frames returned per second over the last full second; updated once a second without a React render. */
  rate(): number | null;
  delegate(): TrackingDelegate | null;
}
export function useHandTracking(videoRef: RefObject<HTMLVideoElement | null>, options: {
  running: boolean;     // camera is on
  needed: boolean;      // 手勢 is on or try-on is active
  wantPose: boolean;    // try-on is active
  mirrored: boolean;
  onRate?: (fps: number, now: number) => void;  // once a second
}): { source: HandSource; status: TrackerStatus };
```

A pure helper in `src/hands/tracking-plan.ts` decides what the hook does, so it is unit-tested without React; the same file holds `RateWindow`, the once-a-second frame counter:

```ts
export function trackingPlan(input: { running: boolean; needed: boolean; started: boolean }):
  { worker: 'start' | 'keep' | 'stop' | 'none'; sendFrames: boolean };
```

- The worker starts the first time `running && needed` holds, and stops (terminated) when `running` turns false or on unmount (R1, R66).
- While `running` stays true, the worker is kept even when `needed` turns false; frames are simply not sent (R9: no hand-only inference). Turning 手勢 or try-on back on resumes at once, without the 20–30 s reload (R2).
- `wantPose` is read from a ref when each frame is captured and put into `ArmWorkerFrame.pose` (R3).
- Listeners run synchronously in the worker's `onmessage`; the hook never calls `setState` per frame (R4, R64). `status` changes only on load, ready and error.

### 3.3 `useArmTracking` as a consumer

```ts
export function useArmTracking(source: HandSource, tracker: TrackerStatus, enabled: boolean):
  { sample: RefObject<ArmSample | null>; status: ArmTrackingStatus; stats: ArmTrackingStats | null };
```

It subscribes while `enabled` (try-on active), runs `ArmTracker.update(frame, frame.capturedAt)`, and keeps today's `validUntil` rule, `searching`/`tracking` switching, once-a-second stats and the `ArmTrackingStatus` values: `off` when not enabled, `loading` while the tracker loads, `load-error`/`track-error` from the tracker, otherwise `searching` or `tracking`. The return shape is unchanged, so App's try-on line and `SceneViewport`'s `tryOn` prop do not change (R5). Stats count only frames received while try-on is on, as today.

### 3.4 App: the 手勢 switch and tracking (R8–R11)

```ts
const [handsOn, setHandsOn] = useState(true);          // reset to true in stopCamera and on a failed start
const cameraOn = camera === 'on';
const tracking = useHandTracking(videoRef, { running: cameraOn, needed: handsOn || tryOnActive, wantPose: tryOnActive, mirrored, onRate });
const armTracking = useArmTracking(tracking.source, tracking.status, tryOnActive);
```

The 手勢 button sits in the first `.stage-toolbar` button group after 護臂試戴, rendered only while `camera === 'on'`: `<button type="button" aria-pressed={handsOn} className="button …active">手勢</button>`. It stays enabled during agent runs (switching it changes no data). When it turns off, the controller is reset (a running drag is cancelled, R39) and the overlay, status line and mode buttons unmount (R9).

## 4. Input pipeline (pure)

### 4.1 Constants (`constants.ts`, R47)

| Constant | Default | Meaning |
|---|---|---|
| `CURSOR_POINT` | `'pinch-midpoint'` | `'pinch-midpoint'` (landmarks 4 and 8) or `'index-knuckle'` (landmark 5) |
| `CURSOR_MIN_CUTOFF` | 1.0 Hz | One Euro minimum cutoff |
| `CURSOR_BETA` | 0.01 (per px/s) | One Euro speed coefficient |
| `CURSOR_D_CUTOFF` | 1.0 Hz | One Euro derivative cutoff |
| `PINCH_ENGAGE_M` / `PINCH_ENGAGE_FRAMES` | 0.03 m / 2 | R20 |
| `PINCH_RELEASE_M` / `PINCH_RELEASE_FRAMES` | 0.05 m / 3 | R20 |
| `HOVER_SETTLE_MS` | 150 | R23 |
| `HAND_LOST_MS` | 300 | overlay hides; cursor filter and an idle pinch reset |
| `DRAG_DEAD_ZONE_PX` | 8 | R29 |
| `DRAG_GAIN` | 1.5 | R30; 1 keeps the grabbed point under the cursor |
| `ORBIT_DEG_PER_PX` | 0.4 | R35; about a mouse orbit's speed on a 1000 px tall view |
| `TRACKING_LOSS_MS` | 300 | R37 |
| `ON_TRACKING_LOSS` | `'cancel'` | R37, `'cancel' \| 'keep'` |
| `MIN_CONTROL_FPS` / `SPEED_HOLD_MS` | 10 / 2000 | R40 |
| `CANCEL_NOTICE_MS` | 4000 | R43 |
| `BADGE_NAME_MAX` | 12 | R16 |
| `ROTATE_DEG_PER_PX` (T6) | 0.5 | R57 |
| `DOUBLE_TAP_MS` / `DOUBLE_TAP_PX` (T7) | 400 / 30 | R60 |

### 4.2 Types (`types.ts`)

```ts
export interface Point { x: number; y: number }              // client (CSS) pixels
export type HandMode = 'translate' | 'rotate';
export interface HandSample {
  points: Point[];          // the 21 landmarks in client pixels, for drawing
  cursor: Point;            // unfiltered CURSOR_POINT in client pixels
  pinchM: number | null;    // world distance 4–8 in metres; null without world landmarks
}
export type Target =
  | { kind: 'empty' }
  | { kind: 'screen'; id: string; label: string }
  | { kind: 'part'; objectId: string; partId: string; label: string; hit: Vector };  // hit = world point
export interface ScreenTarget { id: string; label: string; left: number; top: number; right: number; bottom: number }
```

`targetKey(target)` gives `''`, `screen:{id}` or `{objectId}:{partId}`; it is what `data-hand-target` shows (R18) and what settling compares.

### 4.3 Mapping (`mapping.ts`, R7, R12)

Landmarks arrive in display space, because the frame is flipped before tracking when the video is mirrored (R7). The mapping therefore has no mirror branch; it only undoes `object-fit: cover`:

```ts
export function landmarkToClient(point: { x: number; y: number }, view: { left: number; top: number; width: number; height: number },
  video: { width: number; height: number }): Point {
  const scale = Math.max(view.width / video.width, view.height / video.height);
  const offsetX = (view.width - video.width * scale) / 2, offsetY = (view.height - video.height * scale) / 2;
  return { x: view.left + offsetX + point.x * video.width * scale, y: view.top + offsetY + point.y * video.height * scale };
}
export function handSample(hand: HandLandmarks, view, video, cursorPoint = CURSOR_POINT): HandSample | null;
```

`view` is the video element's bounding rectangle, read once per tracking frame; `video` is the frame's `width`/`height` (the video's own size, as today). `handSample` returns `null` for a hand with fewer than 21 finite points. The overlay canvas and the scene canvas cover the same `.viewport` box as the video, so the same client points serve drawing and picking.

### 4.4 One Euro filter (`one-euro.ts`, R19)

`OneEuroFilter2D` (Casiez et al., CHI 2012) with `filter(point, timeMs)` and `reset()`, per axis: `alpha(cutoff, dt) = 1 / (1 + 1 / (2π · cutoff · dt))`, derivative smoothed with `CURSOR_D_CUTOFF`, `cutoff = minCutoff + beta · |speed|`. The first sample after a reset passes through unchanged. The controller resets it when the hand has been missing for `HAND_LOST_MS`.

### 4.5 Pinch state machine (`pinch.ts`, R20, R21, R29, R60)

```ts
export interface PinchState {
  engaged: boolean;
  streak: number;                 // consecutive frames beyond the threshold that would change `engaged`
  handSeenAt: number | null;      // last frame with a hand
  missing: boolean;               // hand currently missing
  engagePoint: Point | null;      // filtered cursor at engage
  moved: boolean;                 // left the dead zone since engage
  lastTap: { at: number; point: Point } | null;   // T7
}
export type PinchInput = { kind: 'hand'; cursor: Point; pinchM: number | null } | { kind: 'none' } | { kind: 'tick' };
export type PinchEvent =
  | { type: 'found' } | { type: 'lost'; engaged: boolean }
  | { type: 'engage'; point: Point } | { type: 'drag-start' }
  | { type: 'release'; tap: boolean; point: Point }
  | { type: 'double-tap'; point: Point };          // T7
export function pinchStep(state: PinchState, input: PinchInput, now: number): { state: PinchState; events: PinchEvent[] };
```

Rules:
- `hand` frames count toward the streak only when `pinchM` is a number: below `PINCH_ENGAGE_M` counts toward engaging, above `PINCH_RELEASE_M` toward releasing, anything between resets the streak (no change between thresholds, and a one-frame spike never reaches 2 or 3 frames). `pinchM === null` resets the streak and never engages (R20).
- While engaged, a cursor farther than `DRAG_DEAD_ZONE_PX` from `engagePoint` sets `moved` once and emits `drag-start`. `release.tap` is `!moved` (R29).
- `none` frames and `tick`s check time-outs: missing for `TRACKING_LOSS_MS` while engaged → `lost { engaged: true }` and the state disengages; missing for `HAND_LOST_MS` while not engaged → `lost { engaged: false }`. A hand that returns before the time-out continues the same pinch (R37).
- `found` is emitted on the first hand frame after a `lost`.

Only tracking frames (`hand`/`none`) count toward streaks, so the frame counts are tracking frames as R20 says; `tick`s only advance time.

### 4.6 Picking and settling (`targets.ts`, R22, R23)

```ts
export function pickTarget(point: Point, screen: readonly ScreenTarget[], scene: (point: Point) => Target): Target;
export interface SettleState { settled: Target; candidate: Target; since: number }
export function settleStep(state: SettleState, raw: Target, now: number): SettleState;
```

`pickTarget` checks `screen` first (the last registered rectangle that contains the point wins, so a later, higher target wins), then calls `scene`. `settleStep` compares `targetKey`s: a new raw key becomes the candidate; the candidate becomes settled once it has held `HOVER_SETTLE_MS`. When raw and settled name the same part, the settled target takes the raw target's newer `hit`, so a grab uses a current hit point. Later specs add on-screen targets by registering more rectangles; nothing here changes (R22).

## 5. Gestures (pure)

### 5.1 Gates (`gate.ts`, R40–R42)

```ts
export type GateLevel = 'full' | 'view-only' | 'off';
export type GateReason = 'try-on' | 'slow' | 'agent' | 'exploded';
export function handGate(input: { tryOn: boolean; slow: boolean; agentActive: boolean; exploded: boolean }):
  { level: GateLevel; reason: GateReason | null };
export interface SpeedState { slow: boolean; since: number | null }
export function speedStep(state: SpeedState, fps: number, now: number): SpeedState;
```

Priority: try-on, then slow (both `off`), then agent, then exploded (both `view-only`). The delegate is not an input: a CPU fallback with a good rate keeps full hand control, and only the measured rate decides (R40). The delegate still appears in the debug line (§5.5). `speedStep` is fed once a second from `onRate`; it flips to slow after `fps < MIN_CONTROL_FPS` has held for `SPEED_HOLD_MS`, and back after `fps ≥ MIN_CONTROL_FPS` has held as long. Before the first full second after `ready` the rate is unknown and counts as fast.

### 5.2 Pinch decision (`decide.ts`, R24–R28)

```ts
export type PinchAction = { kind: 'press'; id: string } | { kind: 'grab'; objectId: string; partId: string; hit: Vector }
  | { kind: 'orbit' } | { kind: 'none' };
export function decidePinch(target: Target, context: { objectCount: number; gate: GateLevel }): PinchAction;
```

| Gate | Screen target | Part | Empty space |
|---|---|---|---|
| `full` | press (on tap) | grab | orbit |
| `view-only` | press (on tap) | orbit | orbit |
| `off` | none | none | none |

With `objectCount === 0`, parts and empty space give `none`. Whether the part belongs to the active object does not change the action; the controller's `select` call (App's `pick`) handles activation (R25).

### 5.3 The controller (`controller.ts`)

```ts
export interface HandPort {
  pick(point: Point): Target;                       // pickTarget with the registered screen targets and SceneHandle.hitTest
  select(objectId: string, partId: string): void;   // App.pick(objectId, partId, false)
  beginGrab(objectId: string, partId: string, kind: HandMode, hit: Vector): GrabSession | null;
  beginOrbit(): OrbitSession | null;
  press(id: string): void;
  frame(target: Target): void;                      // T7
}
export interface GrabSession { preview(offset: Point): boolean; commit(): void; cancel(): void }   // preview false = no longer valid
export interface OrbitSession { preview(offset: Point): void; end(): void }
export type HandState = 'none' | 'tracked' | 'hover' | 'grab' | 'orbit' | 'locked';
export interface HandView { state: HandState; mode: HandMode; target: Target; cursor: Point | null; points: Point[] | null; gate: GateLevel; ringed: boolean }

export class HandController {
  constructor(port: HandPort);
  setGate(gate: { level: GateLevel; reason: GateReason | null }): void;
  setMode(mode: HandMode): void;                   // applies to the next grab (R58)
  setObjectCount(count: number): void;
  frame(sample: HandSample | null, now: number): HandView;
  tick(now: number): HandView | null;              // null when nothing changed
  reset(): void;                                   // cancel and forget: 手勢 off, camera off, page hidden
  readonly stats: HandStats;
  onCancelled?: (reason: 'loss' | 'gate' | 'external') => void;
}
```

One `frame` call:
1. With a sample: filter the cursor; unless a pinch is engaged, `pick` the raw target and `settleStep` it. Without one: feed `none`.
2. `pinchStep` and handle its events:
   - `engage` → `decidePinch(settled, …)`. `grab`: call `select`, then `beginGrab(objectId, partId, mode, hit)`; `null` (mouse busy, exploded) → the pinch does nothing until release. `orbit`: `beginOrbit()`. `press`: remember the id. `none`: nothing until release (R42).
   - while engaged and moved: `grab.preview(cursor − engagePoint)` (a `false` return cancels: reason `external`), or `orbit.preview(…)`.
   - `release` → grab: `moved ? commit() : cancel()` (a tap only selects, R29; `cancel` restores nothing because nothing moved); orbit: `end()`; press: `port.press(id)` if `tap`.
   - `lost { engaged: true }` → grab: `ON_TRACKING_LOSS === 'cancel' ? cancel() : commit()`, `onCancelled('loss')` on cancel (R37); orbit: `end()` (R38).
3. Compute the `HandView` (§8.1).

`setGate` with a level that no longer allows the running gesture cancels it: a grab is cancelled when the level leaves `full`; an orbit ends when the level becomes `off` (R39). A pinch held across a gate change does nothing until it is released (R42). `setMode` never changes a running grab (R58).

### 5.4 Stats (`stats.ts`, R45)

`HandStats` holds plain counters the controller updates on events: `drags` (grabs that emitted `drag-start`), `commits`, `cancels`, `dragLosses` (hand missing at least one frame during a drag), `longestDragGapMs`, plus the latest `pinchM`, pinch state and settled target key. No timers, no logging (R46).

### 5.5 Texts (`text.ts`, R16, R43)

```ts
export function shortenName(name: string, max = BADGE_NAME_MAX): string;   // first 12 characters + '…' when longer (by code points)
export function badgeText(view: HandView): string;
export type HandStatusState = 'hidden' | 'loading' | 'error' | 'slow' | 'agent' | 'exploded' | 'cancelled' | 'hint';
export function handStatus(input: { tracker: TrackerStatus; gate: { level: GateLevel; reason: GateReason | null };
  cancelledAt: number | null; now: number; handSeen: boolean }): { state: HandStatusState; text: string };
export function debugLine(stats: HandStats, tracking: { delegate: TrackingDelegate | null; fps: number | null; inferenceMs: number | null }): string;
```

All strings are the tables of R16 and R43, written once here. `handStatus` returns `hidden` for try-on (the try-on line already shows) and when nothing applies after a hand has been seen. The 「太慢」 line belongs to `slow` only. `debugLine` is Traditional Chinese too (for example 「GPU · 每秒 28 幀 · 辨識 31 ms · 捏合 24 mm · 已抓取 · 目標 housing · 拖曳 3／完成 2／取消 1／拖曳中遺失 1（最長 420 ms）」).

## 6. Geometry (pure, `drag.ts`)

### 6.1 Moving a part (R30, R31, R33)

```ts
export function dragPosition(input: {
  camera: { matrixWorld: Matrix4; fovDeg: number }; viewportHeight: number;
  parentWorld: Matrix4;           // the part node's parent.matrixWorld (parent part, or the object's model group)
  start: Vector3;                 // the node's local position at engage
  hit: Vector3;                   // the grabbed world point
  offset: Point;                  // cursor offset since engage, CSS pixels
  gain?: number;                  // DRAG_GAIN
}): Vector;                       // new local position, rounded to 5 decimals and clamped to ±100 per axis
```

1. Depth of the grabbed point along the camera's forward axis: `d = (hit − cameraPosition) · forward`.
2. World size of one pixel at that depth: `k = 2 · d · tan(fov / 2) / viewportHeight`. This is where precision comes from: a closer camera means a smaller `d` and a finer move per pixel (R31).
3. World offset in the camera plane: `Δ = right · (offset.x · gain · k) − up · (offset.y · gain · k)` (screen y grows downward).
4. New local position: `parentWorld⁻¹ · (parentWorld · start + Δ)`. Parents never scale children, so `parentWorld` is rigid and the inverse is exact; the object root's transform is part of `parentWorld`, so rotated objects and rotated parents need no special case.

### 6.2 Turning the view (R35)

```ts
export function orbitOffset(start: Vector3 /* camera − target at engage */, offset: Point, degPerPx: number,
  limits: { minPolar: number; maxPolar: number; minAzimuth: number; maxAzimuth: number }): Vector3;
```

`Spherical.setFromVector3(start)`; `theta −= offset.x · degPerPx`, `phi −= offset.y · degPerPx` (radians), clamped to the limits and to `[ε, π − ε]` as OrbitControls does; returns the new camera − target vector. Moving the hand right turns the view the same way as dragging the mouse right.

### 6.3 Rotating a part (T6, R57)

```ts
export function rotateEuler(input: { parentWorld: Matrix4; start: Euler /* local, radians, XYZ */; cameraWorld: Matrix4;
  offset: Point; degPerPx: number }): Vector;   // degrees, rounded to 2 decimals
```

`q = yaw(worldUp, offset.x · degPerPx) · pitch(cameraRight, offset.y · degPerPx)`; world start `w = parentQ · startQ`; new local `parentQ⁻¹ · q · w`, converted to XYZ Euler degrees. Euler angles from a quaternion lie within ±180°, so the ±360° limit always holds. The part turns about its own origin; its position is untouched.

### 6.4 Framing a part (T7, R61)

```ts
export function frameBox(box: Box3, camera: { position: Vector3; fovDeg: number; aspect: number }, target: Vector3):
  { target: Vector3; position: Vector3; minDistance: number };
```

Centre of the box becomes the orbit target; the camera keeps its viewing direction and moves to `radius / sin(min(vFov, hFov) / 2) · 1.4` from it; `minDistance = min(current, radius · 1.12)` so the mouse wheel can still reach it.

## 7. Scene (`SceneViewport.tsx`, `hand-sessions.ts`)

### 7.1 Handle additions

```ts
export interface SceneHandle {
  reset(): void; zoomIn(): void; zoomOut(): void;
  projectPart(id: string, objectId?: string): { x: number; y: number } | null;
  /** Nearest part surface under a client point, over all objects; null for empty space or outside the canvas. */
  hitTest(point: Point): { objectId: string; partId: string; name: string; hit: Vector } | null;
  beginPartGrab(objectId: string, partId: string, kind: HandMode, hit: Vector): GrabSession | null;
  beginOrbit(): OrbitSession | null;
  frameTarget(objectId?: string, partId?: string): void;     // T7; no arguments = frame all objects
}
```

`hitTest` and the click handler share one `hitsAt(point)` helper (the surface list is rebuilt only in `sync`, not per call). `onTransform` gains a fifth parameter, `kind: 'translate' | 'rotate'`; the gizmo passes its own mode.

### 7.2 Grab sessions

`beginPartGrab` returns `null` when: the object or part is unknown; the exploded view is shown or animating (`explodeTarget > 0 || explodeShown > 0`, the same test the gizmo uses); the gizmo is dragging; or a mouse orbit is running (tracked between OrbitControls' `start` and `end` events) (R34, R41). Otherwise it:
- calls `ensureExplosion(entry)` first when the object is not active yet. Explosion bases are captured from the node positions when first computed; computing them later, in the middle of the preview, would store the previewed position as the part's assembled position.
- records the node's stored position and rotation (from the model, not the node, so a move commits the stored rotation unchanged and a rotate the stored position, R33);
- sets `gizmo.enabled = false` until the session ends (R34);
- returns a `createGrabSession(…)` whose `preview` computes `dragPosition` (or `rotateEuler`) from the node's live `parent.matrixWorld`, sets the node, and invalidates the render. Child parts follow because they are child nodes, as with the gizmo (R32).

`commit` compares the rounded result with the stored value; when equal it does nothing, otherwise it calls `onTransform(objectId, partId, position, rotation, kind)` once (R32). `cancel` puts the stored value back on the node (R37, R39).

**Cancel rules (R39).** A pure `grabStillValid(plan, nextActiveId, objectId)` in `hand-sessions.ts` decides it: `sync` marks a live session invalid when its plan builds, rebuilds, moves or removes any object, or when the new active id is not the session's object; the next `preview` returns `false` and the controller cancels. Activating the grabbed object (R25) changes only the active id to the session's own object and rebuilds nothing, so it does not cancel. Undo, redo, the 物件 panel, part fields and agent `state` events all change objects and therefore cancel. After `sync` and after `applyExplosionShown`, a valid session re-applies its last preview, because activation resets node positions to their explosion bases.

### 7.3 Orbit sessions

`beginOrbit` returns `null` while the mouse drags or the gizmo drags, or with no objects. It records `camera.position − controls.target` and sets `viewChanged = true` (R36). `preview` sets `camera.position = target + orbitOffset(…)`, calls `camera.lookAt(target)` and `controls.update()`, and invalidates. `end` does nothing else; the view stays (R38). The existing render loop keeps `data-camera-position` current.

### 7.4 App's commit path

```ts
function onTransform(objectId: string, id: string, position: Vector, rotation: Vector, kind: 'translate' | 'rotate') {
  if (agentActive || objectId !== store.current().activeObjectId) return;
  updatePart(id, { position, rotation }, kind === 'rotate' ? '已旋轉零件，可按「復原」回到上一步。' : '已移動零件，可按「復原」回到上一步。');
}
```

The gizmo and the hand share this function, so a hand drag is one `commit` in the workspace store, one undo step, with today's notices (R32, R57).

## 8. Overlay, status line and debug panel

### 8.1 The view and its style (`style.ts`, R14, R15)

`HandView.state` comes from the controller: `grab` and `orbit` while a session runs; `locked` when the gate is `off`, or `view-only` while not orbiting and not over an on-screen target; `hover` when the settled target is a part (gate `full`) or an on-screen target; `tracked` with a hand otherwise; `none` without one.

```ts
export const MODE_COLOURS = { translate: '#CC79A7', rotate: '#D55E00' } as const;   // Okabe–Ito reddish purple, vermillion
export const LOCKED_COLOUR = '#9AA3AD';
export function overlayStyle(view: HandView): { colour: string; dashed: boolean; lineWidth: number; ring: 'none' | 'hollow' | 'filled' };
```

The two Okabe–Ito colours stay distinguishable with the common colour-vision deficiencies and differ from the part-edge cyan `#69eaff` and the selection amber `#ffc53d`. Lines are 2 px for `tracked`/`hover`, 3.5 px for `grab`/`orbit`, with a 1 px dark outline so they read on skin and on bright video. `locked` uses grey dashes.

### 8.2 `HandOverlay` and drawing (`HandOverlay.tsx`, `skeleton.ts`)

A `<canvas className="hand-overlay" data-testid="hand-overlay" aria-hidden="true">` inside `.viewport`, above the scene canvas, `position:absolute; inset:0; pointer-events:none` (R17), not CSS-mirrored (the points are already in display space). Its handle `draw(view)` clears and redraws: the 21 points and the 21 standard MediaPipe hand connections (Task 2), then the cursor ring and the badge (Task 5; dark rounded rectangle, white 13 px text, 16 px right of and above the cursor, kept inside the canvas). Until Task 5 the hand state is visible only in the data attributes and the line style. It sizes its backing store to the box times `devicePixelRatio` on resize. `data-hand-state`, `data-hand-mode` and `data-hand-target` are written only when they change (R18). With no hand for `HAND_LOST_MS` it clears (R13).

### 8.3 `useHandControl` (`src/hands/useHandControl.ts`)

```ts
export function useHandControl(input: {
  source: HandSource; tracker: TrackerStatus; enabled: boolean;      // camera on and 手勢 on
  gate: { level: GateLevel; reason: GateReason | null }; objectCount: number; mode: HandMode;
  sceneRef: RefObject<SceneHandle | null>; videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HandOverlayHandle | null>; screenTargets: ScreenTargets;
  onPick: (objectId: string, partId: string) => void;
}): { status: { state: HandStatusState; text: string }; stats: HandStats };
```

While `enabled`, it subscribes to `source` and `source.onTick`. Per frame: the video rect, `handSample(frame.hands[0], …)`, `controller.frame`, `overlay.draw`. Per tick: `controller.tick`, and `draw` when it returns a view. It implements `HandPort` with `sceneRef.current` (`hitTest`, `beginPartGrab`, `beginOrbit`, `frameTarget`), `screenTargets` and `onPick`. `gate`, `mode` and `objectCount` are pushed into the controller in effects. A `visibilitychange` to hidden, `enabled` turning false and unmount call `controller.reset()`. React state holds only the status line (recomputed when the tracker status, the gate, a cancel or the first hand changes) (R64).

App computes the gate:

```ts
const gate = handGate({ tryOn: tryOnActive, slow, agentActive, exploded: explode > 0 });
```

`slow` is React state set from `speedStep` in `onRate`, changing only when it flips. During the explode animation back to 0, the gate is already `full` but `beginPartGrab` still refuses (§7.2), so no offset can be committed.

### 8.4 Status line and debug panel (R43, R45)

The status line renders under `.stage-toolbar`, next to the try-on line, as `<p className="notice hand-status" role="status" data-testid="hand-status" data-state={state}>` when the camera and 手勢 are on and the state is not `hidden`. `error`, `slow` and `cancelled` use the `warning` style.

`HandDebugPanel` renders only when `new URLSearchParams(location.search).get('hands') === 'debug'`: a `<p data-testid="hand-debug" className="small-muted">` that reads `debugLine(stats, …)` every 500 ms with its own interval. Without the parameter it is not mounted, so the counters are only plain increments (R45, R46).

## 9. Rotate mode (P1, T6)

- **State.** `const [handMode, setHandMode] = useState<HandMode>('translate')`, reset to `'translate'` in `stopCamera` (R56). Passed to `useHandControl` (`controller.setMode`) and to the overlay through the view.
- **On-screen buttons.** `HandModeButtons` renders, inside `.viewport` at the top-right corner (the top-left holds the stage label), a `.hand-modes` group of two real `<button type="button" aria-pressed>` elements, 手勢移動 and 手勢旋轉, each at least 88 × 48 CSS pixels, shown while the camera and 手勢 are on. Mouse clicks and keyboard activation work as for any button.
- **Hand picking.** Each button registers with `ScreenTargets` through a ref callback: `{ id: 'mode-translate' | 'mode-rotate', label: '手勢移動' | '手勢旋轉', element, press }`. `ScreenTargets.rects()` reads each element's `getBoundingClientRect()` once per tracking frame. A pinch tap presses the button through `port.press(id)`, the same `setHandMode` the mouse calls; a drag that starts on a button does nothing (§5.2).
- **Keys.** A separate window `keydown` listener in App (not the agent-gated undo handler): with the camera and 手勢 on, no modifier, and focus not in an `input`, `textarea`, `select` or `contenteditable`, G sets `'translate'` and R `'rotate'`. In `SceneViewport`'s canvas key handler, `r` is replaced by `Home` for 重設視角.
- **Rotation.** `beginPartGrab(…, 'rotate', …)` uses `rotateEuler`; everything else in §7.2 applies unchanged.
- **Style.** The second colour of `MODE_COLOURS` and the 旋轉 badge texts become reachable.

## 10. Double-pinch zoom (P1, T7)

- `pinchStep` emits `double-tap` on a tap whose engage time and point are within `DOUBLE_TAP_MS` and `DOUBLE_TAP_PX` of the previous tap's, then clears `lastTap`. Single taps act at once; nothing is delayed (R60).
- The controller handles `double-tap` when the gate is not `off` (R62): a part → `port.frame(target)` → `frameTarget(objectId, partId)`; empty space → `frameTarget()`, the same framing as 重設視角; an on-screen target → nothing more.
- `frameTarget(objectId, partId)` measures the part's surface box as `projectPart` does, applies `frameBox`, sets `viewChanged = true`, and leaves damping off for that one update as `fit()` does. No data changes (R61).

## 11. Testing strategy

### 11.1 Synthetic hands (`tests/fixtures/synthetic-hand.ts`)

```ts
export function syntheticHand(options: { cursor: { x: number; y: number }; pinchM: number; size?: number; side?: 'left' | 'right';
  world?: boolean }): HandLandmarks;
export function landmarkSequence(steps: Array<{ at: number; hand: Parameters<typeof syntheticHand>[0] | null }>): …;
```

It builds a flat, open right or left hand around a normalised cursor point: image landmarks scaled to `size` (default 0.25 of the frame height), with landmarks 4 and 8 placed so their midpoint is the cursor and their world distance is `pinchM`; world landmarks in metres (palm about 8 cm), with `world: false` to drop them. Unit tests and the e2e helper both use it.

### 11.2 Unit tests (Vitest, Node, no DOM)

- `hand-tracking.test.ts` (T1): every `trackingPlan` case (start, keep while 手勢 off, stop when the camera goes off, never start while not needed); the rate window.
- `hand-input.test.ts` (T2): `landmarkToClient` for a view wider and a view taller than the video, and the round trip through the e2e helper's inverse; `handSample` with each `CURSOR_POINT` and without world landmarks; One Euro passes the first sample, smooths jitter at rest, follows a fast move with little lag, resets; `pinchStep` engage and release at the thresholds and frame counts, no change between thresholds, one-frame spikes, `null` distance never engages, tap versus drag at the dead zone, loss shorter and longer than `TRACKING_LOSS_MS` while engaged, `HAND_LOST_MS` while idle; `pickTarget` prefers a screen target over a part behind it; `settleStep` ignores a raw target held less than `HOVER_SETTLE_MS`, and a cursor drift while the fingers close (a synthetic sequence moving 6 px over 3 frames during engage) keeps the grabbed target.
- `hand-controller.test.ts` (T3): `handGate` priority for every reason; `speedStep` both directions with the 2 s hold; `decidePinch` table including no objects; the controller with a fake port (records calls, returns fake sessions): grab on the active object; grab on an inactive object calls `select` then `beginGrab` in one gesture; tap selects and calls `cancel`, not `commit`; drag calls `preview` with offsets from the engage point and `commit` once; `beginGrab` returning `null` makes the pinch inert; `preview` returning `false` cancels; loss within and beyond `TRACKING_LOSS_MS`; `'keep'` commits; gate changes cancel a grab and end an orbit; a pinch held across a gate change stays inert; `setMode` during a drag; `reset` cancels; `badgeText` for every state and mode with a 13-character name; `handStatus` priority; stats counters.
- `hand-drag.test.ts` (T3): `dragPosition` has no jump at offset 0; a camera looking down −Z moves +X for a rightward offset; a rotated camera moves in its own plane; a child under a rotated parent and a rotated object root lands on the expected local position (checked by transforming back to world); halving the camera distance halves the move per pixel; rounding and the ±100 clamp. `orbitOffset` keeps the distance, turns the azimuth for a horizontal offset and clamps the polar angle. T6 adds `rotateEuler` (a horizontal offset turns about world Y even under a rotated parent; the result stays within ±180°); T7 adds `frameBox`.

### 11.3 E2E (`tests/e2e/fake-hands.ts`, `hand-control.spec.ts`)

The helper routes the worker URL with the same pattern as `arm-try-on.spec.ts` and fulfils it with a scripted worker:

```ts
export async function installFakeHands(context: BrowserContext, options?: { delegate?: 'GPU' | 'CPU'; replyDelayMs?: number }): Promise<void>;
export async function showHand(page: Page, at: { x: number; y: number } /* client px */, pinchM: number): Promise<void>;
export async function hideHand(page: Page): Promise<void>;
export async function fakeHandsLog(page: Page): Promise<{ ready: number; frames: number; poseFrames: number }>;
```

- The fake worker posts `ready` with the chosen delegate (default GPU), waits `replyDelayMs` (default 0) before answering each frame so a test can make the tracker slow (150 ms gives about 6 frames per second, below `MIN_CONTROL_FPS`), opens `new BroadcastChannel('forgehand-fake-hands')`, keeps the latest hand it receives there, and answers every frame message with it (closing the bitmap). It also posts its counters (`ready` count, frames, frames with `pose: true`) on the channel, which the helper collects in the page through an init script.
- `showHand` reads the video element's rectangle and `videoWidth`/`videoHeight` in the page, converts the client point back to normalised display coordinates (the inverse of `landmarkToClient`), builds the hand with `syntheticHand` in Node, and posts it on the channel. Tests then wait with `expect.poll` on the overlay's data attributes, so the filter and settle delays need no fixed sleeps.
- The app has no test-only branch: the only seam is the worker URL (R50).
- `workbench.spec.ts` and `visual-backgrounds.spec.ts` get one `await installFakeHands(context)` line each, so no camera test downloads a model (R51). `arm-try-on.spec.ts` and `live-cli.spec.ts` are not touched.

`hand-control.spec.ts` grows with the tasks (R52, R59, R61):
- T1: camera on starts tracking with `pose` false (`fakeHandsLog`); 手勢 off stops frames; try-on with 手勢 off still reaches `try-on-status` `tracking` and sends pose frames; toggling try-on does not post a second `ready`; camera off and on resets 手勢 to pressed.
- T2: the overlay appears with a hand and the camera on, disappears with no hand and with the camera off; `data-hand-state` `tracked`; 手勢 off removes the overlay.
- T4: hover then pinch-drag-release on 外殼 (`housing`) of the demo: only `housing`'s position changes in `data-model-json`, `projectPart('battery')` moves with it, `data-object-json` is unchanged, one 復原 restores it; a pinch on a part of a second (inactive) object activates it, selects the part and moves it; a tap selects without an undo step; a pinch on empty space changes `data-camera-position` only; with 手勢 off a pinch does nothing and a mouse click still selects.
- T5: a hand lost mid-drag for longer than `TRACKING_LOSS_MS` puts the part back and shows the cancel notice; the exploded view and an active agent run (an `/api/agent` route that does not answer until the test releases it) make a pinch on a part turn the view instead; a fake with `replyDelayMs: 150` shows the 「太慢」 line and `locked` after `SPEED_HOLD_MS`, while a CPU `ready` with no delay keeps hand control on (a pinch-drag still moves a part); `?hands=debug` shows the panel; no gesture requests `/api/generate`, `/api/edit` or `/api/agent`. The full suite runs.
- T6 and T7: the cases of R59 and R61.

## 12. Task plan and requirement map

Seven tasks (R71). Each is one module group plus its tests and fits one fresh session. Order: 1 → 7. Tasks 6 and 7 are P1; cut 7 first, then 6.

| Task | Content | Requirements |
|---|---|---|
| 1 | Shared tracking: worker `pose` flag, `useHandTracking` + `trackingPlan`, `useArmTracking` as consumer, 手勢 switch in App, synthetic hand fixture, `fake-hands.ts` and its install in two specs, README privacy line, structure.md | 1–8, 9 (inference, worker), 10, 11 (switch name), 44 (switch), 50, 51, 53 (camera off), 54, 63, 66 |
| 2 | Input pipeline: constants, types, mapping, One Euro, pinch machine, picking and settling, skeleton drawing, `HandOverlay`, `useHandControl` part 1 (skeleton only, tracked and locked styles) | 9 (overlay hidden), 12, 13, 14 (first colour), 15 (lines), 17 (overlay), 18 (state, mode), 19–23, 47, 48, 49 (input), 52 (overlay), 64 (overlay) |
| 3 | Gestures, pure: gates and speed, pinch decision, `HandController`, drag and orbit maths, texts, style, stats | 16 (texts), 24–31 (rules and maths), 33 (rounding), 35 (maths), 37, 38, 39 (controller side), 40–42 (rules), 43 (texts), 45 (counters), 48, 49 (gestures) |
| 4 | Wiring: `SceneViewport` `hitTest`, grab and orbit sessions, cancel rules, `onTransform` kind, `ScreenTargets` (empty), `useHandControl` part 2 with the controller (hand state on the overlay's data attributes; no ring or badge yet), App gates | 15 (line styles per state), 17, 18 (state, target), 22 (scene), 24–36 (wiring), 39 (scene side), 40–41 (wiring), 52 (move, orbit, tap, inactive, 手勢 off), 53, 55, 64 |
| 5 | Cursor ring and badge drawing, status line, cancel notice, debug panel, README hand section, the remaining P0 e2e cases, full suite, manual webcam list | 9 (status line hidden), 15 (ring), 16 (badge drawn), 17 (badge aria-hidden), 37 (e2e), 40–41 (e2e), 43, 45, 46, 52 (rest), 54 (full suite), 70, 72 |
| 6 | P1 rotate mode: `rotateEuler`, rotate sessions, hand mode state, `HandModeButtons` as on-screen targets, G/R keys, Home for 重設視角, second colour, e2e, README and manual lines | 11 (mode buttons), 14, 22 (screen targets live), 27 (press), 55 (Home), 56–59, 70, 72 |
| 7 | P1 double-pinch zoom: double tap in `pinchStep`, `frameBox`, `frameTarget`, e2e, README and manual lines | 21 (double tap), 60–62, 70, 72 |

Requirements 65 and 67–69 apply to every task; 71 is satisfied by `tasks.md` itself.

**Manual webcam list.** `tasks.md` carries it under its own heading in Task 5, so it exists even if both P1 tasks are cut. Task 5 checks it against what was built and hands it to the user; Tasks 6 and 7 add their lines (R72). Task 2 also asks the reviewer for an early webcam check of the skeleton and the tracking rate.

## 13. Key decisions

- **A pure controller behind a port.** All timing, hysteresis, decisions and cancel rules live in one class with no DOM, so every rule in R19–R42 has a unit test with synthetic landmark sequences. The React and Three.js code only implements five port methods.
- **Sessions in the scene, commit through the gizmo's callback.** The preview moves the same node the gizmo would move, so child parts follow for free, and the commit is the same `onTransform` → `updatePart`, so undo, notices, validation and conflict handling are the gizmo's.
- **One worker per camera session.** Started on first need, kept idle while 手勢 and try-on are both off, terminated with the camera. Switching 手勢 or try-on never costs another 20–30 s start-up.
- **The worker URL is the only test seam.** It already exists for try-on; the fake answers frames with scripted hands, so e2e tests drive the real app code end to end.
- **Pinch on the world landmarks, cursor on the image landmarks.** Metric distances make the thresholds independent of how far the hand is from the camera; screen positions come from the image landmarks the user sees.
- **Precision by depth.** Converting the cursor offset at the grabbed point's depth makes zooming in the precision control, as with the mouse, with no extra mode.
- **Generic on-screen targets from the start.** The picker and the settled target already know the `screen` kind in Task 2, with an empty list until Task 6, so the mode buttons and later thumbnails or cards need no change to picking or pinch code.

## 14. Risks and later improvements

- **Task 4 is still the largest.** It touches `SceneViewport`, a new hook and App. The cursor ring and badge drawing were moved to Task 5 for that reason; Task 4 exposes the hand state through the overlay's data attributes only.
- **Tuning time is not a task.** The constants are guesses until they meet the user's webcam. Plan about half a day after Task 5 for the manual list and constant changes.
- **Speed on the user's laptop.** MediaPipe on the GPU now runs whenever the camera is on, next to the WebGL scene. If the rate falls below `MIN_CONTROL_FPS`, hand control locks itself (by design), and the demo would show the 「太慢」 line. Check it early: after Task 2 the skeleton is visible on the real webcam, and the try-on stats line already shows the tracking rate.
- **E2E timing under SwiftShader.** The One Euro filter and the 150 ms settle add latency to every scripted step; tests poll attributes instead of sleeping, but the new spec may take a minute or two.
- **Later: lazy pose loading** (§3.1), to make hand control ready about 4 s sooner on each camera start.
