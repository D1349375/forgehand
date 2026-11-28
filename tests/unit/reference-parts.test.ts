import { describe, expect, it } from 'vitest';
import { REFERENCE_LABELS } from '../../shared/i18n/fidelity';
import { PartSchema } from '../../shared/model';
import {
  REFERENCE_PART_IDS, REFERENCE_PARTS, ReferencePartIdSchema, referenceLines, SCREWS, type ReferencePart,
} from '../../shared/standard-parts';

/**
 * design-fidelity R25 to R29: every number of the reference table is pinned here, so a change is deliberate and
 * reviewed. The values and sources are those of .kiro/specs/design-fidelity/reference-sources.md (read on
 * 2026-11-28). A size is in the part's own axes: a cylinder is { x: diameter, y: length, z: diameter }.
 */

type Size = { x: number; y: number; z: number };
const PINNED: Record<string, { primitive: ReferencePart['primitive']; size: Size | null; wall: ReferencePart['wallMm']; url: string }> = {
  'cell-18650': { primitive: 'cylinder', size: { x: 18.5, y: 65.3, z: 18.5 }, wall: null, url: 'https://www.batteryspace.com/prod-specs/NCR18650B.pdf' },
  'cell-aa': { primitive: 'cylinder', size: { x: 14.5, y: 50.5, z: 14.5 }, wall: null, url: 'https://www.farnell.com/datasheets/1960166.pdf' },
  'cell-cr2032': { primitive: 'cylinder', size: { x: 20.0, y: 3.2, z: 20.0 }, wall: null, url: 'https://energy.panasonic.com/dam/master/pdf/en/datasheet/lithium/CR2032_Datasheet_EN.pdf' },
  'cell-lipo-402030': { primitive: 'box', size: { x: 20.5, y: 4.3, z: 32.0 }, wall: null, url: 'https://www.eemb.com/product-247' },
  'pcb-1-6': { primitive: 'box', size: null, wall: { min: 0.4, typical: 1.6, max: 2.0 }, url: 'https://jlcpcb.com/capabilities/pcb-capabilities' },
  'screw-m2': { primitive: 'cylinder', size: { x: 3.8, y: 2.0, z: 3.8 }, wall: null, url: 'https://www.engineersedge.com/iso_socket_head_screw.htm' },
  'screw-m3': { primitive: 'cylinder', size: { x: 5.5, y: 3.0, z: 5.5 }, wall: null, url: 'https://www.engineersedge.com/iso_socket_head_screw.htm' },
  'standoff-m2': { primitive: 'cylinder', size: { x: 4.0, y: 10, z: 4.0 }, wall: null, url: 'https://www.we-online.com/components/products/datasheet/970100244.pdf' },
  'standoff-m3': { primitive: 'cylinder', size: { x: 5.5, y: 8, z: 5.5 }, wall: null, url: 'https://www.we-online.com/components/products/datasheet/970080321.pdf' },
  'usb-c-receptacle': { primitive: 'box', size: { x: 8.94, y: 3.31, z: 7.35 }, wall: null, url: 'https://gct.co/files/drawings/usb4105.pdf' },
  'motor-coin-10': { primitive: 'cylinder', size: { x: 10, y: 2.7, z: 10 }, wall: null, url: 'https://precisionmicrodrives.com/cdn/catalog_product/89437681-576e-46e1-97cf-5ae185adeb1c/310-103-datasheet.pdf' },
  'switch-tact-6': { primitive: 'box', size: { x: 6.0, y: 4.3, z: 6.0 }, wall: null, url: 'https://omronfs.omron.com/en_US/ecb/products/pdf/en-b3f.pdf' },
  'led-5': { primitive: 'cylinder', size: { x: 5.9, y: 8.6, z: 5.9 }, wall: null, url: 'https://www.komponenten.es.aau.dk/fileadmin/komponenten/Data_Sheet/LCD/5mmLOWLED.pdf' },
  'speaker-40': { primitive: 'cylinder', size: { x: 40, y: 9.3, z: 40 }, wall: null, url: 'https://www.sameskydevices.com/product/resource/gf0401m.pdf' },
  'module-wireless': { primitive: 'box', size: { x: 18.0, y: 3.1, z: 25.5 }, wall: null, url: 'https://documentation.espressif.com/esp32-wroom-32e_esp32-wroom-32ue_datasheet_en.pdf' },
  'module-camera': { primitive: 'box', size: { x: 25, y: 11.5, z: 24 }, wall: null, url: 'https://pip-assets.raspberrypi.com/categories/786-raspberry-pi-camera-module-3/documents/RP-008151-DS-1-camera-module-3-product-brief.pdf' },
  thumbstick: { primitive: 'box', size: { x: 17.8, y: 11.2, z: 21.3 }, wall: null, url: 'https://www.alpsalpine.com/cms.media/product_catalog_mu_01_rkjxv_en_05974b8a16.pdf' },
  'bearing-608': { primitive: 'tube', size: { x: 22, y: 7, z: 22 }, wall: null, url: 'https://www.nbcbearings.com/ball-bearings/deep-groove-ball-bearings/id-608/' },
  'motor-bldc-22': { primitive: 'cylinder', size: { x: 28.6, y: 32.8, z: 28.6 }, wall: null, url: 'https://www.readymaderc.com/products/details/87015-emax-e3-series-2207-brushless-motor-1900kv' },
  'wall-moulded-plastic': { primitive: null, size: null, wall: { min: 1.143, typical: null, max: 3.556 }, url: 'https://www.protolabs.com/services/injection-molding/plastic-injection-molding/design-guidelines/' },
  'wall-fdm': { primitive: null, size: null, wall: { min: 1.2, typical: null, max: 1.5 }, url: 'https://www.xometry.com/resources/3d-printing/mini-guide-fdm-3d-printing/' },
  'wall-aluminium': { primitive: null, size: null, wall: { min: 1.5, typical: null, max: null }, url: 'https://static.rapidonline.com/pdf/31-1879t_v1.pdf' },
};

