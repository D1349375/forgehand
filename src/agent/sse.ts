/** One Server-Sent Events frame: the `event:` name and the joined `data:` lines. */
export interface SseFrame { event: string; data: string }

/**
 * Incremental SSE parser. Feed each decoded chunk with the `carry` returned by
 * the previous call; it returns the frames completed so far and the unfinished
 * tail. Handles frames split across chunks, multi-line `data`, several frames
 * in one chunk, and `\r\n` / `\r` line endings (including a `\r\n` split
 * between two chunks). Comment lines and frames without `data` are skipped.
 */
export function parseSseStream(chunk: string, carry: string): { frames: SseFrame[]; carry: string } {
  let text = carry + chunk;
  // A trailing CR may be the first half of a CRLF split across chunks: hold it back.
  const heldCr = text.endsWith('\r');
  if (heldCr) text = text.slice(0, -1);
  text = text.replace(/\r\n|\r/g, '\n');

  const blocks = text.split('\n\n');
  const tail = blocks.pop()! + (heldCr ? '\r' : '');
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    const frame = parseBlock(block);
    if (frame) frames.push(frame);
  }
  return { frames, carry: tail };
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}
