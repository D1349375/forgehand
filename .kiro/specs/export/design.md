# Export: a printable kit — Design

This design satisfies `requirements.md`. It follows the patterns of `workspace-v2` and `assembly-joints`: pure modules unit-tested in Node, thin React and Three.js wiring covered by Playwright, and one place for every rule. Requirement numbers (R…) refer to `requirements.md`; task numbers (T1–T5) refer to `tasks.md`; "AJ" means `assembly-joints` and "AJ R…" or "AJ §…" its requirements and design.

## 1. Approach

```
writers      src/export: mesh helpers and the print frame, binary STL, 3MF package and plate layout,
             zip, GLB scene and GLTFExporter, escaping and number formats                  (T1, no AJ dependency)
plan + docs  shared/export-plan.ts: scope, classification, joint labels, step numbers, the agent summary
             src/export: findings table, BOM rows, bom.csv, bom.md, assembly.html          (T2, after AJ T3)
pieces       src/export: fusion graph, union, joint features, print frame, identical pieces,
             export findings; prepareKit puts every file together                          (T3, after AJ T2–T3)
browser      匯出套件 button, the export dialog, exploded image off screen, downloads       (T4)
agent        prepare_export, StateChange.exportDialog, instructions; README                 (T5)
```

Four ideas carry the design:

1. **Writers take plain data.** Every file writer takes plain values (a mesh as `Float32Array` positions and `Uint32Array` indices in millimetres, rows of text, a list of files) and returns bytes or a string. They know nothing about workspaces or joints, so Task 1 can be built and tested before the joint rules exist, and every writer runs in Node.
2. **One preparation, then downloads.** The dialog runs `prepareKit` once per snapshot. It builds every file in memory (pieces, STL, 3MF, BOM, sheet, image, GLB) and lists them with their sizes. A download only zips or hands over bytes that already exist, so the zip and the single files are byte-identical (R21) and the summary always matches what is downloaded (R2).
3. **Pieces are built in the object frame, written in the main part's frame.** All printed parts and their joint features are placed in the object's model frame in millimetres, fused and cut there, and the result is moved once into the main part's frame and the print frame. Holes are cut after the union, so no fused part can fill them (R8).
4. **The agent prepares; the user downloads.** `prepare_export` computes a summary from the same shared functions as the dialog (without CSG) and opens the dialog through a session-state field of `StateChange`, like `tryOn`. Downloading always needs the user's click (R56–R58).

## 2. Module layout

```
src/export/constants.ts     T1  PLATE_GAP_MM, PLATE_ROW_MM, MESH_KEY_MM, STL_HEADER_BYTES;  T3 FUSE_PARTS, FUSE_MIN_MM3, LARGE_PIECE_MM;
                                T4 IMAGE_WIDTH, IMAGE_HEIGHT, SEPARATION_FACTOR
src/export/mesh.ts          T1  MeshData, meshBounds, meshVolume, meshProblems, PRINT_FRAME, toPrintFrame, meshKey
src/export/stl.ts           T1  writeStl
src/export/threemf.ts       T1  ThreeMfObject, layoutPlate, threeMfModelXml, write3mf
src/export/zip.ts           T1  KitFile, zipFiles, kitZipName
src/export/glb.ts           T1  buildGlbScene (Node), writeGlb (GLTFExporter)
src/export/format.ts        T1  xmlEscape, htmlEscape, mdCell, csvField, csvRow, formatMm, formatCm3, formatDate, base64
shared/export-plan.ts       T2  ExportScopeSchema, scopeWorkspace, classifyPart, METHOD_KIND_LABELS, jointLabel, stepNumbers,
                                boughtRows, machinedRows, ExportSummarySchema, exportSummary
src/export/findings.ts      T2  ExportFinding, EXPORT_MESSAGES, exportMessage, unconfirmedFindings, classFindings, sortFindings
src/export/bom.ts           T2  PieceInfo, Bom, buildBom, bomCsv, bomMarkdown
src/export/sheet.ts         T2  assemblySheetHtml
src/print/printable.ts      T3  (AJ file) two more exports: primitiveSolid, featureSolids; printablePart uses them
src/export/pieces.ts        T3  buildPieces (fusion, union, features, frame, identical pieces, findings, progress)
src/export/prepare.ts       T3  KitInput, PreparedKit, prepareKit, kitZip
src/export/kit-image.ts     T4  explodedLayout (Node), renderKitImage (WebGL, 2D canvas)
src/export/dialog-model.ts  T4  defaultScope, scopeChoiceVisible, sameSnapshot, fileRows, problemBanner (pure)
src/export/download.ts      T4  downloadBytes
src/export/ExportDialog.tsx T4  the dialog (lazy chunk)
src/scene/SceneViewport.tsx T4  SceneHandle.viewDirection() (additive)
src/App.tsx                 T4  匯出套件 button, export state, lazy dialog;  T5 open the dialog from agent events
src/styles.css              T4  dialog styles
shared/agent.ts             T5  StateChangeSchema.exportDialog
server/tools/prepare-export.ts T5  NEW;  server/tools/index.ts, helpers.ts, server/agent.ts  T5 EDIT
src/agent/apply-state.ts, useAgentRun.ts  T5  exportDialog effect, openExport option
README.md                   T5  export section, privacy line, fflate credit
package.json                T1  fflate 0.8.3, exact

tests/unit/export-writers.test.ts   T1     tests/unit/export-plan.test.ts     T2
tests/unit/export-docs.test.ts      T2     tests/unit/export-pieces.test.ts   T3
tests/unit/export-dialog.test.ts    T4     tests/unit/export-agent.test.ts    T5
tests/fixtures/export-workspace.ts  T2 (fused demo cases, hostile names; reuses tests/fixtures/joint-workspace.ts)
tests/e2e/export.spec.ts            T4 (T5 adds the agent case)
```

Dependency direction: `src/export/format.ts`, `mesh.ts` ← `stl.ts`, `threemf.ts`, `zip.ts`; `shared/export-plan.ts` ← `findings.ts` ← `bom.ts`, `sheet.ts` ← `pieces.ts` ← `prepare.ts` ← `ExportDialog.tsx`. `shared/export-plan.ts` imports `shared/kit.ts`, `shared/features.ts`, `shared/joint-rules.ts` (AJ T2–T3) and uses only Three.js math classes, so the server can import it. Nothing in `src/export/` is imported by the main chunk except through `React.lazy` (R49).

## 3. Writers (T1)

### 3.1 Mesh data and the print frame (R10–R12)

