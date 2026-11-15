import type { ModelSpec } from '../../shared/model';
import type { ObjectTransform } from '../../shared/workspace';

export interface SceneSyncObject { id: string; model: ModelSpec; transform: ObjectTransform }
export interface SceneSyncPlan {
  /** Ids that are new: build geometry. */
  build: string[];
  /** Ids whose model is a different reference: build again and replace. */
  rebuild: string[];
  /** Ids with the same model whose transform values changed: only move the group. */
  move: string[];
  /** Ids that are gone: dispose. */
  remove: string[];
  /** Frame the camera on all objects again. */
  refit: boolean;
}

const sameVector = (a: ObjectTransform['position'], b: ObjectTransform['position']) => a.x === b.x && a.y === b.y && a.z === b.z;
const sameTransform = (a: ObjectTransform, b: ObjectTransform) => sameVector(a.position, b.position) && sameVector(a.rotation, b.rotation);

/**
 * Decides what the scene has to do to go from what it shows (`previous`) to
 * the requested list (`next`). Pure: no Three.js, so it can be unit tested.
 * A rebuilt object is never also listed in `move`; its new group is placed
 * at the requested transform when it is built.
 */
export function planSceneSync(
  previous: ReadonlyMap<string, { model: ModelSpec; transform: ObjectTransform }>,
  next: readonly SceneSyncObject[],
): SceneSyncPlan {
  const plan: SceneSyncPlan = { build: [], rebuild: [], move: [], remove: [], refit: false };
  const wanted = new Set<string>();
  for (const object of next) {
    if (wanted.has(object.id)) continue; // a duplicate id is ignored; the first entry wins
    wanted.add(object.id);
    const known = previous.get(object.id);
    if (!known) plan.build.push(object.id);
    else if (known.model !== object.model) plan.rebuild.push(object.id);
    else if (!sameTransform(known.transform, object.transform)) plan.move.push(object.id);
  }
  for (const id of previous.keys()) if (!wanted.has(id)) plan.remove.push(id);
  // Editing, switching the active object and moving keep the user's view.
  plan.refit = plan.build.length > 0 || plan.remove.length > 0 || (previous.size === 0 && wanted.size > 0);
  return plan;
}
