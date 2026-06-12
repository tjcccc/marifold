import * as fs from 'fs';
import * as path from 'path';
import { LoadedMarifoldConfig, MarifoldConfig, MarifoldProviderConfig, ProviderType } from './ConfigSchema';
import { MarifoldError } from '../errors/MarifoldError';
import { resolveUserPath } from '../workspace/WorkspacePaths';
import { getProviderRegistryEntry, providerConfigFromRegistry } from './ProviderRegistry';

export interface ConfigSetResult {
  configPath: string;
  key: string;
  value: string;
}

export interface ConfigRemoveModelResult extends ConfigSetResult {
  removed: boolean;
  wasDefault: boolean;
}

export class ConfigManager {
  constructor(private readonly loadedConfig: LoadedMarifoldConfig) {}

  get config(): MarifoldConfig {
    return this.loadedConfig.config;
  }

  get configPath(): string {
    return this.loadedConfig.configPath;
  }

  save(): string {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, renderMarifoldConfig(this.config));
    return this.configPath;
  }

  setValue(key: string, value: string): ConfigSetResult {
    const parts = key.split('.');
    if (parts.length < 2) throw MarifoldError.configInvalid(`Unknown config key: ${key}`);

    if (parts[0] === 'default' && parts.length === 2) {
      this.setDefaultValue(parts[1], value);
    } else if (parts[0] === 'paths' && parts.length === 2) {
      this.setPathValue(parts[1], value);
    } else if (parts[0] === 'memory' && parts.length === 2) {
      this.setMemoryValue(parts[1], value);
    } else if (parts[0] === 'providers' && parts.length === 3) {
      this.setProviderValue(parts[1], parts[2], value);
    } else {
      throw MarifoldError.configInvalid(`Unknown config key: ${key}`);
    }

    this.save();
    return { configPath: this.configPath, key, value };
  }

  setDefaultModel(model: string, provider?: string): ConfigSetResult {
    if (!model) throw MarifoldError.configInvalid('Model cannot be empty.');
    if (provider) this.config.default.provider = provider;
    this.config.default.model = model;
    this.registerModelOption(this.config.default.provider, model);
    this.save();
    return {
      configPath: this.configPath,
      key: provider ? 'default.provider/default.model' : 'default.model',
      value: provider ? `${provider}/${model}` : model,
    };
  }

  addModel(provider: string, model: string, options: Partial<MarifoldProviderConfig> = {}): ConfigSetResult {
    if (!provider) throw MarifoldError.configInvalid('Provider cannot be empty.');
    if (!model) throw MarifoldError.configInvalid('Model cannot be empty.');

    const providerConfig = this.config.providers[provider] ?? this.createProvider(provider);
    const registry = getProviderRegistryEntry(provider);
    if (registry) {
      const defaults = providerConfigFromRegistry(registry);
      if (defaults.type) providerConfig.type = defaults.type;
      if (defaults.baseUrl && !providerConfig.baseUrl) providerConfig.baseUrl = defaults.baseUrl;
      if (defaults.apiKeyEnv && !providerConfig.apiKeyEnv) providerConfig.apiKeyEnv = defaults.apiKeyEnv;
    }
    if (options.type) providerConfig.type = options.type;
    if (options.baseUrl) providerConfig.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (options.apiKeyEnv) providerConfig.apiKeyEnv = options.apiKeyEnv;
    if (options.apiKey) providerConfig.apiKey = options.apiKey;
    if (options.oauthToken) providerConfig.oauthToken = options.oauthToken;
    if (options.apiKeyExpiresAt !== undefined) providerConfig.apiKeyExpiresAt = options.apiKeyExpiresAt;
    this.registerModelOption(provider, model);
    this.save();
    return { configPath: this.configPath, key: 'models.options', value: `${provider}/${model}` };
  }

  removeModel(provider: string, model: string): ConfigRemoveModelResult {
    if (!provider) throw MarifoldError.configInvalid('Provider cannot be empty.');
    if (!model) throw MarifoldError.configInvalid('Model cannot be empty.');

    const option = `${provider}/${model}`;
    const index = this.config.models.options.indexOf(option);
    const wasDefault = this.config.default.provider === provider && this.config.default.model === model;
    if (index === -1) {
      return {
        configPath: this.configPath,
        key: 'models.options',
        value: option,
        removed: false,
        wasDefault,
      };
    }

    this.config.models.options.splice(index, 1);
    this.save();
    return {
      configPath: this.configPath,
      key: 'models.options',
      value: option,
      removed: true,
      wasDefault,
    };
  }

  registerModelOption(provider: string | undefined, model: string | undefined): void {
    if (!provider || !model) return;
    const option = `${provider}/${model}`;
    if (!this.config.models.options.includes(option)) {
      this.config.models.options.push(option);
      this.config.models.options.sort();
    }
  }

  setDefaultProfile(profile: string): ConfigSetResult {
    if (!profile) throw MarifoldError.configInvalid('Profile cannot be empty.');
    this.config.default.profile = profile;
    this.save();
    return { configPath: this.configPath, key: 'default.profile', value: profile };
  }

  private setDefaultValue(key: string, value: string): void {
    switch (key) {
      case 'provider':
        this.config.default.provider = value;
        return;
      case 'model':
        this.config.default.model = value;
        return;
      case 'profile':
        this.config.default.profile = value;
        return;
      case 'timeout_seconds':
        this.config.default.timeoutSeconds = parseNumber(value, 'default.timeout_seconds');
        return;
      case 'max_output_tokens':
        this.config.default.maxOutputTokens = parseNumber(value, 'default.max_output_tokens');
        return;
      case 'max_system_chars':
        this.config.default.maxSystemChars = parseNumber(value, 'default.max_system_chars');
        return;
      case 'think':
        this.config.default.think = parseBoolean(value, 'default.think');
        return;
      default:
        throw MarifoldError.configInvalid(`Unknown config key: default.${key}`);
    }
  }

  private setPathValue(key: string, value: string): void {
    switch (key) {
      case 'profiles_dir':
        this.config.paths.profilesDir = resolveUserPath(value);
        return;
      case 'sessions_db':
        this.config.paths.sessionsDb = resolveUserPath(value);
        return;
      case 'tasks_dir':
        this.config.paths.tasksDir = resolveUserPath(value);
        return;
      case 'schedules_dir':
        this.config.paths.schedulesDir = resolveUserPath(value);
        return;
      default:
        throw MarifoldError.configInvalid(`Unknown config key: paths.${key}`);
    }
  }

  private setMemoryValue(key: string, value: string): void {
    switch (key) {
      case 'size_limit':
        this.config.memory.sizeLimit = parseNonNegativeNumber(value, 'memory.size_limit');
        return;
      case 'context_limit':
        this.config.memory.contextLimit = parseNonNegativeNumber(value, 'memory.context_limit');
        return;
      default:
        throw MarifoldError.configInvalid(`Unknown config key: memory.${key}`);
    }
  }

  private setProviderValue(providerName: string, key: string, value: string): void {
    const provider = this.config.providers[providerName] ?? this.createProvider(providerName);
    switch (key) {
      case 'type':
        provider.type = parseProviderType(value);
        return;
      case 'base_url':
        provider.baseUrl = value.replace(/\/+$/, '');
        return;
      case 'api_key_env':
        provider.apiKeyEnv = value;
        return;
      case 'api_key':
        provider.apiKey = value;
        return;
      case 'oauth_token':
        provider.oauthToken = value;
        return;
      case 'api_key_expires_at':
        provider.apiKeyExpiresAt = parseNumber(value, `providers.${providerName}.api_key_expires_at`);
        return;
      default:
        throw MarifoldError.configInvalid(`Unknown config key: providers.${providerName}.${key}`);
    }
  }

  private createProvider(providerName: string): MarifoldProviderConfig {
    const registry = getProviderRegistryEntry(providerName);
    const provider: MarifoldProviderConfig = registry
      ? { type: registry.type, ...providerConfigFromRegistry(registry) }
      : { type: providerName === 'ollama' ? 'ollama' : 'openai-compatible' };
    this.config.providers[providerName] = provider;
    return provider;
  }
}

