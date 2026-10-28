import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { type ArtifactSummary, listArtifacts } from '../../api/artifacts';
import type { RunCardState, SavedArtifactChip } from '../../state/threadTypes';

export interface SessionArtifacts {
  /** The chips under a run: what the library records for it, plus its live saves. */
  forRun: (run: Pick<RunCardState, 'runId' | 'savedArtifacts'>) => SavedArtifactChip[];
  refresh: () => Promise<void>;
}

/** The session's library artifacts, reloaded when a reply ends; live saves
 * come from the run's events meanwhile. */
export function useSessionArtifacts(client: ApiClient, sessionId: string | undefined, responding: boolean): SessionArtifacts {
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const refresh = useCallback(async () => {
    if (!sessionId) { setItems([]); return; }
    try { setItems(await listArtifacts(client, { sessionId })); } catch { /* Chips stay as they were. */ }
  }, [client, sessionId]);
  useEffect(() => { if (!responding) { void refresh(); } }, [refresh, responding]);
  const forRun = useMemo(() => {
    const byRun = new Map<string, SavedArtifactChip[]>();
    // In the order they were saved, like the run's other files.
    for (const item of [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      if (!item.runId) { continue; }
      byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), {
        id: item.id, title: item.title, kind: item.kind, version: item.currentVersion, ...(item.sourceOutput ? { sourceOutput: item.sourceOutput } : {}),
      }]);
    }
    return (run: Pick<RunCardState, 'runId' | 'savedArtifacts'>) => {
      const recorded = byRun.get(run.runId) ?? [];
      const live = (run.savedArtifacts ?? []).filter(saved => !recorded.some(item => item.id === saved.id));
      return [...recorded, ...live];
    };
  }, [items]);
  return { forRun, refresh };
}
