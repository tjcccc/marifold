import {
  AnthropicProvider,
  OllamaProvider,
  ProviderAdapter,
} from '@priest-ai/core';
import { MarifoldError } from '../errors/MarifoldError';
import { MarifoldConfig, MarifoldProviderConfig } from './ConfigSchema';
import { MarifoldOpenAICompatProvider } from './MarifoldOpenAICompatProvider';

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
        });
      case 'anthropic':
        return new AnthropicProvider(this.readRequiredApiKey(providerName, provider));
    }
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
