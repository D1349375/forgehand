import { z } from 'zod';
import type { EditDesignDetail, StateChange } from '../../shared/agent';
import { applyEditPlan, describeChanges, EditError, validateEditPlan, type EditPlan } from '../../shared/edit';
import { editTask } from '../provider';
import { checkedChange, fail, isToolResult, langOf, ok, OptionalObjectIdSchema, requireRun, resolveTarget, switchTo } from './helpers';
import { defineTool } from './registry';

/**
 * Applies a text edit instruction to the target object (`objectId`, default the active one). Reuses `editTask` +
 * `applyEditPlan`. clarify/unsupported become `ok:false` with no state change; a
 * local `EditError` (the plan does not apply) becomes a `ToolError`. An
 * abort/GenerationError from `provider.run` propagates and ends the run.
 */
export const editDesign = defineTool({
  name: 'edit_design',
  label: '修改設計',
  category: 'design',
  description: 'applies a text edit instruction to an object (objectId, default: the active object) and makes it active. Returns applied/clarify/unsupported. Returns UNKNOWN_OBJECT for an unknown objectId and NO_MODEL if the workspace is empty.',
  args: z.strictObject({ instruction: z.string().trim().min(1).max(4000), objectId: OptionalObjectIdSchema }),
  side: 'server',
  scope: 'project',
  effects: 'writes-scene',
  async run({ instruction, objectId }, { state, provider }, signal) {
    const target = resolveTarget(state, 'edit_design', objectId);
    if (isToolResult(target)) return target;
    const run = requireRun(provider);
    const { selection } = state.workspace;
    // Only a selection inside the target object is meaningful to the edit.
    const selectedPartIds = selection.objectId === target.id ? selection.partIds : [];
    const planRaw = await run(editTask(target.model, instruction, selectedPartIds, langOf(state)), signal);
    let plan: EditPlan;
    try {
      plan = validateEditPlan(planRaw);
    } catch (error) {
      if (error instanceof EditError) return fail('edit_design', 'INVALID_EDIT', error.message);
      throw error;
    }
    if (plan.status !== 'applied') {
      const detail: EditDesignDetail = {
        objectId: target.id, changes: { added: [], updated: [], removed: [] }, explanation: plan.explanation,
      };
      return { tool: 'edit_design', ok: false, summary: plan.explanation, detail, stateChange: null };
    }
    try {
      const { model, changes } = applyEditPlan(target.model, plan);
      const detail: EditDesignDetail = {
        objectId: target.id,
        changes: { added: changes.added, updated: changes.updated, removed: changes.removed },
        explanation: plan.explanation,
      };
      // Mirror App.tsx's applyEdit: select the changed parts so the working copy
      // and client never keep a selected part that the edit removed.
      const change: StateChange = {
        activeObjectId: switchTo(state, target),
        object: { op: 'model', objectId: target.id, model, source: provider.name, providerModel: provider.model },
        selection: { objectId: target.id, partIds: [...changes.added, ...changes.updated] },
        explode: null,
        tryOn: null,
      };
      const rejected = checkedChange(state, 'edit_design', change);
      if (rejected) return rejected;
      return ok('edit_design', `已修改：${describeChanges(target.model, model, changes)}`, detail, change);
    } catch (error) {
      if (error instanceof EditError) return fail('edit_design', 'INVALID_EDIT', error.message);
      throw error;
    }
  },
});
