import * as fs from 'fs';
import { parse } from 'smol-toml';
import { MarifoldError } from '../errors/MarifoldError';
import {
  LoadedMarifoldConfig,
  MarifoldConfig,
  MarifoldDefaultConfig,
  MarifoldMemoryConfig,
  MarifoldModelsConfig,
  MarifoldPathsConfig,
  MarifoldProviderConfig,
  ProviderType,
} from './ConfigSchema';
import {
  defaultConfigPath,
  defaultProfilesDir,
  defaultSessionsDb,
  resolveUserPath,
} from '../workspace/WorkspacePaths';

type TomlObject = Record<string, unknown>;

export interface LoadConfigOptions {
  configPath?: string;
}

export class ConfigLoader {
  load(options: LoadConfigOptions = {}): LoadedMarifoldConfig {
    const configPath = this.resolveConfigPath(options.configPath);
    const explicitPath = Boolean(options.configPath || process.env.MARIFOLD_CONFIG);

    if (!fs.existsSync(configPath)) {
      if (explicitPath) throw MarifoldError.configFileNotFound(configPath);
      return {
        config: this.normalize({}),
        configPath,
        foundConfig: false,
      };
    }

    const raw = this.readToml(configPath);
    return {
      config: this.normalize(raw),
      configPath,
      foundConfig: true,
    };
  }

  private resolveConfigPath(configPath?: string): string {
    return resolveUserPath(configPath ?? process.env.MARIFOLD_CONFIG ?? defaultConfigPath());
  }

  private readToml(configPath: string): TomlObject {
    try {
      const text = fs.readFileSync(configPath, 'utf-8');
      return asObject(parse(text), configPath);
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw MarifoldError.configInvalid(`Could not read config file ${configPath}: ${String(error)}`, {
        configPath,
      });
    }
  }

  private normalize(raw: TomlObject): MarifoldConfig {
    const defaultRaw = optionalObject(raw.default, 'default');
    const modelsRaw = optionalObject(raw.models, 'models');
    const memoryRaw = optionalObject(raw.memory, 'memory');
    const pathsRaw = optionalObject(raw.paths, 'paths');
    const providersRaw = optionalObject(raw.providers, 'providers');

    return {
      default: this.normalizeDefault(defaultRaw),
      models: this.normalizeModels(modelsRaw),
      memory: this.normalizeMemory(memoryRaw),
      paths: this.normalizePaths(pathsRaw),
      providers: this.normalizeProviders(providersRaw),
    };
  }

  private normalizeDefault(raw: TomlObject): MarifoldDefaultConfig {
    return {
      provider: optionalString(raw.provider, 'default.provider'),
      model: optionalString(raw.model, 'default.model'),
      profile: optionalString(raw.profile, 'default.profile') ?? 'default',
      timeoutSeconds: optionalNumber(raw.timeout_seconds, 'default.timeout_seconds'),
      maxOutputTokens: optionalNumber(raw.max_output_tokens, 'default.max_output_tokens'),
      maxSystemChars: optionalNumber(raw.max_system_chars, 'default.max_system_chars'),
    };
  }

  private normalizePaths(raw: TomlObject): MarifoldPathsConfig {
    return {
      profilesDir: resolveUserPath(optionalString(raw.profiles_dir, 'paths.profiles_dir') ?? defaultProfilesDir()),
      sessionsDb: resolveUserPath(optionalString(raw.sessions_db, 'paths.sessions_db') ?? defaultSessionsDb()),
    };
  }

  private normalizeModels(raw: TomlObject): MarifoldModelsConfig {
    return {
      options: optionalStringArray(raw.options, 'models.options'),
    };
  }

  private normalizeMemory(raw: TomlObject): MarifoldMemoryConfig {
    return {
      sizeLimit: optionalNonNegativeNumber(raw.size_limit, 'memory.size_limit') ?? 50000,
      contextLimit: optionalNonNegativeNumber(raw.context_limit, 'memory.context_limit') ?? 2400,
    };
  }

  private normalizeProviders(raw: TomlObject): Record<string, MarifoldProviderConfig> {
    const providers: Record<string, MarifoldProviderConfig> = {
      ollama: {
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
      },
    };

    for (const [name, value] of Object.entries(raw)) {
      const providerRaw = optionalObject(value, `providers.${name}`);
      const inferredType = name === 'ollama' ? 'ollama' : undefined;
      const type = optionalProviderType(providerRaw.type, `providers.${name}.type`) ?? inferredType;
      if (!type) {
        throw MarifoldError.configInvalid(
          `Provider '${name}' must set type = "ollama", "openai-compatible", or "anthropic".`,
          { provider: name },
        );
      }
      providers[name] = {
        type,
        baseUrl: optionalString(providerRaw.base_url, `providers.${name}.base_url`),
        apiKeyEnv: optionalString(providerRaw.api_key_env, `providers.${name}.api_key_env`),
      };
    }

    return providers;
  }
}

function asObject(value: unknown, label: string): TomlObject {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as TomlObject;
  }
  throw MarifoldError.configInvalid(`Expected ${label} to contain a TOML object.`);
}

function optionalObject(value: unknown, label: string): TomlObject {
  if (value === undefined) return {};
  return asObject(value, label);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw MarifoldError.configInvalid(`Expected ${label} to be a string.`);
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw MarifoldError.configInvalid(`Expected ${label} to be a number.`);
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  const number = optionalNumber(value, label);
  if (number === undefined) return undefined;
  if (number >= 0) return number;
  throw MarifoldError.configInvalid(`Expected ${label} to be a non-negative number.`);
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return [...value];
  throw MarifoldError.configInvalid(`Expected ${label} to be an array of strings.`);
}

function optionalProviderType(value: unknown, label: string): ProviderType | undefined {
  const type = optionalString(value, label);
  if (type === undefined) return undefined;
  if (type === 'ollama' || type === 'openai-compatible' || type === 'anthropic') return type;
  throw MarifoldError.configInvalid(`Expected ${label} to be "ollama", "openai-compatible", or "anthropic".`);
}
