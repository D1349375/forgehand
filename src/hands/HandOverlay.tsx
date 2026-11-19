import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { drawHand } from './skeleton';
import { overlayStyle } from './style';
import type { HandView } from './types';

export interface HandOverlayHandle {
  /** Clears and redraws the skeleton, and writes the data attributes that changed. */
  draw(view: HandView): void;
  /** Clears the canvas and sets the state to `none`. */
  clear(): void;
}

/**
 * A 2D canvas over the camera view. It never takes pointer events, is not
 * CSS-mirrored (the landmarks are already in display space), and is redrawn
 * from the tracking callback, so a frame causes no React render.
 */
export const HandOverlay = forwardRef<HandOverlayHandle>(function HandOverlay(_props, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const written = useRef({ state: 'none', mode: 'translate', target: '' });

  useEffect(() => {
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
    function setAttributes(state: string, mode: string, target: string) {
      const element = canvas.current;
      if (!element) return;
      const last = written.current;
      if (last.state !== state) { element.dataset.handState = state; last.state = state; }
      if (last.mode !== mode) { element.dataset.handMode = mode; last.mode = mode; }
      if (last.target !== target) { element.dataset.handTarget = target; last.target = target; }
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
      draw(view) {
        setAttributes(view.state, view.mode, view.targetKey);
        const surface = wipe();
        if (!surface || view.state === 'none') return;
        const { element, ctx } = surface;
        // Points are client pixels: put the canvas origin at the canvas box and scale to the backing store.
        const box = element.getBoundingClientRect();
        const ratio = box.width > 0 ? element.width / box.width : 1;
        ctx.setTransform(ratio, 0, 0, ratio, -box.left * ratio, -box.top * ratio);
        drawHand(ctx, view.points, overlayStyle(view));
      },
      clear() {
        wipe();
        setAttributes('none', written.current.mode, '');
      },
    };
  }, []);

  return <canvas ref={canvas} className="hand-overlay" data-testid="hand-overlay" aria-hidden="true"
    data-hand-state="none" data-hand-mode="translate" data-hand-target="" />;
});
