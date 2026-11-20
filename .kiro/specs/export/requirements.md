# Export: a printable kit — Requirements

> Status: approved in review, 2026-11-20. The review decisions are listed at the end; `design.md` and `tasks.md` build on this version.

## Overview

Since `assembly-joints` (C9) the workspace records how objects and parts are fixed together, which material each object is made of, and which features (insert holes, counterbores, magnet pockets, pin holes, bosses) each joint needs. Nothing can leave the workbench yet. A design that cannot be printed, bought and assembled has no practical value, so this spec gives the user a **printable kit**. It is capability C11 in `docs/VISION.md` (§2, §3.3, "Real, buildable output"), decided with the user on 2026-11-19.

One 匯出套件 action produces:

- **Print files:** one binary STL per **print piece**, in millimetres, with joint features and tolerances applied through `printablePart` (manifold-3d); and one 3MF with every piece (names, units, colours) for slicers.
- **A bill of materials (BOM):** printed pieces, bought components, machined metal parts, and the standard parts from `jointBom` (screws, inserts, magnets, pins, glue), as CSV and as Markdown.
- **An assembly sheet:** an exploded-view PNG rendered from the scene, plus numbered steps from `assemblyNotes`, as one self-contained HTML file.
- **A GLB** of the exported objects, for viewing in other tools.

Everything runs in the browser. Nothing is uploaded, and no file passes through the server.

A **print piece** is what comes off the printer as one solid. Generated models are made of overlapping primitives (a housing box with two lens tubes pushed into it), so printing every primitive alone would give a pile of fragments with no fixing between them. Parts of one object that overlap or touch are therefore fused into one piece, unless a joint says they are separate (decision 1). With no overlaps, a piece is exactly one part, and the rule matches the brief's "one STL per printable part".

**Numbering.** Requirement numbers are stable ids, because `design.md` and `tasks.md` will refer to them.

## Goals

- One action gives the user every file they need to print, buy and assemble the design.
- The print files are valid for slicers: closed, two-manifold meshes in millimetres with Z up, and joint features cut with the user's printer profile.
- The BOM lists everything to print, buy or machine, with sizes and counts taken from the same local rules as the joint card.
- The assembly sheet can be printed on paper and followed step by step.
- The user sees every joint and export problem before downloading, and can still continue.
- The agent can prepare an export and explain the kit, but never downloads or writes files itself.
- No regression: the workbench behaves as today until the user opens the export dialog, and existing tests pass.

## Out of scope

- STEP files and other CAD exchange formats. Forgehand's analytic primitives make STEP through OpenCascade.js possible later.
- Dimensioned drawings (SVG or PDF).
- Ordering from a print service, price quotes, and slicing (G-code).
- Choosing a print orientation. Pieces are written in their own frame with Z up; the user lays them flat in the slicer.
- Splitting a piece that is too large for the printer.
- Mass and cost estimates. C5 and C6 were cut on 2026-11-19; the BOM gives printed volume only.
- A downloadable tolerance test piece (see "How later specs fit").
- Exporting the workspace as Forgehand data for reopening; that belongs to `projects-memory` (C17).
- Importing any of these files back.
- Any change to `ModelSpec`, `Part`, the workspace schema, `/api/generate`, `/api/edit`, the provider adapters, the joint rules of `assembly-joints`, or the printer profile.
- English UI. The file contents are Traditional Chinese like the UI; `english-ui` localises them later.

## Functional requirements

### Scope and snapshot

1. The export dialog has a 匯出範圍 choice: 整個工作區 (every object) or 目前物件的組合件 (the active object and every object joined to it, `assemblyOf`). The default is 整個工作區 (decision 6). With one object, or when the active object's assembly is the whole workspace, the choice is hidden.
2. The kit is built from a snapshot of the workspace and the printer profile. If either changes while the dialog is open (an edit, a gesture, an agent `state` event, a profile field), the dialog discards its prepared kit and prepares it again before any download is allowed, with the notice 工作區已變更，正在重新準備匯出內容…. A download therefore always matches the summary on screen.
3. Exporting never changes the workspace and is never an undo step. It does not change the live scene, the camera, the selection or the exploded view.

