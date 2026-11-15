/// <reference lib="webworker" />

import { HandLandmarker, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import wasmLoader from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmBinary from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import type { ArmSide, ArmWorkerFrame, ArmWorkerResult, TrackingDelegate } from './arm-pose';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const modelBase = 'https://storage.googleapis.com/mediapipe-models';
const handModel = modelBase + '/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const poseModel = modelBase + '/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/** Pose only supplies the elbow direction; the hand runs on every frame. */
const POSE_INTERVAL_MS = 200;

const send = (message: ArmWorkerResult) => scope.postMessage(message);

async function initialize() {
  // Each task consumes the ESM loader's global ModuleFactory during startup.
  // Distinct module URLs let the same pinned loader register it for both.
  const wasmFiles = (task: string) => {
    const loader = new URL(wasmLoader, scope.location.href);
    loader.searchParams.set('task', task);
    return { wasmLoaderPath: loader.href, wasmBinaryPath: new URL(wasmBinary, scope.location.href).href };
  };
  // On the 2-core / 8 GB host the GPU delegate is ~10× faster per frame than
  // CPU (hand 39 ms vs 552 ms with two hands and pose on CPU; see
  // docs/PRIOR_WORK.md). GPU in a worker needs its own OffscreenCanvas; fall back
  // to CPU when WebGL is unavailable.
  const create = async (delegate: TrackingDelegate) => {
    const canvas = delegate === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {};
    const hand = await HandLandmarker.createFromOptions(wasmFiles('hand'), {
      baseOptions: { modelAssetPath: handModel, delegate }, runningMode: 'VIDEO', numHands: 1, ...canvas,
    });
    try {
      const pose = await PoseLandmarker.createFromOptions(wasmFiles('pose'), {
        baseOptions: { modelAssetPath: poseModel, delegate }, runningMode: 'VIDEO', numPoses: 1, ...canvas,
      });
      return { hand, pose, delegate };
    } catch (error) {
      hand.close();
      throw error;
    }
  };
  let tasks: Awaited<ReturnType<typeof create>>;
  try {
    tasks = await create('GPU');
  } catch (error) {
    console.warn('MediaPipe GPU delegate unavailable; using CPU', error);
    tasks = await create('CPU');
  }
  const { hand, pose, delegate } = tasks;
  // The first GPU inference compiles shaders: ~10.6 s for the hand and ~4.4 s
  // for pose on the 2-core host. Do it on a blank frame while still loading,
  // so live frames never hit the per-frame watchdog. Timestamps stay below
  // the page's performance.now() values used for live frames.
  const blank = new ImageData(256, 256);
  hand.detectForVideo(blank, 1);
  pose.detectForVideo(blank, 1);

  let body: readonly NormalizedLandmark[] = [];
  let lastPose = -Infinity;
  scope.onmessage = (event: MessageEvent<ArmWorkerFrame>) => {
    const { bitmap, width, height, timestamp, pose: wantPose } = event.data;
    try {
      const started = performance.now();
      const result = hand.detectForVideo(bitmap, timestamp);
      const hands = result.landmarks.map((points, index) => {
        const label = result.handedness[index]?.[0]?.categoryName;
        const side: ArmSide | null = label === 'Left' ? 'left' : label === 'Right' ? 'right' : null;
        return { points, world: result.worldLandmarks[index], side };
      });
      if (!hands.length) {
        body = [];
        lastPose = -Infinity;
      } else if (wantPose === false) {
        // Hand control only: skip pose, and run it at once on the next try-on frame.
        body = [];
        lastPose = -Infinity;
      } else if (timestamp - lastPose >= POSE_INTERVAL_MS) {
        body = pose.detectForVideo(bitmap, timestamp).landmarks[0] ?? [];
        lastPose = timestamp;
      }
      send({ type: 'frame', width, height, hands, body, inferenceMs: performance.now() - started });
    } catch (error) {
      console.error('MediaPipe arm tracking failed', error);
      send({ type: 'error', stage: 'track' });
    } finally {
      bitmap.close();
    }
  };
  send({ type: 'ready', delegate });
}

void initialize().catch(error => {
  console.error('MediaPipe arm tracking initialization failed', error);
  send({ type: 'error', stage: 'load' });
});
