import { z } from 'zod';
import type { GenerateDesignDetail } from '../../shared/agent';
import { validateDesign } from '../../shared/model';
import { designTask } from '../provider';
import { ok, requireRun } from './helpers';
import { defineTool } from './registry';

/**
 * Produces a new concept model from a text prompt. Reuses `designTask`. Works
 * with or without an existing model (an existing model is ignored; a new
 * lineage is created client-side). approximation/unsupported become `ok:false`
 * with no state change. An abort/GenerationError from `provider.run` propagates.
 */
export const generateDesign = defineTool({
  name: 'generate_design',
  category: 'design',
  description: 'produces a new concept model from a text description. Works on an empty scene or replaces an existing model. Returns ready/approximation/unsupported.',
  args: z.strictObject({ prompt: z.string().trim().min(1).max(4000) }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ prompt }, { provider }, signal) {
    const run = requireRun(provider);
    const raw = await run(designTask(prompt), signal);
    const design = validateDesign(raw);
    const detail: GenerateDesignDetail = { source: provider.name, providerModel: provider.model, status: design.status };
    if (design.status !== 'ready') {
      return { tool: 'generate_design', ok: false, summary: design.explanation, detail, stateChange: null };
    }
    return ok('generate_design', `已產生「${design.model!.name}」。`, detail, {
      model: { kind: 'generated', model: design.model!, source: provider.name, providerModel: provider.model },
      selection: null, explode: null, tryOn: null,
    });
  },
});
