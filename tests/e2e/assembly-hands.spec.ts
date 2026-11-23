import { expect, test, type Page } from '@playwright/test';
import { alignTransform } from '../../shared/contact';
import type { Joint } from '../../shared/joint';
import { demoPair, side } from '../fixtures/joint-workspace';
import { fakeHandsLog, hideHand, installFakeHands, handsUrl, palmOffset, showHands, type FakeHand } from './fake-hands';

// The two-fist join (assembly-joints Task 6) and the join with two pinches (hand-manipulation Task 11), end to end with the scripted hand worker of fake-hands.ts: two demo objects, a fist on each,
// the second one brought to the first until the faces snap, then released. The scene, the raycasts and the workspace are real; no model
// back end is called.

type Pt = { x: number; y: number };
type Vector = { x: number; y: number; z: number };
type ObjectRow = [string, Vector, Vector];
const OPEN = 0.1;
const PINCH = 0.012;
const GAIN = 1.5; // DRAG_GAIN: a palm pixel moves the object 1.5 screen pixels
const GAP = 0.02; // metres between B's and A's faces before the gesture

const canvas = (page: Page) => page.getByTestId('scene-canvas');
const overlay = (page: Page) => page.getByTestId('hand-overlay');
const undo = (page: Page) => page.getByRole('button', { name: '復原', exact: true });
const objectRows = async (page: Page): Promise<ObjectRow[]> => JSON.parse((await canvas(page).getAttribute('data-object-json'))!);
const jointList = async (page: Page): Promise<Joint[]> => JSON.parse((await canvas(page).getAttribute('data-joints-json'))!);
const shift = (point: Pt, dx: number, dy = 0): Pt => ({ x: point.x + dx, y: point.y + dy });
const fistAt = (at: Pt): FakeHand => ({ at, pinchM: OPEN, fist: true });
const openFor = (palm: Pt, offset: Pt): FakeHand => ({ at: shift(palm, -offset.x, -offset.y), pinchM: OPEN });
/** A pinch is placed by its midpoint, which is the cursor, so an open hand and a pinch at the same point share it. */
const pinchAt = (at: Pt): FakeHand => ({ at, pinchM: PINCH });
const openAt = (at: Pt): FakeHand => ({ at, pinchM: OPEN });

test.beforeEach(async ({ context, page }) => {
  test.setTimeout(240_000);
  await installFakeHands(context);
  await page.route('**/api/status', route => route.fulfill({ json: { configured: true, provider: 'codex', model: 'test-double-not-a-real-model' } }));
  await page.route('**/api/{generate,edit,agent}', route => route.abort());
});

async function framesAbove(page: Page, count: number) {
  await expect.poll(async () => (await fakeHandsLog(page)).frames, { timeout: 45_000 }).toBeGreaterThan(count);
}

