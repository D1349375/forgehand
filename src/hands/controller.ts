import { HAND_LOST_MS, ON_TRACKING_LOSS, TRACKING_LOSS_MS, TWO_HAND_MIN_SPAN_PX } from './constants';
import { decidePinch } from './decide';
import type { Gate } from './gate';
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
}

interface Joiner {
  slot: HandSlot;
  gesture: TwoHandGesture;
  target: Target;
  startSpan: number;
  span: number;
  /** The pair angle at the previous frame, for `angleDelta`. */
  lastAngle: number;
  /** Degrees accumulated since the joiner engaged. */
  angle: number;
  /** The explode amount when the joiner engaged (zero for the other gestures). */
  startValue: number;
}

interface Session {
  owner: HandSlot;
  kind: OwnerGesture;
  /** The scene's session; null for a press. */
  scene: GrabSession | OrbitSession | null;
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
  };
}

/**
 * The gesture core for one or two hands (design §5.5), with no DOM and no Three.js. It turns hand
 * samples into calls on a port. At most one gesture runs; the first hand to engage owns it, and the
 * other hand can only join through the join rule, otherwise its pinch is inert until released.
 */
export class HandController {
  readonly stats: HandStats = createStats();
  onCancelled?: (reason: CancelReason) => void;

  private readonly join: JoinRule;
  private tracks: [Track, Track] = [newTrack(0), newTrack(0)];
  private session: Session | null = null;
  /** A pinch that owns nothing: it may not act until it is released. `inert`: because another hand's gesture runs. */
  private blocked: [Blocked, Blocked] = [null, null];
  private gate: Gate = { level: 'full', reason: null };
  private objectCount = 0;
  private signature = '';
  /** Whether each slot had a hand in the latest frame. */
  private present: [boolean, boolean] = [false, false];

  constructor(private readonly port: HandPort, options: { join?: JoinRule } = {}) {
    this.join = options.join ?? joinGesture;
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
    const endsAll = (session.kind === 'grab' && gate.level !== 'full') || (session.kind !== 'grab' && gate.level === 'off');
    if (endsAll) {
      if (session.kind === 'grab') {
        this.cancelSession('gate');
      } else {
        this.finishQuietly();
      }
      this.blocked[session.owner] = 'passive';
      if (joinerSlot !== null) this.blocked[joinerSlot] = 'passive';
      return;
    }
    const joiner = session.joiner;
    if (joiner && this.join(session.kind, { kind: 'pinch', target: joiner.target }, this.gate) !== joiner.gesture) {
      this.leaveJoiner();
      this.blocked[joiner.slot] = 'passive';
    }
  }

