import {
  EXPLODE_DEAD_ZONE_PX, EXPLODE_FULL_FRACTION, FIST_ENABLED, FIST_ENGAGE_RATIO, HAND_LOST_MS, ON_TRACKING_LOSS, TRACKING_LOSS_MS, TWO_HAND_MIN_SPAN_PX,
  ZOOM_DEAD_ZONE_PX,
} from './constants';
import { decideFist, decidePinch } from './decide';
import { explodeAmount, zoomRatio } from './drag';
import { fistStep, initialFistState, type FistEvent, type FistState } from './fist';
import { fistAllowed, type Gate } from './gate';
import { joinGesture, type JoinRule, type OwnerGesture, type TwoHandGesture } from './join';
import { OneEuroFilter2D } from './one-euro';
import { angleDelta, pairAngle, pairSpan } from './pair';
import { initialPinchState, pinchStep, type PinchEvent, type PinchInput, type PinchState } from './pinch';
import { assignHands, dedupeHands } from './slots';
import {
  createStats, recordCancel, recordCommit, recordDrag, recordDragGap, recordDragLoss, recordHand, recordInert, recordJoin, type HandStats,
} from './stats';
import { initialSettleState, settleStep, type SettleState } from './targets';
import { badgeText } from './text';
import {
  EMPTY_TARGET, targetKey, type GestureKind, type HandSample, type HandSlot, type HandState, type HandView, type OverlayFrame, type Point, type Target,
  type Vector,
} from './types';

/** What the controller needs from the scene and the app. */
export interface HandPort {
  /** The target under a client point: on-screen targets first, then the scene. */
  pick(point: Point): Target;
  /** Select one part, as a plain click does (making its object active when it is not). */
  select(objectId: string, partId: string): void;
  beginGrab(objectId: string, partId: string, hit: Vector): GrabSession | null;
  beginOrbit(): OrbitSession | null;
  press(id: string): void;
  /** Task 7: make an object active before a fist holds it (App's `activateObject`; a no-op for the active object). */
  activate?(objectId: string): void;
  /** Task 7: start moving a whole object by hand; null when the scene refuses. */
  beginHold?(objectId: string, hit: Vector): HoldSession | null;
  /** Task 7: the active object's explode amount (0..1), read when a pinch joins a hold. */
  explodeAmount?(): number;
  /** Task 7: set the explode amount (0..1), as the 爆炸圖 slider does. */
  setExplode?(amount: number): void;
  /** Task 7: height of the camera view in client pixels, the scale of the explode pull (requirement 93). Without it a pull changes nothing. */
  viewportHeight?(): number;
}

/** Moving a whole object by hand (Task 7): the same shape as a part grab, committed through the object's transform. */
export interface HoldSession {
  /** Shows the object moved by the palm offset since the last re-base; false means the session is no longer valid. */
  preview(offset: Point): boolean;
  /** The current preview becomes the start of the next offsets. */
  rebase(): void;
  commit(): void;
  cancel(): void;
}

export interface GrabSession {
  /** Shows the part moved by the cursor offset since the last re-base; false means the session is no longer valid. */
  preview(offset: Point): boolean;
  /** The current preview becomes the start of the next offsets. */
  rebase(): void;
  commit(): void;
  cancel(): void;
}

export interface OrbitSession {
  preview(offset: Point): void;
  rebase(): void;
  /**
   * Two-hand zoom (requirement 87): the camera's distance to the orbit target becomes its distance when the zoom began,
   * times `ratio`, within the distance limits. The viewing direction does not change.
   */
  zoom?(ratio: number): void;
  end(): void;
}

/** Why a running gesture was cancelled. A cancel the caller asked for (`reset`) does not report. */
export type CancelReason = 'loss' | 'gate' | 'external';

type Blocked = null | 'inert' | 'passive';

