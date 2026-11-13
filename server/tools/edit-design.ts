import { z } from 'zod';
import type { EditDesignDetail } from '../../shared/agent';
import { applyEditPlan, describeChanges, EditError, validateEditPlan, type EditPlan } from '../../shared/edit';
import { editTask } from '../provider';
import { fail, noModel, ok, requireRun } from './helpers';
import { defineTool } from './registry';

/**
 * Applies a text edit instruction to the current model. Reuses `editTask` +
 * `applyEditPlan`. clarify/unsupported become `ok:false` with no state change; a
 * local `EditError` (the plan does not apply) becomes a `ToolError`. An
 * abort/GenerationError from `provider.run` propagates and ends the run.
 */
export const editDesign = defineTool({
  name: 'edit_design',
  category: 'design',
  description: 'applies a text edit instruction to the current model. Returns applied/clarify/unsupported. If the current model is null, returns NO_MODEL.',
  args: z.strictObject({ instruction: z.string().trim().min(1).max(4000) }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ instruction }, { state, provider }, signal) {
    if (state.model === null) return noModel('edit_design');
    const run = requireRun(provider);
    const planRaw = await run(editTask(state.model, instruction, state.selection), signal);
    let plan: EditPlan;
    try {
      plan = validateEditPlan(planRaw);
    } catch (error) {
      if (error instanceof EditError) return fail('edit_design', 'INVALID_EDIT', error.message);
      throw error;
    }
    if (plan.status !== 'applied') {
      const detail: EditDesignDetail = { changes: { added: [], updated: [], removed: [] }, explanation: plan.explanation };
      return { tool: 'edit_design', ok: false, summary: plan.explanation, detail, stateChange: null };
    }
    try {
      const { model, changes } = applyEditPlan(state.model, plan);
      const detail: EditDesignDetail = {
        changes: { added: changes.added, updated: changes.updated, removed: changes.removed },
        explanation: plan.explanation,
      };
      // Mirror App.tsx's applyEdit: select the changed parts so the working copy
      // and client never keep a selected part that the edit removed.
      const selection = [...changes.added, ...changes.updated];
      return ok('edit_design', `已修改：${describeChanges(state.model, model, changes)}`, detail, {
        model: { kind: 'edited', model, source: provider.name, providerModel: provider.model },
        selection,
        explode: null, tryOn: null,
      });
    } catch (error) {
      if (error instanceof EditError) return fail('edit_design', 'INVALID_EDIT', error.message);
      throw error;
    }
  },
});
