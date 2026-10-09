import type { ApiClient } from './client';
import { MarifoldApiError } from './client';
import { listRuns } from './runs';
import type { SessionDetail, SessionSummary } from './types';

const RUN_SETTLE_POLL_MS = 75;
const RUN_SETTLE_TIMEOUT_MS = 15_000;

export {
  acquireSessionLease,
  isSessionBusy,
  releaseSessionLease,
  renewSessionLease,
  takeOverSessionLease,
} from '@marifold/client';

export async function listSessions(
  client: ApiClient,
  options: { limit?: number; profile?: string; archived?: boolean; search?: string } = {},
): Promise<SessionSummary[]> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) { query.set('limit', String(options.limit)); }
  if (options.profile !== undefined) { query.set('profile', options.profile); }
  if (options.archived !== undefined) { query.set('archived', String(options.archived)); }
  if (options.search?.trim()) { query.set('q', options.search.trim()); }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const body = await client.request<{ sessions: SessionSummary[] }>('GET', `/v1/sessions${suffix}`);
  return body.sessions;
}

export async function getSession(client: ApiClient, id: string): Promise<SessionDetail> {
  const body = await client.request<{ session: SessionDetail }>(
    'GET',
    `/v1/sessions/${encodeURIComponent(id)}`,
  );
  return body.session;
}

export async function deleteSession(client: ApiClient, id: string): Promise<boolean> {
  const body = await client.request<{ deleted: boolean }>(
    'DELETE',
    `/v1/sessions/${encodeURIComponent(id)}`,
  );
  return body.deleted;
}

export async function updateSession(
  client: ApiClient,
  id: string,
  update: { title?: string | null; pinned?: boolean; archived?: boolean },
): Promise<SessionDetail> {
  const body = await client.request<{ session: SessionDetail }>(
    'PATCH',
    `/v1/sessions/${encodeURIComponent(id)}`,
    update,
  );
  return body.session;
}

/** Manually compact a session now (the /compact command). */
export async function compactSession(
  client: ApiClient,
  id: string,
  request: { profile: string; provider?: string; model?: string; think?: boolean },
): Promise<{ compacted: boolean }> {
  const body = await client.request<{ compacted: boolean }>(
    'POST',
    `/v1/sessions/${encodeURIComponent(id)}/compact`,
    request,
  );
  return { compacted: body.compacted };
}

/** Path of one stored user-turn attachment, fetched with ApiClient.blob. */
export function sessionAttachmentPath(sessionId: string, userTurnIndex: number, attachmentIndex: number): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${userTurnIndex}/${attachmentIndex}`;
}

/** Wait until no run of the session is still running, polling the run list. */
export async function waitForSessionRunsToSettle(client: ApiClient, sessionId: string): Promise<void> {
  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const active = (await listRuns(client)).some(
      run => run.sessionId === sessionId && run.status === 'running',
    );
    if (!active) { return; }
    await new Promise(resolve => window.setTimeout(resolve, RUN_SETTLE_POLL_MS));
  }
  throw new Error('The active run did not stop in time. The session was not deleted.');
}

/** Delete a session, retrying while the service still refuses because a request is finishing. */
export async function deleteSessionWhenIdle(client: ApiClient, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await deleteSession(client, sessionId);
    } catch (error) {
      if (!(error instanceof MarifoldApiError && error.code === 'AGENT_RUN_INVALID')) { throw error; }
      await new Promise(resolve => window.setTimeout(resolve, RUN_SETTLE_POLL_MS));
    }
  }
  throw new Error('The active request did not stop in time. The session was not deleted.');
}