interface Track {
  cursorFilter: OneEuroFilter2D;
  palmFilter: OneEuroFilter2D;
  pinch: PinchState;
  settle: SettleState;
  /** Filtered cursor and palm centre of the latest hand frame. */
  cursor: Point;
  palm: Point;
  points: readonly Point[];
  pinchM: number | null;
  /** Curl ratio of the latest hand frame (null without a hand or world landmarks). */
  curl: number | null;
  fist: FistState;
}

interface Joiner {
  slot: HandSlot;
  gesture: TwoHandGesture;
  /** What the joining hand did: a pinch, or (when a rule allows it) a fist. */
  input: 'pinch' | 'fist';
  target: Target;
  startSpan: number;
  span: number;
  /** The pair angle at the previous frame, for `angleDelta`. */
  lastAngle: number;
  /** Degrees accumulated since the joiner engaged. */
  angle: number;
  /** The explode amount when the joiner engaged (zero for the other gestures). */
  startValue: number;
  /** The zoom ratio last sent to the orbit session (1 until the hands leave the dead zone). */
  zoom: number;
  /** The explode amount last sent to the port, rounded to 0.01 (Task 7). */
  explode: number;
}

interface Session {
  owner: HandSlot;
  kind: OwnerGesture;
  /** The scene's session; null for a press. */
  scene: GrabSession | HoldSession | OrbitSession | null;
  pressId?: string;
  /** The target at engage, for the badge. */
  target: Target;
  /** The owner's point the offsets are measured from: the engage point, or the point at the last re-base. */
  ref: Point;
  moved: boolean;
  /** When the owner's hand first went missing during this session. */
  missingSince: number | null;
  joiner: Joiner | null;
}

/** What a running two-hand gesture has measured; the P1 tasks turn it into zoom, explode and rotate. */
export interface TwoHandMeasure {
  gesture: TwoHandGesture;
  startSpan: number;
  span: number;
  /** Accumulated degrees; held while the hands are closer than `TWO_HAND_MIN_SPAN_PX`. */
  angle: number;
  startValue: number;
}

const OTHER: Record<HandSlot, HandSlot> = { 0: 1, 1: 0 };

function newTrack(now: number): Track {
  return {
    cursorFilter: new OneEuroFilter2D(),
    palmFilter: new OneEuroFilter2D(),
    pinch: initialPinchState(),
    settle: initialSettleState(now),
    cursor: { x: 0, y: 0 },
    palm: { x: 0, y: 0 },
    points: [],
    pinchM: null,
    curl: null,
    fist: initialFistState(),
  };
}

/** Sessions that move something in the scene and end with a commit or a cancel. */
const isEditing = (kind: OwnerGesture): boolean => kind === 'grab' || kind === 'hold';

/**
 * The gesture core for one or two hands (design §5.5), with no DOM and no scene (only Three.js math, through `drag.ts`). It turns hand
 * samples into calls on a port. At most one gesture runs; the first hand to engage owns it, and the
 * other hand can only join through the join rule, otherwise its pinch is inert until released.
 */
export class HandController {
  readonly stats: HandStats = createStats();
  onCancelled?: (reason: CancelReason) => void;

  private readonly join: JoinRule;
  /** Replaces HAND_LOST_MS and TRACKING_LOSS_MS when set (`?hands-loss-ms`). */
  private readonly lossMs: number | null;
  /** `false`: no fist state is computed and the pinch works exactly as without fists (requirement 89). */
  private readonly fistEnabled: boolean;
  private tracks: [Track, Track] = [newTrack(0), newTrack(0)];
  private session: Session | null = null;
  /** A pinch that owns nothing: it may not act until it is released. `inert`: because another hand's gesture runs. */
  private blocked: [Blocked, Blocked] = [null, null];
  private gate: Gate = { level: 'full', reason: null };
  private objectCount = 0;
  private signature = '';
  /** Whether each slot had a hand in the latest frame. */
  private present: [boolean, boolean] = [false, false];

