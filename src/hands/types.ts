/** A position in client (CSS) pixels. */
export interface Point { x: number; y: number }

export type HandMode = 'translate' | 'rotate';

/** What the overlay shows about the hand. `locked` is hand control off or view-only. */
export type HandState = 'none' | 'tracked' | 'hover' | 'grab' | 'orbit' | 'locked';

export interface HandSample {
  /** The 21 landmarks in client pixels, for drawing. */
  points: Point[];
  /** Unfiltered CURSOR_POINT in client pixels. */
  cursor: Point;
  /** Distance between thumb tip and index tip in metres (world landmarks); null without world landmarks. */
  pinchM: number | null;
}

export type Target =
  | { kind: 'empty' }
  | { kind: 'screen'; id: string; label: string }
  /** `hit` is the world point under the cursor. */
  | { kind: 'part'; objectId: string; partId: string; label: string; hit: { x: number; y: number; z: number } };

/** An on-screen target (a button) in client pixels. Later specs register more of them. */
export interface ScreenTarget { id: string; label: string; left: number; top: number; right: number; bottom: number }

/** What the overlay canvas draws and exposes for one frame. */
export interface HandView {
  state: HandState;
  mode: HandMode;
  /** `targetKey` of the settled target. */
  targetKey: string;
  /** The 21 landmarks in client pixels. */
  points: readonly Point[];
}

export const EMPTY_TARGET: Target = { kind: 'empty' };

/** `''` for empty space, `screen:{id}` for an on-screen target, `{objectId}:{partId}` for a part. */
export function targetKey(target: Target): string {
  if (target.kind === 'empty') return '';
  if (target.kind === 'screen') return `screen:${target.id}`;
  return `${target.objectId}:${target.partId}`;
}
