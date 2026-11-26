import { z } from 'zod';
import { ObjectIdSchema } from './ids';
import { PartIdSchema, type Part } from './model';
import { GlueIdSchema, MagnetIdSchema, PinIdSchema, ThreadSchema } from './standard-parts';

/**
 * Joint data (assembly-joints requirements 3, 4 and 21, design 3.1). A joint
 * stores only choices; positions, hole sizes and lengths are derived later from
 * the geometry, the standard-parts table and the printer profile.
 */

export const FaceIdSchema = z.enum(['+x', '-x', '+y', '-y', '+z', '-z']);

/** One side of a joint. The face is named in the part's own axes. */
export const JointSideSchema = z.strictObject({ objectId: ObjectIdSchema, partId: PartIdSchema, face: FaceIdSchema });

export const JointMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('screw-insert'), size: ThreadSchema, count: z.number().int().min(1).max(4), insertSide: z.enum(['a', 'b']) }),
  z.strictObject({ kind: z.literal('magnet'), magnet: MagnetIdSchema, count: z.number().int().min(1).max(4) }),
  z.strictObject({ kind: z.literal('pin'), pin: PinIdSchema, count: z.number().int().min(1).max(4), fit: z.enum(['press-both', 'press-slide']) }),
  z.strictObject({ kind: z.literal('glue'), glue: GlueIdSchema }),
]);

export const JointNeedsSchema = z.strictObject({
  load: z.enum(['light', 'medium', 'heavy']).nullable(),
  disassembly: z.enum(['never', 'sometimes', 'often']).nullable(),
});

export const JointSchema = z.strictObject({
  id: ObjectIdSchema,
  a: JointSideSchema,
  b: JointSideSchema,
  method: JointMethodSchema,
  needs: JointNeedsSchema,
  confirmed: z.boolean(), // the user chose or accepted the method
  createdAt: z.iso.datetime(),
});

export const MAX_JOINTS = 32;

export type FaceId = z.infer<typeof FaceIdSchema>;
export type JointSide = z.infer<typeof JointSideSchema>;
export type JointMethod = z.infer<typeof JointMethodSchema>;
export type JointNeeds = z.infer<typeof JointNeedsSchema>;
export type Joint = z.infer<typeof JointSchema>;

export type FaceShape = 'rect' | 'disc' | 'ring';

/**
 * Contact faces per primitive, named in the part's own axes. Only flat faces
 * count. A `Record` over the primitive enum: when `design-fidelity` adds `shell`,
 * the type check fails until a `shell` row (as box) is added, which is the intended reminder.
 */
export const CONTACT_FACES: Record<Part['primitive'], Partial<Record<FaceId, FaceShape>>> = {
  box: { '+x': 'rect', '-x': 'rect', '+y': 'rect', '-y': 'rect', '+z': 'rect', '-z': 'rect' },
  cylinder: { '+y': 'disc', '-y': 'disc' },
  cone: { '-y': 'disc' },
  tube: { '+y': 'ring', '-y': 'ring' },
  shell: { '+x': 'rect', '-x': 'rect', '+y': 'rect', '-y': 'rect', '+z': 'rect', '-z': 'rect' },
  sphere: {},
  torus: {},
};

/** Traditional Chinese face labels for the user. */
export const FACE_LABELS: Record<FaceId, string> = {
  '+x': '右面',
  '-x': '左面',
  '+y': '頂面',
  '-y': '底面',
  '+z': '前面',
  '-z': '後面',
};

/** Shape of a part's face, or `null` when the face is not a contact face. */
export function faceShape(primitive: Part['primitive'], face: FaceId): FaceShape | null {
  return CONTACT_FACES[primitive][face] ?? null;
}

/** Whether a face shape can carry a joint method: a tube's ring takes glue only. */
export function faceAllows(shape: FaceShape, method: JointMethod): boolean {
  return shape !== 'ring' || method.kind === 'glue';
}
