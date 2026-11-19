import * as THREE from 'three';
import { demoModel } from '../../shared/demo';
import type { Joint, JointSide } from '../../shared/joint';
import { validateModel, type ModelSpec, type Part } from '../../shared/model';
import {
  addJoint, addObject, createObject, emptyWorkspace,
  type ObjectTransform, type SceneObject, type Workspace,
} from '../../shared/workspace';

/**
 * Small joint workspaces for the assembly-joints tests (design 11): two boxes
 * side by side, a rotated pair, a box on a cylinder cap and a demo pair. Each
 * builder takes `{ joint: true }` to add the joint that connects the pair; the
 * first object is added first, so the last one added is active.
 */

export const CREATED_AT = '2026-11-20T08:00:00.000Z';

/** Box size of the small fixtures, metres. */
export const BOX = { x: 0.04, y: 0.02, z: 0.03 } as const;

const vec = (x: number, y: number, z: number) => ({ x, y, z });
const round5 = (value: number) => Math.round(value * 1e5) / 1e5;

export function fixturePart(
  id: string, primitive: Part['primitive'], dimensions: { x: number; y: number; z: number },
  position = vec(0, 0, 0), role: Part['role'] = 'exterior',
): Part {
  return {
    id, name: id, parentId: null, primitive, dimensions, position, rotation: vec(0, 0, 0), color: '#336699', role, tubeRatio: 0.3,
  };
}

export function fixtureModel(name: string, parts: Part[]): ModelSpec {
  return validateModel({ schemaVersion: '1.0', name, summary: 'Fixture.', units: 'm', assumptions: [], parts });
}

export const boxModel = (name = 'Block', partId = 'body'): ModelSpec => fixtureModel(name, [fixturePart(partId, 'box', BOX)]);

export function fixtureObject(id: string, model: ModelSpec, transform: ObjectTransform): SceneObject {
  return { id, model, transform, source: 'test', providerModel: 'fake', edited: false, material: null, createdAt: CREATED_AT };
}

export const side = (objectId: string, partId: string, face: JointSide['face']): JointSide => ({ objectId, partId, face });

/** A glue joint with no needs, not confirmed. Pass `overrides` to change any field. */
export function fixtureJoint(a: JointSide, b: JointSide, overrides: Partial<Joint> = {}): Joint {
  return {
    id: 'joint-1', a, b, method: { kind: 'glue', glue: 'ca' }, needs: { load: null, disassembly: null }, confirmed: false,
    createdAt: CREATED_AT, ...overrides,
  };
}

export interface FixtureOptions {
  /** Adds the joint that connects the pair. */
  joint?: boolean;
  /** Overrides for the joint. */
  jointOverrides?: Partial<Joint>;
}

function build(objects: SceneObject[], joint: Joint | null, options: FixtureOptions): Workspace {
  const ws = objects.reduce((current, object) => addObject(current, object), emptyWorkspace());
  return options.joint && joint ? addJoint(ws, { ...joint, ...options.jointOverrides }) : ws;
}

/**
 * Objects `a` and `b`, one box part `body` each, side by side along X so that
 * a's `+x` face and b's `-x` face touch. Joint `joint-1`: a `+x` to b `-x`.
 */
export function twoBoxes(options: FixtureOptions = {}): Workspace {
  return build(
    [
      fixtureObject('a', boxModel('Block A'), { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }),
      fixtureObject('b', boxModel('Block B'), { position: vec(BOX.x, 0, 0), rotation: vec(0, 0, 0) }),
    ],
    fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x')),
    options,
  );
}

/** The same pair as `twoBoxes`, with both objects rotated by `degrees` about Y and moved off the origin. */
export function rotatedPair(options: FixtureOptions & { degrees?: number } = {}): Workspace {
  const degrees = options.degrees ?? 30;
  const origin = new THREE.Vector3(0.1, 0.05, 0.2);
  const offset = new THREE.Vector3(BOX.x, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(degrees));
  const at = (point: THREE.Vector3): ObjectTransform => ({
    position: vec(round5(point.x), round5(point.y), round5(point.z)), rotation: vec(0, degrees, 0),
  });
  return build(
    [
      fixtureObject('a', boxModel('Block A'), at(origin)),
      fixtureObject('b', boxModel('Block B'), at(origin.clone().add(offset))),
    ],
    fixtureJoint(side('a', 'body', '+x'), side('b', 'body', '-x')),
    options,
  );
}

/**
 * A cylinder `post` (object `post`, part `post`) with a box (object `cap`,
 * part `body`) standing on its top cap. Joint: post `+y` to cap `-y`.
 */
export function boxOnCylinder(options: FixtureOptions = {}): Workspace {
  const post = fixtureModel('Post', [fixturePart('post', 'cylinder', { x: 0.04, y: 0.1, z: 0.04 })]);
  return build(
    [
      fixtureObject('post', post, { position: vec(0, 0, 0), rotation: vec(0, 0, 0) }),
      fixtureObject('cap', boxModel('Cap'), { position: vec(0, round5(0.05 + BOX.y / 2), 0), rotation: vec(0, 0, 0) }),
    ],
    fixtureJoint(side('post', 'post', '+y'), side('cap', 'body', '-y')),
    options,
  );
}

/**
 * Two `demoModel` objects (`demo-a`, `demo-b`), the second placed with
 * `placeBeside`, so a gap separates them. Joint: demo-a housing `+x` to
 * demo-b housing `-x` (the joint exists although the faces do not touch).
 */
export function demoPair(options: FixtureOptions = {}): Workspace {
  const first = createObject(emptyWorkspace(), { id: 'demo-a', model: demoModel, source: 'demo', providerModel: 'demo', createdAt: CREATED_AT });
  const withFirst = addObject(emptyWorkspace(), first);
  const second = createObject(withFirst, { id: 'demo-b', model: demoModel, source: 'demo', providerModel: 'demo', createdAt: CREATED_AT });
  const ws = addObject(withFirst, second);
  return options.joint
    ? addJoint(ws, { ...fixtureJoint(side('demo-a', 'housing', '+x'), side('demo-b', 'housing', '-x')), ...options.jointOverrides })
    : ws;
}