/** The client point, near the part's centre, where the scene's own raycast finds an exterior surface of `objectId`. */
async function pointOnObject(page: Page, objectId: string): Promise<Pt> {
  const found = await page.evaluate(id => {
    const scene = window.__forgehandScene!;
    const centre = scene.projectPart('housing', id);
    if (!centre) return null;
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = centre.y - 140; y <= centre.y + 140; y += 5) {
      for (let x = centre.x - 140; x <= centre.x + 140; x += 5) {
        const hit = scene.hitTest({ x, y });
        const d = Math.hypot(x - centre.x, y - centre.y);
        if (hit && hit.objectId === id && (!best || d < best.d)) best = { x, y, d };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }, objectId);
  expect(found, `no point on ${objectId} found`).not.toBeNull();
  return found!;
}

const faceOf = (page: Page, objectId: string) =>
  page.evaluate(id => window.__forgehandScene!.projectFace(id, 'housing', '-x'), objectId);

/**
 * A and B side by side with GAP between A's side battery and B's housing, and the screen vector that carries B's housing face onto A's
 * battery face. Moving the fist by that vector (divided by the drag gain) leaves B a few millimetres from A, inside the snap distance.
 */
async function setUp(page: Page) {
  await page.goto(handsUrl({ debug: true }));
  await page.getByRole('button', { name: '載入示範模型', exact: true }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '1');
  await page.getByRole('button', { name: /^載入示範模型/ }).first().click();
  await expect(canvas(page)).toHaveAttribute('data-object-count', '2');
  const [a, b] = await objectRows(page);
  const ids = { a: a![0], b: b![0] };
  // Where B stands when its housing touches A's battery, computed with the same rules the app uses.
  const reference = demoPair();
  const touching = alignTransform(reference, side('demo-a', 'battery', '+x'), side('demo-b', 'housing', '-x'));
  expect(touching).not.toBeNull();
  const setX = async (metres: number) => {
    const x = page.getByLabel('物件位置 X', { exact: true });
    await x.fill((Math.round(metres * 10_000) / 10).toString());
    await x.press('Enter');
    await expect.poll(async () => (await objectRows(page))[1]![1].x).toBeCloseTo(metres, 3);
  };
  await expect(canvas(page)).toHaveAttribute('data-active-object-id', ids.b);
  await setX(touching!.position.x);
  const onA = (await faceOf(page, ids.b))!;
  await setX(touching!.position.x + GAP);
  const apart = (await faceOf(page, ids.b))!;
  const carry = { x: (onA.x - apart.x) / GAIN, y: (onA.y - apart.y) / GAIN };
  const rows = await objectRows(page);
  await page.getByRole('button', { name: '開啟攝影機', exact: true }).click();
  await framesAbove(page, 0);
  const offset = await palmOffset(page);
  const pa = await pointOnObject(page, ids.a);
  const pb = await pointOnObject(page, ids.b);
  return { ids, carry, offset, pa, pb, rows };
}
type Rig = Awaited<ReturnType<typeof setUp>>;

async function openHands(page: Page, hands: readonly FakeHand[]) {
  await showHands(page, hands.map(hand => ({ ...hand, pinchM: OPEN, fist: false })));
  await expect(overlay(page)).toHaveAttribute('data-gesture', 'none', { timeout: 45_000 });
}
/** Repeats a whole attempt up to three times: on a busy machine the fake camera can stall for longer than the hand-loss window. */
async function attempts(page: Page, hands: readonly FakeHand[], attempt: () => Promise<void>) {
  for (let count = 1; ; count++) {
    try { await attempt(); return; } catch (error) {
      if (count === 3) throw error;
      await openHands(page, hands);
    }
  }
}
/**
 * Every attempt starts with no hand in either slot, then shows the first fist alone and waits for its hold, then adds the second fist
 * and waits for the assemble. The fake hand jumps between far points; a jump beyond HAND_MATCH_PX counts as a new hand.
 */
async function startAssemble(page: Page, rig: Rig) {
  await attempts(page, [fistAt(rig.pa), fistAt(rig.pb)], async () => {
    await hideHand(page);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'none', { timeout: 45_000 });
    await showHands(page, [fistAt(rig.pa)]);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'hold', { timeout: 15_000 });
    await showHands(page, [fistAt(rig.pa), { at: rig.pb, pinchM: OPEN }]);
    await expect(overlay(page)).toHaveAttribute('data-hand-count', '2', { timeout: 45_000 });
    await showHands(page, [fistAt(rig.pa), fistAt(rig.pb)]);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'assemble', { timeout: 15_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'hold');
  });
}
async function someFrames(page: Page, count = 8) {
  const start = (await fakeHandsLog(page)).frames;
  await expect.poll(async () => (await fakeHandsLog(page)).frames, { timeout: 45_000 }).toBeGreaterThan(start + count);
}

/** Largest move of the carrying hand between two shown positions; far below HAND_MATCH_PX (160 px), like a real hand at 10 fps. */
const CARRY_STEP_PX = 60;

/**
 * Carries the second hand from `from` by `by` in steps of at most CARRY_STEP_PX, with frames in between, while the first hand stays.
 * A hand that jumps farther than HAND_MATCH_PX between two frames counts as a new hand, and its slot can change.
 */
async function carry(page: Page, steady: FakeHand, from: Pt, by: Pt, hand: (at: Pt) => FakeHand): Promise<Pt> {
  const steps = Math.max(1, Math.ceil(Math.hypot(by.x, by.y) / CARRY_STEP_PX));
  let at = from;
  for (let step = 1; step <= steps; step++) {
    at = shift(from, by.x * step / steps, by.y * step / steps);
    await showHands(page, [steady, hand(at)]);
    await someFrames(page, 2);
  }
  return at;
}