### What is printed, bought or machined

4. Every part of every object in scope is classified, using the rules of `assembly-joints` requirements 11–13:
   - **bought component** (外購件): a part with `role: 'interior'`. Not printed.
   - **machined part** (加工件): an exterior part of an object whose material is aluminium or steel. Not printed.
   - **printed part** (列印件): every other exterior part. An object with no material is printed as generic FDM plastic, as `assembly-joints` assumes (its `NO_MATERIAL` info).
   The classification is one pure function in `shared/`, so the browser and the agent tool (requirement 52) agree.
5. Bought components and machined parts appear in the BOM (requirements 30–31), the GLB and the exploded image. They never get an STL and are not in the 3MF.

### Print pieces

6. **Fusion (decision 1).** Within one object, two printed parts are **linked** when their solids overlap by at least `FUSE_MIN_MM3` (1 mm³), or when two of their flat contact faces touch by `assembly-joints` requirement 22. Two parts that are the two sides of a joint are never linked directly. A **print piece** is a connected group of linked parts. Parts of different objects are never fused. A part linked to nothing is a piece by itself. A named switch `FUSE_PARTS` (default `true`) turns fusion off, giving one piece per printed part; this is the documented fallback of decision 1.
7. **Joint inside a piece.** When the two sides of a joint end up in one piece through other linked parts, the piece is still built as one solid, the joint's features are not cut, and the export reports `JOINT_FUSED` (requirement 22).
8. **Geometry.** A piece's solid is the union of its parts' printable solids, then the joint features of all its parts are applied: bosses are added and holes and pockets are subtracted after the union, so an overlapping part of the same piece never fills a hole. The primitives and features are built exactly as `printablePart` builds them (`assembly-joints` requirement 43, design §7.3–7.4), so a one-part piece equals `printablePart` of that part.
9. **Skipped features.** Features of a joint with any error finding from `checkJoints` are not cut (the `skip` option of `assembly-joints` requirement 46), and the export reports `FEATURES_SKIPPED`. An unconfirmed joint is exported with its current method and reported as `JOINT_UNCONFIRMED`.
10. **Frame.** A piece is written in the local frame of its **main part** (the part with the largest solid volume; on a tie, the first in model order), converted to the print frame: millimetres, Z up, with model `(x, y, z)` mapped to `(x, −z, y)`, so the model's top faces up and its front (`+z`, 前面) faces the slicer's front. The piece is translated so its bounding box is centred on X and Y and rests on Z = 0.
11. **Validity.** Every piece mesh is closed and two-manifold (Manifold status `NoError`), with outward-facing triangles and no degenerate triangles. If a piece cannot be built, it is left out of every print file and the export reports `PIECE_FAILED`; the export never writes a broken mesh. If only a feature cannot be applied, the piece is written without it and the export reports `FEATURES_SKIPPED`.
12. **Identical pieces.** Pieces of the same material and colour whose meshes are identical after rounding coordinates to 0.001 mm are one unique piece: one number, one STL, one 3MF object, and a count in the BOM. Otherwise every piece has count 1.
13. **Numbering and names.** Unique pieces are numbered `P01`, `P02`, … in workspace object order, then by the model order of their main part (the first copy decides). A piece's display name is 「{main part name}」, or 「{main part name}」（含 {n} 個零件） when it fuses several parts. Its STL file name is `stl/{number}-{main part id}.stl`; part ids are ASCII by `PartSchema`, so every file name in the kit is ASCII.

### Checks before export

