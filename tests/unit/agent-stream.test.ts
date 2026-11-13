import { describe, expect, it } from 'vitest';
import { serializeSseEvent } from '../../shared/agent';
import { parseAgentEvent } from '../../src/agent/events';
import type { SseFrame } from '../../src/agent/sse';
import { readAgentStream } from '../../src/agent/stream';

/** A response body that yields the given byte chunks, like a network stream. */
function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[index++]!);
    },
  });
}
const bytes = (text: string) => new TextEncoder().encode(text);
const collect = async (body: ReadableStream<Uint8Array>, signal = new AbortController().signal) => {
  const frames: SseFrame[] = [];
  const { sawDone } = await readAgentStream(body, signal, frame => frames.push(frame));
  return { frames, sawDone };
};

describe('readAgentStream', () => {
  const wire = serializeSseEvent('status', { note: '處理中' }) + serializeSseEvent('final', { reply: '完成。' }) + serializeSseEvent('done', {});

  it('delivers every frame and reports that done was seen', async () => {
    const { frames, sawDone } = await collect(bodyOf([bytes(wire)]));
    expect(frames.map(frame => frame.event)).toEqual(['status', 'final', 'done']);
    expect(sawDone).toBe(true);
  });

  it('keeps multi-byte characters intact when the network splits them between chunks', async () => {
    const all = bytes(wire);
    const oneByteAtATime = Array.from(all, byte => new Uint8Array([byte]));
    const { frames, sawDone } = await collect(bodyOf(oneByteAtATime));
    expect(sawDone).toBe(true);
    expect(frames.map(parseAgentEvent)).toEqual([
      { type: 'status', note: '處理中' }, { type: 'final', reply: '完成。' }, { type: 'done' },
    ]);
  });

  it('reports a stream that ends without done', async () => {
    const cut = serializeSseEvent('status', { note: '處理中' }) + 'event: final\ndata: {"rep';
    const { frames, sawDone } = await collect(bodyOf([bytes(cut)]));
    expect(frames).toHaveLength(1);
    expect(sawDone).toBe(false);
  });

  it('delivers no further frames once the signal aborts', async () => {
    const controller = new AbortController();
    const frames: SseFrame[] = [];
    const body = bodyOf([bytes(wire)]);
    const { sawDone } = await readAgentStream(body, controller.signal, frame => {
      frames.push(frame);
      controller.abort(); // cancel while the first chunk's frames are being delivered
    });
    expect(frames).toHaveLength(1);
    expect(sawDone).toBe(false);
  });
});
