import * as THREE from 'three';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { partBoxes, worldMatrices } from '../../shared/bounds';
import { touching, worldFace, type WorldFace } from '../../shared/contact';
import { classifyPart, jointSideNames, stepNumbers } from '../../shared/export-plan';
import type { FeatureSet, JointFeature } from '../../shared/features';
import { CONTACT_FACES, type FaceId, type Joint } from '../../shared/joint';
import { CONTACT_ANGLE_DEG } from '../../shared/joint-constants';
import type { MaterialId } from '../../shared/materials';
import type { Part } from '../../shared/model';
import type { PrinterProfile } from '../../shared/printer';
import { ZERO_TRANSFORM, type SceneObject, type Workspace } from '../../shared/workspace';
import { featureSolids, primitiveSolid } from '../print/printable';
import type { PieceInfo } from './bom';
import { FUSE_MIN_MM3, FUSE_PARTS, LARGE_PIECE_MM } from './constants';
import { EXPORT_SEVERITY, exportMessage, sortFindings, type ExportFinding, type ExportFindingCode } from './findings';
import { meshBounds, meshKey, meshProblems, meshVolume, toPrintFrame, type MeshData } from './mesh';

/**
 * Print pieces (requirements 6 to 13 and 17, design 6.2). Within one object, printed parts that
 * overlap or touch are fused into one piece unless a joint separates them. A piece is built in
 * the object's model frame in millimetres: the union of its parts, then the bosses of the joint
 * features are added and the holes are cut after the union, so an overlapping part of the same
 * piece never fills a hole. The result is moved once into the main part's frame and the print
 * frame. Identical pieces are counted and the pieces are numbered. Runs in Node with the real
 * manifold-3d WASM and in the browser.
 */

const MM = 1000;
/** Two boxes overlap by volume only when they overlap by more than this in every axis (metres). */
const BOX_OVERLAP_M = 1e-9;
/** Normals of two touching faces point against each other; `touching` allows `CONTACT_ANGLE_DEG` of error. */
const OPPOSED_DOT = -Math.cos(THREE.MathUtils.degToRad(CONTACT_ANGLE_DEG)) + 1e-6;

type Params = Record<string, string | number>;

export interface PieceBuild {
  info: PieceInfo;
  /** Print frame, millimetres, closed and outward (`meshProblems` is `[]`). */
  mesh: MeshData;
  /** Colour of the main part, `#rrggbb`. */
  color: string;
  /** `{material}|{colour}|{meshKey}`. */
  key: string;
  objectId: string;
  mainPartId: string;
  partIds: string[];
}

export interface PiecesResult {
  /** Unique pieces, numbered `P01`, … in workspace object order, then by the model order of the main part. */
  pieces: PieceBuild[];
  findings: ExportFinding[];
}

export interface PiecesInput {
  wasm: ManifoldToplevel;
  features: FeatureSet;
  /** Joints with an error finding: their features are not cut. */
  skipped: ReadonlySet<string>;
  /** Defaults to `FUSE_PARTS`; tests pass `false` for one piece per printed part. */
  fuse?: boolean;
  signal?: AbortSignal;
  /** `done` and `total` count printed parts. */
  onProgress?(done: number, total: number): void;
  /** Lets the page paint between pieces; the browser passes `() => new Promise(r => setTimeout(r, 0))`. */
  yieldNow?(): Promise<void>;
}

export function abortError(): DOMException {
  return new DOMException('已停止準備匯出內容。', 'AbortError');
}

interface Disposable { delete(): void }

/** Every Manifold created is kept here and deleted once, so a failure or an abort cannot leak one. */
class Owner {
  private readonly items = new Set<Disposable>();

  keep<T extends Disposable>(item: T): T {
    this.items.add(item);
    return item;
  }

  /** Deletes one item now. Items already freed are ignored. */
  free(item: Disposable): void {
    if (this.items.delete(item)) item.delete();
  }

  dispose(): void {
    const items = [...this.items];
    this.items.clear();
    for (const item of items) {
      try {
        item.delete();
      } catch {
        // A failing delete must not hide the error that led here.
      }
    }
  }
}

