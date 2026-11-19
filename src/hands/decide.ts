import type { Gate } from './gate';
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
