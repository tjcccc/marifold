import type { ApiClient } from './client';
import type { ArtifactDetail, ArtifactFolder, ArtifactSummary } from './types';

// The artifact library (docs/service-api.md#artifacts): artifacts with
// versions, folders, Recently deleted, and view tickets for the viewer.

export type { ArtifactDetail, ArtifactFolder, ArtifactSummary };

/** A library list: a folder id, or one of the fixed views. */
export type ArtifactScope = 'all' | 'unread' | 'unfiled' | 'deleted' | { folderId: string };

export interface ArtifactFolderCounts {
  all: number;
  unread: number;
  unfiled: number;
  deleted: number;
}

/** A view ticket's pages, relative to the connected service. */
export interface ArtifactView {
  /** The ticket's prefix; every file of the version is under it. */
  path: string;
  entryPath: string;
  entry: string;
  kind: 'html' | 'markdown';
  version: number;
}

const artifactPath = (id: string) => `/v1/artifacts/${encodeURIComponent(id)}`;

export async function listArtifacts(client: ApiClient, scope: ArtifactScope | { sessionId: string } | { projectId: string }, query?: string): Promise<ArtifactSummary[]> {
  const params = new URLSearchParams({ limit: '500' });
  if (typeof scope === 'object') {
    if ('folderId' in scope) { params.set('folder', scope.folderId); } else if ('sessionId' in scope) { params.set('sessionId', scope.sessionId); } else { params.set('projectId', scope.projectId); }
  } else if (scope === 'unread') { params.set('unread', 'true'); } else if (scope === 'deleted') { params.set('deleted', 'true'); } else if (scope === 'unfiled') { params.set('folder', 'unfiled'); }
  if (query?.trim()) { params.set('q', query.trim()); }
  return (await client.request<{ artifacts: ArtifactSummary[] }>('GET', `/v1/artifacts?${params}`)).artifacts;
}

export async function getArtifact(client: ApiClient, id: string): Promise<ArtifactDetail> {
  return (await client.request<{ artifact: ArtifactDetail }>('GET', artifactPath(id))).artifact;
}

export async function updateArtifact(client: ApiClient, id: string, update: { title?: string; description?: string | null; folderId?: string | null; seen?: boolean }): Promise<ArtifactDetail> {
  return (await client.request<{ artifact: ArtifactDetail }>('PATCH', artifactPath(id), update)).artifact;
}

/** To Recently deleted, or for good with `permanent`. */
export async function deleteArtifact(client: ApiClient, id: string, permanent = false): Promise<void> {
  await client.request('DELETE', `${artifactPath(id)}${permanent ? '?permanent=true' : ''}`);
}

export async function undeleteArtifact(client: ApiClient, id: string): Promise<ArtifactDetail> {
  return (await client.request<{ artifact: ArtifactDetail }>('POST', `${artifactPath(id)}/undelete`, {})).artifact;
}

/** Makes `version` current again by saving a copy of it as the newest. */
export async function restoreArtifactVersion(client: ApiClient, id: string, version: number): Promise<ArtifactDetail> {
  return (await client.request<{ artifact: ArtifactDetail }>('POST', `${artifactPath(id)}/restore`, { version })).artifact;
}

/** A fresh view ticket. Never cache one: an expired ticket is refused before it can explain itself. */
export async function viewArtifact(client: ApiClient, id: string, version?: number): Promise<ArtifactView> {
  const view = await client.request<ArtifactView>('POST', `${artifactPath(id)}/view`, version === undefined ? {} : { version });
  if (!/^\/v1\/artifact-views\/[a-f0-9]{48}\//.test(view.path) || !view.entryPath.startsWith(view.path)) { throw new Error('Invalid artifact view URL.'); }
  return view;
}

/** Save as artifact: one .html or .md output of a run. */
export async function saveRunOutputAsArtifact(client: ApiClient, input: { runId: string; artifactId: string; title?: string }): Promise<ArtifactDetail> {
  return (await client.request<{ artifact: ArtifactDetail }>('POST', '/v1/artifacts', input)).artifact;
}

export async function listArtifactFolders(client: ApiClient): Promise<{ folders: ArtifactFolder[]; counts: ArtifactFolderCounts }> {
  const { folders, counts } = await client.request<{ folders: ArtifactFolder[]; counts: ArtifactFolderCounts }>('GET', '/v1/artifact-folders');
  return { folders, counts };
}

export async function createArtifactFolder(client: ApiClient, name: string): Promise<ArtifactFolder> {
  return (await client.request<{ folder: ArtifactFolder }>('POST', '/v1/artifact-folders', { name })).folder;
}

export async function renameArtifactFolder(client: ApiClient, id: string, name: string): Promise<ArtifactFolder> {
  return (await client.request<{ folder: ArtifactFolder }>('PATCH', `/v1/artifact-folders/${encodeURIComponent(id)}`, { name })).folder;
}

/** Deletes a folder; its artifacts become Unfiled. */
export async function deleteArtifactFolder(client: ApiClient, id: string): Promise<void> {
  await client.request('DELETE', `/v1/artifact-folders/${encodeURIComponent(id)}`);
}

/** A view page's URL on the connected service. */
export function artifactViewUrl(client: ApiClient, path: string): string {
  return `${client.serverUrl ?? client.baseUrl}${path}`;
}
