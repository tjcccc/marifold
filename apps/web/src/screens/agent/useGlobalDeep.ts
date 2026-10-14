import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { getConfig, getModels, setConfigValue } from '../../api/misc';
import type { ProfileSettings } from '../../api/types';

/**
 * The global Deep switch, `default.deep` in config.toml. Toggling saves it,
 * so the TUI, channels, and other tabs follow; each request still carries the
 * value so a run on another device reasons the same way.
 */
export function useGlobalDeep(client: ApiClient, onError: (error: unknown) => void): [boolean, (deep: boolean) => void] {
  const [deep, setDeepState] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Not worth an error notice: until the config loads, Deep shows off.
    getConfig(client)
      .then(config => { if (!cancelled) { setDeepState(config.default.deep ?? false); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [client]);

  const setDeep = useCallback((next: boolean) => {
    setDeepState(next);
    setConfigValue(client, 'default.deep', String(next)).catch(error => {
      setDeepState(!next);
      onError(error);
    });
  }, [client, onError]);

  return [deep, setDeep];
}

/**
 * Whether Deep changes anything for the model a message would use: the
 * composer's choice, else the profile's pin, else the default model. Unknown
 * (older service, model outside the list) counts as available.
 */
export function useDeepAvailable(client: ApiClient, modelChoice: string | undefined, settings: ProfileSettings | undefined): boolean {
  const [models, setModels] = useState<{ fallback?: string; deep?: string[] }>({});
  useEffect(() => {
    let cancelled = false;
    getModels(client)
      .then(view => {
        if (cancelled) { return; }
        const fallback = view.default.provider && view.default.model ? `${view.default.provider}/${view.default.model}` : undefined;
        setModels({ fallback, deep: view.deepOptions });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [client]);
  const pinned = settings?.provider && settings.model ? `${settings.provider}/${settings.model}` : undefined;
  const model = modelChoice ?? pinned ?? models.fallback;
  return !models.deep || !model || models.deep.includes(model);
}
