import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteSessionStore } from '@priest-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigLoader,
  ConfigManager,
  ProfileManager,
  SessionResolver,
  exportConfigBackup,
  importConfigBackup,
} from '../src';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-management-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function minimalConfigToml(dir: string): string {
  return `
[default]
provider = "ollama"
model = "gemma4:e4b"
profile = "default"
think = false

[models]
options = [
  "ollama/gemma4:e4b",
]

[memory]
size_limit = 50000
context_limit = 2400

[paths]
profiles_dir = "${dir}/profiles"
sessions_db = "${dir}/sessions.db"

[providers.ollama]
type = "ollama"
base_url = "http://localhost:11434"
`;
}

describe('ConfigManager', () => {
  it('sets dotted config values and writes TOML', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
provider = "ollama"
model = "gemma4:e4b"
profile = "default"
think = false

[models]
options = [
  "ollama/gemma4:e4b",
]

[memory]
size_limit = 50000
context_limit = 2400

[paths]
profiles_dir = "${dir}/profiles"
sessions_db = "${dir}/sessions.db"

[providers.ollama]
type = "ollama"
base_url = "http://localhost:11434"
`);

    const loaded = new ConfigLoader().load({ configPath });
    new ConfigManager(loaded).setValue('default.model', 'qwen3:8b');
    new ConfigManager(new ConfigLoader().load({ configPath })).setValue('default.think', 'true');
    new ConfigManager(new ConfigLoader().load({ configPath })).setValue('providers.openai.type', 'openai-compatible');
    new ConfigManager(new ConfigLoader().load({ configPath })).setValue('providers.openai.base_url', 'https://api.openai.com');
    new ConfigManager(new ConfigLoader().load({ configPath })).addModel('openai', 'gpt-4o-mini', {
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
    new ConfigManager(new ConfigLoader().load({ configPath })).setValue('memory.context_limit', '1200');

    const updated = new ConfigLoader().load({ configPath });
    expect(updated.config.default.model).toBe('qwen3:8b');
    expect(updated.config.default.think).toBe(true);
    expect(updated.config.memory.contextLimit).toBe(1200);
    expect(updated.config.providers.openai).toMatchObject({
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
    expect(updated.config.models.options).toContain('openai/gpt-4o-mini');
  });

  it('sets service.* keys, creating the section, and round-trips through the loader', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, minimalConfigToml(dir));

    // No [service] section in the file yet — first write creates it.
    new ConfigManager(new ConfigLoader().load({ configPath })).setValue('service.web_dir', `${dir}/web`);
    new ConfigManager(new ConfigLoader().load({ configPath })).setValue('service.token_env', 'MARIFOLD_TOKEN');
    new ConfigManager(new ConfigLoader().load({ configPath }))
      .setValue('service.cors_origins', 'http://localhost:5173, http://127.0.0.1:5173');

    const updated = new ConfigLoader().load({ configPath });
    expect(updated.config.service).toMatchObject({
      webDir: `${dir}/web`,
      tokenEnv: 'MARIFOLD_TOKEN',
      corsOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    });

    // Empty string clears optional keys / empties the origin list.
    const manager = new ConfigManager(updated);
    manager.setValue('service.token_env', '');
    manager.setValue('service.cors_origins', '');
    const cleared = new ConfigLoader().load({ configPath });
    expect(cleared.config.service?.tokenEnv).toBeUndefined();
    expect(cleared.config.service?.corsOrigins).toEqual([]);

    expect(() => manager.setValue('service.nope', 'x')).toThrow(/Unknown config key: service\.nope/);
  });

  it('sets global agent approvals and web-search fields through dotted keys', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, minimalConfigToml(dir));
    const manager = new ConfigManager(new ConfigLoader().load({ configPath }));

    manager.setValue('agent.approval.shell', 'deny');
    manager.setValue('agent.tool_mode', 'native');
    manager.setValue('agent.max_iterations', '12');
    manager.setValue('web_search.enabled', 'true');
    manager.setValue('web_search.provider', 'firecrawl');
    manager.setValue('web_search.max_results', '8');
    manager.setValue('web_search.scrape', 'true');
    manager.setValue('web_search.api_key_env', 'FIRECRAWL_API_KEY');

    const updated = new ConfigLoader().load({ configPath });
    expect(updated.config.agent).toMatchObject({
      approval: { shell: 'deny' },
      toolMode: 'native',
      maxIterations: 12,
    });
    expect(updated.config.webSearch).toMatchObject({
      enabled: true,
      provider: 'firecrawl',
      maxResults: 8,
      scrape: true,
      apiKeyEnv: 'FIRECRAWL_API_KEY',
    });
    const readback = new ConfigManager(updated);
    expect(readback.getValue('agent.approval.shell')).toBe('deny');
    expect(readback.getValue('web_search.provider')).toBe('firecrawl');
  });

  it('getValue mirrors setValue keys (arrays comma-joined, unset = undefined, unknown throws)', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, minimalConfigToml(dir));

    const manager = new ConfigManager(new ConfigLoader().load({ configPath }));
    expect(manager.getValue('default.model')).toBe('gemma4:e4b');
    expect(manager.getValue('default.think')).toBe('false');
    expect(manager.getValue('default.max_context_tokens')).toBeUndefined(); // known key, unset
    expect(manager.getValue('providers.ollama.base_url')).toBe('http://localhost:11434');
    expect(manager.getValue('service.web_dir')).toBeUndefined(); // section absent entirely

    manager.setValue('service.cors_origins', 'http://a.test,http://b.test');
    expect(manager.getValue('service.cors_origins')).toBe('http://a.test, http://b.test');

    expect(() => manager.getValue('default.nope')).toThrow(/Unknown config key: default\.nope/);
    expect(() => manager.getValue('nonsense')).toThrow(/Unknown config key/);
  });

  it('adds priests-registry provider defaults when adding known models', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
profile = "default"
think = false

[models]
options = []

[memory]
size_limit = 50000
context_limit = 2400

[paths]
profiles_dir = "${dir}/profiles"
sessions_db = "${dir}/sessions.db"
`);

    new ConfigManager(new ConfigLoader().load({ configPath })).addModel('openai', 'gpt-4o-mini');

    const updated = new ConfigLoader().load({ configPath });
    expect(updated.config.providers.openai).toEqual({
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
    expect(updated.config.models.options).toContain('openai/gpt-4o-mini');
  });

  it('adds provider registry defaults without accepting raw credentials', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
profile = "default"
think = false

[models]
options = []

[memory]
size_limit = 50000
context_limit = 2400

[paths]
profiles_dir = "${dir}/profiles"
sessions_db = "${dir}/sessions.db"
`);

    const manager = new ConfigManager(new ConfigLoader().load({ configPath }));
    manager.addProvider('gemini', { proxy: '  http://127.0.0.1:7890  ' });
    expect(manager.config.providers.gemini).toEqual({
      type: 'openai-compatible',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyEnv: 'GEMINI_API_KEY',
      proxy: 'http://127.0.0.1:7890',
    });
    expect(() => manager.addProvider('custom')).toThrow(/requires a server URL/);
    expect(() => manager.addProvider('unknown')).toThrow(/Unknown provider/);

    const saved = fs.readFileSync(configPath, 'utf-8');
    expect(saved).toContain('[providers.gemini]');
    expect(saved).not.toContain('api_key =');
  });

  it('removes a non-default provider with its credentials and model options', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, minimalConfigToml(dir));
    const manager = new ConfigManager(new ConfigLoader().load({ configPath }));
    manager.addModel('xai', 'grok-4.5', {
      type: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'short-lived-access',
      oauthToken: 'refresh-token',
    });

    const result = manager.removeProvider('xai');
    expect(result).toMatchObject({
      removed: true,
      removedModels: ['xai/grok-4.5'],
    });

    const updated = new ConfigLoader().load({ configPath });
    expect(updated.config.providers.xai).toBeUndefined();
    expect(updated.config.models.options).not.toContain('xai/grok-4.5');
    const saved = fs.readFileSync(configPath, 'utf-8');
    expect(saved).not.toContain('[providers.xai]');
    expect(saved).not.toContain('refresh-token');
  });

  it('refuses to remove the current default provider', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, minimalConfigToml(dir));
    const manager = new ConfigManager(new ConfigLoader().load({ configPath }));

    expect(() => manager.removeProvider('ollama')).toThrow(
      /Cannot remove the current default provider 'ollama'/,
    );
    expect(manager.config.providers.ollama).toBeDefined();
  });

  it('persists local provider credentials when adding an OAuth model', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
profile = "default"
think = false

[models]
options = []

[memory]
size_limit = 50000
context_limit = 2400

[paths]
profiles_dir = "${dir}/profiles"
sessions_db = "${dir}/sessions.db"
`);

    new ConfigManager(new ConfigLoader().load({ configPath })).addModel('github_copilot', 'gpt-5.4', {
      apiKey: 'tid=test',
      oauthToken: 'gho-test',
      apiKeyExpiresAt: 1893456000,
    });

    const updated = new ConfigLoader().load({ configPath });
    expect(updated.config.providers.github_copilot).toMatchObject({
      type: 'openai-compatible',
      baseUrl: 'https://api.githubcopilot.com',
      apiKeyEnv: 'GITHUB_COPILOT_API_KEY',
      apiKey: 'tid=test',
      oauthToken: 'gho-test',
      apiKeyExpiresAt: 1893456000,
    });
    expect(updated.config.models.options).toContain('github_copilot/gpt-5.4');
  });

  it('removes saved model options without deleting providers or defaults', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
provider = "openai"
model = "gpt-test"
profile = "default"
think = false

[models]
options = [
  "ollama/gemma4:e4b",
  "openai/gpt-test",
]

[memory]
size_limit = 50000
context_limit = 2400

[paths]
profiles_dir = "${dir}/profiles"
sessions_db = "${dir}/sessions.db"

[providers.openai]
type = "openai-compatible"
base_url = "https://api.openai.com"
`);

    const result = new ConfigManager(new ConfigLoader().load({ configPath })).removeModel('openai', 'gpt-test');
    const updated = new ConfigLoader().load({ configPath });

    expect(result.removed).toBe(true);
    expect(result.wasDefault).toBe(true);
    expect(updated.config.default).toMatchObject({ provider: 'openai', model: 'gpt-test' });
    expect(updated.config.models.options).not.toContain('openai/gpt-test');
    expect(updated.config.providers.openai).toBeDefined();
  });
});

describe('ProfileManager', () => {
  it('scaffolds profiles and updates model overrides', () => {
    const profilesDir = path.join(tempDir(), 'profiles');
    const manager = new ProfileManager(profilesDir);

    const created = manager.init('coder');
    expect(fs.existsSync(path.join(created.path, 'PROFILE.md'))).toBe(true);
    expect(fs.existsSync(path.join(created.path, 'memories', 'user.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(created.path, 'memories', 'preferences.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(created.path, 'memories', 'auto_short.jsonl'))).toBe(true);

    const override = manager.setModelOverride('coder', 'ollama', 'qwen3:8b');
    expect(fs.readFileSync(override.path, 'utf-8')).toContain('model = "qwen3:8b"');

    manager.clearModelOverride('coder');
    expect(fs.readFileSync(override.path, 'utf-8')).not.toContain('model = "qwen3:8b"');
  });

  it('renames and deletes stored profiles', () => {
    const profilesDir = path.join(tempDir(), 'profiles');
    const manager = new ProfileManager(profilesDir);

    manager.init('writer');
    const renamed = manager.rename('writer', 'editor');
    expect(fs.existsSync(renamed.fromPath)).toBe(false);
    expect(fs.existsSync(path.join(profilesDir, 'editor', 'PROFILE.md'))).toBe(true);

    const deleted = manager.delete('editor');
    expect(fs.existsSync(deleted.path)).toBe(false);
  });
});

describe('ConfigBackup', () => {
  it('exports and imports config, profile files, memories, and optional sessions', async () => {
    const sourceDir = tempDir();
    const sourceConfigPath = path.join(sourceDir, 'config.toml');
    const sourceProfilesDir = path.join(sourceDir, 'profiles');
    const sourceSessionsDb = path.join(sourceDir, 'sessions.db');
    fs.writeFileSync(sourceConfigPath, `
[default]
provider = "ollama"
model = "gemma4:e4b"
profile = "default"
think = false

[models]
options = [
  "ollama/gemma4:e4b",
]

[memory]
size_limit = 50000
context_limit = 2400

[paths]
profiles_dir = "${sourceProfilesDir}"
sessions_db = "${sourceSessionsDb}"

[providers.ollama]
type = "ollama"
base_url = "http://localhost:11434"
`);
    new ProfileManager(sourceProfilesDir).init('friend');
    fs.appendFileSync(path.join(sourceProfilesDir, 'friend', 'memories', 'user.jsonl'), '{"text":"likes tea"}\n');
    const store = new SQLiteSessionStore(sourceSessionsDb);
    store.open();
    try {
      const session = await store.create('friend', 'backup-session');
      session.appendTurn('user', 'hello');
      await store.save(session);
    } finally {
      store.close();
    }

    const backupPath = path.join(sourceDir, 'backup.json');
    const exported = exportConfigBackup(new ConfigLoader().load({ configPath: sourceConfigPath }), backupPath, {
      includeSessions: true,
    });
    expect(exported.profileFileCount).toBeGreaterThan(0);
    expect(exported.includedSessions).toBe(true);

    const importTarget = new ConfigLoader().load({ configPath: sourceConfigPath });
    fs.rmSync(sourceProfilesDir, { recursive: true, force: true });
    fs.rmSync(sourceSessionsDb, { force: true });
    fs.rmSync(sourceConfigPath, { force: true });
    const imported = importConfigBackup(importTarget, backupPath, {
      force: true,
    });

    expect(imported.restoredSessions).toBe(true);
    expect(fs.readFileSync(path.join(sourceProfilesDir, 'friend', 'memories', 'user.jsonl'), 'utf-8')).toContain('likes tea');
    expect(new SessionResolver(sourceSessionsDb).get('backup-session')?.turns[0]?.content).toBe('hello');
  });
});

describe('SessionResolver', () => {
  it('shows, renames, and deletes SQLite sessions', async () => {
    const dbPath = path.join(tempDir(), 'sessions.db');
    const store = new SQLiteSessionStore(dbPath);
    store.open();
    try {
      const session = await store.create('default', 'session-a');
      session.appendTurn('user', 'hello');
      session.appendTurn('assistant', 'hi');
      await store.save(session);
    } finally {
      store.close();
    }

    const resolver = new SessionResolver(dbPath);
    expect(resolver.get('session-a')?.turns.map(turn => turn.content)).toEqual(['hello', 'hi']);
    expect(resolver.list(50, 'default')).toHaveLength(1);
    expect(resolver.list(50, 'missing')).toHaveLength(0);
    expect(resolver.latest('default')?.id).toBe('session-a');
    expect(resolver.rename('session-a', 'session-b')).toBe(true);
    expect(resolver.get('session-a')).toBeUndefined();
    expect(resolver.get('session-b')?.turnCount).toBe(2);
    expect(resolver.delete('session-b')).toBe(true);
    expect(resolver.get('session-b')).toBeUndefined();
  });

  it('clears filtered sessions while keeping the newest matches', async () => {
    const dbPath = path.join(tempDir(), 'sessions.db');
    const store = new SQLiteSessionStore(dbPath);
    store.open();
    try {
      for (const id of ['session-a', 'session-b', 'session-c']) {
        const session = await store.create('default', id);
        session.appendTurn('user', id);
        await store.save(session);
      }
      const other = await store.create('other', 'other-session');
      other.appendTurn('user', 'other');
      await store.save(other);
    } finally {
      store.close();
    }

    const resolver = new SessionResolver(dbPath);
    const result = resolver.clear({ profileName: 'default', keepLast: 1 });
    expect(result.count).toBe(2);
    expect(resolver.list(50, 'default')).toHaveLength(1);
    expect(resolver.list(50, 'other')).toHaveLength(1);
  });
});
