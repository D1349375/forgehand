import { MathUtils, Matrix4, Quaternion, Vector3 } from 'three';

export type ArmSide = 'left' | 'right';

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface HandLandmarks {
  points: readonly Landmark[];
  /** Metric hand landmarks (camera-aligned, origin at the hand centre); steadier depth than `points`. */
  world?: readonly Landmark[];
  side: ArmSide | null;
}

export interface LandmarkFrame {
  width: number;
  height: number;
  hands: readonly HandLandmarks[];
  body: readonly Landmark[];
}

export interface ArmWorkerFrame {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  timestamp: number;
  /** Run the pose model for this frame. Absent or true: yes. False: hands only. */
  pose?: boolean;
}

export type TrackingDelegate = 'GPU' | 'CPU';
export type ArmWorkerResult = { type: 'ready'; delegate: TrackingDelegate } | { type: 'error'; stage: 'load' | 'track' }
  | ({ type: 'frame'; inferenceMs: number } & LandmarkFrame);

export interface ArmPose {
  side: ArmSide;
  sourceAspect: number;
  wrist: Vector3;
  orientation: Quaternion;
  palmWidth: number;
  forearmLength: number;
  /** `elbow`: forearm from the pose model's elbow; `hand`: elbow not visible, forearm continues the hand axis. */
  source: 'elbow' | 'hand';
}

export interface ArmSample extends ArmPose {
  seenAt: number;
  /** When the tracked frame was captured (performance.now()); used to predict past the recognition delay. */
  capturedAt?: number;
  validUntil: number;
}

export const ARM_HOLD_MS = 250;
/** Forearm length relative to palm width (wrist bone to elbow ≈ 3× knuckle width for adults); assumption for the hand-only fallback. */
const HAND_ONLY_FOREARM = 3;
/**
 * A partly out-of-frame hand still gets landmarks, extrapolated past the
 * edge. The 2026-11-12 recording lost the cuff for 4 s while a fist's
 * little knuckle sat at x = 1.04 (docs/PRIOR_WORK.md), so allow a margin.
 */
const FRAME_MARGIN = 0.3;
/** Fade between the hand-axis and elbow forearm directions instead of switching (79 of 115 large jumps in that recording). */
export const ELBOW_BLEND_MS = 300;
/** A hand-only handedness label must hold this many frames before the arm changes side (it flipped 36 times there). */
export const SIDE_SWITCH_FRAMES = 6;
/**
 * A real forearm cannot roll more than ~120° between frames this close in
 * time; such a jump is a palm-facing/away ambiguity or a handedness flip
 * (most of the remaining large jumps in that recording), so keep the roll.
 */
const ROLL_FLIP_DOT = -0.5;
const ROLL_CONTINUITY_MS = 250;
const HALF_TURN_ABOUT_FOREARM = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
const armJoints = { left: { elbow: 13, wrist: 15 }, right: { elbow: 14, wrist: 16 } } as const;

function onScreen(point: Landmark | undefined): point is Landmark {
  return Boolean(point && Number.isFinite(point.z) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
}

function nearFrame(point: Landmark | undefined): point is Landmark {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
    && point.x >= -FRAME_MARGIN && point.x <= 1 + FRAME_MARGIN && point.y >= -FRAME_MARGIN && point.y <= 1 + FRAME_MARGIN);
}

function finitePoint(point: Landmark | undefined): point is Landmark {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
}

function visibleJoint(point: Landmark | undefined): point is Landmark {
  return onScreen(point) && (point.visibility ?? 1) >= 0.45;
}

/** View coordinates use source-frame heights. The camera looks along -Z. */
function imagePoint(point: Landmark, sourceAspect: number, depthOrigin: number): Vector3 {
  return new Vector3((point.x - 0.5) * sourceAspect, 0.5 - point.y, (depthOrigin - point.z) * sourceAspect);
}

/** World landmarks share the image axes (y down, smaller z nearer), so flip y and z into view space. */
function worldVector(from: Landmark, to: Landmark): Vector3 {
  return new Vector3(to.x - from.x, from.y - to.y, from.z - to.z);
}

/** Hand bones used to relate image size to metric size; all lie roughly in the palm. */
const SCALE_BONES = [[0, 5], [0, 9], [0, 17], [5, 17], [5, 9], [9, 13], [13, 17]] as const;

/**
 * Knuckle width on screen (frame-height units) from the metric landmarks:
 * metric width × (projected image length ÷ projected metric length) over the
 * palm bones. The image landmarks' relative depth exaggerated it for a fist
 * seen from the side, drawing the cuff about twice the arm's thickness in the
 * 2026-11-12 recording.
 */
