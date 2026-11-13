import type { ModelSpec } from '../../shared/model';

/**
 * The model on screen with its provenance. Lives here, away from `App.tsx`, so
 * the agent helpers can use it without pulling in any DOM code.
 * `lineage` identifies one object across its edits; a new object gets a new lineage.
 */
export type DisplayModel = {
  model: ModelSpec;
  source: string;
  providerModel: string;
  requestId: string;
  startedAt: number | null;
  lineage: string;
  edited: boolean;
};
