import * as THREE from 'three';
import { contactRegion, localFace, worldFace, type WorldFace } from '../../shared/contact';
import type { FeatureSet, JointFeature } from '../../shared/features';
import { DISC_SEGMENTS, MIN_CONTACT_MM2 } from '../../shared/joint-constants';
import type { FaceId, Joint, JointSide } from '../../shared/joint';
import type { Finding } from '../../shared/joint-rules';
import type { Part } from '../../shared/model';
import { findObject, type Workspace } from '../../shared/workspace';

/**
 * Joint marks (assembly-joints design 8.2, requirement 47): the outline of the contact region and
 * a translucent marker for every hole, pocket and boss at its real diameter and depth, built as a
 * Three.js group that is attached to the part's own scene node, so it follows previews, moves and
 * the exploded view. `PartMarks` is plain data (one per joint side, since one part can carry several
 * joints) so a mark is rebuilt only when its `markKey` changes.
 */

export interface Vector { x: number; y: number; z: number }

/** `open`: the joint's card is open. `problem`: the joint has an error, so its outline is dashed (colour never carries the state alone). */
export type MarkState = 'ok' | 'problem' | 'open';

export interface PartMarks {
  jointId: string;
  side: 'a' | 'b';
  objectId: string;
  partId: string;
  /** Part-local points of the contact region's outline, closed implicitly. */
  outline: Vector[];
  features: JointFeature[];
  state: MarkState;
  /** The face glow of a join preview: filled and brighter. */
  glow?: boolean;
}

/** Violet: distinct from the edge cyan `#69eaff`, the selection amber `#ffc53d` and the hand colours. */
export const MARK_COLOR = '#c77dff';
const MARK_COLOR_OPEN = '#e6c2ff';
const BOSS_COLOR = '#e0b3ff';
const HOLE_COLOR = '#8a3fc4';

export const markId = (marks: Pick<PartMarks, 'jointId' | 'side'>): string => `${marks.jointId}:${marks.side}`;

/** Changes exactly when the built geometry would. */
export const markKey = (marks: PartMarks): string => JSON.stringify(marks);

// ---------------------------------------------------------------------------
// Data: what to draw
// ---------------------------------------------------------------------------

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const vec = (point: THREE.Vector3): Vector => ({ x: round6(point.x), y: round6(point.y), z: round6(point.z) });

/** The outer outline of a part's face in the part's own frame: four corners, or `DISC_SEGMENTS` points of the ellipse. */
export function faceOutline(part: Part, face: FaceId): Vector[] {
  const local = localFace(part, face);
  if (!local) return [];
  const at = (s: number, t: number) => vec(local.centre.clone().addScaledVector(local.u, s * local.half.u).addScaledVector(local.v, t * local.half.v));
  if (local.shape === 'rect') return [at(1, 1), at(-1, 1), at(-1, -1), at(1, -1)];
  return Array.from({ length: DISC_SEGMENTS }, (_, step) => {
    const angle = (2 * Math.PI * step) / DISC_SEGMENTS;
    return at(Math.cos(angle), Math.sin(angle));
  });
}

function sideFace(ws: Workspace, side: JointSide): { face: WorldFace; part: Part } | null {
  const object = findObject(ws, side.objectId);
  const part = object?.model.parts.find(candidate => candidate.id === side.partId);
  const face = object && part ? worldFace(object, part, side.face) : null;
  return face && part ? { face, part } : null;
}

/**
 * Part-local outlines of a joint's two sides: the contact region when the faces overlap (so both
 * sides draw the same shape), otherwise each side's whole face. `null` when a face no longer exists.
 */
export function jointOutlines(ws: Workspace, joint: Pick<Joint, 'a' | 'b'>): { a: Vector[]; b: Vector[] } | null {
  const sa = sideFace(ws, joint.a);
  const sb = sideFace(ws, joint.b);
  if (!sa || !sb) return null;
  const region = contactRegion(sa.face, sb.face);
  if (!region || region.areaMm2 < MIN_CONTACT_MM2) return { a: faceOutline(sa.part, joint.a.face), b: faceOutline(sb.part, joint.b.face) };
  const world = region.polygon.map(point => region.origin.clone().addScaledVector(region.u, point.x).addScaledVector(region.v, point.y));
  const toLocal = (side: { face: WorldFace; part: Part }, face: FaceId): Vector[] => {
    const inverse = side.face.matrix.clone().invert();
    // Sit exactly on the face's plane, so a gap between the faces does not lift the outline off the part.
    const plane = localFace(side.part, face)!.centre.getComponent(side.face.axis);
    return world.map(point => vec(point.clone().applyMatrix4(inverse).setComponent(side.face.axis, plane)));
  };
  return { a: toLocal(sa, joint.a.face), b: toLocal(sb, joint.b.face) };
}

/**
 * The marks of every joint side: its outline, its features and its state. A joint whose faces no
 * longer exist has none. `openJointId` is the joint whose card is open.
 */
export function computeMarks(ws: Workspace, kit: { features: FeatureSet; findings: ReadonlyMap<string, readonly Finding[]> }, openJointId: string | null): PartMarks[] {
  const marks: PartMarks[] = [];
  for (const joint of ws.joints) {
    const outlines = jointOutlines(ws, joint);
    if (!outlines) continue;
    const set = kit.features.joints.get(joint.id);
    const hasError = kit.findings.get(joint.id)?.some(finding => finding.severity === 'error') ?? false;
    const state: MarkState = hasError ? 'problem' : joint.id === openJointId ? 'open' : 'ok';
    for (const side of ['a', 'b'] as const) {
      marks.push({
        jointId: joint.id, side, objectId: joint[side].objectId, partId: joint[side].partId,
        outline: outlines[side], features: set?.features.filter(feature => feature.side === side) ?? [], state,
      });
    }
  }
  return marks;
}

