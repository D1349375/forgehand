import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOTHES_CLASS, SEGMENT_SIZE, SKIN_CLASS } from '../../shared/fit-constants';
import { cropTransform } from '../../src/fit/mask';
import type { ArmWorkerFrame, ArmWorkerResult, SegmentCrop } from '../../src/try-on/arm-pose';

/**
 * The real arm.worker.ts, run in Node with a fake MediaPipe and fake canvases (no model is downloaded). It proves that a
 * frame without `segment` produces exactly the messages the worker produced before body fit, and that a frame with
 * `segment` loads the segmenter lazily, never stops hand tracking, and hands over masks as transferred bytes.
 */
const HAND = { points: [{ x: 0.5, y: 0.5, z: 0 }], world: [{ x: 0, y: 0, z: 0 }] };
const CROP: SegmentCrop = { x: 320, y: 240, size: 160, angleDeg: 30 };

class FakeContext {
  calls: [string, ...unknown[]][] = [];
  fillStyle = '';
  imageSmoothingQuality = '';
  pixel = 128;
  setTransform = (...args: number[]) => { this.calls.push(['setTransform', ...args]); };
  fillRect = (...args: number[]) => { this.calls.push(['fillRect', ...args]); };
  drawImage = (...args: unknown[]) => { this.calls.push(['drawImage', ...args]); };
  getImageData = (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(this.pixel) });
}
class FakeCanvas {
  static all: FakeCanvas[] = [];
  readonly context = new FakeContext();
  constructor(readonly width: number, readonly height: number) { FakeCanvas.all.push(this); }
  getContext() { return this.context; }
}

function fakeMask(fill: (index: number) => number) {
  const values = new Float32Array(SEGMENT_SIZE * SEGMENT_SIZE).map((_, index) => fill(index));
  return { width: SEGMENT_SIZE, height: SEGMENT_SIZE, getAsFloat32Array: () => values, close: vi.fn() };
}

interface Rig {
  post: ReturnType<typeof vi.fn>;
  scope: { postMessage: ReturnType<typeof vi.fn>; location: { href: string }; onmessage: ((event: { data: ArmWorkerFrame }) => void) | null };
  hand: { detectForVideo: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  pose: { detectForVideo: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  segmenter: { segmentForVideo: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  segmenterCreate: ReturnType<typeof vi.fn>;
  masks: ReturnType<typeof fakeMask>[];
  /** Resolve or reject the pending segmenter load. */
  finishLoad: (error?: Error) => void;
}

let rig: Rig;
/** Every postMessage call so far: its arguments. */
const sentCalls = (): unknown[][] => rig.post.mock.calls as unknown[][];

async function startWorker(options: { deferSegmenter?: boolean; segmenterFails?: boolean } = {}): Promise<void> {
  FakeCanvas.all = [];
  const post = vi.fn();
  const scope = { postMessage: post, location: { href: 'http://localhost:5197/src/try-on/arm.worker.ts' }, onmessage: null as Rig['scope']['onmessage'] };
  const masks = Array.from({ length: 6 }, (_, klass) => fakeMask(index => klass === SKIN_CLASS ? (index % 256) / 255 : klass === CLOTHES_CLASS ? 0.5 : 0));
  const segmenter = { segmentForVideo: vi.fn(() => ({ confidenceMasks: masks })), close: vi.fn() };
  let finishLoad: Rig['finishLoad'] = () => undefined;
  const segmenterCreate = vi.fn(() => options.deferSegmenter
    ? new Promise((resolve, reject) => { finishLoad = error => error ? reject(error) : resolve(segmenter); })
    : options.segmenterFails ? Promise.reject(new Error('no model')) : Promise.resolve(segmenter));
  const hand = {
    detectForVideo: vi.fn(() => ({ landmarks: [HAND.points], handedness: [[{ categoryName: 'Right' }]], worldLandmarks: [HAND.world] })),
    close: vi.fn(),
  };
  const pose = { detectForVideo: vi.fn(() => ({ landmarks: [[{ x: 0.1, y: 0.2, z: 0 }]] })), close: vi.fn() };
  vi.stubGlobal('self', scope);
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('ImageData', class { constructor(readonly width: number, readonly height: number) {} });
  vi.doMock('@mediapipe/tasks-vision', () => ({
    HandLandmarker: { createFromOptions: vi.fn(async () => hand) },
    PoseLandmarker: { createFromOptions: vi.fn(async () => pose) },
    ImageSegmenter: { createFromOptions: segmenterCreate },
  }));
  vi.resetModules();
  await import('../../src/try-on/arm.worker');
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'ready', delegate: 'GPU' }));
  rig = { post, scope, hand, pose, segmenter, segmenterCreate, masks, get finishLoad() { return finishLoad; } } as Rig;
}

