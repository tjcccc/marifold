import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProxyAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedMarifoldConfig } from '../src/config/ConfigSchema';
import { ProviderEngines } from '../src/runtime/ProviderEngines';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

describe('ChatGPT token refresh', () => {
  it("goes through the provider's proxy when the service has no proxy environment", async () => {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) { vi.stubEnv(name, ''); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-chatgpt-refresh-'));
    dirs.push(dir);
    let dispatcher: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }) => {
      dispatcher = init?.dispatcher;
      return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'rotated', expires_in: 3600 }), { status: 200 });
    }));
    const loaded = {
      configPath: path.join(dir, 'config.toml'),
      foundConfig: false,
      config: {
        default: { provider: 'chatgpt', model: 'gpt-x', profile: 'default', think: false },
        models: { options: [] },
        memory: { sizeLimit: 50000, contextLimit: 2400 },
        paths: { profilesDir: path.join(dir, 'profiles'), sessionsDb: path.join(dir, 'sessions.db'), tasksDir: path.join(dir, 'tasks') },
        providers: { chatgpt: { type: 'openai-compatible', oauthToken: 'old-refresh', proxy: 'http://127.0.0.1:7890' } },
      },
    } as unknown as LoadedMarifoldConfig;

    await new ProviderEngines(loaded, {} as never, {} as never, {} as never).refreshCredentials('chatgpt');

    expect(dispatcher).toBeInstanceOf(ProxyAgent);
    expect(loaded.config.providers.chatgpt.apiKey).toBe('new-access');
  });
});
