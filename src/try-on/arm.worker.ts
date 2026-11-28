/// <reference lib="webworker" />

import { HandLandmarker, ImageSegmenter, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import wasmLoader from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmBinary from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import { CLOTHES_CLASS, LUMA_SIZE, SEGMENT_SIZE, SKIN_CLASS } from '../../shared/fit-constants';
import { TRACKED_HANDS } from '../hands/constants';
import { cropTransform, lumaOf, quantize } from '../fit/mask';
import type { ArmSide, ArmWorkerFrame, ArmWorkerResult, SegmenterState, SegmentCrop, SegmentMask, TrackingDelegate } from './arm-pose';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const modelBase = 'https://storage.googleapis.com/mediapipe-models';
const handModel = modelBase + '/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const poseModel = modelBase + '/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
/**
 * Wrist segmenter of body fit (spec body-fit, design 4.2): 16.37 MB, loaded only when a frame asks for `segment`.
 * URL: checked by the spec reviewer with a HEAD request on 2026-11-26 (HTTP 200, 16,371,837 bytes), and loaded by this worker on a real
 * device on 2026-11-28 (body-fit Task 2): the segmenter reached `ready` with it. Verified.
 */
const segmentModel = modelBase + '/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite';

/** Pose only supplies the elbow direction; the hand runs on every frame. */
const POSE_INTERVAL_MS = 200;

/** A message with no transfer list goes out with exactly one argument, as before body fit. */
const send = (message: ArmWorkerResult, transfer?: Transferable[]) => transfer ? scope.postMessage(message, transfer) : scope.postMessage(message);

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
      baseOptions: { modelAssetPath: handModel, delegate }, runningMode: 'VIDEO', numHands: TRACKED_HANDS, ...canvas,
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

  // Body fit (design 4.2). Nothing below runs, and no canvas or segmenter exists, until a frame asks for `segment`.
  let segmenter: ImageSegmenter | null = null;
  let segmenterState: SegmenterState | 'idle' = 'idle';
  let surface: { cropCanvas: OffscreenCanvas; cropContext: OffscreenCanvasRenderingContext2D; lumaContext: OffscreenCanvasRenderingContext2D } | null = null;
  const setSegmenterState = (state: SegmenterState) => {
    segmenterState = state;
    send({ type: 'segmenter', state });
  };
  const closeMasks = (result: { confidenceMasks?: { close(): void }[] }) => { for (const mask of result.confidenceMasks ?? []) mask.close(); };
  async function loadSegmenter() {
    setSegmenterState('loading');
    try {
      const canvas = delegate === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {};
      const created = await ImageSegmenter.createFromOptions(wasmFiles('segment'), {
        baseOptions: { modelAssetPath: segmentModel, delegate }, runningMode: 'VIDEO',
        outputConfidenceMasks: true, outputCategoryMask: false, ...canvas,
      });
      try {
        // Compile the shaders on a blank frame, like the hand and pose models.
        closeMasks(created.segmentForVideo(blank, 1));
      } catch (error) {
        created.close();
        throw error;
      }
      segmenter = created;
      setSegmenterState('ready');
    } catch (error) {
      console.warn('MediaPipe segmenter unavailable', error);
      setSegmenterState('error');
    }
  }
  /** Draws the crop, reads its luma, and, when the segmenter is ready, segments it. A failure here never stops hand tracking. */
  function segmentFrame(bitmap: ImageBitmap, width: number, height: number, timestamp: number, request: SegmentCrop): { luma?: number; mask?: SegmentMask } {
    try {
      if (!surface) {
        const cropCanvas = new OffscreenCanvas(SEGMENT_SIZE, SEGMENT_SIZE);
        const lumaCanvas = new OffscreenCanvas(LUMA_SIZE, LUMA_SIZE);
        const cropContext = cropCanvas.getContext('2d', { willReadFrequently: true });
        const lumaContext = lumaCanvas.getContext('2d', { willReadFrequently: true });
        if (!cropContext || !lumaContext) throw new Error('no 2d canvas in the worker');
        lumaContext.imageSmoothingQuality = 'high';
        surface = { cropCanvas, cropContext, lumaContext };
      }
      const { cropCanvas, cropContext, lumaContext } = surface;
      cropContext.setTransform(1, 0, 0, 1, 0, 0);
      cropContext.fillStyle = '#000';
      cropContext.fillRect(0, 0, SEGMENT_SIZE, SEGMENT_SIZE);
      cropContext.setTransform(...cropTransform(request, SEGMENT_SIZE));
      cropContext.drawImage(bitmap, 0, 0, width, height);
      lumaContext.drawImage(cropCanvas, 0, 0, LUMA_SIZE, LUMA_SIZE);
      const luma = lumaOf(lumaContext.getImageData(0, 0, LUMA_SIZE, LUMA_SIZE).data);
      if (segmenterState === 'idle') void loadSegmenter();
      if (segmenterState !== 'ready' || !segmenter) return { luma };
      const started = performance.now();
      const result = segmenter.segmentForVideo(cropCanvas, timestamp);
      try {
        const skin = result.confidenceMasks?.[SKIN_CLASS];
        const clothes = result.confidenceMasks?.[CLOTHES_CLASS];
        if (!skin || !clothes || skin.width !== SEGMENT_SIZE || skin.height !== SEGMENT_SIZE || clothes.width !== SEGMENT_SIZE || clothes.height !== SEGMENT_SIZE) {
          throw new Error('unexpected segmenter output');
        }
        const planes = { skin: quantize(skin.getAsFloat32Array()), clothes: quantize(clothes.getAsFloat32Array()) };
        return { luma, mask: { size: SEGMENT_SIZE, crop: request, ...planes, ms: performance.now() - started, timestamp } };
      } finally {
        closeMasks(result);
      }
    } catch (error) {
      console.warn('MediaPipe segmentation failed', error);
      segmenter?.close();
      segmenter = null;
      if (segmenterState !== 'error') setSegmenterState('error');
      return {};
    }
  }

  let body: readonly NormalizedLandmark[] = [];
  let lastPose = -Infinity;
  scope.onmessage = (event: MessageEvent<ArmWorkerFrame>) => {
    const { bitmap, width, height, timestamp, pose: wantPose, segment } = event.data;
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
      const inferenceMs = performance.now() - started;
      if (!segment) {
        send({ type: 'frame', width, height, hands, body, inferenceMs });
      } else {
        const { luma, mask } = segmentFrame(bitmap, width, height, timestamp, segment);
        send({ type: 'frame', width, height, hands, body, inferenceMs, ...(luma === undefined ? {} : { luma }), ...(mask ? { mask } : {}) },
          mask ? [mask.skin.buffer, mask.clothes.buffer] : undefined);
      }
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