export function renderMarifoldConfig(config: MarifoldConfig): string {
  const defaultLines = [
    '[default]',
    optionalStringLine('provider', config.default.provider),
    optionalStringLine('model', config.default.model),
    `profile = ${tomlString(config.default.profile)}`,
    optionalNumberLine('timeout_seconds', config.default.timeoutSeconds),
    optionalNumberLine('max_output_tokens', config.default.maxOutputTokens),
    optionalNumberLine('max_system_chars', config.default.maxSystemChars),
    `think = ${config.default.think}`,
  ].filter(Boolean);

  const pathLines = [
    '[paths]',
    `profiles_dir = ${tomlString(config.paths.profilesDir)}`,
    `sessions_db = ${tomlString(config.paths.sessionsDb)}`,
    `tasks_dir = ${tomlString(config.paths.tasksDir)}`,
    ...(config.paths.schedulesDir ? [`schedules_dir = ${tomlString(config.paths.schedulesDir)}`] : []),
  ];

  const modelLines = [
    '[models]',
    `options = ${tomlStringArray(config.models.options)}`,
  ];

  const memoryLines = [
    '[memory]',
    `size_limit = ${config.memory.sizeLimit}`,
    `context_limit = ${config.memory.contextLimit}`,
  ];

  const agentSection = config.agent === undefined ? undefined : [
    '[agent]',
    `max_iterations = ${config.agent.maxIterations}`,
    `tool_output_limit = ${config.agent.toolOutputLimit}`,
    `tool_mode = ${tomlString(config.agent.toolMode)}`,
    '',
    '[agent.approval]',
    `read = ${tomlString(config.agent.approval.read)}`,
    `write = ${tomlString(config.agent.approval.write)}`,
    `shell = ${tomlString(config.agent.approval.shell)}`,
    `network = ${tomlString(config.agent.approval.network)}`,
    `delegate = ${tomlString(config.agent.approval.delegate)}`,
    ...(config.agent.unattended ? [
      '',
      '[agent.unattended]',
      ...Object.entries(config.agent.unattended).map(([kind, mode]) => `${kind} = ${tomlString(mode)}`),
    ] : []),
  ].join('\n');

  const webSearchSection = config.webSearch === undefined ? undefined : [
    '[web_search]',
    `enabled = ${config.webSearch.enabled}`,
    `max_results = ${config.webSearch.maxResults}`,
    ...(config.webSearch.proxy ? [`proxy = ${tomlString(config.webSearch.proxy)}`] : []),
  ].join('\n');

  const providerTables = Object.entries(config.providers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, provider]) => renderProvider(name, provider));

  const sections = [
    defaultLines.join('\n'),
    modelLines.join('\n'),
    memoryLines.join('\n'),
    ...(agentSection ? [agentSection] : []),
    ...(webSearchSection ? [webSearchSection] : []),
    pathLines.join('\n'),
    ...providerTables,
  ];
  return `${sections.join('\n\n')}\n`;
}

