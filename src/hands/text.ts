import type { TrackingDelegate } from '../try-on/arm-pose';
import { BADGE_NAME_MAX, CANCEL_NOTICE_MS } from './constants';
import type { Gate } from './gate';
import type { HandStats } from './stats';
import type { GestureKind, HandState, Target } from './types';
import type { TrackerStatus } from './useHandTracking';

export type HandStatusState = 'hidden' | 'loading' | 'error' | 'slow' | 'agent' | 'exploded' | 'cancelled' | 'hint';

const TEXTS = {
  loading: '正在載入手部追蹤模型（第一次約 20–30 秒）。',
  error: '手部追蹤無法使用，仍可用滑鼠操作。',
  slow: '這台電腦的手部追蹤太慢，手勢已停用；骨架仍會顯示，請用滑鼠操作。',
  agent: '代理執行中，手勢只能轉動視角。',
  exploded: '爆炸圖開啟中，手勢只能轉動視角；收回後即可抓取零件。',
  explodedWithFist: '爆炸圖開啟中，捏合只能轉動視角，握拳仍可移動整個物件；收回後即可抓取零件。',
  cancelled: '手部追蹤中斷，已取消這次移動。',
  hint: '把手舉到鏡頭前：捏住零件可移動，捏住空白處可轉動視角。',
} as const satisfies Readonly<Record<string, string>>;

/**
 * The one line under the camera view while the camera and 手勢 are on.
 * Priority: loading, error, slow, (try-on: nothing, its own line shows), agent,
 * exploded, cancelled, then the hint until a hand has been seen.
 * `cancelledAt` is the time of the last cancel by tracking loss, or null. With `fistEnabled` the exploded line also says
 * that a fist can still move the whole object (requirement 94).
 */
export function handStatus(input: { tracker: TrackerStatus; gate: Gate; cancelledAt: number | null; now: number; handSeen: boolean; fistEnabled?: boolean }):
  { state: HandStatusState; text: string } {
  const show = (state: Exclude<HandStatusState, 'hidden'>, text: string = TEXTS[state]) => ({ state, text });
  // 'off' is the moment between the camera turning on and the worker starting.
  if (input.tracker === 'off' || input.tracker === 'loading') return show('loading');
  if (input.tracker === 'load-error' || input.tracker === 'track-error') return show('error');
  if (input.gate.reason === 'slow') return show('slow');
  if (input.gate.reason === 'try-on') return { state: 'hidden', text: '' };
  if (input.gate.reason === 'agent') return show('agent');
  if (input.gate.reason === 'exploded') return show('exploded', input.fistEnabled ? TEXTS.explodedWithFist : TEXTS.exploded);
  if (input.cancelledAt !== null && input.now - input.cancelledAt < CANCEL_NOTICE_MS) return show('cancelled');
  if (!input.handSeen) return show('hint');
  return { state: 'hidden', text: '' };
}

