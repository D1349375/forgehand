import { z } from 'zod';
import { ModelSpecSchema, validateModel, type ModelSpec } from './model';

/**
 * Agent contract — the Zod authority shared by server and client, mirroring
 * `model.ts` / `edit.ts`. A flat-nullable strict schema is sent to the model
 * (every property `required`, optionals `null`), then `validateAgentStep` does
 * the semantic checks a JSON-Schema union could not express portably.
 */

const text = z.string().trim().min(1).max(500);
const partId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const primitive = z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus', 'tube']);

// ----- AgentStep (model-facing) -----

export const ToolCallSchema = z.strictObject({
  tool: z.enum(['generate_design', 'edit_design', 'select_parts', 'get_project_state',
    'explode_view', 'wear_on_arm', 'estimate_weight_cost', 'check_feasibility']),
  args: z.strictObject({
    prompt: z.string().trim().min(1).max(4000).nullable(),
    instruction: z.string().trim().min(1).max(4000).nullable(),
    partIds: z.array(partId).max(64).nullable(),
    amount: z.number().min(0).max(1).nullable(),
    enabled: z.boolean().nullable(),
    densityKgPerM3: z.number().min(0).max(100000).nullable(),
    material: z.string().trim().min(1).max(100).nullable(),
  }),
  reason: z.string().trim().min(1).max(300).nullable(),
});

export const AgentStepSchema = z.strictObject({
  type: z.enum(['tool_calls', 'final']),
  note: z.string().trim().min(1).max(500).nullable(),
  reply: z.string().trim().min(1).max(2000).nullable(),
  calls: z.array(ToolCallSchema).min(1).max(8).nullable(),
});

export type ToolName = z.infer<typeof ToolCallSchema>['tool'];
export type ToolCallArgs = z.infer<typeof ToolCallSchema>['args'];
export type ToolCall = z.infer<typeof ToolCallSchema>;

// ----- ModelStateChange (carries everything commit() needs; sent in `state` only) -----

export const ModelStateChangeSchema = z.strictObject({
  kind: z.enum(['generated', 'edited']),
  model: ModelSpecSchema,
  source: z.string().min(1).max(100),
  providerModel: z.string().min(1).max(100),
});

export type ModelStateChange = z.infer<typeof ModelStateChangeSchema>;

// ----- ToolResult -----

