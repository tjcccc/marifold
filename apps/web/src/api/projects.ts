import type { ApiClient } from './client';
import type { ProjectDetail, ProjectSummary, SessionSummary } from './types';

const projectPath = (id: string) => `/v1/projects/${encodeURIComponent(id)}`;

export async function listProjects(client: ApiClient): Promise<ProjectSummary[]> {
  return (await client.request<{ projects: ProjectSummary[] }>('GET', '/v1/projects')).projects;
}

export async function getProject(client: ApiClient, id: string): Promise<ProjectDetail> {
  return (await client.request<{ project: ProjectDetail }>('GET', projectPath(id))).project;
}

export async function createProject(
  client: ApiClient,
  input: { name: string; lead?: string; members?: string[]; instructions?: string },
): Promise<ProjectDetail> {
  return (await client.request<{ project: ProjectDetail }>('POST', '/v1/projects', input)).project;
}

export async function updateProject(
  client: ApiClient,
  id: string,
  patch: { name?: string; instructions?: string; lead?: string },
): Promise<ProjectDetail> {
  return (await client.request<{ project: ProjectDetail }>('PATCH', projectPath(id), patch)).project;
}

/** Its sessions stay, as ordinary sessions of the profile each started with. */
export async function deleteProject(client: ApiClient, id: string): Promise<void> {
  await client.request('DELETE', projectPath(id));
}

export async function inviteProjectMember(client: ApiClient, id: string, profile: string): Promise<ProjectDetail> {
  return (await client.request<{ project: ProjectDetail }>('POST', `${projectPath(id)}/members`, { profile })).project;
}

export async function dismissProjectMember(client: ApiClient, id: string, profile: string): Promise<ProjectDetail> {
  return (await client.request<{ project: ProjectDetail }>('DELETE', `${projectPath(id)}/members/${encodeURIComponent(profile)}`)).project;
}

export async function listProjectSessions(
  client: ApiClient,
  id: string,
  options: { limit?: number; archived?: boolean; search?: string } = {},
): Promise<SessionSummary[]> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) { query.set('limit', String(options.limit)); }
  if (options.archived !== undefined) { query.set('archived', String(options.archived)); }
  if (options.search?.trim()) { query.set('q', options.search.trim()); }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return (await client.request<{ sessions: SessionSummary[] }>('GET', `${projectPath(id)}/sessions${suffix}`)).sessions;
}

/** Move a session into a project, or out of any (`null`). */
export async function moveSessionToProject(client: ApiClient, sessionId: string, projectId: string | null): Promise<void> {
  await client.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/project`, { projectId });
}

export async function fetchProjectIconBlob(client: ApiClient, id: string): Promise<Blob | undefined> {
  return client.blob(`${projectPath(id)}/icon?thumbnail=1`);
}

export async function setProjectIcon(client: ApiClient, id: string, icon: { data: string; mediaType: string }): Promise<ProjectDetail> {
  return (await client.request<{ project: ProjectDetail }>('PUT', `${projectPath(id)}/icon`, icon)).project;
}

export async function deleteProjectIcon(client: ApiClient, id: string): Promise<ProjectDetail> {
  return (await client.request<{ project: ProjectDetail }>('DELETE', `${projectPath(id)}/icon`)).project;
}
