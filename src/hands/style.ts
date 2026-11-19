import type { HandMode, HandState } from './types';

/** Okabe-Ito reddish purple and vermillion: distinguishable under common colour-vision deficiencies, and different from the part-edge cyan and the selection amber. */
export const MODE_COLOURS: Readonly<Record<HandMode, string>> = { translate: '#CC79A7', rotate: '#D55E00' };
/** Hand control is off or view-only. */
export const LOCKED_COLOUR = '#9AA3AD';

export type RingStyle = 'none' | 'hollow' | 'filled';

export interface OverlayStyle {
  colour: string;
  /** Grey dashes mark `locked`. */
  dashed: boolean;
  lineWidth: number;
  /** Drawn from Task 5: hollow over a target, filled while grabbing or turning the view. */
  ring: RingStyle;
}

/**
 * State is shown by shape, not colour: thin lines and no ring = tracked, a
 * hollow ring = over a target, a filled ring and thicker lines = grabbed or
 * turning the view, grey dashes = locked. Colour only says the mode.
 */
export function overlayStyle(view: { state: HandState; mode: HandMode }): OverlayStyle {
  const colour = MODE_COLOURS[view.mode];
  switch (view.state) {
    case 'locked': return { colour: LOCKED_COLOUR, dashed: true, lineWidth: 2, ring: 'none' };
    case 'hover': return { colour, dashed: false, lineWidth: 2, ring: 'hollow' };
    case 'grab':
    case 'orbit': return { colour, dashed: false, lineWidth: 3.5, ring: 'filled' };
    case 'tracked':
    case 'none': return { colour, dashed: false, lineWidth: 2, ring: 'none' };
  }
}
