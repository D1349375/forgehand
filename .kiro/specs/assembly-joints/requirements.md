# Assembly joints — Requirements

## Overview

Since `workspace-v2` the workbench holds several objects, each with its own model and transform, but nothing records how they connect. Two objects that touch on screen are only drawn close together: there is no data that says "these two are fixed with two M3 screws", so nothing can be printed, bought or assembled from the design.

This spec makes joints real data. It is capability C9 in `docs/VISION.md` (§2, "Real, buildable output", decided with the user on 2026-11-19). A **joint** connects a part of one object to a part of another (or, see decision 1, two parts of one object) through one flat **contact face** on each, and records a **fixing method** that suits printed prototypes: screws with heat-set inserts, magnets, dowel or press-fit pins, or glue. Each object gets a minimal **material**, and a **printer profile** holds the tolerances the user tunes for their printer. From the joint, the materials and the profile, local rules derive everything else: where the holes go, how big they are, which screw length to buy, and what may go wrong.

The user joins objects in three ways:
- **Two hands:** each fist holds one object; bringing them together snaps the faces into alignment and shows a clear 「可以接合」 cue before release; releasing creates the joint. This adds one row to the two-hand join table of `hand-manipulation` (its requirement 82 and "How later specs fit").
- **Mouse and panels:** click a face on each object, see the same cue, confirm. This path exists for accessibility and for tests.
- **The agent:** tools to create a joint, set its method, set materials. The agent asks about load and disassembly and explains its recommendation with the reasons the local rules give.

After joining, a **joint card** shows the recommended method and its reasons; the user confirms or changes it.