  /** Cancel and forget: 手勢 off, camera off, page hidden. Does not report through `onCancelled`. */
  reset(): void {
    const session = this.session;
    if (session?.scene) {
      if (session.kind === 'grab') {
        (session.scene as GrabSession).cancel();
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
    for (const slot of [0, 1] as const) {
      const track = this.tracks[slot];
      const index = assigned[slot];
      const sample = index === null || index === undefined ? null : hands[index] ?? null;
      this.present[slot] = sample !== null;
      if (!sample) {
        const step = pinchStep(track.pinch, { kind: 'none' }, now);
        track.pinch = step.state;
        events[slot] = step.events;
        track.pinchM = null;
        continue;
      }
      if (this.expired(track, now)) this.forget(track, now);
      track.cursor = track.cursorFilter.filter(sample.cursor, now);
      track.palm = track.palmFilter.filter(sample.palm, now);
      track.points = sample.points;
      track.pinchM = sample.pinchM;
      if (!track.pinch.engaged) track.settle = settleStep(track.settle, this.port.pick(track.cursor), now);
      const input: PinchInput = { kind: 'hand', cursor: track.cursor, pinchM: sample.pinchM };
      const step = pinchStep(track.pinch, input, now);
      track.pinch = step.state;
      events[slot] = step.events;
    }
    for (const slot of [0, 1] as const) this.handleEvents(slot, events[slot], now);
    this.follow(now);
    return this.build(now);
  }

  /** Time passing without a tracking frame: applies time-outs. Returns null when what the overlay shows has not changed. */
  tick(now: number): OverlayFrame | null {
    for (const slot of [0, 1] as const) {
      const track = this.tracks[slot];
      const step = pinchStep(track.pinch, { kind: 'tick' }, now);
      track.pinch = step.state;
      this.handleEvents(slot, step.events, now);
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
    return seen !== null && now - seen >= (track.pinch.engaged ? TRACKING_LOSS_MS : HAND_LOST_MS);
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
        const owner = this.tracks[session.owner].cursor;
        session.joiner = {
          slot, gesture, target: settled,
          startSpan: pairSpan(owner, track.cursor), span: pairSpan(owner, track.cursor),
          lastAngle: pairAngle(owner, track.cursor), angle: 0, startValue: 0,
        };
        recordJoin(this.stats, gesture);
        return;
      }
    }
    this.blocked[slot] = 'inert';
    recordInert(this.stats);
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

  /** Ends an orbit or a press without a notice. */
  private finishQuietly(): void {
    const session = this.session;
    if (!session) return;
    if (session.kind === 'orbit') (session.scene as OrbitSession).end();
    else if (session.kind === 'grab') (session.scene as GrabSession).cancel();
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
    session.ref = this.tracks[session.owner].cursor;
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
        if (!session.joiner && owner.pinch.moved && session.scene) {
          const offset = { x: owner.cursor.x - session.ref.x, y: owner.cursor.y - session.ref.y };
          if (session.kind === 'grab') {
            if (!(session.scene as GrabSession).preview(offset)) {
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
      const from = this.tracks[this.session.owner].cursor;
      const to = this.tracks[joined.slot].cursor;
      const span = pairSpan(from, to);
      const angle = pairAngle(from, to);
      if (span >= TWO_HAND_MIN_SPAN_PX && joined.span >= TWO_HAND_MIN_SPAN_PX) joined.angle += angleDelta(joined.lastAngle, angle);
      joined.lastAngle = angle;
      joined.span = span;
    }
    for (const slot of [0, 1] as const) {
      const track = this.tracks[slot];
      recordHand(this.stats, slot, { pinchM: this.present[slot] ? track.pinchM : null, pinching: track.pinch.engaged, target: targetKey(track.settle.settled) });
    }
  }

  // ---- the overlay frame -------------------------------------------------------------------------------------------------

  private visible(track: Track, now: number): boolean {
    return track.pinch.handSeenAt !== null && now - track.pinch.handSeenAt < HAND_LOST_MS;
  }

  private gestureKind(): GestureKind {
    const session = this.session;
    if (!session) return 'none';
    return session.joiner ? session.joiner.gesture : session.kind;
  }

  private stateOf(slot: HandSlot, track: Track): { state: HandState; target: Target; inert: boolean } {
    const settled = track.settle.settled;
    const session = this.session;
    if (session?.owner === slot) {
      if (session.kind === 'grab') return { state: 'grab', target: session.target, inert: false };
      if (session.kind === 'orbit') return { state: 'orbit', target: settled, inert: false };
      if (session.kind === 'hold') return { state: 'hold', target: settled, inert: false };
      return { state: 'hover', target: settled, inert: false };
    }
    if (session?.joiner?.slot === slot) return { state: 'join', target: settled, inert: false };
    const blocked = this.blocked[slot];
    if (blocked) return { state: 'locked', target: settled, inert: blocked === 'inert' };
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
      const { state, target, inert } = this.stateOf(slot, track);
      views.push({
        slot, state, targetKey: targetKey(track.settle.settled), points: track.points, cursor: track.cursor, palm: track.palm,
        badge: badgeText({ state, target, gesture, value: null, inert }),
      });
    }
    const session = this.session;
    const link = session?.joiner ? { from: { ...this.tracks[session.owner].cursor }, to: { ...this.tracks[session.joiner.slot].cursor } } : null;
    const frame: OverlayFrame = { hands: views, gesture, link, arc: null };
    if (remember) this.signature = this.signatureOf(frame);
    return frame;
  }

  private signatureOf(frame: OverlayFrame): string {
    return JSON.stringify([frame.gesture, frame.link !== null, frame.hands.map(view => [view.slot, view.state, view.targetKey, view.badge])]);
  }
}
