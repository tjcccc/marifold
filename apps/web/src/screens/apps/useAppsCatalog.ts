import { useWorkspaceChanges } from '../../state/workspaceChanges';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listApps } from '../../api/apps';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import type { SkillAppDefinition, SkillAppInvalidEntry } from '../../api/types';

export interface AppsCatalog {
  apps: SkillAppDefinition[];
  /** Bundles the service could not load, with their exact error. */
  invalidApps: SkillAppInvalidEntry[];
  selected?: SkillAppDefinition;
  /** Set instead of `selected` when the requested App failed to load. */
  selectedInvalid?: SkillAppInvalidEntry;
  selectedName?: string;
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
}

/** Persistent App catalog state shared by the Apps sidebar and canvas. */
export function useAppsCatalog(
  client: ApiClient,
  onUnauthorized: () => void,
  requestedName?: string,
): AppsCatalog {
  const [apps, setApps] = useState<SkillAppDefinition[]>([]);
  const [invalidApps, setInvalidApps] = useState<SkillAppInvalidEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (): Promise<void> => {
    setError(undefined);
    try {
      const next = await listApps(client);
      // Workspace changes include unrelated activity; preserve the active form.
      setApps(current => next.apps.map(app => {
        const previous = current.find(candidate => candidate.app.name === app.app.name);
        return previous && JSON.stringify(previous) === JSON.stringify(app) ? previous : app;
      }));
      setInvalidApps(current => JSON.stringify(current) === JSON.stringify(next.invalidApps) ? current : next.invalidApps);
    } catch (reason) {
      if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') { onUnauthorized(); }
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [client, onUnauthorized]);

  useEffect(() => {
    let live = true;
    setApps([]);
    setInvalidApps([]);
    setError(undefined);
    setLoading(true);
    void listApps(client)
      .then(next => {
        if (!live) { return; }
        setApps(next.apps);
        setInvalidApps(next.invalidApps);
      })
      .catch(reason => {
        if (!live) { return; }
        if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') { onUnauthorized(); }
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (live) { setLoading(false); }
      });
    return () => {
      live = false;
    };
  }, [client, onUnauthorized]);

  useWorkspaceChanges(client, () => { void refresh(); });

  const selectedInvalid = useMemo(
    () => apps.some(app => app.app.name === requestedName)
      ? undefined
      : invalidApps.find(entry => entry.name === requestedName) ?? (apps.length === 0 ? invalidApps[0] : undefined),
    [apps, invalidApps, requestedName],
  );
  const selected = useMemo(
    () => selectedInvalid ? undefined : apps.find(app => app.app.name === requestedName) ?? apps[0],
    [apps, requestedName, selectedInvalid],
  );

  return {
    apps,
    invalidApps,
    selected,
    selectedInvalid,
    selectedName: selectedInvalid?.name ?? selected?.app.name,
    loading,
    error,
    refresh,
  };
}
