import type { MarifoldAgentConfig, PartialAgentConfig } from '../agent/ApprovalPolicy';

export type ProviderType = 'ollama' | 'openai-compatible' | 'anthropic';

export interface MarifoldDefaultConfig {
  provider?: string;
  model?: string;
  profile: string;
  timeoutSeconds?: number;
  maxOutputTokens?: number;
  maxSystemChars?: number;
  /** Conversation-context budget in tokens. Enables session compaction when set (unset = off). */
  maxContextTokens?: number;
  /** Recent turns kept verbatim when compacting; older turns fold into the summary. */
  compactionKeepTurns?: number;
  /** Hard cap on recent session turns replayed to the model (undefined = all). Per-profile overridable. */
  sessionContextTurns?: number;
  think: boolean;
}

export interface MarifoldPathsConfig {
  profilesDir: string;
  sessionsDb: string;
  tasksDir: string;
  /** Defaults to ~/.marifold/schedules when omitted in older configs. */
  schedulesDir?: string;
  /** Defaults to ~/.marifold/skills when omitted in older configs. */
  skillsDir?: string;
}

export interface MarifoldModelsConfig {
  options: string[];
}

export interface MarifoldMemoryConfig {
  sizeLimit: number;
  contextLimit: number;
}

export type WebSearchProvider = 'duckduckgo' | 'firecrawl';

export interface MarifoldWebSearchConfig {
  /** Master switch for the model-initiated web_search tool, in both chat and
   * agent mode — the model decides when to search. Agent calls additionally
   * honor the `network` approval policy. */
  enabled: boolean;
  maxResults: number;
  /** Active search backend. Defaults to the keyless DuckDuckGo floor;
   * `firecrawl` adds AI-ready scraped results (BYOK). */
  provider: WebSearchProvider;
  /** Env var holding the provider's API key. Preferred over `apiKey` so the
   * secret stays out of config.toml. */
  apiKeyEnv?: string;
  /** API key stored directly in config (BYOK). Prefer `apiKeyEnv`. */
  apiKey?: string;
  /** Firecrawl only: scrape each result into LLM-ready markdown (costs more
   * per the provider; off by default). */
  scrape?: boolean;
  /** HTTP proxy for the search backend, e.g. "http://127.0.0.1:7890".
   * Falls back to the HTTPS_PROXY/https_proxy environment variables. */
  proxy?: string;
}

export const DEFAULT_WEB_SEARCH_CONFIG: MarifoldWebSearchConfig = {
  enabled: false,
  maxResults: 5,
  provider: 'duckduckgo',
};

export function resolveWebSearchConfig(partial?: Partial<MarifoldWebSearchConfig>): MarifoldWebSearchConfig {
  // Drop undefined values so an absent key never clobbers a default.
  const defined = Object.fromEntries(
    Object.entries(partial ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<MarifoldWebSearchConfig>;
  return { ...DEFAULT_WEB_SEARCH_CONFIG, ...defined };
}

export interface MarifoldProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  oauthToken?: string;
  apiKeyExpiresAt?: number;
  /** ChatGPT subscription account id, sent as the `chatgpt-account-id` header
   * on Codex-backend requests. Set during ChatGPT OAuth sign-in. */
  accountId?: string;
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
  /** Normalized [channel.*] sections (messaging bridges). Absent when none. */
  channels?: MarifoldChannelsConfig;
}

export interface MarifoldChannelsConfig {
  telegram?: TelegramChannelConfig;
}

/** A messaging bridge that runs a profile in-process over Telegram. */
export interface TelegramChannelConfig {
  /** When false, the bridge refuses to start even if configured. Defaults true. */
  enabled?: boolean;
  /** Env var holding the bot token. Preferred over `botToken` so the secret
   * stays out of config.toml. */
  botTokenEnv?: string;
  /** Bot token stored directly in config. Prefer `botTokenEnv`. */
  botToken?: string;
  /** Telegram user ids allowed to talk to the bot. Empty = nobody (locked). */
  allowlist: number[];
  /** Profile whose model + permissions the bot runs under. */
  profile: string;
  /** Default interaction mode for a new chat (`/chat` `/agent` switch per chat). */
  defaultMode: ProfileMode;
}

export interface LoadedMarifoldConfig {
  config: MarifoldConfig;
  configPath: string;
  foundConfig: boolean;
}

/** A profile's default interaction mode for the TUI: autonomous `agent` (the
 * global default) or single-turn `chat`. */
export type ProfileMode = 'agent' | 'chat';

export interface ProfileSettings {
  provider?: string;
  model?: string;
  memories: boolean;
  /** Default TUI mode for this profile; undefined falls back to `agent`. */
  mode?: ProfileMode;
  /** Per-profile conversation-context budget in tokens; falls back to default.maxContextTokens. */
  maxContextTokens?: number;
  /** Per-profile cap on recent session turns replayed to the model (undefined = all);
   * falls back to default.sessionContextTurns. */
  sessionContextTurns?: number;
  /** Per-profile thinking default; undefined falls back to default.think (off). */
  think?: boolean;
  /** Per-profile agent overrides (approval/permissions, tool mode, iterations).
   * Merged over the global `[agent]`; undefined keys inherit global/defaults. */
  agent?: PartialAgentConfig;
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
