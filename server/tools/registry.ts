import { z } from 'zod';
import type { ToolResult } from '../../shared/agent';
import type { AgentWorkingState } from '../agent-tools';
import type { ModelProvider } from '../provider';

/**
 * Tool registry (design §5, VISION §4.3). A tool is defined once with
 * `defineTool`; the registry then drives dispatch (`getTool`) and the tool list
 * in `AGENT_INSTRUCTIONS` (`listTools` + `argsShapeText`).
 */

export type ToolSide = 'server' | 'client';
export type ToolScope = 'project' | 'home';
export type ToolEffects =
  | 'read-only' | 'writes-scene' | 'writes-project' | 'writes-memory'
  | 'uses-camera' | 'sends-image' | 'long-running';

export interface ToolContext {
  /** Read-only view for the tool: the loop, not the tool, applies `stateChange`. */
  state: AgentWorkingState;
  provider: ModelProvider;
  /** A fresh object id. Defaults to `crypto.randomUUID()`; tests inject a counter. */
  newObjectId(): string;
  /** The current time as an ISO string. Defaults to `new Date().toISOString()`; tests inject a fixed time. */
  now(): string;
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  /** Short Traditional Chinese name (1–40 characters) shown in the UI instead of the tool name. */
  label: string;
  category: string;
  /** One line shown to the model after `name(args):` in the generated tool list. */
  description: string;
  /** Validates the JSON-parsed `argsJson`. Use `z.strictObject` so stray keys are rejected. */
  args: z.ZodType<TArgs>;
  side: ToolSide;
  scope: ToolScope;
  effects: ToolEffects;
  run(args: TArgs, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult>;
}

export interface ToolRegistry {
  defineTool<TArgs>(definition: ToolDefinition<TArgs>): ToolDefinition<TArgs>;
  getTool(name: string): ToolDefinition | undefined;
  /** Registration order is preserved; omitted filters match everything. */
  listTools(filter?: { scope?: ToolScope; side?: ToolSide }): ToolDefinition[];
}

/** A separate registry per call, so tests can register tools without touching the shared one. */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  return {
    defineTool(definition) {
      if (tools.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
      if (definition.label.length < 1 || definition.label.length > 40) {
        throw new Error(`Tool label must be 1-40 characters: ${definition.name}`);
      }
      tools.set(definition.name, definition as ToolDefinition<unknown>);
      return definition;
    },
    getTool: name => tools.get(name),
    listTools: ({ scope, side } = {}) => [...tools.values()].filter(tool =>
      (scope === undefined || tool.scope === scope) && (side === undefined || tool.side === side)),
  };
}

const defaultRegistry = createToolRegistry();
export const defineTool = defaultRegistry.defineTool;
export const getTool = defaultRegistry.getTool;
export const listTools = defaultRegistry.listTools;

/**
 * A short argument signature for the model, such as `partIds: string[]`, built
 * from the tool's own schema so the instructions cannot drift from validation.
 * Returns an empty string for a tool without arguments.
 */
export function argsShapeText(schema: z.ZodType): string {
  const json = inputJsonSchema(schema);
  const properties = json.properties ?? {};
  const required = new Set(json.required ?? []);
  return Object.entries(properties)
    .map(([key, node]) => `${key}${required.has(key) ? '' : '?'}: ${typeText(node)}`)
    .join(', ');
}

/** The argument names a tool's schema declares. */
export function argKeys(schema: z.ZodType): string[] {
  return Object.keys(inputJsonSchema(schema).properties ?? {});
}

function inputJsonSchema(schema: z.ZodType): JsonSchemaNode {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as JsonSchemaNode;
}

interface JsonSchemaNode {
  type?: string | string[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  anyOf?: JsonSchemaNode[];
}

function typeText(node: JsonSchemaNode): string {
  if (node.anyOf) return node.anyOf.map(typeText).join(' | ');
  const type = Array.isArray(node.type) ? node.type.join(' | ') : node.type;
  if (type === 'array') return `${node.items ? typeText(node.items) : 'unknown'}[]`;
  return type ?? 'unknown';
}
