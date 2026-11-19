import { z } from 'zod';

/**
 * Standard parts for joints (assembly-joints requirements 14 and 15, design 3.9).
 * All sizes are millimetres. Every number has its source next to it; the unit test
 * `tests/unit/joint-data.test.ts` pins them, so a change is deliberate and reviewed.
 *
 * `design-fidelity` shares this module (requirement 16): add entries here instead
 * of creating a second table.
 */

export const ThreadSchema = z.enum(['M2', 'M3']);
export const MagnetIdSchema = z.enum(['d6x2', 'd6x3', 'd8x3', 'd10x2', 'd10x3']);
export const PinIdSchema = z.enum(['d2', 'd3', 'd4']);
export const GlueIdSchema = z.enum(['ca', 'epoxy', 'solvent']);

export type Thread = z.infer<typeof ThreadSchema>;
export type MagnetId = z.infer<typeof MagnetIdSchema>;
export type PinId = z.infer<typeof PinIdSchema>;
export type GlueId = z.infer<typeof GlueIdSchema>;

export interface InsertSpec {
  /** Insert length. */
  lengthMm: number;
  /** Outer diameter of the knurled body. */
  outerMm: number;
  /** Recommended hole diameter in the host part. */
  holeMm: number;
  vendor: 'CNC Kitchen';
  label: string;
}

/**
 * Heat-set inserts, CNC Kitchen standard versions.
 * CNC Kitchen notes that printed holes come out smaller than designed, so the
 * recommended hole often fits tightly; the printer profile's hole compensation covers that:
 * https://cnckitchen.com/blog/are-our-heat-set-insert-datasheets-wrong
 */
export const INSERTS: Record<Thread, InsertSpec> = {
  M2: {
    // Product page: https://cnckitchen.store/products/heat-set-insert-m2-x-3-100-pieces (length 3.0 mm)
    lengthMm: 3.0,
    // Outer 3.6 (and hole 3.2, tip 3.1, minimum wall 1.3): retailer spec table for CNC Kitchen M2 x 3.0 standard,
    // https://west3d.com/products/cnc-kitchen-heat-set-inserts-various-sizes (checked by the reviewer, 2026-11-20)
    outerMm: 3.6,
    // Hole for 3.2 mm: https://kb-3d.com/store/inserts-fasteners-adhesives/927-9848-cnckitchen-lead-cadmium-free-heat-set-inserts-multiple-sizes-metric.html (retailer list "M2 x 3mm - For 3.2mm holes")
    holeMm: 3.2,
    vendor: 'CNC Kitchen',
    label: 'M2×3 熱壓螺母',
  },
  M3: {
    // Length 5.7 and hole 4.0: https://cnckitchen.com/blog/are-our-heat-set-insert-datasheets-wrong (datasheet recommends 4.0 mm for M3; knurl outer diameter 4.6 mm)
    // and https://kb-3d.com/store/inserts-fasteners-adhesives/927-9848-cnckitchen-lead-cadmium-free-heat-set-inserts-multiple-sizes-metric.html ("M3 x 5.7mm - For 4mm holes")
    lengthMm: 5.7,
    // Outer 4.6: https://www.flux.ai/p/blog/heat-set-inserts-hole-size-pcb-mounting (quotes the CNC Kitchen drawing: 4.0 mm hole, 4.6 mm outside diameter)
    // and https://cnckitchen.com/blog/are-our-heat-set-insert-datasheets-wrong (4.6 mm is the knurling's outer diameter)
    outerMm: 4.6,
    holeMm: 4.0,
    vendor: 'CNC Kitchen',
    label: 'M3×5.7 熱壓螺母',
  },
};

export interface ScrewSpec {
  /** Head diameter, ISO 4762. */
  headMm: number;
  /** Head height, ISO 4762. */
  headHeightMm: number;
  /** Standard lengths offered, under the head. */
  lengthsMm: readonly number[];
  /** Clearance hole, ISO 273 medium series. */
  clearanceMm: number;
  /** Tap drill for the metric coarse thread (metal parts). */
  tapDrillMm: number;
}