  constructor(private readonly port: HandPort, options: { join?: JoinRule; lossMs?: number | null; fistEnabled?: boolean } = {}) {
    this.join = options.join ?? joinGesture;
    this.lossMs = options.lossMs ?? null;
    this.fistEnabled = options.fistEnabled ?? FIST_ENABLED;
  }

  /** The running two-hand gesture's measurements, or null. */
  get twoHand(): TwoHandMeasure | null {
    const joiner = this.session?.joiner;
    return joiner ? { gesture: joiner.gesture, startSpan: joiner.startSpan, span: joiner.span, angle: joiner.angle, startValue: joiner.startValue } : null;
  }

  setObjectCount(count: number): void {
    this.objectCount = count;
  }

  setGate(gate: Gate): void {
    this.gate = { level: gate.level, reason: gate.reason };
    const session = this.session;
    if (!session) return;
    const joinerSlot = session.joiner?.slot ?? null;
    // A grab needs full control; a hold needs the fist to be allowed (full control, or the exploded view); the rest stop only when off.
    const endsAll = session.kind === 'grab' ? gate.level !== 'full' : session.kind === 'hold' ? !fistAllowed(gate) : gate.level === 'off';
    if (endsAll) {
      if (isEditing(session.kind)) {
        this.cancelSession('gate');
      } else {
        this.finishQuietly();
      }
      this.blocked[session.owner] = 'passive';
      if (joinerSlot !== null) this.blocked[joinerSlot] = 'passive';
      return;
    }
    const joiner = session.joiner;
    if (joiner && this.join(session.kind, { kind: joiner.input, target: joiner.target }, this.gate) !== joiner.gesture) {
      this.leaveJoiner();
      this.blocked[joiner.slot] = 'passive';
    }
  }

  /** Cancel and forget: 手勢 off, camera off, page hidden. Does not report through `onCancelled`. */
  reset(): void {
    const session = this.session;
    if (session?.scene) {
      if (isEditing(session.kind)) {
        (session.scene as GrabSession | HoldSession).cancel();
        recordCancel(this.stats);
      } else {
        (session.scene as OrbitSession).end();
      }
    }
    this.session = null;
    this.blocked = [null, null];
    this.tracks = [newTrack(0), newTrack(0)];
    this.present = [false, false];
    this.signature = '';
  }

  /** One tracking frame: the hands found in it (any number), at time `now` in ms. */
  frame(samples: readonly HandSample[], now: number): OverlayFrame {
    const hands = dedupeHands(samples);
    const slots = this.tracks.map(track => this.trackedPalm(track, now));
    const assigned = assignHands(slots, hands);
    const events: PinchEvent[][] = [[], []];
    const fistEvents: FistEvent[][] = [[], []];
    for (const slot of [0, 1] as const) {
      const track = this.tracks[slot];
      const index = assigned[slot];
      const sample = index === null || index === undefined ? null : hands[index] ?? null;
      this.present[slot] = sample !== null;
      if (!sample) {
        const step = pinchStep(track.pinch, { kind: 'none' }, now, this.lossMs ?? undefined);
        track.pinch = step.state;
        events[slot] = step.events;
        track.pinchM = null;
        track.curl = null;
        if (this.fistEnabled) fistEvents[slot] = this.stepFist(track, { kind: 'none' }, now);
        continue;
      }
      if (this.expired(track, now)) this.forget(track, now);
      track.cursor = track.cursorFilter.filter(sample.cursor, now);
      track.palm = track.palmFilter.filter(sample.palm, now);
      track.points = sample.points;
      track.pinchM = sample.pinchM;
      track.curl = sample.curl ?? null;
      if (!track.pinch.engaged) track.settle = settleStep(track.settle, this.port.pick(track.cursor), now);
      // A fist-like frame never counts toward a pinch (requirement 90), and neither does a frame while a fist is engaged
      // (the fingers pass the engage ratio on the way open).
      const fistLike = this.fistEnabled && track.curl !== null && (track.curl < FIST_ENGAGE_RATIO || track.fist.engaged);
      // The pinch midpoint drifts while the fingers curl into a fist, so a fist-like frame leaves the dead zone of an engaged pinch
      // alone: the cursor stays where the pinch engaged, and a pinch that had not moved can still give way to the fist.
      const cursor = fistLike && track.pinch.engaged && track.pinch.engagePoint ? track.pinch.engagePoint : track.cursor;
      const input: PinchInput = { kind: 'hand', cursor, pinchM: fistLike ? null : sample.pinchM };
      const step = pinchStep(track.pinch, input, now, this.lossMs ?? undefined);
      track.pinch = step.state;
      events[slot] = step.events;
      if (this.fistEnabled) {
        fistEvents[slot] = this.stepFist(track, { kind: 'hand', palm: track.palm, curl: track.curl, pinchMoved: track.pinch.engaged && track.pinch.moved }, now);
      }
    }
    for (const slot of [0, 1] as const) {
      this.handleEvents(slot, events[slot], now);
      this.handleFistEvents(slot, fistEvents[slot], now);
    }
    this.follow(now);
    return this.build(now);
  }

