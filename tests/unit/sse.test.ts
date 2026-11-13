import { describe, expect, it } from 'vitest';
import { serializeSseEvent } from '../../shared/agent';
import { parseSseStream, type SseFrame } from '../../src/agent/sse';

/** Feeds `chunks` through the parser the way the hook does. */
function feed(chunks: string[]) {
  const frames: SseFrame[] = [];
  let carry = '';
  for (const chunk of chunks) {
    const parsed = parseSseStream(chunk, carry);
    frames.push(...parsed.frames);
    carry = parsed.carry;
  }
  return { frames, carry };
}

describe('parseSseStream', () => {
  it('parses one full frame in one chunk', () => {
    expect(parseSseStream('event: status\ndata: {"note":"x"}\n\n', '')).toEqual({
      frames: [{ event: 'status', data: '{"note":"x"}' }],
      carry: '',
    });
  });

  it('parses the server frame format, including Traditional Chinese text', () => {
    const wire = serializeSseEvent('final', { reply: '已完成。' });
    expect(feed([wire]).frames).toEqual([{ event: 'final', data: '{"reply":"已完成。"}' }]);
  });

  it('returns nothing and carries the text when a frame is split across two chunks', () => {
    const first = parseSseStream('event: sta', '');
    expect(first).toEqual({ frames: [], carry: 'event: sta' });
    const second = parseSseStream('tus\ndata: {"note":null}\n\n', first.carry);
    expect(second).toEqual({ frames: [{ event: 'status', data: '{"note":null}' }], carry: '' });
  });

  it('joins multi-line data with a newline', () => {
    expect(parseSseStream('event: x\ndata: one\ndata: two\ndata:three\n\n', '').frames)
      .toEqual([{ event: 'x', data: 'one\ntwo\nthree' }]);
  });

  it('parses several frames in one chunk and carries a trailing partial frame', () => {
    const result = parseSseStream('event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3', '');
    expect(result.frames).toEqual([{ event: 'a', data: '1' }, { event: 'b', data: '2' }]);
    expect(result.carry).toBe('event: c\ndata: 3');
    expect(parseSseStream('\n\n', result.carry).frames).toEqual([{ event: 'c', data: '3' }]);
  });

  it('accepts \\r\\n and bare \\r line endings', () => {
    const result = parseSseStream('event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\rtail', '');
    expect(result.frames).toEqual([{ event: 'a', data: '1' }, { event: 'b', data: '2' }]);
    expect(result.carry).toBe('tail');
  });

  it('does not end a frame early when a \\r\\n pair is split between chunks', () => {
    // "event: a\r\ndata: 1\r\n\r\n" cut right after each \r
    const { frames, carry } = feed(['event: a\r', '\ndata: 1\r', '\n\r', '\n']);
    expect(frames).toEqual([{ event: 'a', data: '1' }]);
    expect(carry).toBe('');
    // A \r held back at the end of a chunk must not make a frame appear before its blank line.
    expect(feed(['event: a\r\ndata: 1\r']).frames).toEqual([]);
  });

  it('gives the same frames however the stream is cut, down to one character per chunk', () => {
    const wire = ['status', 'tool', 'final', 'done']
      .map((name, index) => serializeSseEvent(name as 'status', { n: index, text: '中文' })).join('');
    const whole = feed([wire]).frames;
    expect(whole).toHaveLength(4);
    expect(feed([...wire]).frames).toEqual(whole);
    expect(feed(wire.match(/.{1,7}/gs)!).frames).toEqual(whole);
    expect(feed([...wire.replace(/\n/g, '\r\n')]).frames).toEqual(whole);
  });

  it('skips comment lines, frames without data, and unknown fields', () => {
    expect(parseSseStream(': keep-alive\n\n', '')).toEqual({ frames: [], carry: '' });
    expect(parseSseStream('event: lonely\n\n', '').frames).toEqual([]);
    expect(parseSseStream('id: 7\nretry: 100\nevent: a\n: note\ndata: 1\n\n', '').frames)
      .toEqual([{ event: 'a', data: '1' }]);
  });

  it('defaults the event name to "message" and strips only one leading space', () => {
    expect(parseSseStream('data:  two spaces\n\n', '').frames).toEqual([{ event: 'message', data: ' two spaces' }]);
  });
});
