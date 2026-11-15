import { describe, expect, it } from 'vitest';
import { demoModel } from '../../shared/demo';
import type { ModelSpec } from '../../shared/model';
import type { ObjectTransform } from '../../shared/workspace';
import { planSceneSync, type SceneSyncObject } from '../../src/scene/scene-sync';

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const at = (x = 0, ry = 0): ObjectTransform => ({ position: vec(x, 0, 0), rotation: vec(0, ry, 0) });
const modelA: ModelSpec = demoModel;
const modelB: ModelSpec = { ...demoModel, name: 'Other' };
const entry = (model: ModelSpec, transform = at()) => ({ model, transform });
const input = (id: string, model: ModelSpec, transform = at()): SceneSyncObject => ({ id, model, transform });
const plan = (previous: Array<[string, ReturnType<typeof entry>]>, next: SceneSyncObject[]) => planSceneSync(new Map(previous), next);
const empty = { build: [], rebuild: [], move: [], remove: [], refit: false };

describe('planSceneSync', () => {
  it('plans nothing for an unchanged list, even with new transform objects of equal value', () => {
    expect(plan([['a', entry(modelA)], ['b', entry(modelB, at(1))]], [input('a', modelA, at()), input('b', modelB, at(1))])).toEqual(empty);
    expect(plan([], [])).toEqual(empty);
  });
  it('builds new ids and refits', () => {
    expect(plan([['a', entry(modelA)]], [input('a', modelA), input('b', modelB, at(2))]))
      .toEqual({ ...empty, build: ['b'], refit: true });
  });
  it('refits when the scene goes from empty to non-empty', () => {
    expect(plan([], [input('a', modelA)])).toEqual({ ...empty, build: ['a'], refit: true });
  });
  it('rebuilds only for a different model reference and keeps the view', () => {
    expect(plan([['a', entry(modelA)], ['b', entry(modelB)]], [input('a', { ...modelA }), input('b', modelB)]))
      .toEqual({ ...empty, rebuild: ['a'] });
  });
  it('does not list a rebuilt object as moved', () => {
    expect(plan([['a', entry(modelA)]], [input('a', modelB, at(3))])).toEqual({ ...empty, rebuild: ['a'] });
  });
  it('moves only when the transform values change', () => {
    expect(plan([['a', entry(modelA)], ['b', entry(modelB)]], [input('a', modelA, at(0.5)), input('b', modelB, at(0, 0))]))
      .toEqual({ ...empty, move: ['a'] });
    expect(plan([['a', entry(modelA)]], [input('a', modelA, at(0, 15))])).toEqual({ ...empty, move: ['a'] });
  });
  it('removes ids that are gone and refits', () => {
    expect(plan([['a', entry(modelA)], ['b', entry(modelB)]], [input('b', modelB)])).toEqual({ ...empty, remove: ['a'], refit: true });
    expect(plan([['a', entry(modelA)]], [])).toEqual({ ...empty, remove: ['a'], refit: true });
  });
  it('replacing one object with another builds and removes, and refits', () => {
    expect(plan([['a', entry(modelA)]], [input('b', modelA)])).toEqual({ ...empty, build: ['b'], remove: ['a'], refit: true });
  });
  it('treats a repeated id in the request as one object', () => {
    expect(plan([], [input('a', modelA), input('a', modelB)])).toEqual({ ...empty, build: ['a'], refit: true });
  });
});