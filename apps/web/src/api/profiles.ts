import type { ApiClient } from './client';
import type { MemoryEntry, ProfileDetail, ProfileSummary } from './types';

export async function listProfiles(client: ApiClient): Promise<ProfileSummary[]> {
  const body = await client.request<{ profiles: ProfileSummary[] }>('GET', '/v1/profiles');
  return body.profiles;
}

export async function getProfile(client: ApiClient, name: string): Promise<ProfileDetail> {
  const body = await client.request<{ profile: ProfileDetail }>(
    'GET',
    `/v1/profiles/${encodeURIComponent(name)}`,
  );
  return body.profile;
}

export async function listMemories(
  client: ApiClient,
  profile: string,
  options: { all?: boolean; limit?: number } = {},
): Promise<MemoryEntry[]> {
  const query = new URLSearchParams();
  if (options.all) query.set('all', 'true');
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const body = await client.request<{ memories: MemoryEntry[] }>(
    'GET',
    `/v1/profiles/${encodeURIComponent(profile)}/memories${suffix}`,
  );
  return body.memories;
}
