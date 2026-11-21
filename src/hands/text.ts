import type { TrackingDelegate } from '../try-on/arm-pose';
import { BADGE_NAME_MAX, CANCEL_NOTICE_MS } from './constants';
import type { Gate } from './gate';
import type { HandStats } from './stats';
import type { GestureKind, HandState, Target } from './types';
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
export function trackingDebugLine(input: { delegate: TrackingDelegate | null; fps: number | null; inferenceMs: number | null; hands: number; pinchMm: readonly (number | null)[]; minFps?: number; lossMs?: number | null }): string {
  const number = (value: number | null) => (value === null || !Number.isFinite(value) ? '—' : value.toFixed(0));
  const parts = [
    input.delegate ?? '—',
    `每秒 ${number(input.fps)} 幀`,
    `辨識 ${number(input.inferenceMs)} ms`,
    `${input.hands} 隻手`,
  ];
  if (input.pinchMm.length > 0) parts.push(`捏合 ${input.pinchMm.map(number).join('／')} mm`);
  if (input.minFps !== undefined) parts.push(`速度門檻 ${input.minFps} 幀`);
  if (input.lossMs != null) parts.push(`遺失門檻 ${input.lossMs} ms`);
  return parts.join(' · ');
}
/** Cuts a name longer than `max` code points to its first `max` followed by 「…」. */
export function shortenName(name: string, max: number = BADGE_NAME_MAX): string {
  const characters = Array.from(name);
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : name;
}

/**
 * The short badge next to a hand (requirement 16), so colour is never the only signal.
 * `target` is the settled target, or for a grab the grabbed part. `inert` marks a pinch that
 * may not act because the other hand's gesture runs. `gesture`, `value` and `objectName` are
 * for the rows the P1 tasks add (zoom, hold, explode, rotate); they are not read yet.
 */
export function badgeText(view: { state: HandState; target: Target; gesture: GestureKind; value: number | null; objectName?: string; inert?: boolean }): string {
  const name = view.target.kind === 'empty' ? '' : shortenName(view.target.label);
  switch (view.state) {
    case 'none': return '';
    case 'hover': return name ? `手勢：對準 ${name}` : '手勢：待命';
    case 'grab': return name ? `手勢：已抓取 ${name}` : '手勢：已抓取';
    case 'orbit': return '手勢：轉動視角';
    case 'locked': return view.inert ? '手勢：另一手操作中' : '手勢：暫停';
    case 'join': return view.gesture === 'zoom' ? '手勢：雙手縮放' : '手勢：雙手操作';
    case 'tracked':
    case 'fist':
    case 'hold': return '手勢：待命';
  }
}

/** The whole `?hands=debug` line: tracking numbers, the running gesture, then the controller's counters. */
export function debugLine(stats: HandStats, tracking: Parameters<typeof trackingDebugLine>[0] & { gesture: GestureKind }): string {
  const { gesture, ...rest } = tracking;
  const twoHand = Object.values(stats.twoHand).reduce((sum, count) => sum + count, 0);
  return [
    trackingDebugLine(rest),
    `手勢 ${gesture}`,
    `拖曳 ${stats.drags}／完成 ${stats.commits}／取消 ${stats.cancels}／拖曳中遺失 ${stats.dragLosses}（最長 ${stats.longestDragGapMs} ms）`,
    `雙手 ${twoHand}`,
    `無效捏合 ${stats.inert}`,
  ].join(' · ');
}
