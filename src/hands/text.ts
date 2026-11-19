import type { TrackingDelegate } from '../try-on/arm-pose';
import { CANCEL_NOTICE_MS } from './constants';
import type { Gate } from './gate';
import type { TrackerStatus } from './useHandTracking';

export type HandStatusState = 'hidden' | 'loading' | 'error' | 'slow' | 'agent' | 'exploded' | 'cancelled' | 'hint';

const TEXTS: Readonly<Record<Exclude<HandStatusState, 'hidden'>, string>> = {
  loading: '正在載入手部追蹤模型（第一次約 20–30 秒）。',
  error: '手部追蹤無法使用，仍可用滑鼠操作。',
  slow: '這台電腦的手部追蹤太慢，手勢已停用；骨架仍會顯示，請用滑鼠操作。',
  agent: '代理執行中，手勢只能轉動視角。',
  exploded: '爆炸圖開啟中，手勢只能轉動視角；收回後即可抓取零件。',
  cancelled: '手部追蹤中斷，已取消這次移動。',
  hint: '把手舉到鏡頭前：捏住零件可移動，捏住空白處可轉動視角。',
};

/**
 * The one line under the camera view while the camera and 手勢 are on.
 * Priority: loading, error, slow, (try-on: nothing, its own line shows), agent,
 * exploded, cancelled, then the hint until a hand has been seen.
 * `cancelledAt` is the time of the last cancel by tracking loss, or null.
 */
export function handStatus(input: { tracker: TrackerStatus; gate: Gate; cancelledAt: number | null; now: number; handSeen: boolean }):
  { state: HandStatusState; text: string } {
  const show = (state: Exclude<HandStatusState, 'hidden'>) => ({ state, text: TEXTS[state] });
  // 'off' is the moment between the camera turning on and the worker starting.
  if (input.tracker === 'off' || input.tracker === 'loading') return show('loading');
  if (input.tracker === 'load-error' || input.tracker === 'track-error') return show('error');
  if (input.gate.reason === 'slow') return show('slow');
  if (input.gate.reason === 'try-on') return { state: 'hidden', text: '' };
  if (input.gate.reason === 'agent') return show('agent');
  if (input.gate.reason === 'exploded') return show('exploded');
  if (input.cancelledAt !== null && input.now - input.cancelledAt < CANCEL_NOTICE_MS) return show('cancelled');
  if (!input.handSeen) return show('hint');
  return { state: 'hidden', text: '' };
}

/** The tracking part of the `?hands=debug` line; `pinchMm` has one entry per hand in the latest frame. */
export function trackingDebugLine(input: { delegate: TrackingDelegate | null; fps: number | null; inferenceMs: number | null; hands: number; pinchMm: readonly (number | null)[]; minFps?: number }): string {
  const number = (value: number | null) => (value === null || !Number.isFinite(value) ? '—' : value.toFixed(0));
  const parts = [
    input.delegate ?? '—',
    `每秒 ${number(input.fps)} 幀`,
    `辨識 ${number(input.inferenceMs)} ms`,
    `${input.hands} 隻手`,
  ];
  if (input.pinchMm.length > 0) parts.push(`捏合 ${input.pinchMm.map(number).join('／')} mm`);
  if (input.minFps !== undefined) parts.push(`速度門檻 ${input.minFps} 幀`);
  return parts.join(' · ');
}