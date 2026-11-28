import { describe, expect, it } from 'vitest';
import {
  FIT_MIN_FPS, FIT_RECOVER_FPS, FIT_RECOVER_MS, MEASURE_BURST_MS, SEGMENT_CPU_INTERVAL_MS, SEGMENT_INTERVAL_MS, SEGMENT_MAX_INTERVAL_MS,
} from '../../shared/fit-constants';
import { SPEED_HOLD_MS } from '../../src/hands/constants';
import { initialCadence, segmentPlan, type CadenceInput, type CadenceState } from '../../src/fit/cadence';

/** Runs the plan at `stepMs` intervals and returns the times it asked at, and the state at the end. */
function run(options: { from: number; to: number; stepMs?: number; rateFps: number | null; delegate?: 'GPU' | 'CPU' | null; measuringSince?: number | null; state?: CadenceState }) {
  let state = options.state ?? initialCadence();
  const asked: number[] = [];
  let last = segmentPlan(state, { now: options.from, measuringSince: null, rateFps: null, delegate: 'GPU' });
  for (let now = options.from; now <= options.to; now += options.stepMs ?? 33) {
    const input: CadenceInput = { now, measuringSince: options.measuringSince ?? null, rateFps: options.rateFps, delegate: options.delegate === undefined ? 'GPU' : options.delegate };
    last = segmentPlan(state, input);
    state = last.next;
    if (last.ask) asked.push(now);
  }
  return { asked, state, last };
}