/**
 * Socket head cap screws, ISO 4762.
 * Head diameter and height, and the length lists (the standard lists more; these are the ones the kit offers):
 * https://www.engineersedge.com/iso_socket_head_screw.htm (M2: 3.8 / 2.0, lengths 3, 4, 5, 6 to 12 by 2, 16, 20; M3: 5.5 / 3.0, lengths 5, 6 to 12 by 2, 16, 20, 25, 30)
 * Clearance (ISO 273 medium: M2 2.4, M3 3.4) and tap drill (M2 1.6, M3 2.5):
 * https://www.baouch.fr/telechargements/en/metric-thread-tap-drill-chart.pdf
 * ISO 273 clearance holes medium: M3 3.4 also in https://www.flux.ai/p/blog/heat-set-inserts-hole-size-pcb-mounting
 */
export const SCREWS: Record<Thread, ScrewSpec> = {
  M2: {
    headMm: 3.8,
    headHeightMm: 2.0,
    lengthsMm: [4, 5, 6, 8, 10, 12, 16, 20],
    clearanceMm: 2.4,
    tapDrillMm: 1.6,
  },
  M3: {
    headMm: 5.5,
    headHeightMm: 3.0,
    // The ISO 4762 table starts M3 at 5 mm, so 4 is not offered (reviewer decision, 2026-11-20).
    lengthsMm: [5, 6, 8, 10, 12, 16, 20, 25, 30],
    clearanceMm: 3.4,
    tapDrillMm: 2.5,
  },
};

export interface MagnetSpec {
  diameterMm: number;
  thicknessMm: number;
}

/**
 * Neodymium disc magnets, diameter x thickness. Sizes from the supermagnete data sheets:
 * https://www.supermagnete.de/eng/data_sheet_S-06-02-N.pdf (6 x 2)
 * https://www.supermagnete.fr/eng/data_sheet_S-06-03-N.pdf (6 x 3)
 * https://www.supermagnete.fr/eng/data_sheet_S-08-03-N.pdf (8 x 3)
 * https://www.supermagnete.fr/eng/data_sheet_S-10-02-N.pdf (10 x 2)
 * https://www.supermagnete.de/eng/data_sheet_S-10-03-N.pdf (10 x 3)
 */
export const MAGNETS: Record<MagnetId, MagnetSpec> = {
  d6x2: { diameterMm: 6, thicknessMm: 2 },
  d6x3: { diameterMm: 6, thicknessMm: 3 },
  d8x3: { diameterMm: 8, thicknessMm: 3 },
  d10x2: { diameterMm: 10, thicknessMm: 2 },
  d10x3: { diameterMm: 10, thicknessMm: 3 },
};

export interface PinSpec {
  diameterMm: number;
  /** Standard lengths offered for this diameter. */
  lengthsMm: readonly number[];
}

/**
 * Dowel pins, ISO 8734. Diameters 2, 3 and 4. The commercial length table
 * (https://www.fasten.it/fr/norms/norm/din_en_iso_8734, also https://www.engineersedge.com/hardware/iso_metric_dowel_pins_13805.htm)
 * offers d2 from 5 mm, d3 from 8 mm and d4 from 10 mm. Requirement 15 lists 6 to 20 mm for all three,
 * which includes 3x6, 4x6 and 4x8 that the standard does not list; each diameter gets only the listed lengths from 6 to 20 mm.
 */
export const PINS: Record<PinId, PinSpec> = {
  d2: { diameterMm: 2, lengthsMm: [6, 8, 10, 12, 16, 20] },
  d3: { diameterMm: 3, lengthsMm: [8, 10, 12, 16, 20] },
  d4: { diameterMm: 4, lengthsMm: [10, 12, 16, 20] },
};

export interface GlueSpec {
  /** Traditional Chinese label. */
  label: string;
}

/** The three glues; how well each bonds a material is in `MATERIALS`. */
export const GLUES: Record<GlueId, GlueSpec> = {
  ca: { label: '瞬間膠' },
  epoxy: { label: 'AB 膠' },
  solvent: { label: '溶劑黏合' },
};
