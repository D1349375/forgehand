import type { Measured, ProfileSlice, ScaleSource, WristMeasurement } from '../../shared/body';
import { ellipsePerimeter } from '../../shared/ellipse';
import { PROFILE_MAX_MM, PROFILE_MIN_MM, PROFILE_STEP_MM } from '../../shared/fit-constants';
import { validateModel, type ModelSpec, type Part } from '../../shared/model';

/**
 * Bracelet models for the body-fit tests (tasks T1). Every part is built by hand and the
 * model goes through `validateModel`, so the fixtures are valid `PartSchema` data.
 * Sizes are in millimetres here and converted to metres in `part`. The ring axis of a
 * tube is its local y, of a torus its local z; the case of a bracelet sits on local +z.
 */

const m = (mm: number) => mm / 1000;
const vec = (x: number, y: number, z: number) => ({ x, y, z });

export interface FixturePartOptions {
  parentId?: string | null;
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  role?: Part['role'];
  tubeRatio?: number;
}

/** A part from sizes in millimetres: `dims` is the full size on the part's x, y and z. */
export function fixturePart(
  id: string, primitive: Part['primitive'], dims: [number, number, number], at: [number, number, number] = [0, 0, 0],
  options: FixturePartOptions = {},
): Part {
  return {
    id, name: id, parentId: options.parentId ?? null, primitive,
    dimensions: vec(m(dims[0]), m(dims[1]), m(dims[2])),
    position: vec(m(at[0]), m(at[1]), m(at[2])),
    rotation: options.rotation ?? vec(0, 0, 0),
    color: '#336699', role: options.role ?? 'exterior', tubeRatio: options.tubeRatio ?? 0.75,
  };
}

export function fixtureModel(name: string, parts: Part[]): ModelSpec {
  return validateModel({ schemaVersion: '1.0', name, summary: 'Fit fixture.', units: 'm', assumptions: [], parts });
}

export interface TubeRingSpec {
  /** Inner semi-axes along the part's local x and z. */
  inner1Mm: number;
  inner2Mm: number;
  /** Wall along local x; the wall along z follows from the shared `tubeRatio`. */
  wallMm: number;
  heightMm: number;
}

/** A `tube` part with the given inner ellipse, as `resizeRing` builds one. */
export function tubeRingPart(spec: TubeRingSpec, id = 'band', options: FixturePartOptions = {}): Part {
  const outer1 = 2 * (spec.inner1Mm + spec.wallMm);
  const ratio = 2 * spec.inner1Mm / outer1;
  const outer2 = 2 * spec.inner2Mm / ratio;
  return fixturePart(id, 'tube', [outer1, spec.heightMm, outer2], [0, 0, 0], { ...options, tubeRatio: ratio });
}

export interface TorusRingSpec {
  /** Inner semi-axes along the part's local x and y: a torus's hole is half of its outer size. */
  inner1Mm: number;
  inner2Mm: number;
  /** Size along the ring axis (local z). */
  widthMm: number;
}

export function torusRingPart(spec: TorusRingSpec, id = 'band', options: FixturePartOptions = {}): Part {
  return fixturePart(id, 'torus', [4 * spec.inner1Mm, 4 * spec.inner2Mm, spec.widthMm], [0, 0, 0], options);
}

/** A plain `tube` band: inner 61.6 mm across, wall 3.4 mm, 20 mm wide. */
export const tubeBand = (): ModelSpec =>
  fixtureModel('Tube band', [tubeRingPart({ inner1Mm: 30.8, inner2Mm: 30.8, wallMm: 4.2, heightMm: 20 })]);

/** A plain `torus` band: a 70 by 62 mm hole, a 12 mm wide round-section ring. */
export const torusBand = (): ModelSpec =>
  fixtureModel('Torus band', [torusRingPart({ inner1Mm: 35, inner2Mm: 31, widthMm: 12 })]);

const CASE_MM: [number, number, number] = [40, 36, 12];

