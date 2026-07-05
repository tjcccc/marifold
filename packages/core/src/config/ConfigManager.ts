import * as fs from 'fs';
import * as path from 'path';
import {
  LoadedMarifoldConfig,
  MarifoldConfig,
  MarifoldProviderConfig,
  MarifoldWebSearchConfig,
  ProviderType,
  resolveWebSearchConfig,
} from './ConfigSchema';
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
    } else if (parts[0] === 'service' && parts.length === 2) {
      this.setServiceValue(parts[1], value);
    } else if (parts[0] === 'providers' && parts.length === 3) {
      this.setProviderValue(parts[1], parts[2], value);
    } else {
      throw MarifoldError.configInvalid(`Unknown config key: ${key}`);
    }

    this.save();
    return { configPath: this.configPath, key, value };
  }

  /**
   * Read a config value by the same dotted keys `setValue` accepts.
   * Returns undefined for known-but-unset keys; throws on unknown keys.
   * Arrays render comma-separated. Secrets return as stored — this is the
   * CLI's `config get`; the HTTP view stays sanitized.
   */
  getValue(key: string): string | undefined {
    const parts = key.split('.');
    if (parts.length < 2) throw MarifoldError.configInvalid(`Unknown config key: ${key}`);
    const raw = this.readValue(parts, key);
    if (raw === undefined) return undefined;
    return Array.isArray(raw) ? raw.join(', ') : String(raw);
  }

  private readValue(parts: string[], key: string): unknown {
    const pick = (section: string, map: Record<string, unknown>, field: string): unknown => {
      if (!(field in map)) throw MarifoldError.configInvalid(`Unknown config key: ${section}.${field}`);
      return map[field];
    };
    if (parts[0] === 'default' && parts.length === 2) {
      const d = this.config.default;
      return pick('default', {
        provider: d.provider,
        model: d.model,
        profile: d.profile,
        timeout_seconds: d.timeoutSeconds,
        max_output_tokens: d.maxOutputTokens,
        max_system_chars: d.maxSystemChars,
        max_context_tokens: d.maxContextTokens,
        compaction_keep_turns: d.compactionKeepTurns,
        session_context_turns: d.sessionContextTurns,
        think: d.think,
      }, parts[1]);
    }
    if (parts[0] === 'paths' && parts.length === 2) {
      const p = this.config.paths;
      return pick('paths', {
        profiles_dir: p.profilesDir,
        sessions_db: p.sessionsDb,
        tasks_dir: p.tasksDir,
        schedules_dir: p.schedulesDir,
        skills_dir: p.skillsDir,
      }, parts[1]);
    }
    if (parts[0] === 'memory' && parts.length === 2) {
      const m = this.config.memory;
      return pick('memory', { size_limit: m.sizeLimit, context_limit: m.contextLimit }, parts[1]);
    }
    if (parts[0] === 'service' && parts.length === 2) {
      const svc = this.config.service;
      return pick('service', {
        token_env: svc?.tokenEnv,
        token: svc?.token,
        cors_origins: svc?.corsOrigins,
        web_dir: svc?.webDir,
      }, parts[1]);
    }
    if (parts[0] === 'providers' && parts.length === 3) {
      const provider = this.config.providers[parts[1]];
      return pick(`providers.${parts[1]}`, {
        type: provider?.type,
        base_url: provider?.baseUrl,
        api_key_env: provider?.apiKeyEnv,
        api_key: provider?.apiKey,
        oauth_token: provider?.oauthToken,
        api_key_expires_at: provider?.apiKeyExpiresAt,
        account_id: provider?.accountId,
      }, parts[2]);
    }
    throw MarifoldError.configInvalid(`Unknown config key: ${key}`);
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
    if (options.accountId) providerConfig.accountId = options.accountId;
    this.registerModelOption(provider, model);
    this.save();
    return { configPath: this.configPath, key: 'models.options', value: `${provider}/${model}` };
  }

  /** Merge changes into the [web_search] section (undefined keys are left as-is)
   * and persist. Used by `marifold config search`. */
  updateWebSearch(partial: Partial<MarifoldWebSearchConfig>): ConfigSetResult {
    const defined = Object.fromEntries(
      Object.entries(partial).filter(([, value]) => value !== undefined),
    ) as Partial<MarifoldWebSearchConfig>;
    this.config.webSearch = { ...resolveWebSearchConfig(this.config.webSearch), ...defined };
    this.save();
    return { configPath: this.configPath, key: 'web_search.provider', value: this.config.webSearch.provider };
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
      case 'max_context_tokens':
        this.config.default.maxContextTokens = parseNumber(value, 'default.max_context_tokens');
        return;
      case 'compaction_keep_turns':
        this.config.default.compactionKeepTurns = parseNumber(value, 'default.compaction_keep_turns');
        return;
      case 'session_context_turns': {
        const trimmed = value.trim().toLowerCase();
        if (trimmed === 'all' || trimmed === '') {
          this.config.default.sessionContextTurns = undefined;
        } else {
          const turns = parseNumber(value, 'default.session_context_turns');
          if (!Number.isInteger(turns) || turns < 0) {
            throw MarifoldError.configInvalid('Expected default.session_context_turns to be a non-negative integer or "all".');
          }
          this.config.default.sessionContextTurns = turns;
        }
        return;
      }
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
      case 'skills_dir':
        this.config.paths.skillsDir = resolveUserPath(value);
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

  /** Write a [service] key, creating the section on first write. Empty string
   * clears optional keys (token_env/token/web_dir) and empties cors_origins —
   * so `config set service.token ""` revokes rather than storing "". */
  private setServiceValue(key: string, value: string): void {
    const service = this.config.service ?? (this.config.service = { corsOrigins: [] });
    const cleared = value.trim() === '' ? undefined : value.trim();
    switch (key) {
      case 'token_env':
        service.tokenEnv = cleared;
        return;
      case 'token':
        service.token = cleared;
        return;
      case 'web_dir':
        service.webDir = cleared === undefined ? undefined : resolveUserPath(cleared);
        return;
      case 'cors_origins':
        service.corsOrigins = value.split(',').map(origin => origin.trim()).filter(Boolean);
        return;
      default:
        throw MarifoldError.configInvalid(`Unknown config key: service.${key}`);
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
      case 'account_id':
        provider.accountId = value;
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
    optionalNumberLine('max_context_tokens', config.default.maxContextTokens),
    optionalNumberLine('compaction_keep_turns', config.default.compactionKeepTurns),
    optionalNumberLine('session_context_turns', config.default.sessionContextTurns),
    `think = ${config.default.think}`,
  ].filter(Boolean);

  const pathLines = [
    '[paths]',
    `profiles_dir = ${tomlString(config.paths.profilesDir)}`,
    `sessions_db = ${tomlString(config.paths.sessionsDb)}`,
    `tasks_dir = ${tomlString(config.paths.tasksDir)}`,
    ...(config.paths.schedulesDir ? [`schedules_dir = ${tomlString(config.paths.schedulesDir)}`] : []),
    ...(config.paths.skillsDir ? [`skills_dir = ${tomlString(config.paths.skillsDir)}`] : []),
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
    `provider = ${tomlString(config.webSearch.provider)}`,
    optionalStringLine('api_key_env', config.webSearch.apiKeyEnv),
    optionalStringLine('api_key', config.webSearch.apiKey),
    ...(config.webSearch.scrape ? ['scrape = true'] : []),
    ...(config.webSearch.proxy ? [`proxy = ${tomlString(config.webSearch.proxy)}`] : []),
  ].filter(Boolean).join('\n');

  const tg = config.channels?.telegram;
  const telegramSection = tg === undefined ? undefined : [
    '[channel.telegram]',
    ...(tg.enabled === false ? ['enabled = false'] : []),
    optionalStringLine('bot_token_env', tg.botTokenEnv),
    optionalStringLine('bot_token', tg.botToken),
    `allowlist = [${tg.allowlist.join(', ')}]`,
    `profile = ${tomlString(tg.profile)}`,
    `default_mode = ${tomlString(tg.defaultMode)}`,
  ].filter(Boolean).join('\n');

  const svc = config.service;
  const serviceSection = svc === undefined ? undefined : [
    '[service]',
    optionalStringLine('token_env', svc.tokenEnv),
    optionalStringLine('token', svc.token),
    `cors_origins = [${svc.corsOrigins.map(origin => tomlString(origin)).join(', ')}]`,
    optionalStringLine('web_dir', svc.webDir),
  ].filter(Boolean).join('\n');

  const providerTables = Object.entries(config.providers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, provider]) => renderProvider(name, provider));

  const sections = [
    defaultLines.join('\n'),
    modelLines.join('\n'),
    memoryLines.join('\n'),
    ...(agentSection ? [agentSection] : []),
    ...(webSearchSection ? [webSearchSection] : []),
    ...(telegramSection ? [telegramSection] : []),
    ...(serviceSection ? [serviceSection] : []),
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
    optionalStringLine('account_id', provider.accountId),
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
