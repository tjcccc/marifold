import { useEffect, useMemo, useState } from 'react';
import { listApps } from '../../api/apps';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import type { AppDefinition } from '../../api/types';

export interface AppsCatalog {
  apps: AppDefinition[];
  selected?: AppDefinition;
  selectedName?: string;
  select: (name: string) => void;
  loading: boolean;
  error?: string;
}

/** Persistent App catalog state shared by the Apps sidebar and canvas. */
export function useAppsCatalog(
  client: ApiClient,
  onUnauthorized: () => void,
): AppsCatalog {
  const [apps, setApps] = useState<AppDefinition[]>([]);
  const [selectedName, setSelectedName] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    setApps([]);
    setSelectedName(undefined);
    setError(undefined);
    setLoading(true);
    void listApps(client)
      .then(next => {
        if (!live) return;
        setApps(next);
        setSelectedName(next[0]?.app.name);
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
    () => apps.find(app => app.app.name === selectedName) ?? apps[0],
    [apps, selectedName],
  );

  return {
    apps,
    selected,
    selectedName: selected?.app.name,
    select: setSelectedName,
    loading,
    error,
  };
}