  /** Time passing without a tracking frame: applies time-outs. Returns null when what the overlay shows has not changed. */
  tick(now: number): OverlayFrame | null {
    for (const slot of [0, 1] as const) {
      const track = this.tracks[slot];
      const step = pinchStep(track.pinch, { kind: 'tick' }, now, this.lossMs ?? undefined);
      track.pinch = step.state;
      this.handleEvents(slot, step.events, now);
      if (this.fistEnabled) this.handleFistEvents(slot, this.stepFist(track, { kind: 'tick' }, now), now);
    }
    const frame = this.build(now, false);
    const signature = this.signatureOf(frame);
    if (signature === this.signature) return null;
    this.signature = signature;
    return frame;
  }

  // ---- hand frames -------------------------------------------------------------------------------------------------

  private trackedPalm(track: Track, now: number): Point | null {
    return track.pinch.handSeenAt === null || this.expired(track, now) ? null : track.palm;
  }

  private expired(track: Track, now: number): boolean {
    const seen = track.pinch.handSeenAt;
    return seen !== null && now - seen >= (this.lossMs ?? (track.pinch.engaged ? TRACKING_LOSS_MS : HAND_LOST_MS));
  }

  private stepFist(track: Track, input: Parameters<typeof fistStep>[1], now: number): FistEvent[] {
    const step = fistStep(track.fist, input, now, this.lossMs ?? undefined);
    track.fist = step.state;
    return step.events;
  }

  private forget(track: Track, now: number): void {
    track.cursorFilter.reset();
    track.palmFilter.reset();
    track.settle = initialSettleState(now);
  }

  // ---- events --------------------------------------------------------------------------------------------------------

  private handleEvents(slot: HandSlot, events: readonly PinchEvent[], now: number): void {
    for (const event of events) {
      switch (event.type) {
        case 'found': break;
        case 'lost': this.onLost(slot, event.engaged, now); break;
        case 'engage': this.onEngage(slot); break;
        case 'drag-start': this.onDragStart(slot); break;
        case 'release': this.onRelease(slot, event.tap); break;
      }
    }
  }