function screenPalmWidth(points: readonly Landmark[], world: readonly Landmark[], sourceAspect: number): number | null {
  let image = 0;
  let metric = 0;
  for (const [a, b] of SCALE_BONES) {
    image += Math.hypot((points[b]!.x - points[a]!.x) * sourceAspect, points[b]!.y - points[a]!.y);
    metric += Math.hypot(world[b]!.x - world[a]!.x, world[b]!.y - world[a]!.y);
  }
  if (metric < 1e-4) return null;
  return worldVector(world[5]!, world[17]!).length() * image / metric;
}

function orient(side: ArmSide, across: Vector3, direction: Vector3): Quaternion | null {
  const radial = across.clone().addScaledVector(direction, -across.dot(direction));
  if (radial.length() < across.length() * 0.2) return null;
  radial.normalize();
  if (side === 'left') radial.negate();
  const normal = new Vector3().crossVectors(radial, direction);
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(radial, direction, normal));
}

/** One way to place a cuff on one detected hand, before choosing and blending. */
export interface ArmCandidate {
  /** The pose model's side when an elbow matched, otherwise the hand model's label. */
  side: ArmSide;
  sourceAspect: number;
  wrist: Vector3;
  palmWidth: number;
  /** Index → little knuckle; only its direction is used. */
  across: Vector3;
  /** Unit wrist → middle-knuckle direction, or null when degenerate. */
  handDirection: Vector3 | null;
  /** Unit elbow → wrist direction when the pose model's elbow matches this hand. */
  elbowDirection: Vector3 | null;
  elbowLength: number;
  error: number;
}

/** Candidates for every hand, best first. Both models are matched in image space before using their relative depths. */
export function armCandidates(frame: LandmarkFrame): ArmCandidate[] {
  if (!(frame.width > 0 && frame.height > 0)) return [];
  const sourceAspect = frame.width / frame.height;
  const candidates: ArmCandidate[] = [];

  for (const hand of frame.hands) {
    const [wristPoint, indexKnuckle, middleKnuckle, littleKnuckle] = [0, 5, 9, 17].map(index => hand.points[index]);
    if (!nearFrame(wristPoint) || !nearFrame(indexKnuckle) || !nearFrame(littleKnuckle)) continue;

    const wrist = imagePoint(wristPoint, sourceAspect, wristPoint.z);
    const imageAcross = imagePoint(littleKnuckle, sourceAspect, wristPoint.z).sub(imagePoint(indexKnuckle, sourceAspect, wristPoint.z));
    const world = hand.world && hand.world.length >= 21 && hand.world.every(finitePoint)
      && SCALE_BONES.every(([a, b]) => finitePoint(hand.points[a]) && finitePoint(hand.points[b])) ? hand.world : undefined;
    const palmWidth = (world && screenPalmWidth(hand.points, world, sourceAspect)) || imageAcross.length();
    if (palmWidth < 0.022 || palmWidth > 0.55) continue;
    const across = world ? worldVector(world[5]!, world[17]!) : imageAcross;

    let handDirection: Vector3 | null = null;
    if (nearFrame(middleKnuckle)) {
      const imageAxis = imagePoint(middleKnuckle, sourceAspect, wristPoint.z).sub(wrist);
      // A hand pointing at the camera foreshortens to a dot: no usable axis.
      if (imageAxis.length() >= palmWidth * 0.5) handDirection = (world ? worldVector(world[0]!, world[9]!) : imageAxis).normalize();
    }

    let matched = false;
    for (const side of ['left', 'right'] as const) {
      const joints = armJoints[side];
      const bodyWrist = frame.body[joints.wrist];
      const bodyElbow = frame.body[joints.elbow];
      if (!visibleJoint(bodyWrist) || !visibleJoint(bodyElbow)) continue;
      const wristError = Math.hypot((bodyWrist.x - wristPoint.x) * sourceAspect, bodyWrist.y - wristPoint.y);
      if (wristError > Math.max(0.04, palmWidth * 0.75)) continue;

      const elbow = imagePoint(bodyElbow, sourceAspect, bodyWrist.z);
      const direction = wrist.clone().sub(elbow);
      const projectedLength = Math.hypot(direction.x, direction.y);
      if (projectedLength < 0.045) continue;
      // Depth from each model is relative. Bound the pose model's Z estimate
      // so a noisy, foreshortened arm cannot make the shell jump in size.
      direction.z = Math.max(-projectedLength * 2, Math.min(projectedLength * 2, direction.z));
      const elbowLength = direction.length();
      const handednessPenalty = hand.side && hand.side !== side ? 0.025 : 0;
      candidates.push({ side, sourceAspect, wrist, palmWidth, across, handDirection, elbowDirection: direction.normalize(), elbowLength, error: wristError + handednessPenalty });
      matched = true;
    }
    // Ranked after every elbow-matched arm.
    if (!matched && hand.side && handDirection) {
      candidates.push({ side: hand.side, sourceAspect, wrist, palmWidth, across, handDirection, elbowDirection: null, elbowLength: 0, error: 1 });
    }
  }
  return candidates.sort((a, b) => a.error - b.error);
}

