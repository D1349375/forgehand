import * as THREE from 'three';
import { assemblyOf, objectMatrix } from '../../shared/assembly';
import { partBoxes, worldMatrices } from '../../shared/bounds';
import { localFace, worldFace } from '../../shared/contact';
import type { Joint, JointSide } from '../../shared/joint';
import type { ModelSpec, Part } from '../../shared/model';
import type { SceneObject, Workspace } from '../../shared/workspace';
import { computeExplosion, explodedOffsets } from '../scene/explode';
import { buildModel, disposeObject } from '../scene/geometry';
import { IMAGE_HEIGHT, IMAGE_WIDTH, SEPARATION_FACTOR } from './constants';
/**
 * The exploded-view image of the kit (requirements 40 to 44, design 7.4). `explodedLayout` is
 * pure and runs in Node: it decides where every part and object is drawn and where the step
 * badges go. `renderKitImage` draws that layout in print style on white with its own short-lived
 * renderer, so the live view, its camera and its exploded state are never touched.
 */
type Vector = { x: number; y: number; z: number };
export interface ImageLayout {
  objects: Array<{
    objectId: string;
    /** Object matrix with the assembly separation applied: model frame to world. */
    root: THREE.Matrix4;
    /** Exploded position of every part in its parent's frame (metres). */
    parts: Map<string, THREE.Vector3>;
  }>;
  /** One per joint that has a step number: the world point where the badge is drawn. */
  badges: Array<{ step: number; point: THREE.Vector3 }>;
  /** World box of every exploded part, with the separation applied. */
  bounds: THREE.Box3;
}
interface Drawn {
  object: SceneObject;
  matrix: THREE.Matrix4;
  /** Total exploded translation of each part, in the model frame. */
  offsets: Map<string, THREE.Vector3>;
  /** Part matrices in the model frame, not exploded. */
  matrices: Map<string, THREE.Matrix4>;
  positions: Map<string, THREE.Vector3>;
  /** World box of the exploded object before any separation. */
  box: THREE.Box3;
}
function drawObject(object: SceneObject): Drawn {
  const model = object.model;
  const offsets = explodedOffsets(model, computeExplosion(model), 1);
  const matrices = worldMatrices(model);
  const positions = new Map<string, THREE.Vector3>();
  for (const part of model.parts) {
    // A child node moves in its parent's (rotated) frame: the part's own move is the difference of the totals.
    const delta = offsets.get(part.id)!.clone();
    if (part.parentId) {
      delta.sub(offsets.get(part.parentId)!);
      delta.applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(matrices.get(part.parentId)!).invert());
    }
    positions.set(part.id, new THREE.Vector3(part.position.x, part.position.y, part.position.z).add(delta));
  }
  const modelBox = new THREE.Box3();
  for (const box of partBoxes(model, offsets).values()) modelBox.union(box);
  const matrix = objectMatrix(object.transform);
  return { object, matrix, offsets, matrices, positions, box: modelBox.applyMatrix4(matrix) };
}
/** Interval of a box along a unit direction. */
function projection(box: THREE.Box3, direction: THREE.Vector3): { min: number; max: number } {
  const centre = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const middle = centre.dot(direction);
  const reach = half.x * Math.abs(direction.x) + half.y * Math.abs(direction.y) + half.z * Math.abs(direction.z);
  return { min: middle - reach, max: middle + reach };
}
const diagonal = (box: THREE.Box3): number => box.getSize(new THREE.Vector3()).length();
const volume = (box: THREE.Box3): number => { const size = box.getSize(new THREE.Vector3()); return size.x * size.y * size.z; };
/**
 * Where everything is drawn. `ws` is the scoped workspace and `steps` maps joint ids to step numbers.
 * 1. Every object is fully exploded (`computeExplosion`).
 * 2. Objects joined to each other are drawn apart along the joint (requirement 41): in each assembly the largest object
 *    stays; a breadth-first walk in step order moves every newly reached object, and everything reached through it, along
 *    the outward contact-face normal of the object it was reached from, until the two are separate along that normal,
 *    plus `SEPARATION_FACTOR` of the smaller object's size.
 * 3. A badge sits halfway between the two contact faces of every joint that has a step (requirement 42).
 */
