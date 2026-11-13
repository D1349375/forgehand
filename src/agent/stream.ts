import { parseSseStream, type SseFrame } from './sse';

/**
 * Reads an event-stream response body and calls `onFrame` for each complete frame.
 * Bytes are decoded in streaming mode, so a multi-byte character split between
 * two network chunks is not corrupted. Returns whether a `done` frame was seen;
 * a stream that ends without one was cut off. Stops quietly once `signal` aborts,
 * without delivering further frames.
 */
export async function readAgentStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void,
): Promise<{ sawDone: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let sawDone = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const parsed = parseSseStream(decoder.decode(value, { stream: true }), carry);
      carry = parsed.carry;
      for (const frame of parsed.frames) {
        if (signal.aborted) return { sawDone };
        if (frame.event === 'done') sawDone = true;
        onFrame(frame);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { sawDone };
}
