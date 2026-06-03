import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderInspector } from '../src';
import { LoadedMarifoldConfig } from '../src/config/ConfigSchema';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TEST_OPENAI_KEY;
});

describe('ProviderInspector', () => {
  it('validates an Ollama model from the live model list', async () => {
    const loadedConfig = testConfig();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: 'gemma4:e4b' }],
    }), { status: 200 })));

    const result = await new ProviderInspector(loadedConfig).validateModel('ollama', 'gemma4:e4b');

    expect(result).toMatchObject({
      provider: 'ollama',
      model: 'gemma4:e4b',
      valid: true,
      status: 'ok',
    });
  });

  it('fails validation when a listed provider does not have the model', async () => {
    const loadedConfig = testConfig();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: 'qwen3:8b' }],
    }), { status: 200 })));

    const result = await new ProviderInspector(loadedConfig).validateModel('ollama', 'gemma4:e4b');

    expect(result).toMatchObject({
      valid: false,
      status: 'error',
    });
  });

  it('fails validation when a provider api key env var is missing', async () => {
    const loadedConfig = testConfig();

    const result = await new ProviderInspector(loadedConfig).validateModel('openai', 'gpt-test');

    expect(result).toMatchObject({
      valid: false,
      status: 'error',
      message: 'Missing environment variable TEST_OPENAI_KEY.',
    });
  });

  it('warns when live validation is unavailable for a configured provider type', async () => {
    const loadedConfig = testConfig();
    process.env.TEST_OPENAI_KEY = 'test-key';

    const result = await new ProviderInspector(loadedConfig).validateModel('anthropic', 'claude-test');

    expect(result).toMatchObject({
      valid: true,
      status: 'warning',
    });
  });
});

function testConfig(): LoadedMarifoldConfig {
  const root = path.join('/tmp', 'marifold-provider-test');
  return {
    configPath: path.join(root, 'config.toml'),
    foundConfig: true,
    config: {
      default: {
        provider: 'ollama',
        model: 'gemma4:e4b',
        profile: 'default',
        think: false,
      },
      models: {
        options: ['ollama/gemma4:e4b'],
      },
      memory: {
        sizeLimit: 50000,
        contextLimit: 2400,
      },
      paths: {
        profilesDir: path.join(root, 'profiles'),
        sessionsDb: path.join(root, 'sessions.db'),
      },
      providers: {
        ollama: {
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
        },
        openai: {
          type: 'openai-compatible',
          baseUrl: 'https://api.openai.com',
          apiKeyEnv: 'TEST_OPENAI_KEY',
        },
        anthropic: {
          type: 'anthropic',
          apiKeyEnv: 'TEST_OPENAI_KEY',
        },
      },
    },
  };
}
