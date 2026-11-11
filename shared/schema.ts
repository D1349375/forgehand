import { z } from 'zod';
import { EditPlanSchema } from './edit';
import { GeneratedDesignSchema } from './model';

// A single schema drives both providers. Zod remains the authority and also
// validates semantic relationships after the response has been decoded.
export function designJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(GeneratedDesignSchema, { target: 'draft-7' });
  const { $schema: _dialect, ...portable } = schema;
  return portable;
}

/** Edit plans use the same portable draft-7 form as designs. */
export function editJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(EditPlanSchema, { target: 'draft-7' });
  const { $schema: _dialect, ...portable } = schema;
  return portable;
}