Joined objects form an **assembly** and move together: any move of one of them (a fist, the 物件 panel, the agent's `set_transform`) moves the whole assembly as one undo step, so a normal move never pulls a joint apart (decided in review, see "Decisions from review").

Joint **features** (insert holes, screw clearance holes and counterbores, bosses, magnet pockets, pin holes) need boolean operations (CSG) on the primitives. This spec computes the features as data, draws them in the scene as markers, builds the printable geometry of one part on demand, and defines the pure interface the later `export` spec calls to write per-part print files, a BOM and an assembly sheet.

Snap detection, checks, recommendations, tolerances and features are local rules: they run in the browser (and the same code on the server for agent tools), take milliseconds, and spend no model quota.

**Numbering.** Requirement numbers are stable ids, because `design.md` and `tasks.md` refer to them. Requirements 84–88 were added in review and sit in the section they belong to, so the numbers are not in order inside the document.

## Goals

- Joints, materials and their changes are workspace data, validated by one Zod schema in `shared/`, migrated from version 1, with undo and redo like every other workspace change.
- Four fixing methods with dimensions taken from published standards and datasheets, in one table a reviewer can check.
- Tolerances live in a printer profile the user can tune after printing a test piece; no joint stores a hole size.
- Joining feels physical with two hands: faces snap, the cue appears before release, and one release is one undo step.
- Joined objects stay joined: an assembly moves as one, so only a model edit can separate a joint.
- Every hand step has a mouse or panel equivalent, so the feature works without a camera and is testable.
- The agent helps choose a method from the user's answers about load and disassembly, using the same local rules as the card.
- The export spec gets a small, pure, tested interface: features per part, printable geometry per part, BOM items, assembly notes and assemblies.
- No regression: with no joints the workbench behaves as today, and existing tests pass.

## Out of scope

- Snap-fits (cantilever clips). They need flexible materials and careful geometry. The material table records that PLA is too brittle for them, and the agent says that snap-fits are not supported yet.
- Welding. It hardly applies to printed prototypes; the agent only warns.
- Moving joints: hinges, sliders, revolute or ball joints. Every joint here is fixed.
- More than one method per joint (for example pins plus glue). The user can add a second joint on another face pair.
- Moving one object of an assembly on its own. An assembly always moves as one; to move one object alone, the user removes its joint first.
- Splitting a part of an object into a new object.
- Curved contact: joints between curved surfaces (sphere, torus, the side of a cylinder).
- STEP export, the export files themselves (STL, 3MF), the BOM file and the assembly sheet: they belong to the `export` spec, which calls the interface of requirements 66–71.
- Downloading a printable tolerance test piece. This spec shows the note to print one; `export` can offer the file (see "How later specs fit").
- Material appearance (PBR), density, mass and price. C5 and C6 were cut on 2026-11-19.
- The two-hand ruler, and any change to the other two-hand gestures of `hand-manipulation`.
- Changes to `ModelSpec`, `Part`, `/api/generate`, `/api/edit`, `designTask`, `editTask` or the provider adapters. Model back ends never see joints except through the agent's state snapshot and tool results.
- English UI.

## Functional requirements

### Workspace data (version 2)

1. `WORKSPACE_VERSION` becomes 2. `Workspace` gains `joints: Joint[]` and `SceneObject` gains `material: MaterialId | null`. Nothing else in the workspace changes shape.
2. **Migration.** A pure `migrateWorkspace(input)` in `shared/workspace.ts` turns a version-1 workspace into version 2 by adding `joints: []` and `material: null` to every object, and returns version-2 input unchanged. `validateWorkspace` migrates before it validates, so a saved or in-flight version-1 workspace is still accepted; any other version is `INVALID_WORKSPACE`. `assertWorkspace` accepts only version 2. A `SceneObject` that arrives without a `material` key (an `add` change in a `state` event, a test fixture) is read as `material: null`, so existing payloads stay valid.
3. **Joint.**
   ```
   Joint = {
     id: string,                        // object-id format; created by whoever creates the joint
     a: JointSide, b: JointSide,
     method: JointMethod,
     needs: { load: 'light' | 'medium' | 'heavy' | null, disassembly: 'never' | 'sometimes' | 'often' | null },
     confirmed: boolean,                 // the user chose or accepted the method (requirement 55)
     createdAt: string,                  // ISO 8601
   }
   JointSide = { objectId: string, partId: string, face: '+x' | '-x' | '+y' | '-y' | '+z' | '-z' }   // in the part's own axes
   JointMethod =
     | { kind: 'screw-insert', size: 'M2' | 'M3', count: 1..4, insertSide: 'a' | 'b' }
     | { kind: 'magnet', magnet: MagnetId, count: 1..4 }
     | { kind: 'pin', pin: PinId, count: 1..4, fit: 'press-both' | 'press-slide' }
     | { kind: 'glue', glue: 'ca' | 'epoxy' | 'solvent' }
   ```
   A joint stores only choices. Positions, hole sizes, depths, screw and pin lengths are derived (requirements 29–37), so they follow part edits and profile changes and can never go stale.
4. `assertWorkspace` enforces for joints: unique ids in the id format; at most `MAX_JOINTS` (32); both sides name an existing object and part; the two sides are different parts; each face is a contact face of its part's primitive (requirement 21) and allows the joint's method (tube caps allow glue only); no two joints connect the same two (object, part, face) sides; magnet and pin ids exist in the standard-parts table. Whether the faces actually touch is **not** a workspace rule: it is a check (requirement 39), so moving or editing an object never makes the workspace invalid.
5. **Operations.** Pure functions in `shared/`, following the contract of `workspace-v2` requirement 12 (never mutate, return the same reference when nothing changes, keep the references of unchanged objects, ids and timestamps passed in): `addJoint`, `updateJoint` (method, needs, confirmed), `removeJoint`, `setMaterial`, `realignJoint` (moves side b's side so the faces meet again, requirement 26), and `joinObjects`, which applies up to two object moves and adds one joint in a single result. `setTransform` keeps its signature and now moves the object's whole assembly (requirement 85), so `joinObjects`, the 物件 panel, the fist and the agent all move assemblies through it.
6. **Cascades.** `removeObject` also removes every joint that names the object. `replaceModel` also removes every joint whose part no longer exists, or whose face is no longer a contact face because the part's primitive changed. The cascade is part of the same operation, so it is part of the same undo step, and the browser adds 已一併移除 {n} 個接合。 to the notice. A change of a part's dimensions, position or rotation keeps the joint; if it moves a contact face, the checks report 已分開 (requirement 88).
7. **Undo.** An undo snapshot holds `objects`, `activeObjectId` and `joints`. Each of these is one undo step: adding, changing or removing a joint; setting a material; 重新對齊; a join (the moved transforms and the new joint together); a move of an assembly (every moved object together). These are not undo steps: opening or closing a joint card, the joint list's selection, the printer profile, the 顯示接合 switch, the 列印件預覽, and any snap preview.
8. A workspace stays plain JSON: `validateWorkspace(JSON.parse(JSON.stringify(ws)))` returns an equal workspace.

### Assemblies (added in review)

84. **Assembly.** An object's assembly is the set of objects connected to it through joints between different objects, directly or through other objects, including the object itself. `assemblyOf(workspace, objectId)` returns their ids in workspace order (requirement 70). A joint between two parts of one object links nothing.
85. **Moving an assembly.** `setTransform(ws, id, patch)` moves the object's whole assembly as one rigid body: the change from the object's old to its new transform is applied to every other object of its assembly, so their placement relative to each other, and every joint between them, is kept. A move that changes only the position moves every other object by the same offset and leaves their rotations untouched. Every move path goes through this one operation: the 物件 panel's fields, a fist move (`hand-manipulation` requirement 92), the agent's `set_transform`, a `transform` change in a `state` event, and `joinObjects`. The browser and the server therefore compute the same result, and each move is one undo step. Moved transforms are rounded like other transforms; a unit test moves a jointed pair 200 times and rotates it 20 times and shows the joint still touching (requirement 22).
86. **Limits.** A move that would put any object of the assembly outside the transform limits is rejected as a whole with `INVALID_WORKSPACE`: nothing moves, and the 物件 panel shows its existing rejection notice.
87. **Feedback.** While a fist holds an object, the preview moves the scene roots of its whole assembly by the same offset (requirement 60). During a mouse or hand join, side b's assembly is shown moving with side b. A move of more than one object shows the notice 已調整物件位置（連同接合的 {n} 個物件），可按「復原」回到上一步。
88. **What can still break a joint.** Only a change inside a model can move a contact face away: a part's dimensions, position, rotation or primitive changed through the part fields, the gizmo, a hand drag of a part, an AI edit or the agent's `edit_design`. Rounding over many rotations could in principle add up too. The joint then reports 已分開 (requirement 39), and the card offers 重新對齊 (requirement 26). Undo returns to the aligned state.

### Materials

9. `MaterialId` is one of `pla`, `petg`, `abs`, `tpu`, `nylon`, `resin`, `aluminium`, `steel`. One table in `shared/` gives each a Traditional Chinese label (PLA, PETG, ABS, TPU, 尼龍, 樹脂, 鋁, 鋼), a process (`fdm`, `resin` or `metal`), whether it is flexible, its solvent family (ABS only), whether heat-set inserts suit it, and how well each glue type bonds it (good, fair, poor). The table has no density, price or appearance; `materials-analysis` can add those later.
10. The 物件 panel gets a 材料 select for the active object (the eight materials plus 未指定), and the agent gets `set_material` (requirement 64). A change is one undo step. The material does not change how the object is rendered and does not mark the object 已修改.
11. **One material per object.** Every exterior part of an object is made of the object's material. Parts that need another material belong in another object; this is also why two-object assembly matters (decision 2).
12. **Bought components.** A part with `role: 'interior'` is treated as a bought component (a battery, a PCB, a motor). The object's material does not apply to it, a joint may name it, and features are never cut into it: it brings its own holes.
13. **Metal parts** (aluminium, steel) are not printed. Their features are reported as machining features (tapped holes, drilled holes), and the checks say 金屬零件需另行加工。

### Standard parts

14. One module in `shared/` holds the standard-parts table: heat-set inserts M2 and M3 (thread, length, outer diameter, recommended hole diameter, vendor); socket head cap screws ISO 4762 M2 and M3 (head diameter, head height, the standard lengths offered); clearance holes ISO 273 (medium series); tap drills for metal; disc magnets; dowel pins; and the three glues with Traditional Chinese labels. Every number has its source (a standard number or a datasheet URL) in a comment next to it, and a unit test pins the values, so any change is deliberate and reviewed.
15. Starting values, which the reviewer checks against the cited sources before Task 1 is accepted:

    | Entry | Values (mm) | Source |
    |---|---|---|
    | Insert M2 (CNC Kitchen M2×3) | length 3.0, hole Ø3.2; outer Ø from the datasheet | cnckitchen.store, M2×3 product and datasheet |
    | Insert M3 (CNC Kitchen M3×5.7) | length 5.7, hole Ø4.0, outer Ø4.6 | cnckitchen.store, M3×5.7 datasheet |
    | Screw M2, ISO 4762 | head Ø3.8, head height 2.0; lengths 4, 5, 6, 8, 10, 12, 16, 20 | ISO 4762 |
    | Screw M3, ISO 4762 | head Ø5.5, head height 3.0; lengths 4, 5, 6, 8, 10, 12, 16, 20, 25, 30 | ISO 4762 |
    | Clearance hole, ISO 273 medium | M2 Ø2.4, M3 Ø3.4 | ISO 273 |
    | Tap drill, metric coarse | M2 Ø1.6, M3 Ø2.5 | ISO 261 / tap drill tables |
    | Disc magnets (Ø × thickness) | 6×2, 6×3, 8×3, 10×2, 10×3 | common N35–N52 neodymium sizes; one supplier datasheet cited |
    | Dowel pins, ISO 8734 | Ø2, Ø3, Ø4; lengths 6, 8, 10, 12, 16, 20 | ISO 8734 |
    | Glues | CA (瞬間膠), 2-part epoxy (AB 膠), solvent (溶劑黏合, ABS family only) | material table, requirement 9 |

    CNC Kitchen notes that printed holes come out smaller than designed, so its recommended hole diameters often fit tightly ([CNC Kitchen, "Are our heat-set insert datasheets wrong?"](https://cnckitchen.com/blog/are-our-heat-set-insert-datasheets-wrong)); the printer profile's hole compensation (requirement 17) covers that.
16. `design-fidelity` (C18) also needs an M2/M3 screw and standoff table for its generation rules. Both specs use this one module; whichever lands first creates it, and the other adds entries instead of a second table.

### Printer profile

17. A printer profile holds the tolerances, in millimetres, with defaults and allowed ranges:

    | Field | Meaning | Default | Range |
    |---|---|---|---|
    | `slidingFit` | gap per side for a part that should slide in | 0.25 | 0–1 |
    | `pressFit` | gap per side for a part that should press in | 0.10 | 0–0.5 |
    | `holeCompensation` | added to the diameter of every printed hole, because printed holes come out small | 0.20 | 0–1 |
    | `depthAllowance` | added to the depth of every blind printed hole and pocket | 0.20 | 0–1 |
    | `petgExtra` | added per side to fits in PETG parts | 0.05 | 0–0.5 |

    The starting points follow common FDM guidance: about 0.05–0.15 mm per side for a press fit and 0.2–0.3 mm for a sliding fit, more for PETG, with holes made about 0.2 mm larger still (for example [Mandarin3D, "3D printing tolerances"](https://mandarin3d.com/blog/3d-printing-tolerances-clearance-for-every-fit)). The reviewer checks the defaults; they are starting points, not promises.
18. A printed hole's diameter is its nominal diameter + `holeCompensation` + 2 × (its fit allowance + `petgExtra` when the part is PETG). Each feature has a fixed fit class:

    | Feature | Nominal | Fit allowance |
    |---|---|---|
    | insert hole | the insert's recommended hole Ø; depth = insert length + `depthAllowance` | none (the datasheet value is already the fit) |
    | screw clearance hole | ISO 273 medium | none |
    | counterbore for the screw head | head Ø; depth down to the clamp floor | `slidingFit` |
    | magnet pocket | magnet Ø; depth = thickness + `depthAllowance` | `pressFit` |
    | pin hole, press side | pin Ø | `pressFit` |
    | pin hole, sliding side | pin Ø | `slidingFit` |
    | boss | outer Ø from requirement 33 | none |
    | tapped or drilled hole in metal | tap drill or clearance Ø | none: not printed, no compensation |

    Resin parts use the same values, and the checks add the info line 列印設定是依 FDM 調整的，樹脂列印請另行測試。
19. The profile is a user setting stored in the browser (`localStorage`), not in the workspace and not an undo step, because it belongs to the user's printer rather than to one design. A missing or invalid stored value gives the defaults. A 列印設定 panel shows the five values as number fields with the same validation as the part fields, a 恢復預設值 button, and the note 公差會因印表機與線材而不同。請先列印公差測試件，再依結果調整這些數值。 A changed value changes the derived features, markers and checks at once.
20. The agent request gains an optional `printer` field with the profile, so the server's checks and recommendations use the same values as the browser; without it the server uses the defaults. The agent cannot change the profile.

### Contact faces and snapping (local rules)

21. **Contact faces.** Only flat faces can be contact faces, named in the part's own axes:

    | Primitive | Faces | Face shape |
    |---|---|---|
    | box | `+x`, `-x`, `+y`, `-y`, `+z`, `-z` | rectangle |
    | cylinder | `+y`, `-y` (caps) | disc |
    | cone | `-y` (base) | disc |
    | tube | `+y`, `-y` (caps) | ring; glue only |
    | sphere, torus | none | — |
    | shell (`design-fidelity`, when it exists) | as box | rectangle; the wall is the shell's wall |

    Labels for the user: `+x` 右面, `-x` 左面, `+y` 頂面, `-y` 底面, `+z` 前面, `-z` 後面.
22. **Touching.** Two faces touch when their world normals are opposite within `CONTACT_ANGLE_DEG` (1°), the gap between their planes is at most `CONTACT_GAP_MM` (0.1 mm) in either direction, and their overlap in the plane is at least `MIN_CONTACT_MM2` (20 mm²). The **contact region** is that overlap. World faces come from the object transform and the part's world matrix (`shared/bounds.ts`). It is one pure function.
23. **Snap candidates.** Given two objects and their current (or previewed) transforms, a pure function finds the best snap candidate among the contact faces of their exterior parts: normals opposite within `SNAP_ANGLE_DEG` (15°), the gap along the normal between `−SNAP_PENETRATION_MM` (3 mm into each other) and `SNAP_DISTANCE_MM` (10 mm apart), and an overlap of at least `MIN_CONTACT_MM2` once aligned. The best is the smallest gap, then the smallest angle, then the largest overlap, then the smaller ids, so the result is deterministic. **Facing pairs.** For the mouse join and the agent, where the user does not bring the objects close, the same function ranks the facing pairs of two given parts (or of all exterior parts of two objects) without the distance limit: each face's centre lies in front of the other face, the normals are within `SNAP_ANGLE_DEG`, and the overlap once aligned is at least `MIN_CONTACT_MM2`; the smallest gap comes first.
24. **Alignment.** The aligned transform of the second object (side b) rotates it by the smallest rotation that makes the normals exactly opposite (at most `SNAP_ANGLE_DEG`), then moves it along the normal so the planes meet. In the plane it stays where the user put it, except that face centres closer than `CENTRE_SNAP_MM` (3 mm) are centred. Alignment never moves side a's object; side b's object moves, and its assembly moves with it (requirement 85). The result is rounded like other transforms (position 5 decimals, rotation 2 decimals), stays within the transform limits, and after rounding still passes requirement 22.
25. **Hysteresis.** A pure step function turns candidates into a stable snap state for live use: a candidate becomes **ready** after the same face pair has held for `SNAP_SETTLE_MS` (150 ms), and stops being ready when the gap grows past `SNAP_RELEASE_MM` (15 mm), the angle past `SNAP_RELEASE_DEG` (25°), or another pair has been better for `SNAP_SETTLE_MS`. This keeps the cue from flickering.
26. **Re-alignment.** For a joint whose faces no longer touch (requirement 88), `realignJoint` applies requirement 24 to the joint's own faces regardless of distance, as long as the normals are within `SNAP_ANGLE_DEG`. It moves side b's object together with every object that stays connected to it when this joint is left out. When side a's object is among them (the two are also connected through other joints), it fails with 這兩個物件還透過其他接合相連，無法單獨對齊。; normals too far apart fail with 兩個接合面的方向差太多，請先旋轉物件。 It is not offered for a joint inside one object.
27. **Joints inside one object or one assembly** are created only when the two faces already touch (requirement 22); nothing moves. This covers two parts of one object (decision 1) and two objects that are already connected through other joints.
28. All snap and contact constants live in one module and are exported by name; the defaults above are starting points to tune on the user's laptop.

### Joint features (local rules)

29. A pure `jointFeatures(workspace, profile)` returns, for each part that a joint touches, the list of features in that part's local frame, in metres: kind (`insert-hole`, `clearance-hole`, `counterbore`, `boss`, `magnet-pocket`, `pin-hole`, `tapped-hole`, `drilled-hole`), the centre on the face, the axis into the part, diameter, depth, fit class, nominal size, the joint id, and whether it is printed or machined. The same input always gives the same output.
30. **Layout.** A joint with `count` fasteners places them inside the contact region, at least the feature's radius + `EDGE_MARGIN_MM` from its edge and at least two feature diameters apart: 1 at the centre; 2 along the region's long axis; 3 in a line along the long axis, or in a triangle when the region is nearly square; 4 at the corners of a centred rectangle. Both sides use the same positions, mirrored through the contact plane. The thickness of a part along the axis is measured from its geometry (its dimension along that axis; for a shell, the wall).
31. **Screws with inserts.** The insert side gets an insert hole. The other side (the screw side) gets a clearance hole through the part, and a counterbore from the far face down to a clamp floor of `CLAMP_FLOOR_MM` when the part is thicker than that floor. Below the insert, the hole continues as a clearance hole for `SCREW_TAIL_MM`, or through the part when it is too thin for that, so the next standard screw length fits. The screw length is the shortest standard length that reaches at least `MIN_ENGAGEMENT` (1.5 × the thread diameter) into the insert and does not reach past the end of that hole. With no such length, the joint has an error (requirement 39).
32. **Metal sides.** When the insert side is metal it gets a tapped hole instead of an insert hole, and the BOM has no insert. A metal screw side gets a drilled clearance hole.
33. **Bosses.** When the insert side is thinner along the axis than the insert length + `MIN_FLOOR_MM`, a boss is added around the insert hole so the insert has its full depth: on the opposite face of a solid part, or on the inner face of the wall of a shell. Its outer diameter is the insert's outer diameter + 2 × `BOSS_WALL_MM`. The checks report it as info (已在背面加上螺柱。) and warn when it would intersect another part of the same object.
34. **Magnets.** Each position gets a pocket on both sides, open at the contact face, each for one magnet; the BOM counts 2 × `count` magnets and the assembly notes say to check the poles before gluing or pressing them in. A side too thin for the pocket + `MIN_FLOOR_MM` is an error.
35. **Pins.** Each position gets a blind hole on both sides. The pin length is the longest standard length that fits both depths (each side's thickness − `MIN_FLOOR_MM`), split evenly, and at least 2 × the pin diameter; with none, the joint has an error. `press-both` uses the press fit on both sides; `press-slide` uses the press fit on side a and the sliding fit on side b, so the parts can be taken apart.
36. **Glue** adds no features. The contact area is reported to the checks.
37. **Components.** No feature is ever placed on a bought component (requirement 12). A joint whose features land on a component side places them only on the other side, and the assembly notes refer to the component's own holes.
38. Feature constants (`EDGE_MARGIN_MM`, `CLAMP_FLOOR_MM`, `SCREW_TAIL_MM`, `MIN_FLOOR_MM`, `BOSS_WALL_MM`) live in the same module as the snap constants; design fixes their defaults.

### Checks and recommendations (local rules)

39. A pure `checkJoints(workspace, profile)` returns, per joint, a list of findings `{ jointId, severity: 'error' | 'warning' | 'info', code, message }` with fixed Traditional Chinese messages. At least:
    - **error:** the faces no longer touch after a model edit (已分開，可按「重新對齊」。, requirement 88); a face is no longer a contact face; the features do not fit the contact region; a part is too thin for its features; no standard screw or pin length fits; two features of one part (from any joints) intersect.
    - **warning:** glue on a side whose material bonds poorly with that glue (for example nylon or TPU); solvent glue unless both sides are ABS; glue as the only fixing between metal and plastic (金屬與塑膠建議用螺絲或銷固定。); heat-set inserts into resin or TPU; a boss that intersects another part.
    - **info:** both sides of the same material (同材質接合最容易。); a material not set (未指定材料，先以一般 FDM 塑膠估算。); PETG with the extra allowance; resin with an FDM profile; machined features on metal; a boss added.
40. Checks are advisory. They never block creating, changing or confirming a joint. The `export` spec decides what an error means for its files.
41. A pure `recommendJoint(workspace, jointId, profile)` returns the methods ranked, each with complete parameters and a list of short Traditional Chinese reasons. Only methods whose features fit (no error from requirement 39) are ranked first. The rules include at least:
    - taken apart often and a light load → magnets first (拆裝方便);
    - taken apart sometimes or often with a medium or heavy load → screws with inserts first (最牢固，可重複拆裝);
    - never taken apart → glue when both materials bond well with one glue, otherwise press-fit pins;
    - metal to plastic → never glue first; the insert goes on the plastic side;
    - no room or an unsuitable material for inserts → the next method;
    - parameters: the largest insert, magnet or pin that fits, two of them when two fit, otherwise one.
    With `needs` unknown, it assumes a medium load and occasional disassembly and says so in its first reason (尚未得知負重與拆裝需求，先假設中等負重、偶爾拆裝。).
42. A new joint, from any path, starts with the top recommendation as its method and `confirmed: false`.

### Printable geometry (CSG)

43. A `printablePart(part, features)` function returns the part's printable solid in its local frame, in millimetres (the unit slicers expect; the CSG also works better at that scale than in metres): the primitive built from its analytic description (not the display geometry), minus the holes and pockets, plus the bosses. The result is a closed two-manifold mesh that a slicer accepts. It runs in the browser and in Node, so unit tests can check it.
44. The CSG library is the one new runtime dependency. It must: have a permissive licence (MIT or Apache-2.0), install without a native build, run in Node 22 and in the browser through Vite, load nothing from the network at run time (its assets are bundled), produce or verify manifold output, and be loaded lazily so the first page load does not grow. Its version is pinned and it is credited in README. Design compares `manifold-3d` and `three-bvh-csg` against these points (decision 6).
45. Unit tests check, for a box, a cylinder and a shell (when it exists): the result is manifold; its volume equals the analytic volume minus the features plus the bosses within 1 %; an M3 insert hole has the expected diameter and depth.
46. Features that cannot be applied (an error from requirement 39) are left out, and the function reports which ones; it never throws for a valid part.

### Scene

47. Each joint draws, on both parts: the outline of the contact region and a marker for each feature at its real diameter and depth (for example a translucent cylinder with a ring at the face). Markers are children of the part's scene node, so they follow moves, previews and the exploded view. Their colour differs from the part-edge cyan (`#69eaff`), the selection amber (`#ffc53d`) and the hand colours; a joint with an error uses a dashed outline, so colour never carries the state alone.
48. A 顯示接合 switch shows or hides all joint drawings; it is on by default and is session state.
49. **列印件預覽.** From the joint card, the user can preview one side's part as it will be printed: the part's display is replaced by its `printablePart` result until the preview is closed or the workspace changes. While it is built the card shows 正在產生列印件預覽…; a failure shows a notice and changes nothing. The preview never runs during a gesture, and its Three.js resources are disposed with `disposeObject`.
50. The canvas exposes for tests: `data-joint-count`; `data-joints-json` (the workspace's joints); `data-snap` (`none` or `ready`, during a hand or mouse join); `data-print-preview` (the previewed part's `{objectId}:{partId}`, or empty).

### Joining with the mouse and the panels

51. A 接合 panel in the control column lists every joint as 「{object name}・{part name} ↔ {object name}・{part name}」 with its method label and its state in text and icon: 待確認, 已確認 or 有問題 (any error). Clicking a joint opens its card. A 新增接合 button starts a mouse join.
52. **Mouse join.** Step 1: the user clicks a part; a part without contact faces gives the notice 這個零件沒有平面可以接合。 Step 2: the user clicks a part of another object (or, with decision 1, another part of the same object). The faces are the best facing pair of the two parts (requirement 23), so the user never has to aim at a face that may point away from the camera; 換一組面 steps through the other facing pairs in rank order, and two parts without one give 這兩個零件沒有可以接合的平面。 and the flow returns to step 2. If the faces touch, or can be aligned (requirement 24; requirement 27 for parts already in one object or one assembly), side b's object and its assembly are shown at the aligned pose with the same cue as the hand path (requirement 58) and `data-snap="ready"`; 確認接合 commits it through `joinObjects` as one undo step and opens the card; 取消接合 or Esc puts everything back.
53. During a mouse join, clicks pick parts for the join instead of selecting them, the gizmo is off, and the flow is cancelled by Esc, by an agent run starting, or by any other workspace change. While an agent run is active, 新增接合 and the card's controls are disabled with the other manual controls (the existing `agentActive` gate).

### Joint card

54. The joint card shows: the two sides (object, part and face labels); the recommendation with its reasons; 負重 (輕 / 中 / 重 / 未指定) and 拆裝 (不拆 / 偶爾 / 經常 / 未指定) selects; a 固定方式 select (熱壓螺母＋螺絲, 磁鐵, 定位銷, 膠合) with that method's parameters; the derived values, read-only (for example 「M3×8 螺絲 ×2、M3 熱壓螺母 ×2、孔徑 Ø4.2 mm」); the findings of requirement 39, each with an icon and text by severity; and the buttons 確認方式, 重新對齊 (only while the faces are apart), 列印件預覽 (one per printed side), 請代理建議 and 刪除接合.
55. **Confirming.** 確認方式, or any change of the method or its parameters in the card, sets `confirmed: true`. Changing 負重 or 拆裝 on an unconfirmed joint replaces the method with the new top recommendation; on a confirmed joint it keeps the method, and when the new top recommendation differs the card shows 改用建議 to switch to it. Each of these is one undo step.
56. The card opens by itself after a join from any path, with the notice 已接合「{a}」與「{b}」，請確認固定方式。
57. 請代理建議 sends the agent the instruction 請幫我為接合「{a}」↔「{b}」選擇固定方式，先問我負重和拆裝需求。 through the existing agent panel. It is disabled while an agent run is active.

### Joining with two hands

58. **The cue.** While a join is ready: both contact regions glow, side b's object is shown at its aligned pose (it visibly snaps into place, like a magnet), a label 可以接合 sits at the contact region, and for the hand path the joining hand's badge reads 手勢：可以接合. The cue is shown by shape and text as well as colour. When not ready, nothing snaps and the label is absent.
59. **The join row.** `hand-manipulation`'s join rule gains one row: owner gesture `hold` (a fist holding object A) and a joining **fist** whose palm is over a part of **another** object B, not in A's assembly → `assemble`, at gate `full` only. A fist on the same object or on an object of A's assembly, on empty space, or at any other gate stays inert (`hand-manipulation` requirement 81). With `FIST_ENABLED = false` there is no assemble.
60. **Both hands move.** Unlike the other two-hand gestures (`hand-manipulation` requirement 84), the owner's hold does not freeze: the owner's fist moves A's assembly and the joining fist moves B's assembly, each with the hold mapping of `hand-manipulation` requirement 92. Any fist hold, also outside a join, previews the whole assembly of the held object (requirement 87). Snap detection (requirements 23 and 25) runs on the two previewed poses at most once per tracking frame; side a is the owner's object and side b the joiner's.
61. **Release.** When either fist opens, the assemble gesture ends for both hands. If the snap is ready: one commit through `joinObjects`: A's moved position, B's aligned transform (each moving its assembly) and the new joint (requirement 42), as one undo step; the card opens (requirement 56). If not ready: the moves of both objects are committed as one undo step, or nothing when neither moved, and no joint is created. The fist still closed is inert until it opens.
62. **Loss and cancel.** If either hand is lost for longer than `TRACKING_LOSS_MS`, or any cancel reason of `hand-manipulation` requirement 39 applies, both holds follow `ON_TRACKING_LOSS`: `'cancel'` puts both objects back; `'keep'` commits both moves as one undo step. A joint is never created on loss or cancel.
63. Overlay and debug: `data-gesture` is `assemble` during the gesture; the joiner's state is `hold` with the badge 手勢：握住 {object name} until ready; `?hands=debug` adds the snap gap in mm, the angle, the overlap in mm² and a join counter. No assemble step sends anything to the server.

### Agent

64. Four new server tools, project scope, local (no model call), with Traditional Chinese labels:
    - `create_joint({ a: { objectId, partId?, face? }, b: { objectId, partId?, face? } })`, effect `writes-scene`, label 建立接合: uses the given faces, or the best facing pair of requirement 23 between the two objects (or parts); aligns side b's object, with its assembly, onto side a when the faces do not touch (requirement 24; requirement 27 inside one object or one assembly); adds the joint with the top recommendation. One tool call is one object transform plus one joint. It does not change the active object, because a joint belongs to two objects. It returns the joint id, the recommendation with reasons and the findings. Errors: `UNKNOWN_OBJECT`, `UNKNOWN_PART`, `NO_CONTACT_FACE`, `CANNOT_ALIGN`, `JOINT_LIMIT`.
    - `update_joint({ jointId, load?, disassembly?, method?, confirmed? })`, effect `writes-scene`, label 設定接合: sets the needs and/or the method (a full `JointMethod`), and returns the new recommendation and findings. `UNKNOWN_JOINT`, `INVALID_ARGS`.
    - `remove_joint({ jointId })`, effect `writes-scene`, label 移除接合.
    - `set_material({ objectId, material })`, effect `writes-scene`, label 設定材料; `material` may be `null`.
65. `get_project_state` adds each object's material to its summary, and a short list of joints (id, the two sides with names, method, needs, confirmed, finding codes). The per-round state snapshot lists joints in the same short form. `WorkspaceChange` gains an optional, nullable `joint` change (`add`, `update` or `remove`) and `ObjectChange` gains a `material` op, so one tool call changes at most one object and one joint; existing payloads without the new key stay valid. The browser applies them with the shared operations of requirement 5, each `state` event with a change being one undo step, as in `workspace-v2` requirement 47.
66. `AGENT_INSTRUCTIONS` says, in English: the four methods are the only ones; when `load` or `disassembly` is unknown, ask the user about both before recommending; explain a recommendation with the reasons the tools return and do not invent numbers; pass `confirmed: true` only when the user chose or accepted the method in the conversation; snap-fits and moving joints are not supported yet (PLA is too brittle for snap-fits); never suggest welding for printed parts; metal to plastic is fastened mechanically; tolerances come from the user's printer profile, which the agent cannot change; `set_transform` on a jointed object moves its whole assembly, and an object leaves its assembly only when its joint is removed.

### Interface for the export spec

67. These pure, documented functions are exported for `export`, each with unit tests: `jointFeatures` (requirement 29), `checkJoints` (requirement 39), `printablePart` (requirement 43), and:
68. `jointBom(workspace, profile)`: the standard parts to buy, aggregated across joints, each `{ kind: 'screw' | 'insert' | 'magnet' | 'pin' | 'glue', standardId, label, quantity, jointIds }` with a Traditional Chinese label such as 「M3×8 內六角螺絲（ISO 4762）」 or 「6×3 mm 圓形磁鐵」. Glue is one item per glue type, with no quantity unit beyond 1.
69. `assemblyNotes(workspace, profile)`: one Traditional Chinese instruction per joint, in a stable order, for example 「將 2 顆 M3 熱壓螺母壓入「錶殼」，再以 2 支 M3×8 螺絲鎖上「錶帶」。」.
70. `assemblyOf(workspace, objectId)` (requirement 84): the ids of all objects connected to the object through joints. `setTransform` uses it to move assemblies (requirement 85), and `export` and `body-fit` use it to treat an assembly as one unit.
71. These functions never call a model, the network or the DOM; `printablePart` is the only one that needs the CSG library.

### Compatibility

72. With no joints and no materials set, the workbench looks and behaves as today, except for the new 接合 and 列印設定 panels, the 材料 select and the 顯示接合 switch.
73. Every existing e2e spec passes unchanged. Existing unit tests change only where they assert the workspace version, the exact shape of a workspace, object or tool detail (including fixtures typed as `Workspace` or `SceneObject`, which gain `joints: []` and `material: null`), or the list of registered tools (which this spec extends). If any other existing test needs a change, the task stops and reports instead of editing it.
74. `/api/generate`, `/api/edit`, `ModelSpec`, `Part`, the provider adapters and their tests stay untouched.

## Non-functional requirements

75. `shared/` stays the single Zod authority: the joint, material and profile schemas, the migration, the operations, the standard-parts table and all local rules (contact, snapping, features, checks, recommendations, BOM, notes, assemblies) live there, use only Three.js math classes, and are used by both server and browser. `printablePart` lives outside `shared/`, because it needs the CSG library.
76. **Speed.** Snap detection for two objects of 64 parts runs within a budget that design states and that keeps hand tracking above `MIN_CONTROL_FPS` on the user's laptop; checks and features for a full workspace are recomputed only when the workspace or the profile changes. CSG runs only on demand (requirement 49) and in `export`, never during a gesture.
77. **Privacy and security.** Unchanged: the camera image and landmarks stay in the browser, nothing about joints is logged, the server stays loopback-only, and the CSG library makes no network request.
78. **Resources.** Joint drawings and previews are disposed with `disposeObject` when they change or unmount; the CSG module frees its own memory (for example WASM objects) after each call.
79. **Tests.** Every task has Vitest unit tests; pure modules and `printablePart` are tested in Node; no jsdom or happy-dom is added. Tests never call a real model back end. E2E tests cover the mouse join, the card (method change, confirm, undo), the 材料 select, the profile panel (values kept after a reload), a routed agent stream that creates a joint, and a fake-fist assemble with `tests/e2e/fake-hands.ts`; none needs a webcam.
80. `npm run check` (type check + build + unit tests) passes before a task is marked done, and the real result is reported.
81. Spec, design, task files and code comments are English; user-facing strings are Traditional Chinese, with no mixed languages on one screen (material abbreviations such as PLA and standard designations such as M3 and ISO 4762 are names, not English UI).
82. README gets a short "assembly joints" section: the four methods, materials, the printer profile and the test-piece note, the mouse and two-hand joins, and the credit for the CSG library. The project still installs and runs from the README alone.
83. `tasks.md` has at most 6 tasks, each small enough for one fresh Kiro session with Claude Sonnet 5.5, with "Read first", "Build", "Tests", "Done when" and "Session facts" as in `workspace-v2`, and a cut order. The two-hand task comes last, because it depends on `hand-manipulation` Task 7. The last task ends with a short manual check list: the two-fist join on the user's webcam, and, if time allows, one real print of a joint with the default profile. `design.md` maps every requirement to a task.

## Dependencies on other specs

- **hand-manipulation** (phase C, Tasks 3–9 open). The two-hand join (requirements 58–63) needs its Task 7: fists, hold sessions that do not refuse a second hold (its design §7.4), the join rule that receives the joining hand's input and target (its requirement 82, design §5.4), and `onObjectMove`. This spec changes two things there: for `assemble` only, the owner's hold keeps moving (requirement 60); and every hold session previews the whole assembly (requirement 87). Until this spec's two-hand task lands, a fist move previews only the held object, and the rest of its assembly follows on release, because the commit goes through `setTransform`. If its Task 7 is cut, the two-hand join is cut too, and the mouse join and the agent remain.
- **design-fidelity** (phase C). The `shell` primitive is a contact face source (requirement 21), limits feature depth to the wall, and puts bosses on the inner wall (requirement 33). Without it, every part is solid and those rules simply never apply. Both specs share the standard-parts module (requirement 16).
- **export** (phase C). It calls requirements 67–71 and should not start its per-part files before this spec's Tasks 1–3 land. It owns the STL and 3MF files, the BOM file, the assembly sheet and, if wanted, the tolerance test piece.
- **body-fit** (phase C). An assembly of two objects (a case and a strap) should be worn as one; `assemblyOf` (requirement 70) gives the set.

## How later specs fit (not built here)

- **export:** per-part STL from `printablePart`, a 3MF with every part, `jointBom` as CSV or Markdown, `assemblyNotes` and an exploded image for the assembly sheet. Metal parts and bought components are listed, not printed. A tolerance test piece can reuse the feature rules (one hole per fit class) and `printablePart`.
- **Rotating an assembly by hand:** fists only move; an assembly rotates through the 物件 panel or `set_transform`, which already rotate it as one rigid body.
- **Snap-fits, hinges, sliders:** new `JointMethod` kinds; the material table already records flexibility and PLA's brittleness.
- **Per-part materials:** an optional override per part, if real designs need two materials in one object.
- **materials-analysis:** adds density and price to the material table; mass per part uses `printablePart` volumes.
- **projects-memory:** saves a version-2 workspace; `migrateWorkspace` is the place for later versions.
- **english-ui:** the material, method, face, finding and BOM labels are plain string tables.

## Decisions from review

The decisions were reviewed on 2026-11-19. The requirements above reflect the outcome.

1. **Accepted: joints between two parts of one object**, through the mouse join and the agent only, and only where the faces already touch (requirement 27). `export` writes one print file per part, so a case and a lid in one generated object need a fixing too.
2. **Accepted: one material per object; interior parts are bought components** (requirements 11–12). Mixed materials (a TPU strap on a PLA case) become two objects, which matches the two-hand demo. Per-part materials are a later option.
3. **Changed: joined objects move together.** The draft recommended that a jointed object keep moving alone and report 已分開. The user decided instead that any move of an object (a fist, the 物件 panel, the agent's `set_transform`) moves its whole assembly (`assemblyOf`) as one undo step, so a normal move never separates a joint. `setTransform` itself does it, so every move path and both the browser and the server get the same result (requirements 84–88). 已分開 and 重新對齊 remain only for what can still break alignment: an edit inside a model that moves a contact face (requirement 88).
4. **Accepted: the printer profile is a browser setting, not workspace data**, and the agent request carries it (requirements 19–20). It belongs to the printer and must survive a reload while workspaces are not saved yet.
5. **Accepted: tolerances are per side, and every printed hole also gets a hole compensation** (requirements 17–18), with the defaults 0.25 / 0.10 / 0.20 / 0.20 / 0.05 mm. The reviewer checks the numbers before Task 1 is accepted.
6. **Accepted: `manifold-3d`, pinned to a version without dependencies (3.2.1 or earlier), over `three-bvh-csg`.** Both are permissively licensed (Apache-2.0 and MIT). `manifold-3d` is built for guaranteed manifold output, which slicers need, builds the primitives itself, runs in Node and the browser, and adds about 0.6 MB (JS + WASM) loaded only on demand; versions from 3.3 on pull in build tools (esbuild-wasm, glTF-Transform) as dependencies. `three-bvh-csg` is pure JS and small, but its README warns that results may not be fully two-manifold and that inputs must be two-manifold, which Three.js's `BoxGeometry` and `CylinderGeometry` are not without welding. The CSG task starts with a spike that confirms the size and the Vite and Vitest loading.
7. **Accepted: features are drawn as markers; real CSG only on demand** (requirements 47–49). Markers are cheap and always current; one on-demand 列印件預覽 proves the CSG path in the browser before `export` relies on it. If time runs short, the preview is the first cut; the markers stay.
8. **Accepted: flat faces only** (requirement 21). Spheres, tori and the sides of cylinders cannot be jointed yet, and tube caps take glue only.
9. **Accepted: side b moves; side a stays.** On a join only the second object (the joining fist's, the second click's, or the agent's `b`) is aligned, with its assembly, and only by a small rotation (at most `SNAP_ANGLE_DEG`). Larger rotations go through the 物件 panel or `set_transform` first.
10. **Accepted: the agent may confirm a method** only when the user chose or accepted it in the conversation (requirement 66), so a voice-only user can finish a joint.
11. **Accepted: inserts from one named vendor** (CNC Kitchen standard M2×3 and M3×5.7) as the default, named in the BOM, because insert hole sizes differ between vendors.
12. **Accepted: TPU in the material list**, for straps; its checks steer away from inserts and glue.
13. **Accepted: releasing either fist ends the two-hand join** (requirement 61); without a ready snap both moves are committed as one undo step.

## Changes while writing the design (2026-11-19)

Small changes made while writing `design.md`, after the review:

- **The mouse join picks parts, not faces** (requirement 52). The two faces that meet between two objects usually point at each other, so one of them faces away from the camera and cannot be clicked. The user clicks two parts; the best facing pair is chosen (the facing-pair rule added to requirement 23), and 換一組面 steps through the others. The cancel button is named 取消接合, so it cannot match selectors for 取消選取 or 取消這次生成.
- **`printablePart` returns millimetres** (requirement 43), the unit slicers expect; features stay in metres like the models (requirement 29).
- **The hole below an insert continues for `SCREW_TAIL_MM`, or through the part** (requirement 31). Without it, no standard M3 length fits between the minimum engagement and the end of a 5.7 mm insert with a 2 mm clamp.
- **`create_joint` does not change the active object** (requirement 64), because a joint belongs to two objects.
