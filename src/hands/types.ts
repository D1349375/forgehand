/** A position in client (CSS) pixels. */
export interface Point { x: number; y: number }
/** Which of the two tracked hands: the first to appear takes 0. */
export type HandSlot = 0 | 1;
/** A point in 3D space (world metres or a local position). */
export interface Vector { x: number; y: number; z: number }
/** What the overlay shows about the hand. `locked` is hand control off, view-only or an inert pinch. */
export type HandState = 'none' | 'tracked' | 'hover' | 'grab' | 'orbit' | 'locked'
  /** The second hand of a two-hand gesture (Task 4). */
  | 'join'
  /** A closed fist, and a fist holding an object (Task 7). */
  | 'fist' | 'hold';
export interface HandSample {
  /** The 21 landmarks in client pixels, for drawing. */
  points: Point[];
  /** Unfiltered CURSOR_POINT in client pixels. */
  cursor: Point;
  /** Mean of landmarks 0, 5, 9, 13 and 17 in client pixels: stays put while the fingers curl. Used for hand slots. */
  palm: Point;
  /** Distance between thumb tip and index tip in metres (world landmarks); null without world landmarks. */
  pinchM: number | null;
  /** Curl ratio of the four fingers (`curlRatio`); below FIST_ENGAGE_RATIO is a fist. Null without world landmarks. Filled by `handSample` (Task 7). */
  curl?: number | null;
}
export type Target =
  | { kind: 'empty' }
  | { kind: 'screen'; id: string; label: string }
  /** `hit` is the world point under the cursor. */
  | { kind: 'part'; objectId: string; partId: string; label: string; hit: { x: number; y: number; z: number };
    /** The part's object name, for the fist badge (Task 7). */
    objectName?: string };
/** An on-screen target (a button) in client pixels. Later specs register more of them. */
export interface ScreenTarget { id: string; label: string; left: number; top: number; right: number; bottom: number }
export type GestureKind = 'none' | 'grab' | 'orbit' | 'press' | 'zoom' | 'hold' | 'explode' | 'rotate'
  /** Two fists, each holding an object, bringing two objects together to join them (assembly-joints Task 6). */
  | 'assemble';
/** What the overlay draws and exposes for one hand. */
export interface HandView {
  slot: HandSlot;
  state: HandState;
  /** `targetKey` of the settled target. */
  targetKey: string;
  /** The 21 landmarks in client pixels. */
  points: readonly Point[];
  cursor: Point;
  palm: Point;
  /** Badge text, drawn from Task 5. */
  badge: string | null;
}
/** What the overlay draws and exposes for one frame. */
export interface OverlayFrame {
  /** At most two, in slot order. */
  hands: readonly HandView[];
  gesture: GestureKind;
  /** The line between the hands while a two-hand gesture runs. */
  link: { from: Point; to: Point } | null;
  /** The angle arc of the rotate gesture (Task 8). */
  arc: { centre: Point; fromDeg: number; toDeg: number } | null;
}
export const EMPTY_TARGET: Target = { kind: 'empty' };
/** `''` for empty space, `screen:{id}` for an on-screen target, `{objectId}:{partId}` for a part. */
export function targetKey(target: Target): string {
  if (target.kind === 'empty') return '';
  if (target.kind === 'screen') return `screen:${target.id}`;
  return `${target.objectId}:${target.partId}`;
}
