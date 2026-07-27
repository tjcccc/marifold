import * as fs from 'fs';
import { parse } from 'smol-toml';
import { AgentApprovalConfig, ApprovalMode, AgentToolMode, PartialAgentConfig, resolveAgentConfig } from '../agent/ApprovalPolicy';
import { MarifoldError } from '../errors/MarifoldError';
import {
  LoadedMarifoldConfig,
  MarifoldConfig,
  MarifoldDefaultConfig,
  MarifoldMemoryConfig,
  MarifoldModelsConfig,
  MarifoldChannelsConfig,
  MarifoldPathsConfig,
  MarifoldProviderConfig,
  MarifoldServiceConfig,
  MarifoldWebSearchConfig,
  ProfileMode,
  TelegramChannelConfig,
  ProviderType,
  resolveWebSearchConfig,
  WebSearchProvider,
} from './ConfigSchema';
import {
  defaultConfigPath,
  defaultAppsDir,
  defaultProfilesDir,
  defaultSchedulesDir,
  defaultSessionsDb,
  defaultSkillsDir,
  defaultTasksDir,
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
      return { config: this.normalize({}), configPath, foundConfig: false };
    }

    const raw = this.readToml(configPath);
    return { config: this.normalize(raw), configPath, foundConfig: true };
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
      ...(raw.agent !== undefined ? { agent: resolveAgentConfig(parsePartialAgentConfig(raw.agent, 'agent')) } : {}),
      ...(raw.web_search !== undefined ? { webSearch: this.normalizeWebSearch(asObject(raw.web_search, 'web_search')) } : {}),
      ...(raw.channel !== undefined ? { channels: this.normalizeChannels(asObject(raw.channel, 'channel')) } : {}),
      ...(raw.service !== undefined ? { service: this.normalizeService(asObject(raw.service, 'service')) } : {}),
    };
  }

  private normalizeService(raw: TomlObject): MarifoldServiceConfig {
    const webDir = optionalString(raw.web_dir, 'service.web_dir');
    return {
      tokenEnv: optionalString(raw.token_env, 'service.token_env'),
      token: optionalString(raw.token, 'service.token'),
      corsOrigins: optionalStringArray(raw.cors_origins, 'service.cors_origins'),
      ...(webDir !== undefined ? { webDir: resolveUserPath(webDir) } : {}),
    };
  }

  private normalizeChannels(raw: TomlObject): MarifoldChannelsConfig {
    const telegram = raw.telegram !== undefined
      ? this.normalizeTelegramChannel(asObject(raw.telegram, 'channel.telegram'))
      : undefined;
    return { ...(telegram ? { telegram } : {}) };
  }

  private normalizeTelegramChannel(raw: TomlObject): TelegramChannelConfig {
    const mode = optionalString(raw.default_mode, 'channel.telegram.default_mode');
    if (mode !== undefined && mode !== 'agent' && mode !== 'chat') {
      throw MarifoldError.configInvalid('channel.telegram.default_mode must be "agent" or "chat".');
    }
    const allowlist = optionalNumberArray(raw.allowlist, 'channel.telegram.allowlist');
    return {
      enabled: optionalBoolean(raw.enabled, 'channel.telegram.enabled'),
      botTokenEnv: optionalString(raw.bot_token_env, 'channel.telegram.bot_token_env'),
      botToken: optionalString(raw.bot_token, 'channel.telegram.bot_token'),
      allowlist,
      profile: optionalString(raw.profile, 'channel.telegram.profile') ?? 'default',
      defaultMode: (mode as ProfileMode | undefined) ?? 'agent',
    };
  }

  private normalizeWebSearch(raw: TomlObject): MarifoldWebSearchConfig {
    return resolveWebSearchConfig({
      enabled: optionalBoolean(raw.enabled, 'web_search.enabled'),
      maxResults: optionalPositiveInteger(raw.max_results, 'web_search.max_results'),
      provider: optionalWebSearchProvider(raw.provider, 'web_search.provider'),
      apiKeyEnv: optionalString(raw.api_key_env, 'web_search.api_key_env'),
      apiKey: optionalString(raw.api_key, 'web_search.api_key'),
      scrape: optionalBoolean(raw.scrape, 'web_search.scrape'),
      proxy: optionalString(raw.proxy, 'web_search.proxy'),
    });
  }

  private normalizeDefault(raw: TomlObject): MarifoldDefaultConfig {
    return {
      provider: optionalString(raw.provider, 'default.provider'),
      model: optionalString(raw.model, 'default.model'),
      profile: optionalString(raw.profile, 'default.profile') ?? 'default',
      timeoutSeconds: optionalNumber(raw.timeout_seconds, 'default.timeout_seconds'),
      maxOutputTokens: optionalNumber(raw.max_output_tokens, 'default.max_output_tokens'),
      maxSystemChars: optionalNumber(raw.max_system_chars, 'default.max_system_chars'),
      maxContextTokens: optionalNumber(raw.max_context_tokens, 'default.max_context_tokens'),
      compactionKeepTurns: optionalNumber(raw.compaction_keep_turns, 'default.compaction_keep_turns'),
      sessionContextTurns: optionalTurnWindow(raw.session_context_turns, 'default.session_context_turns'),
      think: optionalBoolean(raw.think, 'default.think') ?? false,
    };
  }

  private normalizePaths(raw: TomlObject): MarifoldPathsConfig {
    return {
      profilesDir: resolveUserPath(optionalString(raw.profiles_dir, 'paths.profiles_dir') ?? defaultProfilesDir()),
      sessionsDb: resolveUserPath(optionalString(raw.sessions_db, 'paths.sessions_db') ?? defaultSessionsDb()),
      tasksDir: resolveUserPath(optionalString(raw.tasks_dir, 'paths.tasks_dir') ?? defaultTasksDir()),
      schedulesDir: resolveUserPath(optionalString(raw.schedules_dir, 'paths.schedules_dir') ?? defaultSchedulesDir()),
      skillsDir: resolveUserPath(optionalString(raw.skills_dir, 'paths.skills_dir') ?? defaultSkillsDir()),
      appsDir: resolveUserPath(optionalString(raw.apps_dir, 'paths.apps_dir') ?? defaultAppsDir()),
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
      const baseUrl = optionalString(providerRaw.base_url, `providers.${name}.base_url`);
      const apiKeyEnv = optionalString(providerRaw.api_key_env, `providers.${name}.api_key_env`);
      const apiKey = optionalString(providerRaw.api_key, `providers.${name}.api_key`);
      const oauthToken = optionalString(providerRaw.oauth_token, `providers.${name}.oauth_token`);
      const apiKeyExpiresAt = optionalNumber(providerRaw.api_key_expires_at, `providers.${name}.api_key_expires_at`);
      const accountId = optionalString(providerRaw.account_id, `providers.${name}.account_id`);
      const proxy = optionalString(providerRaw.proxy, `providers.${name}.proxy`);
      providers[name] = {
        type,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(oauthToken !== undefined ? { oauthToken } : {}),
        ...(apiKeyExpiresAt !== undefined ? { apiKeyExpiresAt } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
        ...(proxy !== undefined ? { proxy } : {}),
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

/** `"all"` (or unset) → undefined (no cap); a non-negative integer → that turn count. */
function optionalTurnWindow(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'all') return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw MarifoldError.configInvalid(`Expected ${label} to be a non-negative integer or "all".`);
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return [...value];
  throw MarifoldError.configInvalid(`Expected ${label} to be an array of strings.`);
}

function optionalNumberArray(value: unknown, label: string): number[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item))) return [...value];
  throw MarifoldError.configInvalid(`Expected ${label} to be an array of numbers.`);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw MarifoldError.configInvalid(`Expected ${label} to be a boolean.`);
}

