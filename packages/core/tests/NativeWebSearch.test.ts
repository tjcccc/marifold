import { describe, expect, it } from 'vitest';
import { ProviderFactory } from '../src/config/ProviderFactory';
import type { MarifoldConfig, NativeWebSearchPreference } from '../src/config/ConfigSchema';
import { isNativeWebSearchCapabilityError } from '../src/runtime/NativeWebSearch';

function factory(
  providerName: string,
  nativeWebSearch?: NativeWebSearchPreference,
): ProviderFactory {
  const config: MarifoldConfig = {
    default: { provider: providerName, model: 'test', profile: 'default', think: false },
    models: { options: [] },
    memory: { sizeLimit: 1000, contextLimit: 100 },
    paths: { profilesDir: '/tmp/profiles', sessionsDb: '/tmp/sessions.db', tasksDir: '/tmp/tasks' },
    providers: {
      [providerName]: {
        type: 'openai-compatible',
        baseUrl: 'https://example.com/compatible-mode',
        nativeWebSearch,
      },
    },
  };
  return new ProviderFactory(config, '/tmp/config.toml');
}

describe('native web-search strategy', () => {
  it('uses Bailian Responses only for its verified newer model families', () => {
    const bailian = factory('bailian');
    expect(bailian.nativeWebSearchStrategy('bailian', 'qwen3.5-plus')).toBe('responses-tool');
    expect(bailian.nativeWebSearchStrategy('bailian', 'qwen3.8-max-2026-08-01')).toBe('responses-tool');
    expect(bailian.nativeWebSearchStrategy('bailian', 'deepseek-v4-pro')).toBe('responses-tool');
    expect(bailian.nativeWebSearchStrategy('bailian', 'glm-5.2')).toBe('responses-tool');
  });

  it('uses Bailian Chat search for documented legacy families and rejects unknown ids', () => {
    const bailian = factory('bailian');
    expect(bailian.nativeWebSearchStrategy('bailian', 'qwen-plus')).toBe('chat-option');
    expect(bailian.nativeWebSearchStrategy('bailian', 'qwen3-max')).toBe('chat-option');
    expect(bailian.nativeWebSearchStrategy('bailian', 'qwen3-32b')).toBe('none');
    expect(bailian.nativeWebSearchStrategy('bailian', 'qwq-plus')).toBe('none');
  });

  it('honors Bailian transport overrides and the global off switch', () => {
    expect(factory('bailian', 'responses').nativeWebSearchStrategy('bailian', 'future-model')).toBe('responses-tool');
    expect(factory('alibaba_cloud', 'chat').nativeWebSearchStrategy('alibaba_cloud', 'future-model')).toBe('chat-option');
    expect(factory('bailian', 'off').nativeWebSearchStrategy('bailian', 'qwen3.5-plus')).toBe('none');
    expect(factory('xai', 'off').nativeWebSearchStrategy('xai', 'grok-4.6')).toBe('none');
  });

  it('recognizes a rejected Bailian enable_search option without hiding unrelated failures', () => {
    expect(isNativeWebSearchCapabilityError({
      code: 'PROVIDER_ERROR',
      message: 'enable_search is not supported for this model',
    })).toBe(true);
    expect(isNativeWebSearchCapabilityError({
      code: 'PROVIDER_ERROR',
      message: 'HTTP 429: rate limited',
    })).toBe(false);
  });
});