/** The part's world matrix with its translation in millimetres (the matrix of the object's model frame). */
function millimetres(world: THREE.Matrix4): THREE.Matrix4 {
  const matrix = world.clone();
  const at = new THREE.Vector3().setFromMatrixPosition(matrix).multiplyScalar(MM);
  return matrix.setPosition(at);
}

const asMat4 = (matrix: THREE.Matrix4) => matrix.elements as Mat4;

function toMeshData(solid: Manifold): MeshData {
  const { numProp, vertProperties, triVerts } = solid.getMesh();
  const count = vertProperties.length / numProp;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = vertProperties[i * numProp]!;
    positions[i * 3 + 1] = vertProperties[i * numProp + 1]!;
    positions[i * 3 + 2] = vertProperties[i * numProp + 2]!;
  }
  return { positions, indices: Uint32Array.from(triVerts) };
}

interface Placed {
  part: Part;
  /** Part-local to object model frame, millimetres. */
  world: THREE.Matrix4;
  /** The part's solid in the object's model frame, millimetres. */
  solid: Manifold;
  volumeMm3: number;
  /** Axis-aligned box in the model frame, metres. */
  box: THREE.Box3;
}

/** A finding about one piece, finished once the piece has its number and name. */
interface Draft {
  code: ExportFindingCode;
  params: Params;
  jointId: string | null;
}

/** One built piece of one object, before identical pieces are merged. */
interface Built {
  object: SceneObject;
  main: Part;
  parts: Part[];
  mesh: MeshData;
  color: string;
  key: string;
  drafts: Draft[];
}

const overlapsInVolume = (a: THREE.Box3, b: THREE.Box3): boolean =>
  Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) > BOX_OVERLAP_M
  && Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y) > BOX_OVERLAP_M
  && Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) > BOX_OVERLAP_M;

/** Boxes closer than `CONTACT_GAP_MM` (expanded by `gapM`) may still touch. */
const near = (a: THREE.Box3, b: THREE.Box3, gapM: number): boolean => a.clone().expandByScalar(gapM).intersectsBox(b);

