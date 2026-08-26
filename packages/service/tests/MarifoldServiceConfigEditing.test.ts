import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionResolver } from '@marifold/core';
import { createMarifoldService } from '../src';
import { cleanupTempDirs, fixtureLoadedConfig, tempDir } from './helpers';

afterEach(() => {
  cleanupTempDirs();
});

function scaffoldProfile(profilesDir: string, name: string): string {
  const dir = path.join(profilesDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROFILE.md'), `# ${name}`);
  fs.writeFileSync(path.join(dir, 'profile.toml'), 'memories = true\n');
  return dir;
}

describe('config editing routes', () => {
  it('PATCH /v1/profiles/:name updates settings and clears overrides with null', async () => {
    const dir = tempDir();
    const loadedConfig = fixtureLoadedConfig(dir);
    scaffoldProfile(loadedConfig.config.paths.profilesDir, 'writer');
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const patched = await server.inject({
        method: 'PATCH',
        url: '/v1/profiles/writer',
        payload: {
          displayName: 'Writing Partner',
          mode: 'chat',
          provider: 'ollama',
          model: 'codellama',
          memories: false,
          think: true,
          sessionContextTurns: 5,
          approval: { shell: 'deny' },
        },
      });
      expect(patched.statusCode).toBe(200);
      const settings = patched.json().profile.settings;
      expect(patched.json().profile.displayName).toBe('Writing Partner');
      expect(settings).toMatchObject({
        mode: 'chat', provider: 'ollama', model: 'codellama',
        memories: false, think: true, sessionContextTurns: 5,
      });
      expect(settings.agent.approval.shell).toBe('deny');

      // null clears: model override, think, the approval override, the turn window.
      const cleared = await server.inject({
        method: 'PATCH',
        url: '/v1/profiles/writer',
        payload: {
          displayName: null,
          provider: null,
          model: null,
          think: null,
          sessionContextTurns: null,
          approval: { shell: null },
        },
      });
      expect(cleared.statusCode).toBe(200);
      const after = cleared.json().profile.settings;
      expect(cleared.json().profile.displayName).toBe('writer');
      expect(after.displayName).toBeUndefined();
      expect(after.provider).toBeUndefined();
      expect(after.model).toBeUndefined();
      expect(after.think).toBeUndefined();
      expect(after.sessionContextTurns).toBeUndefined();
      expect(after.agent?.approval?.shell).toBeUndefined();
      expect(after.mode).toBe('chat'); // untouched fields preserved

      // Validation failures are 400 CONFIG_INVALID.
      const badMode = await server.inject({ method: 'PATCH', url: '/v1/profiles/writer', payload: { mode: 'wizard' } });
      expect(badMode.statusCode).toBe(400);
      const halfModel = await server.inject({ method: 'PATCH', url: '/v1/profiles/writer', payload: { provider: 'ollama' } });
      expect(halfModel.statusCode).toBe(400);
      const badKind = await server.inject({ method: 'PATCH', url: '/v1/profiles/writer', payload: { approval: { wizardry: 'allow' } } });
      expect(badKind.statusCode).toBe(400);

      // Unknown profile is a 400 PROFILE_INVALID (matches the GET behavior).
      const unknown = await server.inject({ method: 'PATCH', url: '/v1/profiles/nope', payload: { mode: 'chat' } });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error.code).toBe('PROFILE_INVALID');
    } finally {
      await server.close();
    }
  });

  it('PUT /v1/profiles/:name/files/:file writes the markdown and rejects unknown files', async () => {
    const dir = tempDir();
    const loadedConfig = fixtureLoadedConfig(dir);
    const profileDir = scaffoldProfile(loadedConfig.config.paths.profilesDir, 'writer');
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const put = await server.inject({
        method: 'PUT',
        url: '/v1/profiles/writer/files/rules',
        payload: { content: '# Strict rules\nNo fluff.' },
      });
      expect(put.statusCode).toBe(200);
      expect(fs.readFileSync(path.join(profileDir, 'RULES.md'), 'utf-8')).toBe('# Strict rules\nNo fluff.');
      expect(put.json().profile.files.rules.content).toBe('# Strict rules\nNo fluff.');

      const bad = await server.inject({
        method: 'PUT',
        url: '/v1/profiles/writer/files/secrets',
        payload: { content: 'x' },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('trusted-folder routes add and remove entries (safety refusals stay 400)', async () => {
    const dir = tempDir();
    const loadedConfig = fixtureLoadedConfig(dir);
    scaffoldProfile(loadedConfig.config.paths.profilesDir, 'writer');
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const added = await server.inject({
        method: 'POST',
        url: '/v1/profiles/writer/trusted-folders',
        payload: { folder: '/tmp/blog' },
      });
      expect(added.statusCode).toBe(200);
      expect(added.json().profile.settings.agent.trustedFolders).toEqual(['/tmp/blog']);

      const refused = await server.inject({
        method: 'POST',
        url: '/v1/profiles/writer/trusted-folders',
        payload: { folder: '/' },
      });
      expect(refused.statusCode).toBe(400);

      const removed = await server.inject({
        method: 'DELETE',
        url: '/v1/profiles/writer/trusted-folders',
        payload: { folder: '/tmp/blog' },
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().removed).toBe(true);
      expect(removed.json().profile.settings.agent?.trustedFolders ?? []).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('DELETE /v1/profiles/:name/memories/:id forgets (default) or deletes exactly one entry', async () => {
    const dir = tempDir();
    const loadedConfig = fixtureLoadedConfig(dir);
    scaffoldProfile(loadedConfig.config.paths.profilesDir, 'writer');
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      // Seed two memories through the runtime the service exposes elsewhere.
      const memories = await server.inject({ method: 'GET', url: '/v1/profiles/writer/memories' });
      expect(memories.statusCode).toBe(200);
      // Seed directly via the profile's jsonl (the service has no memory-create route by design).
      const userJsonl = path.join(loadedConfig.config.paths.profilesDir, 'writer', 'memories', 'user.jsonl');
      const entry = (id: string, text: string) => JSON.stringify({
        id, kind: 'user', text, status: 'active', priority: 0, confidence: 1,
        stability: 'stable', source: 'user_direct', created_at: new Date().toISOString(),
      });
      fs.writeFileSync(userJsonl, `${entry('mem-1', 'Likes espresso.')}\n${entry('mem-2', 'Likes espresso machines.')}\n`);

      const forgotten = await server.inject({ method: 'DELETE', url: '/v1/profiles/writer/memories/mem-1' });
      expect(forgotten.statusCode).toBe(200);
      expect(forgotten.json().removed).toBe(true);
      const remainingIds = (forgotten.json().memories as Array<{ id: string }>).map(m => m.id);
      expect(remainingIds).toEqual(['mem-2']); // active list; similar text untouched

      const deleted = await server.inject({ method: 'DELETE', url: '/v1/profiles/writer/memories/mem-2?mode=delete' });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().memories).toEqual([]);

      const badMode = await server.inject({ method: 'DELETE', url: '/v1/profiles/writer/memories/mem-2?mode=zap' });
      expect(badMode.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('PATCH /v1/config sets a dotted key and returns the sanitized view (canary)', async () => {
    const dir = tempDir();
    const loadedConfig = fixtureLoadedConfig(dir, {
      service: { token: 'sekret-token', corsOrigins: [] },
    });
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    const auth = { authorization: 'Bearer sekret-token' };
    try {
      const set = await server.inject({
        method: 'PATCH',
        url: '/v1/config',
        headers: auth,
        payload: { key: 'default.max_context_tokens', value: '12000' },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().config.default.maxContextTokens).toBe(12000);
      // Persisted to disk, not just in memory.
      expect(fs.readFileSync(loadedConfig.configPath, 'utf-8')).toContain('max_context_tokens = 12000');

      // Sanitized view: [service] appears with hasToken, never the token; provider canary stays hidden.
      const view = JSON.stringify(set.json().config);
      expect(set.json().config.service).toMatchObject({ hasToken: true, corsOrigins: [] });
      expect(view).not.toContain('sekret-token');
      expect(view).not.toContain('test-secret-key');

      // service.* keys route too (the CLI-parity requirement).
      const cors = await server.inject({
        method: 'PATCH',
        url: '/v1/config',
        headers: auth,
        payload: { key: 'service.cors_origins', value: 'http://localhost:5173' },
      });
      expect(cors.statusCode).toBe(200);
      expect(cors.json().config.service.corsOrigins).toEqual(['http://localhost:5173']);

      // providers.<name>.proxy routes and surfaces in the sanitized view (a
      // non-secret URL exposed like base_url, unlike raw api_key).
      const proxy = await server.inject({
        method: 'PATCH',
        url: '/v1/config',
        headers: auth,
        payload: { key: 'providers.xai.proxy', value: 'http://127.0.0.1:7890' },
      });
      expect(proxy.statusCode).toBe(200);
      expect(proxy.json().config.providers.xai.proxy).toBe('http://127.0.0.1:7890');

      const unknown = await server.inject({
        method: 'PATCH',
        url: '/v1/config',
        headers: auth,
        payload: { key: 'nonsense.key', value: 'x' },
      });
      expect(unknown.statusCode).toBe(400);

      // Auth still gates the write route.
      const bare = await server.inject({ method: 'PATCH', url: '/v1/config', payload: { key: 'default.think', value: 'true' } });
      expect(bare.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('POST /v1/profiles scaffolds a profile; duplicates and bad names are 400', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir());
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const created = await server.inject({ method: 'POST', url: '/v1/profiles', payload: { name: 'scribe' } });
      expect(created.statusCode).toBe(201);
      expect(created.json().profile).toMatchObject({
        name: 'scribe',
        displayName: 'scribe',
        source: 'directory',
      });
      expect(fs.existsSync(path.join(loadedConfig.config.paths.profilesDir, 'scribe', 'PROFILE.md'))).toBe(true);

      const listed = await server.inject({ method: 'GET', url: '/v1/profiles' });
      expect(listed.json().profiles.map((p: { name: string }) => p.name)).toContain('scribe');

      const dup = await server.inject({ method: 'POST', url: '/v1/profiles', payload: { name: 'scribe' } });
      expect(dup.statusCode).toBe(400);
      const bad = await server.inject({ method: 'POST', url: '/v1/profiles', payload: { name: '../evil' } });
      expect(bad.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('lists recent profile responses, pins profiles, and removes non-default profiles', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir());
    const writerDir = scaffoldProfile(loadedConfig.config.paths.profilesDir, 'writer');
    scaffoldProfile(loadedConfig.config.paths.profilesDir, 'painter');
    const sessions = new SessionResolver(loadedConfig.config.paths.sessionsDb);
    await sessions.appendExchange('writer-session', 'writer', 'Write', '## Latest writer response\nMore detail');
    await sessions.appendExchange('painter-session', 'painter', 'Paint', 'Latest painter response');
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const listed = await server.inject({ method: 'GET', url: '/v1/profiles' });
      expect(listed.json().profiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'writer', preview: 'Latest writer response' }),
        expect.objectContaining({ name: 'painter', preview: 'Latest painter response' }),
      ]));

      const pinned = await server.inject({
        method: 'PATCH',
        url: '/v1/profiles/writer/display',
        payload: { pinned: true },
      });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json().profiles[0]).toMatchObject({ name: 'writer', pinned: true });

      const badPin = await server.inject({
        method: 'PATCH',
        url: '/v1/profiles/writer/display',
        payload: { pinned: 'yes' },
      });
      expect(badPin.statusCode).toBe(400);

      const defaultDelete = await server.inject({ method: 'DELETE', url: '/v1/profiles/default' });
      expect(defaultDelete.statusCode).toBe(400);

      const removed = await server.inject({ method: 'DELETE', url: '/v1/profiles/writer' });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ deleted: true, name: 'writer' });
      expect(fs.existsSync(writerDir)).toBe(false);
      expect((await server.inject({ method: 'GET', url: '/v1/sessions/writer-session' })).statusCode).toBe(200);
    } finally {
      await server.close();
      sessions.close();
    }
  });

  it('model management: add/remove options and set the default; secrets stay off the wire', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir());
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      // Add against the existing provider.
      const added = await server.inject({
        method: 'POST',
        url: '/v1/models',
        payload: { provider: 'ollama', model: 'llama4:8b' },
      });
      expect(added.statusCode).toBe(201);
      expect(added.json().options).toContain('ollama/llama4:8b');

      // Add with a brand-new provider entry (no secrets accepted, only the env name).
      const remote = await server.inject({
        method: 'POST',
        url: '/v1/models',
        payload: {
          provider: 'myremote',
          model: 'big-model',
          type: 'openai-compatible',
          baseUrl: 'https://llm.example.com/v1/',
          apiKeyEnv: 'MYREMOTE_API_KEY',
          apiKey: 'raw-secret-must-be-ignored',
        },
      });
      expect(remote.statusCode).toBe(201);
      const providers = (await server.inject({ method: 'GET', url: '/v1/providers' })).json().providers;
      const myremote = providers.find((p: { name: string }) => p.name === 'myremote');
      expect(myremote).toMatchObject({ type: 'openai-compatible', baseUrl: 'https://llm.example.com/v1' });
      expect(myremote.hasApiKey ?? false).toBe(false); // the raw key was ignored
      expect(JSON.stringify(myremote)).not.toContain('raw-secret');

      const badType = await server.inject({
        method: 'POST',
        url: '/v1/models',
        payload: { provider: 'x', model: 'y', type: 'grpc' },
      });
      expect(badType.statusCode).toBe(400);

      // Default switch registers + persists.
      const setDefault = await server.inject({
        method: 'PUT',
        url: '/v1/models/default',
        payload: { provider: 'ollama', model: 'llama4:8b' },
      });
      expect(setDefault.statusCode).toBe(200);
      expect(setDefault.json().default).toEqual({ provider: 'ollama', model: 'llama4:8b' });

      // Remove: reports removed + wasDefault, leaves the default untouched.
      const removed = await server.inject({
        method: 'DELETE',
        url: '/v1/models',
        payload: { provider: 'ollama', model: 'llama4:8b' },
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ removed: true, wasDefault: true });
      expect(removed.json().options).not.toContain('ollama/llama4:8b');

      const absent = await server.inject({
        method: 'DELETE',
        url: '/v1/models',
        payload: { provider: 'ollama', model: 'never-there' },
      });
      expect(absent.json()).toMatchObject({ removed: false });
    } finally {
      await server.close();
    }
  });

  it('provider status and live model listing stay sanitized and never throw', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir());
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const status = await server.inject({ method: 'GET', url: '/v1/providers/status' });
      expect(status.statusCode).toBe(200);
      const entries = status.json().providers;
      expect(Array.isArray(entries)).toBe(true);
      for (const entry of entries) {
        expect(typeof entry.hasApiKey).toBe('boolean');
        expect(entry.apiKey).toBeUndefined();
        expect(entry.oauthToken).toBeUndefined();
      }

      const unknown = await server.inject({ method: 'GET', url: '/v1/providers/ghost/models' });
      expect(unknown.statusCode).toBe(200);
      expect(unknown.json()).toMatchObject({ provider: 'ghost', models: [] });
    } finally {
      await server.close();
    }
  });

  it('lists the CLI provider catalog and adds a registry provider atomically', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir());
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const catalog = await server.inject({ method: 'GET', url: '/v1/providers/catalog' });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().providers[0]).toMatchObject({
        name: 'ollama',
        label: 'Ollama (local)',
        kind: 'local',
        type: 'ollama',
        defaultBaseUrl: 'http://localhost:11434',
      });
      expect(catalog.json().providers.at(-1)).toMatchObject({
        name: 'custom',
        label: 'Custom OpenAI-compatible endpoint',
      });

      const added = await server.inject({
        method: 'POST',
        url: '/v1/providers',
        payload: {
          name: 'gemini',
          proxy: 'http://127.0.0.1:7890',
          apiKey: 'raw-secret-must-be-ignored',
        },
      });
      expect(added.statusCode).toBe(201);
      expect(added.json().config.providers.gemini).toMatchObject({
        type: 'openai-compatible',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKeyEnv: 'GEMINI_API_KEY',
        proxy: 'http://127.0.0.1:7890',
        hasApiKey: false,
      });
      expect(fs.readFileSync(loadedConfig.configPath, 'utf-8')).not.toContain('raw-secret');

      const duplicate = await server.inject({
        method: 'POST',
        url: '/v1/providers',
        payload: { name: 'gemini' },
      });
      expect(duplicate.statusCode).toBe(400);
      expect(duplicate.json().error.message).toMatch(/already configured/);

      const incomplete = await server.inject({
        method: 'POST',
        url: '/v1/providers',
        payload: { name: 'custom' },
      });
      expect(incomplete.statusCode).toBe(400);
      expect(incomplete.json().error.message).toMatch(/requires a server URL/);
    } finally {
      await server.close();
    }
  });

  it('removes provider config, credentials, and saved models with reference guards', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir());
    loadedConfig.config.providers.xai = {
      type: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'short-lived-access',
      oauthToken: 'refresh-token',
    };
    loadedConfig.config.models.options.push('xai/grok-4.5');
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const defaultProvider = await server.inject({ method: 'DELETE', url: '/v1/providers/ollama' });
      expect(defaultProvider.statusCode).toBe(400);
      expect(defaultProvider.json().error.message).toMatch(/current default provider/);

      scaffoldProfile(loadedConfig.config.paths.profilesDir, 'grokker');
      fs.writeFileSync(
        path.join(loadedConfig.config.paths.profilesDir, 'grokker', 'profile.toml'),
        'provider = "xai"\nmodel = "grok-4.5"\n',
      );
      const profileProvider = await server.inject({ method: 'DELETE', url: '/v1/providers/xai' });
      expect(profileProvider.statusCode).toBe(400);
      expect(profileProvider.json().error.message).toMatch(/profile 'grokker'/);

      fs.writeFileSync(
        path.join(loadedConfig.config.paths.profilesDir, 'grokker', 'profile.toml'),
        'memories = true\n',
      );
      const removed = await server.inject({ method: 'DELETE', url: '/v1/providers/xai' });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({
        removed: true,
        removedModels: ['xai/grok-4.5'],
      });
      expect(removed.json().config.providers.xai).toBeUndefined();
      expect(removed.json().models.options).not.toContain('xai/grok-4.5');
      expect(fs.readFileSync(loadedConfig.configPath, 'utf-8')).not.toContain('refresh-token');
    } finally {
      await server.close();
    }
  });

  it('avatar routes: PUT stores, GET serves bytes with ETag, DELETE removes', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir());
    scaffoldProfile(loadedConfig.config.paths.profilesDir, 'painter');
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const missing = await server.inject({ method: 'GET', url: '/v1/profiles/painter/avatar' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('AVATAR_NOT_FOUND');

      const png = Buffer.from('not-a-real-png-but-bytes');
      const put = await server.inject({
        method: 'PUT',
        url: '/v1/profiles/painter/avatar',
        payload: { data: png.toString('base64'), mediaType: 'image/png' },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().profile.avatar).toEqual({ mediaType: 'image/png' });

      const got = await server.inject({ method: 'GET', url: '/v1/profiles/painter/avatar' });
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(got.rawPayload.equals(png)).toBe(true);
      const etag = got.headers.etag as string;
      expect(etag).toBeTruthy();

      const cached = await server.inject({
        method: 'GET',
        url: '/v1/profiles/painter/avatar',
        headers: { 'if-none-match': etag },
      });
      expect(cached.statusCode).toBe(304);

      const badType = await server.inject({
        method: 'PUT',
        url: '/v1/profiles/painter/avatar',
        payload: { data: png.toString('base64'), mediaType: 'image/tiff' },
      });
      expect(badType.statusCode).toBe(400);

      const removed = await server.inject({ method: 'DELETE', url: '/v1/profiles/painter/avatar' });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().removed).toBe(true);
      expect(removed.json().profile.avatar).toBeUndefined();
      expect((await server.inject({ method: 'GET', url: '/v1/profiles/painter/avatar' })).statusCode).toBe(404);

      const unknown = await server.inject({ method: 'GET', url: '/v1/profiles/ghost/avatar' });
      expect(unknown.statusCode).toBe(400); // PROFILE_INVALID from the up-front guard
    } finally {
      await server.close();
    }
  });
});
