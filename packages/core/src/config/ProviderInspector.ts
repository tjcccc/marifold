import { LoadedMarifoldConfig, MarifoldProviderConfig, ProviderType } from './ConfigSchema';
import { openAIModelsUrl } from './OpenAICompatUrls';
import {
  getProviderRegistryEntry,
  isKnownGitHubCopilotUnsupportedModelId,
  providerConfigFromRegistry,
} from './ProviderRegistry';
import { proxyDispatcher } from '../util/proxy';

// The ChatGPT Codex catalog requires a Codex client version and gates catalog
// entries against it. This is a catalog-protocol compatibility version, not the
// Marifold package version; update it when adopting a newer Codex catalog shape.
const CHATGPT_MODEL_CATALOG_CLIENT_VERSION = '0.149.0';

export interface ProviderSummary {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKeyEnv?: string;
  hasApiKey: boolean;
  hasOauthToken: boolean;
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
    const registry = getProviderRegistryEntry(providerName);
    const provider = this.loadedConfig.config.providers[providerName]
      ?? (registry ? providerConfigFromRegistry(registry) as MarifoldProviderConfig : undefined);
    if (!provider) {
      return {
        provider: providerName,
        reachable: null,
        models: [],
        message: `Provider '${providerName}' is not configured.`,
      };
    }
    const registryModels = registry?.knownModels ?? undefined;

    if (provider.type === 'ollama') {
      const result = await this.fetchOllamaModels(provider.baseUrl ?? 'http://localhost:11434');
      if (shouldShowRegistryModelFallback(providerName, result) && Array.isArray(registryModels) && registryModels.length > 0) {
        return {
          provider: providerName,
          reachable: result.reachable,
          models: registryModels,
          message: `${result.message} Showing registry models.`,
        };
      }
      return { provider: providerName, ...result };
    }

    if (provider.type === 'openai-compatible') {
      if (!provider.baseUrl) {
        if (Array.isArray(registryModels)) {
          return {
            provider: providerName,
            reachable: null,
            models: registryModels,
            message: `Provider '${providerName}' has no base_url. Showing registry models.`,
          };
        }
        return {
          provider: providerName,
          reachable: null,
          models: [],
          message: `Provider '${providerName}' has no base_url.`,
        };
      }
      if (provider.apiKeyEnv && !this.readApiKey(provider) && Array.isArray(registryModels) && registryModels.length > 0) {
        return {
          provider: providerName,
          reachable: null,
          models: registryModels,
          message: providerName === 'chatgpt'
            ? 'Sign in with ChatGPT for live model listing. Showing known models.'
            : `Set ${provider.apiKeyEnv} for live model listing. Showing registry models.`,
        };
      }
      const apiKey = this.readApiKey(provider);
      const result = await this.fetchOpenAICompatibleModels(providerName, provider.baseUrl, apiKey, {
        accountId: provider.accountId,
        proxy: provider.proxy,
      });
      if (shouldShowRegistryModelFallback(providerName, result) && Array.isArray(registryModels) && registryModels.length > 0) {
        return {
          provider: providerName,
          reachable: result.reachable,
          models: registryModels,
          message: `${result.message} Showing registry models.`,
        };
      }
      return { provider: providerName, ...result };
    }

