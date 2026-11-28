import { z } from 'zod';
import { localized, type Localized } from './i18n/define';
import { REFERENCE_LABELS } from './i18n/fidelity';
import type { Part } from './model';

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

// ----- Reference parts (design-fidelity requirements 25 to 29) -----

/** The group a reference part belongs to; it only orders and describes the table. */
export type ReferenceCategory = 'battery' | 'board' | 'fastener' | 'connector' | 'actuator' | 'input' | 'light' | 'audio' | 'module' | 'mechanical' | 'wall';

/** The ids of the reference parts, in table order (the order of `referenceLines`). Keys of `REFERENCE_LABELS` match them. */
export const REFERENCE_PART_IDS = [
  'cell-18650', 'cell-aa', 'cell-cr2032', 'cell-lipo-402030', 'pcb-1-6', 'screw-m2', 'screw-m3', 'standoff-m2', 'standoff-m3',
  'usb-c-receptacle', 'motor-coin-10', 'switch-tact-6', 'led-5', 'speaker-40', 'module-wireless', 'module-camera', 'thumbstick',
  'bearing-608', 'motor-bldc-22', 'wall-moulded-plastic', 'wall-fdm', 'wall-aluminium',
] as const;
export const ReferencePartIdSchema = z.enum(REFERENCE_PART_IDS);
export type ReferencePartId = z.infer<typeof ReferencePartIdSchema>;

export interface ReferencePart {
  id: ReferencePartId;
  /** The generic name in both languages (never a brand or a product); see `REFERENCE_LABELS`. */
  label: Localized;
  /** One English line for the instructions: what it is and what the size means. */
  description: string;
  category: ReferenceCategory;
  /** The suggested primitive; null for a wall entry, which has no shape of its own. */
  primitive: Part['primitive'] | null;
  /**
   * The outer envelope in millimetres in the part's own axes, as `src/scene/geometry.ts` builds them: a
   * cylinder or tube is round in x and z and long in y, a box has width x, height y and depth z. Null when the
   * size depends on the design (a circuit board's width and depth) or for a wall entry.
   */
  sizeMm: { x: number; y: number; z: number } | null;
  /**
   * A wall or board thickness in millimetres. `min` is always stated by the source; `typical` and `max` are null
   * when the source does not state them (never filled in from elsewhere).
   */
  wallMm: { min: number; typical: number | null; max: number | null } | null;
  /** The https URL of the document the numbers were read from. */
  sourceUrl: string;
  /** What was read: the document, the table, drawing or line. */
  source: string;
  /** The ISO date the numbers were read from the source. */
  checked: string;
}

const labelOf = (id: ReferencePartId): Localized => localized(REFERENCE_LABELS['zh-TW'][id], REFERENCE_LABELS.en[id]);
/** The page the screw numbers of `SCREWS` come from (see the comment above `SCREWS`). */
const SCREW_SOURCE_URL = 'https://www.engineersedge.com/iso_socket_head_screw.htm';
const CHECKED = '2026-11-28';

/**
 * Typical components and wall thicknesses with published dimensions. Every value was read from the document
 * named in `sourceUrl` on the date in `checked`; nothing here comes from memory. The reviewer's notes are in
 * `.kiro/specs/design-fidelity/reference-sources.md`; `tests/unit/reference-parts.test.ts` pins every number.
 * A cylinder is `{ x: diameter, y: length, z: diameter }`; a box lies flat with its thickness in y.
 */
