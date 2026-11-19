import { z } from 'zod';
import type { MaterialId } from './materials';

/**
 * Printer profile and printed sizes (assembly-joints requirements 17 and 18,
 * design 3.10). All values are millimetres. The profile is a browser setting,
 * not workspace data; these are the only functions where it meets a nominal size.
 */

export const PrinterProfileSchema = z.strictObject({
  slidingFit: z.number().min(0).max(1), // gap per side for a part that should slide in
  pressFit: z.number().min(0).max(0.5), // gap per side for a part that should press in
  holeCompensation: z.number().min(0).max(1), // added to the diameter of every printed hole
  depthAllowance: z.number().min(0).max(1), // added to the depth of every blind printed hole and pocket
  petgExtra: z.number().min(0).max(0.5), // added per side to fits in PETG parts
});

export type PrinterProfile = z.infer<typeof PrinterProfileSchema>;

/** Starting points that follow common FDM guidance, not promises: tune them with a printed tolerance test. */
export const DEFAULT_PRINTER_PROFILE: PrinterProfile = Object.freeze({
  slidingFit: 0.25,
  pressFit: 0.10,
  holeCompensation: 0.20,
  depthAllowance: 0.20,
  petgExtra: 0.05,
});

/** Fit class of a feature: `none` means the nominal size already is the fit. */
export type Fit = 'none' | 'press' | 'sliding';

/** Sizes are quoted to 0.01 mm. */
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Diameter to model for a printed hole: nominal + `holeCompensation` +
 * 2 x (fit allowance + `petgExtra` for a fit in a PETG part), rounded to 0.01.
 */
export function printedDiameter(nominalMm: number, fit: Fit, profile: PrinterProfile, material: MaterialId | null): number {
  const allowance = fit === 'press' ? profile.pressFit : fit === 'sliding' ? profile.slidingFit : 0;
  const petg = material === 'petg' && fit !== 'none' ? profile.petgExtra : 0;
  return round2(nominalMm + profile.holeCompensation + 2 * (allowance + petg));
}

/** Depth to model for a blind printed hole or pocket: nominal + `depthAllowance`, rounded to 0.01. */
export function printedDepth(nominalMm: number, profile: PrinterProfile): number {
  return round2(nominalMm + profile.depthAllowance);
}
