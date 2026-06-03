import * as fs from 'fs';
import * as path from 'path';
import { LoadedMarifoldConfig, MarifoldConfig, MarifoldProviderConfig, ProviderType } from './ConfigSchema';
import { MarifoldError } from '../errors/MarifoldError';
import { resolveUserPath } from '../workspace/WorkspacePaths';

export interface ConfigSetResult {
  configPath: string;
  key: string;
  value: string;
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
    if (options.type) providerConfig.type = options.type;
    if (options.baseUrl) providerConfig.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (options.apiKeyEnv) providerConfig.apiKeyEnv = options.apiKeyEnv;
    this.registerModelOption(provider, model);
    this.save();
    return { configPath: this.configPath, key: 'models.options', value: `${provider}/${model}` };
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
      default:
        throw MarifoldError.configInvalid(`Unknown config key: paths.${key}`);
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
      default:
        throw MarifoldError.configInvalid(`Unknown config key: providers.${providerName}.${key}`);
    }
  }

  private createProvider(providerName: string): MarifoldProviderConfig {
    const provider: MarifoldProviderConfig = {
      type: providerName === 'ollama' ? 'ollama' : 'openai-compatible',
    };
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
  ].filter(Boolean);

  const pathLines = [
    '[paths]',
    `profiles_dir = ${tomlString(config.paths.profilesDir)}`,
    `sessions_db = ${tomlString(config.paths.sessionsDb)}`,
  ];

  const modelLines = [
    '[models]',
    `options = ${tomlStringArray(config.models.options)}`,
  ];

  const providerTables = Object.entries(config.providers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, provider]) => renderProvider(name, provider));

  return `${defaultLines.join('\n')}\n\n${modelLines.join('\n')}\n\n${pathLines.join('\n')}\n\n${providerTables.join('\n\n')}\n`;
}

function renderProvider(name: string, provider: MarifoldProviderConfig): string {
  const lines = [
    `[providers.${name}]`,
    `type = ${tomlString(provider.type)}`,
    optionalStringLine('base_url', provider.baseUrl),
    optionalStringLine('api_key_env', provider.apiKeyEnv),
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

function parseProviderType(value: string): ProviderType {
  if (value === 'ollama' || value === 'openai-compatible' || value === 'anthropic') return value;
  throw MarifoldError.configInvalid(`Expected provider type to be "ollama", "openai-compatible", or "anthropic".`);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  if (values.length === 0) return '[]';
  return `[\n${values.map(value => `  ${tomlString(value)},`).join('\n')}\n]`;
}
