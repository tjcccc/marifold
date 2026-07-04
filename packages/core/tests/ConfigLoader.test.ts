import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader, ConfigManager, MarifoldError } from '../src';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ConfigLoader', () => {
  it('loads provider, model, paths, and provider config from TOML', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
provider = "ollama"
model = "gemma4:e4b"
profile = "default"
timeout_seconds = 30
think = true

[models]
options = [
  "ollama/gemma4:e4b",
  "openai/gpt-4o-mini",
]

[memory]
size_limit = 1000
context_limit = 120

[paths]
profiles_dir = "${dir}/profiles"
sessions_db = "${dir}/sessions.db"
tasks_dir = "${dir}/tasks"

[providers.ollama]
type = "ollama"
base_url = "http://localhost:11434"
`);

    const loaded = new ConfigLoader().load({ configPath });

    expect(loaded.foundConfig).toBe(true);
    expect(loaded.config.default.provider).toBe('ollama');
    expect(loaded.config.default.model).toBe('gemma4:e4b');
    expect(loaded.config.default.timeoutSeconds).toBe(30);
    expect(loaded.config.default.think).toBe(true);
    expect(loaded.config.models.options).toEqual(['ollama/gemma4:e4b', 'openai/gpt-4o-mini']);
    expect(loaded.config.memory).toEqual({ sizeLimit: 1000, contextLimit: 120 });
    expect(loaded.config.paths.profilesDir).toBe(path.join(dir, 'profiles'));
    expect(loaded.config.paths.sessionsDb).toBe(path.join(dir, 'sessions.db'));
    expect(loaded.config.paths.tasksDir).toBe(path.join(dir, 'tasks'));
    expect(loaded.config.providers.ollama.baseUrl).toBe('http://localhost:11434');
  });

  it('throws when an explicit config path is missing', () => {
    const missing = path.join(tempDir(), 'missing.toml');

    expect(() => new ConfigLoader().load({ configPath: missing })).toThrow(MarifoldError);
  });

  it('uses memory defaults when the memory table is absent', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
provider = "ollama"
model = "gemma4:e4b"
profile = "default"

[paths]
profiles_dir = "${dir}/profiles"
sessions_db = "${dir}/sessions.db"
`);

    const loaded = new ConfigLoader().load({ configPath });

    expect(loaded.config.memory).toEqual({ sizeLimit: 50000, contextLimit: 2400 });
  });

  it('omits agent config when [agent] is absent and normalizes it when present', () => {
    const dir = tempDir();
    const bare = path.join(dir, 'bare.toml');
    fs.writeFileSync(bare, `
[default]
provider = "ollama"
model = "gemma4:e4b"
profile = "default"
`);
    expect(new ConfigLoader().load({ configPath: bare }).config.agent).toBeUndefined();

    const withAgent = path.join(dir, 'agent.toml');
    fs.writeFileSync(withAgent, `
[default]
provider = "ollama"
model = "gemma4:e4b"
profile = "default"

[agent]
max_iterations = 8
tool_mode = "control-block"

[agent.approval]
shell = "deny"
`);
    const loaded = new ConfigLoader().load({ configPath: withAgent });
    expect(loaded.config.agent).toEqual({
      approval: { read: 'allow', write: 'ask', shell: 'deny', network: 'ask', delegate: 'allow' },
      trustedFolders: [],
      maxIterations: 8,
      toolOutputLimit: 100000,
      toolMode: 'control-block',
    });
  });

  it('rejects invalid agent approval modes', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
profile = "default"

[agent.approval]
write = "maybe"
`);
    expect(() => new ConfigLoader().load({ configPath })).toThrow(/allow.*ask.*deny/);
  });

  it('parses [channel.telegram] (and rejects a bad default_mode)', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
profile = "default"

[channel.telegram]
bot_token_env = "MARIFOLD_TG_TOKEN"
allowlist = [123, 456]
profile = "messenger"
default_mode = "agent"
`);
    const tg = new ConfigLoader().load({ configPath }).config.channels?.telegram;
    expect(tg).toEqual({
      enabled: undefined,
      botTokenEnv: 'MARIFOLD_TG_TOKEN',
      botToken: undefined,
      allowlist: [123, 456],
      profile: 'messenger',
      defaultMode: 'agent',
    });

    fs.writeFileSync(configPath, '[default]\nprofile = "default"\n[channel.telegram]\nprofile = "x"\ndefault_mode = "wizard"\n');
    expect(() => new ConfigLoader().load({ configPath })).toThrow(/default_mode/);
  });

  it('parses [service] and round-trips it through a config rewrite', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `
[default]
profile = "default"

[service]
token_env = "MARIFOLD_SERVICE_TOKEN"
cors_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
`);
    const loaded = new ConfigLoader().load({ configPath });
    expect(loaded.config.service).toEqual({
      tokenEnv: 'MARIFOLD_SERVICE_TOKEN',
      token: undefined,
      corsOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    });

    // A ConfigManager rewrite must preserve the section.
    new ConfigManager(loaded).setValue('default.model', 'gemma4:e4b');
    const reloaded = new ConfigLoader().load({ configPath });
    expect(reloaded.config.service).toEqual(loaded.config.service);
    expect(reloaded.config.default.model).toBe('gemma4:e4b');

    // Bad types are rejected with a dotted label.
    fs.writeFileSync(configPath, '[default]\nprofile = "default"\n[service]\ncors_origins = [42]\n');
    expect(() => new ConfigLoader().load({ configPath })).toThrow(/service\.cors_origins/);
  });
});
