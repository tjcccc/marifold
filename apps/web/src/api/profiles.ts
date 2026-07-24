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

/** Scaffold a new profile (POST /v1/profiles). Duplicate/invalid names are 400. */
export async function createProfile(client: ApiClient, name: string): Promise<ProfileDetail> {
  const body = await client.request<{ profile: ProfileDetail }>('POST', '/v1/profiles', { name });
  return body.profile;
}

export async function setProfilePinned(
  client: ApiClient,
  name: string,
  pinned: boolean,
): Promise<ProfileSummary[]> {
  const body = await client.request<{ profiles: ProfileSummary[] }>(
    'PATCH',
    `/v1/profiles/${encodeURIComponent(name)}/display`,
    { pinned },
  );
  return body.profiles;
}

/** Remove profile files/memories/skills/avatar. Session history remains stored. */
export async function deleteProfile(client: ApiClient, name: string): Promise<void> {
  await client.request(
    'DELETE',
    `/v1/profiles/${encodeURIComponent(name)}`,
  );
}

export async function putAvatar(
  client: ApiClient,
  name: string,
  data: string,
  mediaType: string,
): Promise<ProfileDetail> {
  const body = await client.request<{ profile: ProfileDetail }>(
    'PUT',
    `/v1/profiles/${encodeURIComponent(name)}/avatar`,
    { data, mediaType },
  );
  return body.profile;
}

export async function deleteAvatar(client: ApiClient, name: string): Promise<ProfileDetail> {
  const body = await client.request<{ profile: ProfileDetail }>(
    'DELETE',
    `/v1/profiles/${encodeURIComponent(name)}/avatar`,
  );
  return body.profile;
}

/** Avatar bytes via the authorized client; undefined when the profile has none. */
export async function fetchAvatarBlob(client: ApiClient, name: string): Promise<Blob | undefined> {
  return client.blob(`/v1/profiles/${encodeURIComponent(name)}/avatar`);
}

export interface CreateProfileInput {
  name: string;
  mode?: ProfileMode;
  /** "provider/model" pair; both or neither. */
  provider?: string;
  model?: string;
  avatar?: { data: string; mediaType: string };
}

/** The create-sheet flow: scaffold, then apply the optional initial settings
 * and avatar. Returns the final detail. Follow-up failures throw after the
 * profile exists — callers should refresh their lists either way. */
export async function createProfileWithSetup(client: ApiClient, input: CreateProfileInput): Promise<ProfileDetail> {
  let detail = await createProfile(client, input.name);
  const patch: ProfilePatchInput = {
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.provider && input.model ? { provider: input.provider, model: input.model } : {}),
  };
  if (Object.keys(patch).length > 0) detail = await updateProfile(client, input.name, patch);
  if (input.avatar) detail = await putAvatar(client, input.name, input.avatar.data, input.avatar.mediaType);
  return detail;
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

/** Save a memory for a profile (the /remember command). */
export async function rememberMemory(client: ApiClient, profile: string, text: string): Promise<MemoryEntry[]> {
  const body = await client.request<{ memories: MemoryEntry[] }>(
    'POST',
    `/v1/profiles/${encodeURIComponent(profile)}/memories`,
    { text },
  );
  return body.memories;
}
