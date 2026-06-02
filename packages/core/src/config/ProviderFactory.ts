import {
  AnthropicProvider,
  OllamaProvider,
  OpenAICompatProvider,
  ProviderAdapter,
} from '@priest-ai/core';
import { MarifoldError } from '../errors/MarifoldError';
import { MarifoldConfig, MarifoldProviderConfig } from './ConfigSchema';

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
        return new OpenAICompatProvider(this.requireBaseUrl(providerName, provider), this.readOptionalApiKey(providerName, provider));
      case 'anthropic':
        return new AnthropicProvider(this.readRequiredApiKey(providerName, provider));
    }
  }

  private requireBaseUrl(providerName: string, provider: MarifoldProviderConfig): string {
    if (provider.baseUrl) return provider.baseUrl;
    throw MarifoldError.configInvalid(`Provider '${providerName}' requires base_url.`, { provider: providerName });
  }

  private readOptionalApiKey(providerName: string, provider: MarifoldProviderConfig): string | undefined {
    if (!provider.apiKeyEnv) return undefined;
    const value = process.env[provider.apiKeyEnv];
    if (!value) throw MarifoldError.apiKeyMissing(providerName, provider.apiKeyEnv);
    return value;
  }

  private readRequiredApiKey(providerName: string, provider: MarifoldProviderConfig): string {
    if (!provider.apiKeyEnv) {
      throw MarifoldError.configInvalid(`Provider '${providerName}' requires api_key_env.`, { provider: providerName });
    }
    const value = process.env[provider.apiKeyEnv];
    if (!value) throw MarifoldError.apiKeyMissing(providerName, provider.apiKeyEnv);
    return value;
  }
}
