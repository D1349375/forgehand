import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createArmPreview } from '../../src/scene/arm-preview';
import { ARM_HOLD_MS, ArmTracker, coverFrameBounds, ELBOW_BLEND_MS, estimateArmPose, SIDE_SWITCH_FRAMES, type Landmark, type LandmarkFrame } from '../../src/try-on/arm-pose';

function frame(rolled = false): LandmarkFrame {
  const point = (x: number, y: number, z = 0): Landmark => ({ x, y, z, visibility: 1 });
  const hand = Array.from({ length: 21 }, () => point(0.5, 0.55));
  hand[0] = point(0.5, 0.55);
  hand[5] = rolled ? point(0.5, 0.48, -0.05) : point(0.55, 0.48);
  hand[17] = rolled ? point(0.5, 0.48, 0.05) : point(0.45, 0.48);
  const body = Array.from({ length: 33 }, () => point(0.1, 0.4));
  body[13] = point(0.5, 0.82, -0.15);
  body[15] = point(0.51, 0.55, -0.15);
  return { width: 1280, height: 720, hands: [{ points: hand, side: 'left' }], body };
}

describe('webcam arm preview', () => {
  it('anchors at the hand wrist and uses the matching elbow in image coordinates', () => {
    const arm = estimateArmPose(frame())!;
    expect(arm.side).toBe('left');
    expect(arm.wrist.x).toBeCloseTo(0);
    expect(arm.wrist.y).toBeCloseTo(-0.05);
    expect(arm.wrist.z).toBe(0);
    expect(arm.forearmLength).toBeCloseTo(0.27);
    expect(new Vector3(0, 1, 0).applyQuaternion(arm.orientation).y).toBeCloseTo(1);
  });

  it('rotates about the forearm as the across-palm direction turns in depth', () => {
    const faceOn = estimateArmPose(frame())!;
    const rolled = estimateArmPose(frame(true))!;
    expect(faceOn.orientation.angleTo(rolled.orientation)).toBeCloseTo(Math.PI / 2);
    expect(rolled.palmWidth).toBeCloseTo(faceOn.palmWidth);
    expect(rolled.wrist.distanceTo(faceOn.wrist)).toBe(0);
  });

  it('without a visible, matching elbow, continues the forearm along the hand axis', () => {
    const visible = frame();
    const occludedBody = visible.body.map((point, index) => index === 13 ? { ...point, visibility: 0.1 } : point);
    const unmatchedBody = visible.body.map((point, index) => index === 15 ? { ...point, x: 0.9 } : point);
    // The fixture's middle knuckle sits on the wrist, so there is no hand axis either.
    expect(estimateArmPose({ ...visible, body: occludedBody })).toBeNull();
    expect(estimateArmPose({ ...visible, body: unmatchedBody })).toBeNull();

    const hand = visible.hands[0]!;
    const points = hand.points.map((point, index) => index === 9 ? { ...point, y: 0.45 } : point);
    for (const body of [occludedBody, unmatchedBody, []]) {
      const arm = estimateArmPose({ ...visible, body, hands: [{ ...hand, points }] })!;
      expect(arm.source).toBe('hand');
      expect(arm.side).toBe('left');
      expect(arm.forearmLength).toBeCloseTo(arm.palmWidth * 3);
      expect(new Vector3(0, 1, 0).applyQuaternion(arm.orientation).y).toBeCloseTo(1);
    }
    // A matching elbow still wins over the hand axis.
    expect(estimateArmPose({ ...visible, hands: [{ ...hand, points }] })!.source).toBe('elbow');
  });

  it('eases toward a velocity-predicted wrist between tracking results', () => {
    const preview = createArmPreview();
    const base = estimateArmPose(frame())!;
    const at = (x: number, t: number) => ({ ...base, wrist: base.wrist.clone().setX(x), seenAt: t + 40, capturedAt: t, validUntil: t + 2000 });
    try {
      preview.update(at(0, 0), true, 40);
      preview.update(at(0.05, 100), true, 140);
      // Moving +0.0005/ms: by 220 ms it is predicted past the last result (0.05).
      let changed = false;
      for (let now = 156; now <= 220; now += 16) changed = preview.update(null, true, now) || changed;
      expect(changed).toBe(true);
      expect(preview.position.x).toBeGreaterThan(0.05);
      // Prediction is capped, so a lost hand does not drift away.
      for (let now = 236; now <= 600; now += 16) preview.update(null, true, now);
      expect(preview.position.x).toBeLessThanOrEqual(0.05 + 0.0005 * 120 * 0.6 + 1e-6);
    } finally {
      preview.dispose();
    }
  });

  // Cases below come from the 2026-11-12 webcam recording (docs/PRIOR_WORK.md).
  const handOnly = (side: 'left' | 'right' = 'left', axisX = 0): LandmarkFrame => {
    const base = frame();
    const points = base.hands[0]!.points.map((point, index) => index === 9 ? { ...point, x: 0.5 + axisX, y: 0.45 } : point);
    return { ...base, body: [], hands: [{ points, side }] };
  };
  const forearm = (pose: { orientation: import('three').Quaternion }) => new Vector3(0, 1, 0).applyQuaternion(pose.orientation);

  it('keeps a hand whose knuckles are extrapolated just past the frame edge', () => {
    const base = handOnly();
    const shifted = base.hands[0]!.points.map(point => ({ ...point, x: point.x + 0.5 }));
    expect(shifted[17]!.x).toBeLessThan(1);
    const edge = shifted.map((point, index) => index === 5 ? { ...point, x: 1.06 } : point);
    expect(estimateArmPose({ ...base, hands: [{ points: edge, side: 'left' }] })).not.toBeNull();
    const far = shifted.map((point, index) => index === 5 ? { ...point, x: 1.6 } : point);
    expect(estimateArmPose({ ...base, hands: [{ points: far, side: 'left' }] })).toBeNull();
  });

  it('fades between the hand axis and a newly visible elbow instead of switching', () => {
    const tracker = new ArmTracker();
    const tilted = handOnly('left', 0.08);
    const withElbow = { ...frame(), hands: tilted.hands };
    const handAxis = forearm(tracker.update(tilted, 0)!);
    const elbowAxis = forearm(estimateArmPose(withElbow)!);
    expect(handAxis.angleTo(elbowAxis)).toBeGreaterThan(0.3);
    const halfway = forearm(tracker.update(withElbow, ELBOW_BLEND_MS / 2)!);
    expect(halfway.angleTo(handAxis)).toBeGreaterThan(0.05);
    expect(halfway.angleTo(elbowAxis)).toBeGreaterThan(0.05);
    expect(forearm(tracker.update(withElbow, ELBOW_BLEND_MS * 1.5)!).angleTo(elbowAxis)).toBeLessThan(1e-6);
  });

  it('keeps its side through a brief handedness flip and follows a lasting one', () => {
    const tracker = new ArmTracker();
    expect(tracker.update(handOnly('left'), 0)!.side).toBe('left');
    for (let index = 1; index < SIDE_SWITCH_FRAMES; index++) expect(tracker.update(handOnly('right'), index * 33)!.side).toBe('left');
    expect(tracker.update(handOnly('right'), SIDE_SWITCH_FRAMES * 33)!.side).toBe('right');
  });

  it('does not roll the cuff half a turn between consecutive frames', () => {
    const tracker = new ArmTracker();
    const first = tracker.update(handOnly('left'), 0)!;
    // A palm facing/away ambiguity reverses the across-palm direction in one frame.
    const reversed = handOnly('left');
    const points = reversed.hands[0]!.points.map((point, index) => index === 5 ? { ...point, x: 0.45 } : index === 17 ? { ...point, x: 0.55 } : point);
    const next = tracker.update({ ...reversed, hands: [{ points, side: 'left' }] }, 33)!;
    expect(next.orientation.angleTo(first.orientation)).toBeLessThan(0.1);
    // After a real gap the new estimate is taken as is.
    const later = new ArmTracker();
    later.update(handOnly('left'), 0);
    expect(later.update({ ...reversed, hands: [{ points, side: 'left' }] }, 1000)!.orientation.angleTo(first.orientation)).toBeGreaterThan(3);
  });

  it('uses the same centered crop as the video element in either aspect ratio', () => {
    expect(coverFrameBounds(16 / 9, 1)).toEqual({ width: 1, height: 1 });
    expect(coverFrameBounds(1, 16 / 9)).toEqual({ width: 1, height: 9 / 16 });
  });

  it('holds briefly on loss, fades, and removes the overlay immediately on stop', () => {
    const preview = createArmPreview();
    const sample = { ...estimateArmPose(frame())!, seenAt: 100, validUntil: 1800 };
    try {
      preview.update(sample, true, 100);
      expect(preview.opacity).toBe(1);
      preview.update(sample, true, 800);
      expect(preview.opacity).toBe(1);
      preview.update(null, true, 810);
      preview.update(null, true, 810 + ARM_HOLD_MS);
      expect(preview.opacity).toBe(1);
      preview.update(null, true, 810 + ARM_HOLD_MS + 90);
      expect(preview.opacity).toBeCloseTo(0.5);
      preview.update(null, true, 810 + ARM_HOLD_MS + 180);
      expect(preview.opacity).toBe(0);
      preview.update({ ...sample, seenAt: 1300 }, true, 1300);
      expect(preview.opacity).toBe(1);
      preview.update(null, false, 1301);
      expect(preview.opacity).toBe(0);
    } finally {
      preview.dispose();
    }
  });
});
