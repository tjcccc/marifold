import type { ApiClient } from './client';
import type { SessionDetail, SessionSummary } from './types';

export async function listSessions(
  client: ApiClient,
  options: { limit?: number; profile?: string } = {},
): Promise<SessionSummary[]> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.profile !== undefined) query.set('profile', options.profile);
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
