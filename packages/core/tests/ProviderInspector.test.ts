import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderInspector } from '../src';
import { LoadedMarifoldConfig } from '../src/config/ConfigSchema';
import { openAIChatCompletionsUrl, openAIModelsUrl, openAIResponsesUrl } from '../src/config/OpenAICompatUrls';

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

  it('lists curated registry models for providers before they are configured', async () => {
    const loadedConfig = testConfig();

    const result = await new ProviderInspector(loadedConfig).listModels('gemini');

    expect(result.reachable).toBeNull();
    expect(result.models).toContain('gemini-2.5-flash');
    expect(result.message).toContain('registry models');
  });

  it('lists only supported registry models for GitHub Copilot fallback', async () => {
    const loadedConfig = testConfig();

    const result = await new ProviderInspector(loadedConfig).listModels('github_copilot');

    expect(result.reachable).toBeNull();
    expect(result.models).toContain('gpt-5.4');
    expect(result.models).toContain('gpt-5.4-mini');
    expect(result.models).toContain('gemini-3.1-pro-preview');
    expect(result.models).toContain('gemini-3.5-flash');
    expect(result.models).not.toContain('gpt-5.4-nano');
    expect(result.models).not.toContain('grok-code-fast-1');
    expect(result.models).not.toContain('goldeneye');
  });

  it('filters GitHub Copilot live models to supported picker models', async () => {
    const loadedConfig = testConfig();
    loadedConfig.config.providers.github_copilot = {
      type: 'openai-compatible',
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'tid=test',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'gpt-5.4-mini',
          capabilities: { type: 'chat' },
          model_picker_enabled: true,
          supported_endpoints: ['/responses'],
        },
        {
          id: 'gpt-5-mini',
          capabilities: { type: 'chat' },
          model_picker_enabled: true,
          supported_endpoints: ['/chat/completions', '/responses'],
        },
        {
          id: 'text-embedding-3-small',
          capabilities: { type: 'embeddings' },
          model_picker_enabled: false,
          supported_endpoints: ['/embeddings'],
        },
        {
          id: 'oswe-vscode-prime',
          capabilities: { type: 'chat' },
          model_picker_enabled: true,
          supported_endpoints: ['/chat/completions'],
        },
      ],
    }), { status: 200 })));

    const result = await new ProviderInspector(loadedConfig).listModels('github_copilot');

    expect(result.models).toEqual(['gpt-5-mini', 'gpt-5.4-mini']);
  });

  it('does not fall back to registry models when live GitHub Copilot listing has only incompatible models', async () => {
    const loadedConfig = testConfig();
    loadedConfig.config.providers.github_copilot = {
      type: 'openai-compatible',
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'tid=test',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'gpt-5.4-nano',
          capabilities: { type: 'chat' },
          model_picker_enabled: true,
          supported_endpoints: ['/responses'],
        },
        {
          id: 'text-embedding-3-small',
          capabilities: { type: 'embeddings' },
          model_picker_enabled: false,
          supported_endpoints: ['/embeddings'],
        },
      ],
    }), { status: 200 })));

    const result = await new ProviderInspector(loadedConfig).listModels('github_copilot');

    expect(result.reachable).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.message).toBe('0 model(s) available.');
  });

  it('validates GitHub Copilot responses-only models as supported chat models', async () => {
    const loadedConfig = testConfig();
    loadedConfig.config.providers.github_copilot = {
      type: 'openai-compatible',
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'tid=test',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'gpt-5.4-mini',
          capabilities: { type: 'chat' },
          model_picker_enabled: true,
          supported_endpoints: ['/responses'],
        },
      ],
    }), { status: 200 })));

    const result = await new ProviderInspector(loadedConfig).validateModel('github_copilot', 'gpt-5.4-mini');

    expect(result).toMatchObject({
      valid: true,
      status: 'ok',
    });
  });

  it('lists selectable ChatGPT models from the authenticated Codex catalog', async () => {
    const loadedConfig = testConfig();
    loadedConfig.config.providers.chatgpt = {
      type: 'openai-compatible',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'access-token',
      accountId: 'acct_123',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-5.6-luna', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-hidden', visibility: 'hide', supported_in_api: true },
        { slug: 'gpt-on-request', visibility: 'on_request', supported_in_api: true },
        { slug: 'gpt-unsupported', visibility: 'list', supported_in_api: false },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ProviderInspector(loadedConfig).listModels('chatgpt');

    expect(result).toMatchObject({
      reachable: true,
      models: ['gpt-5.6-luna', 'gpt-5.6-sol'],
      message: '2 model(s) available.',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.149.0');
    expect(headers.get('Authorization')).toBe('Bearer access-token');
    expect(headers.get('chatgpt-account-id')).toBe('acct_123');
    expect(headers.get('originator')).toBe('codex_cli_rs');
  });

  it('does not offer known ChatGPT models when a live catalog has no selectable entries', async () => {
    const loadedConfig = testConfig();
    loadedConfig.config.providers.chatgpt = {
      type: 'openai-compatible',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'access-token',
      accountId: 'acct_123',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{ slug: 'gpt-hidden', visibility: 'hide', supported_in_api: true }],
    }), { status: 200 })));

    const result = await new ProviderInspector(loadedConfig).listModels('chatgpt');

    expect(result.reachable).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.message).toBe('0 model(s) available.');
  });

  it('falls back to known ChatGPT models when live catalog discovery fails', async () => {
    const loadedConfig = testConfig();
    loadedConfig.config.providers.chatgpt = {
      type: 'openai-compatible',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'access-token',
      accountId: 'acct_123',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));

    const result = await new ProviderInspector(loadedConfig).listModels('chatgpt');

    expect(result.reachable).toBe(false);
    expect(result.models).toEqual(['gpt-5.5', 'gpt-5.3-codex', 'gpt-5.4-mini']);
    expect(result.message).toContain('Showing registry models.');
  });

  it('builds OpenAI-compatible URLs for root and versioned provider bases', () => {
    expect(openAIChatCompletionsUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/chat/completions');
    expect(openAIChatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    expect(openAIModelsUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/models',
    );
    expect(openAIResponsesUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/responses',
    );
    expect(openAIChatCompletionsUrl('https://api.githubcopilot.com', { providerName: 'github_copilot' })).toBe(
      'https://api.githubcopilot.com/chat/completions',
    );
    expect(openAIResponsesUrl('https://api.githubcopilot.com', { providerName: 'github_copilot' })).toBe(
      'https://api.githubcopilot.com/responses',
    );
    expect(openAIModelsUrl('https://api.githubcopilot.com', { providerName: 'github_copilot' })).toBe(
      'https://api.githubcopilot.com/models',
    );
    expect(openAIModelsUrl('https://chatgpt.com/backend-api/codex', { providerName: 'chatgpt' })).toBe(
      'https://chatgpt.com/backend-api/codex/models',
    );
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
        tasksDir: path.join(root, 'tasks'),
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