function optionalApprovalMode(value: unknown, label: string): ApprovalMode | undefined {
  const mode = optionalString(value, label);
  if (mode === undefined) return undefined;
  if (mode === 'allow' || mode === 'ask' || mode === 'deny') return mode;
  throw MarifoldError.configInvalid(`Expected ${label} to be "allow", "ask", or "deny".`);
}

function optionalToolMode(value: unknown, label: string): AgentToolMode | undefined {
  const mode = optionalString(value, label);
  if (mode === undefined) return undefined;
  if (mode === 'auto' || mode === 'native' || mode === 'control-block') return mode;
  throw MarifoldError.configInvalid(`Expected ${label} to be "auto", "native", or "control-block".`);
}

function normalizeApprovalModes(raw: TomlObject, label: string): Partial<AgentApprovalConfig> {
  const modes: Partial<AgentApprovalConfig> = {};
  for (const kind of ['read', 'write', 'shell', 'network', 'delegate'] as const) {
    const mode = optionalApprovalMode(raw[kind], `${label}.${kind}`);
    if (mode !== undefined) modes[kind] = mode;
  }
  return modes;
}

/**
 * Parse a TOML `[agent]` table into a {@link PartialAgentConfig} — only the keys
 * actually present, with NO defaults applied — so it can be merged over the
 * global config. Shared by ConfigLoader (global `[agent]`) and ProfileResolver
 * (per-profile `[agent]` in profile.toml) so validation is identical.
 */
export function parsePartialAgentConfig(raw: unknown, label: string): PartialAgentConfig {
  const obj = asObject(raw, label);
  const trustedFolders = obj.trusted_folders !== undefined
    ? optionalStringArray(obj.trusted_folders, `${label}.trusted_folders`)
    : undefined;
  return {
    approval: normalizeApprovalModes(optionalObject(obj.approval, `${label}.approval`), `${label}.approval`),
    unattended: normalizeApprovalModes(optionalObject(obj.unattended, `${label}.unattended`), `${label}.unattended`),
    ...(trustedFolders ? { trustedFolders } : {}),
    maxIterations: optionalPositiveInteger(obj.max_iterations, `${label}.max_iterations`),
    toolOutputLimit: optionalNonNegativeNumber(obj.tool_output_limit, `${label}.tool_output_limit`),
    toolMode: optionalToolMode(obj.tool_mode, `${label}.tool_mode`),
  };
}

function optionalWebSearchProvider(value: unknown, label: string): WebSearchProvider | undefined {
  const provider = optionalString(value, label);
  if (provider === undefined) return undefined;
  if (provider === 'duckduckgo' || provider === 'firecrawl') return provider;
  throw MarifoldError.configInvalid(`Expected ${label} to be "duckduckgo" or "firecrawl".`);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  const number = optionalNumber(value, label);
  if (number === undefined) return undefined;
  if (Number.isInteger(number) && number >= 1) return number;
  throw MarifoldError.configInvalid(`Expected ${label} to be a positive integer.`);
}

function optionalProviderType(value: unknown, label: string): ProviderType | undefined {
  const type = optionalString(value, label);
  if (type === undefined) return undefined;
  if (type === 'ollama' || type === 'openai-compatible' || type === 'anthropic') return type;
  throw MarifoldError.configInvalid(`Expected ${label} to be "ollama", "openai-compatible", or "anthropic".`);
}
