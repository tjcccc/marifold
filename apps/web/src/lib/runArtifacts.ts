import { MarifoldApiError, type ApiClient } from '../api/client';
import type { RunArtifact } from '../api/types';

export const ARTIFACT_UNAVAILABLE_NOTICE = 'This file has expired or was removed. The download is no longer available.';

export class ArtifactUnavailableError extends Error {
  constructor() { super(ARTIFACT_UNAVAILABLE_NOTICE); this.name = 'ArtifactUnavailableError'; }
}

/** Resolve a model-authored sandbox URL only through artifacts already
 * published for the same run. The host path is never fetched directly. */
export function artifactForSandboxHref(
  href: string,
  runId: string,
  artifacts: RunArtifact[],
): RunArtifact | undefined {
  if (!href.startsWith('sandbox:')) return undefined;
  let normalized: string;
  try {
    normalized = decodeURIComponent(href.slice('sandbox:'.length)).replaceAll('\\', '/');
  } catch {
    return undefined;
  }
  const marker = `/runs/${runId}/output/`;
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const name = normalized.slice(markerIndex + marker.length);
  if (!safeArtifactName(name)) return undefined;
  return artifacts.find(artifact => artifact.name === name);
}

export function artifactPath(runId: string, artifactId: string): string {
  return `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function isImageArtifact(artifact: RunArtifact): boolean {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mediaType);
}

/** Exchange bearer authentication for a short-lived, single-file browser URL. */
export async function artifactAccessUrl(client: ApiClient, runId: string, artifact: RunArtifact, purpose: 'download' | 'image'): Promise<string> {
  try {
    const result = await client.request<{ path: string }>('POST', `${artifactPath(runId, artifact.id)}/access`, { purpose });
    if (!/^\/v1\/downloads\/[a-f0-9]{48}$/.test(result.path)) throw new Error('Invalid file download URL.');
    return `${client.serverUrl ?? client.baseUrl}${result.path}`;
  } catch (error) {
    if (error instanceof MarifoldApiError && error.code === 'ARTIFACT_NOT_FOUND') throw new ArtifactUnavailableError();
    throw error;
  }
}

/** The browser owns streaming, progress, cancellation and the save location. */
export async function downloadRunArtifact(client: ApiClient, runId: string, artifact: RunArtifact): Promise<void> {
  const url = await artifactAccessUrl(client, runId, artifact, 'download');
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifact.name.split('/').at(-1) || artifact.name;
  anchor.referrerPolicy = 'no-referrer';
  // Keep any server-side error page from replacing the conversation.
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}

function safeArtifactName(name: string): boolean {
  if (!name || name.startsWith('/')) return false;
  return name.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
