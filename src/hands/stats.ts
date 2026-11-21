/** What the debug panel shows about one hand. */
export interface HandSlotStats {
  /** Latest thumb-index distance in metres; null without a hand or world landmarks. */
  pinchM: number | null;
  /** The pinch is engaged. */
  pinching: boolean;
  /** `targetKey` of the settled target. */
  target: string;
  /** Latest curl ratio (Task 7); null without a hand or world landmarks. */
  curl: number | null;
  /** The fist is engaged (Task 7). */
  fist: boolean;
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
  /** Two-fist assemble gestures started (assembly-joints Task 6). */
  assembles: number;
  /** Joints created by releasing a ready assemble. */
  joins: number;
  /** The latest snap measurement of a running assemble; null before the first one. Null fields: no pair within the engage limits. */
  snap: SnapStats | null;
  hands: [HandSlotStats, HandSlotStats];
}

/** What the debug line shows of the snap detection of one frame. */
export interface SnapStats { gapMm: number | null; angleDeg: number | null; overlapMm2: number | null; detectMs: number }

const emptyHand = (): HandSlotStats => ({ pinchM: null, pinching: false, target: '', curl: null, fist: false });

export function createStats(): HandStats {
  return { drags: 0, commits: 0, cancels: 0, dragLosses: 0, longestDragGapMs: 0, twoHand: {}, inert: 0, assembles: 0, joins: 0, snap: null, hands: [emptyHand(), emptyHand()] };
}

export function recordDrag(stats: HandStats): void { stats.drags++; }
export function recordCommit(stats: HandStats): void { stats.commits++; }
export function recordCancel(stats: HandStats): void { stats.cancels++; }
export function recordInert(stats: HandStats): void { stats.inert++; }
export function recordJoin(stats: HandStats, gesture: string): void { stats.twoHand[gesture] = (stats.twoHand[gesture] ?? 0) + 1; }
export function recordDragLoss(stats: HandStats): void { stats.dragLosses++; }
export function recordDragGap(stats: HandStats, gapMs: number): void { stats.longestDragGapMs = Math.max(stats.longestDragGapMs, Math.round(gapMs)); }
export function recordHand(stats: HandStats, slot: 0 | 1, hand: HandSlotStats): void { stats.hands[slot] = hand; }
export function recordAssemble(stats: HandStats): void { stats.assembles++; }
export function recordJoined(stats: HandStats): void { stats.joins++; }
export function recordSnap(stats: HandStats, snap: SnapStats): void { stats.snap = snap; }