```ts
// src/export/mesh.ts
export interface MeshData { positions: Float32Array /* mm, xyz */; indices: Uint32Array }   // structurally a subset of AJ's PrintableMesh
export function meshBounds(mesh: MeshData): { min: [number, number, number]; max: [number, number, number] };
export function meshVolume(mesh: MeshData): number;        // mm³, signed sum of tetrahedra; positive for outward winding
export type MeshProblem = 'empty' | 'index' | 'degenerate' | 'open-edge' | 'non-manifold-edge' | 'inward';
export function meshProblems(mesh: MeshData): MeshProblem[];
export const PRINT_FRAME: THREE.Matrix4;                     // (x, y, z) → (x, −z, y): rotation +90° about X
export function toPrintFrame(mesh: MeshData, matrix?: THREE.Matrix4): MeshData;
export function meshKey(mesh: MeshData): string;
```

- `meshProblems`: every index within range; no triangle with two equal indices or area below 1e-9 mm²; every undirected edge used by exactly two triangles, once in each direction (closed, two-manifold, consistently wound); `meshVolume > 0` (outward). Pieces must pass with `[]` before they are written (R11). Writers do not re-check; `buildPieces` does.
- `toPrintFrame`: applies `matrix` (default identity), then `PRINT_FRAME`, then translates so the bounding box is centred on X and Y and its minimum Z is 0. Returns a new mesh; the input is not changed. Indices are copied unchanged, so the winding (and outward orientation) is kept, because the matrices are rotations and translations only.
- `meshKey`: coordinates rounded to `MESH_KEY_MM` (0.001 mm) as integers; each triangle rotated so its smallest vertex (lexicographic) comes first, keeping the winding; triangles sorted; the result is `${triangleCount}:${fnv1a64(bytes)}` over the sorted integer list. Independent of vertex and triangle order, so two copies built at different positions get the same key (R12).

### 3.2 STL (R23, R24)

`writeStl(mesh, label)` returns a binary STL: an 80-byte header `Forgehand ${label} mm` (ASCII, padded with spaces; `label` is a piece number such as `P01`), a little-endian `uint32` triangle count, then per triangle the unit normal from `(v2 − v1) × (v3 − v1)`, the three vertices as `float32`, and a `uint16` 0. Size is `84 + 50 n` bytes. A zero-area normal is written as `(0, 0, 0)`, which slicers accept.

### 3.3 3MF (R25–R28)

```ts
// src/export/threemf.ts
export interface ThreeMfObject { number: string /* P01 */; name: string; color: string /* #rrggbb */; mesh: MeshData; copies: number }
export function layoutPlate(objects: readonly ThreeMfObject[]): Array<{ objectIndex: number; x: number; y: number }>;   // mm
export function threeMfModelXml(input: { title: string; objects: readonly ThreeMfObject[] }): string;
export function write3mf(input: { title: string; objects: readonly ThreeMfObject[] }, mtime: Date): Uint8Array;
```

Package (Core Specification only; entries in this order):

```
[Content_Types].xml   <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
                        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
                        <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>
_rels/.rels           <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                        <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>
3D/3dmodel.model      the model below
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-TW" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">{title}</metadata>
  <metadata name="Application">Forgehand</metadata>
  <resources>
    <basematerials id="1"><base name="#59D9E8" displaycolor="#59D9E8FF"/>…</basematerials>
    <object id="2" type="model" name="P01 外殼（含 3 個零件）（相機）" pid="1" pindex="0">
      <mesh><vertices><vertex x="…" y="…" z="…"/>…</vertices><triangles><triangle v1="0" v2="1" v3="2"/>…</triangles></mesh>
    </object>
  </resources>
  <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 {tx} {ty} 0"/>…</build>
</model>
```

