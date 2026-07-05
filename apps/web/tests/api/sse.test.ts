import { describe, expect, it } from 'vitest';
import { parseSse } from '../../src/api/sse';
import type { SseFrame } from '../../src/api/types';

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSse(byteStream(chunks))) frames.push(frame);
  return frames;
}

describe('parseSse', () => {
  it('parses a complete frame with id, event, and JSON data', async () => {
    const frames = await collect(['id: 7\nevent: text\ndata: {"type":"text","text":"hi"}\n\n']);
    expect(frames).toEqual([{ id: 7, event: 'text', data: { type: 'text', text: 'hi' } }]);
  });

  it('reassembles frames split across arbitrary chunk boundaries', async () => {
    const frames = await collect(['id: 1\neve', 'nt: chunk\ndata: {"te', 'xt":"ab"}\n', '\nid: 2\nevent: done\ndata: {}\n\n']);
    expect(frames).toEqual([
      { id: 1, event: 'chunk', data: { text: 'ab' } },
      { id: 2, event: 'done', data: {} },
    ]);
  });

  it('handles CRLF line endings, including a CR split from its LF', async () => {
    const frames = await collect(['event: chunk\r\ndata: {"text":"a"}\r', '\n\r\nevent: done\r\ndata: {}\r\n\r\n']);
    expect(frames).toEqual([
      { event: 'chunk', data: { text: 'a' } },
      { event: 'done', data: {} },
    ]);
  });

  it('joins multi-line data fields with newlines', async () => {
    const frames = await collect(['event: note\ndata: first\ndata: second\n\n']);
    expect(frames).toEqual([{ event: 'note', data: 'first\nsecond' }]);
  });

  it('skips heartbeat comments entirely', async () => {
    const frames = await collect([': ping\n\n: ping\n\nevent: done\ndata: {}\n\n']);
    expect(frames).toEqual([{ event: 'done', data: {} }]);
  });

  it('surfaces retry hints as control frames', async () => {
    const frames = await collect(['retry: 3000\n\nevent: done\ndata: {}\n\n']);
    expect(frames).toEqual([{ retryMs: 3000 }, { event: 'done', data: {} }]);
  });

  it('passes non-JSON data through as a raw string', async () => {
    const frames = await collect(['event: raw\ndata: not json\n\n']);
    expect(frames).toEqual([{ event: 'raw', data: 'not json' }]);
  });

  it('drops a partial frame when the stream ends mid-block', async () => {
    const frames = await collect(['event: done\ndata: {}\n\nevent: truncated\ndata: {"x":']);
    expect(frames).toEqual([{ event: 'done', data: {} }]);
  });
});
