import type { MarifoldAgentConfig } from '../agent/ApprovalPolicy';

export type ProviderType = 'ollama' | 'openai-compatible' | 'anthropic';

export interface MarifoldDefaultConfig {
  provider?: string;
  model?: string;
  profile: string;
  timeoutSeconds?: number;
  maxOutputTokens?: number;
  maxSystemChars?: number;
  think: boolean;
}

export interface MarifoldPathsConfig {
  profilesDir: string;
  sessionsDb: string;
  tasksDir: string;
  /** Defaults to ~/.marifold/schedules when omitted in older configs. */
  schedulesDir?: string;
}

export interface MarifoldModelsConfig {
  options: string[];
}

export interface MarifoldMemoryConfig {
  sizeLimit: number;
  contextLimit: number;
}

export interface MarifoldWebSearchConfig {
  /** Enables model-initiated web_search/read_file tools on chat turns.
   * The explicit /search chat command works regardless of this flag. */
  enabled: boolean;
  maxResults: number;
  /** HTTP proxy for the search backend, e.g. "http://127.0.0.1:7890".
   * Falls back to the HTTPS_PROXY/https_proxy environment variables. */
  proxy?: string;
}

export const DEFAULT_WEB_SEARCH_CONFIG: MarifoldWebSearchConfig = {
  enabled: false,
  maxResults: 5,
};

export function resolveWebSearchConfig(partial?: Partial<MarifoldWebSearchConfig>): MarifoldWebSearchConfig {
  return { ...DEFAULT_WEB_SEARCH_CONFIG, ...(partial ?? {}) };
}

export interface MarifoldProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  oauthToken?: string;
  apiKeyExpiresAt?: number;
}

export interface MarifoldConfig {
  default: MarifoldDefaultConfig;
  models: MarifoldModelsConfig;
  memory: MarifoldMemoryConfig;
  paths: MarifoldPathsConfig;
  providers: Record<string, MarifoldProviderConfig>;
  /** Normalized [agent] section. Absent when the config file has none; use
   * resolveAgentConfig() for effective defaults. */
  agent?: MarifoldAgentConfig;
  /** Normalized [web_search] section. Absent when the config file has none;
   * use resolveWebSearchConfig() for effective defaults. */
  webSearch?: MarifoldWebSearchConfig;
}

export interface LoadedMarifoldConfig {
  config: MarifoldConfig;
  configPath: string;
  foundConfig: boolean;
}

export interface ProfileSettings {
  provider?: string;
  model?: string;
  memories: boolean;
}

export interface ProfileSummary {
  name: string;
  source: 'directory' | 'json' | 'built-in';
  path?: string;
}

export interface ProfileFileSummary {
  path?: string;
  content: string;
}

export interface ProfileDetail extends ProfileSummary {
  settings: ProfileSettings;
  files: {
    profile: ProfileFileSummary;
    rules: ProfileFileSummary;
    custom: ProfileFileSummary;
    profileToml: ProfileFileSummary;
  };
}

export interface SessionSummary {
  id: string;
  profileName: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

export interface SessionTurnSummary {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface SessionDetail extends SessionSummary {
  turns: SessionTurnSummary[];
}