  private onEngage(slot: HandSlot): void {
    const track = this.tracks[slot];
    const settled = track.settle.settled;
    const session = this.session;
    if (!session) {
      const action = decidePinch(settled, { objectCount: this.objectCount, gate: this.gate });
      switch (action.kind) {
        case 'none':
          this.blocked[slot] = 'passive';
          return;
        case 'press':
          this.session = { owner: slot, kind: 'press', scene: null, pressId: action.id, target: settled, ref: track.cursor, moved: false, missingSince: null, joiner: null };
          return;
        case 'grab': {
          this.port.select(action.objectId, action.partId);
          const scene = this.port.beginGrab(action.objectId, action.partId, action.hit);
          if (!scene) {
            this.blocked[slot] = 'passive';
            return;
          }
          this.session = { owner: slot, kind: 'grab', scene, target: settled, ref: track.cursor, moved: false, missingSince: null, joiner: null };
          return;
        }
        case 'orbit': {
          const scene = this.port.beginOrbit();
          if (!scene) {
            this.blocked[slot] = 'passive';
            return;
          }
          this.session = { owner: slot, kind: 'orbit', scene, target: EMPTY_TARGET, ref: track.cursor, moved: false, missingSince: null, joiner: null };
          return;
        }
      }
    }
    if (session.owner !== slot && !session.joiner) {
      const gesture = this.join(session.kind, { kind: 'pinch', target: settled }, this.gate);
      if (gesture) {
        this.startJoiner(session, slot, gesture, 'pinch', settled);
        return;
      }
    }
    this.blocked[slot] = 'inert';
    recordInert(this.stats);
  }

  /** The other hand joins the owner's gesture: its span, angle and starting value are measured from the owner's point. */
  private startJoiner(session: Session, slot: HandSlot, gesture: TwoHandGesture, input: 'pinch' | 'fist', target: Target): void {
    const owner = this.ownerPoint(session);
    const joinerPoint = input === 'fist' ? this.tracks[slot].palm : this.tracks[slot].cursor;
    const startValue = gesture === 'explode' ? Math.min(1, Math.max(0, this.port.explodeAmount?.() ?? 0)) : 0;
    session.joiner = {
      slot, gesture, input, target,
      startSpan: pairSpan(owner, joinerPoint), span: pairSpan(owner, joinerPoint),
      lastAngle: pairAngle(owner, joinerPoint), angle: 0, startValue, zoom: 1, explode: Math.round(startValue * 100) / 100,
    };
    recordJoin(this.stats, gesture);
  }

  /** The point a gesture's owner is measured at: the palm centre of a fist, the cursor of a pinch. */
  private ownerPoint(session: Session): Point {
    const track = this.tracks[session.owner];
    return session.kind === 'hold' ? track.palm : track.cursor;
  }

  /** The joining hand's point, by what it did. */
  private joinerPoint(joiner: Joiner): Point {
    const track = this.tracks[joiner.slot];
    return joiner.input === 'fist' ? track.palm : track.cursor;
  }

  private onDragStart(slot: HandSlot): void {
    const session = this.session;
    if (!session || session.owner !== slot) return;
    session.moved = true;
    if (session.kind === 'grab') recordDrag(this.stats);
  }

  private onRelease(slot: HandSlot, tap: boolean): void {
    const session = this.session;
    if (session && session.owner === slot) {
      this.finishOnRelease(session, tap);
    } else if (session?.joiner?.slot === slot) {
      this.leaveJoiner();
    }
    this.blocked[slot] = null;
  }

  private onLost(slot: HandSlot, engaged: boolean, now: number): void {
    const track = this.tracks[slot];
    this.forget(track, now);
    this.blocked[slot] = null;
    if (!engaged) return;
    const session = this.session;
    if (session && session.owner === slot) {
      this.noteGap(session, now);
      if (session.kind === 'grab') {
        if (ON_TRACKING_LOSS === 'cancel') this.cancelSession('loss');
        else this.commitSession();
      } else {
        this.finishQuietly();
      }
    } else if (session?.joiner?.slot === slot) {
      this.leaveJoiner();
    }
  }

  // ---- fist events (Task 7) --------------------------------------------------------------------------------------------

  private handleFistEvents(slot: HandSlot, events: readonly FistEvent[], now: number): void {
    for (const event of events) {
      switch (event.type) {
        case 'fist-engage': this.onFistEngage(slot); break;
        case 'fist-move-start': this.onFistMoveStart(slot); break;
        case 'fist-release': this.onFistRelease(slot, event.moved); break;
        case 'fist-lost': this.onFistLost(slot, now); break;
      }
    }
  }