export const ToolResultSchema = z.strictObject({
  tool: z.enum(['generate_design', 'edit_design', 'select_parts', 'get_project_state',
    'explode_view', 'wear_on_arm', 'estimate_weight_cost', 'check_feasibility']),
  ok: z.boolean(),
  summary: z.string().trim().min(1).max(1000),
  // Per-tool detail, validated by the matching detail schema below. NEVER a full ModelSpec.
  detail: z.unknown().nullable(),
  stateChange: z.strictObject({
    model: ModelStateChangeSchema.nullable(),
    selection: z.array(partId).max(64).nullable(),
    explode: z.number().min(0).max(1).nullable(),
    tryOn: z.boolean().nullable(),
  }).nullable(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

// ----- Per-tool detail schemas -----

export const GenerateDesignDetailSchema = z.strictObject({
  source: z.string().min(1).max(100),
  providerModel: z.string().min(1).max(100),
  status: z.enum(['ready', 'approximation', 'unsupported']),
});
export type GenerateDesignDetail = z.infer<typeof GenerateDesignDetailSchema>;

export const EditDesignDetailSchema = z.strictObject({
  changes: z.strictObject({
    added: z.array(partId).max(64),
    updated: z.array(partId).max(64),
    removed: z.array(partId).max(64),
  }),
  explanation: z.string().trim().min(1).max(2000),
});
export type EditDesignDetail = z.infer<typeof EditDesignDetailSchema>;

const PartSummarySchema = z.strictObject({
  id: partId,
  name: text,
  primitive,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  parentId: partId.nullable(),
});

export const GetProjectStateDetailSchema = z.strictObject({
  parts: z.array(PartSummarySchema).max(64),
  selection: z.array(partId).max(64),
  explode: z.number().min(0).max(1),
  tryOn: z.boolean(),
});
export type GetProjectStateDetail = z.infer<typeof GetProjectStateDetailSchema>;

export const ExplodeViewDetailSchema = z.strictObject({ amount: z.number().min(0).max(1) });
export type ExplodeViewDetail = z.infer<typeof ExplodeViewDetailSchema>;

export const WearOnArmDetailSchema = z.strictObject({
  tryOn: z.boolean(),
  cameraOn: z.boolean(),
  message: z.string().trim().min(1).max(500),
});
export type WearOnArmDetail = z.infer<typeof WearOnArmDetailSchema>;

export const ToolErrorDetailSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().trim().min(1).max(1000),
});
export type ToolErrorDetail = z.infer<typeof ToolErrorDetailSchema>;

// Deferred (Task 9); defined now so the enum/detail set is complete.
export const EstimateDetailSchema = z.strictObject({
  totalKg: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
  perPart: z.array(z.strictObject({ id: partId, kg: z.number().nonnegative(), cost: z.number().nonnegative() })).max(64),
});
export type EstimateDetail = z.infer<typeof EstimateDetailSchema>;

export const FeasibilityDetailSchema = z.strictObject({
  issues: z.array(z.strictObject({
    severity: z.enum(['warning', 'error']),
    partId: partId.nullable(),
    message: z.string().trim().min(1).max(500),
  })).max(64),
});
export type FeasibilityDetail = z.infer<typeof FeasibilityDetailSchema>;

// ----- Request, turns, history -----

export const AgentTurnSchema = z.strictObject({
  instruction: z.string().trim().min(1).max(4000),
  reply: z.string().trim().min(1).max(2000),
});
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

export const AgentRequestSchema = z.strictObject({
  instruction: z.string().trim().min(1).max(4000),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  // A missing key or an explicit `undefined` is a structural error (INVALID_REQUEST);
  // only an explicit `null` means "no model". Any non-null value is validated later.
  model: z.union([
    z.null(),
    z.unknown().refine((value) => value !== undefined, { message: 'model 必須明確為 null 或模型資料。' }),
  ]),
  selectedPartIds: z.array(partId).max(64),
  explode: z.number().min(0).max(1),
  tryOn: z.boolean(),
  cameraOn: z.boolean(),
  history: z.array(AgentTurnSchema).max(10),
});

/** Distinguishes request-validation failures so the route can map them to HTTP codes. */
export class AgentRequestError extends Error {
  constructor(public code: 'INVALID_MODEL' | 'INVALID_SELECTION', message: string) {
    super(message);
    this.name = 'AgentRequestError';
  }
}

export interface AgentRequest {
  instruction: string;
  requestId: string;
  model: ModelSpec | null;
  selectedPartIds: string[];
  explode: number;
  tryOn: boolean;
  cameraOn: boolean;
  history: AgentTurn[];
}

/**
 * Parses the request and runs semantic checks: a null model must come with an
 * empty selection; a non-null model must be a valid `ModelSpec` whose parts
 * contain every selected id. Throws `AgentRequestError` for model/selection
 * failures and lets Zod throw for structural ones.
 */
export function validateAgentRequest(input: unknown): AgentRequest {
  const raw = AgentRequestSchema.parse(input);
  if (raw.model === null) {
    if (raw.selectedPartIds.length) throw new AgentRequestError('INVALID_SELECTION', '沒有模型時不可選取零件。');
    return { ...raw, model: null };
  }
  let model: ModelSpec;
  try { model = validateModel(raw.model); }
  catch {
    // Fixed sanitized message — never leak the Zod/semantic error detail.
    throw new AgentRequestError('INVALID_MODEL', '目前模型資料無效，無法處理這次請求。');
  }
  const ids = new Set(model.parts.map(part => part.id));
  for (const id of raw.selectedPartIds) {
    if (!ids.has(id)) throw new AgentRequestError('INVALID_SELECTION', `選取的零件不在目前模型中：${id}`);
  }
  return { ...raw, model };
}

// ----- AgentStep validation -----

export interface AgentToolCalls {
  type: 'tool_calls';
  note: string | null;
  calls: ToolCall[];
  reply: null;
}
export interface AgentFinal {
  type: 'final';
  note: null;
  reply: string;
  calls: null;
}
export type AgentStep = AgentToolCalls | AgentFinal;

/** Arg fields each tool "owns" (others must be null) and which of those are required. */
const TOOL_ALLOWED: Record<ToolName, (keyof ToolCallArgs)[]> = {
  generate_design: ['prompt'],
  edit_design: ['instruction'],
  select_parts: ['partIds'],
  get_project_state: [],
  explode_view: ['amount'],
  wear_on_arm: ['enabled'],
  estimate_weight_cost: ['densityKgPerM3', 'material'],
  check_feasibility: [],
};
const TOOL_REQUIRED: Record<ToolName, (keyof ToolCallArgs)[]> = {
  generate_design: ['prompt'],
  edit_design: ['instruction'],
  select_parts: ['partIds'],
  get_project_state: [],
  explode_view: ['amount'],
  wear_on_arm: ['enabled'],
  estimate_weight_cost: [],
  check_feasibility: [],
};
const ARG_KEYS: (keyof ToolCallArgs)[] = ['prompt', 'instruction', 'partIds', 'amount', 'enabled', 'densityKgPerM3', 'material'];

export function validateToolCallArgs(call: ToolCall): void {
  const allowed = new Set(TOOL_ALLOWED[call.tool]);
  const required = new Set(TOOL_REQUIRED[call.tool]);
  for (const key of ARG_KEYS) {
    const value = call.args[key];
    if (value !== null && !allowed.has(key)) throw new Error(`工具「${call.tool}」不接受參數 ${key}。`);
    if (value === null && required.has(key)) throw new Error(`工具「${call.tool}」需要參數 ${key}。`);
  }
}

export function validateAgentStep(input: unknown): AgentStep {
  const raw = AgentStepSchema.parse(input);
  if (raw.type === 'tool_calls') {
    if (raw.calls === null || raw.calls.length === 0) throw new Error('tool_calls 必須包含至少一個工具呼叫。');
    if (raw.reply !== null) throw new Error('tool_calls 不可附帶最終回覆。');
    for (const call of raw.calls) validateToolCallArgs(call);
    return { type: 'tool_calls', note: raw.note, calls: raw.calls, reply: null };
  }
  if (raw.reply === null) throw new Error('final 必須提供最終回覆。');
  if (raw.calls !== null) throw new Error('final 不可附帶工具呼叫。');
  // A stray note on a final step is harmless; drop it rather than cost a retry round.
  return { type: 'final', note: null, reply: raw.reply, calls: null };
}

// ----- JSON schema for model-facing structured output -----

export function agentJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AgentStepSchema, { target: 'draft-7' });
  const { $schema: _dialect, ...portable } = schema;
  return portable;
}

// ----- SSE event helpers -----

export const AGENT_EVENTS = ['status', 'tool', 'result', 'state', 'final', 'error', 'done'] as const;
export type AgentEventName = (typeof AGENT_EVENTS)[number];

export function serializeSseEvent(name: AgentEventName, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