14. When the dialog opens, it prepares the kit: it loads the CSG module (lazily, as `assembly-joints` requirement 44 requires), builds every piece, and computes the findings. While it works, it shows 正在準備列印檔…（{done}/{total}） and a 停止準備 button.
15. The dialog then shows a summary: the number of print pieces, bought components, machined parts and standard-part items, the total printed volume in cm³, and the findings below, each with an icon and text by severity (錯誤, 警告, 提示), so colour never carries the state alone.
16. The findings are the `checkJoints` findings of every joint in scope (all severities; info lines are collapsed under 顯示 {n} 則提示), followed by the export's own findings:

    | Severity | Code | Message (Traditional Chinese, fixed) |
    |---|---|---|
    | error | `PIECE_FAILED` | 「{piece}」無法產生列印檔，已略過。 |
    | warning | `FEATURES_SKIPPED` | 接合「{a}」↔「{b}」有問題，孔位沒有加工。 |
    | warning | `JOINT_UNCONFIRMED` | 接合「{a}」↔「{b}」尚未確認，先以「{method}」匯出。 |
    | warning | `JOINT_FUSED` | 接合「{a}」↔「{b}」的兩個零件會連成同一個列印件，孔位沒有加工。 |
    | warning | `JOINT_OVERLAP` | 接合「{a}」↔「{b}」的兩個零件重疊 {n} mm³，印出後無法組合。 |
    | warning | `COMPONENT_BLOCKED` | 外購件「{part}」和「{piece}」重疊，印出後放不進去。 |
    | warning | `LOOSE_PIECE` | 「{piece}」沒有和其他零件相連或接合，組裝時需要另外固定。 |
    | warning | `TOO_LARGE` | 「{piece}」最長 {n} mm，可能超過一般印表機的列印範圍。 |
    | info | `BOUGHT` | 「{part}」是外購件，不會產生列印檔。 |
    | info | `MACHINED` | 「{part}」是金屬件，需另行加工，不會產生列印檔。 |
    | info | `FUSED` | 「{piece}」由 {n} 個相連的零件合併而成。 |

