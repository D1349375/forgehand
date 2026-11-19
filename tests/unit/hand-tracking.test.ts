import { describe, expect, it } from 'vitest';
import { frameClockStep, RateWindow, trackingPlan, VIDEO_FRAME_STALL_MS, type FrameClock } from '../../src/hands/tracking-plan';
import { clientToNormalized, syntheticHand } from '../fixtures/synthetic-hand';

describe('trackingPlan', () => {
  it('does nothing while the camera is off', () => {
    expect(trackingPlan({ running: false, needed: true, started: false })).toEqual({ worker: 'none', sendFrames: false });
    expect(trackingPlan({ running: false, needed: false, started: false })).toEqual({ worker: 'none', sendFrames: false });
  });
  it('stops a started worker when the camera goes off', () => {
    expect(trackingPlan({ running: false, needed: true, started: true })).toEqual({ worker: 'stop', sendFrames: false });
    expect(trackingPlan({ running: false, needed: false, started: true })).toEqual({ worker: 'stop', sendFrames: false });
  });
  it('starts on the first need while the camera is on', () => {
    expect(trackingPlan({ running: true, needed: true, started: false })).toEqual({ worker: 'start', sendFrames: true });
  });
  it('never starts while nothing needs tracking', () => {
    expect(trackingPlan({ running: true, needed: false, started: false })).toEqual({ worker: 'none', sendFrames: false });
  });
  it('keeps the worker without frames when the need goes away, and resumes with frames', () => {
    expect(trackingPlan({ running: true, needed: false, started: true })).toEqual({ worker: 'keep', sendFrames: false });
    expect(trackingPlan({ running: true, needed: true, started: true })).toEqual({ worker: 'keep', sendFrames: true });
  });
});

describe('RateWindow', () => {
  it('reports frames per second once per completed second', () => {
    const window = new RateWindow();
    const reports: number[] = [];
    for (let t = 0; t <= 3000; t += 50) {
      const fps = window.add(1000 + t);
      if (fps !== null) reports.push(fps);
    }
    expect(reports).toHaveLength(3);
    for (const fps of reports) expect(fps).toBeCloseTo(20, 5);
  });
  it('follows a changed rate and reports nothing inside a window', () => {
    const window = new RateWindow();
    expect(window.add(0)).toBeNull();
    expect(window.add(400)).toBeNull();
    expect(window.add(800)).toBeNull();
    expect(window.add(1000)).toBeCloseTo(3, 5);
    expect(window.add(1500)).toBeNull();
    expect(window.add(2000)).toBeCloseTo(2, 5);
  });
  it('starts over after reset', () => {
    const window = new RateWindow();
    window.add(0);
    window.reset();
    expect(window.add(5000)).toBeNull();
    expect(window.add(6000)).toBeCloseTo(1, 5);
  });
});

describe('syntheticHand', () => {
  const cursor = { x: 0.4, y: 0.6 };
  it('puts the midpoint of landmarks 4 and 8 on the cursor', () => {
    for (const side of ['left', 'right'] as const) {
      const hand = syntheticHand({ cursor, pinchM: 0.07, side });
      expect(hand.points).toHaveLength(21);
      expect(hand.side).toBe(side);
      expect((hand.points[4]!.x + hand.points[8]!.x) / 2).toBeCloseTo(cursor.x, 9);
      expect((hand.points[4]!.y + hand.points[8]!.y) / 2).toBeCloseTo(cursor.y, 9);
    }
  });
  it('gives landmarks 4 and 8 the requested world distance', () => {
    for (const pinchM of [0, 0.02, 0.1]) {
      const { world } = syntheticHand({ cursor, pinchM });
      expect(world).toHaveLength(21);
      expect(Math.hypot(world![4]!.x - world![8]!.x, world![4]!.y - world![8]!.y, world![4]!.z - world![8]!.z)).toBeCloseTo(pinchM, 9);
    }
  });
  it('scales the hand with size and drops world with world: false', () => {
    const small = syntheticHand({ cursor, pinchM: 0.05, size: 0.1 });
    const large = syntheticHand({ cursor, pinchM: 0.05, size: 0.3 });
    const span = (points: readonly { y: number }[]) => Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
    expect(span(large.points)).toBeGreaterThan(span(small.points) * 2);
    expect('world' in syntheticHand({ cursor, pinchM: 0.05, world: false })).toBe(false);
  });
});

describe('clientToNormalized', () => {
  /** The forward cover mapping, written out independently of the helper. */
  function forward(n: { x: number; y: number }, view: { left: number; top: number; width: number; height: number }, video: { width: number; height: number }) {
    const scale = Math.max(view.width / video.width, view.height / video.height);
    return {
      x: view.left + (view.width - video.width * scale) / 2 + n.x * video.width * scale,
      y: view.top + (view.height - video.height * scale) / 2 + n.y * video.height * scale,
    };
  }
  const video = { width: 1280, height: 720 };
  for (const [name, view] of [['wider', { left: 10, top: 20, width: 1600, height: 600 }], ['taller', { left: 30, top: 5, width: 500, height: 900 }]] as const) {
    it(`round-trips on a view ${name} than the video`, () => {
      for (const n of [{ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.75 }, { x: 0.9, y: 0.1 }]) {
        const back = clientToNormalized(forward(n, view, video), view, video);
        expect(back.x).toBeCloseTo(n.x, 9);
        expect(back.y).toBeCloseTo(n.y, 9);
      }
    });
  }
  it('maps the centre of the view to the centre of the frame', () => {
    const view = { left: 100, top: 50, width: 800, height: 400 };
    const mid = clientToNormalized({ x: 500, y: 250 }, view, video);
    expect(mid.x).toBeCloseTo(0.5, 9);
    expect(mid.y).toBeCloseTo(0.5, 9);
  });
});
describe('frameClockStep', () => {
  const step = (clock: FrameClock, lastCallbackAt: number | null, now: number, playing = true) => frameClockStep({ clock, lastCallbackAt, now, playing });
  it('keeps the video-frame clock while callbacks keep arriving', () => {
    expect(step('video-frame', 1000, 1000 + VIDEO_FRAME_STALL_MS - 1)).toBe('video-frame');
    expect(step('video-frame', 1000, 1000)).toBe('video-frame');
  });
  it('switches to animation frames once a playing video has had no callback for the stall time', () => {
    expect(step('video-frame', 1000, 1000 + VIDEO_FRAME_STALL_MS)).toBe('animation-frame');
    expect(step('video-frame', 1000, 9000)).toBe('animation-frame');
  });
  it('never switches while the video is paused or not ready, or before a first baseline', () => {
    expect(step('video-frame', 1000, 9000, false)).toBe('video-frame');
    expect(step('video-frame', null, 9000)).toBe('video-frame');
  });
  it('never switches back', () => {
    expect(step('animation-frame', 9000, 9001)).toBe('animation-frame');
    expect(step('animation-frame', null, 0, false)).toBe('animation-frame');
  });
});