/** Blends the forearm direction `elbowWeight` of the way from the hand axis to the elbow. */
export function composeArmPose(candidate: ArmCandidate, side: ArmSide, elbowWeight: number,
  elbow: { direction: Vector3; length: number } | null = candidate.elbowDirection ? { direction: candidate.elbowDirection, length: candidate.elbowLength } : null): ArmPose | null {
  const weight = elbow ? MathUtils.clamp(elbowWeight, 0, 1) : 0;
  const hand = candidate.handDirection;
  let direction = hand && elbow ? hand.clone().lerp(elbow.direction, weight) : (elbow?.direction ?? hand)?.clone();
  if (!direction) return null;
  if (direction.length() < 1e-3) direction = (weight >= 0.5 ? elbow!.direction : hand!).clone();
  direction.normalize();
  const orientation = orient(side, candidate.across, direction);
  if (!orientation) return null;
  const handLength = candidate.palmWidth * HAND_ONLY_FOREARM;
  const forearmLength = elbow ? handLength + (elbow.length - handLength) * weight : handLength;
  return { side, sourceAspect: candidate.sourceAspect, wrist: candidate.wrist, orientation, palmWidth: candidate.palmWidth, forearmLength, source: weight >= 0.5 ? 'elbow' : 'hand' };
}

/**
 * Stateless placement for one frame. Without a visible, matching elbow the
 * forearm continues the hand axis (wrist → middle knuckle).
 */
export function estimateArmPose(frame: LandmarkFrame, preferredSide?: ArmSide): ArmPose | null {
  const candidates = armCandidates(frame);
  const candidate = candidates.find(item => item.side === preferredSide) ?? candidates[0];
  return candidate ? composeArmPose(candidate, candidate.side, candidate.elbowDirection ? 1 : 0) : null;
}

/**
 * Frame-to-frame placement: keeps the arm's side through brief handedness
 * flips and fades between the hand-axis and elbow directions.
 */
export class ArmTracker {
  private side: ArmSide | null = null;
  private pendingSide: ArmSide | null = null;
  private pendingFrames = 0;
  private elbowWeight = 0;
  private lastElbow: { direction: Vector3; length: number } | null = null;
  private lastTime: number | null = null;
  private lastPose: { orientation: Quaternion; at: number } | null = null;

  update(frame: LandmarkFrame, now: number): ArmPose | null {
    const candidates = armCandidates(frame);
    const candidate = candidates.find(item => item.side === this.side) ?? candidates[0];
    const elapsed = this.lastTime === null ? null : Math.max(0, now - this.lastTime);
    this.lastTime = now;
    if (!candidate) return null;

    // An elbow match is geometric and trusted; a hand-only label must persist.
    let side = candidate.side;
    if (!candidate.elbowDirection && this.side && side !== this.side) {
      this.pendingFrames = this.pendingSide === side ? this.pendingFrames + 1 : 1;
      this.pendingSide = side;
      if (this.pendingFrames < SIDE_SWITCH_FRAMES) side = this.side;
      else this.pendingFrames = 0;
    } else {
      this.pendingFrames = 0;
    }
    if (side !== this.side) this.lastElbow = null;
    this.side = side;

    if (candidate.elbowDirection) this.lastElbow = { direction: candidate.elbowDirection, length: candidate.elbowLength };
    const target = candidate.elbowDirection ? 1 : 0;
    if (elapsed === null) this.elbowWeight = target;
    else {
      const step = elapsed / ELBOW_BLEND_MS;
      this.elbowWeight = target > this.elbowWeight ? Math.min(target, this.elbowWeight + step) : Math.max(target, this.elbowWeight - step);
    }
    const pose = composeArmPose(candidate, side, this.elbowWeight, this.elbowWeight > 0 ? this.lastElbow : null);
    if (!pose) return null;
    if (this.lastPose && now - this.lastPose.at <= ROLL_CONTINUITY_MS) {
      const radial = new Vector3(1, 0, 0).applyQuaternion(pose.orientation);
      const previous = new Vector3(1, 0, 0).applyQuaternion(this.lastPose.orientation);
      if (radial.dot(previous) < ROLL_FLIP_DOT) pose.orientation.multiply(HALF_TURN_ABOUT_FOREARM);
    }
    this.lastPose = { orientation: pose.orientation.clone(), at: now };
    return pose;
  }
}

/** The centered crop used by .camera-video's object-fit: cover. */
export function coverFrameBounds(sourceAspect: number, canvasAspect: number) {
  return { width: Math.min(sourceAspect, canvasAspect), height: Math.min(1, sourceAspect / canvasAspect) };
}
