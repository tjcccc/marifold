import { MarifoldApiError, type ApiClient } from './client';
import { parseSse } from './sse';
/** Following is read-only. Reconnect never resubmits the start operation. */
export async function* followRunEvents<T extends { type: string }>(
  client: ApiClient,
  runId: string,
  signal?: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  let after = 0;
  while (!signal?.aborted) {
    try {
      const response = await client.stream(`/v1/runs/${encodeURIComponent(runId)}/events`, {
        signal,
        lastEventId: String(after),
      });
      for await (const frame of parseSse(response.body!)) {
        if (!frame.id || frame.id <= after || !frame.data) continue;
        after = frame.id;
        const event = frame.data as T;
        yield event;
        if (event.type === 'done') return;
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof MarifoldApiError && ![502, 503, 504].includes(error.status)) throw error;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 1000 + Math.random() * 500);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
