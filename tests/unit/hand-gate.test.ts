import { describe, expect, it } from 'vitest';
import { CANCEL_NOTICE_MS, MIN_CONTROL_FPS, PINCH_ENGAGE_M, PINCH_RELEASE_M, SPEED_HOLD_MS } from '../../src/hands/constants';
import { handGate, initialSpeedState, parseLossMs, parseMinFps, speedStep, type Gate, type SpeedState } from '../../src/hands/gate';
import { handStatus, trackingDebugLine } from '../../src/hands/text';
import type { TrackerStatus } from '../../src/hands/useHandTracking';

const none = { tryOn: false, slow: false, agentActive: false, exploded: false };

describe('handGate', () => {
  it('is full control when nothing applies', () => {
    expect(handGate(none)).toEqual({ level: 'full', reason: null });
  });
  it('turns hand control off for try-on and for slow tracking', () => {
    expect(handGate({ ...none, tryOn: true })).toEqual({ level: 'off', reason: 'try-on' });
    expect(handGate({ ...none, slow: true })).toEqual({ level: 'off', reason: 'slow' });
  });
  it('leaves only the view for an agent run and for the exploded view', () => {
    expect(handGate({ ...none, agentActive: true })).toEqual({ level: 'view-only', reason: 'agent' });
    expect(handGate({ ...none, exploded: true })).toEqual({ level: 'view-only', reason: 'exploded' });
  });
  it('ranks try-on above slow above agent above exploded', () => {
    expect(handGate({ tryOn: true, slow: true, agentActive: true, exploded: true }).reason).toBe('try-on');
    expect(handGate({ tryOn: false, slow: true, agentActive: true, exploded: true }).reason).toBe('slow');
    expect(handGate({ tryOn: false, slow: false, agentActive: true, exploded: true }).reason).toBe('agent');
  });
});

describe('speedStep', () => {
  const slowFps = MIN_CONTROL_FPS - 1;
  const fastFps = MIN_CONTROL_FPS;
  /** Feeds one reading per second starting at t = 0 and returns the state after each. */
  function run(readings: number[], from: SpeedState = initialSpeedState()) {
    const states: SpeedState[] = [];
    let state = from;
    readings.forEach((fps, index) => { state = speedStep(state, fps, index * 1000); states.push(state); });
    return states;
  }
  it('counts an unknown rate as fast', () => {
    expect(initialSpeedState()).toEqual({ slow: false, since: null });
  });
  it('flips to slow only after the rate stayed below the floor for SPEED_HOLD_MS', () => {
    const states = run([slowFps, slowFps, slowFps]);
    expect(states.map(state => state.slow)).toEqual([false, false, true]);
    expect(SPEED_HOLD_MS).toBe(2000);
  });
  it('does not flip on a short dip, and the dip does not count toward a later one', () => {
    const states = run([slowFps, fastFps, slowFps, slowFps]);
    expect(states.map(state => state.slow)).toEqual([false, false, false, false]);
  });
  it('flips back to fast only after the rate stayed at or above the floor for SPEED_HOLD_MS', () => {
    const slow: SpeedState = { slow: true, since: null };
    const states = run([fastFps, fastFps, fastFps], slow);
    expect(states.map(state => state.slow)).toEqual([true, true, false]);
    expect(run([fastFps, slowFps, fastFps, fastFps], slow).map(state => state.slow)).toEqual([true, true, true, true]);
  });
  it('stays fast at exactly the floor', () => {
    expect(run([fastFps, fastFps, fastFps, fastFps]).every(state => !state.slow)).toBe(true);
  });
});

