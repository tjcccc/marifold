import { LoadedMarifoldConfig, MarifoldProviderConfig, ProviderType } from './ConfigSchema';

export interface ProviderSummary {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKeyEnv?: string;
  isDefault: boolean;
}

export interface ProviderStatus extends ProviderSummary {
  configured: boolean;
  reachable: boolean | null;
  modelCount?: number;
  models: string[];
  message: string;
}

export interface ProviderModelList {
  provider: string;
  reachable: boolean | null;
  models: string[];
  message: string;
}

export interface ModelValidation {
  provider: string;
  model: string;
  valid: boolean;
  status: 'ok' | 'warning' | 'error';
  message: string;
}

export class ProviderInspector {
  constructor(private readonly loadedConfig: LoadedMarifoldConfig) {}

  current(): ProviderSummary | undefined {
    const provider = this.loadedConfig.config.default.provider;
    if (!provider) return undefined;
    const config = this.loadedConfig.config.providers[provider];
    if (!config) return undefined;
    return this.toSummary(provider, config);
  }

  list(): ProviderSummary[] {
    return Object.entries(this.loadedConfig.config.providers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, provider]) => this.toSummary(name, provider));
  }

  async status(): Promise<ProviderStatus[]> {
    const statuses: ProviderStatus[] = [];
    for (const [name, provider] of Object.entries(this.loadedConfig.config.providers).sort(([a], [b]) => a.localeCompare(b))) {
      statuses.push(await this.providerStatus(name, provider));
    }
    return statuses;
  }

  async listModels(providerName: string): Promise<ProviderModelList> {
    const provider = this.loadedConfig.config.providers[providerName];
    if (!provider) {
      return {
        provider: providerName,
        reachable: null,
        models: [],
        message: `Provider '${providerName}' is not configured.`,
      };
    }

    if (provider.type === 'ollama') {
      const result = await this.fetchOllamaModels(provider.baseUrl ?? 'http://localhost:11434');
      return { provider: providerName, ...result };
    }

    if (provider.type === 'openai-compatible') {
      if (!provider.baseUrl) {
        return {
          provider: providerName,
          reachable: null,
          models: [],
          message: `Provider '${providerName}' has no base_url.`,
        };
      }
      const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
      const result = await this.fetchOpenAICompatibleModels(provider.baseUrl, apiKey);
      return { provider: providerName, ...result };
    }

    return {
      provider: providerName,
      reachable: null,
      models: [],
      message: `Provider '${providerName}' does not expose model listing in Marifold yet.`,
    };
  }

  async validateModel(providerName: string, modelName: string): Promise<ModelValidation> {
    const provider = this.loadedConfig.config.providers[providerName];
    if (!provider) {
      return {
        provider: providerName,
        model: modelName,
        valid: false,
        status: 'error',
        message: `Provider '${providerName}' is not configured.`,
      };
    }
    if (!modelName.trim()) {
      return {
        provider: providerName,
        model: modelName,
        valid: false,
        status: 'error',
        message: 'Model name cannot be empty.',
      };
    }

    if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
      return {
        provider: providerName,
        model: modelName,
        valid: false,
        status: 'error',
        message: `Missing environment variable ${provider.apiKeyEnv}.`,
      };
    }

    if (provider.type === 'ollama' || provider.type === 'openai-compatible') {
      const result = await this.listModels(providerName);
      if (result.reachable === false || result.reachable === null) {
        return {
          provider: providerName,
          model: modelName,
          valid: false,
          status: 'error',
          message: result.message,
        };
      }
      if (result.models.includes(modelName)) {
        return {
          provider: providerName,
          model: modelName,
          valid: true,
          status: 'ok',
          message: 'Model is available.',
        };
      }
      return {
        provider: providerName,
        model: modelName,
        valid: false,
        status: 'error',
        message: `Model '${modelName}' was not found for provider '${providerName}'.`,
      };
    }

    return {
      provider: providerName,
      model: modelName,
      valid: true,
      status: 'warning',
      message: `Live model validation is not available for provider type '${provider.type}'.`,
    };
  }

  private async providerStatus(name: string, provider: MarifoldProviderConfig): Promise<ProviderStatus> {
    const summary = this.toSummary(name, provider);

    if (provider.type === 'ollama') {
      return this.ollamaStatus(summary);
    }

    if (provider.apiKeyEnv) {
      const configured = Boolean(process.env[provider.apiKeyEnv]);
      return {
        ...summary,
        configured,
        reachable: null,
        models: [],
        message: configured
          ? `Configured through ${provider.apiKeyEnv}; remote health not checked.`
          : `Missing environment variable ${provider.apiKeyEnv}.`,
      };
    }

    return {
      ...summary,
      configured: provider.type === 'openai-compatible' && Boolean(provider.baseUrl),
      reachable: null,
      models: [],
      message: provider.type === 'openai-compatible'
        ? 'No api_key_env set; requests will be sent without an API key.'
        : 'Provider has no api_key_env configured.',
    };
  }

  private async ollamaStatus(summary: ProviderSummary): Promise<ProviderStatus> {
    const baseUrl = summary.baseUrl ?? 'http://localhost:11434';
    const result = await this.fetchOllamaModels(baseUrl);
    return {
      ...summary,
      configured: true,
      reachable: result.reachable,
      modelCount: result.models.length,
      models: result.models,
      message: result.message,
    };
  }

  private async fetchOllamaModels(baseUrl: string): Promise<Omit<ProviderModelList, 'provider'>> {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { models?: Array<{ name?: unknown }> };
      const models = (body.models ?? [])
        .map(model => model.name)
        .filter((name): name is string => typeof name === 'string')
        .sort();
      return {
        reachable: true,
        models,
        message: `${models.length} model(s) available.`,
      };
    } catch (error) {
      return {
        reachable: false,
        models: [],
        message: `Could not connect to ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async fetchOpenAICompatibleModels(baseUrl: string, apiKey?: string): Promise<Omit<ProviderModelList, 'provider'>> {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const url = openAIModelsUrl(baseUrl);
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { data?: Array<{ id?: unknown }> };
      const models = (body.data ?? [])
        .map(model => model.id)
        .filter((id): id is string => typeof id === 'string')
        .sort();
      return {
        reachable: true,
        models,
        message: `${models.length} model(s) available.`,
      };
    } catch (error) {
      return {
        reachable: false,
        models: [],
        message: `Could not connect to ${url}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private toSummary(name: string, provider: MarifoldProviderConfig): ProviderSummary {
    return {
      name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      isDefault: name === this.loadedConfig.config.default.provider,
    };
  }
}

function openAIModelsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? `${normalized}/models` : `${normalized}/v1/models`;
}
