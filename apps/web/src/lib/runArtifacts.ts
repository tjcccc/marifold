import type { ApiClient } from '../api/client';
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

/** Download one artifact with the configured service URL and bearer token. */
export async function downloadRunArtifact(
  client: ApiClient,
  runId: string,
  artifact: RunArtifact,
): Promise<void> {
  const blob = await client.blob(
    `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}`,
  );
  if (!blob) throw new ArtifactUnavailableError();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifact.name.split('/').at(-1) || artifact.name;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Allow the browser to begin consuming the blob before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function safeArtifactName(name: string): boolean {
  if (!name || name.startsWith('/')) return false;
  return name.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