  private onFistEngage(slot: HandSlot): void {
    const track = this.tracks[slot];
    // Closing the hand passes through a short thumb-index distance: this hand's pinch, which has not left its dead zone (the fist
    // never engages otherwise), gives way to the fist with nothing committed (requirement 90).
    if (track.pinch.engaged) this.dropPinch(slot);
    const target = this.port.pick(track.palm);
    const session = this.session;
    if (session) {
      // Another hand's gesture runs: the fist joins it only if the rule has a row for it (none in this spec), else it is inert.
      const gesture = session.owner !== slot && !session.joiner ? this.join(session.kind, { kind: 'fist', target }, this.gate) : null;
      if (gesture) {
        this.startJoiner(session, slot, gesture, 'fist', target);
        return;
      }
      this.blocked[slot] = 'inert';
      recordInert(this.stats);
      return;
    }
    const action = decideFist(target, { objectCount: this.objectCount, gate: this.gate });
    // Nothing to hold: the hand shows a hollow fist until it opens.
    if (action.kind === 'none') return;
    this.port.activate?.(action.objectId);
    const scene = this.port.beginHold?.(action.objectId, action.hit) ?? null;
    if (!scene) return;
    this.session = { owner: slot, kind: 'hold', scene, target, ref: track.palm, moved: false, missingSince: null, joiner: null };
  }

  /** Puts an engaged pinch of this hand away without committing anything: its own session ends, or it leaves the gesture it joined. */
  private dropPinch(slot: HandSlot): void {
    const track = this.tracks[slot];
    const session = this.session;
    if (session?.owner === slot) this.finishQuietly();
    else if (session?.joiner?.slot === slot) this.leaveJoiner();
    track.pinch = { ...track.pinch, engaged: false, streak: 0, engagePoint: null, moved: false };
    this.blocked[slot] = null;
  }

  private onFistMoveStart(slot: HandSlot): void {
    const session = this.session;
    if (!session || session.owner !== slot || session.kind !== 'hold') return;
    session.moved = true;
    recordDrag(this.stats);
  }

  private onFistRelease(slot: HandSlot, moved: boolean): void {
    const session = this.session;
    if (session?.owner === slot && session.kind === 'hold') {
      if (moved || session.moved) this.commitSession();
      else this.cancelQuietly();
    } else if (session?.joiner?.slot === slot) {
      this.leaveJoiner();
    }
    this.blocked[slot] = null;
  }

  private onFistLost(slot: HandSlot, now: number): void {
    this.blocked[slot] = null;
    const session = this.session;
    if (session?.owner === slot && session.kind === 'hold') {
      this.noteGap(session, now);
      if (ON_TRACKING_LOSS === 'cancel') this.cancelSession('loss');
      else this.commitSession();
    } else if (session?.joiner?.slot === slot) {
      this.leaveJoiner();
    }
  }

  // ---- sessions ------------------------------------------------------------------------------------------------------

  private finishOnRelease(session: Session, tap: boolean): void {
    if (session.kind === 'grab') {
      if (!tap) this.commitSession();
      else this.cancelQuietly();
    } else if (session.kind === 'orbit') {
      (session.scene as OrbitSession).end();
      this.endSession(session);
    } else if (session.kind === 'press') {
      const id = session.pressId;
      this.endSession(session);
      if (tap && id !== undefined) this.port.press(id);
    }
  }

  private commitSession(): void {
    const session = this.session;
    if (!session) return;
    (session.scene as GrabSession).commit();
    recordCommit(this.stats);
    this.endSession(session);
  }

  /** A cancel that is a tap or a quiet end, not counted and not reported. */
  private cancelQuietly(): void {
    const session = this.session;
    if (!session) return;
    (session.scene as GrabSession).cancel();
    this.endSession(session);
  }

