import { z } from 'zod';
import type { GenerateDesignDetail, StateChange } from '../../shared/agent';
import { validateDesign } from '../../shared/model';
import { createObject, MAX_OBJECTS, WorkspaceError } from '../../shared/workspace';
import { designTask } from '../provider';
import { checkedChange, fail, langOf, ok, requireRun } from './helpers';
import { defineTool } from './registry';

/**
 * Produces a new concept model from a text prompt. Reuses `designTask`. The
 * model becomes a new object placed beside the others; an existing object is
 * never replaced. At the object limit the tool fails before it calls the
 * provider. approximation/unsupported become `ok:false` with no state change.
 * An abort/GenerationError from `provider.run` propagates.
 */
export const generateDesign = defineTool({
  name: 'generate_design',
  label: '生成設計',
  category: 'design',
  description: `produces a new concept model from a text description and adds it to the workspace as a new object beside the others, then makes it active. It never replaces an existing object. Returns ready/approximation/unsupported and the new object's id. Returns OBJECT_LIMIT when the workspace already holds ${MAX_OBJECTS} objects.`,
  args: z.strictObject({ prompt: z.string().trim().min(1).max(4000) }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ prompt }, { state, provider, newObjectId, now }, signal) {
    if (state.workspace.objects.length >= MAX_OBJECTS) {
      return fail('generate_design', 'OBJECT_LIMIT', new WorkspaceError('OBJECT_LIMIT').message);
    }
    const run = requireRun(provider);
    const raw = await run(designTask(prompt, langOf(state)), signal);
    const design = validateDesign(raw);
    const detail: GenerateDesignDetail = { source: provider.name, providerModel: provider.model, status: design.status, objectId: null };
    if (design.status !== 'ready') {
      return { tool: 'generate_design', ok: false, summary: design.explanation, detail, stateChange: null };
    }
    const object = createObject(state.workspace, {
      id: newObjectId(), model: design.model, source: provider.name, providerModel: provider.model, createdAt: now(),
    });
    const change: StateChange = {
      activeObjectId: null, object: { op: 'add', object }, selection: null, explode: null, tryOn: null,
    };
    const rejected = checkedChange(state, 'generate_design', change);
    if (rejected) return rejected;
    return ok('generate_design', `已產生「${object.model.name}」（物件 id：${object.id}）。`, { ...detail, objectId: object.id }, change);
  },
});
