export type ProviderType = 'ollama' | 'openai-compatible' | 'anthropic';

export interface MarifoldDefaultConfig {
  provider?: string;
  model?: string;
  profile: string;
  timeoutSeconds?: number;
  maxOutputTokens?: number;
  maxSystemChars?: number;
}

export interface MarifoldPathsConfig {
  profilesDir: string;
  sessionsDb: string;
}

export interface MarifoldProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface MarifoldConfig {
  default: MarifoldDefaultConfig;
  paths: MarifoldPathsConfig;
  providers: Record<string, MarifoldProviderConfig>;
}

export interface LoadedMarifoldConfig {
  config: MarifoldConfig;
  configPath: string;
  foundConfig: boolean;
}

export interface ProfileSettings {
  provider?: string;
  model?: string;
}

export interface ProfileSummary {
  name: string;
  source: 'directory' | 'json' | 'built-in';
  path?: string;
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