function renderProvider(name: string, provider: MarifoldProviderConfig): string {
  const lines = [
    `[providers.${name}]`,
    `type = ${tomlString(provider.type)}`,
    optionalStringLine('base_url', provider.baseUrl),
    optionalStringLine('api_key_env', provider.apiKeyEnv),
    optionalStringLine('api_key', provider.apiKey),
    optionalStringLine('oauth_token', provider.oauthToken),
    optionalNumberLine('api_key_expires_at', provider.apiKeyExpiresAt),
  ].filter(Boolean);
  return lines.join('\n');
}

function optionalStringLine(key: string, value?: string): string | undefined {
  return value === undefined ? undefined : `${key} = ${tomlString(value)}`;
}

function optionalNumberLine(key: string, value?: number): string | undefined {
  return value === undefined ? undefined : `${key} = ${value}`;
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw MarifoldError.configInvalid(`Expected ${label} to be a number.`);
  return parsed;
}

function parseNonNegativeNumber(value: string, label: string): number {
  const parsed = parseNumber(value, label);
  if (parsed < 0) throw MarifoldError.configInvalid(`Expected ${label} to be a non-negative number.`);
  return parsed;
}

function parseProviderType(value: string): ProviderType {
  if (value === 'ollama' || value === 'openai-compatible' || value === 'anthropic') return value;
  throw MarifoldError.configInvalid(`Expected provider type to be "ollama", "openai-compatible", or "anthropic".`);
}

function parseBoolean(value: string, label: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'on' || normalized === '1') return true;
  if (normalized === 'false' || normalized === 'off' || normalized === '0') return false;
  throw MarifoldError.configInvalid(`Expected ${label} to be true or false.`);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  if (values.length === 0) return '[]';
  return `[\n${values.map(value => `  ${tomlString(value)},`).join('\n')}\n]`;
}