  private cancelSession(reason: CancelReason): void {
    const session = this.session;
    if (!session) return;
    (session.scene as GrabSession).cancel();
    recordCancel(this.stats);
    this.endSession(session);
    this.onCancelled?.(reason);
  }

  /** Ends an orbit or a press without a notice; a grab or a hold is put back. */
  private finishQuietly(): void {
    const session = this.session;
    if (!session) return;
    if (session.kind === 'orbit') (session.scene as OrbitSession).end();
    else if (isEditing(session.kind)) (session.scene as GrabSession | HoldSession).cancel();
    this.endSession(session);
  }

  /** The owner's gesture is over: a joiner that is still pinching stays inert until it releases. */
  private endSession(session: Session): void {
    const joiner = session.joiner;
    this.session = null;
    if (joiner && this.tracks[joiner.slot].pinch.engaged) {
      this.blocked[joiner.slot] = 'passive';
      recordInert(this.stats);
    }
  }

  /** The joiner leaves; its effect stays. The owner continues from where it is, re-based so nothing jumps. */
  private leaveJoiner(): void {
    const session = this.session;
    if (!session?.joiner) return;
    session.joiner = null;
    session.ref = this.ownerPoint(session);
    session.scene?.rebase();
  }

  private noteGap(session: Session, now: number): void {
    if (session.missingSince === null) return;
    recordDragGap(this.stats, now - session.missingSince);
    session.missingSince = null;
  }

  // ---- following the hands ---------------------------------------------------------------------------------------------

  /** After the events of a frame: owner preview, joiner measurement, gap bookkeeping and the debug numbers. */
  private follow(now: number): void {
    const session = this.session;
    if (session) {
      const owner = this.tracks[session.owner];
      if (!this.present[session.owner]) {
        if (session.missingSince === null && session.kind !== 'press') {
          session.missingSince = now;
          recordDragLoss(this.stats);
        }
      } else {
        this.noteGap(session, now);
        // The owner moves once it has left the dead zone: its pinch for a grab or an orbit, its fist for a hold.
        const moved = session.kind === 'hold' ? owner.fist.moved : owner.pinch.moved;
        if (!session.joiner && moved && session.scene) {
          const point = this.ownerPoint(session);
          const offset = { x: point.x - session.ref.x, y: point.y - session.ref.y };
          if (isEditing(session.kind)) {
            if (!(session.scene as GrabSession | HoldSession).preview(offset)) {
              this.cancelSession('external');
              this.blocked[session.owner] = 'passive';
            }
          } else {
            (session.scene as OrbitSession).preview(offset);
          }
        }
      }
    }
    const joined = this.session?.joiner;
    if (this.session && joined && this.present[joined.slot] && this.present[this.session.owner]) {
      const from = this.ownerPoint(this.session);
      const to = this.joinerPoint(joined);
      const span = pairSpan(from, to);
      const angle = pairAngle(from, to);
      if (span >= TWO_HAND_MIN_SPAN_PX && joined.span >= TWO_HAND_MIN_SPAN_PX) joined.angle += angleDelta(joined.lastAngle, angle);
      joined.lastAngle = angle;
      joined.span = span;
      if (joined.gesture === 'zoom' && this.session.kind === 'orbit') {
        const ratio = zoomRatio({ startSpan: joined.startSpan, span, deadZonePx: ZOOM_DEAD_ZONE_PX, minSpanPx: TWO_HAND_MIN_SPAN_PX });
        if (ratio !== joined.zoom) {
          joined.zoom = ratio;
          (this.session.scene as OrbitSession).zoom?.(ratio);
        }
      }
      if (joined.gesture === 'explode' && this.session.kind === 'hold') {
        const viewportHeight = this.port.viewportHeight?.() ?? 0;
        if (viewportHeight > 0) {
          const amount = explodeAmount({
            start: joined.startValue, startSpan: joined.startSpan, span, deadZonePx: EXPLODE_DEAD_ZONE_PX, viewportHeight, fullFraction: EXPLODE_FULL_FRACTION,
          });
          // The port hears only about a change of the rounded value (requirement 64).
          if (amount !== joined.explode) {
            joined.explode = amount;
            this.port.setExplode?.(amount);
          }
        }
      }
    }
    for (const slot of [0, 1] as const) {
      const track = this.tracks[slot];
      recordHand(this.stats, slot, {
        pinchM: this.present[slot] ? track.pinchM : null, pinching: track.pinch.engaged, target: targetKey(track.settle.settled),
        curl: this.present[slot] ? track.curl : null, fist: track.fist.engaged,
      });
    }
  }

