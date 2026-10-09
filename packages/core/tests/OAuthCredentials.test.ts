import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../src/config/ConfigLoader';
import { ConfigManager } from '../src/config/ConfigManager';
import { withOAuthCredentials } from '../src/config/OAuthCredentials';
import { MarifoldRuntime } from '../src/runtime/MarifoldRuntime';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-oauth-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, '');
  const loaded = new ConfigLoader().load({ configPath });
  loaded.config.default = { provider: 'xai', model: 'grok-test', profile: 'default', think: false };
  loaded.config.paths = {
    profilesDir: path.join(dir, 'profiles'), sessionsDb: path.join(dir, 'sessions.db'),
    tasksDir: path.join(dir, 'tasks'), skillsDir: path.join(dir, 'skills'),
  };
  loaded.config.providers = { xai: {
    type: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', nativeWebSearch: 'off',
    apiKey: 'expired', oauthToken: 'old-refresh', apiKeyExpiresAt: 1,
  } };
  new ConfigManager(loaded).save();
  return loaded;
}

function read(loaded: ReturnType<typeof setup>) {
  return new ConfigLoader().load({ configPath: loaded.configPath });
}

function reauth(loaded: ReturnType<typeof setup>) {
  const saved = read(loaded);
  Object.assign(saved.config.providers.xai!, {
    apiKey: 'signed-in', oauthToken: 'new-refresh', apiKeyExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  new ConfigManager(saved).save();
}

describe('live OAuth credentials', () => {
  it('uses reauthenticated xAI credentials in an already running runtime', async () => {
    const loaded = setup();
    const runtime = new MarifoldRuntime({ loadedConfig: loaded });
    reauth(loaded);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.x.ai/v1/chat/completions');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer signed-in');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }));
    });
    vi.stubGlobal('fetch', fetch);
    try {
      expect((await runtime.ask({ prompt: 'Hello', chatTools: false })).text).toBe('hello');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { runtime.close(); }
  });

  it('serializes refreshes across runtimes sharing a config and adopts the rotated token', async () => {
    const loaded = setup();
    const other = read(loaded);
    let calls = 0;
    const refresh = async (provider: typeof loaded.config.providers.xai) => {
      if (provider.apiKey === 'fresh') { return; }
      calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { apiKey: 'fresh', oauthToken: 'rotated' };
    };
    await Promise.all([
      withOAuthCredentials(loaded, 'xai', refresh),
      withOAuthCredentials(other, 'xai', refresh),
    ]);
    expect(calls).toBe(1);
    expect(other.config.providers.xai!.oauthToken).toBe('rotated');
  });

  it.each([false, true])('preserves reauth during an in-flight refresh (failure: %s)', async fail => {
    const loaded = setup();
    await withOAuthCredentials(loaded, 'xai', async () => {
      reauth(loaded);
      if (fail) { throw new Error('invalid_grant'); }
      return { apiKey: 'obsolete', oauthToken: 'obsolete' };
    });
    expect(loaded.config.providers.xai!.apiKey).toBe('signed-in');
    expect(read(loaded).config.providers.xai!.oauthToken).toBe('new-refresh');
  });

  it('preserves unrelated config changes made while refreshing', async () => {
    const loaded = setup();
    await withOAuthCredentials(loaded, 'xai', async () => {
      const saved = read(loaded);
      saved.config.default.model = 'changed-model';
      new ConfigManager(saved).save();
      return { apiKey: 'fresh', oauthToken: 'rotated' };
    });
    expect(read(loaded).config.default.model).toBe('changed-model');
    expect(read(loaded).config.providers.xai!.oauthToken).toBe('rotated');
  });

  it('keeps rotated tokens when the same provider is edited during the refresh', async () => {
    const loaded = setup();
    await withOAuthCredentials(loaded, 'xai', async () => {
      const saved = read(loaded);
      saved.config.providers.xai!.proxy = 'http://127.0.0.1:7890';
      new ConfigManager(saved).save();
      return { apiKey: 'fresh', oauthToken: 'rotated', apiKeyExpiresAt: 2 };
    });
    const provider = read(loaded).config.providers.xai!;
    expect(provider).toMatchObject({ proxy: 'http://127.0.0.1:7890', apiKey: 'fresh', oauthToken: 'rotated' });
    expect(loaded.config.providers.xai!.oauthToken).toBe('rotated');
  });

  it('does not overwrite a sign-in that completes during the refresh', async () => {
    const loaded = setup();
    await withOAuthCredentials(loaded, 'xai', async () => {
      reauth(loaded);
      return { apiKey: 'fresh', oauthToken: 'rotated' };
    });
    expect(read(loaded).config.providers.xai!).toMatchObject({ apiKey: 'signed-in', oauthToken: 'new-refresh' });
  });

  it('allows a subsequent sign-in to recover after a failed refresh', async () => {
    const loaded = setup();
    await expect(withOAuthCredentials(loaded, 'xai', async () => { throw new Error('invalid_grant'); }))
      .rejects.toThrow('invalid_grant');
    reauth(loaded);
    await withOAuthCredentials(loaded, 'xai', async provider => {
      expect(provider.apiKey).toBe('signed-in');
    });
  });
});