export const REFERENCE_PARTS: Record<ReferencePartId, ReferencePart> = {
  'cell-18650': {
    id: 'cell-18650', label: labelOf('cell-18650'), category: 'battery', primitive: 'cylinder',
    description: 'bare cylindrical lithium cell, maximum diameter and length',
    sizeMm: { x: 18.5, y: 65.3, z: 18.5 }, wallMm: null,
    sourceUrl: 'https://www.batteryspace.com/prod-specs/NCR18650B.pdf',
    source: 'Panasonic NCR18650B datasheet (distributor-hosted copy), page 1, Dimensions drawing: Max. 18.5 mm and Max. 65.3 mm; version 13.11 R1.',
    checked: CHECKED,
  },
  'cell-aa': {
    id: 'cell-aa', label: labelOf('cell-aa'), category: 'battery', primitive: 'cylinder',
    description: 'AA (LR6) cell, maximum diameter and length',
    sizeMm: { x: 14.5, y: 50.5, z: 14.5 }, wallMm: null,
    sourceUrl: 'https://www.farnell.com/datasheets/1960166.pdf',
    source: 'Energizer Industrial LR6 (AA) datasheet (distributor-hosted copy), page 1, Industry Standard Dimensions: 14.50 and 50.50 mm.',
    checked: CHECKED,
  },
  'cell-cr2032': {
    id: 'cell-cr2032', label: labelOf('cell-cr2032'), category: 'battery', primitive: 'cylinder',
    description: 'coin cell, maximum diameter and height',
    sizeMm: { x: 20.0, y: 3.2, z: 20.0 }, wallMm: null,
    sourceUrl: 'https://energy.panasonic.com/dam/master/pdf/en/datasheet/lithium/CR2032_Datasheet_EN.pdf',
    source: 'Panasonic CR2032 datasheet, page 1, Dimensions: Diameter (Max.) 20.0 mm, Height (Max.) 3.2 mm; as of February 2026.',
    checked: CHECKED,
  },
  'cell-lipo-402030': {
    id: 'cell-lipo-402030', label: labelOf('cell-lipo-402030'), category: 'battery', primitive: 'box',
    description: 'flat lithium-polymer pouch cell of type 402030 with solder tabs, lying flat (width x, thickness y, length z); vendors differ slightly',
    sizeMm: { x: 20.5, y: 4.3, z: 32.0 }, wallMm: null,
    sourceUrl: 'https://www.eemb.com/product-247',
    source: 'EEMB 402030 product page, Size: 20.5 mm x 32.00 mm x 4.30 mm (W x L x H). The page does not say whether the length includes a protection board. The type code 4.0 x 20 x 30 is only nominal.',
    checked: CHECKED,
  },
  'pcb-1-6': {
    id: 'pcb-1-6', label: labelOf('pcb-1-6'), category: 'board', primitive: 'box',
    description: 'FR4 circuit board: the thickness is standard, the width and depth follow the design; use the thickness for the y dimension',
    sizeMm: null, wallMm: { min: 0.4, typical: 1.6, max: 2.0 },
    sourceUrl: 'https://jlcpcb.com/capabilities/pcb-capabilities',
    source: 'JLCPCB PCB capabilities, PCB Specifications, Thickness row: FR4 thicknesses 0.4 / 0.6 / 0.8 / 1.0 / 1.2 / 1.6 / 2.0 mm. The page lists 1.6 mm among the standard thicknesses; the typical value is the choice made in reference-sources.md.',
    checked: CHECKED,
  },
  'screw-m2': {
    id: 'screw-m2', label: labelOf('screw-m2'), category: 'fastener', primitive: 'cylinder',
    description: 'ISO 4762 socket head cap screw, head only (head diameter x head height)',
    sizeMm: { x: SCREWS.M2.headMm, y: SCREWS.M2.headHeightMm, z: SCREWS.M2.headMm }, wallMm: null,
    sourceUrl: SCREW_SOURCE_URL,
    source: 'The numbers of SCREWS.M2 in this file (ISO 4762 head diameter and height, see the comment above SCREWS); not copied.',
    checked: CHECKED,
  },
  'screw-m3': {
    id: 'screw-m3', label: labelOf('screw-m3'), category: 'fastener', primitive: 'cylinder',
    description: 'ISO 4762 socket head cap screw, head only (head diameter x head height)',
    sizeMm: { x: SCREWS.M3.headMm, y: SCREWS.M3.headHeightMm, z: SCREWS.M3.headMm }, wallMm: null,
    sourceUrl: SCREW_SOURCE_URL,
    source: 'The numbers of SCREWS.M3 in this file (ISO 4762 head diameter and height, see the comment above SCREWS); not copied.',
    checked: CHECKED,
  },
  'standoff-m2': {
    id: 'standoff-m2', label: labelOf('standoff-m2'), category: 'fastener', primitive: 'cylinder',
    description: 'brass hex spacer with internal thread, 4.0 mm across flats (x and z), length 10 mm (y); the series has lengths 5, 6, 8, 10, 12 and 15 mm',
    sizeMm: { x: 4.0, y: 10, z: 4.0 }, wallMm: null,
    sourceUrl: 'https://www.we-online.com/components/products/datasheet/970100244.pdf',
    source: 'Wurth Elektronik WA-SBRII brass spacer 970100244, page 1 of 3, Article Properties: Length L 10 mm, Inner Thread M2, Wrench SW 4; revision 001.003. Series lengths from the family page "M2, SW 4, 5 to 15 mm".',
    checked: CHECKED,
  },
  'standoff-m3': {
    id: 'standoff-m3', label: labelOf('standoff-m3'), category: 'fastener', primitive: 'cylinder',
    description: 'hex spacer with internal thread, 5.5 mm across flats (x and z), length 8 mm (y); the 5.5 mm brass line runs from 5 to 45 mm',
    sizeMm: { x: 5.5, y: 8, z: 5.5 }, wallMm: null,
    sourceUrl: 'https://www.we-online.com/components/products/datasheet/970080321.pdf',
    source: 'Wurth Elektronik WA-SSTII steel spacer 970080321, page 1 of 3, Article Properties: Length L 8 mm, Inner Thread M3, Wrench SW 5.5; revision 001.003 (2022-06-01). The brass WA-SBRII M3 SW 5.5 line runs 5 to 45 mm.',
    checked: CHECKED,
  },
  'usb-c-receptacle': {
    id: 'usb-c-receptacle', label: labelOf('usb-c-receptacle'), category: 'connector', primitive: 'box',
    description: 'surface-mount (top-mount) USB-C receptacle body (width x, height y, depth z, tolerance 0.15 mm); the plug opening in the enclosure is 8.34 x 2.56 mm',
    sizeMm: { x: 8.94, y: 3.31, z: 7.35 }, wallMm: null,
    sourceUrl: 'https://gct.co/files/drawings/usb4105.pdf',
    source: 'GCT USB4105 drawing, sheet 1 of 2, revision B4: 8.94, 7.35 and 3.31 mm (tolerance 0.15). The opening 8.34 x 2.56 mm is from the USB Type-C Cable and Connector Specification Release 1.2, Figure 3-1 (SHELL OPENING 8.34, SHELL 2.56), read in a third-party copy at https://mikrocontroller.net/attachment/322860/USB_Type-C_Specification_Release_1.2.pdf.',
    checked: CHECKED,
  },
  'motor-coin-10': {
    id: 'motor-coin-10', label: labelOf('motor-coin-10'), category: 'actuator', primitive: 'cylinder',
    description: 'flat (coin) vibration motor, body diameter and body length',
    sizeMm: { x: 10, y: 2.7, z: 10 }, wallMm: null,
    sourceUrl: 'https://precisionmicrodrives.com/cdn/catalog_product/89437681-576e-46e1-97cf-5ae185adeb1c/310-103-datasheet.pdf',
    source: 'Precision Microdrives 310-103 datasheet, page 3, Physical specification: Body Diameter 10 mm (+/- 0.1), Body Length 2.7 mm (+/- 0.1); R002-V011.',
    checked: CHECKED,
  },
  'switch-tact-6': {
    id: 'switch-tact-6', label: labelOf('switch-tact-6'), category: 'input', primitive: 'box',
    description: 'tactile switch, 6 x 6 mm footprint, height including the plunger (y)',
    sizeMm: { x: 6.0, y: 4.3, z: 6.0 }, wallMm: null,
    sourceUrl: 'https://omronfs.omron.com/en_US/ecb/products/pdf/en-b3f.pdf',
    source: 'Omron B3F datasheet, Dimensions, 6 x 6 mm models with the standard flat plunger (B3F-1000): 6 +/- 0.2, 6 +/- 0.2, 4.3 +/- 0.2; Cat. No. A070-E1-08.',
    checked: CHECKED,
  },
  'led-5': {
    id: 'led-5', label: labelOf('led-5'), category: 'light', primitive: 'cylinder',
    description: 'T-1 3/4 LED lamp: the diameter is the flange (the body is 5.0 mm), the height is above the leads',
    sizeMm: { x: 5.9, y: 8.6, z: 5.9 }, wallMm: null,
    sourceUrl: 'https://www.komponenten.es.aau.dk/fileadmin/komponenten/Data_Sheet/LCD/5mmLOWLED.pdf',
    source: 'Kingbright L-53L T-1 3/4 (5 mm) Low Current LED Lamps datasheet (university-hosted copy), page 1, Package Dimensions drawing: 5 (body), 5.9 (flange) and 8.6 mm, read from the drawing image.',
    checked: CHECKED,
  },
  'speaker-40': {
    id: 'speaker-40', label: labelOf('speaker-40'), category: 'audio', primitive: 'cylinder',
    description: 'round speaker driver, diameter and depth',
    sizeMm: { x: 40, y: 9.3, z: 40 }, wallMm: null,
    sourceUrl: 'https://www.sameskydevices.com/product/resource/gf0401m.pdf',
    source: 'Same Sky (formerly CUI Devices) GF0401M datasheet, page 1, Specifications: dimensions diameter 40 x 9.3 mm; rev 1.05, 2024-09-11.',
    checked: CHECKED,
  },
  'module-wireless': {
    id: 'module-wireless', label: labelOf('module-wireless'), category: 'module', primitive: 'box',
    description: 'ESP32-class Wi-Fi and Bluetooth module, lying flat (width x, thickness y, length z)',
    sizeMm: { x: 18.0, y: 3.1, z: 25.5 }, wallMm: null,
    sourceUrl: 'https://documentation.espressif.com/esp32-wroom-32e_esp32-wroom-32ue_datasheet_en.pdf',
    source: 'Espressif ESP32-WROOM-32E datasheet v2.1, ordering table (page 3), ESP32-WROOM-32E-N8: 18.0 x 25.5 x 3.1 mm, and Figure 10.1 Module Dimensions (page 40).',
    checked: CHECKED,
  },
  'module-camera': {
    id: 'module-camera', label: labelOf('module-camera'), category: 'module', primitive: 'box',
    description: 'small camera board with lens, lying flat (width x, height including the lens y, depth z); the wide variants are 12.4 mm high',
    sizeMm: { x: 25, y: 11.5, z: 24 }, wallMm: null,
    sourceUrl: 'https://pip-assets.raspberrypi.com/categories/786-raspberry-pi-camera-module-3/documents/RP-008151-DS-1-camera-module-3-product-brief.pdf',
    source: 'Raspberry Pi Camera Module 3 product brief RP-008151-DS-1, specification list: Dimensions 25 x 24 x 11.5 mm (12.4 mm height for Wide variants).',
    checked: CHECKED,
  },
  thumbstick: {
    id: 'thumbstick', label: labelOf('thumbstick'), category: 'input', primitive: 'box',
    description: 'analog thumbstick module body (width x, body height y, depth z); the lever above the frame is not included',
    sizeMm: { x: 17.8, y: 11.2, z: 21.3 }, wallMm: null,
    sourceUrl: 'https://www.alpsalpine.com/cms.media/product_catalog_mu_01_rkjxv_en_05974b8a16.pdf',
    source: 'ALPS ALPINE RKJXV catalogue (update 2510), Product List, RKJXV1220001: 17.8 x 21.3 x 11.2 mm, banner "body height of 11.2 mm". The lever height was not verified.',
    checked: CHECKED,
  },
  'bearing-608': {
    id: 'bearing-608', label: labelOf('bearing-608'), category: 'mechanical', primitive: 'tube',
    description: 'deep groove ball bearing with 22 mm outer diameter, 8 mm bore and 7 mm width (y); set tubeRatio to bore / outer diameter',
    sizeMm: { x: 22, y: 7, z: 22 }, wallMm: null,
    sourceUrl: 'https://www.nbcbearings.com/ball-bearings/deep-groove-ball-bearings/id-608/',
    source: 'NBC Bearings 608 product page, Technical Specification: d 8 mm, D 22 mm, B 7 mm. The SKF pages render only with JavaScript and were not read.',
    checked: CHECKED,
  },
  'motor-bldc-22': {
    id: 'motor-bldc-22', label: labelOf('motor-bldc-22'), category: 'actuator', primitive: 'cylinder',
    description: '2207-size brushless outrunner, overall diameter and overall length (y); the mounting pattern is 19 x 19 mm',
    sizeMm: { x: 28.6, y: 32.8, z: 28.6 }, wallMm: null,
    sourceUrl: 'https://www.readymaderc.com/products/details/87015-emax-e3-series-2207-brushless-motor-1900kv',
    source: 'EMAX E3 2207 1900KV specifications on a retailer page: Overall Motor Dimensions 28.6 mm diameter x 32.8 mm, Mounting Bolt Pattern 19 mm x 19 mm. The 16 x 16 pattern and the hole size were not verified.',
    checked: CHECKED,
  },
  'wall-moulded-plastic': {
    id: 'wall-moulded-plastic', label: labelOf('wall-moulded-plastic'), category: 'wall', primitive: null,
    description: 'recommended wall thickness of an injection-moulded ABS part; the source states a range and no typical value',
    sizeMm: null, wallMm: { min: 1.143, typical: null, max: 3.556 },
    sourceUrl: 'https://www.protolabs.com/services/injection-molding/plastic-injection-molding/design-guidelines/',
    source: 'Protolabs injection-moulding design guidelines, Recommended wall thickness table, ABS row: 1.143 mm - 3.556 mm.',
    checked: CHECKED,
  },
  'wall-fdm': {
    id: 'wall-fdm', label: labelOf('wall-fdm'), category: 'wall', primitive: null,
    description: 'recommended wall thickness for supporting walls of an FDM 3D print; the source states a range and no typical value',
    sizeMm: null, wallMm: { min: 1.2, typical: null, max: 1.5 },
    sourceUrl: 'https://www.xometry.com/resources/3d-printing/mini-guide-fdm-3d-printing/',
    source: 'Xometry FDM Mini-Guide (updated 2025-09-04), Design Tip 1: Wall Thickness: at least 0.047" - 0.06" (1.2 - 1.5 mm) thick.',
    checked: CHECKED,
  },
  'wall-aluminium': {
    id: 'wall-aluminium', label: labelOf('wall-aluminium'), category: 'wall', primitive: null,
    description: 'minimum wall thickness of an extruded aluminium enclosure; the source states only the minimum',
    sizeMm: null, wallMm: { min: 1.5, typical: null, max: null },
    sourceUrl: 'https://static.rapidonline.com/pdf/31-1879t_v1.pdf',
    source: 'Hammond 1455F series datasheet (distributor-hosted copy), page 1: extruded aluminum with a minimum thickness of 0.06" (1.5 mm).',
    checked: CHECKED,
  },
};

