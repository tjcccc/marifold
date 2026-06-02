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
model = "llama3.2"
profile = "default"
timeout_seconds = 30

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
    expect(loaded.config.default.model).toBe('llama3.2');
    expect(loaded.config.default.timeoutSeconds).toBe(30);
    expect(loaded.config.paths.profilesDir).toBe(path.join(dir, 'profiles'));
    expect(loaded.config.providers.ollama.baseUrl).toBe('http://localhost:11434');
  });

  it('throws when an explicit config path is missing', () => {
    const missing = path.join(tempDir(), 'missing.toml');

    expect(() => new ConfigLoader().load({ configPath: missing })).toThrow(MarifoldError);
  });
});
