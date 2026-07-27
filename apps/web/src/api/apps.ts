import type { ApiClient } from './client';
import { parseSse } from './sse';
import type {
  ChatStreamEvent,
  AppDefinition,
  AppVariableValue,
} from './types';

export async function listApps(
  client: ApiClient,
): Promise<AppDefinition[]> {
  const payload = await client.request<{ ok: true; apps: AppDefinition[] }>(
    'GET',
    '/v1/apps',
  );
  return payload.apps;
}

export async function* streamAppAction(
  client: ApiClient,
  appName: string,
  actionName: string,
  request: {
    values: Record<string, AppVariableValue>;
  },
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  const response = await client.stream(
    `/v1/apps/${encodeURIComponent(appName)}/actions/${encodeURIComponent(actionName)}/stream`,
    { method: 'POST', body: request, signal },
  );
  let finished = false;
  for await (const frame of parseSse(response.body!)) {
    if (frame.event === 'chunk') {
      const text = (frame.data as { text?: unknown } | undefined)?.text;
      if (typeof text === 'string') yield { type: 'chunk', text };
    } else if (frame.event === 'reasoning') {
      const text = (frame.data as { text?: unknown } | undefined)?.text;
      if (typeof text === 'string') yield { type: 'reasoning', text };
    } else if (frame.event === 'error') {
      const body = frame.data as { code?: unknown; message?: unknown } | undefined;
      yield {
        type: 'error',
        code: typeof body?.code === 'string' ? body.code : 'STREAM_ERROR',
        message: typeof body?.message === 'string' ? body.message : 'App action failed.',
      };
    } else if (frame.event === 'done') {
      const body = frame.data as {
        usage?: { totalTokens?: unknown };
        latencyMs?: unknown;
      } | undefined;
      const totalTokens = body?.usage?.totalTokens;
      finished = true;
      yield {
        type: 'done',
        ...(typeof body?.latencyMs === 'number' && Number.isFinite(body.latencyMs)
          ? { latencyMs: body.latencyMs }
          : {}),
        ...(typeof totalTokens === 'number' && Number.isFinite(totalTokens)
          ? { usage: { totalTokens } }
          : {}),
      };
      return;
    }
  }
  if (!finished && !signal?.aborted) {
    yield { type: 'error', code: 'STREAM_INTERRUPTED', message: 'The App stream ended before completing.' };
    yield { type: 'done' };
  }
}