describe('handStatus', () => {
  const full: Gate = { level: 'full', reason: null };
  const base: { tracker: TrackerStatus; gate: Gate; cancelledAt: number | null; now: number; handSeen: boolean } = { tracker: 'ready', gate: full, cancelledAt: null, now: 10_000, handSeen: false };
  const state = (patch: Partial<typeof base>) => handStatus({ ...base, ...patch }).state;

  it('writes the texts of requirement 43', () => {
    expect(handStatus({ ...base, tracker: 'loading' }).text).toBe('正在載入手部追蹤模型（第一次約 20–30 秒）。');
    expect(handStatus({ ...base, tracker: 'load-error' }).text).toBe('手部追蹤無法使用，仍可用滑鼠操作。');
    expect(handStatus({ ...base, gate: { level: 'off', reason: 'slow' } }).text).toBe('這台電腦的手部追蹤太慢，手勢已停用；骨架仍會顯示，請用滑鼠操作。');
    expect(handStatus({ ...base, gate: { level: 'view-only', reason: 'agent' } }).text).toBe('代理執行中，手勢只能轉動視角。');
    expect(handStatus({ ...base, gate: { level: 'view-only', reason: 'exploded' } }).text).toBe('爆炸圖開啟中，手勢只能轉動視角；收回後即可抓取零件。');
    expect(handStatus({ ...base, cancelledAt: 9_000 }).text).toBe('手部追蹤中斷，已取消這次移動。');
    expect(handStatus(base).text).toBe('把手舉到鏡頭前：捏住零件可移動，捏住空白處可轉動視角。');
  });
  it('maps every tracker status and gate reason to its state', () => {
    expect(state({ tracker: 'off' })).toBe('loading');
    expect(state({ tracker: 'loading' })).toBe('loading');
    expect(state({ tracker: 'load-error' })).toBe('error');
    expect(state({ tracker: 'track-error' })).toBe('error');
    expect(state({ gate: { level: 'off', reason: 'slow' } })).toBe('slow');
    expect(state({ gate: { level: 'view-only', reason: 'agent' } })).toBe('agent');
    expect(state({ gate: { level: 'view-only', reason: 'exploded' } })).toBe('exploded');
    expect(state({})).toBe('hint');
  });
  it('shows nothing during try-on, and nothing once a hand has been seen and nothing applies', () => {
    expect(handStatus({ ...base, gate: { level: 'off', reason: 'try-on' } })).toEqual({ state: 'hidden', text: '' });
    expect(handStatus({ ...base, handSeen: true })).toEqual({ state: 'hidden', text: '' });
  });
  it('follows the priority loading, error, slow, agent, exploded, cancelled, hint', () => {
    const slow: Gate = { level: 'off', reason: 'slow' };
    const agent: Gate = { level: 'view-only', reason: 'agent' };
    const exploded: Gate = { level: 'view-only', reason: 'exploded' };
    expect(state({ tracker: 'loading', gate: slow, cancelledAt: 9_999 })).toBe('loading');
    expect(state({ tracker: 'track-error', gate: slow })).toBe('error');
    expect(state({ gate: slow, cancelledAt: 9_999 })).toBe('slow');
    expect(state({ gate: agent, cancelledAt: 9_999 })).toBe('agent');
    expect(state({ gate: exploded, cancelledAt: 9_999 })).toBe('exploded');
    expect(state({ cancelledAt: 9_999 })).toBe('cancelled');
    expect(state({ cancelledAt: 9_999, handSeen: true })).toBe('cancelled');
  });
  it('shows the cancel notice for CANCEL_NOTICE_MS only', () => {
    expect(state({ cancelledAt: 10_000 - CANCEL_NOTICE_MS + 1, handSeen: true })).toBe('cancelled');
    expect(state({ cancelledAt: 10_000 - CANCEL_NOTICE_MS, handSeen: true })).toBe('hidden');
  });
});

describe('trackingDebugLine', () => {
  it('shows the delegate, the rate, the inference time, the hands and the pinch distance per hand', () => {
    expect(trackingDebugLine({ delegate: 'GPU', fps: 22.4, inferenceMs: 48.2, hands: 2, pinchMm: [24.3, 61] }))
      .toBe('GPU · 每秒 22 幀 · 辨識 48 ms · 2 隻手 · 捏合 24／61 mm');
  });
  it('writes a dash for what is not known yet', () => {
    expect(trackingDebugLine({ delegate: null, fps: null, inferenceMs: null, hands: 0, pinchMm: [] }))
      .toBe('— · 每秒 — 幀 · 辨識 — ms · 0 隻手');
    expect(trackingDebugLine({ delegate: 'CPU', fps: 8, inferenceMs: 120, hands: 1, pinchMm: [null] }))
      .toBe('CPU · 每秒 8 幀 · 辨識 120 ms · 1 隻手 · 捏合 — mm');
  });
  it('shows the loss threshold only when it is overridden', () => {
    const base = { delegate: 'GPU' as const, fps: 22, inferenceMs: 48, hands: 1, pinchMm: [] };
    expect(trackingDebugLine({ ...base, lossMs: 2000 })).toBe('GPU · 每秒 22 幀 · 辨識 48 ms · 1 隻手 · 遺失門檻 2000 ms');
    expect(trackingDebugLine({ ...base, lossMs: null })).not.toContain('遺失門檻');
    expect(trackingDebugLine(base)).not.toContain('遺失門檻');
  });
});