/** The band is the root; the case is its child on local +z; a battery and a board sit inside the case. */
export const bandWithCase = (): ModelSpec => {
  const band = tubeRingPart({ inner1Mm: 30.8, inner2Mm: 30.8, wallMm: 4.2, heightMm: 20 });
  return fixtureModel('Band with case', [
    band,
    fixturePart('case', 'box', CASE_MM, [0, 0, 35 + CASE_MM[2] / 2], { parentId: 'band' }),
    fixturePart('battery', 'box', [20, 20, 4], [0, 0, 1.5], { parentId: 'case', role: 'interior' }),
    fixturePart('board', 'box', [24, 24, 2], [0, 0, -3.5], { parentId: 'case', role: 'interior' }),
  ]);
};

/** The case is the root; the band is its child, on the side of local -z. */
export const caseWithBand = (): ModelSpec => {
  const band = tubeRingPart({ inner1Mm: 30.8, inner2Mm: 30.8, wallMm: 4.2, heightMm: 20 }, 'band', { parentId: 'case' });
  band.position = vec(0, 0, -m(35 + CASE_MM[2] / 2));
  return fixtureModel('Case with band', [fixturePart('case', 'box', CASE_MM), band]);
};

/**
 * An open C cuff of 14 boxes around the y axis at radius 34.5 mm (inner face at 33 mm), every
 * 20 degrees from 0 to 220 and at 320 and 340: an opening of about 75 degrees centred on ring angle 270.
 */
export const openCuff = (): ModelSpec => {
  const radius = 34.5;
  const angles = [...Array.from({ length: 12 }, (_, i) => i * 20), 320, 340];
  return fixtureModel('Open cuff', angles.map(angle => {
    const t = angle * Math.PI / 180;
    return fixturePart(`seg-${angle}`, 'box', [14, 20, 3], [radius * Math.sin(t), 0, radius * Math.cos(t)], { rotation: vec(0, angle, 0) });
  }));
};

/** A box with a sphere on it: nothing surrounds an axis. */
export const noRing = (): ModelSpec =>
  fixtureModel('No ring', [
    fixturePart('body', 'box', [50, 30, 20]),
    fixturePart('lens', 'sphere', [14, 14, 14], [0, 0, 8], { parentId: 'body' }),
  ]);

/** A tube band with a bar across its axis: the axis itself is inside a part. */
export const ringWithBar = (): ModelSpec =>
  fixtureModel('Ring with bar', [
    tubeRingPart({ inner1Mm: 30.8, inner2Mm: 30.8, wallMm: 4.2, heightMm: 20 }),
    fixturePart('bar', 'box', [70, 6, 6]),
  ]);

/** All fixtures by name, for tests that run over each of them. */
export const fixtures = { tubeBand, torusBand, bandWithCase, caseWithBand, openCuff, noRing, ringWithBar } as const;

export interface WristOptions {
  /** Millimetres of width gained per millimetre toward the elbow; the thickness gains the same share. Default 0: a straight arm. */
  taper?: number;
  source?: ScaleSource;
  spreadMm?: number | null;
  passageMm?: number | null;
  side?: 'left' | 'right';
}

const measured = (mm: number, source: ScaleSource, spreadMm: number | null): Measured => ({ mm, source, spreadMm });

/** A wrist measurement of the given width and thickness at the band position, with a profile along the arm. */
export function wristMeasurement(widthMm: number, thicknessMm: number, options: WristOptions = {}): WristMeasurement {
  const { taper = 0, source = 'tape', spreadMm = null } = options;
  const profile: ProfileSlice[] = [];
  for (let offset = PROFILE_MIN_MM; offset <= PROFILE_MAX_MM; offset += PROFILE_STEP_MM) {
    profile.push({
      offsetMm: offset,
      width: measured(widthMm + taper * offset, source, spreadMm),
      thickness: measured(thicknessMm + taper * offset * thicknessMm / widthMm, source, spreadMm),
    });
  }
  return {
    side: options.side ?? 'left',
    width: measured(widthMm, source, spreadMm),
    thickness: measured(thicknessMm, source, spreadMm),
    circumference: measured(ellipsePerimeter(widthMm / 2, thicknessMm / 2), source, null),
    profile,
    passage: options.passageMm == null ? null : measured(options.passageMm, source, null),
    thicknessAssumed: false,
    cameraCircumferenceMm: null,
  };
}