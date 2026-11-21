import { fistAllowed, type Gate } from './gate';
import type { Target, Vector } from './types';

export type PinchAction =
  | { kind: 'press'; id: string }
  | { kind: 'grab'; objectId: string; partId: string; hit: Vector }
  | { kind: 'orbit' }
  | { kind: 'none' };

/**
 * What a pinch that starts a gesture does, from its settled target, the number
 * of objects on stage and the gate (requirements 24–28, 40–42).
 *
 * | Gate      | Screen target | Part | Empty space |
 * |-----------|---------------|------|-------------|
 * | full      | press         | grab | orbit       |
 * | view-only | press         | orbit| orbit       |
 * | off       | none          | none | none        |
 *
 * With no objects, parts and empty space give `none`; a screen target still presses.
 */
export function decidePinch(target: Target, context: { objectCount: number; gate: Gate }): PinchAction {
  const { objectCount, gate } = context;
  if (gate.level === 'off') return { kind: 'none' };
  if (target.kind === 'screen') return { kind: 'press', id: target.id };
  if (objectCount <= 0) return { kind: 'none' };
  if (target.kind === 'part' && gate.level === 'full') {
    return { kind: 'grab', objectId: target.objectId, partId: target.partId, hit: { x: target.hit.x, y: target.hit.y, z: target.hit.z } };
  }
  return { kind: 'orbit' };
}

export type FistAction = { kind: 'hold'; objectId: string; hit: Vector } | { kind: 'none' };

/**
 * What a fist that starts a gesture does (requirements 91 and 94): it holds the object of the part under the palm centre when hand
 * control is fully on or the exploded view is open (`fistAllowed`); over empty space, over an on-screen target, with no objects or
 * with the fist not allowed it holds nothing.
 */
export function decideFist(target: Target, context: { objectCount: number; gate: Gate }): FistAction {
  if (context.objectCount <= 0 || !fistAllowed(context.gate) || target.kind !== 'part') return { kind: 'none' };
  return { kind: 'hold', objectId: target.objectId, hit: { x: target.hit.x, y: target.hit.y, z: target.hit.z } };
}