export function explodedLayout(ws: Workspace, steps: ReadonlyMap<string, number>): ImageLayout {
  const drawn = new Map(ws.objects.map(object => [object.id, drawObject(object)] as const));
  const shifts = new Map<string, THREE.Vector3>(ws.objects.map(object => [object.id, new THREE.Vector3()] as const));
  const done = new Set<string>();
  const order = (joint: Joint): number => steps.get(joint.id) ?? Number.POSITIVE_INFINITY;
  const crossing = ws.joints
    .filter(joint => joint.a.objectId !== joint.b.objectId && drawn.has(joint.a.objectId) && drawn.has(joint.b.objectId))
    .map((joint, index) => ({ joint, index }))
    .sort((x, y) => order(x.joint) - order(y.joint) || x.index - y.index)
    .map(entry => entry.joint);
  for (const first of ws.objects) {
    if (done.has(first.id)) continue;
    const members = assemblyOf(ws, first.id).filter(id => drawn.has(id));
    members.forEach(id => done.add(id));
    if (members.length < 2) continue;
    // The largest exploded object stays; ties go to workspace order (`members` is in workspace order).
    const anchor = members.reduce((best, id) => (volume(drawn.get(id)!.box) > volume(drawn.get(best)!.box) + 1e-12 ? id : best));
    const placed = new Set([anchor]);
    const queue = [anchor];
    for (let at = 0; at < queue.length; at++) {
      const from = queue[at]!;
      for (const joint of crossing) {
        const fromSide: JointSide | null = joint.a.objectId === from ? joint.a : joint.b.objectId === from ? joint.b : null;
        if (!fromSide) continue;
        const to = fromSide === joint.a ? joint.b.objectId : joint.a.objectId;
        if (placed.has(to)) continue;
        placed.add(to);
        queue.push(to);
        const source = drawn.get(from)!;
        const target = drawn.get(to)!;
        const part = source.object.model.parts.find(candidate => candidate.id === fromSide.partId);
        const face = part ? worldFace(source.object, part, fromSide.face) : null;
        const normal = face ? face.normal.clone() : target.box.getCenter(new THREE.Vector3()).sub(source.box.getCenter(new THREE.Vector3()));
        if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
        normal.normalize();
        // Both boxes travel with the same shift so far, so the unshifted boxes give the same gap.
        const gap = Math.max(0, projection(source.box, normal).max - projection(target.box, normal).min);
        const distance = gap + SEPARATION_FACTOR * Math.min(diagonal(source.box), diagonal(target.box));
        shifts.set(to, shifts.get(from)!.clone().addScaledVector(normal, distance));
      }
    }
  }
  const bounds = new THREE.Box3();
  const objects: ImageLayout['objects'] = ws.objects.map(object => {
    const entry = drawn.get(object.id)!;
    const shift = shifts.get(object.id)!;
    bounds.union(entry.box.clone().translate(shift));
    return { objectId: object.id, root: new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z).multiply(entry.matrix), parts: entry.positions };
  });
  const badges: ImageLayout['badges'] = [];
  const faceCentre = (side: JointSide): THREE.Vector3 | null => {
    const entry = drawn.get(side.objectId);
    const part: Part | undefined = entry?.object.model.parts.find(candidate => candidate.id === side.partId);
    const face = part ? localFace(part, side.face) : null;
    if (!entry || !part || !face) return null;
    return face.centre.clone()
      .applyMatrix4(entry.matrices.get(part.id)!)
      .add(entry.offsets.get(part.id)!)
      .applyMatrix4(entry.matrix)
      .add(shifts.get(side.objectId)!);
  };
  for (const joint of ws.joints) {
    const step = steps.get(joint.id);
    const a = faceCentre(joint.a);
    const b = faceCentre(joint.b);
    if (step !== undefined && a && b) badges.push({ step, point: a.add(b).multiplyScalar(0.5) });
  }
  return { objects, badges, bounds };
}
const DEFAULT_VIEW = new THREE.Vector3(3, 2, 4);
const EDGE_COLOUR = '#1f2933';
const BADGE_COLOUR = '#111827';
/** An opaque print-style part: solid colour with dark edges (requirement 40). The edges follow the geometry, so the caller disposes both. */
function printPart(geometry: THREE.BufferGeometry, part: Part): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: part.color, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  group.add(new THREE.Mesh(geometry, material));
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 24), new THREE.LineBasicMaterial({ color: EDGE_COLOUR })));
  return group;
}
function addLights(scene: THREE.Scene, camera: THREE.Camera) {
  const basis = (column: number) => new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, column);
  const right = basis(0);
  const up = basis(1);
  const back = basis(2);
  scene.add(new THREE.HemisphereLight('#ffffff', '#cbd2d9', 1.4));
  const key = new THREE.DirectionalLight('#ffffff', 2.2);
  key.position.copy(back).multiplyScalar(1.2).addScaledVector(up, 1).addScaledVector(right, -0.8).multiplyScalar(10);
  const fill = new THREE.DirectionalLight('#ffffff', 0.9);
  fill.position.copy(back).multiplyScalar(0.6).addScaledVector(up, 0.2).addScaledVector(right, 1).multiplyScalar(10);
  scene.add(key, fill);
}
function drawBadge(context: CanvasRenderingContext2D, x: number, y: number, step: number) {
  context.beginPath();
  context.arc(x, y, 18, 0, Math.PI * 2);
  context.fillStyle = BADGE_COLOUR;
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = '#ffffff';
  context.stroke();
  context.fillStyle = '#ffffff';
  context.font = 'bold 20px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(step), x, y + 1);
}
/**
 * `exploded.png` of the laid-out objects, 1600 x 1200, or `null` when no image can be made (no WebGL context, a failed
 * render). The camera looks along `-viewDirection` at the centre of the layout and fits its bounding sphere with a 15 %
 * margin. The renderer and every Three.js resource are released before this returns.
 */
