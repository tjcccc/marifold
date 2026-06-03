import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader, MarifoldError } from '../src';

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

[providers.ollama]
type = "ollama"
base_url = "http://localhost:11434"
`);

    const loaded = new ConfigLoader().load({ configPath });

    expect(loaded.foundConfig).toBe(true);
    expect(loaded.config.default.provider).toBe('ollama');
    expect(loaded.config.default.model).toBe('gemma4:e4b');
    expect(loaded.config.default.timeoutSeconds).toBe(30);
    expect(loaded.config.models.options).toEqual(['ollama/gemma4:e4b', 'openai/gpt-4o-mini']);
    expect(loaded.config.memory).toEqual({ sizeLimit: 1000, contextLimit: 120 });
    expect(loaded.config.paths.profilesDir).toBe(path.join(dir, 'profiles'));
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
});
