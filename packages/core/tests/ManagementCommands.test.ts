import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteSessionStore } from '@priest-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader, ConfigManager, ProfileManager, SessionResolver } from '../src';

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
});