  // ---- the overlay frame -------------------------------------------------------------------------------------------------

  private visible(track: Track, now: number): boolean {
    return track.pinch.handSeenAt !== null && now - track.pinch.handSeenAt < (this.lossMs ?? HAND_LOST_MS);
  }

  private gestureKind(): GestureKind {
    const session = this.session;
    if (!session) return 'none';
    return session.joiner ? session.joiner.gesture : session.kind;
  }

  private stateOf(slot: HandSlot, track: Track): { state: HandState; target: Target; inert: boolean; objectName?: string } {
    const settled = track.settle.settled;
    const session = this.session;
    if (session?.owner === slot) {
      if (session.kind === 'grab') return { state: 'grab', target: session.target, inert: false };
      if (session.kind === 'orbit') return { state: 'orbit', target: settled, inert: false };
      if (session.kind === 'hold') {
        return { state: 'hold', target: settled, inert: false, objectName: session.target.kind === 'part' ? session.target.objectName : undefined };
      }
      return { state: 'hover', target: settled, inert: false };
    }
    if (session?.joiner?.slot === slot) return { state: 'join', target: settled, inert: false };
    const blocked = this.blocked[slot];
    if (blocked) return { state: 'locked', target: settled, inert: blocked === 'inert' };
    // A closed fist that holds nothing; grey and dashed instead when the gate does not allow fists (an agent run).
    if (track.fist.engaged) return { state: fistAllowed(this.gate) ? 'fist' : 'locked', target: settled, inert: false };
    if (this.gate.level === 'off') return { state: 'locked', target: settled, inert: false };
    if (settled.kind === 'screen') return { state: 'hover', target: settled, inert: false };
    if (this.gate.level === 'view-only') return { state: 'locked', target: settled, inert: false };
    return { state: settled.kind === 'part' ? 'hover' : 'tracked', target: settled, inert: false };
  }

  private build(now: number, remember = true): OverlayFrame {
    const gesture = this.gestureKind();
    const views: HandView[] = [];
    for (const slot of [0, 1] as const) {
      const track = this.tracks[slot];
      if (!this.visible(track, now)) continue;
      const { state, target, inert, objectName } = this.stateOf(slot, track);
      // The joining hand of a pull shows the explode percentage (requirement 95).
      const value = state === 'join' && this.session?.joiner?.gesture === 'explode' ? Math.round(this.session.joiner.explode * 100) : null;
      views.push({
        slot, state, targetKey: targetKey(track.settle.settled), points: track.points, cursor: track.cursor, palm: track.palm,
        badge: badgeText({ state, target, gesture, value, objectName, inert }),
      });
    }
    const session = this.session;
    const link = session?.joiner ? { from: { ...this.ownerPoint(session) }, to: { ...this.joinerPoint(session.joiner) } } : null;
    const frame: OverlayFrame = { hands: views, gesture, link, arc: null };
    if (remember) this.signature = this.signatureOf(frame);
    return frame;
  }

  private signatureOf(frame: OverlayFrame): string {
    return JSON.stringify([frame.gesture, frame.link !== null, frame.hands.map(view => [view.slot, view.state, view.targetKey, view.badge])]);
  }
}