17. `JOINT_OVERLAP`: the two sides of a joint overlap by at least `FUSE_MIN_MM3`. `COMPONENT_BLOCKED`: a bought component overlaps a printed piece of the same object by at least `FUSE_MIN_MM3`; this is the case of a battery inside a solid housing, which disappears once `design-fidelity`'s hollow `shell` primitive is used. `LOOSE_PIECE`: an object has more than one piece, and this piece neither links to nor is joined with any other part. `TOO_LARGE`: a piece's largest extent exceeds `LARGE_PIECE_MM` (250 mm, a named constant; common FDM beds are about 220–256 mm).
18. Findings are advisory and never block a download (the user's decision of 2026-11-19). When there is at least one error or warning, the dialog shows 有 {n} 個問題，仍可繼續匯出。 above the download buttons. Findings are sorted by severity, then code, then step or piece number, so the order is stable.
19. The findings also appear in the assembly sheet (requirement 36) and at the end of `bom.md`, so a reader of the files sees the same problems.

### Kit contents

20. 下載完整套件 downloads one zip file, `forgehand-kit-{yyyyMMdd-HHmm}.zip` in local time (decision 2), containing:

    | Path | Content |
    |---|---|
    | `assembly.html` | the assembly sheet (requirements 35–39) |
    | `exploded.png` | the exploded-view image (requirements 40–44) |
    | `bom.csv`, `bom.md` | the BOM (requirements 29–34) |
    | `kit.3mf` | every print piece for slicers (requirements 25–28) |
    | `workspace.glb` | the exported objects for viewing (requirements 45–47) |
    | `stl/P01-{part id}.stl`, … | one STL per unique print piece (requirements 23–24) |

21. Below the main button, the dialog lists every file of the kit with its size, each with its own 下載 button (下載 kit.3mf, 下載 stl/P01-housing.stl, …), so the user can download a single file. A single file is byte-identical to the same file in the zip.
22. A kit with no printed pieces (every part bought or machined) still has the BOM, the sheet, the image and the GLB; the 3MF and STL rows are absent and the summary says 沒有需要列印的零件。.

### STL

23. Each STL is binary, in millimetres in the print frame (requirement 10), with an 80-byte ASCII header `Forgehand {piece number} mm`, one facet per triangle, and facet normals computed from the triangle winding.
24. The STL is written by a small local writer from the piece mesh (positions and indices), not from display geometry.

### 3MF

25. **Writer (decision 3).** `kit.3mf` is written by a small local writer (expected under 200 lines) on top of the zip library of requirement 48. No 3MF library is added: three.js has no 3MF exporter, and the only complete library, lib3mf, is a multi-megabyte WASM build. The writer uses only the 3MF Core Specification: `[Content_Types].xml`, `_rels/.rels` and `3D/3dmodel.model`.
26. The model has `unit="millimeter"`, the metadata `Title` (the exported object names) and `Application` (Forgehand), one `<basematerials>` group with one `displaycolor` per distinct piece colour (the main part's `color`), and one mesh `<object type="model">` per unique piece with `name` set to 「{piece number} {piece name}（{object name}）」 and its colour. All text is XML-escaped.
27. **Layout (decision 4).** The `<build>` places every copy of every piece flat on the plate, not in assembled positions: rows of pieces in piece order, with a `PLATE_GAP_MM` (5 mm) gap between bounding boxes, each resting on Z = 0. A piece with count n has n build items that reference one object. The assembled positions are in the GLB and the image.
28. The 3MF is valid by construction: every vertex index is in range, every mesh is closed and outward-facing (requirement 11), object ids are unique, and every build item references an existing object. A unit test reads the zip back and checks these, and the manual check list (requirement 66) opens it in a slicer.

### BOM

29. **Printed pieces** (列印件), one row per unique piece: number, name, object, material (the object's material label, or 未指定（以 PLA 估）), count, size in the print frame (W×D×H mm, one decimal), volume of one copy (cm³, one decimal, from the mesh), STL file, and the names of the fused parts. A total printed volume line follows (sum over copies).
30. **Bought components** (外購件), from the interior parts in scope: name, object, size (W×D×H mm from its dimensions, one decimal) and count. Parts with the same name, primitive and dimensions (rounded to 0.1 mm) are one row with their count. The note column says 概念尺寸，購買前請確認型號與尺寸。
31. **Machined parts** (加工件), from metal exterior parts: name, object, material, size, and its machined features from `jointFeatures` (for example 「M3 攻牙孔 ×2」).
32. **Standard parts** (標準件), from `jointBom` unchanged: kind, label, quantity, and the step numbers of the joints that use them (requirement 36). A joint whose features were skipped (requirement 9) still contributes its `jointBom` items, and its row notes 接合有問題，請先修正。
33. **`bom.csv`** is one table with a 類別 column (列印件, 外購件, 加工件, 標準件) and the fields above as columns, Traditional Chinese headers, UTF-8 with a byte-order mark so spreadsheet programs read the Chinese text, CRLF line ends, and RFC 4180 quoting. A field that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'`, because names come from model output and must not run as spreadsheet formulas.
34. **`bom.md`** has a title, the date, the note 概念設計：尺寸與數量請在列印與購買前確認。, one table per category (an empty category is left out), the total volume, and the findings (requirement 19). Table cells escape `|`, line breaks and HTML, so a part name can never break the table or inject markup.

### Assembly sheet

35. **Format (decision 5).** `assembly.html` is one self-contained HTML file: inline CSS, the exploded image embedded as a `data:` URL, no script, no external resource, and a Content-Security-Policy `<meta>` that allows only inline styles and `data:` images. It opens offline on any machine and prints on A4 through the browser's print dialog (print CSS: no page break inside a step or a table row).
36. **Content**, in order: the title (the exported object names) and the date; the exploded image; 準備 with the printed pieces (number, name, material, count) and the parts to buy (bought components and standard parts with counts); 組裝步驟, one numbered step per entry of `assemblyNotes` in its order, where step n is the n-th joint and matches badge n in the image (requirement 42); the findings (requirement 19); and the notes 公差會因印表機與線材而不同。請先列印公差測試件，再依結果調整列印設定。 and 概念設計：尺寸與數量請在列印與購買前確認。
37. A step whose joint has an error adds 這個接合有問題，孔位沒有加工，請先修正後再匯出。 A kit without joints shows 這個套件沒有接合步驟。 instead of steps.
38. Every name in the sheet is HTML-escaped. Names come from model output and are untrusted.
39. The sheet is in Traditional Chinese, like the UI. Standard designations (M3, ISO 4762) and material abbreviations (PLA) are names.

### Exploded-view image

40. `exploded.png` is rendered off screen from the exported objects, at 1600 × 1200 pixels, with an opaque white background and a print style: solid part colours, dark edges, and soft lighting, so it reads on paper. It never shows the live view's hologram style, the gizmo, hand overlays, joint markers or the try-on cuff. If the image cannot be rendered (for example no WebGL context), the kit is written without `exploded.png`, the sheet keeps its text steps without the image, and the dialog shows 無法產生爆炸圖，其餘檔案不受影響。
41. **Explosion.** Every exported object is drawn fully exploded with the existing `computeExplosion` (display-only, as today). Objects of one assembly are also drawn apart along the normal of the joint that connects them, by at least 30 % of the smaller object's size, so every contact face is visible. Bought components are drawn, so the reader sees where they go.
42. **Step badges.** Each joint gets a numbered badge (a circle with its step number) at the centre of its contact region in the exploded drawing, matching the step numbers of requirement 36. This is the first item to cut (requirement 67).
43. **View.** The camera looks from the user's current view direction (so they can choose the angle by rotating the scene before exporting) and frames all exported objects with a margin.
44. **Privacy and the live view.** The image never contains the camera image: the camera video is a separate page element and is not part of the render. Rendering the image does not change the live view, its camera or its exploded state, and causes no visible flicker. All Three.js resources created for it are disposed with `disposeObject`, and an off-screen renderer, if one is used, is disposed after the capture.

### GLB

45. `workspace.glb` contains every exported object as a node with its transform, and every part as a child node with its `Part` transform and hierarchy, in metres with Y up (the glTF convention), assembled, not exploded.
46. Parts use their display geometry (`createPartGeometry`) with an opaque material in the part's colour; no hologram edges, no joint features (they are in the print files). Each part node carries `extras` with `objectId`, `partId`, `role` and the object's `material`; node names are the part and object names.
47. It is written with three.js's `GLTFExporter` in binary mode, loaded with the export code (requirement 49).

### Zip and loading

48. **Zip library (decision 2).** The zip and the 3MF package are written with `fflate` 0.8.3 (MIT), added as a direct dependency pinned with `--save-exact`. The same version is already installed today as a dependency of `@types/three` and is bundled inside three (`three/examples/jsm/libs/fflate.module.js`), so the install adds no new code. The part used (`zipSync` and `strToU8`) measured 9.2 kB minified and 4.6 kB gzip on 2026-11-20 (esbuild). File names in the zip are ASCII (requirement 13). PNG entries are stored without compression; all others are deflated. Entry times are the export time.
49. **Lazy loading.** The export code, `fflate`, `GLTFExporter` (37.5 kB minified, 11.2 kB gzip, measured 2026-11-20 with three external) and manifold-3d are loaded only when the dialog opens, in chunks separate from the main chunk, so the first page load does not grow. `npm run build` shows it.
50. **Downloads** use a `Blob`, an object URL and a temporary link; the object URL is revoked after the download starts. Each click starts exactly one download.

### Export dialog

51. A 匯出套件 button is visible whenever the workspace has at least one object, and disabled with no objects. It opens the export dialog (requirements 14–22). The dialog has a 關閉匯出 button and closes on Esc; closing it stops a running preparation between pieces and frees every CSG object. All new accessible names avoid existing test selectors: not 取消, 取消選取, 取消這次生成, 取消接合, 刪除零件, 刪除物件, 復原, 重做, 載入示範模型 or 生成 3D 草案.
52. The dialog can be opened during an agent run, because export reads a snapshot and changes nothing; requirement 2 keeps it consistent with changes the run makes.
53. The dialog exposes for tests: `data-export-state` (`preparing`, `ready` or `failed`), `data-export-files` (a JSON list of `{ path, bytes }`), `data-export-findings` (a JSON list of finding codes), and `data-export-image` (`ok` or `missing`).
54. A failure that stops the whole preparation (for example the CSG module cannot load) shows 無法準備匯出內容，請重新整理頁面後再試。 and sets `data-export-state="failed"`. No details of the error are shown or logged.
55. All new user-facing strings are Traditional Chinese.

### Agent

56. **Tool (decision 7).** One new server tool `prepare_export({ scope: 'workspace' | 'assembly' | null, objectId: string | null })`, project scope, local (no model call), effect `read-only`, label 準備匯出. `scope` defaults to `workspace`; `assembly` uses the assembly of `objectId`, or of the active object when `objectId` is null. It returns a summary computed only with shared pure functions (requirement 4, `jointBom`, `checkJoints`), without CSG: the number of printed, bought and machined parts per object, the standard parts with quantities, the unconfirmed joints, and the joint findings with severity error or warning. Errors: `NO_MODEL` for an empty workspace, `UNKNOWN_OBJECT`.
57. Its state change asks the browser to open the export dialog with that scope: `StateChange` gains an optional, nullable `exportDialog: { scope, objectId } | null`, so existing payloads stay valid. Like `tryOn`, it is session state: it never changes the workspace and is never an undo step. The browser opens the dialog when the change arrives, and prepares the kit as usual. Print pieces are counted only in the browser, so the summary says 列印零件 {n} 個（相連的零件會合併成一個列印件，實際數量以匯出視窗為準）.
58. The agent never downloads, writes or names files on the user's machine, and cannot press 下載完整套件. `AGENT_INSTRUCTIONS` says, in English: the agent cannot save files; to export, call `prepare_export` and ask the user to press 下載完整套件 in the export dialog; mention the problems the tool returns before the user downloads and offer to fix them; the kit contains STL, 3MF, a BOM, an assembly sheet and a GLB; STEP files, drawings, print-service orders and slicing are not supported.
59. `prepare_export` uses the request's `printer` profile (`assembly-joints` requirement 20), or the defaults without it, so its BOM and findings match the dialog.

### Compatibility

60. Until the user opens the export dialog, the workbench looks and behaves as today, except for the new 匯出套件 button.
61. Every existing e2e spec passes unchanged. Existing unit tests change only where they assert the list of registered tools or the exact shape of `StateChange` (both extended here). If any other existing test needs a change, the task stops and reports instead of editing it.
62. `/api/generate`, `/api/edit`, `ModelSpec`, `Part`, the workspace schema, the joint rules and the provider adapters stay untouched. No new API route is added.

## Non-functional requirements

63. **Where code lives.** The classification (requirement 4), the BOM rows and the agent summary are pure functions in `shared/`, used by the browser and the agent tool. The file writers (STL, 3MF XML, CSV, Markdown, HTML, zip) are pure functions in `src/export/` that take data and return bytes or text, and run in Node for tests. Piece building uses the CSG module next to `printablePart`. Only the dialog, the image capture, the GLB and the downloads need the DOM.
64. **Determinism.** The same workspace, profile, scope and export time give byte-identical files, so tests can compare output.
65. **Speed.** Preparing the kit yields between pieces so the page keeps painting and the dialog's progress updates. Budget: two demo objects joined with one screw joint (the e2e setup) are ready within 3 s on the user's laptop; design states the budget for 8 objects of 64 parts. CSG runs only while the dialog prepares, never during a gesture.
66. **Tests.** Every task has Vitest unit tests; pure modules and piece building (with the real WASM) are tested in Node; no jsdom or happy-dom is added. Tests never call a real model back end. Unit tests cover at least: classification; fusion (overlap, touching, a joint that separates, a joint fused through a third part); the print frame and Z-up mapping; identical-piece counting; every export finding; STL bytes (header, triangle count, a known volume); the 3MF read back (unit, names, colours, closed meshes, build items, escaping); CSV quoting, byte-order mark and formula guard; Markdown and HTML escaping of a hostile part name; the zip file list; determinism; `prepare_export` success and error paths. E2E tests cover: opening the dialog with two demo objects and a joint, the findings list, downloading the zip (unpacked in the test to check the file list) and one single file, a workspace change while the dialog is open, and a routed `/api/agent` stream whose `state` frame opens the dialog. The last task ends with a manual check list: open `kit.3mf` in PrusaSlicer, Bambu Studio or OrcaSlicer (piece count, names, colours, millimetre size), open one STL, open `workspace.glb` in Blender or another glTF viewer, print `assembly.html` to PDF, and, if time allows, print one jointed pair.
67. **Cut order** if time runs short: the step badges in the image (requirement 42), then the agent tool (requirements 56–59), then the image in the assembly sheet (the sheet keeps its text steps), then the assembly sheet itself. The STL, the 3MF and the BOM stay. This follows `docs/VISION.md` §5.
68. **Privacy and security.** Export makes no network request and never calls `/api/*`; the files exist only in the browser until the user saves them. Model-written names are escaped in every format (XML, HTML, Markdown, CSV). Nothing about the kit is logged. The server is unchanged except for one read-only tool. README's privacy section adds that export runs locally.
69. **Resources.** Every Manifold and CrossSection object is deleted after use, also when preparation is stopped or fails; Three.js resources of the image and the GLB are disposed with `disposeObject`; object URLs are revoked.
70. **Dependencies.** `fflate` is the only new direct dependency (requirement 48); manifold-3d comes from `assembly-joints`. README credits `fflate` (MIT) next to manifold-3d.
71. **Language.** Spec, design, task files and code comments are English; user-facing strings and file contents are Traditional Chinese, with no mixed languages on one screen.
72. `npm run check` (type check + build + unit tests) passes before a task is marked done, and the real result is reported.
73. README gets a short "export" section: what the kit contains, that it runs locally, that the 3MF lays pieces out flat for printing, how parts are fused into pieces and how a joint keeps them apart, and the tolerance test-print note. The project still installs and runs from the README alone.
74. `tasks.md` has at most 5 tasks, each small enough for one fresh Kiro session with Claude Sonnet 5.5, with "Read first", "Build", "Tests", "Done when" and "Session facts" as in `assembly-joints`, and the cut order of requirement 67. `design.md` maps every requirement to a task.

## Dependencies on other specs

- **assembly-joints** (C9). Task 1 (data, materials, printer profile, `assemblyOf`) has landed (commit `184182d`). Export needs Task 2 (`jointFeatures`, contact faces and `touching` for fusion) and Task 3 (`checkJoints`, `jointBom`, `assemblyNotes`, manifold-3d and `printablePart`) before it can build pieces, findings or the BOM. Export also needs to build several primitives and features in one frame before subtracting holes (requirement 8), so it reuses Task 3's primitive and feature builders from `src/print/` instead of calling `printablePart` once per part; design states the small export it needs there. Task 5 adds `printer` to the agent request; until it lands, `prepare_export` uses the default profile. Task 4 (the 列印件預覽) is the first browser use of manifold-3d; if it lands after export's browser task, export proves the browser loading itself.
- **design-fidelity** (C18). The `shell` primitive reaches export through `printablePart` and `createPartGeometry`; export has no primitive-specific code. Without it, solid parts export correctly, and `COMPONENT_BLOCKED` tells the user when a bought component sits inside a solid part.
- **hand-manipulation** (C4). No dependency. Its tasks edit `src/App.tsx` and `src/scene/` in parallel, so export's browser task starts from a clean tree, like `assembly-joints`.
- **english-ui** (C16). All labels, messages and file text are plain string tables, ready for localisation.

### Proposed task split (design confirms)

1. File writers from mesh data: STL, 3MF package and layout, zip, determinism. Needs only `fflate`; can start now.
2. Kit plan in `shared/`: classification, BOM rows, CSV and Markdown, assembly-sheet HTML from `assemblyNotes`. Needs `assembly-joints` Task 3.
3. Print pieces: fusion, union, features, print frame, identical pieces, export findings, in Node with the real WASM. Needs `assembly-joints` Tasks 2–3.
4. Browser: the dialog, the off-screen exploded image, the GLB, downloads, e2e.
5. Agent tool, instructions, README, manual check list.

## How later specs fit (not built here)

- **Tolerance test piece:** a small printable gauge with one hole per fit class (insert, clearance, press, sliding), built with the same feature rules and `printablePart`, offered as one more file in the kit.
- **STEP:** from the analytic primitives through OpenCascade.js or replicad, as one more file per piece.
- **Drawings:** orthographic views to SVG with overall dimensions from the piece bounding boxes.
- **materials-analysis:** adds density and price to the material table; the BOM gains mass and cost per piece from the volumes it already has.
- **projects-memory:** a saved project can keep its last exported kit summary.
- **Print orientation:** choosing the largest flat face as the bed face per piece.

## Decisions from review

The decisions were reviewed and all ten recommendations accepted on 2026-11-20. The requirements above reflect them.

1. **Accepted: print pieces.** Parts of one object that overlap or touch are fused into one print piece unless a joint separates them (requirements 6–7, 13, 17); a joint is the user's way to say "print these separately". Generated models overlap primitives (the demo housing has two lens tubes and a battery pushed into it), so strict per-part files would be fragments with no fixing and no assembly step. **Documented fallback:** `FUSE_PARTS = false` gives one piece per printed part, if fusion cannot be made reliable in time (requirement 6).
2. **Accepted: one zip, written with `fflate` 0.8.3 as a pinned direct dependency** (requirements 20, 48). Several automatic downloads are blocked or prompted by browsers, and a zip keeps the kit together. `fflate` is MIT, already installed through `@types/three`, and the part used costs 4.6 kB gzip. Importing three's bundled copy was rejected because it relies on a file path inside three.
3. **Accepted: a local 3MF writer** (requirement 25), Core Specification only. No suitable small library exists; lib3mf is a large WASM build.
4. **Accepted: the 3MF lays pieces out flat on the plate, not assembled** (requirement 27). Assembled pieces overlap in the slicer, and some slicers then ask to merge them into one object. The assembled view lives in the GLB and the image.
5. **Accepted: the assembly sheet is self-contained HTML** (requirement 35), not Markdown: it embeds the image, prints to PDF and opens anywhere. The BOM is both CSV and Markdown.
6. **Accepted: scope 整個工作區 by default, with 目前物件的組合件 as an option** (requirement 1). The option helps when the workspace also holds discarded variants.
7. **Accepted: `prepare_export` opens the dialog and summarises; the user downloads** (requirements 56–59). A download stays the user's action; no client tool triggers it.
8. **Accepted: the image is in print style on white**, from the user's current view direction, with every object exploded and assemblies drawn apart along their joints (requirements 40–43).
9. **Accepted: joint errors and unconfirmed joints do not block export** (requirement 9): a joint with an error gets no features cut, an unconfirmed joint is exported with its current method, each with a warning.
10. **Accepted: bought components and metal parts get no STL** (requirement 5). Metal parts are listed with their machining features; STEP is the later format for a machinist.

## Changes while writing the design (2026-11-20)

Small changes made while writing `design.md`, after the review:

- **Fusion switch** (requirement 6): the fallback of decision 1 is a named constant, `FUSE_PARTS`.
- **Identical pieces also need the same material and colour** (requirement 12), so a PLA copy and a TPU copy of one shape stay two BOM rows.
- **A missing image does not stop the export** (requirement 40): without WebGL, the kit is written without `exploded.png`, the sheet keeps its text steps, and the dialog says so. The dialog exposes `data-export-image` for tests (requirement 53).