- One `<base>` per distinct colour (upper-case hex, alpha `FF`), in first-use order; `pindex` refers to it. Object ids start at 2, in piece order.
- Coordinates are written with `fmtNumber` (at most 4 decimals, trailing zeros removed, `-0` written as `0`), so output is deterministic.
- **Layout (R27):** copies in piece order; each copy's footprint is its mesh's X–Y bounds (the mesh is centred, so the item translation is the footprint centre). A shelf packer places copies left to right from (0, 0) with `PLATE_GAP_MM` (5 mm) between footprints, and starts a new row (at the previous row's deepest footprint + gap) when the next copy would pass `PLATE_ROW_MM` (220 mm, a common bed width). A copy wider than a row gets a row of its own. Pieces rest on Z = 0 already (§3.1), so `tz = 0`.
- Text goes through `xmlEscape` (§3.6). `write3mf` zips the three entries with `zipFiles` (§3.4), all deflated.

### 3.4 Zip (R20, R48)

```ts
// src/export/zip.ts
export interface KitFile { path: string; bytes: Uint8Array; mime: string }
export function zipFiles(files: readonly KitFile[], mtime: Date): Uint8Array;   // fflate zipSync; order kept
export function kitZipName(exportedAt: Date): string;                            // forgehand-kit-yyyyMMdd-HHmm.zip, local time
```

`zipSync` from `fflate` with each entry's `mtime` set to `mtime`; PNG entries use `{ level: 0 }` (stored), all others the default deflate level. Paths must match `^[A-Za-z0-9._/-]+$`; `zipFiles` throws otherwise, so a non-ASCII name can never slip in (R13). `fflate` is imported as `import { zipSync, strToU8 } from 'fflate'` (version 0.8.3, exact).

### 3.5 GLB (R45–R47)

```ts
// src/export/glb.ts
export function buildGlbScene(objects: readonly SceneObject[]): THREE.Scene;   // Node-testable
export async function writeGlb(objects: readonly SceneObject[]): Promise<Uint8Array>;   // browser: GLTFExporter, binary
```

- `buildGlbScene`: per object, a `Group` named `model.name` with the object transform (metres, XYZ Euler degrees) and `userData = { objectId, material }`, holding `buildModel(model, solidPart)`. `solidPart(geometry, part)` returns one `Mesh` named `part.name` with an opaque `MeshStandardMaterial({ color: part.color, roughness: 0.55, metalness: 0 })`. After `buildModel`, each part transform node is renamed to `part.name` and its `userData` (`partId`, `partName`, `primitive`, `color`, `role` from `buildModel`) gains `objectId` and `material`. GLTFExporter writes `userData` as glTF `extras` (R46).
- `writeGlb`: `new GLTFExporter().parseAsync(scene, { binary: true })`, then `disposeObject(scene)` in a `finally`. GLTFExporter uses `FileReader` in binary mode, which Node does not have; the unit test checks `buildGlbScene`, and the bytes are checked in e2e (T4) by the `glTF` magic and the JSON chunk's node names.

### 3.6 Escaping and formats (R33, R34, R38, R68)

| Function | Rule |
|---|---|
| `xmlEscape(s)` | `& < > " '` as entities; characters not allowed in XML 1.0 (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+FFFE, U+FFFF, lone surrogates) removed |
| `htmlEscape(s)` | `& < > " '` as entities |
| `mdCell(s)` | line breaks → space; `\` `` ` `` `*` `_` `[` `]` `|` → backslash-escaped; `<` `>` `&` → entities |
| `csvField(s)` | a leading `=`, `+`, `-`, `@`, tab or CR gets a `'` prefix; then quoted with `"` doubled when it holds `,`, `"`, CR or LF |
| `csvRow(fields)` | fields joined with `,`, ended with CRLF |
| `formatMm(n)` | one decimal (`12.5`); `formatSize({x,y,z})` → `12.5 × 30.0 × 8.0` |
| `formatCm3(mm3)` | `mm3 / 1000`, one decimal |
| `formatDate(d)` | `yyyy-MM-dd HH:mm`, local time |
| `base64(bytes)` | chunked `btoa` over 32 kB slices (works in the browser and Node 22) |

## 4. Kit plan (T2, `shared/export-plan.ts`)

```ts
export const ExportScopeSchema = z.strictObject({ scope: z.enum(['workspace', 'assembly']), objectId: ObjectIdSchema.nullable() });
export type ExportScope = z.infer<typeof ExportScopeSchema>;
export function scopeWorkspace(ws: Workspace, scope: ExportScope): Workspace;          // R1
export type PartClass = 'printed' | 'bought' | 'machined';
export function classifyPart(object: SceneObject, part: Part): PartClass;              // R4
export const METHOD_KIND_LABELS: Record<JointMethod['kind'], string>;                  // 熱壓螺母＋螺絲, 磁鐵, 定位銷, 膠合
export function jointLabel(ws: Workspace, joint: Joint): string;                       // 「A・電池」↔「B・外殼」
export function stepNumbers(ws: Workspace, profile: PrinterProfile): Map<string, number>;
export interface BoughtRow { name: string; objectNames: string[]; sizeMm: Vector; count: number }
export interface MachinedRow { name: string; objectName: string; material: MaterialId; sizeMm: Vector; features: string[] }
export function boughtRows(ws: Workspace): BoughtRow[];                                // R30
export function machinedRows(ws: Workspace, features: FeatureSet): MachinedRow[];      // R31
export const ExportSummarySchema: z.ZodType<ExportSummary>;
export function exportSummary(ws: Workspace, scope: ExportScope, profile: PrinterProfile): ExportSummary;   // R56
```

- **`scopeWorkspace`:** `workspace` keeps every object; `assembly` keeps `assemblyOf(ws, objectId ?? activeObjectId)` in workspace order. The result keeps only joints whose two sides are kept (in assembly scope that is every joint of the members), clears the selection, sets explode 0, and keeps `activeObjectId` when kept, else the first kept object. It throws `WorkspaceError('NO_MODEL')` for an empty workspace and `UNKNOWN_OBJECT` for an unknown id. Every later function takes this scoped workspace, so nothing else needs to know the scope.
- **`classifyPart`:** `role === 'interior'` → `bought`; `MATERIALS[object.material]?.process === 'metal'` → `machined`; else `printed` (R4).
- **`jointLabel`:** AJ §6.4's naming: 「{object}・{part}」 on both sides when they belong to different objects, 「{part}」 otherwise; joined with `↔`.
- **`stepNumbers`:** step n is the n-th entry of `assemblyNotes(ws, profile)` (sorted by `createdAt`, then id), starting at 1 (R36, R42).
- **`boughtRows`:** interior parts grouped by name, primitive and dimensions rounded to 0.1 mm; size from `dimensions × 1000` in the model's axes; `objectNames` lists each object once; groups in first-appearance order.
- **`machinedRows`:** one row per metal exterior part; `features` from `features.parts.get('{objectId}:{partId}')` with `made === 'machined'`, grouped and labelled: `tapped-hole` → 「{thread} 攻牙孔 ×n」 (thread from the joint's `screw-insert` size), `drilled-hole` → 「Ø{d} mm 通孔 ×n」, `magnet-pocket` → 「Ø{d}×{depth} mm 磁鐵槽 ×n」, `pin-hole` → 「Ø{d} mm 銷孔 ×n」, with `d` and `depth` from `nominal`.
- **`METHOD_KIND_LABELS`** match AJ's card labels (AJ §8.4). AJ T4 keeps its own browser table; if both exist when AJ T4 is built, it may import this one instead (§13).

**Summary for the agent (R56, R57):**

```ts
interface ExportSummary {
  scope: ExportScope;
  objects: Array<{ objectId: string; name: string; material: MaterialId | null; printed: number; bought: number; machined: number }>;
  standardParts: Array<{ label: string; quantity: number }>;          // jointBom, unchanged order
  unconfirmed: Array<{ jointId: string; label: string; method: string }>;
  problems: Array<{ severity: 'error' | 'warning'; code: string; message: string }>;   // checkJoints, max 40
  note: string;   // 列印零件 {n} 個（相連的零件會合併成一個列印件，實際數量以匯出視窗為準）
}
```

`exportSummary` calls `scopeWorkspace`, `classifyPart`, `jointBom`, `checkJoints` and `jointLabel` only: no CSG, no DOM, so the server can run it.

## 5. Documents (T2)

### 5.1 Findings (R16–R19)

```ts
// src/export/findings.ts
export type ExportFindingCode = 'PIECE_FAILED' | 'FEATURES_SKIPPED' | 'JOINT_UNCONFIRMED' | 'JOINT_FUSED' | 'JOINT_OVERLAP'
  | 'COMPONENT_BLOCKED' | 'LOOSE_PIECE' | 'TOO_LARGE' | 'BOUGHT' | 'MACHINED' | 'FUSED';
export interface ExportFinding {
  severity: 'error' | 'warning' | 'info';
  code: ExportFindingCode | FindingCode;   // AJ codes come through unchanged
  source: 'joint' | 'export';
  message: string;
  jointId: string | null; step: number | null; piece: string | null;   // for sorting and the sheet
}
export const EXPORT_MESSAGES: Record<ExportFindingCode, (p: Record<string, string | number>) => string>;   // R16 table
export function jointFindings(ws: Workspace, findings: Map<string, Finding[]>, steps: Map<string, number>): ExportFinding[];
export function unconfirmedFindings(ws: Workspace, steps: Map<string, number>): ExportFinding[];   // JOINT_UNCONFIRMED
export function classFindings(ws: Workspace): ExportFinding[];                                     // BOUGHT, MACHINED
export function featuresSkippedJoints(findings: Map<string, Finding[]>): Set<string>;              // joints with any error
export function sortFindings(list: readonly ExportFinding[]): ExportFinding[];
```

- `jointFindings` turns `checkJoints` output into `ExportFinding`s with `source: 'joint'` and the joint's step. Messages are AJ's, prefixed with 「步驟 {n}：」 so the reader knows which joint is meant.
- `FEATURES_SKIPPED` is emitted by `buildPieces` (T3) for every joint in `featuresSkippedJoints`, plus joints whose features failed in CSG; `JOINT_UNCONFIRMED` here for every joint with `confirmed: false`.
- **Sort (R18):** severity (error, warning, info), then code (string order), then step, then piece number; `null` last.
- The dialog shows them all; info lines are collapsed (R16). `bom.md` and the sheet list errors and warnings, and the count of info lines.

### 5.2 BOM (R29–R34)

```ts
// src/export/bom.ts
export interface PieceInfo { number: string; name: string; objectId: string; objectName: string; material: MaterialId | null;
  count: number; sizeMm: Vector; volumeMm3: number; file: string; partNames: string[] }
export interface StandardRow extends BomItem { steps: number[]; problem: boolean }
export interface Bom { pieces: PieceInfo[]; bought: BoughtRow[]; machined: MachinedRow[]; standard: StandardRow[]; totalVolumeMm3: number }
export function buildBom(ws: Workspace, profile: PrinterProfile, pieces: readonly PieceInfo[], features: FeatureSet,
  skipped: ReadonlySet<string>, steps: Map<string, number>): Bom;
export function bomCsv(bom: Bom): string;
export function bomMarkdown(bom: Bom, findings: readonly ExportFinding[], meta: { title: string; date: string }): string;
```

- `standard` is `jointBom(ws, profile, features)` unchanged, with `steps` from its `jointIds` and `problem` when any of them is in `skipped` (R32).
- Material text: `MATERIALS[m].label`, or 未指定（以 PLA 估） (R29).
- `totalVolumeMm3 = Σ volumeMm3 × count`.

`bom.csv` (R33): the byte-order mark `\uFEFF`, then one header row and one row per entry, CRLF, through `csvRow`:

| 類別 | 編號 | 名稱 | 物件 | 材料 | 尺寸 (mm) | 數量 | 單件體積 (cm³) | 檔案 | 包含零件 | 用於步驟 | 備註 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 列印件 | P01 | 外殼（含 3 個零件） | 相機 | PLA | 160.0 × 70.0 × 90.0 | 1 | 412.3 | stl/P01-housing.stl | 外殼、鏡筒 1、鏡筒 2 | | |
| 外購件 | | 內部電路概念件 | 相機 | | 120.0 × 4.0 × 45.0 | 1 | | | | | 概念尺寸，購買前請確認型號與尺寸。 |
| 加工件 | | 底板 | 支架 | 鋁 | … | 1 | | | | | M3 攻牙孔 ×2 |
| 標準件 | | M3×8 內六角螺絲（ISO 4762） | | | | 2 | | | | 1 | (接合有問題，請先修正。 when `problem`) |

`bom.md` (R34): `# 材料清單（BOM）`, `{title}` and the date, the 概念設計 note, then `## 列印件`, `## 外購件`, `## 加工件`, `## 標準件` tables with the same columns minus 類別 (empty categories left out), the line 列印總體積：{n} cm³, and `## 問題` with the errors and warnings (or 沒有錯誤或警告。) and 另有 {n} 則提示。 Every cell goes through `mdCell`.

### 5.3 Assembly sheet (R35–R39)

```ts
// src/export/sheet.ts
export function assemblySheetHtml(input: { title: string; date: string; image: Uint8Array | null; bom: Bom;
  steps: Array<{ number: number; text: string; problem: boolean }>; findings: readonly ExportFinding[] }): string;
```

Structure: `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8">`, the CSP `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`, `<title>`, one `<style>` block; then `<h1>` title and date, the image (`<img src="data:image/png;base64,…" alt="爆炸圖">`, left out when `image` is null), `<h2>準備</h2>` with the printed pieces and the parts to buy (bought components and standard parts with counts), `<h2>組裝步驟</h2>` as an `<ol>` (or the sentence 這個套件沒有接合步驟。), `<h2>問題</h2>`, and the two notes of R36. A step with `problem` gets the R37 line. Print CSS: A4 portrait, 15 mm margins, `break-inside: avoid` on `li` and `tr`, the image at most 100 % width. No `<script>`, no external URL. Every text value goes through `htmlEscape`.

## 6. Print pieces (T3)

### 6.1 Additions to `src/print/printable.ts` (AJ file)

```ts
export function primitiveSolid(wasm: ManifoldToplevel, part: Part): Manifold;   // AJ §7.3 table, part-local mm
export function featureSolids(wasm: ManifoldToplevel, features: readonly JointFeature[], options?: { skip?: ReadonlySet<string> }):
  { bosses: Manifold[]; holes: Manifold[]; skipped: Array<{ featureId: string; reason: 'problem' | 'invalid' }> };   // AJ §7.4, part-local mm
```

`printablePart` is refactored to `primitiveSolid` + `featureSolids` + union + subtract, with no change in behaviour; AJ's `printable.test.ts` must pass unchanged. The caller owns and deletes every returned `Manifold`. If AJ T3 already exports equivalents under other names, T3 uses them and adds nothing.

### 6.2 `buildPieces` (R6–R13, R17)

```ts
// src/export/pieces.ts
export interface PieceBuild { info: PieceInfo; mesh: MeshData /* print frame */; color: string; key: string;
  objectId: string; mainPartId: string; partIds: string[] }
export interface PiecesResult { pieces: PieceBuild[] /* unique, numbered */; findings: ExportFinding[] }
export async function buildPieces(ws: Workspace /* scoped */, profile: PrinterProfile, input: {
  wasm: ManifoldToplevel; features: FeatureSet; skipped: ReadonlySet<string>;
  fuse?: boolean /* default FUSE_PARTS; tests pass false */; signal?: AbortSignal; onProgress?(done: number, total: number): void; yieldNow?(): Promise<void>;
}): Promise<PiecesResult>;
```

Per object, in workspace order:

1. **Solids.** For each printed part: `primitiveSolid(part)` transformed by `W_part` (from `worldMatrices(model)`, translation × 1000) into the object's model frame in mm. Parts are processed in model order.
2. **Links (R6).** Candidate pairs are parts whose model-frame boxes (`partBoxes`) overlap after expanding by `CONTACT_GAP_MM`. For each candidate: `overlap = intersect(a, b).volume()`. A pair that is the two sides of a joint is never linked; its `overlap ≥ FUSE_MIN_MM3` gives `JOINT_OVERLAP` with `{n}` = the volume rounded to 1 mm³. Otherwise the pair is linked when `overlap ≥ FUSE_MIN_MM3`, or when any pair of their contact faces (`CONTACT_FACES`) passes AJ's `touching(worldFace(object, a, fa), worldFace(object, b, fb))`. With `fuse` false (`FUSE_PARTS = false` in `constants.ts`), nothing is linked: one piece per printed part, the documented fallback (R6).
3. **Pieces.** Union-find over the links; each component is a piece. Its main part is the part with the largest `primitiveSolid` volume, ties by model order (R10). Pieces are ordered by their main part's model order.
4. **Joints inside a piece (R7).** A joint whose two sides are in one piece gets `JOINT_FUSED` and is added to the piece's local skip set.
5. **Bought components (R17).** Each bought part of the object is placed the same way and intersected with each piece's union; `≥ FUSE_MIN_MM3` gives `COMPONENT_BLOCKED`.
6. **Geometry (R8, R9).** All matrices here are in millimetres (`W_part` with its translation × 1000). `solid = union(part solids)`; then `featureSolids` of every part's features (`features.parts.get('{objectId}:{partId}')`), skipping features of joints in `skipped` or the local skip set, each transformed by its part's `W_part`; `solid = union(solid, …bosses).subtract(union(…holes))`. Then `solid.transform(W_main⁻¹)` and `getMesh()` → `MeshData`, then `toPrintFrame(mesh)`, which applies `PRINT_FRAME`, centres the piece and rests it on Z = 0 (changed in Task 3: applying `PRINT_FRAME` in both places would rotate twice).
7. **Validity (R11).** `meshProblems(mesh)` must be `[]` and Manifold status `NoError`. On failure, the piece is built again without features: success gives `FEATURES_SKIPPED` for its joints; a second failure gives `PIECE_FAILED` and the piece is left out. Joint skips from step 6 also give `FEATURES_SKIPPED` (once per joint).
8. **Findings per piece.** `FUSED` (info) for pieces with more than one part; `TOO_LARGE` when the largest bounds extent exceeds `LARGE_PIECE_MM` (250 mm); `LOOSE_PIECE` when the object has more than one piece and none of this piece's parts is linked to another part or named by any joint (R17).

Across objects:

9. **Identical pieces (R12).** `key = '{material}|{color}|' + meshKey(mesh)`. Pieces with the same key are one unique piece: the first copy (in the order above) keeps its mesh, `count` is the number of copies, and `partNames` comes from the first copy.
10. **Numbering (R13).** Unique pieces are numbered `P01`… in that order; `file = 'stl/{number}-{mainPartId}.stl'`; `name` is 「{main part name}」 or 「{main part name}」（含 {n} 個零件）; `sizeMm` from `meshBounds`; `volumeMm3` from `meshVolume`.

**Progress and stopping (R14, R65, R69).** `total` is the number of printed parts in scope. After each piece, `done` grows by its part count, `onProgress(done, total)` is called, and `await yieldNow()` lets the page paint (the browser passes `() => new Promise(r => setTimeout(r, 0))`; Node passes nothing). `signal` is checked after every Manifold operation batch; an abort throws `AbortError`. Every `Manifold` and `CrossSection` created is pushed to an `owned` list and deleted in one `finally`, on success, abort and failure.

**Budget (R65).** The two-object demo with one screw joint: under 3 s on the user's laptop (the e2e setup; T4 reports the measured time). Eight objects of 64 parts: under 30 s with progress shown; T3 measures a synthetic case in Node and reports the number (not a failing test).

### 6.3 `prepareKit` (R2, R20–R22)

```ts
// src/export/prepare.ts
export interface KitInput { workspace: Workspace; scope: ExportScope; profile: PrinterProfile; exportedAt: Date;
  loadManifold(): Promise<ManifoldToplevel>;
  renderImage?(ws: Workspace, steps: Map<string, number>): Promise<Uint8Array | null>;   // T4 passes the WebGL render
  writeGlb?(objects: readonly SceneObject[]): Promise<Uint8Array>;                       // T4 passes glb.ts
  signal?: AbortSignal; onProgress?(done: number, total: number): void; yieldNow?(): Promise<void> }
export interface KitSummary { pieces: number; copies: number; bought: number; machined: number; standard: number; totalVolumeMm3: number }
export interface PreparedKit { summary: KitSummary; findings: ExportFinding[]; files: KitFile[]; zipName: string; imageMissing: boolean }
export async function prepareKit(input: KitInput): Promise<PreparedKit>;
export function kitZip(kit: PreparedKit, exportedAt: Date): Uint8Array;
```

Order: `scopeWorkspace` → `jointFeatures` → `checkJoints` → `stepNumbers` → `featuresSkippedJoints` → `buildPieces` → `buildBom` → findings (`jointFindings`, `unconfirmedFindings`, `classFindings`, piece findings, sorted) → `renderImage` (a thrown error or `null` gives `imageMissing: true`, R40) → `writeGlb` → files:

```
assembly.html  text/html;charset=utf-8         exploded.png  image/png (when present)
bom.csv        text/csv;charset=utf-8          bom.md        text/markdown;charset=utf-8
kit.3mf        model/3mf (when there are pieces)
workspace.glb  model/gltf-binary
stl/P01-….stl  model/stl, one per unique piece
```

Text files are UTF-8 (`strToU8`). The 3MF title and the sheet title are the scoped object names joined with 、. `kitZip` calls `zipFiles(kit.files, exportedAt)`, so the zip holds exactly the listed bytes (R21).

## 7. Browser (T4)

### 7.1 App wiring

```ts
const [exportRequest, setExportRequest] = useState<ExportScope | null>(null);
const ExportDialog = lazy(() => import('./export/ExportDialog'));   // module scope
```

- A 匯出套件 button at the end of the stage toolbar's second button group (after 重設視角), `disabled={workspace.objects.length === 0}`, not gated by `agentActive` (R52). Click → `setExportRequest(defaultScope(workspace))`.
- When `exportRequest` is set: `<Suspense fallback={<p className="notice" role="status">正在載入匯出功能…</p>}><ExportDialog …/></Suspense>` with `workspace`, `printer` (AJ T4's `printer` state when it exists, else `DEFAULT_PRINTER_PROFILE`), `request`, `viewDirection={() => sceneRef.current?.viewDirection() ?? null}` and `onClose={() => setExportRequest(null)}`.
- An empty workspace closes the dialog.
- `SceneHandle.viewDirection(): Vector | null`: `camera.position − controls.target`, normalised; `null` before the view exists. Additive; no other change to `SceneViewport`.

### 7.2 Dialog model (`src/export/dialog-model.ts`, pure)

```ts
export function defaultScope(ws: Workspace): ExportScope;                 // { scope: 'workspace', objectId: null }
export function scopeChoiceVisible(ws: Workspace): boolean;               // R1: hidden when the active assembly is the whole workspace
export interface SnapshotKey { objects: readonly SceneObject[]; joints: readonly Joint[]; profile: PrinterProfile; scope: ExportScope }
export function snapshotKey(ws: Workspace, scope: ExportScope, profile: PrinterProfile): SnapshotKey;   // scoped objects and joints
export function sameSnapshot(a: SnapshotKey, b: SnapshotKey): boolean;   // element-wise reference equality + scope + profile values
export function fileRows(kit: PreparedKit): Array<{ path: string; bytes: number; label: string }>;   // label 下載 {path}
export function problemBanner(findings: readonly ExportFinding[]): string | null;   // 有 {n} 個問題，仍可繼續匯出。
export function summaryLines(kit: PreparedKit): string[];
```

The workspace store returns new references only for changed objects (workspace-v2 R61), so reference equality on the scoped objects and the joints array detects every change that matters and ignores selection, explode and activation (unless the scope is `assembly`, where `snapshotKey` resolves the active assembly).

### 7.3 `ExportDialog.tsx`

A non-modal `<section role="dialog" aria-label="匯出套件" data-testid="export-dialog">` over the control column, so the scene stays visible and usable (R2 covers changes). Content:

- heading 匯出套件; the 匯出範圍 select (整個工作區 / 目前物件的組合件) when `scopeChoiceVisible`;
- **preparing:** 正在準備列印檔…（{done}/{total}）, a `<progress>`, 停止準備;
- **ready:** the summary lines (列印件 {n} 種（共 {copies} 件）、外購件 {m} 個、加工件 {k} 個、標準件 {s} 項、列印總體積 {v} cm³, or 沒有需要列印的零件。, R22); the findings (errors and warnings with ⛔ / ⚠ and their severity word, info lines in `<details><summary>顯示 {n} 則提示</summary>` with ℹ); the banner; 下載完整套件; the file list with 下載 {path} buttons and sizes (`{n} KB`); 無法產生爆炸圖，其餘檔案不受影響。 when `imageMissing`;
- **failed:** 無法準備匯出內容，請重新整理頁面後再試。 (R54);
- 關閉匯出 always. Esc inside the dialog closes it.

Behaviour: on mount, and whenever `sameSnapshot` turns false, it aborts any running preparation, sets the 工作區已變更，正在重新準備匯出內容… notice (not on the first run), takes `exportedAt = new Date()` and `viewDirection()`, and runs `prepareKit` with `loadManifold` (AJ's `src/print/manifold.ts`), `renderImage` (§7.4) and `writeGlb` (§3.5, dynamically imported). 停止準備, 關閉匯出, Esc and unmount abort and close. A thrown error other than `AbortError` sets `failed`; nothing about it is logged or shown (R54). Downloads: 下載完整套件 → `downloadBytes(kit.zipName, kitZip(kit, exportedAt), 'application/zip')`; a file row → `downloadBytes(basename(path), bytes, mime)`.

Test attributes on the section (R53): `data-export-state` (`preparing` | `ready` | `failed`), `data-export-files` (`JSON.stringify(fileRows.map(({ path, bytes }) => ({ path, bytes })))`), `data-export-findings` (the codes in order), and `data-export-image` (`ok` | `missing`).

### 7.4 Exploded image (`src/export/kit-image.ts`, R40–R44)

```ts
export interface ImageLayout {
  objects: Array<{ objectId: string; root: THREE.Matrix4; parts: Map<string, THREE.Vector3> /* local positions, exploded */ }>;
  badges: Array<{ step: number; point: THREE.Vector3 /* world */ }>;
  bounds: THREE.Box3;
}
export function explodedLayout(ws: Workspace /* scoped */, steps: Map<string, number>): ImageLayout;   // pure, Node
export async function renderKitImage(ws: Workspace, layout: ImageLayout, viewDirection: Vector | null): Promise<Uint8Array | null>;
```

`explodedLayout`:

1. **Explosion.** Per object, `computeExplosion(model)` and `explodedOffsets(model, plan, 1)` give each part's total model-frame offset; a part's local position is `part.position + R_parent⁻¹ · (offset(part) − offset(parent))`, with `R_parent` the parent's model-frame rotation (as `SceneViewport.ensureExplosion` does). The exploded world box of each object is computed from these positions and `partBoxes`.
2. **Separating assemblies (R41).** Assemblies are the connected groups of objects over joints between different objects. In each, the anchor is the object with the largest exploded box volume (ties: workspace order). A breadth-first walk from the anchor visits joints in step order; for a joint from a placed object P to a new object Q, the direction `n` is P's world contact-face normal (AJ `worldFace`, pointing out of P). Q and every object later reached through Q are moved along `n` by `max(0, max_P(n) − min_Q(n)) + SEPARATION_FACTOR × min(size_P, size_Q)` (projections of the exploded boxes on `n`; size = the box diagonal; `SEPARATION_FACTOR` 0.3). Objects outside assemblies stay where they are.
3. **Badges (R42).** For every joint with a step number, the badge point is the midpoint of the two face centres (`localFace(part, face).centre`) under each part's final world matrix.

`renderKitImage` (browser only): a new `THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })` on a detached canvas, `setPixelRatio(1)`, `setSize(IMAGE_WIDTH, IMAGE_HEIGHT, false)` (1600 × 1200), `scene.background = #ffffff`; per object `buildModel(model, printPart)` with the layout's root matrix and part positions; `printPart` = opaque `MeshStandardMaterial(part.color, roughness 0.6)` plus `EdgesGeometry(geometry, 24)` lines in `#1f2933`; a hemisphere light and two directional lights; a `PerspectiveCamera(30°, 4:3)` looking along `−viewDirection` (default `(3, 2, 4)` normalised) at the layout bounds' centre, at the distance that fits the bounding sphere with a 15 % margin. After one `render`, a 2D canvas of the same size draws the WebGL canvas, then each badge (projected with the camera) as a filled `#111827` circle of radius 18 px with a white bold 20 px number. `canvas.toBlob('image/png')` gives the bytes. Everything (`disposeObject(scene)`, `renderer.dispose()`, `renderer.forceContextLoss()`) is released in a `finally`. A failed context or render returns `null`. The live renderer, camera and scene are never touched; the camera video is an HTML element and is not part of either canvas (R44).

### 7.5 Downloads (R50)

`downloadBytes(name, bytes, mime)`: `URL.createObjectURL(new Blob([bytes], { type: mime }))`, a temporary `<a download>` clicked once and removed, and `URL.revokeObjectURL` in a `setTimeout(…, 0)` after the click.

### 7.6 Styles and names

`styles.css` adds `.export-dialog` (positioned over the control column, scrollable, the existing panel look) and `.export-findings` (icons, severities). Accessible names (R51): 匯出套件, 匯出範圍, 停止準備, 下載完整套件, 下載 {path}, 關閉匯出, 顯示 {n} 則提示. None contains 取消, 刪除, 復原, 重做, 載入示範模型 or 生成 3D 草案.

## 8. Agent (T5)

- **Contract (`shared/agent.ts`).** `StateChangeSchema` gains `exportDialog: ExportScopeSchema.nullable().optional()`; absent or `null` means no change, so existing payloads parse (R57). The server's `checkedChange` (`server/tools/helpers.ts`) and the browser's `applyStateEvent` drop `exportDialog` (and `tryOn`) before `applyWorkspaceChange`.
- **Tool (`server/tools/prepare-export.ts`).** `defineTool({ name: 'prepare_export', label: '準備匯出', category: 'export', side: 'server', scope: 'project', effects: 'read-only', args: z.strictObject({ scope: z.enum(['workspace', 'assembly']).nullable(), objectId: ObjectIdSchema.nullable() }) })`. `run`: empty workspace → `noModel`; an unknown `objectId` → `UNKNOWN_OBJECT` (as `resolveTarget`); otherwise `exportSummary(state.workspace, { scope: scope ?? 'workspace', objectId }, state.printer ?? DEFAULT_PRINTER_PROFILE)`. `state.printer` exists after AJ T5; before it, the default is used (R59). Result: `ok('prepare_export', summaryText, summary, { activeObjectId: null, object: null, joint: null, selection: null, explode: null, tryOn: null, exportDialog: { scope, objectId } })`. Summary text: 已開啟匯出視窗：{note}，外購件 {m} 個，標準件 {s} 項{，有 {p} 個問題}。請使用者按「下載完整套件」。 Registered in `server/tools/index.ts` last.
- **Description** (model-facing, English): "opens the export dialog in the browser and returns a summary of the printable kit (printed, bought and machined parts per object, standard parts, unconfirmed joints, problems). It cannot download or save files; the user downloads from the dialog. scope 'assembly' exports the assembly of objectId (or of the active object)."
- **`AGENT_INSTRUCTIONS`** gains: "You cannot save or download files. To export, call prepare_export, then tell the user to press 下載完整套件 in the export dialog. Before they download, mention the problems prepare_export returns and offer to fix them. The kit contains STL files per print piece, a 3MF for slicers, a BOM (CSV and Markdown), an assembly sheet and a GLB. STEP files, drawings, print-service orders and slicing are not supported."
- **Client.** `StateEffects.exportDialog?: ExportScope`; `useAgentRun` options gain `openExport?(scope: ExportScope): void`, called when the effect is present; App passes `scope => setExportRequest(scope)`. Not an undo step; `recordUndo` is unchanged (R57).
- **No other server change.** No new route; the server never builds files (R62).

## 9. Testing strategy

- **T1 (`export-writers.test.ts`):** `meshProblems` on a closed cube (`[]`), an open box, a flipped cube (`inward`), a bad index; `meshVolume` of a 10 mm cube; `toPrintFrame` maps a +Y-tall box to +Z-tall, the front face `+z` to `−y`, rests on Z = 0, centres X/Y, keeps the winding (`meshProblems` still `[]`); `meshKey` equal for a translated and re-ordered copy, different for a mirrored one; STL header, size `84 + 50 n`, a normal; 3MF unzipped with `fflate.unzipSync`: entry names and order, `unit="millimeter"`, the content-type and relationship strings, one `<base>` per colour, object names escaped (a name with `<&"'` and a control character), indices within range, copies → several items for one object, the plate layout (no overlapping footprints, gap ≥ 5 mm, row wrap at 220 mm); `zipFiles` order, stored PNG, deflated text, fixed `mtime` gives identical bytes twice, a non-ASCII path throws; `kitZipName`; `buildGlbScene` names, transforms, `userData`; every escaping function with a hostile string (`=cmd|' /C calc'!A0`, `| <b>x</b> \n`, `<script>`).
- **T2 (`export-plan.test.ts`, `export-docs.test.ts`):** `scopeWorkspace` for both scopes, unknown id, empty; `classifyPart` for interior, metal, `null` and PLA objects; `jointLabel` across objects and inside one; `stepNumbers` order; `boughtRows` grouping; `machinedRows` labels; `exportSummary` on the demo pair with a joint; every R16 message; `sortFindings`; `buildBom` from hand-built `PieceInfo`s (standard rows, steps, `problem`); `bomCsv` (BOM character, CRLF, header, quoting, formula guard); `bomMarkdown` (empty categories left out, escaping, totals); `assemblySheetHtml` (CSP, no `<script>` even with a hostile name, steps in order, the R37 lines, image present or absent).
- **T3 (`export-pieces.test.ts`, real WASM in Node):** a box with two tubes pushed in → one piece, `FUSED`; two stacked boxes touching → one piece; the same with a joint between them → two pieces; three boxes A–B–C overlapping with a joint A–C → one piece, `JOINT_FUSED`; jointed parts overlapping → `JOINT_OVERLAP`; a bought part inside a solid box → `COMPONENT_BLOCKED`; a floating part → `LOOSE_PIECE`; a 300 mm part → `TOO_LARGE`; a metal object → no piece, `MACHINED`; two identical glass discs → one piece with count 2; different materials → not merged; `FUSE_PARTS = false` (passed as an option in the test) → one piece per part; an insert hole on a part overlapped by another part of the same piece is still open (a ray along the hole axis finds no material over its depth); a one-part piece equals `printablePart` in volume within 0.1 %; every piece passes `meshProblems`; the print frame of a rotated main part; numbering and file names; abort mid-run deletes everything (count live Manifold objects through a wrapper); `prepareKit` with fake `renderImage` and `writeGlb`: the file list, MIME types, `kitZip` equals `zipFiles(files)`, and the same input twice gives identical bytes (R64); a kit with only bought parts (R22).
- **T4 (`export-dialog.test.ts`, `tests/e2e/export.spec.ts`):** pure dialog model (`scopeChoiceVisible`, `sameSnapshot` ignores selection and explode but not a model change or a profile change, `fileRows`, `problemBanner`); `explodedLayout` in Node (exploded parts moved, an assembly separated along the joint normal with no overlap along `n`, badge points between the faces). E2E: 載入示範模型 twice; a routed `/api/agent` stream with a `state` frame whose `joint` change adds a screw joint between the two demo objects (AJ T1 already applies `joint` changes); 匯出套件 → `data-export-state="ready"`; `data-export-files` lists the R20 paths; `data-export-findings` contains `JOINT_UNCONFIRMED`; 下載完整套件 → a `download` event named `forgehand-kit-*.zip`, unzipped in the test: the file list, the `PK` header of `kit.3mf`, the `glTF` magic and node names in `workspace.glb`, the PNG signature and 1600 × 1200 size, `bom.csv` starts with the BOM character; 下載 kit.3mf gives the same bytes as the zip entry; changing a part's name while the dialog is open sets `preparing` and then `ready` with the new name in `bom.md`; 關閉匯出 closes it; a hostile part name (set with the 名稱 field) appears escaped in `assembly.html`. The test records the preparation time.
- **T5 (`export-agent.test.ts`, the e2e agent case):** `prepare_export` success (summary fields, `exportDialog` in the state change, no workspace change), `NO_MODEL`, `UNKNOWN_OBJECT`, `assembly` scope; `StateChangeSchema` parses old payloads and `exportDialog`; `applyStateEvent` returns `exportDialog` and `recordUndo: false`; `tool-registry.test.ts` lists `prepare_export` with its label and effect (an extension); `AGENT_INSTRUCTIONS` names the tool. E2E: a routed stream with a `prepare_export` `state` frame opens the dialog with the given scope; 復原 stays disabled.

## 10. Task plan and requirement map

Five tasks (R74). Task 1 needs nothing from unfinished AJ tasks and can start now. Tasks 2–3 wait for AJ Tasks 2–3; Task 4 for Task 3; Task 5 for Task 4 (and preferably AJ Task 5).

| Task | Content | Requirements |
|---|---|---|
| 1 | Writers: `fflate`, mesh helpers and the print frame, STL, 3MF and plate layout, zip, GLB scene and writer, escaping and formats | 10 (frame helper), 11 (mesh check), 12 (mesh key), 13 (ASCII paths), 20 (zip), 23–28, 45–48, 64 (writers), 68 (escaping), 70 (dependency) |
| 2 | Kit plan and documents: `shared/export-plan.ts`, findings table and sort, BOM rows, `bom.csv`, `bom.md`, `assembly.html` | 1 (scope function), 4, 5, 9 (unconfirmed), 13 (names), 16, 18 (sort), 19, 22 (text), 29–39, 56 (summary function), 63 |
| 3 | Pieces: `primitiveSolid` and `featureSolids` in `src/print/printable.ts`, `buildPieces`, export findings, `prepareKit`, `kitZip` | 6–12, 14 (progress), 17, 20–22 (file set), 64, 65, 69 |
| 4 | Browser: 匯出套件 button, dialog model and dialog, exploded image, GLB in the browser, downloads, `viewDirection`, e2e | 1–3, 14, 15, 18 (banner), 20–22 (UI), 40–44, 47, 49–55, 60, 61, 65 (measured), 66 (e2e) |
| 5 | Agent: `prepare_export`, `StateChange.exportDialog`, client effect, instructions; README; manual check list | 56–59, 61, 62, 66 (manual), 67, 68 (README), 70 (credit), 73 |

Requirements 71 and 72 apply to every task; 74 is satisfied by `tasks.md` itself.

## 11. Key decisions

All ten review decisions are in `requirements.md` ("Decisions from review"). Design-level choices:

- **Writers before rules.** Task 1 owns everything that turns plain data into bytes, so the schedule does not wait for AJ Tasks 2–3 to start, and the formats are tested before any geometry exists.
- **Fuse in the object frame, then move once.** One union and one subtraction per piece, holes after the union, and a single final transform; canonical mesh keys make copies match even when they were built at different positions.
- **Prepare everything, download bytes.** The file list with sizes is honest, single files equal zip entries, and stale kits are impossible because a snapshot change restarts preparation.
- **A second, short-lived renderer for the image.** It keeps the live view untouched, gives a white print-style picture without the hologram look, and is released right after one frame.
- **Session state for the agent's dialog request.** `exportDialog` travels like `tryOn`, so no new event type, no undo step, and the browser stays in charge of files.
- **Labels for methods live in `shared/export-plan.ts`,** because the server summary needs them; AJ T4 may reuse them.

## 12. Risks

- **AJ Tasks 2–3 are not done** (only AJ T1 has landed, `184182d`; AJ T2 is in progress on 2026-11-20). Tasks 2–5 wait for them. The manifold-3d spike in AJ T3 is the largest unknown; if it fails and the user picks `three-bvh-csg`, Task 3's link test (intersection volume) and its validity check need rework.
- **`src/print/printable.ts` belongs to AJ.** Task 3 adds two exports there; if AJ T3 is still running, Task 3 waits.
- **CSG time and robustness for large workspaces.** Up to 64 parts per object means many intersection tests; the box prefilter keeps it near linear for typical models. A piece whose union fails is retried without features, then reported.
- **Shared files with parallel sessions.** `src/App.tsx` and `src/scene/SceneViewport.tsx` (hand-manipulation, AJ T4 and T6), `shared/agent.ts`, `server/agent.ts`, `src/agent/*` (AJ T5), `package.json` (AJ T3), `README.md`. `tasks.md` lists the owners and the stop rule.
- **Off-screen WebGL under SwiftShader.** A second context and a 1600 × 1200 render may be slow in e2e; the image test only checks the PNG signature and size, and `imageMissing` keeps the kit usable if a context cannot be created.
- **GLB in Node.** `GLTFExporter` needs `FileReader`; the bytes are tested in e2e only.
- **Slicer acceptance** can only be confirmed by hand: Task 5's manual list opens `kit.3mf` in a real slicer and prints one joint test piece.
- **Fusion surprises.** Generated models may touch in ways the user did not expect, giving one huge piece. The `FUSED` info line names the fused parts, a joint separates them, and `FUSE_PARTS = false` is the fallback.

## 13. Changes to other specs' code

| File (spec, task) | Change | Task |
|---|---|---|
| `package.json`, `package-lock.json` | `fflate` 0.8.3, exact | 1 |
| `src/print/printable.ts` (AJ T3) | export `primitiveSolid` and `featureSolids`; `printablePart` uses them, unchanged behaviour | 3 |
| `src/scene/SceneViewport.tsx` (workspace-v2, hand-manipulation, AJ T4/T6) | `SceneHandle.viewDirection()` | 4 |
| `src/App.tsx` (all specs) | 匯出套件 button, `exportRequest`, lazy dialog; `openExport` for the agent | 4, 5 |
| `src/styles.css` | `.export-dialog`, `.export-findings` | 4 |
| `shared/agent.ts` (agent-harness, AJ T5) | `StateChangeSchema.exportDialog` | 5 |
| `server/tools/helpers.ts`, `server/tools/index.ts`, `server/agent.ts` (agent-harness, AJ T5) | strip `exportDialog` in `checkedChange`; register the tool; instruction lines | 5 |
| `src/agent/apply-state.ts`, `src/agent/useAgentRun.ts` (agent-harness, AJ T5) | `exportDialog` effect, `openExport` option | 5 |
| `tests/unit/tool-registry.test.ts` | lists `prepare_export` (an extension) | 5 |
| `README.md` | export section, privacy line, `fflate` credit | 5 |