/** The tracking part of the `?hands=debug` line; `pinchMm` has one entry per hand in the latest frame. */
export function trackingDebugLine(input: { delegate: TrackingDelegate | null; fps: number | null; inferenceMs: number | null; hands: number; pinchMm: readonly (number | null)[]; minFps?: number; lossMs?: number | null; pinchThresholdsMm?: { engage: number; release: number } }): string {
  const number = (value: number | null) => (value === null || !Number.isFinite(value) ? '—' : value.toFixed(0));
  const parts = [
    input.delegate ?? '—',
    `每秒 ${number(input.fps)} 幀`,
    `辨識 ${number(input.inferenceMs)} ms`,
    `${input.hands} 隻手`,
  ];
  if (input.pinchMm.length > 0) parts.push(`捏合 ${input.pinchMm.map(number).join('／')} mm`);
  if (input.pinchThresholdsMm) parts.push(`捏合門檻 ${number(input.pinchThresholdsMm.engage)}／${number(input.pinchThresholdsMm.release)} mm`);
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
 * may not act because the other hand's gesture runs. `gesture` tells the joining hand's badge (zoom, explode); `value` is the
 * explode percentage of the pull (requirement 95) or the signed angle of a rotate in degrees (requirement 98); `objectName` is the held
 * object's name; `ready` is the snap of an assemble: the joining hand's badge then reads 可以接合 instead of the held object.
 * `input` is `pinch` for a hold that a pinch started (the two-pinch join, Task 11): 捏住 instead of 握住.
 */
export function badgeText(view: { state: HandState; target: Target; gesture: GestureKind; value: number | null; objectName?: string; inert?: boolean; ready?: boolean; input?: 'pinch' | 'fist' }): string {
  const name = view.target.kind === 'empty' ? '' : shortenName(view.target.label);
  switch (view.state) {
    case 'none': return '';
    case 'hover': return name ? `手勢：對準 ${name}` : '手勢：待命';
    case 'grab': return name ? `手勢：已抓取 ${name}` : '手勢：已抓取';
    case 'orbit': return '手勢：轉動視角';
    case 'locked': return view.inert ? '手勢：另一手操作中' : '手勢：暫停';
    case 'join':
      if (view.gesture === 'zoom') return '手勢：雙手縮放';
      if (view.gesture === 'explode') return view.value === null ? '手勢：拉開' : `手勢：拉開 ${view.value}%`;
      if (view.gesture === 'rotate') return view.value === null ? '手勢：雙手旋轉' : `手勢：雙手旋轉 ${view.value}°`;
      return '手勢：雙手操作';
    case 'fist': return '手勢：握拳';
    case 'hold':
      if (view.gesture === 'assemble' && view.ready) return '手勢：可以接合';
      return view.objectName
        ? `手勢：${view.input === 'pinch' ? '捏住' : '握住'} ${shortenName(view.objectName)}`
        : view.input === 'pinch' ? '手勢：捏住' : '手勢：握住';
    case 'tracked': return '手勢：待命';
  }
}

/** The whole `?hands=debug` line: tracking numbers, the running gesture, then the controller's counters. */
export function debugLine(stats: HandStats, tracking: Parameters<typeof trackingDebugLine>[0] & { gesture: GestureKind }): string {
  const { gesture, ...rest } = tracking;
  const twoHand = Object.values(stats.twoHand).reduce((sum, count) => sum + count, 0);
  // The curl ratio and the fist state of both hands, for tuning the fist thresholds on a real webcam (Task 7).
  const fists = stats.hands.some(hand => hand.curl !== null)
    ? [`曲度 ${stats.hands.map(hand => (hand.curl === null ? '—' : hand.curl.toFixed(2))).join('／')}`, `握拳 ${stats.hands.map(hand => (hand.fist ? '是' : '否')).join('／')}`]
    : [];
  return [
    trackingDebugLine(rest),
    `手勢 ${gesture}`,
    ...fists,
    `拖曳 ${stats.drags}／完成 ${stats.commits}／取消 ${stats.cancels}／拖曳中遺失 ${stats.dragLosses}（最長 ${stats.longestDragGapMs} ms）`,
    `雙手 ${twoHand}`,
    `無效捏合 ${stats.inert}`,
    ...snapDebug(stats),
  ].join(' · ');
}

/** The snap numbers of the two-fist join (requirement 63), once an assemble has started; nothing before that. */
function snapDebug(stats: HandStats): string[] {
  if (stats.assembles === 0) return [];
  const snap = stats.snap;
  const value = (number: number | null | undefined, digits: number) => (number === null || number === undefined || !Number.isFinite(number) ? '—' : number.toFixed(digits));
  return [`接合：間隙 ${value(snap?.gapMm, 1)} mm · 角度 ${value(snap?.angleDeg, 1)}° · 重疊 ${value(snap?.overlapMm2, 0)} mm² · 偵測 ${value(snap?.detectMs, 1)} ms · 接合 ${stats.joins}`];
}
