import type { ApiClient } from './client';
import { parseSse } from './sse';
import type { AgentUsage, ChatStreamEvent, ImageInput } from './types';

export interface ChatRequest {
  prompt: string;
  profile?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  userTurn?: string;
  isolated?: boolean;
  replaceUserTurnIndex?: number;
  memories?: boolean;
  think?: boolean;
  images?: ImageInput[];
  originalImages?: boolean;
  instructions?: string[];
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
      } else if (frame.event === 'reasoning') {
        const text = (frame.data as { text?: string } | undefined)?.text;
        if (typeof text === 'string') yield { type: 'reasoning', text };
      } else if (frame.event === 'error') {
        const body = frame.data as { code?: string; message?: string } | undefined;
        yield { type: 'error', code: body?.code ?? 'STREAM_ERROR', message: body?.message ?? 'Stream failed.' };
      } else if (frame.event === 'done') {
        const body = frame.data as { usage?: unknown; latencyMs?: unknown } | undefined;
        const usage = parseUsage(body?.usage);
        finished = true;
        yield {
          type: 'done',
          ...(usage ? { usage } : {}),
          ...(typeof body?.latencyMs === 'number' && Number.isFinite(body.latencyMs)
            ? { latencyMs: body.latencyMs }
            : {}),
        };
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

function parseUsage(value: unknown): AgentUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage: AgentUsage = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedInputTokens',
    'reasoningTokens',
    'estimatedCostUSD',
  ] as const) {
    const field = source[key];
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0) usage[key] = field;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}
