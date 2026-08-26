import type { ApiClient } from '../api/client';
import type { RunArtifact } from '../api/types';

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
  if (!blob) throw new Error('The generated file is no longer available.');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifact.name.split('/').at(-1) || artifact.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeArtifactName(name: string): boolean {
  if (!name || name.startsWith('/')) return false;
  return name.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
