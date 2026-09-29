import * as fs from 'fs';
import * as path from 'path';
import { ConfigLoader } from './ConfigLoader';
import { ConfigManager } from './ConfigManager';
import type { LoadedMarifoldConfig, MarifoldProviderConfig } from './ConfigSchema';

// Runtimes sharing a config must not concurrently consume rotating tokens.
const pending = new Map<string, Promise<void>>();

export async function withOAuthCredentials(
  loaded: LoadedMarifoldConfig,
  name: string,
  refresh: (provider: MarifoldProviderConfig) => Promise<Partial<MarifoldProviderConfig> | void>,
): Promise<void> {
  const key = JSON.stringify([path.resolve(loaded.configPath), name]);
  const previous = pending.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const read = (): LoadedMarifoldConfig => fs.existsSync(loaded.configPath)
      ? new ConfigLoader().load({ configPath: loaded.configPath }) : loaded;
    const adopt = (saved: LoadedMarifoldConfig): MarifoldProviderConfig | undefined => {
      const provider = saved.config.providers[name];
      if (provider) loaded.config.providers[name] = { ...provider };
      else delete loaded.config.providers[name];
      return provider;
    };
    const provider = adopt(read());
    if (!provider) return;
    const original = JSON.stringify(provider);
    let update: Partial<MarifoldProviderConfig> | void;
    try {
      update = await refresh({ ...provider });
    } catch (error) {
      // A sign-in completed while the old token request was in flight.
      const current = adopt(read());
      if (current && JSON.stringify(current) !== original
        && current.apiKey && current.apiKey !== provider.apiKey) return;
      throw error;
    }
    if (!update) return;
    const latest = read();
    const current = adopt(latest);
    // Never overwrite a concurrent reauth, provider removal, or config edit.
    if (JSON.stringify(current) !== original) return;
    latest.config.providers[name] = { ...current!, ...update };
    new ConfigManager(latest).save();
    adopt(latest);
  });
  pending.set(key, operation);
  try {
    await operation;
  } finally {
    if (pending.get(key) === operation) pending.delete(key);
  }
}