export async function buildPieces(ws: Workspace, profile: PrinterProfile, input: PiecesInput): Promise<PiecesResult> {
  const { wasm, features, signal } = input;
  const fuse = input.fuse ?? FUSE_PARTS;
  const { Manifold } = wasm;
  const steps = stepNumbers(ws, profile, features);
  const checkAbort = () => {
    if (signal?.aborted) throw abortError();
  };
  const total = ws.objects.reduce((sum, object) => sum + object.model.parts.filter(part => classifyPart(object, part) === 'printed').length, 0);
  let done = 0;

  const built: Built[] = [];
  const findings: ExportFinding[] = [];
  /** Joints that get `FEATURES_SKIPPED`: an error, an invalid feature, or a piece that only built without its features. */
  const featureSkips = new Set<string>([...input.skipped].filter(id => ws.joints.some(joint => joint.id === id)));
  const jointFinding = (code: ExportFindingCode, joint: Joint, params: Params = {}): ExportFinding => ({
    severity: EXPORT_SEVERITY[code], code, source: 'export',
    message: exportMessage(code, { ...jointSideNames(ws, joint), ...params }),
    jointId: joint.id, step: steps.get(joint.id) ?? null, piece: null,
  });

  checkAbort();
  input.onProgress?.(0, total);

  for (const object of ws.objects) {
    const printed = object.model.parts.filter(part => classifyPart(object, part) === 'printed');
    if (printed.length === 0) continue;
    const own = new Owner();
    try {
      const worlds = worldMatrices(object.model);
      const boxes = partBoxes(object.model);
      const featuresOf = (part: Part): readonly JointFeature[] => features.parts.get(`${object.id}:${part.id}`) ?? [];

      // 1. Solids: every printed part in the object's model frame, in millimetres.
      const placed: Placed[] = [];
      for (const part of printed) {
        checkAbort();
        const world = millimetres(worlds.get(part.id)!);
        const base = own.keep(primitiveSolid(wasm, part));
        const solid = own.keep(base.transform(asMat4(world)));
        own.free(base);
        placed.push({ part, world, solid, volumeMm3: solid.volume(), box: boxes.get(part.id)! });
      }
      const indexOf = new Map(placed.map((item, index) => [item.part.id, index]));

      const overlapMm3 = (a: Placed, b: Placed): number => {
        if (!overlapsInVolume(a.box, b.box)) return 0;
        const common = own.keep(a.solid.intersect(b.solid));
        const volume = common.volume();
        own.free(common);
        return volume;
      };

      // Joints between two printed parts of this object: never linked, and reported when they overlap (requirement 17).
      const objectJoints = ws.joints.filter(joint => joint.a.objectId === object.id && joint.b.objectId === object.id
        && indexOf.has(joint.a.partId) && indexOf.has(joint.b.partId));
      const pairKey = (x: number, y: number) => (x < y ? `${x}|${y}` : `${y}|${x}`);
      const jointPairs = new Set(objectJoints.map(joint => pairKey(indexOf.get(joint.a.partId)!, indexOf.get(joint.b.partId)!)));
      for (const joint of objectJoints) {
        checkAbort();
        const volume = overlapMm3(placed[indexOf.get(joint.a.partId)!]!, placed[indexOf.get(joint.b.partId)!]!);
        if (volume >= FUSE_MIN_MM3) findings.push(jointFinding('JOINT_OVERLAP', joint, { n: Math.round(volume) }));
      }

      // 2. Links: overlapping solids, or touching contact faces (requirement 6).
      const parent = placed.map((_, index) => index);
      const root = (index: number): number => {
        let at = index;
        while (parent[at] !== at) {
          parent[at] = parent[parent[at]!]!;
          at = parent[at]!;
        }
        return at;
      };
      if (fuse) {
        const faces = new Map<string, WorldFace | null>();
        const faceOf = (part: Part, face: FaceId): WorldFace | null => {
          const key = `${part.id}:${face}`;
          if (!faces.has(key)) faces.set(key, worldFace(object, part, face, ZERO_TRANSFORM));
          return faces.get(key)!;
        };
        const facesTouch = (a: Part, b: Part): boolean => {
          for (const fa of Object.keys(CONTACT_FACES[a.primitive]) as FaceId[]) {
            const wa = faceOf(a, fa);
            if (!wa) continue;
            for (const fb of Object.keys(CONTACT_FACES[b.primitive]) as FaceId[]) {
              const wb = faceOf(b, fb);
              if (wb && wa.normal.dot(wb.normal) <= OPPOSED_DOT && touching(wa, wb).ok) return true;
            }
          }
          return false;
        };
        const gapM = 0.1 / MM;
        for (let i = 0; i < placed.length; i += 1) {
          for (let j = i + 1; j < placed.length; j += 1) {
            const a = placed[i]!;
            const b = placed[j]!;
            if (root(i) === root(j) || jointPairs.has(pairKey(i, j)) || !near(a.box, b.box, gapM)) continue;
            checkAbort();
            if (overlapMm3(a, b) >= FUSE_MIN_MM3 || facesTouch(a.part, b.part)) parent[root(i)] = root(j);
          }
        }
      }
      await input.yieldNow?.();

      // 3. Pieces: the connected groups, in the model order of their main part (the part with the largest solid).
      const groups = new Map<number, number[]>();
      placed.forEach((_, index) => {
        const key = root(index);
        groups.set(key, [...(groups.get(key) ?? []), index]);
      });
      const pieces = [...groups.values()].map(members => {
        let main = members[0]!;
        for (const index of members) if (placed[index]!.volumeMm3 > placed[main]!.volumeMm3 * (1 + 1e-9) + 1e-9) main = index;
        return { members, main };
      }).sort((x, y) => x.main - y.main);

      // 4. A joint whose two sides end up in one piece keeps the piece in one solid and cuts no holes.
      const pieceOf = new Map<number, number>();
      pieces.forEach((piece, at) => piece.members.forEach(index => pieceOf.set(index, at)));
      const fusedJoints: Joint[][] = pieces.map(() => []);
      const localSkip = new Set<string>();
      for (const joint of objectJoints) {
        const at = pieceOf.get(indexOf.get(joint.a.partId)!)!;
        if (at !== pieceOf.get(indexOf.get(joint.b.partId)!)) continue;
        fusedJoints[at]!.push(joint);
        localSkip.add(joint.id);
      }
      const skipJoint = (jointId: string) => input.skipped.has(jointId) || localSkip.has(jointId);

      // 5. Bought components, placed like printed parts, for the `COMPONENT_BLOCKED` check.
      const qualify = ws.objects.length > 1;
      const bought: Array<{ name: string; solid: Manifold; box: THREE.Box3 }> = [];
      for (const part of object.model.parts) {
        if (classifyPart(object, part) !== 'bought') continue;
        checkAbort();
        const base = own.keep(primitiveSolid(wasm, part));
        const solid = own.keep(base.transform(asMat4(millimetres(worlds.get(part.id)!))));
        own.free(base);
        bought.push({ name: qualify ? `${object.model.name}・${part.name}` : part.name, solid, box: boxes.get(part.id)! });
      }

      for (const [at, piece] of pieces.entries()) {
        const members = piece.members.map(index => placed[index]!);
        const mainPlaced = placed[piece.main]!;
        const pieceOwn = new Owner();
        try {
          /** The union of the piece's parts, built on first use; a piece of one part is that part's solid. */
          let union: Manifold | null = members.length === 1 ? mainPlaced.solid : null;
          const unionOfMembers = (): Manifold => (union ??= pieceOwn.keep(Manifold.union(members.map(item => item.solid))));
          const drafts: Draft[] = [];
          const skipIds = new Set(members.flatMap(item => featuresOf(item.part)).filter(feature => skipJoint(feature.jointId)).map(feature => feature.id));
          const toMain = millimetres(worlds.get(mainPlaced.part.id)!).invert();

          /** The mesh of the piece with or without its joint features, or `null` when it is not a valid solid. */
          const attempt = (withFeatures: boolean): { mesh: MeshData; invalid: Set<string> } | null => {
            const invalid = new Set<string>();
            const bosses: Manifold[] = [];
            const holes: Manifold[] = [];
            if (withFeatures) {
              for (const item of members) {
                const list = featuresOf(item.part);
                if (list.length === 0) continue;
                const made = featureSolids(wasm, list, { skip: skipIds });
                for (const solid of [...made.bosses, ...made.holes]) pieceOwn.keep(solid);
                const place = (solid: Manifold) => pieceOwn.keep(solid.transform(asMat4(item.world)));
                bosses.push(...made.bosses.map(place));
                holes.push(...made.holes.map(place));
                for (const solid of [...made.bosses, ...made.holes]) pieceOwn.free(solid);
                const reasons = new Map(made.skipped.map(entry => [entry.featureId, entry.reason]));
                for (const feature of list) if (reasons.get(feature.id) === 'invalid') invalid.add(feature.jointId);
              }
            }
            checkAbort();
            let solid = unionOfMembers();
            if (bosses.length > 0) solid = pieceOwn.keep(Manifold.union([solid, ...bosses]));
            if (holes.length > 0) solid = pieceOwn.keep(Manifold.difference([solid, ...holes]));
            checkAbort();
            if (solid.status() !== 'NoError' || solid.isEmpty()) return null;
            const moved = pieceOwn.keep(solid.transform(asMat4(toMain)));
            if (moved.status() !== 'NoError' || moved.isEmpty()) return null;
            // The matrix is the identity here: `toPrintFrame` applies the print frame and rests the piece on Z = 0.
            const mesh = toPrintFrame(toMeshData(moved));
            return meshProblems(mesh).length === 0 ? { mesh, invalid } : null;
          };

          const guarded = (withFeatures: boolean) => {
            try {
              return attempt(withFeatures);
            } catch (error) {
              if (error instanceof DOMException && error.name === 'AbortError') throw error;
              return null;
            }
          };
          let result = guarded(true);
          if (result !== null) {
            for (const jointId of result.invalid) featureSkips.add(jointId);
          } else if (members.some(item => featuresOf(item.part).some(feature => !skipIds.has(feature.id)))) {
            // Retry without the features: the piece is written, the joints that wanted holes are reported.
            result = guarded(false);
            if (result !== null) {
              for (const item of members) for (const feature of featuresOf(item.part)) if (!skipIds.has(feature.id)) featureSkips.add(feature.jointId);
            }
          }

          const name = pieceName(mainPlaced.part, members.length);
          if (result === null) {
            findings.push({
              severity: EXPORT_SEVERITY.PIECE_FAILED, code: 'PIECE_FAILED', source: 'export',
              message: exportMessage('PIECE_FAILED', { piece: name }), jointId: null, step: null, piece: null,
            });
          } else {
            const { mesh } = result;
            for (const joint of fusedJoints[at]!) drafts.push({ code: 'JOINT_FUSED', params: jointSideNames(ws, joint), jointId: joint.id });
            for (const component of bought) {
              if (!members.some(item => overlapsInVolume(item.box, component.box))) continue;
              const common = pieceOwn.keep(unionOfMembers().intersect(component.solid));
              const volume = common.volume();
              pieceOwn.free(common);
              if (volume >= FUSE_MIN_MM3) drafts.push({ code: 'COMPONENT_BLOCKED', params: { part: component.name }, jointId: null });
            }
            const extent = meshBounds(mesh);
            const longest = Math.max(extent.max[0] - extent.min[0], extent.max[1] - extent.min[1], extent.max[2] - extent.min[2]);
            if (members.length > 1) drafts.push({ code: 'FUSED', params: { n: members.length }, jointId: null });
            if (longest > LARGE_PIECE_MM) drafts.push({ code: 'TOO_LARGE', params: { n: Math.round(longest) }, jointId: null });
            const named = ws.joints.some(joint => [joint.a, joint.b].some(side => side.objectId === object.id && members.some(item => item.part.id === side.partId)));
            if (pieces.length > 1 && members.length === 1 && !named) drafts.push({ code: 'LOOSE_PIECE', params: {}, jointId: null });
            const color = mainPlaced.part.color.toLowerCase();
            built.push({
              object, main: mainPlaced.part, parts: members.map(item => item.part), mesh, color,
              key: `${object.material ?? 'none'}|${color}|${meshKey(mesh)}`, drafts,
            });
          }
        } finally {
          pieceOwn.dispose();
        }
        done += members.length;
        input.onProgress?.(done, total);
        await input.yieldNow?.();
        checkAbort();
      }
    } finally {
      own.dispose();
    }
  }

  // Identical pieces (requirement 12) and numbering (requirement 13).
  const unique = new Map<string, { first: Built; count: number; build: PieceBuild }>();
  for (const item of built) {
    const known = unique.get(item.key);
    if (known) {
      known.count += 1;
      continue;
    }
    const number = `P${String(unique.size + 1).padStart(2, '0')}`;
    const bounds = meshBounds(item.mesh);
    const material: MaterialId | null = item.object.material ?? null;
    const info: PieceInfo = {
      number, name: pieceName(item.main, item.parts.length), objectId: item.object.id, objectName: item.object.model.name, material,
      count: 1, sizeMm: { x: bounds.max[0] - bounds.min[0], y: bounds.max[1] - bounds.min[1], z: bounds.max[2] - bounds.min[2] },
      volumeMm3: meshVolume(item.mesh), file: `stl/${number}-${item.main.id}.stl`, partNames: item.parts.map(part => part.name),
    };
    unique.set(item.key, {
      first: item, count: 1,
      build: { info, mesh: item.mesh, color: item.color, key: item.key, objectId: item.object.id, mainPartId: item.main.id, partIds: item.parts.map(part => part.id) },
    });
  }
  for (const entry of unique.values()) entry.build.info.count = entry.count;

  const seen = new Set<string>();
  for (const item of built) {
    const target = unique.get(item.key)!.build.info;
    for (const draft of item.drafts) {
      const finding: ExportFinding = {
        severity: EXPORT_SEVERITY[draft.code], code: draft.code, source: 'export',
        message: exportMessage(draft.code, { ...draft.params, piece: target.name }),
        jointId: draft.jointId, step: draft.jointId ? steps.get(draft.jointId) ?? null : null, piece: target.number,
      };
      const id = `${finding.code}|${finding.piece}|${finding.message}`;
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push(finding);
    }
  }
  for (const joint of ws.joints) if (featureSkips.has(joint.id)) findings.push(jointFinding('FEATURES_SKIPPED', joint));

  return { pieces: [...unique.values()].map(entry => entry.build), findings: sortFindings(findings) };
}

/** 「{main part name}」, or 「{main part name}（含 n 個零件）」 for a fused piece. */
function pieceName(main: Part, count: number): string {
  return count > 1 ? `${main.name}（含 ${count} 個零件）` : main.name;
}
