import { z } from 'zod';
import { ExportPlanError, exportSummary, type ExportScope } from '../../shared/export-plan';
import { findObject, ObjectIdSchema, WorkspaceError } from '../../shared/workspace';
import { fail, noModel, ok } from './helpers';
import { printerOf } from './joint-helpers';
import { defineTool } from './registry';

export const prepareExport = defineTool({
  name: 'prepare_export',
  label: '準備匯出',
  category: 'export',
  description: "opens the export dialog in the browser and returns a summary of the printable kit (printed, bought and machined parts per object, standard parts, unconfirmed joints, problems). It cannot download or save files; the user downloads from the dialog. scope 'assembly' exports the assembly of objectId (or of the active object). scope defaults to 'workspace'. Returns UNKNOWN_OBJECT for an unknown objectId and NO_MODEL if the workspace is empty.",
  args: z.strictObject({
    scope: z.enum(['workspace', 'assembly']).nullable(),
    objectId: ObjectIdSchema.nullable(),
  }),
  side: 'server',
  scope: 'project',
  effects: 'read-only',
  async run({ scope, objectId }, { state }) {
    const { workspace } = state;
    if (workspace.objects.length === 0) return noModel('prepare_export');
    if (objectId !== null && !findObject(workspace, objectId)) {
      return fail('prepare_export', 'UNKNOWN_OBJECT', `工作區沒有 id 為「${objectId}」的物件。`);
    }
    // The workspace scope covers every object, so it carries no object id.
    const requested: ExportScope = scope === 'assembly'
      ? { scope: 'assembly', objectId }
      : { scope: 'workspace', objectId: null };
    try {
      // The user's printer profile comes with the agent request; the default applies only when it is absent.
      const summary = exportSummary(workspace, requested, printerOf(state));
      const bought = summary.objects.reduce((sum, object) => sum + object.bought, 0);
      const problems = summary.problems.length > 0 ? `，有 ${summary.problems.length} 個問題` : '';
      const text = `已開啟匯出視窗：${summary.note}，外購件 ${bought} 個，標準件 ${summary.standardParts.length} 項${problems}。請使用者按「下載完整套件」。`;
      return ok('prepare_export', text, summary, {
        activeObjectId: null, object: null, selection: null, explode: null, tryOn: null, exportDialog: requested,
      });
    } catch (error) {
      if (error instanceof ExportPlanError) return noModel('prepare_export');
      if (error instanceof WorkspaceError) return fail('prepare_export', error.code, error.message);
      throw error;
    }
  },
});
