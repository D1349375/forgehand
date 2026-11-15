import { z } from 'zod';
import { PartIdSchema } from './model';
import {
  ObjectIdSchema, ObjectTransformSchema, WorkspaceChangeSchema, WorkspaceError, validateWorkspace,
  type Workspace,
} from './workspace';

/**
 * Agent contract — the Zod authority shared by server and client, mirroring
 * `model.ts` / `edit.ts`. The schema sent to the model is fixed: a strict
 * object (every property `required`, optionals `null`) whose tool calls are
 * `{ tool, argsJson }`, so it does not grow with the tool count. Each tool
 * parses `argsJson` with its own schema in `server/tools/`. `validateAgentStep`
 * then does the type/calls/reply consistency checks a JSON-Schema union could
 * not express portably; it does not check tool names or arguments.
 */

const text = z.string().trim().min(1).max(500);
const partId = PartIdSchema;
/** Part id format, shared with the tools that take part ids as arguments. */
export { PartIdSchema };
const primitive = z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus', 'tube']);

// ----- AgentStep (model-facing) -----

// The step schema does not grow with the tool count: a call is a tool name plus a
// JSON-encoded argument object. The tool registry (server/tools) owns the name
// check and each tool's argument schema; a bad call comes back as a ToolError.
export const ToolCallSchema = z.strictObject({
  tool: z.string().trim().min(1).max(64),
  argsJson: z.string().max(8000),
  reason: z.string().trim().min(1).max(300).nullable(),
});

export const AgentStepSchema = z.strictObject({
  type: z.enum(['tool_calls', 'final']),
  note: z.string().trim().min(1).max(500).nullable(),
  reply: z.string().trim().min(1).max(2000).nullable(),
  calls: z.array(ToolCallSchema).min(1).max(8).nullable(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

// ----- ToolResult -----

/**
 * What a tool changed: a workspace change plus the try-on flag. Sent whole in
 * the `state` event; the `result` event nulls an `add` or `model` object change.
 */
export const StateChangeSchema = z.strictObject({
  ...WorkspaceChangeSchema.shape,
  tryOn: z.boolean().nullable(),
});
export type StateChange = z.infer<typeof StateChangeSchema>;

export const ToolResultSchema = z.strictObject({
  tool: z.string().trim().min(1).max(64),
  ok: z.boolean(),
  summary: z.string().trim().min(1).max(1000),
  // Per-tool detail, validated by the matching detail schema below. NEVER a full ModelSpec.
  detail: z.unknown().nullable(),
  stateChange: StateChangeSchema.nullable(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

// ----- Per-tool detail schemas -----

export const GenerateDesignDetailSchema = z.strictObject({
  source: z.string().min(1).max(100),
  providerModel: z.string().min(1).max(100),
  status: z.enum(['ready', 'approximation', 'unsupported']),
  objectId: ObjectIdSchema.nullable(), // set when the object was added
});
export type GenerateDesignDetail = z.infer<typeof GenerateDesignDetailSchema>;

export const EditDesignDetailSchema = z.strictObject({
  objectId: ObjectIdSchema,
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

export const SelectPartsDetailSchema = z.strictObject({
  objectId: ObjectIdSchema,
  selection: z.array(partId).max(64),
});
export type SelectPartsDetail = z.infer<typeof SelectPartsDetailSchema>;

export const ObjectSummarySchema = z.strictObject({
  id: ObjectIdSchema,
  name: text,
  partCount: z.number().int().nonnegative(),
  position: ObjectTransformSchema.shape.position,
  rotation: ObjectTransformSchema.shape.rotation,
  active: z.boolean(),
});
export type ObjectSummary = z.infer<typeof ObjectSummarySchema>;

export const GetProjectStateDetailSchema = z.strictObject({
  objects: z.array(ObjectSummarySchema).max(8),
  activeObjectId: ObjectIdSchema.nullable(),
  // The object the read describes: the given or the active one. Null on an empty workspace.
  target: z.strictObject({
    objectId: ObjectIdSchema,
    parts: z.array(PartSummarySchema).max(64),
    selection: z.array(partId).max(64),
    explode: z.number().min(0).max(1),
  }).nullable(),
  tryOn: z.boolean(),
});
export type GetProjectStateDetail = z.infer<typeof GetProjectStateDetailSchema>;

export const ExplodeViewDetailSchema = z.strictObject({ objectId: ObjectIdSchema, amount: z.number().min(0).max(1) });
export type ExplodeViewDetail = z.infer<typeof ExplodeViewDetailSchema>;

/** For `set_active_object`, `set_transform` and `remove_object` (Task 7). */
export const ObjectToolDetailSchema = z.strictObject({
  objectId: ObjectIdSchema,
  activeObjectId: ObjectIdSchema.nullable(),
  transform: ObjectTransformSchema.nullable(),
});
export type ObjectToolDetail = z.infer<typeof ObjectToolDetailSchema>;

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
  // A missing key or an explicit `undefined` is a structural error (INVALID_REQUEST).
  // Any other value is checked by `validateWorkspace` in `validateAgentRequest`.
  workspace: z.unknown().refine(value => value !== undefined, { message: 'workspace 為必填。' }),
  tryOn: z.boolean(),
  cameraOn: z.boolean(),
  history: z.array(AgentTurnSchema).max(10),
});

/** Distinguishes request-validation failures so the route can map them to HTTP codes. */
export class AgentRequestError extends Error {
  constructor(public code: 'INVALID_WORKSPACE', message: string) {
    super(message);
    this.name = 'AgentRequestError';
  }
}

export interface AgentRequest {
  instruction: string;
  requestId: string;
  workspace: Workspace;
  tryOn: boolean;
  cameraOn: boolean;
  history: AgentTurn[];
}

/**
 * Parses the request, then validates the workspace with `validateWorkspace`.
 * A workspace failure throws `AgentRequestError('INVALID_WORKSPACE')` with a
 * fixed message (no ids, no schema text); Zod throws for structural failures.
 */
export function validateAgentRequest(input: unknown): AgentRequest {
  const raw = AgentRequestSchema.parse(input);
  let workspace: Workspace;
  try { workspace = validateWorkspace(raw.workspace); }
  catch (error) {
    if (error instanceof WorkspaceError) throw new AgentRequestError('INVALID_WORKSPACE', '目前工作區資料無效，無法處理這次請求。');
    throw error;
  }
  return { ...raw, workspace };
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

export function validateAgentStep(input: unknown): AgentStep {
  const raw = AgentStepSchema.parse(input);
  if (raw.type === 'tool_calls') {
    if (raw.calls === null || raw.calls.length === 0) throw new Error('tool_calls 必須包含至少一個工具呼叫。');
    if (raw.reply !== null) throw new Error('tool_calls 不可附帶最終回覆。');
    // Tool names and argument shapes are checked per tool by runTool (server/agent-tools.ts).
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

// Payloads of the simple events, so the client parses them with the same authority.
// `result` uses ToolResultSchema and `state` uses StateChangeSchema.
export const StatusEventSchema = z.strictObject({ note: z.string().nullable() });
export const UNKNOWN_TOOL_LABEL = '其他步驟';
export const ToolEventSchema = z.strictObject({ tool: z.string().min(1).max(64), label: z.string().min(1).max(40), argsJson: z.string() });
export const FinalEventSchema = z.strictObject({ reply: z.string().min(1) });
export const ErrorEventSchema = z.strictObject({ message: z.string().min(1) });
export type AgentEventName = (typeof AGENT_EVENTS)[number];

export function serializeSseEvent(name: AgentEventName, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
