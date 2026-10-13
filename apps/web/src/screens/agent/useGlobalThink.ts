import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { getConfig, getModels, setConfigValue } from '../../api/misc';
import type { ProfileSettings } from '../../api/types';

/**
 * The global Think switch, `default.think` in config.toml. Toggling saves it,
 * so the TUI, channels, and other tabs follow; each request still carries the
 * value so a run on another device thinks the same way.
 */
export function useGlobalThink(client: ApiClient, onError: (error: unknown) => void): [boolean, (think: boolean) => void] {
  const [think, setThinkState] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Not worth an error notice: until the config loads, Think shows off.
    getConfig(client)
      .then(config => { if (!cancelled) { setThinkState(config.default.think ?? false); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [client]);

  const setThink = useCallback((next: boolean) => {
    setThinkState(next);
    setConfigValue(client, 'default.think', String(next)).catch(error => {
      setThinkState(!next);
      onError(error);
    });
  }, [client, onError]);

  return [think, setThink];
}

/**
 * Whether Think changes anything for the model a message would use: the
 * composer's choice, else the profile's pin, else the default model. Unknown
 * (older service, model outside the list) counts as available.
 */
export function useThinkAvailable(client: ApiClient, modelChoice: string | undefined, settings: ProfileSettings | undefined): boolean {
  const [models, setModels] = useState<{ fallback?: string; think?: string[] }>({});
  useEffect(() => {
    let cancelled = false;
    getModels(client)
      .then(view => {
        if (cancelled) { return; }
        const fallback = view.default.provider && view.default.model ? `${view.default.provider}/${view.default.model}` : undefined;
        setModels({ fallback, think: view.thinkOptions });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [client]);
  const pinned = settings?.provider && settings.model ? `${settings.provider}/${settings.model}` : undefined;
  const model = modelChoice ?? pinned ?? models.fallback;
  return !models.think || !model || models.think.includes(model);
}