/** The two faces of a join preview, as glow outlines on their parts. */
export function glowMarks(ws: Workspace, a: JointSide, b: JointSide): PartMarks[] {
  return ([['a', a], ['b', b]] as const).flatMap(([side, ref]) => {
    const part = findObject(ws, ref.objectId)?.model.parts.find(candidate => candidate.id === ref.partId);
    if (!part) return [];
    return [{ jointId: 'preview', side, objectId: ref.objectId, partId: ref.partId, outline: faceOutline(part, ref.face), features: [], state: 'open' as const, glow: true }];
  });
}

// ---------------------------------------------------------------------------
// Three.js: what is drawn
// ---------------------------------------------------------------------------

const noRaycast = () => {};

function outlineLine(points: readonly Vector[], color: string, opacity: number, dashed: boolean, scale = 1): THREE.Line | null {
  if (points.length < 2) return null;
  const centre = points.reduce<THREE.Vector3>((sum, point) => sum.add(new THREE.Vector3(point.x, point.y, point.z)), new THREE.Vector3()).divideScalar(points.length);
  const closed = [...points, points[0]!].map(point => new THREE.Vector3(point.x, point.y, point.z).sub(centre).multiplyScalar(scale).add(centre));
  const geometry = new THREE.BufferGeometry().setFromPoints(closed);
  let line: THREE.Line;
  if (dashed) {
    const size = new THREE.Box3().setFromPoints(closed).getSize(new THREE.Vector3());
    const dash = Math.max(Math.max(size.x, size.y, size.z) / 24, 0.0005);
    line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color, transparent: true, opacity, depthWrite: false, dashSize: dash, gapSize: dash * 0.7 }));
    line.computeLineDistances();
  } else {
    line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  }
  line.raycast = noRaycast;
  line.renderOrder = 4;
  return line;
}

/** A triangle fan over a convex outline: the fill of a glow. */
function outlineFill(points: readonly Vector[], color: string, opacity: number): THREE.Mesh | null {
  if (points.length < 3) return null;
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(point => new THREE.Vector3(point.x, point.y, point.z)));
  const index: number[] = [];
  for (let at = 1; at < points.length - 1; at++) index.push(0, at, at + 1);
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
  mesh.raycast = noRaycast;
  mesh.renderOrder = 3;
  return mesh;
}

const isHole = (feature: JointFeature) => feature.kind !== 'boss';

function featureObjects(feature: JointFeature, opacity: number): THREE.Object3D[] {
  const radius = feature.diameter / 2;
  if (!(radius > 0) || !(feature.depth > 0)) return [];
  const axis = new THREE.Vector3(feature.axis.x, feature.axis.y, feature.axis.z).normalize();
  const start = new THREE.Vector3(feature.centre.x, feature.centre.y, feature.centre.z);
  const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, feature.depth, 24, 1, false),
    new THREE.MeshBasicMaterial({ color: isHole(feature) ? HOLE_COLOR : BOSS_COLOR, transparent: true, opacity: isHole(feature) ? 0.5 * opacity : 0.55 * opacity, depthWrite: false }),
  );
  body.position.copy(start).addScaledVector(axis, feature.depth / 2);
  body.quaternion.copy(orientation);
  body.raycast = noRaycast;
  body.renderOrder = 3;
  body.name = `${feature.id}:marker`;
  // A ring at the face the feature starts on.
  const ringPoints = Array.from({ length: 33 }, (_, step) => {
    const angle = (2 * Math.PI * step) / 32;
    return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  });
  const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints), new THREE.LineBasicMaterial({ color: MARK_COLOR, transparent: true, opacity: 0.95 * opacity, depthWrite: false }));
  ring.position.copy(start);
  ring.quaternion.copy(orientation);
  ring.raycast = noRaycast;
  ring.renderOrder = 4;
  ring.name = `${feature.id}:ring`;
  return [body, ring];
}

/** One group per joint side, named `joint-marks`; every child ignores raycasts. The caller disposes it with `disposeObject`. */
export function buildPartMarks(marks: PartMarks): THREE.Group {
  const group = new THREE.Group();
  group.name = 'joint-marks';
  group.userData.jointMarks = true;
  group.userData.markId = markId(marks);
  const opacity = marks.glow || marks.state === 'open' ? 1 : 0.8;
  const color = marks.glow || marks.state === 'open' ? MARK_COLOR_OPEN : MARK_COLOR;
  const dashed = marks.state === 'problem';
  const outline = outlineLine(marks.outline, color, opacity, dashed);
  if (outline) group.add(outline);
  if (marks.glow) {
    // Thicker: a second outline just inside the first, over a brighter fill.
    const inner = outlineLine(marks.outline, color, opacity, false, 0.94);
    if (inner) group.add(inner);
    const fill = outlineFill(marks.outline, color, 0.28);
    if (fill) group.add(fill);
  }
  for (const feature of marks.features) group.add(...featureObjects(feature, opacity));
  return group;
}