    if (Array.isArray(registryModels)) {
      return {
        provider: providerName,
        reachable: null,
        models: registryModels,
        message: `Showing registry models for provider '${providerName}'.`,
      };
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

    if (provider.apiKeyEnv && !this.readApiKey(provider)) {
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

    if (provider.apiKeyEnv || provider.apiKey || provider.oauthToken) {
      const configured = Boolean(this.readApiKey(provider) || provider.oauthToken);
      return {
        ...summary,
        configured,
        reachable: null,
        models: [],
        message: configured
          ? provider.apiKeyEnv && process.env[provider.apiKeyEnv]
            ? `Configured through ${provider.apiKeyEnv}; remote health not checked.`
            : 'Configured through saved local credentials; remote health not checked.'
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

  private async fetchOpenAICompatibleModels(
    providerName: string,
    baseUrl: string,
    apiKey?: string,
    options: { accountId?: string; proxy?: string } = {},
  ): Promise<Omit<ProviderModelList, 'provider'>> {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (providerName === 'github_copilot') {
      headers['Editor-Version'] = 'marifold/0';
      headers['Editor-Plugin-Version'] = 'marifold/0';
      headers['Copilot-Integration-Id'] = 'vscode-chat';
      headers['User-Agent'] = 'marifold';
    }
    if (providerName === 'chatgpt') {
      headers.originator = 'codex_cli_rs';
      headers['User-Agent'] = 'marifold';
      if (options.accountId) headers['chatgpt-account-id'] = options.accountId;
    }
    const baseModelsUrl = openAIModelsUrl(baseUrl, { providerName });
    const url = providerName === 'chatgpt'
      ? `${baseModelsUrl}?client_version=${CHATGPT_MODEL_CATALOG_CLIENT_VERSION}`
      : baseModelsUrl;
    try {
      const init: RequestInit = {
        headers,
        signal: AbortSignal.timeout(5000),
      };
      const dispatcher = proxyDispatcher(options.proxy);
      const response = await fetch(url, dispatcher ? { ...init, dispatcher } as RequestInit : init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as OpenAICompatibleModelsResponse;
      const records = providerName === 'chatgpt'
        ? body.models ?? body.data ?? []
        : body.data ?? body.models ?? [];
      const models = [...new Set(filterOpenAICompatibleModels(providerName, records)
        .map(model => modelId(providerName, model))
        .filter((id): id is string => typeof id === 'string'))]
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
      hasApiKey: Boolean(provider.apiKey),
      hasOauthToken: Boolean(provider.oauthToken),
      isDefault: name === this.loadedConfig.config.default.provider,
    };
  }

  private readApiKey(provider: MarifoldProviderConfig): string | undefined {
    if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return process.env[provider.apiKeyEnv];
    return provider.apiKey;
  }
}

interface OpenAICompatibleModelRecord {
  id?: unknown;
  slug?: unknown;
  capabilities?: {
    type?: unknown;
  };
  model_picker_enabled?: unknown;
  supported_endpoints?: unknown;
  supported_in_api?: unknown;
  visibility?: unknown;
}

interface OpenAICompatibleModelsResponse {
  data?: OpenAICompatibleModelRecord[];
  models?: OpenAICompatibleModelRecord[];
}

function filterOpenAICompatibleModels(providerName: string, models: OpenAICompatibleModelRecord[]): OpenAICompatibleModelRecord[] {
  if (providerName === 'chatgpt') {
    return models.filter(model => {
      if (model.supported_in_api === false) return false;
      if (typeof model.visibility === 'string' && model.visibility !== 'list') return false;
      return typeof model.slug === 'string' || typeof model.id === 'string';
    });
  }
  if (providerName !== 'github_copilot') return models;

  return models.filter(model => {
    if (typeof model.id === 'string' && isKnownGitHubCopilotUnsupportedModelId(model.id)) return false;
    if (model.capabilities?.type !== 'chat') return false;
    if (model.model_picker_enabled === false) return false;
    if (!Array.isArray(model.supported_endpoints)) return true;
    return model.supported_endpoints.includes('/chat/completions')
      || model.supported_endpoints.includes('/responses');
  });
}

function modelId(providerName: string, model: OpenAICompatibleModelRecord): string | undefined {
  const value = providerName === 'chatgpt' ? model.slug ?? model.id : model.id;
  return typeof value === 'string' && value ? value : undefined;
}

function shouldShowRegistryModelFallback(
  providerName: string,
  result: Omit<ProviderModelList, 'provider'>,
): boolean {
  if (result.models.length > 0) return false;
  if ((providerName === 'github_copilot' || providerName === 'chatgpt') && result.reachable === true) return false;
  return true;
}
