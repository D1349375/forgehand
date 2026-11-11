import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import { validateModel, type ModelSpec } from '../../shared/model';
import { computeExplosion, explodedOffsets, groupProgress, partBoxes } from '../../src/scene/explode';

// Real generated models (phase one, ten prompts) are the main fixture, so the
// exploded view is checked on what the AI actually produces.
const saved = JSON.parse(readFileSync(new URL('../../artifacts/real-provider-2026-11-11.json', import.meta.url), 'utf8')) as
  { runs: Array<{ results: Array<{ id: string; design: { model: unknown } }> }> };
const realModels = saved.runs[0]!.results.map(result => ({ id: result.id, model: validateModel(result.design.model) }));
const fixtures: Array<{ id: string; model: ModelSpec }> = [{ id: 'demo', model: demoModel }, ...realModels];

/** Pairs of parts (excluding a part and its own ancestors) whose boxes overlap by more than a sliver. */
function overlappingPairs(model: ModelSpec, offsets?: Map<string, THREE.Vector3>): number {
  const boxes = partBoxes(model, offsets);
  const parents = new Map(model.parts.map(part => [part.id, part.parentId]));
  const related = (a: string, b: string) => {
    for (let id: string | null | undefined = parents.get(a); id; id = parents.get(id)) if (id === b) return true;
    for (let id: string | null | undefined = parents.get(b); id; id = parents.get(id)) if (id === a) return true;
    return false;
  };
  let count = 0;
  for (let i = 0; i < model.parts.length; i++) for (let j = i + 1; j < model.parts.length; j++) {
    const a = model.parts[i]!.id, b = model.parts[j]!.id;
    if (related(a, b)) continue;
    const overlap = boxes.get(a)!.clone().intersect(boxes.get(b)!);
    if (overlap.isEmpty()) continue;
    const size = overlap.getSize(new THREE.Vector3());
    if (Math.min(size.x, size.y, size.z) > 1e-4) count++;
  }
  return count;
}

describe('exploded view', () => {
  it('moves every non-anchor part, never changes the model, and is all zero when collapsed', () => {
    for (const { id, model } of fixtures) {
      const before = JSON.stringify(model);
      const plan = computeExplosion(model);
      const roots = model.parts.filter(part => part.parentId === null);
      const expectedMoves = model.parts.length - (roots.length > 1 ? 1 : roots.length);
      expect(plan.moves.size, id).toBe(expectedMoves);
      for (const [partId, move] of plan.moves) expect(move.offset.length(), `${id}:${partId}`).toBeGreaterThan(0);
      for (const offset of explodedOffsets(model, plan, 0).values()) expect(offset.length()).toBe(0);
      expect(JSON.stringify(model), id).toBe(before);
    }
  });

  it('drops table legs straight down from the tabletop (smallest escape, unblocked)', () => {
    const table = realModels.find(entry => entry.id === 'P01')!.model;
    const plan = computeExplosion(table);
    for (const leg of ['leg1', 'leg2', 'leg3', 'leg4']) {
      const { offset } = plan.moves.get(leg)!;
      expect(offset.y, leg).toBeLessThan(0);
      expect(offset.x).toBe(0);
      expect(offset.z).toBe(0);
    }
  });

  it('does not add box overlaps between unrelated parts when fully exploded', () => {
    const report: string[] = [];
    for (const { id, model } of fixtures) {
      const plan = computeExplosion(model);
      const before = overlappingPairs(model);
      const after = overlappingPairs(model, explodedOffsets(model, plan, 1));
      report.push(`${id}: ${before}→${after}`);
      expect(after, id).toBeLessThanOrEqual(before);
    }
    console.info(`[explode] overlapping box pairs (collapsed→exploded): ${report.join(', ')}`);
  });

  it('expands outer groups before inner ones and collapses in reverse', () => {
    expect(groupProgress(0.25, 0, 1)).toBeCloseTo(0.5);
    expect(groupProgress(0.25, 1, 1)).toBe(0);
    expect(groupProgress(0.75, 0, 1)).toBe(1);
    expect(groupProgress(0.75, 1, 1)).toBeCloseTo(0.5);
    expect(groupProgress(1, 1, 1)).toBe(1);
  });
});
