import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { RunArtifact } from '../../api/types';
import { ArtifactUnavailableError, downloadRunArtifact } from '../../lib/runArtifacts';

const NO_ARTIFACTS: RunArtifact[] = [];

export function useArtifactDownloads(client?: ApiClient, runId?: string, artifacts: RunArtifact[] = NO_ARTIFACTS) {
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<string>();
  const [started, setStarted] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setUnavailable(new Set(artifacts.filter(artifact => artifact.available === false).map(artifact => artifact.id)));
    if (!client || !runId || artifacts.length === 0) return;
    let cancelled = false;
    void client.request<{ artifacts: RunArtifact[] }>('GET', `/v1/runs/${encodeURIComponent(runId)}/artifacts`)
      .then(result => {
        if (!cancelled) setUnavailable(current => new Set([
          ...current,
          ...result.artifacts.filter(artifact => artifact.available === false).map(artifact => artifact.id),
        ]));
      }).catch(() => { /* Offline devices and older services remain retryable. */ });
    return () => { cancelled = true; };
  }, [client, runId, artifacts]);

  async function download(artifact: RunArtifact): Promise<void> {
    if (!client || !runId || unavailable.has(artifact.id)) return;
    setDownloading(artifact.id);
    setStarted(undefined);
    setError(undefined);
    try {
      await downloadRunArtifact(client, runId, artifact);
      setStarted(artifact.id);
    } catch (error) {
      if (error instanceof ArtifactUnavailableError) setUnavailable(current => new Set([...current, artifact.id]));
      else setError(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading(undefined);
    }
  }

  return { unavailable, downloading, started, error, download };
}
