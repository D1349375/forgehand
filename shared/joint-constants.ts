/**
 * Snap, contact and feature constants (assembly-joints requirements 28 and 38,
 * design 4.7). The defaults are starting points to tune on the user's laptop;
 * every other module imports them by name. Lengths are millimetres, angles degrees,
 * times milliseconds.
 */

/** Two faces touch when their normals are opposite within this angle. */
export const CONTACT_ANGLE_DEG = 1;
/** Two faces touch when the gap between their planes is at most this, in either direction. */
export const CONTACT_GAP_MM = 0.1;
/** Two faces touch when their overlap is at least this area. */
export const MIN_CONTACT_MM2 = 20;

/** A snap candidate has normals opposite within this angle. */
export const SNAP_ANGLE_DEG = 15;
/** A snap candidate may be this deep inside the other face's plane. */
export const SNAP_PENETRATION_MM = 3;
/** A snap candidate may be this far from the other face's plane. */
export const SNAP_DISTANCE_MM = 10;
/** Face centres closer than this (in the plane) are centred when aligning. */
export const CENTRE_SNAP_MM = 3;
/** The same candidate must hold this long before a snap is ready. */
export const SNAP_SETTLE_MS = 150;
/** A ready snap is released when the gap grows past this. */
export const SNAP_RELEASE_MM = 15;
/** A ready snap is released when the angle grows past this. */
export const SNAP_RELEASE_DEG = 25;
/** Points used for the outline of a disc or ring face. */
export const DISC_SEGMENTS = 32;

/** Distance from a feature's edge to the edge of the contact region. */
export const EDGE_MARGIN_MM = 1.2;
/** Material kept between a screw head's counterbore and the contact face. */
export const CLAMP_FLOOR_MM = 2.0;
/** Length of clearance hole behind a heat-set insert, for the screw's end. */
export const SCREW_TAIL_MM = 3.0;
/** Material kept at the bottom of a blind hole or pocket. */
export const MIN_FLOOR_MM = 1.0;
/** Wall of the boss around a heat-set insert. */
export const BOSS_WALL_MM = 1.6;
/** A screw reaches into its insert or tapped hole by at least this many thread diameters. */
export const MIN_ENGAGEMENT_FACTOR = 1.5;
