import type { SseFrame } from './types';

/**
 * Parse a text/event-stream body into frames. Pure with respect to transport:
 * feed it any ReadableStream of bytes. Handles frames split across chunks,
 * CRLF line endings, multi-line `data:` fields, comment heartbeats (skipped),
 * and control-only `retry:` blocks (surfaced via `retryMs`). `data` is JSON-
 * parsed when possible (the marifold service always sends JSON), otherwise
 * the raw string is passed through. A partial frame at stream end is dropped.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF; hold back a trailing CR that may be half of one.
      buffer = buffer.replace(/\r\n/g, '\n');
      let holdback = '';
      if (buffer.endsWith('\r')) {
        holdback = '\r';
        buffer = buffer.slice(0, -1);
      }
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame) yield frame;
      }
      buffer += holdback;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseFrame | undefined {
  let id: number | undefined;
  let event: string | undefined;
  let retryMs: number | undefined;
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    // Per the SSE spec a single space after the colon is stripped.
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed)) id = parsed;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'retry') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed) && parsed >= 0) retryMs = parsed;
    }
  }

  if (dataLines.length === 0 && event === undefined && retryMs === undefined && id === undefined) {
    return undefined;
  }
  return {
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(dataLines.length > 0 ? { data: parseData(dataLines.join('\n')) } : {}),
    ...(retryMs !== undefined ? { retryMs } : {}),
  };
}

function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
