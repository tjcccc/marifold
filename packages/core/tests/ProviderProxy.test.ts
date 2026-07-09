import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader, ConfigManager } from '../src';

const tempDirs: string[] = [];

function tempConfig(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-pproxy-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, body);
  return configPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('per-provider proxy', () => {
  it('parses a provider proxy from TOML', () => {
    const configPath = tempConfig(
      '[default]\nprofile = "default"\n\n[providers.xai]\ntype = "openai-compatible"\nbase_url = "https://api.x.ai/v1"\nproxy = "http://127.0.0.1:7890"\n',
    );
    const { config } = new ConfigLoader().load({ configPath });
    expect(config.providers.xai.proxy).toBe('http://127.0.0.1:7890');
  });

  it('leaves proxy undefined when not set (direct connection)', () => {
    const configPath = tempConfig('[default]\nprofile = "default"\n\n[providers.xai]\ntype = "openai-compatible"\n');
    const { config } = new ConfigLoader().load({ configPath });
    expect(config.providers.xai.proxy).toBeUndefined();
  });

  it('round-trips a provider proxy through save()', () => {
    const configPath = tempConfig(
      '[default]\nprofile = "default"\n\n[providers.xai]\ntype = "openai-compatible"\nproxy = "http://127.0.0.1:7890"\n',
    );
    const loaded = new ConfigLoader().load({ configPath });
    new ConfigManager(loaded).save();
    expect(new ConfigLoader().load({ configPath }).config.providers.xai.proxy).toBe('http://127.0.0.1:7890');
  });

  it('sets and clears a provider proxy via config set providers.<name>.proxy', () => {
    const configPath = tempConfig('[default]\nprofile = "default"\n\n[providers.xai]\ntype = "openai-compatible"\n');
    const manager = new ConfigManager(new ConfigLoader().load({ configPath }));
    manager.setValue('providers.xai.proxy', 'http://127.0.0.1:7890');
    expect(manager.getValue('providers.xai.proxy')).toBe('http://127.0.0.1:7890');
    expect(new ConfigLoader().load({ configPath }).config.providers.xai.proxy).toBe('http://127.0.0.1:7890');
    manager.setValue('providers.xai.proxy', '');
    expect(manager.getValue('providers.xai.proxy')).toBeUndefined();
  });
});
