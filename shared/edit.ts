import { z } from 'zod';
import { PartSchema, validateModel, type ModelSpec, type Part } from './model';

const text = z.string().trim().min(1).max(500);
const partId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);

/**
 * An AI edit returns only the parts that change. `upsert` carries the whole
 * part (structured output requires every field), `remove` carries none.
 * Model-level fields are null when unchanged, otherwise the full new value.
 */
export const EditOperationSchema = z.strictObject({
  op: z.enum(['upsert', 'remove']),
  partId,
  part: PartSchema.nullable(),
});

export const EditPlanSchema = z.strictObject({
  status: z.enum(['applied', 'clarify', 'unsupported']),
  explanation: z.string().trim().min(1).max(2000),
  operations: z.array(EditOperationSchema).max(64),
  name: text.nullable(),
  summary: z.string().trim().min(1).max(2000).nullable(),
  assumptions: z.array(text).max(20).nullable(),
});

export type EditOperation = z.infer<typeof EditOperationSchema>;
export type EditPlan = z.infer<typeof EditPlanSchema>;

export interface EditChanges { added: string[]; updated: string[]; removed: string[]; modelFields: boolean }
export interface AppliedEdit { model: ModelSpec; changes: EditChanges }

/**
 * How much the model should invent (design-fidelity R18 to R20): concept is the default and today's behaviour,
 * detailed adds the typical internals of the product category. Shared by generation, edits and the agent.
 */
export const DetailModeSchema = z.enum(['concept', 'detailed']);
export type DetailMode = z.infer<typeof DetailModeSchema>;

export const EditRequestSchema = z.strictObject({
  instruction: z.string().trim().min(1).max(4000),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  model: z.unknown(),
  selectedPartIds: z.array(partId).max(64),
  /** Absent means concept mode (design-fidelity R20). */
  detail: DetailModeSchema.optional(),
});

export interface EditResult { plan: EditPlan; source: 'codex' | 'claude' | 'openai'; model: string; elapsedMs: number; requestId: string }
export const EditResultSchema = z.strictObject({
  plan: EditPlanSchema,
  source: z.enum(['codex', 'claude', 'openai']),
  model: z.string().min(1).max(100),
  elapsedMs: z.number().nonnegative(),
  requestId: z.string().min(1).max(100),
});

export class EditError extends Error {
  constructor(message: string) { super(message); this.name = 'EditError'; }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Structural checks that do not depend on a particular model. */
export function validateEditPlan(input: unknown): EditPlan {
  const plan = EditPlanSchema.parse(input);
  if (plan.status !== 'applied') {
    if (plan.operations.length || plan.name || plan.summary || plan.assumptions) throw new EditError('需要確認或無法處理的回覆不可附帶修改。');
    return plan;
  }
  const seen = new Set<string>();
  for (const operation of plan.operations) {
    if (seen.has(operation.partId)) throw new EditError(`同一個零件不可在一次修改中出現兩次：${operation.partId}`);
    seen.add(operation.partId);
    if (operation.op === 'remove' && operation.part !== null) throw new EditError('刪除零件不可附帶零件資料。');
    if (operation.op === 'upsert' && (operation.part === null || operation.part.id !== operation.partId)) throw new EditError('新增或修改零件必須附上 ID 一致的完整零件資料。');
  }
  return plan;
}

/**
 * Applies a validated plan to a model. The result passes the same validation
 * as a freshly generated model; any failure leaves the input untouched.
 */
export function applyEditPlan(model: ModelSpec, input: EditPlan): AppliedEdit {
  const plan = validateEditPlan(input);
  if (plan.status !== 'applied') throw new EditError('這次回覆沒有可套用的修改。');
  const parts = model.parts.map(part => ({ ...part }));
  const index = new Map(parts.map((part, position) => [part.id, position]));
  const changes: EditChanges = { added: [], updated: [], removed: [], modelFields: false };
  const removed = new Set<string>();
  for (const operation of plan.operations) {
    const position = index.get(operation.partId);
    if (operation.op === 'remove') {
      if (position === undefined) throw new EditError(`找不到要刪除的零件：${operation.partId}`);
      removed.add(operation.partId);
      changes.removed.push(operation.partId);
    } else if (position === undefined) {
      parts.push(operation.part!);
      index.set(operation.partId, parts.length - 1);
      changes.added.push(operation.partId);
    } else if (!same(parts[position], operation.part)) {
      parts[position] = operation.part!;
      changes.updated.push(operation.partId);
    }
  }
  const next: ModelSpec = {
    ...model,
    name: plan.name ?? model.name,
    summary: plan.summary ?? model.summary,
    assumptions: plan.assumptions ?? model.assumptions,
    parts: parts.filter(part => !removed.has(part.id)),
  };
  changes.modelFields = next.name !== model.name || next.summary !== model.summary || !same(next.assumptions, model.assumptions);
  const orphan = next.parts.find(part => part.parentId !== null && removed.has(part.parentId));
  if (orphan) throw new EditError(`「${orphan.name}」仍依附在被刪除的零件上，請一併處理子零件。`);
  if (!next.parts.length) throw new EditError('修改後模型不可沒有任何零件。');
  if (!changes.added.length && !changes.updated.length && !changes.removed.length && !changes.modelFields) {
    throw new EditError('這次修改沒有改變任何內容。');
  }
  try { return { model: validateModel(next), changes }; }
  catch (error) { throw new EditError(`修改後的模型未通過驗證：${error instanceof Error ? error.message.slice(0, 200) : '格式錯誤'}`); }
}

/**
 * Parts an edit plan would overwrite that were changed locally after the
 * request was sent. Comparing against the request's base model means a
 * manual adjustment is never silently replaced by an older AI answer.
 */
export function editConflicts(base: ModelSpec, current: ModelSpec, plan: EditPlan): Part[] {
  const before = new Map(base.parts.map(part => [part.id, part]));
  const now = new Map(current.parts.map(part => [part.id, part]));
  const conflicts: Part[] = [];
  for (const operation of plan.operations) {
    const original = before.get(operation.partId), latest = now.get(operation.partId);
    if (original && !same(original, latest)) conflicts.push(latest ?? original);
    else if (!original && latest) conflicts.push(latest);
  }
  return conflicts;
}

/** Human-readable change summary in Traditional Chinese. */
export function describeChanges(before: ModelSpec, after: ModelSpec, changes: EditChanges): string {
  const name = (model: ModelSpec, id: string) => model.parts.find(part => part.id === id)?.name ?? id;
  const lines: string[] = [];
  if (changes.added.length) lines.push(`新增 ${changes.added.map(id => name(after, id)).join('、')}`);
  if (changes.updated.length) lines.push(`調整 ${changes.updated.map(id => name(after, id)).join('、')}`);
  if (changes.removed.length) lines.push(`刪除 ${changes.removed.map(id => name(before, id)).join('、')}`);
  if (changes.modelFields) lines.push('更新模型說明');
  return lines.join('；');
}