/** Two fists, B carried to A until `data-snap` is ready. Returns where B's fist is. */
async function snap(page: Page, rig: Rig): Promise<Pt> {
  await startAssemble(page, rig);
  const to = await carry(page, fistAt(rig.pa), rig.pb, rig.carry, fistAt);
  await expect(canvas(page)).toHaveAttribute('data-snap', 'ready', { timeout: 30_000 });
  return to;
}

/** The full join: snap, then open B's fist. Leaves the joint card open. */
async function join(page: Page, rig: Rig) {
  const to = await snap(page, rig);
  await showHands(page, [fistAt(rig.pa), openFor(to, rig.offset)]);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1', { timeout: 45_000 });
  await expect(page.getByTestId('joint-card')).toBeVisible();
}

test('兩個拳頭接合：靠近到可以接合，放開後建立一個接合，復原一次兩個物件都回去', async ({ page }) => {
  const rig = await setUp(page);
  const before = await objectRows(page);
  expect(await jointList(page)).toEqual([]);
  const to = await snap(page, rig);
  // The cue is up and nothing is written until a fist opens.
  await expect(overlay(page)).toHaveAttribute('data-gesture', 'assemble');
  await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'hold');
  await expect(page.getByTestId('hand-debug')).toContainText('接合：間隙');
  expect(await objectRows(page)).toEqual(before);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');

  await showHands(page, [fistAt(rig.pa), openFor(to, rig.offset)]);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1', { timeout: 45_000 });
  await expect(canvas(page)).toHaveAttribute('data-snap', 'none');
  await expect(page.getByTestId('joint-card')).toBeVisible();
  await expect(page.getByTestId('joint-card')).toContainText('待確認');
  await expect(page.getByText(/已接合「.+」與「.+」，請確認固定方式。/)).toBeVisible();
  await expect(page.getByTestId('hand-debug')).toContainText(/接合 1\b/);
  const [joint] = await jointList(page);
  expect(joint!.a.objectId).toBe(rig.ids.a);
  expect(joint!.b.objectId).toBe(rig.ids.b);
  expect(joint!.confirmed).toBe(false);
  // B moved onto A's face; A did not move.
  const after = await objectRows(page);
  expect(after[0]).toEqual(before[0]);
  expect(after[1]![1].x).not.toBeCloseTo(before[1]![1].x, 3);

  // One undo step removes the joint and puts B back.
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect.poll(async () => (await objectRows(page))[1]![1]).toEqual(before[1]![1]);
  expect((await objectRows(page))[0]).toEqual(before[0]);
});

test('兩個拳頭：接合後拿住其中一個，整組一起移動；另一個拳頭按在同一組物件上不會動作', async ({ page }) => {
  const rig = await setUp(page);
  await join(page, rig);
  await showHands(page, []);
  await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
  const joined = await objectRows(page);
  const pa = await pointOnObject(page, rig.ids.a);
  const pb = await pointOnObject(page, rig.ids.b);
  const housingB = (await faceOf(page, rig.ids.b))!;
  const to = shift(pa, 90, 0);
  await attempts(page, [fistAt(pa)], async () => {
    await hideHand(page);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'none', { timeout: 45_000 });
    await showHands(page, [fistAt(pa)]);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'hold', { timeout: 15_000 });
  });
  // A second fist on an object of the held object's assembly does nothing.
  await showHands(page, [fistAt(pa), { at: pb, pinchM: OPEN }]);
  await expect(overlay(page)).toHaveAttribute('data-hand-count', '2', { timeout: 45_000 });
  await showHands(page, [fistAt(pa), fistAt(pb)]);
  await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'locked', { timeout: 15_000 });
  await expect(overlay(page)).toHaveAttribute('data-gesture', 'hold');
  await showHands(page, [fistAt(pa), fistAt(pb)]);
  // While the fist holds A, B moves with it on screen; the data waits for the release. The second fist stays closed and inert.
  await showHands(page, [fistAt(shift(pa, 45)), fistAt(pb)]);
  await someFrames(page, 4);
  await showHands(page, [fistAt(to), fistAt(pb)]);
  await expect.poll(async () => ((await faceOf(page, rig.ids.b)) ?? housingB).x, { timeout: 30_000 }).toBeGreaterThan(housingB.x + 30);
  expect(await objectRows(page)).toEqual(joined);
  await showHands(page, [openFor(to, rig.offset), fistAt(pb)]);
  await expect.poll(async () => (await objectRows(page))[0]![1].x, { timeout: 45_000 }).not.toBeCloseTo(joined[0]![1].x, 3);
  const moved = await objectRows(page);
  // Both objects moved by the same offset, and nothing turned.
  expect(moved[1]![1].x - joined[1]![1].x).toBeCloseTo(moved[0]![1].x - joined[0]![1].x, 4);
  expect(moved[1]![1].y - joined[1]![1].y).toBeCloseTo(moved[0]![1].y - joined[0]![1].y, 4);
  expect(moved[0]![2]).toEqual(joined[0]![2]);
  expect(moved[1]![2]).toEqual(joined[1]![2]);
  await expect(page.getByText('已調整物件位置（連同接合的 1 個物件），可按「復原」回到上一步。')).toBeVisible();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1');
});