const mm = (value: number): string => String(value);

/** The range of a wall entry for the instructions: only the stated values are named. */
function wallText(wall: NonNullable<ReferencePart['wallMm']>): string {
  const range = wall.max === null ? `at least ${mm(wall.min)}` : `${mm(wall.min)} to ${mm(wall.max)}`;
  return wall.typical === null ? `${range} mm` : `${range} mm, typical ${mm(wall.typical)} mm`;
}

/**
 * One English instruction line per entry, in table order, generated from the data so the text cannot drift
 * from it (requirement 28): `- {label}: {description}, {size} mm, as {primitive}`. A size reads x by y by z in
 * the part's own axes; a thickness reads as a range with only the stated values.
 */
export function referenceLines(): string[] {
  return REFERENCE_PART_IDS.map(id => {
    const entry = REFERENCE_PARTS[id];
    const size = entry.sizeMm ? `${mm(entry.sizeMm.x)} x ${mm(entry.sizeMm.y)} x ${mm(entry.sizeMm.z)} mm (x, y, z)` : null;
    const thickness = entry.wallMm ? `${entry.category === 'wall' ? 'wall' : 'thickness'} ${wallText(entry.wallMm)}` : null;
    const shape = entry.primitive ? `as ${entry.primitive}` : null;
    return `- ${entry.label.en}: ${[entry.description, size, thickness, shape].filter(Boolean).join(', ')}`;
  });
}