/** What the debug panel shows about one hand. */
export interface HandSlotStats {
  /** Latest thumb-index distance in metres; null without a hand or world landmarks. */
  pinchM: number | null;
  /** The pinch is engaged. */
  pinching: boolean;
  /** `targetKey` of the settled target. */
  target: string;
}

/** Plain counters for the `?hands=debug` panel. No timers, no logging. */
export interface HandStats {
  /** Owner drags that left the dead zone. */
  drags: number;
  /** Gestures committed to the workspace. */
  commits: number;
  /** Gestures cancelled by loss, gate, external change or reset (a tap is not counted). */
  cancels: number;
  /** Drags whose owner was missing for at least one frame. */
  dragLosses: number;
  /** The longest time an owner was missing during a drag, in ms. */
  longestDragGapMs: number;
  /** Two-hand gestures started, by gesture. */
  twoHand: Record<string, number>;
  /** Pinches that were not allowed to act because the other hand's gesture ran. */
  inert: number;
  hands: [HandSlotStats, HandSlotStats];
}

const emptyHand = (): HandSlotStats => ({ pinchM: null, pinching: false, target: '' });

export function createStats(): HandStats {
  return { drags: 0, commits: 0, cancels: 0, dragLosses: 0, longestDragGapMs: 0, twoHand: {}, inert: 0, hands: [emptyHand(), emptyHand()] };
}

export function recordDrag(stats: HandStats): void { stats.drags++; }
export function recordCommit(stats: HandStats): void { stats.commits++; }
export function recordCancel(stats: HandStats): void { stats.cancels++; }
export function recordInert(stats: HandStats): void { stats.inert++; }
export function recordJoin(stats: HandStats, gesture: string): void { stats.twoHand[gesture] = (stats.twoHand[gesture] ?? 0) + 1; }
export function recordDragLoss(stats: HandStats): void { stats.dragLosses++; }
export function recordDragGap(stats: HandStats, gapMs: number): void { stats.longestDragGapMs = Math.max(stats.longestDragGapMs, Math.round(gapMs)); }
export function recordHand(stats: HandStats, slot: 0 | 1, hand: HandSlotStats): void { stats.hands[slot] = hand; }