describe('parseMinFps (?hands-min-fps)', () => {
  it('falls back to MIN_CONTROL_FPS when the parameter is missing or empty', () => {
    expect(parseMinFps('')).toBe(MIN_CONTROL_FPS);
    expect(parseMinFps('?hands=debug')).toBe(MIN_CONTROL_FPS);
    expect(parseMinFps('?hands-min-fps=')).toBe(MIN_CONTROL_FPS);
  });
  it('takes a number of 0 or more, including decimals and 0 to turn the gate off', () => {
    expect(parseMinFps('?hands-min-fps=0')).toBe(0);
    expect(parseMinFps('?hands-min-fps=4')).toBe(4);
    expect(parseMinFps('?hands=debug&hands-min-fps=7.5')).toBe(7.5);
    expect(parseMinFps('?hands-min-fps=25')).toBe(25);
  });
  it('falls back for negative, non-numeric or non-finite values', () => {
    for (const bad of ['-1', 'abc', 'NaN', 'Infinity', '1e999', '7fps']) expect(parseMinFps('?hands-min-fps=' + bad)).toBe(MIN_CONTROL_FPS);
  });
  it('uses the given fallback', () => {
    expect(parseMinFps('?hands-min-fps=x', 12)).toBe(12);
  });
});

describe('speedStep with a custom threshold', () => {
  it('never turns slow when the threshold is 0', () => {
    let state = initialSpeedState();
    for (let t = 0; t < 10; t++) state = speedStep(state, 0.5, t * 1000, 0);
    expect(state.slow).toBe(false);
  });
  it('uses the given threshold instead of the constant', () => {
    let state = initialSpeedState();
    for (let t = 0; t < 3; t++) state = speedStep(state, 15, t * 1000, 20);
    expect(state.slow).toBe(true);
    let low = initialSpeedState();
    for (let t = 0; t < 3; t++) low = speedStep(low, 5, t * 1000, 4);
    expect(low.slow).toBe(false);
  });
});

describe('the default speed gate (Task 10)', () => {
  it('is 5 frames per second: the 9-10 fps of the user laptop never locks hand control, 4 fps does', () => {
    expect(MIN_CONTROL_FPS).toBe(5);
    let laptop = initialSpeedState();
    for (let t = 0; t < 6; t++) laptop = speedStep(laptop, 9, t * 1000);
    expect(laptop.slow).toBe(false);
    let slow = initialSpeedState();
    for (let t = 0; t < 6; t++) slow = speedStep(slow, 4, t * 1000);
    expect(slow.slow).toBe(true);
  });
});

describe('trackingDebugLine pinch thresholds (Task 10)', () => {
  it('shows the engage and release thresholds in mm, so the next webcam test can read them', () => {
    expect(trackingDebugLine({ delegate: 'GPU', fps: 9, inferenceMs: 80, hands: 1, pinchMm: [26], pinchThresholdsMm: { engage: PINCH_ENGAGE_M * 1000, release: PINCH_RELEASE_M * 1000 } }))
      .toBe('GPU · 每秒 9 幀 · 辨識 80 ms · 1 隻手 · 捏合 26 mm · 捏合門檻 40／55 mm');
  });
  it('leaves the line as it was without thresholds', () => {
    expect(trackingDebugLine({ delegate: 'GPU', fps: 9, inferenceMs: 80, hands: 0, pinchMm: [] })).not.toContain('門檻');
  });
});

describe('trackingDebugLine threshold', () => {
  it('shows the active speed threshold when given', () => {
    expect(trackingDebugLine({ delegate: 'GPU', fps: 22, inferenceMs: 48, hands: 0, pinchMm: [], minFps: 0 })).toBe('GPU · 每秒 22 幀 · 辨識 48 ms · 0 隻手 · 速度門檻 0 幀');
  });
});
describe('parseLossMs (?hands-loss-ms)', () => {
  it('takes an integer from 100 to 5000', () => {
    expect(parseLossMs('?hands-loss-ms=100')).toBe(100);
    expect(parseLossMs('?hands=debug&hands-loss-ms=2000')).toBe(2000);
    expect(parseLossMs('?hands-loss-ms=5000')).toBe(5000);
  });
  it('returns null outside that range', () => {
    for (const bad of ['99', '5001', '0', '-300', '100000']) expect(parseLossMs('?hands-loss-ms=' + bad)).toBeNull();
  });
  it('returns null for a value that is not an integer', () => {
    for (const bad of ['abc', '', ' ', 'NaN', 'Infinity', '1e3', '300.5', '2000ms', '0x800']) expect(parseLossMs('?hands-loss-ms=' + bad)).toBeNull();
  });
  it('returns null when the parameter is absent', () => {
    expect(parseLossMs('')).toBeNull();
    expect(parseLossMs('?hands=debug')).toBeNull();
    expect(parseLossMs('?hands-min-fps=0')).toBeNull();
  });
});