describe('segmentPlan (design 4.3)', () => {
  it('asks right away, then every SEGMENT_INTERVAL_MS', () => {
    const { asked } = run({ from: 0, to: 2000, rateFps: 9 });
    expect(asked[0]).toBe(0);
    expect(asked.slice(1).every((time, i) => time - asked[i]! >= SEGMENT_INTERVAL_MS && time - asked[i]! < SEGMENT_INTERVAL_MS + 33)).toBe(true);
    expect(asked.length).toBeGreaterThanOrEqual(5);
    expect(asked.length).toBeLessThanOrEqual(7);
  });
  it('counts from the last ask, not from the last mask', () => {
    const state: CadenceState = { ...initialCadence(), lastAskAt: 1000 };
    expect(segmentPlan(state, { now: 1200, measuringSince: null, rateFps: 9, delegate: 'GPU' }).ask).toBe(false);
    expect(segmentPlan(state, { now: 1000 + SEGMENT_INTERVAL_MS, measuringSince: null, rateFps: 9, delegate: 'GPU' }).ask).toBe(true);
  });
  it('asks on every frame during a measuring burst and goes back to the interval after MEASURE_BURST_MS', () => {
    const burst = run({ from: 5000, to: 5000 + MEASURE_BURST_MS - 1, rateFps: 4.5, measuringSince: 5000 });
    expect(burst.asked.length).toBe(Math.floor((MEASURE_BURST_MS - 1) / 33) + 1);
    const after = run({ from: 5000 + MEASURE_BURST_MS, to: 5000 + MEASURE_BURST_MS + 1000, rateFps: 9, measuringSince: 5000, state: burst.state });
    expect(after.asked.length).toBeLessThanOrEqual(4);
    expect(after.asked.length).toBeGreaterThanOrEqual(2);
  });
  it('does not back off while a burst makes the rate fall', () => {
    const burst = run({ from: 0, to: MEASURE_BURST_MS - 1, rateFps: 4, measuringSince: 0 });
    expect(burst.state.intervalMs).toBe(SEGMENT_INTERVAL_MS);
    expect(burst.state.lowSince).toBeNull();
  });
  it('doubles the interval after SPEED_HOLD_MS below FIT_MIN_FPS, again after each further SPEED_HOLD_MS, up to the maximum', () => {
    const slow = FIT_MIN_FPS - 0.5;
    expect(run({ from: 0, to: SPEED_HOLD_MS - 50, rateFps: slow }).state.intervalMs).toBe(SEGMENT_INTERVAL_MS);
    expect(run({ from: 0, to: SPEED_HOLD_MS + 50, rateFps: slow }).state.intervalMs).toBe(SEGMENT_INTERVAL_MS * 2);
    expect(run({ from: 0, to: 2 * SPEED_HOLD_MS + 50, rateFps: slow }).state.intervalMs).toBe(SEGMENT_MAX_INTERVAL_MS);
    expect(run({ from: 0, to: 10 * SPEED_HOLD_MS, rateFps: slow }).state.intervalMs).toBe(SEGMENT_MAX_INTERVAL_MS);
  });
  it('asks less often once it has backed off', () => {
    const { asked } = run({ from: 0, to: 20_000, rateFps: 3 });
    const late = asked.filter(time => time > 10_000);
    expect(late.every((time, i) => i === 0 || time - late[i - 1]! >= SEGMENT_MAX_INTERVAL_MS)).toBe(true);
  });
  it('restores the interval after FIT_RECOVER_MS above FIT_RECOVER_FPS, one halving at a time', () => {
    const backedOff: CadenceState = { intervalMs: SEGMENT_MAX_INTERVAL_MS, lastAskAt: 0, lowSince: null, highSince: null };
    const fast = FIT_RECOVER_FPS + 1;
    expect(run({ from: 0, to: FIT_RECOVER_MS - 50, rateFps: fast, state: backedOff }).state.intervalMs).toBe(SEGMENT_MAX_INTERVAL_MS);
    expect(run({ from: 0, to: FIT_RECOVER_MS + 50, rateFps: fast, state: backedOff }).state.intervalMs).toBe(SEGMENT_MAX_INTERVAL_MS / 2);
    expect(run({ from: 0, to: 2 * FIT_RECOVER_MS + 50, rateFps: fast, state: backedOff }).state.intervalMs).toBe(SEGMENT_INTERVAL_MS);
    expect(run({ from: 0, to: 6 * FIT_RECOVER_MS, rateFps: fast, state: backedOff }).state.intervalMs).toBe(SEGMENT_INTERVAL_MS);
  });
  it('keeps the interval between FIT_MIN_FPS and FIT_RECOVER_FPS, and resets the timers', () => {
    const mid = run({ from: 0, to: 20_000, rateFps: (FIT_MIN_FPS + FIT_RECOVER_FPS) / 2 });
    expect(mid.state).toMatchObject({ intervalMs: SEGMENT_INTERVAL_MS, lowSince: null, highSince: null });
    // A dip that ends before SPEED_HOLD_MS does not count.
    const dip = run({ from: 0, to: SPEED_HOLD_MS - 100, rateFps: 2 });
    const recovered = run({ from: SPEED_HOLD_MS, to: SPEED_HOLD_MS + 500, rateFps: 9, state: dip.state });
    expect(recovered.state.intervalMs).toBe(SEGMENT_INTERVAL_MS);
    expect(recovered.state.lowSince).toBeNull();
  });
  it('does nothing about an unknown rate', () => {
    const unknown = run({ from: 0, to: 20_000, rateFps: null });
    expect(unknown.state).toMatchObject({ intervalMs: SEGMENT_INTERVAL_MS, lowSince: null, highSince: null });
  });
  it('never asks more than once a second on the CPU delegate, even while measuring', () => {
    const cpu = run({ from: 0, to: 10_000, rateFps: 9, delegate: 'CPU' });
    expect(cpu.last.intervalMs).toBe(SEGMENT_CPU_INTERVAL_MS);
    expect(cpu.asked.slice(1).every((time, i) => time - cpu.asked[i]! >= SEGMENT_CPU_INTERVAL_MS)).toBe(true);
    const measuring = run({ from: 0, to: MEASURE_BURST_MS - 1, rateFps: 9, delegate: 'CPU', measuringSince: 0 });
    expect(measuring.asked.length).toBeLessThanOrEqual(Math.ceil(MEASURE_BURST_MS / SEGMENT_CPU_INTERVAL_MS));
    expect(segmentPlan(initialCadence(), { now: 0, measuringSince: null, rateFps: 9, delegate: 'GPU' }).intervalMs).toBe(SEGMENT_INTERVAL_MS);
  });
  it('treats an unknown delegate like the GPU', () => {
    expect(run({ from: 0, to: 100, rateFps: 9, delegate: null }).last.intervalMs).toBe(SEGMENT_INTERVAL_MS);
  });
});
