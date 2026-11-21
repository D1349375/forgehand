import { strToU8 } from 'fflate';
import type { ManifoldToplevel } from 'manifold-3d';
import { classifyPart, stepNumbers, scopeWorkspace, type ExportScope } from '../../shared/export-plan';
import { jointFeatures } from '../../shared/features';
import { checkJoints } from '../../shared/joint-rules';
import { assemblyNotes } from '../../shared/kit';
import type { PrinterProfile } from '../../shared/printer';
import type { SceneObject, Workspace } from '../../shared/workspace';
import { buildBom, bomCsv, bomMarkdown } from './bom';
import {
  classFindings, featuresSkippedJoints, jointFindings, sortFindings, unconfirmedFindings, type ExportFinding,
} from './findings';
import { formatDate } from './format';
import { abortError, buildPieces } from './pieces';
import { assemblySheetHtml } from './sheet';
import { writeStl } from './stl';
import { write3mf } from './threemf';
import { kitZipName, zipFiles, type KitFile } from './zip';

/**
 * Puts the whole kit together in memory (requirements 2 and 20 to 22, design 6.3): the pieces,
 * the STL and 3MF files, the BOM, the assembly sheet, the image and the GLB. A download only
 * hands over these bytes, so a single file equals its entry in the zip. The same workspace,
 * profile, scope and export time give the same bytes (requirement 64).
 */

export interface KitInput {
  workspace: Workspace;
  scope: ExportScope;
  profile: PrinterProfile;
  exportedAt: Date;
  loadManifold(): Promise<ManifoldToplevel>;
  /** The exploded image as PNG bytes (Task 4 passes the WebGL render). `null`, or an error, leaves the image out. */
  renderImage?(ws: Workspace, steps: Map<string, number>): Promise<Uint8Array | null>;
  /** The GLB of the exported objects (Task 4 passes `glb.ts`). Without it the kit has no `workspace.glb`. */
  writeGlb?(objects: readonly SceneObject[]): Promise<Uint8Array>;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
  yieldNow?(): Promise<void>;
}

export interface KitSummary {
  /** Unique print pieces. */
  pieces: number;
  /** Print pieces with their copies counted. */
  copies: number;
  /** Bought components, counted by part. */
  bought: number;
  /** Machined parts. */
  machined: number;
  /** Rows of standard parts. */
  standard: number;
  totalVolumeMm3: number;
}

export interface PreparedKit {
  summary: KitSummary;
  findings: ExportFinding[];
  files: KitFile[];
  zipName: string;
  /** No exploded image is in the kit: it could not be rendered, or no renderer was given. */
  imageMissing: boolean;
}

const MIME = {
  html: 'text/html;charset=utf-8',
  png: 'image/png',
  csv: 'text/csv;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  threeMf: 'model/3mf',
  glb: 'model/gltf-binary',
  stl: 'model/stl',
} as const;

/** The title of the sheet and the 3MF: the names of the objects in scope. */
const titleOf = (ws: Workspace): string => ws.objects.map(object => object.model.name).join('、');

export async function prepareKit(input: KitInput): Promise<PreparedKit> {
  const { profile, exportedAt, signal } = input;
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };
  const scoped = scopeWorkspace(input.workspace, input.scope);
  const features = jointFeatures(scoped, profile);
  const found = checkJoints(scoped, profile, features);
  const steps = stepNumbers(scoped, profile, features);
  const skipped = featuresSkippedJoints(found);

  // A kit with nothing to print (requirement 22) does not need the CSG module at all.
  const printable = scoped.objects.some(object => object.model.parts.some(part => classifyPart(object, part) === 'printed'));
  let built: Awaited<ReturnType<typeof buildPieces>> = { pieces: [], findings: [] };
  if (printable) {
    const wasm = await input.loadManifold();
    built = await buildPieces(scoped, profile, {
      wasm, features, skipped, signal, onProgress: input.onProgress, yieldNow: input.yieldNow,
    });
  } else {
    input.onProgress?.(0, 0);
  }
  throwIfAborted();

  const title = titleOf(scoped);
  const date = formatDate(exportedAt);
  const infos = built.pieces.map(piece => piece.info);
  const bom = buildBom(scoped, profile, infos, features, skipped, steps);
  const findings = sortFindings([
    ...jointFindings(scoped, found, steps),
    ...unconfirmedFindings(scoped, steps),
    ...classFindings(scoped),
    ...built.findings,
  ]);

  let image: Uint8Array | null = null;
  if (input.renderImage) {
    try {
      image = await input.renderImage(scoped, steps);
    } catch {
      image = null;
    }
    throwIfAborted();
  }
  const glb = input.writeGlb ? await input.writeGlb(scoped.objects) : null;
  throwIfAborted();

  const sheetSteps = assemblyNotes(scoped, profile, features).map((note, index) => ({
    number: index + 1, text: note.text, problem: skipped.has(note.jointId),
  }));
  const text = (path: string, mime: string, content: string): KitFile => ({ path, bytes: strToU8(content), mime });
  const files: KitFile[] = [
    text('assembly.html', MIME.html, assemblySheetHtml({ title, date, image, bom, steps: sheetSteps, findings })),
  ];
  if (image) files.push({ path: 'exploded.png', bytes: image, mime: MIME.png });
  files.push(
    text('bom.csv', MIME.csv, bomCsv(bom)),
    text('bom.md', MIME.markdown, bomMarkdown(bom, findings, { title, date })),
  );
  if (built.pieces.length > 0) {
    const objects = built.pieces.map(piece => ({
      number: piece.info.number, name: `${piece.info.name}（${piece.info.objectName}）`, color: piece.color,
      mesh: piece.mesh, copies: piece.info.count,
    }));
    files.push({ path: 'kit.3mf', bytes: write3mf({ title, objects }, exportedAt), mime: MIME.threeMf });
  }
  if (glb) files.push({ path: 'workspace.glb', bytes: glb, mime: MIME.glb });
  for (const piece of built.pieces) files.push({ path: piece.info.file, bytes: writeStl(piece.mesh, piece.info.number), mime: MIME.stl });

  return {
    summary: {
      pieces: bom.pieces.length,
      copies: bom.pieces.reduce((sum, piece) => sum + piece.count, 0),
      bought: bom.bought.reduce((sum, row) => sum + row.count, 0),
      machined: bom.machined.length,
      standard: bom.standard.length,
      totalVolumeMm3: bom.totalVolumeMm3,
    },
    findings,
    files,
    zipName: kitZipName(exportedAt),
    imageMissing: image === null,
  };
}

/** The zip of the kit: exactly the listed files, entry times set to the export time. */
export function kitZip(kit: PreparedKit, exportedAt: Date): Uint8Array {
  return zipFiles(kit.files, exportedAt);
}
