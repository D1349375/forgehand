import { StateChangeSchema } from '../../shared/agent';
import type { DisplayModel } from './types';

/** What the caller should apply for one `state` event. Absent fields mean "leave as is". */
export interface StateEffects {
  commitArg?: DisplayModel;
  selection?: string[];
  explode?: number;
  tryOn?: boolean;
}

/**
 * Turns a `state` event payload into the arguments for `commit`, `setSelected`,
 * `setExplode` and `setTryingOn`. The payload carries none of `requestId`,
 * `startedAt` or `lineage`; the caller supplies them so this stays deterministic.
 * An invalid payload yields `{}` (nothing to apply).
 *
 * Apply `commitArg` first: a `generated` model has a new lineage, so `commit`
 * resets selection and explode, and the event's own `selection`/`explode` then
 * set the values the agent chose.
 */
export function applyStateEvent(
  event: unknown,
  current: DisplayModel | null,
  context: { requestId: string; now: number; newLineage: string },
): StateEffects {
  const parsed = StateChangeSchema.safeParse(event);
  if (!parsed.success) return {};
  const { model, selection, explode, tryOn } = parsed.data;
  const effects: StateEffects = {};

  if (model?.kind === 'generated') {
    effects.commitArg = {
      model: model.model, source: model.source, providerModel: model.providerModel,
      requestId: context.requestId, startedAt: context.now, lineage: context.newLineage, edited: false,
    };
  } else if (model?.kind === 'edited' && current) {
    effects.commitArg = {
      ...current,
      model: model.model, source: model.source, providerModel: model.providerModel,
      requestId: context.requestId, startedAt: context.now, edited: true,
    };
  }
  if (selection !== null) effects.selection = selection;
  if (explode !== null) effects.explode = explode;
  if (tryOn !== null) effects.tryOn = tryOn;
  return effects;
}