export async function renderKitImage(ws: Workspace, layout: ImageLayout, viewDirection: Vector | null): Promise<Uint8Array | null> {
  const scene = new THREE.Scene();
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    const canvas = document.createElement('canvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(IMAGE_WIDTH, IMAGE_HEIGHT, false);
    scene.background = new THREE.Color('#ffffff');
    for (const entry of layout.objects) {
      const object = ws.objects.find(candidate => candidate.id === entry.objectId);
      if (!object) continue;
      const model: ModelSpec = {
        ...object.model,
        parts: object.model.parts.map(part => {
          const at = entry.parts.get(part.id);
          return at ? { ...part, position: { x: at.x, y: at.y, z: at.z } } : part;
        }),
      };
      const group = buildModel(model, printPart);
      scene.add(group); // attached first, so a failure below is cleaned up with the scene
      group.applyMatrix4(entry.root);
    }
    scene.updateMatrixWorld(true);
    const direction = viewDirection ? new THREE.Vector3(viewDirection.x, viewDirection.y, viewDirection.z) : DEFAULT_VIEW.clone();
    if (!Number.isFinite(direction.lengthSq()) || direction.lengthSq() < 1e-12) direction.copy(DEFAULT_VIEW);
    direction.normalize();
    const sphere = layout.bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1e-3);
    const camera = new THREE.PerspectiveCamera(30, IMAGE_WIDTH / IMAGE_HEIGHT, 0.001, 1000);
    // The narrower of the two half angles decides the distance at which the sphere fits.
    const halfVertical = THREE.MathUtils.degToRad(camera.fov / 2);
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * camera.aspect);
    const distance = (radius * 1.15) / Math.sin(Math.min(halfVertical, halfHorizontal));
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    camera.near = Math.max(distance - radius * 2, radius * 0.01);
    camera.far = distance + radius * 4;
    camera.updateProjectionMatrix();
    camera.lookAt(sphere.center);
    camera.updateMatrixWorld(true);
    addLights(scene, camera);
    renderer.render(scene, camera);
    const output = document.createElement('canvas');
    output.width = IMAGE_WIDTH;
    output.height = IMAGE_HEIGHT;
    const context = output.getContext('2d');
    if (!context) return null;
    context.drawImage(canvas, 0, 0);
    for (const badge of layout.badges) {
      const point = badge.point.clone().project(camera);
      drawBadge(context, ((point.x + 1) / 2) * IMAGE_WIDTH, ((1 - point.y) / 2) * IMAGE_HEIGHT, badge.step);
    }
    const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    disposeObject(scene);
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
}
