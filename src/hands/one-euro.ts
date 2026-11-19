import { CURSOR_BETA, CURSOR_D_CUTOFF, CURSOR_MIN_CUTOFF } from './constants';
import type { Point } from './types';

/** Smoothing factor of a first-order low-pass filter with this cutoff (Hz) and time step (s). */
function alpha(cutoffHz: number, dt: number): number {
  return 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dt));
}

/** One axis of the One Euro filter (Casiez, Roussel and Vogel, CHI 2012). */
class OneEuroAxis {
  private value = 0;
  private derivative = 0;
  private raw = 0;
  private started = false;

  constructor(private readonly minCutoff: number, private readonly beta: number, private readonly dCutoff: number) {}

  filter(x: number, dt: number): number {
    if (!this.started) {
      this.started = true;
      this.value = x;
      this.raw = x;
      this.derivative = 0;
      return x;
    }
    const speed = (x - this.raw) / dt;
    this.derivative += alpha(this.dCutoff, dt) * (speed - this.derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    this.value += alpha(cutoff, dt) * (x - this.value);
    this.raw = x;
    return this.value;
  }
}

/**
 * Smooths the cursor: heavy at rest (the cutoff is `minCutoff`) and light when
 * the hand moves fast (the cutoff grows with speed). A pure function of the
 * point sequence and its timestamps.
 */
export class OneEuroFilter2D {
  private x: OneEuroAxis;
  private y: OneEuroAxis;
  private lastTime: number | null = null;
  private last: Point | null = null;

  constructor(private readonly options: { minCutoff?: number; beta?: number; dCutoff?: number } = {}) {
    this.x = this.axis();
    this.y = this.axis();
  }

  /** Filters `point` observed at `timeMs`. The first sample after a reset passes through unchanged. */
  filter(point: Point, timeMs: number): Point {
    if (this.lastTime !== null && this.last && !(timeMs > this.lastTime)) {
      // The same or an earlier timestamp carries no time step to filter with.
      return { ...this.last };
    }
    const dt = this.lastTime === null ? 0 : (timeMs - this.lastTime) / 1000;
    this.lastTime = timeMs;
    this.last = { x: this.x.filter(point.x, dt), y: this.y.filter(point.y, dt) };
    return { ...this.last };
  }

  reset() {
    this.x = this.axis();
    this.y = this.axis();
    this.lastTime = null;
    this.last = null;
  }

  private axis() {
    const { minCutoff = CURSOR_MIN_CUTOFF, beta = CURSOR_BETA, dCutoff = CURSOR_D_CUTOFF } = this.options;
    return new OneEuroAxis(minCutoff, beta, dCutoff);
  }
}
