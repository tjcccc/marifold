import { useCallback, useEffect, useMemo, useState } from 'react';
import { listApps } from '../../api/apps';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import type { SkillAppDefinition } from '../../api/types';

export interface AppsCatalog {
  apps: SkillAppDefinition[];
  selected?: SkillAppDefinition;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (): Promise<void> => {
    setError(undefined);
    setLoading(true);
    try {
      setApps(await listApps(client));
    } catch (reason) {
      if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') onUnauthorized();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [client, onUnauthorized]);

  useEffect(() => {
    let live = true;
    setApps([]);
    setError(undefined);
    setLoading(true);
    void listApps(client)
      .then(next => {
        if (!live) return;
        setApps(next);
      })
      .catch(reason => {
        if (!live) return;
        if (reason instanceof MarifoldApiError && reason.code === 'UNAUTHORIZED') onUnauthorized();
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [client, onUnauthorized]);

  const selected = useMemo(
    () => apps.find(app => app.app.name === requestedName) ?? apps[0],
    [apps, requestedName],
  );

  return {
    apps,
    selected,
    selectedName: selected?.app.name,
    loading,
    error,
    refresh,
  };
}
