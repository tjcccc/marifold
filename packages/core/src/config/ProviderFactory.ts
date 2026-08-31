import {
  AnthropicProvider,
  OllamaProvider,
  ProviderAdapter,
} from '@priest-ai/core';
import { MarifoldError } from '../errors/MarifoldError';
import { MarifoldConfig, MarifoldProviderConfig } from './ConfigSchema';
import { MarifoldOpenAICompatProvider } from './MarifoldOpenAICompatProvider';

export type NativeWebSearchStrategy = 'responses-tool' | 'chat-option' | 'none';

const ALWAYS_RESPONSES_SEARCH_PROVIDERS = new Set(['openai', 'chatgpt', 'xai']);
const BAILIAN_PROVIDER_NAMES = new Set(['bailian', 'alibaba_cloud']);

export class ProviderFactory {
  constructor(
    private readonly config: MarifoldConfig,
    private readonly configPath: string,
  ) {}

  create(providerName: string): ProviderAdapter {
    const provider = this.config.providers[providerName];
    if (!provider) throw MarifoldError.providerNotConfigured(providerName, this.configPath);

    switch (provider.type) {
      case 'ollama':
        return new OllamaProvider(provider.baseUrl ?? 'http://localhost:11434');
      case 'openai-compatible':
        return new MarifoldOpenAICompatProvider(this.requireBaseUrl(providerName, provider), this.readOptionalApiKey(providerName, provider), {
          providerName,
          accountId: provider.accountId,
          proxy: provider.proxy,
        });
      case 'anthropic':
        return new AnthropicProvider(this.readRequiredApiKey(providerName, provider));
    }
  }

  /** Resolve the verified hosted-search wire contract for one provider/model.
   * OpenAI compatibility alone is not a capability signal: Bailian exposes
   * both Responses tools and a non-standard Chat Completions option, and only
   * documented model families enter auto mode. */
  nativeWebSearchStrategy(providerName: string, model: string): NativeWebSearchStrategy {
    const provider = this.config.providers[providerName];
    if (provider?.type !== 'openai-compatible') {
      return 'none';
    }
    if (provider.nativeWebSearch === 'off') {
      return 'none';
    }
    if (BAILIAN_PROVIDER_NAMES.has(providerName)) {
      if (provider.nativeWebSearch === 'responses') {
        return 'responses-tool';
      }
      if (provider.nativeWebSearch === 'chat') {
        return 'chat-option';
      }
      return bailianNativeWebSearchStrategy(model);
    }
    return ALWAYS_RESPONSES_SEARCH_PROVIDERS.has(providerName)
      ? 'responses-tool'
      : 'none';
  }

  private requireBaseUrl(providerName: string, provider: MarifoldProviderConfig): string {
    if (provider.baseUrl) return provider.baseUrl;
    throw MarifoldError.configInvalid(`Provider '${providerName}' requires base_url.`, { provider: providerName });
  }

  private readOptionalApiKey(providerName: string, provider: MarifoldProviderConfig): string | undefined {
    if (!provider.apiKeyEnv) return provider.apiKey;
    const value = process.env[provider.apiKeyEnv];
    if (value) return value;
    if (provider.apiKey) return provider.apiKey;
    throw MarifoldError.apiKeyMissing(providerName, provider.apiKeyEnv);
  }

  private readRequiredApiKey(providerName: string, provider: MarifoldProviderConfig): string {
    if (!provider.apiKeyEnv) {
      if (provider.apiKey) return provider.apiKey;
      throw MarifoldError.configInvalid(`Provider '${providerName}' requires api_key_env.`, { provider: providerName });
    }
    const value = process.env[provider.apiKeyEnv];
    if (value) return value;
    if (provider.apiKey) return provider.apiKey;
    throw MarifoldError.apiKeyMissing(providerName, provider.apiKeyEnv);
  }
}

/** Conservative auto-detection from Alibaba Cloud's documented search matrix.
 * Unknown/custom model ids retain Marifold fallback search; users can opt a
 * newly released model into a transport with providers.<name>.native_web_search. */
function bailianNativeWebSearchStrategy(model: string): NativeWebSearchStrategy {
  const normalized = model.toLowerCase();
  if (
    /^qwen3\.[5-9]-(?:max|plus|flash)(?:-|$)/.test(normalized)
    || /^deepseek-v4-(?:flash|pro)(?:-|$)/.test(normalized)
    || /^glm-5\.2(?:-|$)/.test(normalized)
  ) {
    return 'responses-tool';
  }
  if (/^qwen(?:3-max|-(?:plus|max|turbo))(?:-|$)/.test(normalized)) {
    return 'chat-option';
  }
  return 'none';
}
