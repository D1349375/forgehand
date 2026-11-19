import { DUPLICATE_HAND_PX, HAND_MATCH_PX } from './constants';
import type { HandSample, Point } from './types';

/**
 * Keeps the first of two samples whose palm centres are closer than `minPx`.
 * MediaPipe sometimes reports one hand twice when more than one hand is allowed.
 */
export function dedupeHands(samples: readonly HandSample[], minPx = DUPLICATE_HAND_PX): HandSample[] {
  const kept: HandSample[] = [];
  for (const sample of samples) {
    const duplicate = kept.some(other => Math.hypot(other.palm.x - sample.palm.x, other.palm.y - sample.palm.y) < minPx);
    if (!duplicate) kept.push(sample);
  }
  return kept;
}

/**
 * Decides which sample each hand slot takes. `slots` holds, per slot, the last
 * filtered palm centre of a tracked hand, or `null` for a free slot. The result
 * holds, per slot, the index into `samples` that the slot takes, or `null`.
 *
 * A tracked slot takes a sample only within `maxJumpPx`; with several choices the
 * assignment that matches the most slots wins, then the one with the smaller total
 * palm movement. A sample that no tracked slot takes goes to the lowest free slot.
 * A sample left over when no slot is free is dropped. A tracked slot without a
 * sample gets `null` and keeps its state until its time-outs.
 */
export function assignHands(slots: readonly (Point | null)[], samples: readonly HandSample[], maxJumpPx = HAND_MATCH_PX): Array<number | null> {
  const result: Array<number | null> = slots.map(() => null);
  const distance = (slot: number, sample: number) => {
    const from = slots[slot]!;
    const to = samples[sample]!.palm;
    return Math.hypot(from.x - to.x, from.y - to.y);
  };
  const tracked = slots.map((point, slot) => (point ? slot : -1)).filter(slot => slot >= 0);
  let best: { picks: Array<number | null>; matched: number; total: number } | null = null;
  const search = (position: number, taken: ReadonlySet<number>, picks: Array<number | null>, matched: number, total: number) => {
    if (position === tracked.length) {
      if (!best || matched > best.matched || (matched === best.matched && total < best.total)) best = { picks: [...picks], matched, total };
      return;
    }
    const slot = tracked[position]!;
    for (let sample = 0; sample < samples.length; sample++) {
      if (taken.has(sample)) continue;
      const jump = distance(slot, sample);
      if (jump > maxJumpPx) continue;
      search(position + 1, new Set(taken).add(sample), [...picks, sample], matched + 1, total + jump);
    }
    search(position + 1, taken, [...picks, null], matched, total);
  };
  search(0, new Set(), [], 0, 0);
  const chosen = best as { picks: Array<number | null> } | null;
  const used = new Set<number>();
  chosen?.picks.forEach((sample, position) => {
    if (sample === null) return;
    result[tracked[position]!] = sample;
    used.add(sample);
  });
  for (let sample = 0; sample < samples.length; sample++) {
    if (used.has(sample)) continue;
    const free = slots.findIndex((point, slot) => point === null && result[slot] === null);
    if (free >= 0) result[free] = sample;
  }
  return result;
}
