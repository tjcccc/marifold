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
        ...summary,
        configured: true,
        reachable: true,
        modelCount: models.length,
        models,
        message: `${models.length} model(s) available.`,
      };
    } catch (error) {
      return {
        ...summary,
        configured: true,
        reachable: false,
        models: [],
        message: `Could not connect to ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
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
