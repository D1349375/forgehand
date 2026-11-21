/** Gap between two footprints on the 3MF plate, in millimetres. */
export const PLATE_GAP_MM = 5;
/** A row on the plate wraps before it passes this width (a common print bed width), in millimetres. */
export const PLATE_ROW_MM = 220;
/** Coordinates are rounded to this step before two meshes are compared (`meshKey`), in millimetres. */
export const MESH_KEY_MM = 0.001;
/** Size of the binary STL header in bytes. */
export const STL_HEADER_BYTES = 80;
/** Fusion of touching and overlapping printed parts into print pieces (requirement 6). `false` gives one piece per printed part. */
export const FUSE_PARTS = true;
/** Two printed parts overlapping by at least this volume are linked, and a joint whose sides overlap by this much is reported, in mm³. */
export const FUSE_MIN_MM3 = 1;
/** A piece whose largest extent passes this is reported as `TOO_LARGE`, in millimetres. */
export const LARGE_PIECE_MM = 250;
/** Size of `exploded.png` in pixels (requirement 40). */
export const IMAGE_WIDTH = 1600;
export const IMAGE_HEIGHT = 1200;
/** Objects of one assembly are drawn apart by at least this share of the smaller object's size (requirement 41). */
export const SEPARATION_FACTOR = 0.3;
