import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CARD_STILL_MS, DEFAULT_BAND_OFFSET_MM, STILL_MM_PER_S, STILL_WINDOW_MS } from '../../shared/fit-constants';
import type { HandSource, TrackedFrame } from '../hands/useHandTracking';
import { ArmTracker, type ArmPose, type HandLandmarks, type TrackingDelegate } from '../try-on/arm-pose';
import {
  cardFactor, cardGuide, findCardEdges, guideInsideFrame, type CardDetection, type CardEdges, type CardFactor, type CardGuide, type PixelImage,
} from './card';
import { initialCadence, segmentPlan, type CadenceState } from './cadence';
import { frameToMask, wristCrop, type Point } from './mask';
import {
  forearmFlat, mmPerMaskPx, mmPerPx, MeasureStep, palmFacing, stepOffsets, stepReason, stillness, widthAcross,
  type StepKind, type StepState, type TimedPoint,
} from './measure';
import type { FitStore } from './store';

/**
 * The measuring flow of body fit (design 7): it listens to the shared hand tracking, runs the guided measure steps and the
 * card calibration, and asks the worker for a wrist mask on a cadence. `FitEngine` is plain TypeScript with no React and no
 * DOM (the frozen picture is captured by a function the caller gives it), so unit tests can feed it synthetic frames;
 * `useBodyFit` wraps it for the page. No tracking frame causes a React render: the live view is published at most
 * four times a second (R109).
 */

/** The live view is published at most this often (R109: the numbers update at most four times a second). */
const PUBLISH_INTERVAL_MS = 250;
/** How long the notice of an unstable step stays on screen after the step restarted. */
const UNSTABLE_NOTICE_MS = 4000;
/** How much of a new scale reading enters the smoothed scale (about 0.25 s at 9 frames per second). */
const SCALE_SMOOTHING = 0.25;
/** How far back the wrist history for the stillness check reaches. */
const HISTORY_MS = 2000;

export type CardPhase = 'off' | 'aiming' | 'frozen';

/** What the panel and the guide show while measuring; a new object each time it is published. */
export interface FitLive {
  /** An arm pose was placed on the latest frame. */
  tracking: boolean;
  /** The measure step that is running, if any. */
  step: { kind: StepKind; state: StepState } | null;
  /** A step restarted because its frames disagreed (R23); shown for a few seconds. */
  unstable: boolean;
  card: CardPhase;
  delegate: TrackingDelegate | null;
}
export const IDLE_LIVE: FitLive = { tracking: false, step: null, unstable: false, card: 'off', delegate: null };

