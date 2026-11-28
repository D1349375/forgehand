# Workbench UI: a full-screen workbench, the parts tray and objects as groups — Requirements

> Status: draft for review, 2026-11-26. Written from `docs/VISION.md` §4.9 (notes "Updated 2026-11-22" and "Updated 2026-11-23/25") and the code on `main` at `ab8d750`. The numbered decisions at the end need the user's answer before `design.md` and `tasks.md` are final; both already follow the recommendations.

## Overview

The workbench today is a web page with two columns (`src/App.tsx`, `src/styles.css`): a 3D and camera view of fixed height (`.viewport`, `clamp(440px, 58vh, 760px)`) with a toolbar under it, and a 365–390 px control column with eight panels stacked in a long scroll (export dialog, 代理, the prompt panel, 物件, 接合, 列印設定, 零件, 模型與假設). On the user's first webcam test (VISION §4.9, 2026-11-22) two problems showed: the camera view is small next to the panels, and the second 載入示範模型 button (a text link under the service status at the bottom of the prompt panel, `.demo-link`) is hard to find. On the retest (2026-11-23/25) the user found joining whole objects too coarse: a generated design is one object, and its parts could only be joined with the mouse when their faces already touched.

This spec turns the page into a **full-screen workbench** and makes **an object the group**:

- The camera video and the 3D scene fill the window. A thin top bar (the **HUD**) and a status bar stay visible; every panel lives in a **dock** at the side and appears only when it is needed, and the user can dismiss it. The agent can place **data cards** (a part's size, a distance, a joint's state) onto the video.
- A **parts tray** at the bottom lists the active object's parts as cards. Clicking or pinching a card selects the part for fine adjustment; dragging a card up into the scene, with the mouse or a pinch, **pulls the part out**.
- **Object = group.** Every part belongs to exactly one object. Pulling a part (with its child parts) out makes a new object next to the original, in one undo step. **Joints connect objects**; removing a joint separates them and never merges them back. Hands only pull parts out (from the tray) and join (two pinches or two fists, already built); there is no gesture that removes a joint or ungroups.
- The demo model is easy to find: exactly one 載入示範模型 button is always on screen.

**Numbering.** Requirement numbers are stable ids (R1, R2, …), because `design.md` and `tasks.md` refer to them. Sections of other specs are written as "HM R27" (`hand-manipulation`), "AJ R27" (`assembly-joints`), "EX R6" (`export`) and "WS R61" (`workspace-v2`).

## Goals

- The camera image and the model use the whole window; panels never shrink or move the 3D view.
- The user sees at a glance what they can do, and nothing else: each panel opens when the work needs it, by itself or on request, and closes when dismissed.
- Every part of a design can become its own object, so it can be printed separately, given another material, and joined to the rest with a real joint.
- The hands do two grouping actions only, pulling out and joining; everything that undoes a grouping is a deliberate mouse, keyboard or agent action.
- Every existing feature stays reachable (gestures, try-on, export, joints, agent, undo), and the e2e suite keeps passing.
- Other specs (`design-fidelity`, `body-fit`, `english-ui`) have named places in the layout and a string convention, so they plug in without reworking it.

## Out of scope

Only items `docs/VISION.md` places in other specs or later:

- English strings and the language switch (`english-ui`, C16). This spec reserves the switch's place in the HUD (R4) and writes its strings so they can be moved (R86).
- The W×D×H readout, the 概念尺寸 badge and the fit-check notices (`design-fidelity`, C18), and the fit panel and the fit map (`body-fit`, C10). This spec gives them slots (R6, R11, R62, R70); their content is built there.
- The candidates tray of thumbnails for several generated designs (C3, cut 2026-11-19) and floating project cards (C17, cut 2026-11-19).
- Voice (C15).
- Pulling a part out *for display only* while a fist holds the object (VISION §5 "After": "pulling a part out by hand"); this spec's pull-out changes the data.
- Snap-fits, hinges and moving joints (C9, P2).

## Functional requirements

### Layout

1. **Full-screen stage.** The camera video and the 3D canvas fill the browser window. The element with `data-testid="viewport"` covers the window and keeps the `video.camera-video` (aria-label 即時攝影機背景), the shade and the `SceneViewport`. The canvas size never changes when a panel opens or closes, so `SceneViewport`'s `ResizeObserver` re-frames only on a real window resize. At widths of 801 px and more the page itself never scrolls; docks scroll inside themselves.
2. **Layers.** From back to front: the stage (video, shade, canvas); the data cards (R61); the HUD, the docks, the status bar and the tray; the drag ghost of a card being pulled out (R33); the hand overlay (`HandOverlay`, `pointer-events: none`), so the skeletons are drawn over every panel the hand can reach.
3. **Zones.** The window is divided into named zones: the **HUD** (top), the **left dock** (the agent, R20), the **right dock** (every other panel, R19), the **status bar** and the **tray** (bottom), and the **free area** (what remains: the part of the scene that no zone covers). Zone sizes are CSS custom properties in one place, and one pure function computes the zone rectangles from the element boxes, for framing (R8), the drop rule (R34) and the data cards (R64).
4. **Always visible.** These stay on screen whenever they apply, regardless of panels:

   | Element | Contents | When |
   |---|---|---|
   | HUD, first row | brand; object caption (R6); panel toggles (R15); the language switch slot of `english-ui` | always |
   | HUD, second row (toolbar) | 開啟攝影機 / 取消開啟 / 關閉攝影機, 護臂試戴 / 結束護臂試戴, 手勢, 隱藏鏡頭畫面, 提高背景對比; 復原, 重做; 縮小, 放大, 重設視角; 爆炸圖 / 收回爆炸圖 and 拆開程度; 匯出套件; 載入示範模型 (R25) | each control under the same conditions as today (for example 手勢 only while the camera is on) |
   | Agent bar (R20) | 任務指示, 執行, 取消, the agent status line | always |
   | Status bar (R7) | the workbench message, hand status, try-on status, errors, hints | always |
   | Parts tray (R27) | the active object's parts | while there is an active object |
   | Data cards (R61) | cards the agent placed | while any exist |
   | Hand overlay | skeletons and badges | while the camera and 手勢 are on (as today) |

