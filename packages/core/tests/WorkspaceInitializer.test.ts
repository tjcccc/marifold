import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader, MarifoldError, ProfileResolver, WorkspaceInitializer } from '../src';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-init-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorkspaceInitializer', () => {
  it('creates config and a priests-style default profile', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    const profilesDir = path.join(dir, 'profiles');
    const sessionsDb = path.join(dir, 'sessions.db');

    const result = new WorkspaceInitializer().initialize({
      configPath,
      profilesDir,
      sessionsDb,
    });

    expect(result.configPath).toBe(configPath);
    expect(result.provider).toBe('ollama');
    expect(result.model).toBe('gemma4:e4b');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, 'default', 'PROFILE.md'))).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, 'default', 'RULES.md'))).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, 'default', 'CUSTOM.md'))).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, 'default', 'profile.toml'))).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, 'default', 'memories', 'user.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, 'default', 'memories', 'preferences.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, 'default', 'memories', 'auto_short.jsonl'))).toBe(true);

    const loaded = new ConfigLoader().load({ configPath });
    expect(loaded.config.default).toMatchObject({
      provider: 'ollama',
      model: 'gemma4:e4b',
      profile: 'default',
    });
    expect(loaded.config.models.options).toEqual(['ollama/gemma4:e4b']);
    expect(loaded.config.memory).toEqual({ sizeLimit: 50000, contextLimit: 2400 });
    expect(loaded.config.paths.profilesDir).toBe(profilesDir);
    expect(new ProfileResolver(profilesDir).list()).toMatchObject([
      { name: 'default', source: 'directory' },
    ]);
  });

  it('refuses to overwrite config unless force is set', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    const profilesDir = path.join(dir, 'profiles');
    const sessionsDb = path.join(dir, 'sessions.db');
    const initializer = new WorkspaceInitializer();

    initializer.initialize({ configPath, profilesDir, sessionsDb });

    expect(() => initializer.initialize({ configPath, profilesDir, sessionsDb })).toThrow(MarifoldError);
  });

  it('rewrites config with force while preserving existing profile files', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    const profilesDir = path.join(dir, 'profiles');
    const sessionsDb = path.join(dir, 'sessions.db');
    const profilePath = path.join(profilesDir, 'default', 'PROFILE.md');
    const initializer = new WorkspaceInitializer();

    initializer.initialize({ configPath, profilesDir, sessionsDb });
    fs.writeFileSync(profilePath, 'Custom profile content');

    const result = initializer.initialize({
      configPath,
      profilesDir,
      sessionsDb,
      force: true,
      provider: 'openai',
      model: 'gpt-test',
    });

    const loaded = new ConfigLoader().load({ configPath });
    expect(loaded.config.default.provider).toBe('openai');
    expect(loaded.config.default.model).toBe('gpt-test');
    expect(loaded.config.providers.openai).toMatchObject({
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
    expect(loaded.config.models.options).toEqual(['openai/gpt-test']);
    expect(fs.readFileSync(profilePath, 'utf-8')).toBe('Custom profile content');
    expect(result.files.find(file => file.path === profilePath)?.status).toBe('kept');
  });
});
