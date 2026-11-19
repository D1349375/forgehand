import { z } from 'zod';
import type { GlueId } from './standard-parts';

/**
 * Material table (assembly-joints design 3.8). One material per object; the
 * ratings are advisory starting points for the checks and recommendations.
 * No density, price or appearance: `materials-analysis` can add those later.
 */

export const MaterialIdSchema = z.enum(['pla', 'petg', 'abs', 'tpu', 'nylon', 'resin', 'aluminium', 'steel']);
export type MaterialId = z.infer<typeof MaterialIdSchema>;

export type Rating = 'good' | 'fair' | 'poor';

export interface Material {
  /** Traditional Chinese label; abbreviations such as PLA are names. */
  label: string;
  process: 'fdm' | 'resin' | 'metal';
  flexible: boolean;
  /** Heat-set inserts suit it. Metal parts are tapped instead. */
  inserts: boolean;
  /** Solvent family: only ABS can be solvent-welded. */
  solvent: 'abs' | null;
  /** How well each glue type bonds it. */
  glue: Record<GlueId, Rating>;
  /** Recorded for a later snap-fit spec; metals are not snap-fit materials. */
  snapFit: Rating;
}

export const MATERIALS: Record<MaterialId, Material> = {
  pla: { label: 'PLA', process: 'fdm', flexible: false, inserts: true, solvent: null, glue: { ca: 'good', epoxy: 'good', solvent: 'poor' }, snapFit: 'poor' },
  petg: { label: 'PETG', process: 'fdm', flexible: false, inserts: true, solvent: null, glue: { ca: 'fair', epoxy: 'good', solvent: 'poor' }, snapFit: 'fair' },
  abs: { label: 'ABS', process: 'fdm', flexible: false, inserts: true, solvent: 'abs', glue: { ca: 'good', epoxy: 'good', solvent: 'good' }, snapFit: 'fair' },
  tpu: { label: 'TPU', process: 'fdm', flexible: true, inserts: false, solvent: null, glue: { ca: 'fair', epoxy: 'poor', solvent: 'poor' }, snapFit: 'good' },
  nylon: { label: '尼龍', process: 'fdm', flexible: false, inserts: true, solvent: null, glue: { ca: 'poor', epoxy: 'fair', solvent: 'poor' }, snapFit: 'good' },
  resin: { label: '樹脂', process: 'resin', flexible: false, inserts: false, solvent: null, glue: { ca: 'good', epoxy: 'good', solvent: 'poor' }, snapFit: 'poor' },
  aluminium: { label: '鋁', process: 'metal', flexible: false, inserts: false, solvent: null, glue: { ca: 'fair', epoxy: 'good', solvent: 'poor' }, snapFit: 'poor' },
  steel: { label: '鋼', process: 'metal', flexible: false, inserts: false, solvent: null, glue: { ca: 'fair', epoxy: 'good', solvent: 'poor' }, snapFit: 'poor' },
};
