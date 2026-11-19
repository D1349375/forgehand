import { MIN_CONTROL_FPS, SPEED_HOLD_MS } from './constants';

export type GateLevel = 'full' | 'view-only' | 'off';
export type GateReason = 'try-on' | 'slow' | 'agent' | 'exploded';
/** What hand control may do: everything, only turn the view, or nothing. */
export interface Gate { level: GateLevel; reason: GateReason | null }

/** Priority: try-on, then slow (both off), then agent, then exploded (both view-only). The delegate does not matter. */
export function handGate(input: { tryOn: boolean; slow: boolean; agentActive: boolean; exploded: boolean }): Gate {
  if (input.tryOn) return { level: 'off', reason: 'try-on' };
  if (input.slow) return { level: 'off', reason: 'slow' };
  if (input.agentActive) return { level: 'view-only', reason: 'agent' };
  if (input.exploded) return { level: 'view-only', reason: 'exploded' };
  return { level: 'full', reason: null };
}

/** `since`: when the rate first disagreed with `slow`, or null while it agrees. */
export interface SpeedState { slow: boolean; since: number | null }
export function initialSpeedState(): SpeedState {
  return { slow: false, since: null };
}

/**
 * Fed once a second with the tracking rate. Flips to slow after the rate stayed
 * below MIN_CONTROL_FPS for SPEED_HOLD_MS, and back after it stayed at or above
 * it as long. minFps is the threshold, MIN_CONTROL_FPS unless the page URL overrides it. Before the first measurement the rate is unknown and counts as fast.
 */
export function speedStep(state: SpeedState, fps: number, now: number, minFps: number = MIN_CONTROL_FPS): SpeedState {
  const wantsSlow = fps < minFps;
  if (wantsSlow === state.slow) return state.since === null ? state : { slow: state.slow, since: null };
  const since = state.since ?? now;
  if (now - since >= SPEED_HOLD_MS) return { slow: wantsSlow, since: null };
  return { slow: state.slow, since };
}
/**
 * The speed threshold from the page URL: `?hands-min-fps=<number>` overrides
 * MIN_CONTROL_FPS (0 turns the speed gate off). A missing, empty, negative or
 * non-numeric value falls back to the constant. Read once at load.
 */
export function parseMinFps(search: string, fallback: number = MIN_CONTROL_FPS): number {
  const raw = new URLSearchParams(search).get('hands-min-fps');
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}