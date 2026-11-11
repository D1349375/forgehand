import { z } from 'zod';

const text = z.string().trim().min(1).max(500);
const vector = (scalar: z.ZodNumber) => z.strictObject({ x: scalar, y: scalar, z: scalar });

export const PartSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  name: text,
  parentId: z.string().max(64).nullable(),
  primitive: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus', 'tube']),
  dimensions: vector(z.number().min(0.001).max(100)),
  position: vector(z.number().min(-100).max(100)),
  rotation: vector(z.number().min(-360).max(360)),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  role: z.enum(['exterior', 'interior']),
  tubeRatio: z.number().min(0.05).max(0.95),
});

// Keep the API JSON schema free of refinements. Apply semantic checks below
// after structured output parsing, and again before constructing any geometry.
export const ModelSpecSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  name: text,
  summary: z.string().trim().min(1).max(2000),
  units: z.literal('m'),
  assumptions: z.array(text).max(20),
  parts: z.array(PartSchema).min(1).max(64),
});

export const GeneratedDesignSchema = z.strictObject({
  status: z.enum(['ready', 'approximation', 'unsupported']),
  explanation: z.string().trim().min(1).max(2000),
  model: ModelSpecSchema.nullable(),
});

export type Part = z.infer<typeof PartSchema>;
export type ModelSpec = z.infer<typeof ModelSpecSchema>;
export type GeneratedDesign = z.infer<typeof GeneratedDesignSchema>;

export interface GenerationResult {
  design: GeneratedDesign;
  source: 'codex' | 'claude' | 'openai';
  model: string;
  elapsedMs: number;
  requestId: string;
}

export const GenerationResultSchema = z.strictObject({
  design: GeneratedDesignSchema,
  source: z.enum(['codex', 'claude', 'openai']),
  model: z.string().min(1).max(100),
  elapsedMs: z.number().nonnegative(),
  requestId: z.string().min(1).max(100),
});

export function validateModel(input: unknown): ModelSpec {
  const model = ModelSpecSchema.parse(input);
  const byId = new Map<string, Part>();
  for (const part of model.parts) {
    if (byId.has(part.id)) throw new Error(`重複零件 ID：${part.id}`);
    byId.set(part.id, part);
  }
  for (const part of model.parts) {
    const visited = new Set<string>([part.id]);
    let parentId = part.parentId;
    let depth = 0;
    while (parentId !== null) {
      if (visited.has(parentId)) throw new Error('零件階層不可循環');
      const parent = byId.get(parentId);
      if (!parent) throw new Error(`找不到父零件：${parentId}`);
      visited.add(parentId);
      if (++depth > 12) throw new Error('零件階層不可超過 12 層');
      parentId = parent.parentId;
    }
  }
  return model;
}

export function validateDesign(input: unknown): GeneratedDesign {
  const design = GeneratedDesignSchema.parse(input);
  if (design.status === 'unsupported') {
    if (design.model !== null) throw new Error('不支援的描述不可附帶可用模型');
  } else {
    if (design.model === null) throw new Error('可建立的描述必須提供模型');
    design.model = validateModel(design.model);
  }
  return design;
}

export function validateGenerationResult(input: unknown): GenerationResult {
  const result = GenerationResultSchema.parse(input);
  result.design = validateDesign(result.design);
  return result;
}
