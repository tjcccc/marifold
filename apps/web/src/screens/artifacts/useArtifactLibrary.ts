import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { type ArtifactFolder, type ArtifactFolderCounts, listArtifactFolders } from '../../api/artifacts';

export interface ArtifactLibraryState {
  folders: ArtifactFolder[];
  counts?: ArtifactFolderCounts;
  error?: string;
  refresh: () => Promise<void>;
}

/** The library's folders and counts, loaded while the Artifacts view is open. */
export function useArtifactLibrary(client: ApiClient, active: boolean): ArtifactLibraryState {
  const [folders, setFolders] = useState<ArtifactFolder[]>([]);
  const [counts, setCounts] = useState<ArtifactFolderCounts>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const next = await listArtifactFolders(client);
      setFolders(next.folders);
      setCounts(next.counts);
      setError(undefined);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, [client]);
  useEffect(() => { if (active) { void refresh(); } }, [active, refresh]);
  return { folders, counts, error, refresh };
}