test('兩個拳頭：沒靠近就放開，只移動兩個物件（一步復原），不建立接合', async ({ page }) => {
  const rig = await setUp(page);
  const before = await objectRows(page);
  await startAssemble(page, rig);
  // B's fist moves away from A: no face is near enough to snap.
  const to = shift(rig.pb, 60, 0);
  await showHands(page, [fistAt(rig.pa), fistAt(shift(rig.pb, 30, 0))]);
  await someFrames(page, 4);
  await showHands(page, [fistAt(rig.pa), fistAt(to)]);
  await someFrames(page, 8);
  await expect(canvas(page)).toHaveAttribute('data-snap', 'none');
  await showHands(page, [fistAt(rig.pa), openFor(to, rig.offset)]);
  await expect.poll(async () => (await objectRows(page))[1]![1].x, { timeout: 45_000 }).not.toBeCloseTo(before[1]![1].x, 3);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect(page.getByTestId('joint-card')).toHaveCount(0);
  // A's fist never moved: A stayed.
  expect((await objectRows(page))[0]).toEqual(before[0]);
  await undo(page).click();
  await expect.poll(async () => (await objectRows(page))[1]![1]).toEqual(before[1]![1]);
});

// ---- Task 11: the join with two pinches -----------------------------------------------------------------------------------------

/**
 * Every attempt starts with no hand in either slot. The first hand hovers over A alone, the second joins over B, the first pinches
 * (it grabs a part of A), then the second pinches a part of B: the grab gives way to two holds and the assemble starts.
 */
async function startPinchAssemble(page: Page, rig: Rig) {
  await attempts(page, [openAt(rig.pa), openAt(rig.pb)], async () => {
    await hideHand(page);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'none', { timeout: 45_000 });
    await showHands(page, [openAt(rig.pa)]);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'hover', { timeout: 45_000 });
    await showHands(page, [openAt(rig.pa), openAt(rig.pb)]);
    await expect(overlay(page)).toHaveAttribute('data-hand-count', '2', { timeout: 45_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'hover', { timeout: 45_000 });
    await showHands(page, [pinchAt(rig.pa), openAt(rig.pb)]);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'grab', { timeout: 15_000 });
    await showHands(page, [pinchAt(rig.pa), pinchAt(rig.pb)]);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'assemble', { timeout: 15_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'hold');
    await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'hold');
  });
}

test('兩個捏合接合：捏住一個零件、再捏住另一個物件，靠近到可以接合，放開後建立一個接合，復原一次兩個物件都回去', async ({ page }) => {
  const rig = await setUp(page);
  const before = await objectRows(page);
  expect(await jointList(page)).toEqual([]);
  await startPinchAssemble(page, rig);
  // The grab was cancelled and nothing is written: both objects stand where they were.
  expect(await objectRows(page)).toEqual(before);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect(page.getByTestId('hand-debug')).toContainText('接合：間隙');

  // B's pinch carries B to A in small steps.
  const to = await carry(page, pinchAt(rig.pa), rig.pb, rig.carry, pinchAt);
  await expect(canvas(page)).toHaveAttribute('data-snap', 'ready', { timeout: 30_000 });
  expect(await objectRows(page)).toEqual(before);

  // Opening B's pinch creates the joint.
  await showHands(page, [pinchAt(rig.pa), openAt(to)]);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '1', { timeout: 45_000 });
  await expect(canvas(page)).toHaveAttribute('data-snap', 'none');
  await expect(page.getByTestId('joint-card')).toBeVisible();
  await expect(page.getByTestId('joint-card')).toContainText('待確認');
  await expect(page.getByTestId('hand-debug')).toContainText(/接合 1\b/);
  const [joint] = await jointList(page);
  expect(joint!.a.objectId).toBe(rig.ids.a);
  expect(joint!.b.objectId).toBe(rig.ids.b);
  // B moved onto A's face; A did not move.
  const after = await objectRows(page);
  expect(after[0]).toEqual(before[0]);
  expect(after[1]![1].x).not.toBeCloseTo(before[1]![1].x, 3);
  // The first pinch is still closed and does nothing until it opens.
  await expect(overlay(page)).toHaveAttribute('data-hand-state', 'locked');

  // One undo step removes the joint and puts B back.
  await undo(page).click();
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  await expect.poll(async () => (await objectRows(page))[1]![1]).toEqual(before[1]![1]);
  expect((await objectRows(page))[0]).toEqual(before[0]);
});

