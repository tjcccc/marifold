import type { ApiClient } from './client';
import type { ApprovalMode, MemoryEntry, ProfileDetail, ProfileMode, ProfileSummary, ToolKind } from './types';

/** The editable per-profile markdown files (mirrors core's ProfileFileKind). */
export type ProfileFileKind = 'profile' | 'rules' | 'custom';

/** PATCH /v1/profiles/:name body. Absent field = untouched; null = clear the
 * override (inherit again). provider/model must be set together (or both null). */
export interface ProfilePatchInput {
  mode?: ProfileMode;
  provider?: string | null;
  model?: string | null;
  memories?: boolean | null;
  think?: boolean | null;
  maxContextTokens?: number | null;
  sessionContextTurns?: number | 'all' | null;
  approval?: Partial<Record<ToolKind, ApprovalMode | null>>;
}

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

export async function updateProfile(client: ApiClient, name: string, patch: ProfilePatchInput): Promise<ProfileDetail> {
  const body = await client.request<{ profile: ProfileDetail }>(
    'PATCH',
    `/v1/profiles/${encodeURIComponent(name)}`,
    patch,
  );
  return body.profile;
}

export async function putProfileFile(
  client: ApiClient,
  name: string,
  file: ProfileFileKind,
  content: string,
): Promise<ProfileDetail> {
  const body = await client.request<{ profile: ProfileDetail }>(
    'PUT',
    `/v1/profiles/${encodeURIComponent(name)}/files/${file}`,
    { content },
  );
  return body.profile;
}

export async function addTrustedFolder(client: ApiClient, name: string, folder: string): Promise<ProfileDetail> {
  const body = await client.request<{ profile: ProfileDetail }>(
    'POST',
    `/v1/profiles/${encodeURIComponent(name)}/trusted-folders`,
    { folder },
  );
  return body.profile;
}

export async function removeTrustedFolder(client: ApiClient, name: string, folder: string): Promise<ProfileDetail> {
  const body = await client.request<{ profile: ProfileDetail }>(
    'DELETE',
    `/v1/profiles/${encodeURIComponent(name)}/trusted-folders`,
    { folder },
  );
  return body.profile;
}

/** forget = supersede (recoverable); delete = permanent. Returns the fresh active list. */
export async function deleteMemory(
  client: ApiClient,
  profile: string,
  id: string,
  mode: 'forget' | 'delete' = 'forget',
): Promise<MemoryEntry[]> {
  const body = await client.request<{ memories: MemoryEntry[] }>(
    'DELETE',
    `/v1/profiles/${encodeURIComponent(profile)}/memories/${encodeURIComponent(id)}?mode=${mode}`,
  );
  return body.memories;
}
