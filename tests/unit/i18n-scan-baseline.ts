/**
 * Per-file counts of Chinese text that still sits outside the string tables (english-ui R48, decision 9 (b)).
 *
 * How it was made: on 2026-11-27, in english-ui Task 2, from the scan of i18n-scan.test.ts. For every .ts, .tsx
 * and .html file under src/, shared/ and server/ (and index.html) outside the table folders, the number of lines
 * that strayLines reports: a CJK character on a line that is not comment-only. The counts are those of the
 * committed files plus Task 2's own edits (server/agent.ts lost three lines to server/i18n/instructions.ts).
 * Files that other sessions had changed but not committed contributed their committed lines, and none of them
 * had a different count. A file that is not listed has a baseline of 0. Total: 747 lines in 67 files.
 *
 * What the scan does with it: a file whose count is above its baseline fails, and so does a file that is not
 * listed and has any stray line, so new Chinese text cannot get in. A count below the baseline passes and prints
 * a reminder to lower the entry.
 *
 * Who changes it: Tasks 3 to 5 lower an entry, or delete it when the count reaches 0, in the same task that moves
 * those strings into tables. Task 6 turns STRICT on in i18n-scan.test.ts and deletes this file. Never raise
 * a number to make the scan pass: move the text into the area's table instead (.kiro/steering/hackathon.md).
 */
export const SCAN_BASELINE: Readonly<Record<string, number>> = Object.freeze({
  'index.html': 2,
  'server/agent-tools.ts': 9,
  'server/agent.ts': 19,
  'server/app-server.ts': 40,
  'server/app.ts': 20,
  'server/claude.ts': 8,
  'server/codex.ts': 13,
  'server/index.ts': 8,
  'server/model-host.ts': 5,
  'server/provider.ts': 13,
  'server/tools/create-joint.ts': 4,
  'server/tools/edit-design.ts': 2,
  'server/tools/explode-view.ts': 2,
  'server/tools/generate-design.ts': 2,
  'server/tools/get-project-state.ts': 3,
  'server/tools/helpers.ts': 3,
  'server/tools/joint-helpers.ts': 14,
  'server/tools/prepare-export.ts': 4,
  'server/tools/remove-joint.ts': 2,
  'server/tools/remove-object.ts': 2,
  'server/tools/select-parts.ts': 3,
  'server/tools/set-active-object.ts': 3,
  'server/tools/set-camera-image.ts': 3,
  'server/tools/set-material.ts': 4,
  'server/tools/set-transform.ts': 3,
  'server/tools/update-joint.ts': 5,
  'server/tools/wear-on-arm.ts': 4,
  'shared/agent.ts': 7,
  'shared/contact.ts': 3,
  'shared/demo.ts': 12,
  'shared/edit.ts': 15,
  'shared/export-plan.ts': 13,
  'shared/fit-text.ts': 37,
  'shared/hollow.ts': 1,
  'shared/joint-rules.ts': 30,
  'shared/joint.ts': 6,
  'shared/kit.ts': 19,
  'shared/materials.ts': 4,
  'shared/model.ts': 6,
  'shared/pull-out.ts': 1,
  'shared/standard-parts.ts': 5,
  'shared/workspace.ts': 12,
  'src/App.tsx': 125,
  'src/agent/AgentPanel.tsx': 18,
  'src/agent/labels.ts': 3,
  'src/agent/request.ts': 1,
  'src/agent/run-reducer.ts': 1,
  'src/agent/useAgentRun.ts': 3,
  'src/export/ExportDialog.tsx': 16,
  'src/export/bom.ts': 25,
  'src/export/dialog-model.ts': 5,
  'src/export/findings.ts': 13,
  'src/export/pieces.ts': 2,
  'src/export/prepare.ts': 2,
  'src/export/sheet.ts': 18,
  'src/hands/text.ts': 34,
  'src/joints/JointCard.tsx': 22,
  'src/joints/JointPanel.tsx': 9,
  'src/joints/PrinterPanel.tsx': 9,
  'src/joints/card-model.ts': 13,
  'src/joints/labels.ts': 32,
  'src/print/printable.ts': 1,
  'src/scene/SceneViewport.tsx': 5,
  'src/scene/geometry.ts': 6,
  'src/workspace/ObjectPanel.tsx': 9,
  'src/workspace/app-rules.ts': 2,
  'src/workspace/object-panel.ts': 2,
});
