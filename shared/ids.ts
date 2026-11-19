import { z } from 'zod';

/** Id format for workspace objects and joints. `crypto.randomUUID()` fits. */
export const ObjectIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
