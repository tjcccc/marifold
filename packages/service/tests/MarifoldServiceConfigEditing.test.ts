import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
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
      expect(settings).toMatchObject({
        mode: 'chat', provider: 'ollama', model: 'codellama',
        memories: false, think: true, sessionContextTurns: 5,
      });
      expect(settings.agent.approval.shell).toBe('deny');

      // null clears: model override, think, the approval override, the turn window.
      const cleared = await server.inject({
        method: 'PATCH',
        url: '/v1/profiles/writer',
        payload: { provider: null, model: null, think: null, sessionContextTurns: null, approval: { shell: null } },
      });
      expect(cleared.statusCode).toBe(200);
      const after = cleared.json().profile.settings;
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
});