/** The guide while the user aims the card: redrawn from the tracking callback without a React render. */
export interface LiveGuideState {
  guide: CardGuide;
  /** 0 to 1: how long the hand has been still inside the frame, over `CARD_STILL_MS`. */
  still: number;
  /** The whole guide lies inside the camera frame. */
  inside: boolean;
  /** Size of the camera frame the guide is in, in pixels. */
  frame: { width: number; height: number };
}
export interface LiveGuide {
  current(): LiveGuideState | null;
  set(state: LiveGuideState | null): void;
  subscribe(listener: (state: LiveGuideState | null) => void): () => void;
}
export function createLiveGuide(): LiveGuide {
  let current: LiveGuideState | null = null;
  const listeners = new Set<(state: LiveGuideState | null) => void>();
  return {
    current: () => current,
    set(state) { current = state; for (const listener of [...listeners]) listener(state); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** The picture frozen for the card calibration (R12): pixels for the edge finder and a bitmap for drawing. Never leaves the page. */
export interface FrozenPicture { pixels: PixelImage; bitmap: ImageBitmap | null }
export interface FrozenCard {
  picture: FrozenPicture;
  guide: CardGuide;
  frame: { width: number; height: number };
  /** The scale estimate on the frozen frame without any calibration, millimetres per frame pixel. */
  mmPerPxEstimate: number;
  detection: CardDetection;
}
export type ConfirmResult = { ok: true; k: number } | { ok: false; reason: Extract<CardFactor, { ok: false }>['reason'] };

export interface FitEngineOptions {
  store: FitStore;
  source: HandSource;
  /** Captures the current camera frame, mirrored like the tracking frame, at the video's size. `null`: not possible now. */
  capture?: () => Promise<FrozenPicture | null>;
  onLive?: (live: FitLive) => void;
  onFrozen?: (card: FrozenCard | null) => void;
  guide?: LiveGuide;
  clock?: () => number;
}

/** The hand of `frame` that belongs to `pose`: the one whose wrist is nearest to the pose's wrist. */
export function poseHand(frame: Pick<TrackedFrame, 'hands' | 'width' | 'height'>, pose: Pick<ArmPose, 'wrist'>): HandLandmarks | null {
  const aspect = frame.width / frame.height;
  let best: HandLandmarks | null = null;
  let bestDistance = Infinity;
  for (const hand of frame.hands) {
    const wrist = hand.points[0];
    if (!wrist) continue;
    const distance = Math.hypot((wrist.x - 0.5) * aspect - pose.wrist.x, 0.5 - wrist.y - pose.wrist.y);
    if (distance < bestDistance) { best = hand; bestDistance = distance; }
  }
  return best;
}

/** The unit direction in frame pixels (y down) from the wrist toward the hand: the arm pose's local y axis, flattened onto the image. */
export function distalOf(pose: Pick<ArmPose, 'orientation'>): Point | null {
  const { x, y, z, w } = pose.orientation;
  const dx = 2 * (x * y - w * z);
  const dy = 1 - 2 * (x * x + z * z);
  const length = Math.hypot(dx, dy);
  return length > 1e-6 ? { x: dx / length, y: -dy / length } : null;
}

interface Placement {
  hand: HandLandmarks;
  pose: ArmPose;
  frame: { width: number; height: number };
  wrist: Point;
  /** From the wrist toward the hand, unit, frame pixels. */
  distal: Point;
  /** Midpoint of the index and little knuckles, frame pixels. */
  knuckles: Point;
  /** Millimetres per frame pixel with the calibration applied; null while the hand gives no scale. */
  scale: number | null;
}

/** The plain-TypeScript core of `useBodyFit`. */
export class FitEngine {
  readonly guide: LiveGuide;
  private readonly store: FitStore;
  private readonly source: HandSource;
  private readonly clock: () => number;
  private readonly arm = new ArmTracker();
  private history: TimedPoint[] = [];
  /** Smoothed time between two tracked frames, so that the stillness window always spans a few frames on a slow machine. */
  private frameGapMs = 0;
  private placement: Placement | null = null;
  private rawScale: number | null = null;
  private cadence: CadenceState = initialCadence();
  private step: MeasureStep | null = null;
  private measuringSince: number | null = null;
  private unstableAt: number | null = null;
  private card: CardPhase = 'off';
  private stillSince: number | null = null;
  private capturing = false;
  private frozen: FrozenCard | null = null;
  private live: FitLive = IDLE_LIVE;
  private lastPublish = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void)[] = [];
  private stopped = false;

  constructor(private readonly options: FitEngineOptions) {
    this.store = options.store;
    this.source = options.source;
    this.guide = options.guide ?? createLiveGuide();
    this.clock = options.clock ?? (() => performance.now());
  }

  start(): void {
    this.stopped = false;
    this.unsubscribe = [
      this.source.subscribe(frame => this.onFrame(frame)),
      this.source.onTick(now => this.onTick(now)),
    ];
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.store.segment.current = null;
    this.closeFrozen();
    this.guide.set(null);
  }

  /** The live view as last computed, without waiting for the publish interval. */
  snapshot(): FitLive { return this.compute(this.clock()); }

  // -------------------------------------------------------------------------
  // Controls

  startStep(kind: StepKind): void {
    this.step = new MeasureStep(kind);
    this.step.start();
    this.measuringSince = null;
    this.unstableAt = null;
    if (this.card !== 'off') this.cancelCard();
    this.emit(true);
  }

  stopStep(): void {
    this.step = null;
    this.measuringSince = null;
    this.unstableAt = null;
    this.emit(true);
  }

  startCard(): void {
    if (this.card !== 'off') return;
    this.step = null;
    this.measuringSince = null;
    this.card = 'aiming';
    this.stillSince = null;
    this.emit(true);
  }

  /** Leaves the calibration unchanged (R13). */
  cancelCard(): void {
    this.closeFrozen();
    this.card = 'off';
    this.stillSince = null;
    this.guide.set(null);
    this.emit(true);
  }

  /** Unfreezes and aims again (R13). */
  retakeCard(): void {
    if (this.card !== 'frozen') return;
    this.closeFrozen();
    this.card = 'aiming';
    this.stillSince = null;
    this.emit(true);
  }

  /** Accepts the edges the user settled on: sets the calibration, or says why it was refused (R15, R16). */
  confirmCard(edges: CardEdges): ConfirmResult {
    const frozen = this.frozen;
    if (!frozen) return { ok: false, reason: 'degenerate' };
    const wrist = this.store.derived().measurement;
    const result = cardFactor(edges, {
      mmPerPxEstimate: frozen.mmPerPxEstimate, frameWidthPx: frozen.frame.width,
      thicknessMm: wrist && !wrist.thicknessAssumed ? wrist.thickness.mm : null,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    this.store.setCalibration({ k: result.k, at: new Date().toISOString(), spreadPct: Math.min(100, result.spreadPct) });
    this.cancelCard();
    return { ok: true, k: result.k };
  }

  // -------------------------------------------------------------------------
  // Tracking

  private onTick(now: number): void {
    if (this.stopped) return;
    const placement = this.placement;
    const crop = placement && placement.scale ? wristCrop(this.cropCentre(placement), placement.distal, placement.scale) : null;
    const before = this.cadence.lastAskAt;
    const plan = segmentPlan(this.cadence, {
      now, measuringSince: this.measuringSince, rateFps: this.source.rate(), delegate: this.source.delegate(),
    });
    // A tick without a crop cannot ask: the interval must not start from it.
    this.cadence = plan.ask && !crop ? { ...plan.next, lastAskAt: before } : plan.next;
    if (crop && (plan.ask || this.store.segment.current)) this.store.segment.current = crop;
  }

  private onFrame(frame: TrackedFrame): void {
    if (this.stopped) return;
    const now = frame.receivedAt;
    // The request stays set until a frame comes back with a luma: a request made on one tick only is dropped while the worker is busy.
    // The interval starts from the answer (requirements, review of Task 2, item 15a).
    if (frame.luma !== undefined) {
      this.store.segment.current = null;
      this.cadence = { ...this.cadence, lastAskAt: now };
    }
    if (frame.mask) this.store.setSegmenter('ready');

    const pose = this.arm.update(frame, frame.capturedAt);
    const hand = pose ? poseHand(frame, pose) : null;
    const distal = pose ? distalOf(pose) : null;
    if (!pose || !hand || !distal) {
      this.placement = null;
      this.stillSince = null;
      this.guide.set(null);
      this.feedStep(frame, null, now);
      this.emit(false);
      return;
    }
    this.store.setSide(pose.side);
    const raw = mmPerPx(hand, frame, 1);
    if (raw !== null) this.rawScale = this.rawScale === null || Math.abs(raw / this.rawScale - 1) > 0.3 ? raw : this.rawScale + SCALE_SMOOTHING * (raw - this.rawScale);
    const wrist0 = hand.points[0]!;
    const wrist = { x: wrist0.x * frame.width, y: wrist0.y * frame.height };
    const index = hand.points[5]!, little = hand.points[17]!;
    const knuckles = { x: (index.x + little.x) / 2 * frame.width, y: (index.y + little.y) / 2 * frame.height };
    const placement: Placement = {
      hand, pose, frame: { width: frame.width, height: frame.height }, wrist, distal, knuckles,
      scale: this.rawScale === null ? null : this.rawScale * this.store.k(),
    };
    this.placement = placement;
    const previous = this.history[this.history.length - 1];
    if (previous) this.frameGapMs = this.frameGapMs ? this.frameGapMs + 0.3 * (frame.capturedAt - previous.t - this.frameGapMs) : frame.capturedAt - previous.t;
    this.history.push({ x: wrist.x, y: wrist.y, t: frame.capturedAt });
    while (this.history.length > 1 && frame.capturedAt - this.history[0]!.t > HISTORY_MS) this.history.shift();

    this.feedStep(frame, placement, now);
    this.feedCard(placement, now);
    this.emit(false);
  }

  /** The window of the wrist speed: STILL_WINDOW_MS, or about three frames when frames come slower than that. */
  private stillWindow(): number {
    return Math.max(STILL_WINDOW_MS, 3 * this.frameGapMs);
  }

  /** Where the crop is centred: the band position (R20, R30), or the knuckles for the passage step. */
  private cropCentre(placement: Placement): Point {
    if (this.step?.kind === 'passage') return placement.knuckles;
    return this.bandPoint(placement);
  }

  private bandPoint(placement: Placement): Point {
    const px = placement.scale ? DEFAULT_BAND_OFFSET_MM / placement.scale : 0;
    return { x: placement.wrist.x - placement.distal.x * px, y: placement.wrist.y - placement.distal.y * px };
  }

  // -------------------------------------------------------------------------
  // The measure step

  private feedStep(frame: TrackedFrame, placement: Placement | null, now: number): void {
    const step = this.step;
    if (!step || step.state.phase === 'idle' || step.state.phase === 'done') return;
    const speed = placement?.scale ? stillness(this.history, placement.scale, this.stillWindow()) : null;
    const base = {
      palmAngleDeg: placement ? palmFacing(placement.hand.world) : null,
      forearmAngleDeg: placement ? forearmFlat(placement.pose) : null,
      speedMmPerS: speed,
    };
    const widths = placement && placement.scale && frame.mask ? this.readWidths(step.kind, frame.mask, placement) : null;
    // A frame without a mask says nothing about the width. It only counts when it shows that the pose is wrong.
    if (!widths && stepReason(step.kind, { ...base, widthsMm: stepOffsets(step.kind).map(() => 0) }) === null) return;
    const state = step.push({ ...base, widthsMm: widths });
    if (state.phase === 'recording' && this.measuringSince === null) this.measuringSince = now;
    if (state.phase === 'unstable') this.unstableAt = now;
    if (state.phase === 'done') {
      this.store.recordStep({ kind: step.kind, slices: state.slices, k: this.store.k() });
      this.step = null;
      this.measuringSince = null;
      this.unstableAt = null;
      this.emit(true);
    }
  }

  /** One width per profile line (R20), or the one line across the knuckles; `null` where no skin was found. */
  private readWidths(kind: StepKind, mask: NonNullable<TrackedFrame['mask']>, placement: Placement): (number | null)[] | null {
    const scale = placement.scale!;
    const centre = kind === 'passage' ? placement.knuckles : this.bandPoint(placement);
    const inMask = frameToMask(mask.crop, centre.x, centre.y, mask.size);
    const perPx = mmPerMaskPx(mask, scale);
    return stepOffsets(kind).map(offsetMm => widthAcross(mask, { mmPerPx: scale, row: inMask.y + offsetMm / perPx, axisX: inMask.x })?.widthMm ?? null);
  }

  // -------------------------------------------------------------------------
  // The card

  private feedCard(placement: Placement, now: number): void {
    if (this.card !== 'aiming' || !placement.scale) {
      if (this.card !== 'frozen') this.guide.set(null);
      return;
    }
    const guide = cardGuide({ centre: this.bandPoint(placement), distal: placement.distal, mmPerPx: placement.scale });
    const inside = guideInsideFrame(guide, placement.frame);
    const speed = stillness(this.history, placement.scale, this.stillWindow());
    const still = speed !== null && speed <= STILL_MM_PER_S;
    if (inside && still) this.stillSince ??= now;
    else this.stillSince = null;
    const fraction = this.stillSince === null ? 0 : Math.min(1, (now - this.stillSince) / CARD_STILL_MS);
    this.guide.set({ guide, still: fraction, inside, frame: placement.frame });
    if (fraction >= 1 && !this.capturing && this.rawScale !== null) void this.freeze(guide, placement.frame, this.rawScale);
  }

  private async freeze(guide: CardGuide, frame: { width: number; height: number }, mmPerPxEstimate: number): Promise<void> {
    const capture = this.options.capture;
    if (!capture) return;
    this.capturing = true;
    try {
      const picture = await capture();
      if (!picture || this.stopped || this.card !== 'aiming') { picture?.bitmap?.close(); return; }
      this.frozen = { picture, guide, frame, mmPerPxEstimate, detection: findCardEdges(picture.pixels, guide) };
      this.card = 'frozen';
      this.guide.set(null);
      this.options.onFrozen?.(this.frozen);
      this.emit(true);
    } finally {
      this.capturing = false;
      this.stillSince = null;
    }
  }

  private closeFrozen(): void {
    if (!this.frozen) return;
    this.frozen.picture.bitmap?.close();
    this.frozen = null;
    this.options.onFrozen?.(null);
  }

  // -------------------------------------------------------------------------
  // Publishing

  private compute(now: number): FitLive {
    return {
      tracking: this.placement !== null,
      step: this.step ? { kind: this.step.kind, state: this.step.state } : null,
      unstable: this.unstableAt !== null && now - this.unstableAt < UNSTABLE_NOTICE_MS,
      card: this.card,
      delegate: this.source.delegate(),
    };
  }

  /** Publishes at most every `PUBLISH_INTERVAL_MS`; `force` publishes now (a state change the user is waiting for). A later call catches up. */
  private emit(force: boolean): void {
    if (this.stopped || !this.options.onLive) return;
    const now = this.clock();
    if (!force && now - this.lastPublish < PUBLISH_INTERVAL_MS) {
      if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; this.emit(true); }, PUBLISH_INTERVAL_MS);
      return;
    }
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.lastPublish = now;
    const next = this.compute(now);
    if (!sameLive(this.live, next)) {
      this.live = next;
      this.options.onLive(next);
    }
  }
}

function sameLive(a: FitLive, b: FitLive): boolean {
  if (a.tracking !== b.tracking || a.unstable !== b.unstable || a.card !== b.card || a.delegate !== b.delegate) return false;
  if (a.step === null || b.step === null) return a.step === b.step;
  if (a.step.kind !== b.step.kind || a.step.state.phase !== b.step.state.phase) return false;
  const sa = a.step.state, sb = b.step.state;
  const reasonA = sa.phase === 'waiting' ? sa.reason : '';
  const reasonB = sb.phase === 'waiting' ? sb.reason : '';
  const acceptedA = 'accepted' in sa ? sa.accepted : -1;
  const acceptedB = 'accepted' in sb ? sb.accepted : -1;
  return reasonA === reasonB && acceptedA === acceptedB;
}

/** Copies the current video frame, mirrored like the tracking frame, at the video's size: pixels for the edge finder and a bitmap to draw. */
export async function captureVideoFrame(video: HTMLVideoElement | null, mirrored: boolean): Promise<FrozenPicture | null> {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const { videoWidth: width, videoHeight: height } = video;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.setTransform(mirrored ? -1 : 1, 0, 0, 1, mirrored ? width : 0, 0);
  context.drawImage(video, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const bitmap = await createImageBitmap(canvas);
  return { pixels, bitmap };
}

export interface BodyFitApi {
  live: FitLive;
  frozen: FrozenCard | null;
  guide: LiveGuide;
  startStep(kind: StepKind): void;
  stopStep(): void;
  startCard(): void;
  cancelCard(): void;
  retakeCard(): void;
  confirmCard(edges: CardEdges): ConfirmResult;
}

/**
 * Runs the measuring flow while `enabled` (a fit session on a running camera). `source` is the shared hand tracking; the hook
 * sets `store.segment`, which `useHandTracking` reads on every frame.
 */
export function useBodyFit(options: {
  store: FitStore;
  source: HandSource;
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  mirrored: boolean;
}): BodyFitApi {
  const { store, source, enabled, videoRef } = options;
  const [live, setLive] = useState<FitLive>(IDLE_LIVE);
  const [frozen, setFrozen] = useState<FrozenCard | null>(null);
  const guide = useMemo(createLiveGuide, []);
  const engine = useRef<FitEngine | null>(null);
  const mirrored = useRef(options.mirrored);
  mirrored.current = options.mirrored;

  useEffect(() => {
    if (!enabled) return;
    const next = new FitEngine({
      store, source, guide,
      capture: () => captureVideoFrame(videoRef.current, mirrored.current),
      onLive: setLive, onFrozen: setFrozen,
    });
    engine.current = next;
    next.start();
    return () => {
      next.stop();
      engine.current = null;
      setLive(IDLE_LIVE);
      setFrozen(null);
    };
  }, [enabled, store, source, guide, videoRef]);

  return useMemo<BodyFitApi>(() => ({
    live, frozen, guide,
    startStep: kind => engine.current?.startStep(kind),
    stopStep: () => engine.current?.stopStep(),
    startCard: () => engine.current?.startCard(),
    cancelCard: () => engine.current?.cancelCard(),
    retakeCard: () => engine.current?.retakeCard(),
    confirmCard: edges => engine.current?.confirmCard(edges) ?? { ok: false, reason: 'degenerate' },
  }), [live, frozen, guide]);
}
