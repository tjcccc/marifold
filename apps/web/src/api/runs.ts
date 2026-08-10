import type { ApiClient } from './client';
import { MarifoldApiError } from './client';
import { parseSse } from './sse';
import type {
  AgentEvent,
  RunApprovalAction,
  RunRecord,
  RunStartInput,
  TaskStatus,
  UserInputSubmission,
} from './types';

export async function startRun(client: ApiClient, input: RunStartInput): Promise<RunRecord> {
  const body = await client.request<{ run: RunRecord }>('POST', '/v1/runs', input);
  return body.run;
}

export async function listRuns(client: ApiClient): Promise<RunRecord[]> {
  const body = await client.request<{ runs: RunRecord[] }>('GET', '/v1/runs');
  return body.runs;
}

export async function getRun(client: ApiClient, runId: string): Promise<RunRecord> {
  const body = await client.request<{ run: RunRecord }>('GET', `/v1/runs/${encodeURIComponent(runId)}`);
  return body.run;
}

export async function answerApproval(
  client: ApiClient,
  runId: string,
  requestId: string,
  action: RunApprovalAction,
): Promise<{ requestId: string; approved: boolean }> {
  return client.request(
    'POST',
    `/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(requestId)}`,
    { action },
  );
}

export async function answerUserInput(
  client: ApiClient,
  runId: string,
  requestId: string,
  submission: UserInputSubmission,
): Promise<{ requestId: string; accepted: true }> {
  return client.request(
    'POST',
    `/v1/runs/${encodeURIComponent(runId)}/inputs/${encodeURIComponent(requestId)}`,
    submission,
  );
}

export async function steerRun(client: ApiClient, runId: string, text: string): Promise<void> {
  await client.request('POST', `/v1/runs/${encodeURIComponent(runId)}/steer`, { text });
}

export async function cancelRun(client: ApiClient, runId: string): Promise<TaskStatus> {
  const body = await client.request<{ status: TaskStatus }>(
    'POST',
    `/v1/runs/${encodeURIComponent(runId)}/cancel`,
    {},
  );
  return body.status;
}

export interface FollowRunOptions {
  afterSeq?: number;
  signal?: AbortSignal;
  /** Initial reconnect delay; the server's `retry:` hint overrides it. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * Follow a run's event stream to its terminal `done`, transparently
 * reconnecting with `last-event-id` when the transport drops, so consumers
 * see each sequenced event exactly once. Throws MarifoldApiError
 * RUN_NOT_FOUND when the run is gone (evicted after its TTL) — callers
 * degrade to the durable task/session record.
 */
export async function* followRun(
  client: ApiClient,
  runId: string,
  options: FollowRunOptions = {},
): AsyncGenerator<{ seq: number; event: AgentEvent }, void, unknown> {
  const { signal } = options;
  let lastSeq = options.afterSeq ?? 0;
  let retryMs = options.retryDelayMs ?? 3000;
  const maxRetryMs = options.maxRetryDelayMs ?? 15000;

  while (!signal?.aborted) {
    try {
      const response = await client.stream(`/v1/runs/${encodeURIComponent(runId)}/events`, {
        ...(lastSeq > 0 ? { lastEventId: String(lastSeq) } : {}),
        signal,
      });
      for await (const frame of parseSse(response.body!)) {
        if (frame.retryMs !== undefined) retryMs = Math.min(frame.retryMs, maxRetryMs);
        if (frame.id === undefined || frame.data === undefined) continue;
        if (frame.id <= lastSeq) continue; // replay overlap after reconnect
        lastSeq = frame.id;
        const event = frame.data as AgentEvent;
        yield { seq: frame.id, event };
        if (event.type === 'done') return;
      }
      // Stream ended without `done` — the connection dropped; reconnect.
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof MarifoldApiError) throw error;
      // Network-level failure — fall through to the retry delay.
    }
    if (signal?.aborted) return;
    await sleep(withJitter(retryMs, maxRetryMs), signal);
  }
}

function withJitter(baseMs: number, capMs: number): number {
  return Math.min(Math.round(baseMs * (1 + Math.random() * 0.3)), capMs);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
