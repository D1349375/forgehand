import type { HandState } from './types';

/** Okabe-Ito reddish purple, for both hands: distinguishable under common colour-vision deficiencies, and different from the part-edge cyan and the selection amber. */
export const HAND_COLOUR = '#CC79A7';
/** Okabe-Ito vermillion, for the line between the hands. */
export const LINK_COLOUR = '#D55E00';
/** Hand control is off, view-only or the pinch is inert. */
export const LOCKED_COLOUR = '#9AA3AD';

export type OverlayMark = 'none' | 'ring-hollow' | 'ring-filled';
export interface OverlayStyle {
  colour: string;
  /** Grey dashes mark `locked`. */
  dashed: boolean;
  lineWidth: number;
  /** Drawn from Task 5: hollow over a target, filled while grabbing, turning the view or joining. The fist squares come with Task 7. */
  mark: OverlayMark;
}

/**
 * State is shown by shape, not colour: thin lines and no mark = tracked, a
 * hollow ring = over a target, a filled ring and thicker lines = acting, grey
 * dashes = locked. Both hands share one colour.
 */
export function overlayStyle(view: { state: HandState }): OverlayStyle {
  switch (view.state) {
    case 'locked': return { colour: LOCKED_COLOUR, dashed: true, lineWidth: 2, mark: 'none' };
    case 'hover': return { colour: HAND_COLOUR, dashed: false, lineWidth: 2, mark: 'ring-hollow' };
    case 'grab':
    case 'orbit':
    case 'join': return { colour: HAND_COLOUR, dashed: false, lineWidth: 3.5, mark: 'ring-filled' };
    // Task 7 gives the fist and its hold their square marks.
    case 'hold': return { colour: HAND_COLOUR, dashed: false, lineWidth: 3.5, mark: 'none' };
    case 'fist':
    case 'tracked':
    case 'none': return { colour: HAND_COLOUR, dashed: false, lineWidth: 2, mark: 'none' };
  }
}