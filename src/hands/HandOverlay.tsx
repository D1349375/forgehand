import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { drawHand } from './skeleton';
import { overlayStyle } from './style';
import type { OverlayFrame } from './types';

export interface HandOverlayHandle {
  /** Clears and redraws the skeleton of every hand in the frame, and writes the data attributes that changed. */
  draw(frame: OverlayFrame): void;
  /** Clears the canvas and sets every attribute back to its idle value. */
  clear(): void;
}

/** The data attributes the overlay exposes, with their idle values. Written only when one changes. */
const IDLE = { count: '0', state: 'none', target: '', state2: 'none', target2: '', gesture: 'none' };

/**
 * A 2D canvas over the camera view. It never takes pointer events, is not
 * CSS-mirrored (the landmarks are already in display space), and is redrawn
 * from the tracking callback, so a frame causes no React render.
 */
export const HandOverlay = forwardRef<HandOverlayHandle>(function HandOverlay(_props, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const written = useRef({ ...IDLE });  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(element.clientWidth * ratio));
      const height = Math.max(1, Math.round(element.clientHeight * ratio));
      // Assigning the size clears the canvas, so only do it when it changed.
      if (element.width !== width) element.width = width;
      if (element.height !== height) element.height = height;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, []);

  useImperativeHandle(ref, () => {
    function setAttributes(next: typeof IDLE) {
      const element = canvas.current;
      if (!element) return;
      const last = written.current;
      if (last.count !== next.count) { element.dataset.handCount = next.count; last.count = next.count; }
      if (last.state !== next.state) { element.dataset.handState = next.state; last.state = next.state; }
      if (last.target !== next.target) { element.dataset.handTarget = next.target; last.target = next.target; }
      if (last.state2 !== next.state2) { element.dataset.hand2State = next.state2; last.state2 = next.state2; }
      if (last.target2 !== next.target2) { element.dataset.hand2Target = next.target2; last.target2 = next.target2; }
      if (last.gesture !== next.gesture) { element.dataset.gesture = next.gesture; last.gesture = next.gesture; }
    }
    function wipe() {
      const element = canvas.current;
      const ctx = element?.getContext('2d');
      if (!element || !ctx) return null;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, element.width, element.height);
      return { element, ctx };
    }
    return {
      draw(frame) {
        const first = frame.hands.find(hand => hand.slot === 0);
        const second = frame.hands.find(hand => hand.slot === 1);
        setAttributes({
          count: String(frame.hands.length),
          state: first?.state ?? 'none', target: first?.targetKey ?? '',
          state2: second?.state ?? 'none', target2: second?.targetKey ?? '',
          gesture: frame.gesture,
        });
        const surface = wipe();
        if (!surface || frame.hands.length === 0) return;
        const { element, ctx } = surface;
        // Points are client pixels: put the canvas origin at the canvas box and scale to the backing store.
        const box = element.getBoundingClientRect();
        const ratio = box.width > 0 ? element.width / box.width : 1;
        ctx.setTransform(ratio, 0, 0, ratio, -box.left * ratio, -box.top * ratio);
        for (const hand of frame.hands) {
          if (hand.state !== 'none') drawHand(ctx, hand.points, overlayStyle(hand));
        }
      },
      clear() {
        wipe();
        setAttributes(IDLE);
      },
    };
  }, []);

  return <canvas ref={canvas} className="hand-overlay" data-testid="hand-overlay" aria-hidden="true"
    data-hand-count="0" data-hand-state="none" data-hand-target="" data-hand2-state="none" data-hand2-target="" data-gesture="none" />;
});