const entries = Object.values(REFERENCE_PARTS);

describe('the reference table: ids and shape', () => {
  it('has the 22 verified entries, with ids that match the enum, the labels and the pins', () => {
    expect(REFERENCE_PART_IDS).toHaveLength(22);
    expect(new Set(REFERENCE_PART_IDS).size).toBe(22);
    expect([...ReferencePartIdSchema.options]).toEqual([...REFERENCE_PART_IDS]);
    expect(Object.keys(REFERENCE_PARTS)).toEqual([...REFERENCE_PART_IDS]);
    expect(Object.keys(PINNED).sort()).toEqual([...REFERENCE_PART_IDS].sort());
    expect(Object.keys(REFERENCE_LABELS['zh-TW']).sort()).toEqual([...REFERENCE_PART_IDS].sort());
    expect(Object.keys(REFERENCE_LABELS.en).sort()).toEqual([...REFERENCE_PART_IDS].sort());
    for (const id of REFERENCE_PART_IDS) expect(REFERENCE_PARTS[id].id).toBe(id);
    for (const id of REFERENCE_PART_IDS) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('pins every primitive, size, wall and source URL', () => {
    for (const id of REFERENCE_PART_IDS) {
      const entry = REFERENCE_PARTS[id];
      const pinned = PINNED[id]!;
      expect([id, entry.primitive]).toEqual([id, pinned.primitive]);
      expect([id, entry.sizeMm]).toEqual([id, pinned.size]);
      expect([id, entry.wallMm]).toEqual([id, pinned.wall]);
      expect([id, entry.sourceUrl]).toEqual([id, pinned.url]);
    }
  });

  it('uses only primitives the model schema knows', () => {
    for (const entry of entries) {
      if (entry.primitive !== null) expect(PartSchema.shape.primitive.safeParse(entry.primitive).success).toBe(true);
    }
  });
});

describe('the reference table: sources and sanity checks (R27)', () => {
  it('has an https source URL, a source note and an ISO date for every entry', () => {
    for (const entry of entries) {
      const url = new URL(entry.sourceUrl);
      expect([entry.id, url.protocol]).toEqual([entry.id, 'https:']);
      expect(url.hostname.length).toBeGreaterThan(3);
      expect(entry.source.trim().length).toBeGreaterThan(20);
      expect(entry.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(entry.checked))).toBe(false);
      expect(entry.checked).toBe('2026-11-28');
      expect(entry.description.trim().length).toBeGreaterThan(10);
    }
  });

  it('has positive sizes below 1000 mm in every axis', () => {
    for (const entry of entries) {
      if (!entry.sizeMm) continue;
      for (const value of Object.values(entry.sizeMm)) {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThan(1000);
      }
    }
  });

  it('orders min, typical and max over the stated values only, and lets nothing but min be missing', () => {
    for (const entry of entries) {
      if (!entry.wallMm) continue;
      const { min, typical, max } = entry.wallMm;
      expect(min).toBeGreaterThan(0);
      const stated = [min, typical, max].filter((value): value is number => value !== null);
      expect([entry.id, stated]).toEqual([entry.id, [...stated].sort((a, b) => a - b)]);
      for (const value of stated) expect(value).toBeLessThan(1000);
    }
  });

  it('gives each entry a size or a thickness, and a wall entry no shape', () => {
    for (const entry of entries) {
      expect([entry.id, entry.sizeMm !== null || entry.wallMm !== null]).toEqual([entry.id, true]);
      if (entry.category === 'wall') {
        expect([entry.id, entry.primitive, entry.sizeMm]).toEqual([entry.id, null, null]);
        expect(entry.wallMm).not.toBeNull();
      }
    }
    // The board has no size of its own, only a thickness (decision 11).
    expect(REFERENCE_PARTS['pcb-1-6'].sizeMm).toBeNull();
    expect(REFERENCE_PARTS['pcb-1-6'].wallMm).toEqual({ min: 0.4, typical: 1.6, max: 2.0 });
  });

  it('has a generic label in both languages and no brand in the English one', () => {
    for (const entry of entries) {
      expect(entry.label['zh-TW'].trim().length).toBeGreaterThan(1);
      expect(entry.label.en.trim().length).toBeGreaterThan(1);
      expect(entry.label['zh-TW']).toBe(REFERENCE_LABELS['zh-TW'][entry.id]);
      expect(entry.label.en).toBe(REFERENCE_LABELS.en[entry.id]);
    }
    for (const brand of ['Panasonic', 'Energizer', 'Omron', 'Espressif', 'Raspberry', 'ALPS', 'EMAX', 'Kingbright', 'GCT', 'NBC', 'Wurth']) {
      for (const entry of entries) expect(entry.label.en).not.toContain(brand);
    }
  });
});

describe('the reference table: no duplicated numbers (R29)', () => {
  it('builds the screw entries from SCREWS', () => {
    expect(REFERENCE_PARTS['screw-m2'].sizeMm).toEqual({ x: SCREWS.M2.headMm, y: SCREWS.M2.headHeightMm, z: SCREWS.M2.headMm });
    expect(REFERENCE_PARTS['screw-m3'].sizeMm).toEqual({ x: SCREWS.M3.headMm, y: SCREWS.M3.headHeightMm, z: SCREWS.M3.headMm });
  });
});

describe('referenceLines (R28)', () => {
  it('has one English line per entry, in table order, with the label first', () => {
    const lines = referenceLines();
    expect(lines).toHaveLength(REFERENCE_PART_IDS.length);
    REFERENCE_PART_IDS.forEach((id, index) => {
      expect(lines[index]!.startsWith(`- ${REFERENCE_PARTS[id].label.en}: `)).toBe(true);
      expect(lines[index]).not.toContain('\n');
    });
  });

  it('writes sizes as x by y by z in mm and the suggested primitive', () => {
    const line = (id: (typeof REFERENCE_PART_IDS)[number]) => referenceLines()[REFERENCE_PART_IDS.indexOf(id)]!;
    expect(line('cell-18650')).toBe('- typical 18650 cylindrical lithium cell: bare cylindrical lithium cell, maximum diameter and length, 18.5 x 65.3 x 18.5 mm (x, y, z), as cylinder');
    expect(line('switch-tact-6')).toContain('6 x 4.3 x 6 mm (x, y, z), as box');
    expect(line('bearing-608')).toContain('22 x 7 x 22 mm (x, y, z), as tube');
  });

  it('names only the stated wall values', () => {
    const line = (id: (typeof REFERENCE_PART_IDS)[number]) => referenceLines()[REFERENCE_PART_IDS.indexOf(id)]!;
    expect(line('wall-moulded-plastic')).toMatch(/, wall 1\.143 to 3\.556 mm$/);
    expect(line('wall-fdm')).toMatch(/, wall 1\.2 to 1\.5 mm$/);
    expect(line('wall-aluminium')).toMatch(/, wall at least 1\.5 mm$/);
    expect(line('pcb-1-6')).toMatch(/, thickness 0\.4 to 2 mm, typical 1\.6 mm, as box$/);
    for (const id of ['wall-moulded-plastic', 'wall-fdm', 'wall-aluminium'] as const) {
      expect(line(id)).not.toContain('typical 0');
      expect(line(id)).not.toContain('null');
      expect(line(id)).not.toContain(' as ');
    }
  });

  it('has no Chinese text, no undefined and no NaN', () => {
    for (const line of referenceLines()) {
      expect(/[\u3400-\u9fff]/.test(line)).toBe(false);
      expect(line).not.toMatch(/undefined|NaN/);
    }
  });
});
