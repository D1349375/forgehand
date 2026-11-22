import { useEffect, useState, type RefObject } from 'react';
import { PINCH_ENGAGE_M, PINCH_RELEASE_M } from './constants';
import { createStats } from './stats';
import { debugLine } from './text';
import type { HandDebugNumbers } from './useHandControl';
import type { HandSource } from './useHandTracking';

/** True when the page URL has `?hands=debug`. */
export function handDebugRequested(search: string): boolean {
  return new URLSearchParams(search).get('hands') === 'debug';
}

/** Tracking numbers for tuning on a real webcam. Mounted only with `?hands=debug`; it polls twice a second and causes no render per frame. */
export function HandDebugPanel({ source, debug, minFps, lossMs = null }: { source: HandSource; debug: RefObject<HandDebugNumbers>; minFps: number; lossMs?: number | null }) {
  const [line, setLine] = useState('');
  useEffect(() => {
    const empty = createStats();
    const read = () => setLine(debugLine(debug.current.stats ?? empty, {
      delegate: source.delegate(), fps: source.rate(), inferenceMs: source.latest()?.inferenceMs ?? null,
      hands: debug.current.hands, pinchMm: debug.current.pinchMm, minFps, lossMs, gesture: debug.current.gesture,
      pinchThresholdsMm: { engage: PINCH_ENGAGE_M * 1000, release: PINCH_RELEASE_M * 1000 },
    }));
    read();
    const timer = window.setInterval(read, 500);
    return () => window.clearInterval(timer);
  }, [source, debug, minFps, lossMs]);
  return <p className="small-muted hand-debug" data-testid="hand-debug">{line}</p>;
}