5. **Empty workspace.** With no objects and no try-on, the free area shows the start message (讓第一個想法成形 and its two lines), the 載入示範模型 button (R25) and the privacy line 攝影機只在本機顯示；生成與修改服務接收你的文字與目前模型資料。 The tray is hidden, and the 生成與修改 panel is open (R13).
6. **Object caption.** With an active object, the HUD shows the source label (示範資料 · 非 AI 生成, or the provider, plus · 已修改), the model name (`data-testid="model-name"`), the part count, the selection and the object count, as `.model-caption` does today. The caption component takes an `extras` slot that `design-fidelity` fills with the W×D×H readout and the 概念尺寸 badge.
7. **Status bar.** One bar above the tray shows, top to bottom: the workbench message (today's `.generation-status`, `role="status"`, with the elapsed seconds while a request runs and 取消這次生成 / 取消這次修改 next to it); the hand status line (`data-testid="hand-status"`); the try-on status and its numbers (`try-on-status`, `try-on-stats`); camera and render errors (`role="alert"`, as today); and the hint line 拖曳旋轉 · 滾輪縮放 · 點擊選取（Shift 加選） with 概念視覺化 · 非工程量測或製造驗證. Pull-out results and refusals use the workbench message (R35), so this spec adds no `role="alert"` element.
8. **Framing in the free area.** The automatic framing and 重設視角 frame the objects inside the free area, not the whole canvas, so no part starts hidden under a dock or the tray. The camera's projection is shifted so the orbit target projects to the free area's centre (`PerspectiveCamera.setViewOffset`), and the distance fits the free area's width and height. The shift is set only when the view is framed; opening or closing a panel never moves the camera. Picking, `projectPart`, `projectFace`, `hitTest` and the export's `viewDirection` stay consistent because they all use the same camera.
9. **Narrow windows.** At 800 px and less, the left and right docks become one bottom sheet above the tray (at most 55 % of the window height, scrolling inside), the HUD rows wrap, and the page never scrolls sideways (the existing 390 × 844 test). The scene stays visible above the sheet.
10. **Decorative elements removed.** These carry no feature and are dropped: the phase label 第二階段 / 選取 · 調整 · 文字修改, the heading LIVE WORKSPACE / 把想法，放進視野。, the stage label 虛擬展示位置 CONCEPT / 01 (during try-on the try-on status says 護臂試戴), and the footer row. Their information moves: the camera state is the camera button's text and a dot beside it; the disclaimer and the privacy line move to the status bar (R7) and the empty workspace (R5), and the privacy line also to 詳細資料. Decision 15.

### Panels

11. **The panels.** Each panel is one region with a heading, a close button and the content it has today:

    | Id | Title and toggle | Dock | Content |
    |---|---|---|---|
    | `agent` | 代理 (expands and collapses the agent panel, R20) | left | `AgentPanel` |
    | `create` | 生成與修改 | right | today's prompt panel: the 修改目前模型 / 生成新物件 tabs, both forms, the object-limit notice, 重試, 需要確認, the edit summary, 修改衝突, 近似方案待確認, the service status |
    | `part` | 零件 (the toggle is shown only while parts are selected) | right | today's part editor: 零件名稱, 零件顏色, 尺寸 / 位置 / 角度 X Y Z, 拖曳移動, 拖曳旋轉, 刪除零件, 取消選取, the rejection notice; plus 拉出成新物件 (R32) and the `notices` slot of `design-fidelity` |
    | `objects` | 物件 | right | `ObjectPanel` |
    | `joints` | 接合 | right | `JointPanel` with the open `JointCard` |
    | `printer` | 列印設定 | right | `PrinterPanel` (`data-testid="printer-panel"`), shown open instead of as a collapsed `<details>` |
    | `details` | 詳細資料 | right | today's 模型與假設: summary, source, model, units, timing, assumptions, the part list with sizes; plus the privacy line and the `checks` slot of `design-fidelity` |
    | `export` | 匯出套件 (the existing toolbar button) | right | `ExportDialog`, unchanged |
    | `hand-debug` | 手勢除錯 (the toggle exists only with `?hands=debug`) | floating above the tray, right | `HandDebugPanel` |
    | `fit` | reserved for `body-fit` | right | the fit panel of `body-fit` |

12. **One panel model.** Which panels are open, and whether the agent panel is expanded, is session state held in one pure state machine (no React, no DOM), so every rule below is unit-tested. It is never part of the workspace and never an undo step.
13. **Opening by itself.** A panel opens by itself only on the change listed here (an edge, not a level), and an auto-open never moves the keyboard focus:

    | Panel | Opens by itself when | Closes by itself when |
    |---|---|---|
    | 生成與修改 | the page starts with an empty workspace; the workspace becomes empty; a generate or edit request ends with something to answer (an error with 重試, 需要確認, 修改衝突, 近似方案待確認) | never |
    | 零件 | the selection goes from empty to non-empty (a click in the scene, a tray card, a pinch, the agent's `select_parts`) | the selection becomes empty |
    | 物件 | the object count goes from 0 or 1 to 2 or more | the workspace becomes empty |
    | 接合 | the object count goes from 0 or 1 to 2 or more; a joint is added (any source); a joint card is opened; a mouse join starts | the workspace becomes empty |
    | 列印設定, 詳細資料 | never | never |
    | 匯出套件 | 匯出套件, or the agent's `prepare_export` (as today) | 關閉匯出, Esc, an empty workspace (as today) |
    | 手勢除錯 | hand control turns on while the URL has `?hands=debug` | hand control turns off |
    | 代理 (expanded) | a run starts (執行, 請代理建議), or a reply or an error arrives | never |

14. **The user's close wins.** A panel the user closed stays closed until its next opening edge (R13) or the user opens it again.
15. **Mouse.** Each panel has a toggle in the HUD's first row: a button with `aria-expanded` and `aria-controls`, named by the panel title (R11). Each panel heading has a close button named 關閉生成與修改, 關閉零件面板, 關閉物件面板, 關閉接合面板, 關閉列印設定, 關閉詳細資料 and 關閉手勢除錯 (the export dialog keeps 關閉匯出; the agent panel collapses with its toggle).
16. **Keyboard.**
    - The focus order is HUD → left dock → right dock → status bar → tray.
    - Enter or Space on a toggle opens or closes its panel. Opening a panel from its toggle moves the focus to the panel heading; closing it from its close button or Esc returns the focus to the toggle (for 零件, to the selected tray card).
    - **Esc**, in this order: ends a running card drag (R33); else ends a running mouse join (as today); else, when the focus is on a button or the heading inside a panel or a data card, closes that panel or card (focus inside a text field keeps today's meaning: the field handles it); else clears the selection and the drag mode (as today).
    - **/** (slash), when the focus is not in a field, expands the agent panel and focuses 任務指示.
17. **Hand.** The panel toggles in the HUD are on-screen targets (HM R22): a pinch tap on a toggle presses it (HM R27), at hand-control level `full` or `view-only`, as for any on-screen target. Controls inside panels are not hand targets (decision 11).
18. **Agent.** The agent tool `show_panel` (R71) opens or closes 生成與修改, 物件, 接合, 列印設定, 詳細資料 and, once `body-fit` adds it, `fit`. The 零件 panel follows the selection, the export panel follows `prepare_export`, and the agent panel and 手勢除錯 are the user's.
19. **Right dock.** Open panels stack in a fixed order (匯出套件, 生成與修改, 零件, 物件, 接合, 列印設定, 詳細資料, `fit`) between the HUD and the status bar, and scroll inside the dock. A panel that opens by itself is scrolled into view inside the dock without moving the focus. The dock is as wide as the control column today (365 px; 390 px from 1500 px; 320 px from 1100 px down).
20. **Agent panel.** The agent panel stays in the left dock and never disappears. **Collapsed**, it shows 任務指示, 執行, 取消 (while running) and the agent status line; **expanded**, it also shows the intro, the progress log, the reply and the error, as today. `data-testid="agent-panel"`, `agent-log`, `agent-reply`, `agent-error`, `agent-blocked` and the status inside the panel stay. It expands by itself (R13) and collapses with the 代理 toggle or Esc.
21. **Mouse join and the 接合 panel.** A mouse join starts and runs inside the 接合 panel as today. Closing the 接合 panel ends a running mouse join (as 取消接合 does). The rule that pinned the canvas in view during a mouse join (`.workspace:has(.mouse-join-status) .viewport { position: sticky }`) is removed, because the canvas is always in view.
22. **Export dialog.** `ExportDialog` keeps its behaviour, names and test attributes (EX R51–R55) and moves from the top of the control column to the top of the right dock.
23. **Closed panels are not rendered** (except the agent panel), so their React work stops. State that must survive a close already lives in `App` (the prompt, the instruction, the selection, the joint card id) or in the printer store.
24. **Hand debug.** `HandDebugPanel` keeps `data-testid="hand-debug"` and its polling (twice a second, no render per frame), and floats at the right above the tray, outside the right dock, so it never covers the panels.

### The demo model

25. **Exactly one 載入示範模型.** At any time there is exactly one button whose name starts with 載入示範模型: in an empty workspace the one in the start message (R5), named 載入示範模型; otherwise one in the HUD toolbar, named 載入示範模型 非 AI 生成 like today's link (the 非 AI 生成 part is a smaller tag inside the button). The link under the service status is removed. Both are disabled while an agent run is active or the workspace is full (`MAX_OBJECTS`), as today.
26. Both are on-screen targets for the hands (R17): a pinch tap loads the demo.

### The parts tray

27. **What it shows.** While there is an active object, the tray (a region named 零件匣) lists every part of the active object, in model order, as cards in a list named 零件清單. It replaces today's part list in the 零件 panel (`.part-picker`), so there is still one 零件清單 on screen.
28. **A card** shows the part's colour, an icon of its primitive (box, sphere, cylinder, cone, torus, tube), its name, 屬於 {parent name} for a child part, its size 寬 × 高 × 深 in mm (one decimal, from `dimensions`), 內部 for `role: 'interior'`, and 含 {n} 個子零件 when it has descendants. Part ids are not shown (they stay in `data-part-id`). The card's accessible name starts with the part name, so the existing selectors (`/側邊電池/`, `/^外殼/`, `/展示支架/`) keep working.
29. **Selecting.** A click selects the card's part exactly as today's list does (`pick(activeObjectId, partId, shiftKey)`, `pickPart`): alone, or added and removed with Shift. The selected card has `aria-pressed="true"`, an outline and a check mark, so colour is never the only signal. During a mouse join a click picks the part for the join instead (as today). While an agent run is active every card is disabled (as today).
30. **Keyboard.** The tray list is one tab stop with a roving focus: ← and → move between cards, Home and End jump to the first and last; Enter or Space selects; Shift+Enter or Shift+Space adds or removes. The tray scrolls to keep the focused card visible.
31. **Scrolling.** When the cards do not fit, the tray scrolls sideways (wheel, touchpad) and shows 上一組零件 and 下一組零件 buttons at its ends that scroll by one tray width.
32. **Fine adjustment.** Selecting a part opens the 零件 panel (R13) with today's fields and buttons; the gizmo stays explicit through 拖曳移動 and 拖曳旋轉 (decision 12). With exactly one part selected the panel also has **拉出成新物件**, the keyboard and single-pointer way to pull out (WCAG 2.2 SC 2.5.7). It is disabled, with the reason as its description, when the part cannot be pulled out (R43).
33. **Mouse drag.** Pressing on a card and moving at least `TRAY_DRAG_START_PX` (8 px) starts a drag: the card's part is selected (as a hand grab selects first: `HandController.onEngage` calls `port.select` before `beginGrab`), a ghost of the card follows the pointer, and the ghost says 拖到畫面上放開 or, over the drop zone (R34), 放開即可拉出. Releasing in the drop zone pulls the part out (R40); releasing anywhere else, Esc, or a cancelled pointer puts the ghost back and changes nothing. A drag is not possible while an agent run or a mouse join is active, or for a part that cannot be pulled out; it is possible in the exploded view.
34. **Drop zone.** A point is in the drop zone when it is inside the free area (R3) and at least `PULL_OUT_MIN_PX` (48 px) above the tray's top edge. One pure function decides it, for the mouse and the hand.
35. **Feedback.** A pull-out shows its result in the workbench message (R7):
    - 已把「{part}」拉出成新物件，放在「{original}」旁邊，可按「復原」回到上一步。
    - 已把「{part}」拉出成新物件；它和其他零件的接合保留，會一起移動。可按「復原」回到上一步。 (in place, R42)
    - with child parts, 「{part}」 reads 「{part}」（含 {n} 個子零件）.
    - A refusal shows the fixed message of R43, and the ghost goes back.
36. **Hand.** Each card is a **draggable** on-screen target, which amends HM R27 ("a drag that starts on an on-screen target does nothing") for draggable targets only:
    - a pinch tap on a card selects its part, as a click;
    - a pinch that starts on a card and moves past the drag dead zone (`DRAG_DEAD_ZONE_PX`) **carries** the card: the part is selected, the ghost follows the hand cursor, and the badge says 手勢：拉出 {name} (手勢：放開拉出 {name} over the drop zone);
    - opening the pinch in the drop zone pulls the part out; anywhere else it puts the card back. The ghost freezes the moment the hand starts to open, as a grab does (HM Task 10), so the opening motion cannot move the drop point;
    - losing the hand during a carry puts the card back, as a lost drag does (`TRACKING_LOSS_MS`, `ON_TRACKING_LOSS`, HM R37);
    - carrying is allowed when a fist may hold (`fistAllowed`: hand control `full`, or `view-only` because the exploded view is open); a tap still selects whenever pressing is allowed;
    - while a carry runs, a second hand is inert (the join rule has no row for a press owner, `joinGesture`);
    - the overlay shows the carrying hand as grabbing (`data-hand-state="grab"`, target `screen:{id}`) and the gesture `carry`.
37. The tray's 上一組零件 and 下一組零件 buttons are on-screen targets too: a pinch tap scrolls.
38. **Reach.** Cards are at least `TRAY_CARD_MIN` (96 × 72 px), the gap between cards is at least 8 px, and the tray sits `TRAY_BOTTOM_GAP_PX` (24 px) above the window's bottom edge, so the hand cursor can reach a card while the palm stays in the camera frame. All three are named constants, tuned in the manual webcam check.

### Object = group, and pulling a part out

39. **The group.** Every part belongs to exactly one object (as `SceneObject.model.parts` already guarantees). A generated design, an AI edit result and the demo start as one object. No operation merges objects; a pull-out is undone only by 復原.
40. **Pull-out.** Pulling part *p* out of object *O* takes *p* and all its descendants (the **subtree**, in model order) out of *O* and makes them a new object *N*:
    - *N*'s model: name = *p*'s name; summary = 從「{O 的名稱}」拉出的零件。; `assumptions: []`; `schemaVersion` and `units` from *O*; the subtree's parts, with *p* as the root (`parentId: null`) and every other part unchanged.
    - *N*'s object fields: the given id and `createdAt`; `source` and `providerModel` from *O*; `edited: true`; `material` from *O* (AJ R11: one material per object, which the user can now change for *N* alone).
    - *O* keeps every other part, unchanged, and is marked edited.
41. **In place, exactly.** Before placement, *N* sits exactly where the subtree was: *N*'s rotation is *O*'s rotation; *N*'s position is *p*'s origin in the world (*O*'s matrix times *p*'s model-frame matrix from `worldMatrices`); *p*'s position becomes (0, 0, 0) and its rotation becomes its model-frame rotation (XYZ degrees). Positions are rounded to 5 decimals and rotations to 2, as `transformOfMatrix` does; the error is below 0.01 mm and 0.01°, far inside `CONTACT_GAP_MM` (0.1 mm) and `CONTACT_ANGLE_DEG` (1°), so touching faces still touch.
42. **Placement** (decision 1). If any joint has exactly one side in the subtree (it connects the subtree to the rest of *O* or to another object), *N* stays in place (R41), so the joined faces keep touching. Otherwise *N* is placed **next to *O***: moved along world X so that its box starts `max(0.02 m, 10 % of its width)` past the right edge of *O*'s remaining box (`objectBox`), keeping its height and depth; if that box overlaps another object's box, the left side of *O* is tried, then front, then back; if all overlap, *N* goes past the right edge of every object, as `placeBeside` does. The rule is deterministic, so the browser and the server compute the same result.
43. **Refusals.** Nothing changes, and a `WorkspaceError` with a fixed Traditional Chinese message is thrown, when:
    - the object does not exist (`UNKNOWN_OBJECT`, 找不到指定的物件。) or has no such part (`UNKNOWN_PART`, new: 找不到指定的零件。);
    - the subtree is the whole object (`WHOLE_OBJECT`, new: 這個零件連同子零件就是整個物件，不需要拉出。);
    - the workspace already has `MAX_OBJECTS` objects (`OBJECT_LIMIT`, existing message);
    - the new id is in use (`DUPLICATE_OBJECT`), or the result leaves the transform limits (`INVALID_WORKSPACE`).
44. **Order** (decision 3). *N* is inserted into `workspace.objects` right after *O*, so the 物件 list and the export's piece numbering keep a design's objects together.
45. **Joints.** Every joint side that names a part of the subtree is re-pointed to *N* (same part id, same face); joint ids, methods, needs and `confirmed` stay; no joint is removed. A joint between the subtree and the rest of *O* now connects *O* and *N*, so they form an assembly and move together (AJ R84–R85). A joint between the subtree and another object now connects that object and *N*; *O* leaves that assembly unless another joint still links it. A joint with both sides in the subtree stays a joint inside *N*.
46. **Selection, active object, exploded view.** *O* stays the active object (decision 2) and keeps its tray, so several parts can be pulled out in a row. Selected parts that moved to *N* leave the selection. The explode amount stays; *O* is shown with its remaining parts at that amount, and *N*, not being active, is shown assembled (`SceneViewport` explodes the active object only).
47. **Undo.** A pull-out is exactly one undo step (one `commit`): 復原 restores *O* with its parts, removes *N* and restores the joints; 重做 repeats it with the same ids.
48. **What else reacts**, through the existing rules:
    - a running mouse join ends and a print preview closes (`workspace-changed`);
    - an AI edit of *O* that is still waiting reports a conflict, because the pulled parts count as manually changed (`editConflicts`);
    - a running hand grab or fist hold on *O* is cancelled, because *O* is rebuilt (HM R39);
    - an open export dialog prepares again (EX R2);
    - an open joint card stays open (its joint id is unchanged).
49. **The change.** `ObjectChangeSchema` gains `{ op: 'pull-out', objectId, partId, newObjectId, createdAt, inPlace?: true }`. `applyWorkspaceChange` applies it with the same pure function as the browser, so a server-built change and a local pull-out give the same workspace. `inPlace: true` forces R41 without R42 (used by R50). Old payloads parse unchanged.
50. **Two parts of one object, joined** (decision 5). When a new joint's two sides are parts of the same object (the mouse join, or the agent's `create_joint`), the side whose part is not an ancestor of the other side's part (side b when neither is) is first pulled out in place (`inPlace: true`), and the joint is created between the two objects: one undo step, the joint card opens, and the message is 已把「{part}」拉出成新物件，並接合「{a}」與「{b}」，請確認固定方式。. At `MAX_OBJECTS` the join is refused with the `OBJECT_LIMIT` message. Two-hand joins already need two different objects (`joinsAnotherObject`) and are unchanged.
51. **Older data.** A joint inside one object that already exists in a workspace stays valid (`assertJoints` is unchanged) and exports as today (EX R6–R7). `WORKSPACE_VERSION` stays 2 and `migrateWorkspace` is unchanged (decision 6).
52. **Saved workspaces.** No workspace is saved anywhere today: the only browser storage is the printer profile (`src/joints/printer-store.ts`), and `validateWorkspace` runs only on agent requests (`validateAgentRequest`). Because `SceneObject` and `Workspace` keep their schema, a workspace saved later by `projects-memory` before or after this spec loads the same way.
53. **Export.** Parts of different objects are never fused into one print piece (EX R6), so a pulled-out part becomes a print piece of *N* even where it touches *O*. A re-pointed joint keeps its features, its BOM items and its step. The BOM lists *N*'s pieces and bought components under *N*'s name, and the piece numbers follow the object order (R44). The export code is unchanged except R54.
54. **Export scope.** When the export dialog's scope is 目前物件的組合件 and some objects are not in that assembly, the dialog shows the info line 不在這個組合件中的物件不會匯出：{names}。, so a pulled-out part that was never joined is not silently left out.
55. **Material.** *N* starts with *O*'s material and can be set on its own in the 物件 panel or with `set_material`.
56. **Agent tool `pull_out_part`.** `pull_out_part({ partId, objectId? })`, label 拉出零件, category `assembly`, effect `writes-scene`, project scope, no model call. `objectId` defaults to the active object. It returns the R49 change (with an id from `newObjectId()` and the time from `now()`), and a detail `{ objectId, partId, newObjectId, partIds, inPlace, jointsMoved }`. Errors: `NO_MODEL`, `UNKNOWN_OBJECT`, `UNKNOWN_PART`, `WHOLE_OBJECT`, `OBJECT_LIMIT`, with the R43 messages. When the agent's change arrives, the workbench message is 代理已把「{part}」拉出成新物件，可按「復原」回到上一步。

### Joints connect objects

57. **A joint connects two objects.** Every joint created from now on has its two sides in two different objects (R50). The joint card, the mouse join, the two-pinch and two-fist joins and `create_joint` are otherwise unchanged.
58. **Removing a joint** is done only with 刪除接合 on the joint card or the agent's `remove_joint`. The two objects stay where they are, as separate objects; their assemblies are recomputed (`assemblyOf`), and they are never merged back into one object.
59. **No ungroup gesture.** No hand gesture removes a joint, ungroups, or moves a part back into another object. The hands change grouping in exactly two ways: pulling a part out from the tray (R36) and joining (two pinches or two fists, HM R108, AJ Task 6). The two-hand join rule (`joinGesture`) gains no row.
60. **Reaching the joint card.** The 接合 panel opens by itself when a joint is created or its card is requested (R13), so 刪除接合 is one click away after any join; the 接合 toggle and the agent reach it at any time.

### Data cards

61. **Cards on the video.** The agent can place small **data cards** over the camera view. A card is anchored to a part, to the middle of two parts, or to a joint's contact region, and is drawn over the scene with a short line to its anchor.
62. **Kinds.** A card names what it shows, never the numbers:

    | Kind | Target | Shows |
    |---|---|---|
    | `part-size` | one part | 寬 × 高 × 深 in mm from the part's `dimensions` (one decimal), and its primitive |
    | `distance` | two parts (any objects) | the distance between their origins in mm and the gap between their boxes (approximately, labelled 約), one decimal |
    | `joint` | one joint | the two sides, the method (`methodSummary`), the state (待確認 / 已確認 / 有問題) and the number of problems from `checkJoints` |
    | `dimensions` | one object | reserved for `design-fidelity` (the W×D×H readout) |
    | `fit` | one object | reserved for `body-fit` (the fit result and the fit map) |

63. **Computed, live.** A card's values are computed in the browser from the current workspace each time it is drawn, never from model text, so they are never stale after an edit (VISION §4.10: every number shown is computed from the model). A card whose target no longer exists disappears.
64. **Placement.** After each scene render, each card follows its anchor: it sits 24 px right of and 24 px above the anchor's screen point, is kept inside the free area, and moves down past an earlier card it would overlap. An anchor outside the view pins its card to the nearest edge of the free area without a line.
65. **At most `MAX_DATA_CARDS` (4)** cards at a time; a fifth removes the oldest.
66. **Dismissing.** Each card has a close button 關閉資料卡; Esc closes a card that has the focus (R16); the agent can hide one card or clear all (R71).
67. **Session state.** Cards are not part of the workspace, not an undo step and not exported. They survive undo and redo while their target exists.
68. **Accessibility.** A card is a `role="group"` with its title as accessible name, its values are text, and it is not a hand target.
69. **Cost.** Card positions are written to the card elements directly after each render (no React render per frame), with at most `MAX_DATA_CARDS` projections per render.
70. **Plug-ins.** Each kind is one entry in a registry (title, rows, anchor), so `design-fidelity` and `body-fit` add `dimensions` and `fit` by adding an entry and a schema member, without changing the layer.

### Agent

71. **Tools.** Besides `pull_out_part` (R56), two new tools, both local, project scope, effect `read-only` (they change no workspace data):
    - `show_panel({ panel, open })`, label 開關面板: `panel` is one of `create`, `objects`, `joints`, `printer`, `details` (and `fit` once `body-fit` adds it).
    - `data_card({ action, kind?, objectId?, partId?, otherObjectId?, otherPartId?, jointId?, cardId? })`, label 資料卡: `action` is `show` (with a kind and its targets), `hide` (with `cardId`) or `clear`. A `show` returns the card id and the computed values in its summary, from the same shared functions the card uses, so the agent's reply can only repeat computed numbers. Errors: `NO_MODEL`, `UNKNOWN_OBJECT`, `UNKNOWN_PART`, `UNKNOWN_JOINT`, `UNKNOWN_CARD`, `MISSING_TARGET`.
    The registry then has 18 tools, under the 20 at which VISION §4.3 adds `find_tools`.
72. **State change.** `StateChangeSchema` gains two optional, nullable session fields, like `tryOn`, `exportDialog` and `cameraHidden`: `panel: { id, open }` and `dataCard: { op: 'show', card } | { op: 'hide', cardId } | { op: 'clear' }`. The server's `checkedChange` and the browser's `applyStateEvent` strip them before `applyWorkspaceChange`; they are never an undo step. Existing payloads stay valid.
73. **What the agent sees.** `AgentRequestSchema` gains an optional `ui: { panels, cards }` (the open panels and the shown cards), and the per-round snapshot (`workspaceSnapshot`) lists them in one line each when present, so the agent can close what it opened. A request without `ui` is valid.
74. **Instructions.** `AGENT_INSTRUCTIONS` gains, in English: an object is one printed group and `pull_out_part` makes a part its own object (when to use it, in place or beside, the original stays active); joints connect two objects and `create_joint` on two parts of one object first pulls one out in place; removing a joint keeps the objects separate and nothing merges objects; `show_panel` and `data_card` with their limits, and the rule that the reply repeats only numbers a tool or card gave. The existing line "Joints connect two objects (or two parts of one object) on flat faces." changes accordingly.
75. **`create_joint`** follows R50 for two parts of one object; its description and its result summary say that one part became its own object.
76. **Messages.** `StateEffects` carries the object change's `op`, so the browser's message for an agent change can name a pull-out (R56) instead of 代理已建立新物件.
77. Tool errors returned to the model and the client are fixed Traditional Chinese strings without Zod text, as for every tool.

### Compatibility and reachability

78. **Inventory.** Every control and readout of today's page is reachable after this spec, at most one toggle away from a fresh page or the state where it applies:

    | Today | After |
    |---|---|
    | camera, try-on, 手勢, 隱藏鏡頭畫面, 提高背景對比, 復原, 重做, 縮小, 放大, 重設視角, 匯出套件 (stage toolbar) | HUD toolbar, always (R4) |
    | 爆炸圖, 拆開程度 and its note (under the stage) | HUD toolbar with an active object; the note becomes the slider's description |
    | hand status, try-on status and numbers, camera and render errors, the stage hints | status bar (R7) |
    | `HandDebugPanel` | floating 手勢除錯 (R24) |
    | export dialog | right dock (R22) |
    | agent panel | left dock, bar always visible (R20) |
    | prompt panel and its notices; service status and 重新檢查 | 生成與修改 (R11) |
    | 載入示範模型 (start message and link) | exactly one button (R25) |
    | 物件 panel | 物件 |
    | 接合 panel, joint card | 接合 |
    | 列印設定 | 列印設定 |
    | part list | tray (R27) |
    | part editor | 零件 |
    | 模型與假設 | 詳細資料 |
    | model caption | HUD (R6) |
    | orientation marks (Y X Z) | bottom left of the free area |
    | all gestures, try-on, keyboard shortcuts (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Esc, Delete, +, −, R) | unchanged |

79. **Names.** Every accessible name, label and test id used by `tests/e2e/` keeps its exact text, except where a task changes a control on purpose and updates its tests in the same task. New names never contain 取消, 刪除, 復原, 重做, 載入示範模型 (except R25's button) or a part or object name (except tray cards), so they cannot collide with existing selectors.
80. **Unchanged contracts.** `/api/generate`, `/api/edit`, `/api/agent`'s event types, `ModelSpec`, `Part`, the workspace schema (version 2), the provider adapters, the joint rules, the printer profile and every export file stay as they are, except the additive changes of R49, R72 and R73.
81. **Unchanged behaviour.** Apart from where controls are, the workbench behaves as today: the same undo steps, the same gesture gates (`handGate`), the same try-on, export and agent behaviour.
82. **E2E.** The full e2e suite passes after every task that moves or renames a control. A task that has to change an existing e2e test changes only selectors and the steps that open a panel (through one shared helper), never an asserted behaviour, unless this spec changes that behaviour on purpose (listed per task in `tasks.md`).

## Non-functional requirements

83. **Performance on the 2-core, 8 GB laptop with an integrated GPU** (two hands track at about 9–10 fps, VISION §4.9):
    - No React render per tracking frame (as HM requires): the card ghost, the carry and the data cards are moved through element styles; on-screen target rectangles are read from a cache that is refreshed on resize, tray scroll and panel changes, not per frame.
    - A pull-out of a 64-part object with 32 joints takes under 5 ms in Node (reported, not asserted).
    - Opening or closing a panel renders only the docks, not the scene; the canvas is never resized by it (R1).
    - The full-screen canvas has more pixels than today's view (for example 1440 × 1000 CSS px against about 1000 × 580). Its pixel ratio is capped by `FULLSCREEN_MAX_PIXEL_RATIO` (decision 14). The manual check compares the hand tracking rate and the frame time before and after on the user's laptop; the rate must not drop by more than 1 fps.
84. **Size.** No new dependency. The main chunk may grow only by the new components; the export chunk stays lazy. `npm run build` output is reported in the layout task and the last task.
85. **Accessibility** (WCAG 2.2 AA where it applies):
    - every control works with the keyboard (R16, R30), with a visible focus ring over the video;
    - dragging has a single-pointer and keyboard alternative, 拉出成新物件 (SC 2.5.7);
    - targets are at least 24 × 24 px (SC 2.5.8), tray cards 96 × 72 px (R38);
    - panel and HUD backgrounds are opaque enough (alpha at least 0.88) that text keeps a contrast of 4.5:1 over any camera image; 提高背景對比 still darkens the video;
    - toggles expose `aria-expanded`; results are announced through the existing polite status line (R7);
    - state is never shown by colour alone (R29, R36);
    - `prefers-reduced-motion` turns off the ghost's return animation and the panel transitions (the existing global rule).
86. **Strings for `english-ui`** (decision 13). Every user-facing string in a file this spec creates lives in its area's text module: `src/workbench/text.ts` for the layout, panels, tray and cards; new hand badges in `src/hands/text.ts`; new workspace errors in the `MESSAGES` table of `shared/workspace.ts`; new tool summaries in one `TEXT` constant at the top of each new tool file. Strings that stay in `App.tsx` and other existing files are not moved by this spec. `english-ui` replaces the text modules after this spec's tasks that touch the same files.
87. **Privacy and security.** No new network request; panels, the tray and the cards run in the browser. The camera image never enters a card, a panel or the agent request. The server changes only by three local tools and the additive request field; it logs nothing new.
88. **Tests.** Every task has Vitest unit tests for its pure modules (panel model, zones and drop rule, tray model, pull-out, controller carry, card placement, measurements, tools), in Node, without jsdom, with a fake `ModelProvider` and no real model call. E2E tests use the fake camera, the synthetic hands of `tests/e2e/fake-hands.ts` and routed `/api/*`. Each task lists which e2e specs it runs (`design.md` §11).
89. **Language.** Spec, design, task files and code comments are English; user-facing strings are Traditional Chinese, with no mixed languages on one screen.
90. `npm run check` (type check + build + unit tests) passes before a task is marked done, and the real result is reported.
91. **README.** The README's usage text follows the new layout (where the panels are, the tray, pulling a part out, joints connect objects, data cards), and the project still installs and runs from the README alone.
92. `tasks.md` has at most 7 tasks, each small enough for one fresh Kiro session, with "Read first", "Build", "Tests", "Done when" and "Session facts"; `design.md` maps every requirement to a task.

## Dependencies on other specs

- **workspace-v2, assembly-joints, hand-manipulation, export, agent-harness.** All built (`[x]` in their `tasks.md`). This spec builds on `applyWorkspaceChange`, the undo store, `assemblyOf`, `planJoin`, the on-screen targets and press of HM (R22, R27, `pickTarget`, `HandPort.press`, which today registers no targets: `pickTarget(point, [], …)` in `useHandControl.ts`), and the export dialog. It amends HM R27 for draggable targets (R36) and AJ R27 / AJ decision 1 for new joints inside one object (R50).
- **english-ui** (C16). Strings follow R86. `english-ui`'s string tasks run **after** this spec's tasks that touch the same files (T3–T7 for `App.tsx`, `styles.css`, `src/workbench/**`, `AgentPanel.tsx`, `ObjectPanel.tsx`, `JointPanel.tsx`, `PrinterPanel.tsx`, `src/hands/text.ts`); its translation module and language switch can be built earlier as new files, and the switch goes into the HUD slot of R4.
- **design-fidelity** (C18). Its W×D×H readout and 概念尺寸 badge plug into the `extras` slot of `ObjectCaption` (R6); its fit-check notices into the `checks` slot of `DetailsPanel` and the `notices` slot of `PartPanel` (R11); a W×D×H data card, if wanted, is the reserved `dimensions` kind (R62, R70). Its `shell` primitive needs a tray icon: `PRIMITIVE_ICONS` is a `Record` over the primitive enum, so the type check fails until `shell` gets one (the same reminder as `CONTACT_FACES`). Its UI task runs after this spec's T3; its `shell`, generation-rule and research tasks are independent.
- **body-fit** (C10). Its fit panel is the reserved `fit` panel (R11, a row in the panel table and the dock order); its fit map can be shown as the reserved `fit` card kind (R62, R70), and its agent tool returns a `dataCard` change (R72). Its UI tasks run after T3 (panel) and T6 (card); its tracking, segmentation and measurement tasks are independent. If `body-fit` adds or replaces agent tools, the tool count passes 20 (R71): VISION §4.3's `find_tools` then applies, which belongs to `agent-harness` and needs the user's decision.
- **Ordering proposal** across the four specs being written now, by shared files:

  | Step | workbench-ui | Can run at the same time |
  |---|---|---|
  | 1 | T1 (shared pull-out) | design-fidelity `shell` and generation rules; body-fit maths; english-ui translation module |
  | 2 | T2 (agent tool) | the same; not another task that edits `server/agent.ts` or `server/tools/index.ts` |
  | 3 | T3 (full-screen layout) | only tasks that do not edit `App.tsx`, `styles.css`, `SceneViewport.tsx` or the panel components |
  | 4 | T4 (tray, mouse) | body-fit tracking and measurement |
  | 5 | T5 (tray, hands) | design-fidelity UI (it edits the slot components and `App.tsx`, not `src/hands/**`) |
  | 6 | T6 (data cards) | body-fit tracking; after T6: body-fit fit panel and card, design-fidelity `dimensions` card |
  | 7 | T7 (reachability, README) | then english-ui's string tasks on the shared UI files |

## Priorities and build order

- **P0:** R1–R9 (layout, framing in the free area), R11–R16, R19–R25 (panels by mouse and keyboard, the agent bar, the demo button), R27–R36, R38 (the tray by mouse, keyboard and hand), R39–R53, R55–R60 (pull-out, joints, the agent tool), R74 (the pull-out and joint lines), R75–R77, R78–R82 (reachability and the e2e suite), R83, R85–R92.
- **P1:** R17, R26, R37 (pinch taps on the HUD toggles, the demo button and the tray scroll buttons), R18, R61–R73 and R74's panel and card lines (data cards, `show_panel`, `data_card`, the request's `ui`), R54 (the export scope line), R10 (decorative clean-up), R84.
- **P2:** none. Every requirement above is planned; only the user decides cuts.

Build order: **T1 → T2 → T3 → T4 → T5 → T6 → T7** (`tasks.md`). T1 and T2 change no UI file and can run beside other specs' non-UI tasks; T3 to T7 share `App.tsx` and `styles.css` and run one after the other.

## Decisions

Each decision lists the options and the recommendation; `design.md` and `tasks.md` follow the recommendations until the user says otherwise.

1. **Where a pulled-out part goes.** (a) Next to the original object, as VISION says; (b) at the drop point in the scene; (c) always in place. **Recommendation: (a), except that a part joined to anything outside its subtree stays in place** (R42). (b) gives spatial control but needs a depth for the drop point and can overlap other objects; (c) leaves the parts overlapping, so the user cannot see that anything happened. A joined part must stay in place, or its joint faces separate.
2. **Which object is active afterwards.** (a) The original stays active and keeps its tray; (b) the new object becomes active with its root part selected. **Recommendation: (a)** (R46): the user can pull several parts out of one design in a row, and the hands join without activating anything. With (b) the tray would jump to a one-card object after every pull-out.
3. **Order of the new object.** (a) Right after the original; (b) at the end. **Recommendation: (a)** (R44): the 物件 list and the export piece numbers (P01, P02, …) keep a design together. `objectRows`' comment ("creation order") is updated.
4. **Joints that link the pulled part to the rest.** (a) Keep them; they now connect the two objects; (b) remove them. **Recommendation: (a)** (R45): the joint is exactly "printed apart, then fastened" (VISION 2026-11-23/25); removing it would lose the user's method choice.
5. **New joints between two parts of one object.** (a) Pull one side out in place, then join, as one undo step; (b) refuse with 請先把零件拉出成新物件; (c) keep allowing joints inside one object (AJ decision 1). **Recommendation: (a)** (R50): the mouse flow the user knows keeps working, and every new joint connects two objects. Existing unit tests that create a joint inside one object through `create_joint` (`tests/unit/agent-joint-tools.test.ts`, "joins two parts of one object that already touch") change in T2; tests of the data rule itself (`joint-data.test.ts` "allows two parts of one object", `joint-contact.test.ts`, `export-plan.test.ts`, `export-pieces.test.ts`) stay, because such joints remain valid data (R51).
6. **Schema version and lineage.** (a) No schema change: `WORKSPACE_VERSION` 2, no new field; (b) add `pulledFrom: objectId | null` to `SceneObject` (with a version bump or a default). **Recommendation: (a).** Evidence: `material: null` is written in 27 places in 18 files (tests, fixtures and code), and a new `SceneObject` field would need the same edit in all of them while other sessions edit the same files; no workspace is saved today (R52), so nothing needs migrating. What lineage would add (a warning for a pulled-out part that was never joined) is covered by R54.
7. **When panels open.** (a) By themselves on the edges of R13, and whenever the user asks; (b) only when the user asks; (c) the current set, always open, in a dock. **Recommendation: (a).** (b) hides 新增接合 and the part fields until the user knows where to look; (c) is the cluttered page the user wants to leave.
8. **The agent panel.** (a) A bar that is always visible and expands for the log and the reply; (b) a dock panel like the others. **Recommendation: (a)** (R20): talking to the agent is the main way to work (VISION §4.11, "you work with an agent"), and 任務指示 stays where every agent test finds it.
9. **Docks over the canvas or beside it.** (a) Docks float over the full-screen canvas and framing uses the free area (R8); (b) the canvas shrinks to the free area; (c) docks float and framing ignores them. **Recommendation: (a).** (b) is not full screen, and every panel change would resize the canvas and re-frame it (`SceneViewport`'s `ResizeObserver` calls `fit()` while the view is unchanged); (c) frames the demo's base under the tray, where a pinch would hit a tray card instead of the part.
10. **Tray card pictures.** (a) Colour, a primitive icon, name and size; (b) a rendered 3D thumbnail per part. **Recommendation: (a)** (R28): (b) needs an off-screen render per part (up to 64) and per model change on a 2-core laptop whose GPU already runs hand tracking; the colour and icon identify a part well enough, and selecting it highlights it in the scene.
11. **What the hands can press.** (a) The HUD panel toggles, the demo button, the tray cards and the tray scroll buttons; (b) every button; (c) only the tray cards. **Recommendation: (a)** (R17, R26, R36–R37). Evidence for not (b): the hand tests find "empty space" at the vertical middle near the canvas's right edge (`emptyPoint` in `tests/e2e/hand-control.spec.ts`), exactly where the right dock's buttons would be; on-screen targets win over the scene (`pickTarget`), so those pinches would press panel buttons. The HUD and the tray sit at the window's top and bottom edges, away from the scene's middle.
12. **The gizmo when a card is selected.** (a) Selection only; 拖曳移動 and 拖曳旋轉 stay explicit; (b) selecting from the tray turns on 拖曳移動. **Recommendation: (a)** (R32): it matches a click in the scene, and `tests/e2e/explode.spec.ts` and `edit-select.spec.ts` press 拖曳移動 expecting it to turn on.
13. **Strings in moved code.** (a) Strings in every file this spec creates go to the area's text module, including strings moved there from `App.tsx`; strings left in existing files stay; (b) moved strings stay inline. **Recommendation: (a)** (R86): `english-ui` then replaces text modules instead of editing the new components after this spec, which removes most merge conflicts between the two specs.
14. **Pixel ratio of the full-screen canvas.** (a) Keep today's cap of 2 (`setPixelRatio(Math.min(devicePixelRatio, 2))`); (b) cap at 1.5; (c) cap at 1. **Recommendation: (b), then measure** (R83). The canvas grows by about 2.5 times in CSS pixels; the laptop shares its integrated GPU between WebGL and the MediaPipe GPU delegate. If the manual check shows the hand rate dropping by more than 1 fps, use (c). The answer depends on the laptop's display scaling (see the question in the report).
15. **Decorative labels.** (a) Remove the phase label, the LIVE WORKSPACE heading, CONCEPT / 01 and the footer row, and move their information (R10); (b) keep them in the HUD. **Recommendation: (a)**: 第二階段 is out of date, and the HUD has no room for text that does nothing.
16. **Schedule risk** (no recommendation to cut; the user decides). Evidence: on 2026-11-26 03:00 about 9 days remain until the deadline (2026-12-05 06:00 Taiwan); VISION §5 reserves 11/29–12/03 for `english-ui`, the README, the video and the submission. This spec has 7 tasks, five of which run the full e2e suite (about 25 minutes each on this laptop, plus single specs during development), and T3 to T7 cannot run in parallel with each other or with the other specs' UI tasks, because they share `App.tsx` and `styles.css`. For comparison, `export`'s five tasks landed between 2026-11-20 and 11-22 (`c8a9fa2` to `c00332d`), and `hand-manipulation`'s Tasks 10–12 took from 11-22 to 11-26 including webcam retests. `design-fidelity` and `body-fit` are being written at the same time, and `english-ui` must follow this spec on the shared files. If T3–T7 are not done by 11/29, `english-ui` starts late. Options for the user: keep the full plan; or decide an order of P1 items to postpone (R17/R26/R37 hand presses on the HUD, R61–R77 data cards and panel tools, R54); or start `english-ui`'s translation module now on new files only (no conflict).

## Decisions from review (2026-11-26)

Reviewed with the user and Claude Code. The user accepted every recommendation under "Decisions" above, plus these cross-spec decisions. Where this section and the text above differ, this section wins.

1. **Decorative labels (decision 15):** removed as recommended; only the brand FORGEHAND stays. `english-ui` decision 7 follows this.
2. **Demo entry (amends R25, R26):** there is still exactly one button named 載入示範模型 (same names as R25, so existing selectors keep working), and next to it a selector named 示範模型 with two options: 雙鏡頭概念裝置 (default, today's demo) and 智慧手環 (`body-fit`'s hand-written bracelet, `shared/demo-bracelet.ts`, once it exists). The button loads the selected demo. The same pair appears in the empty workspace's start message. `body-fit` builds no separate 載入示範手環 button. The selector is not a hand target; the button stays one (R26).
3. **Tool count (R71):** `find_tools` is not built now. Measured on 2026-11-26: 15 tools, generated tool list 6,409 characters. The four specs bring about 21 tools; `agent-platform` (being written) adds more. Revisit then (VISION §4.3 note of 2026-11-26).
4. **Strings (R86):** once `english-ui` Task 1 has landed and the steering is updated, new user-facing strings go into bilingual tables (`english-ui` R58); before that, R86 applies as written.
5. **Try-on button:** `body-fit` renames 護臂試戴 to 試戴 and replaces the try-on status texts; whichever spec lands second updates the HUD names (R4) and its tests.
6. **Schedule (decision 16):** the user keeps the full plan; nothing is postponed. Tasks follow the cross-spec order kept by the reviewer.
7. **`agent-platform`** (being written): its save and open controls and its notice for changes made by an external agent need a place in the HUD or a panel; give them a slot when that spec lands.

## Decisions from review of Task 2 (2026-11-28)

Recorded by the reviewer; this section wins over the text above and over `design.md`.

8. **An agent join inside one object opens the joint card.** Design §4.4 gave every `pull-out` change the plain pull-out message, which missed R50's case: `create_joint` on two parts of one object sends a pull-out and a new joint in one state event. The browser now opens the new joint's card and says 代理已把「{part}」拉出成新物件，並接合「{a}」與「{b}」，請確認固定方式。 (R50's sentence with the 代理 prefix every agent message has). Fixed by the reviewer in `src/App.tsx` and `src/i18n/pull-out-text.ts`, with an e2e case in `tests/e2e/pull-out.spec.ts`. The mouse join of R50 is still to be built by its task.
9. **The instruction line says "undo", not 「復原」.** The new line would have been a Chinese line in `server/agent.ts` above its stray-string baseline; the English instructions name the action instead.
10. **`create_joint`'s summary mixes languages in English** until english-ui moves that tool's strings: only the new pull-out sentence follows `langOf(state)`.
