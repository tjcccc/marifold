import type { ApiClient } from './client';
import type { ListedProjectAsset, ProjectAssetList, ProjectAssetVersion, StoredProjectAsset } from './types';

// Project assets (docs/service-api.md#projects): stored files with versions,
// and links to files or folders on workspace devices.

const assetsPath = (projectId: string) => `/v1/projects/${encodeURIComponent(projectId)}/assets`;
const assetPath = (projectId: string, assetId: string) => `${assetsPath(projectId)}/${encodeURIComponent(assetId)}`;

export interface SavedProjectAsset {
  asset: StoredProjectAsset;
  /** False when the content equals the latest version, which then stays. */
  newVersion: boolean;
}

export async function listProjectAssets(client: ApiClient, projectId: string): Promise<ProjectAssetList> {
  const { assets, usage } = await client.request<ProjectAssetList>('GET', assetsPath(projectId));
  return { assets, usage };
}

/** Store a file (base64) under `name`; a name that exists gets a new version. */
export async function uploadProjectAsset(
  client: ApiClient,
  projectId: string,
  input: { name: string; data: string; mediaType: string; description?: string },
): Promise<SavedProjectAsset> {
  const { asset, newVersion } = await client.request<SavedProjectAsset>('POST', assetsPath(projectId), input);
  return { asset, newVersion };
}

/** Add to assets: store a run's output, read from the device that ran it. */
export async function addRunOutputToAssets(
  client: ApiClient,
  projectId: string,
  input: { runId: string; artifactId: string; name?: string },
): Promise<SavedProjectAsset> {
  const { asset, newVersion } = await client.request<SavedProjectAsset>('POST', `${assetsPath(projectId)}/from-run`, input);
  return { asset, newVersion };
}

/** `target` is `@device/~/path`, `@device/` and an absolute path, or a bare path on the sending device. */
export async function linkProjectAsset(
  client: ApiClient,
  projectId: string,
  input: { target: string; name?: string; description?: string },
): Promise<ListedProjectAsset> {
  return (await client.request<{ asset: ListedProjectAsset }>('POST', `/v1/projects/${encodeURIComponent(projectId)}/links`, input)).asset;
}

export async function listProjectAssetVersions(client: ApiClient, projectId: string, assetId: string): Promise<ProjectAssetVersion[]> {
  return (await client.request<{ versions: ProjectAssetVersion[] }>('GET', `${assetPath(projectId, assetId)}/versions`)).versions;
}

/** A stored version's content (the latest when `version` is omitted); undefined once it is gone. */
export async function fetchProjectAssetContent(client: ApiClient, projectId: string, assetId: string, version?: number): Promise<Blob | undefined> {
  return client.blob(`${assetPath(projectId, assetId)}/content${version === undefined ? '' : `?version=${version}`}`);
}

export async function updateProjectAsset(
  client: ApiClient,
  projectId: string,
  assetId: string,
  patch: { name?: string; description?: string | null },
): Promise<ListedProjectAsset> {
  return (await client.request<{ asset: ListedProjectAsset }>('PATCH', assetPath(projectId, assetId), patch)).asset;
}

export async function deleteProjectAsset(client: ApiClient, projectId: string, assetId: string): Promise<ProjectAssetList> {
  const { assets, usage } = await client.request<ProjectAssetList>('DELETE', assetPath(projectId, assetId));
  return { assets, usage };
}