function frame(extra: Partial<ArmWorkerFrame> = {}, timestamp = 1000) {
  const bitmap = { close: vi.fn(), width: 640, height: 480 };
  rig.scope.onmessage!({ data: { bitmap: bitmap as unknown as ImageBitmap, width: 1280, height: 960, timestamp, ...extra } });
  return bitmap;
}
const frames = () => sentCalls().map(call => call[0] as ArmWorkerResult).filter(message => message.type === 'frame') as Extract<ArmWorkerResult, { type: 'frame' }>[];
const messagesOfType = (type: string) => sentCalls().map(call => call[0] as { type: string }).filter(message => message.type === type);

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => {
  vi.doUnmock('@mediapipe/tasks-vision');
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('a frame without segment (today\'s messages)', () => {
  it('answers with exactly the fields the worker always sent, in one-argument messages, and creates nothing extra', async () => {
    await startWorker();
    const sizesBefore = FakeCanvas.all.map(canvas => canvas.width);
    const first = frame({ pose: true }, 1000);
    frame({ pose: false }, 1033);
    frame({ segment: null }, 1066);
    frame({}, 1300);
    expect(sentCalls()[0]).toEqual([{ type: 'ready', delegate: 'GPU' }]);
    expect(sentCalls()).toHaveLength(5);
    for (const call of sentCalls().slice(1)) {
      expect(call).toHaveLength(1);
      expect(Object.keys(call[0] as object).sort()).toEqual(['body', 'hands', 'height', 'inferenceMs', 'type', 'width']);
      expect(call[0]).toEqual({ type: 'frame', width: 1280, height: 960, hands: [{ ...HAND, side: 'right' }], body: expect.any(Array), inferenceMs: expect.any(Number) });
    }
    // Pose runs on the first try-on frame, is skipped for hand control only, and runs again after its 200 ms interval.
    expect(frames().map(message => message.body.length)).toEqual([1, 0, 1, 1]);
    expect(rig.hand.detectForVideo).toHaveBeenCalledTimes(1 + 4);
    expect(first.close).toHaveBeenCalledTimes(1);
    // No segmenter, no crop canvas, no luma canvas, no extra message.
    expect(rig.segmenterCreate).not.toHaveBeenCalled();
    expect(FakeCanvas.all.map(canvas => canvas.width)).toEqual(sizesBefore);
    expect(FakeCanvas.all.every(canvas => canvas.context.calls.length === 0)).toBe(true);
    expect(messagesOfType('segmenter')).toEqual([]);
  });
  it('closes the bitmap and reports a tracking error exactly as before when the hand model throws', async () => {
    await startWorker();
    rig.hand.detectForVideo.mockImplementationOnce(() => { throw new Error('boom'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bitmap = frame();
    expect(sentCalls()[sentCalls().length - 1]).toEqual([{ type: 'error', stage: 'track' }]);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});

describe('a frame with segment', () => {
  it('loads the segmenter on the first request, answers with a luma and no mask meanwhile, then sends masks', async () => {
    await startWorker({ deferSegmenter: true });
    frame({ segment: CROP }, 1000);
    expect(messagesOfType('segmenter')).toEqual([{ type: 'segmenter', state: 'loading' }]);
    expect(rig.segmenterCreate).toHaveBeenCalledTimes(1);
    const [wasm, options] = rig.segmenterCreate.mock.calls[0] as unknown as [{ wasmLoaderPath: string }, Record<string, unknown>];
    expect(wasm.wasmLoaderPath).toContain('task=segment');
    expect(options).toMatchObject({
      baseOptions: { delegate: 'GPU', modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite' },
      runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    const loading = frames()[0]!;
    expect(loading.mask).toBeUndefined();
    expect(loading.luma).toBeCloseTo(128 * (0.2126 + 0.7152 + 0.0722) / 255, 6);
    // More requests while it loads do not start a second load or post another state.
    frame({ segment: CROP }, 1033);
    expect(rig.segmenterCreate).toHaveBeenCalledTimes(1);
    expect(messagesOfType('segmenter')).toHaveLength(1);
    expect(frames()[1]!.mask).toBeUndefined();
    expect(rig.segmenter.segmentForVideo).not.toHaveBeenCalled();
    rig.finishLoad();
    await vi.waitFor(() => expect(messagesOfType('segmenter')).toEqual([{ type: 'segmenter', state: 'loading' }, { type: 'segmenter', state: 'ready' }]));
    // The warm-up ran on a blank frame at timestamp 1 and its masks were closed.
    expect(rig.segmenter.segmentForVideo).toHaveBeenCalledTimes(1);
    expect(rig.segmenter.segmentForVideo.mock.calls[0]![1]).toBe(1);
    for (const mask of rig.masks) expect(mask.close).toHaveBeenCalledTimes(1);

    const bitmap = frame({ segment: CROP }, 2000);
    const answer = frames()[2]!;
    expect(answer.mask).toBeDefined();
    expect(answer.mask).toMatchObject({ size: SEGMENT_SIZE, crop: CROP, timestamp: 2000 });
    expect(answer.mask!.ms).toBeGreaterThanOrEqual(0);
    expect(answer.mask!.skin).toBeInstanceOf(Uint8Array);
    expect(answer.mask!.skin).toHaveLength(SEGMENT_SIZE * SEGMENT_SIZE);
    expect([...answer.mask!.skin.slice(0, 300)]).toEqual(Array.from({ length: 300 }, (_, index) => index % 256));
    expect(answer.mask!.clothes.every(value => value === 128)).toBe(true);
    expect(answer.luma).toBeDefined();
    // The masks are transferred, not copied.
    const call = sentCalls()[sentCalls().length - 1]!;
    expect(call).toHaveLength(2);
    expect(call[1]).toEqual([answer.mask!.skin.buffer, answer.mask!.clothes.buffer]);
    // The segmenter saw the crop canvas at the frame's timestamp, and every mask it returned was closed again.
    const [canvasArg, timestampArg] = rig.segmenter.segmentForVideo.mock.calls[1] as unknown as [FakeCanvas, number];
    expect(canvasArg).toBeInstanceOf(FakeCanvas);
    expect(canvasArg.width).toBe(SEGMENT_SIZE);
    expect(timestampArg).toBe(2000);
    for (const mask of rig.masks) expect(mask.close).toHaveBeenCalledTimes(2);
    // The crop was drawn through the shared transform, over a cleared canvas, from the bitmap at frame size.
    const calls = canvasArg.context.calls;
    expect(calls.filter(entry => entry[0] === 'fillRect').at(-1)).toEqual(['fillRect', 0, 0, SEGMENT_SIZE, SEGMENT_SIZE]);
    expect(calls.filter(entry => entry[0] === 'setTransform').at(-1)).toEqual(['setTransform', ...cropTransform(CROP)]);
    expect(calls.filter(entry => entry[0] === 'drawImage').at(-1)).toEqual(['drawImage', bitmap, 0, 0, 1280, 960]);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    // Hand tracking keeps its own fields and cost.
    expect(answer.hands).toEqual([{ ...HAND, side: 'right' }]);
    expect(answer.inferenceMs).toEqual(expect.any(Number));
  });
  it('reads the luma of the crop even when the segmenter never loads, and keeps tracking after a failed load', async () => {
    await startWorker({ segmenterFails: true });
    frame({ segment: CROP }, 1000);
    await vi.waitFor(() => expect(messagesOfType('segmenter')).toEqual([{ type: 'segmenter', state: 'loading' }, { type: 'segmenter', state: 'error' }]));
    frame({ segment: CROP }, 1100);
    frame({}, 1200);
    expect(frames()).toHaveLength(3);
    expect(frames()[1]!.luma).toBeDefined();
    expect(frames()[1]!.mask).toBeUndefined();
    expect(Object.keys(frames()[2]!).sort()).toEqual(['body', 'hands', 'height', 'inferenceMs', 'type', 'width']);
    // It does not try again.
    expect(rig.segmenterCreate).toHaveBeenCalledTimes(1);
    expect(messagesOfType('error')).toEqual([]);
  });
  it('turns a failing segmentation into the error state and still answers the frame', async () => {
    await startWorker();
    frame({ segment: CROP }, 1000);
    await vi.waitFor(() => expect(messagesOfType('segmenter')).toHaveLength(2));
    rig.segmenter.segmentForVideo.mockImplementationOnce(() => ({ confidenceMasks: rig.masks.slice(0, 3) }));
    const bitmap = frame({ segment: CROP }, 2000);
    expect(messagesOfType('segmenter')[2]).toEqual({ type: 'segmenter', state: 'error' });
    expect(frames()).toHaveLength(2);
    expect(frames()[1]!.mask).toBeUndefined();
    expect(frames()[1]!.hands).toHaveLength(1);
    expect(rig.segmenter.close).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    // The masks it did return were closed.
    for (const mask of rig.masks.slice(0, 3)) expect(mask.close).toHaveBeenCalledTimes(2);
    frame({ segment: CROP }, 3000);
    expect(frames()[2]!.mask).toBeUndefined();
    expect(rig.segmenter.segmentForVideo).toHaveBeenCalledTimes(2);
  });
});
