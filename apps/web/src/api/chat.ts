import type { ApiClient } from './client';
import { parseSse } from './sse';
import type { ChatStreamEvent, ImageInput } from './types';

export interface ChatRequest {
  prompt: string;
  profile?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  memories?: boolean;
  think?: boolean;
  images?: ImageInput[];
}

/**
 * One-shot chat stream. NEVER reconnects — a retry would re-run the prompt
 * (the runs stream is the resumable one). A transport drop before the
 * server's `done` surfaces as an error event so the UI can mark the turn.
 */
export async function* streamChat(
  client: ApiClient,
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  const response = await client.stream('/v1/chat/stream', { method: 'POST', body: request, signal });
  let finished = false;
  try {
    for await (const frame of parseSse(response.body!)) {
      if (frame.event === 'chunk') {
        const text = (frame.data as { text?: string } | undefined)?.text;
        if (typeof text === 'string') yield { type: 'chunk', text };
      } else if (frame.event === 'error') {
        const body = frame.data as { code?: string; message?: string } | undefined;
        yield { type: 'error', code: body?.code ?? 'STREAM_ERROR', message: body?.message ?? 'Stream failed.' };
      } else if (frame.event === 'done') {
        finished = true;
        yield { type: 'done' };
        return;
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  }
  if (!finished && !signal?.aborted) {
    yield { type: 'error', code: 'STREAM_INTERRUPTED', message: 'The chat stream ended before completing.' };
    yield { type: 'done' };
  }
}