/** The client point, near the centre of `partId` of `objectId`, where the scene's own raycast finds exactly that part. */
async function pointOnPart(page: Page, objectId: string, partId: string): Promise<Pt> {
  const found = await page.evaluate(([object, part]) => {
    const scene = window.__forgehandScene!;
    const centre = scene.projectPart(part!, object!);
    if (!centre) return null;
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = centre.y - 100; y <= centre.y + 100; y += 5) {
      for (let x = centre.x - 100; x <= centre.x + 100; x += 5) {
        const hit = scene.hitTest({ x, y });
        const d = Math.hypot(x - centre.x, y - centre.y);
        if (hit && hit.objectId === object && hit.partId === part && (!best || d < best.d)) best = { x, y, d };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }, [objectId, partId] as const);
  expect(found, `no point on ${partId} of ${objectId} found`).not.toBeNull();
  return found!;
}

test('兩個捏合：第二個捏合按在同一個物件的另一個零件上，仍然是繞圈旋轉，不會接合，零件也不會被放回去', async ({ page }) => {
  const rig = await setUp(page);
  const before = await objectRows(page);
  const housing = await pointOnPart(page, rig.ids.a, 'housing');
  const battery = await pointOnPart(page, rig.ids.a, 'battery');
  expect(Math.hypot(housing.x - battery.x, housing.y - battery.y)).toBeGreaterThan(60);
  await attempts(page, [openAt(housing), openAt(battery)], async () => {
    await hideHand(page);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'none', { timeout: 45_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'none', { timeout: 45_000 });
    await showHands(page, [openAt(housing)]);
    await expect(overlay(page)).toHaveAttribute('data-hand-target', `${rig.ids.a}:housing`, { timeout: 45_000 });
    await showHands(page, [openAt(housing), openAt(battery)]);
    await expect(overlay(page)).toHaveAttribute('data-hand-count', '2', { timeout: 45_000 });
    await expect(overlay(page)).toHaveAttribute('data-hand2-target', `${rig.ids.a}:battery`, { timeout: 45_000 });
    await showHands(page, [pinchAt(housing), openAt(battery)]);
    await expect(overlay(page)).toHaveAttribute('data-hand-state', 'grab', { timeout: 15_000 });
    await showHands(page, [pinchAt(housing), pinchAt(battery)]);
    await expect(overlay(page)).toHaveAttribute('data-gesture', 'rotate', { timeout: 15_000 });
  });
  await expect(overlay(page)).toHaveAttribute('data-hand-state', 'grab');
  await expect(overlay(page)).toHaveAttribute('data-hand2-state', 'join');
  await someFrames(page, 10);
  await expect(overlay(page)).toHaveAttribute('data-gesture', 'rotate');
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
  expect(await objectRows(page)).toEqual(before);
  // Opening both pinches ends it without a commit: the second pinch only stayed inside the rotate's dead zone.
  await showHands(page, [pinchAt(housing), openAt(battery)]);
  await expect(overlay(page)).toHaveAttribute('data-gesture', 'grab', { timeout: 20_000 });
  await showHands(page, [openAt(housing), openAt(battery)]);
  await expect(overlay(page)).toHaveAttribute('data-gesture', 'none', { timeout: 20_000 });
  expect(await objectRows(page)).toEqual(before);
  await expect(canvas(page)).toHaveAttribute('data-joint-count', '0');
});
