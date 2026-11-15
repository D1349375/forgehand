/** What the tracking hook does with its worker and its frame capture. Pure, so it is tested without React. */
export interface TrackingPlan {
  worker: 'start' | 'keep' | 'stop' | 'none';
  sendFrames: boolean;
}

/**
 * `running`: the camera is on. `needed`: hand control or try-on wants frames.
 * `started`: a worker exists. The worker starts on the first need and lives as
 * long as the camera stays on, so switching hand control off and on does not
 * reload the models; frames are simply not sent while nothing needs them.
 */
export function trackingPlan({ running, needed, started }: { running: boolean; needed: boolean; started: boolean }): TrackingPlan {
  if (!running) return { worker: started ? 'stop' : 'none', sendFrames: false };
  if (started) return { worker: 'keep', sendFrames: needed };
  return needed ? { worker: 'start', sendFrames: true } : { worker: 'none', sendFrames: false };
}

/** Counts frames and reports the frames per second of each completed one-second window. */
export class RateWindow {
  private start: number | null = null;
  private frames = 0;

  /** Records one frame at `now` (ms). Returns the rate when this frame closes a window of at least 1 s, otherwise null. */
  add(now: number): number | null {
    // The frame that opens a window is its time origin and is not counted in it.
    if (this.start === null) { this.start = now; this.frames = 0; return null; }
    this.frames++;
    const span = now - this.start;
    if (span < 1000) return null;
    const fps = (this.frames * 1000) / span;
    this.start = now;
    this.frames = 0;
    return fps;
  }

  reset() {
    this.start = null;
    this.frames = 0;
  }
}
