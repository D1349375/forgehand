import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SceneHandle } from '../scene/SceneViewport';
import { CANCEL_NOTICE_MS } from './constants';
import { HandController, type HandPort } from './controller';
import type { Gate } from './gate';
import type { HandOverlayHandle } from './HandOverlay';
import { handSample } from './mapping';
import { dedupeHands } from './slots';
import type { HandStats } from './stats';
import { pickTarget } from './targets';
import { handStatus, type HandStatusState } from './text';
import { EMPTY_TARGET, type GestureKind, type HandSample, type Target } from './types';
import type { HandSource, TrackerStatus } from './useHandTracking';

/** The numbers the `?hands=debug` panel reads without a React render. */
export interface HandDebugNumbers {
  /** Hands in the latest frame, after removing duplicates. */
  hands: number;
  /** Thumb-index distance in millimetres per hand, null without world landmarks. */
  pinchMm: (number | null)[];
  /** The running gesture. */
  gesture: GestureKind;
  /** The controller's counters (the same object for the life of the hook). */
  stats: HandStats | null;
}

const IDLE_DEBUG: HandDebugNumbers = { hands: 0, pinchMm: [], gesture: 'none', stats: null };

/**
 * Turns tracking frames into the hand overlay and into gestures. A `HandController` runs inside the
 * tracking callbacks, so a frame causes no React render; React state holds only the status line
 * (the tracker, the gate, "a hand has been seen" and the cancel notice).
 */
export function useHandControl(input: {
  source: HandSource;
  tracker: TrackerStatus;
  /** The camera is on and 手勢 is on. */
  enabled: boolean;
  gate: Gate;
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HandOverlayHandle | null>;
  /** Objects in the workspace: with none, a pinch has nothing to act on. */
  objectCount: number;
  sceneRef: RefObject<SceneHandle | null>;
  /** `?hands-loss-ms`: replaces both hand-loss windows; null keeps the defaults. */
  lossMs?: number | null;
  /** A pinch on a part selects it, as a click does (activating its object when needed). */
  onPick: (objectId: string, partId: string) => void;
}): { status: { state: HandStatusState; text: string }; debug: RefObject<HandDebugNumbers> } {
  const { source, tracker, enabled, gate, videoRef, overlayRef, objectCount, sceneRef, lossMs = null } = input;
  const [handSeen, setHandSeen] = useState(false);
  /** When hand tracking was lost during a drag and the part went back; the notice shows for CANCEL_NOTICE_MS. */
  const [cancelledAt, setCancelledAt] = useState<number | null>(null);
  const debug = useRef<HandDebugNumbers>({ ...IDLE_DEBUG });
  const onPick = useRef(input.onPick);
  onPick.current = input.onPick;
  const controller = useMemo(() => {
    const port: HandPort = {
      pick(point): Target {
        return pickTarget(point, [], at => {
          const hit = sceneRef.current?.hitTest(at);
          return hit ? { kind: 'part', objectId: hit.objectId, partId: hit.partId, label: hit.name, hit: hit.hit } : EMPTY_TARGET;
        });
      },
      select: (objectId, partId) => onPick.current(objectId, partId),
      beginGrab: (objectId, partId, hit) => sceneRef.current?.beginPartGrab(objectId, partId, hit) ?? null,
      beginOrbit: () => sceneRef.current?.beginOrbit() ?? null,
      press: () => { /* no on-screen targets yet */ },
    };
    return new HandController(port, { lossMs });
  }, [sceneRef, lossMs]);
  useEffect(() => { controller.setGate(gate); }, [controller, gate.level, gate.reason]);
  useEffect(() => { controller.setObjectCount(objectCount); }, [controller, objectCount]);
  useEffect(() => {
    if (!enabled) return;
    let noticeTimer = 0;
    controller.onCancelled = reason => {
      if (reason !== 'loss') return;
      setCancelledAt(performance.now());
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => setCancelledAt(null), CANCEL_NOTICE_MS);
    };
    let seen = false;
    const unsubscribeFrames = source.subscribe(frame => {
      const video = videoRef.current;
      if (!video) return;
      const rect = video.getBoundingClientRect();
      const size = { width: frame.width, height: frame.height };
      const samples: HandSample[] = [];
      for (const hand of frame.hands) {
        const sample = handSample(hand, rect, size);
        if (sample) samples.push(sample);
      }
      const hands = dedupeHands(samples);
      if (hands.length > 0 && !seen) { seen = true; setHandSeen(true); }
      const overlay = controller.frame(samples, frame.receivedAt);
      debug.current = {
        hands: hands.length, pinchMm: hands.map(sample => (sample.pinchM === null ? null : sample.pinchM * 1000)), gesture: overlay.gesture, stats: controller.stats,
      };
      overlayRef.current?.draw(overlay);
    });
    // Video frames without a result: time-outs (a lost hand, a lost pinch) apply here.
    const unsubscribeTicks = source.onTick(now => {
      const overlay = controller.tick(now);
      if (!overlay) return;
      if (overlay.hands.length === 0) debug.current = { ...debug.current, hands: 0, pinchMm: [], gesture: overlay.gesture };
      else debug.current = { ...debug.current, gesture: overlay.gesture };
      overlayRef.current?.draw(overlay);
    });
    // A hidden page gets no frames: put a running drag back instead of leaving it half done.
    const hidden = () => { if (document.visibilityState === 'hidden') controller.reset(); };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      unsubscribeFrames();
      unsubscribeTicks();
      document.removeEventListener('visibilitychange', hidden);
      window.clearTimeout(noticeTimer);
      controller.onCancelled = undefined;
      controller.reset();
      debug.current = { ...IDLE_DEBUG, stats: controller.stats };
      overlayRef.current?.clear();
      setHandSeen(false);
      setCancelledAt(null);
    };
  }, [controller, source, enabled, videoRef, overlayRef]);
  const status = useMemo(
    () => (enabled
      ? handStatus({ tracker, gate: { level: gate.level, reason: gate.reason }, cancelledAt, now: cancelledAt ?? 0, handSeen })
      : { state: 'hidden' as const, text: '' }),
    [enabled, tracker, gate.level, gate.reason, handSeen, cancelledAt],
  );
  return { status, debug };
}
