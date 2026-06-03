import { MarifoldProviderConfig, ProviderType } from './ConfigSchema';

export type ProviderRegistryKind = 'local' | 'api' | 'oauth';

export interface ProviderRegistryEntry {
  name: string;
  label: string;
  kind: ProviderRegistryKind;
  type: ProviderType;
  defaultBaseUrl?: string;
  apiKeyEnv?: string;
  knownModels: string[] | null;
}

export const GITHUB_COPILOT_RESPONSES_MODELS = [
  'gpt-5.4-mini',
];

// GitHub's public Copilot model table is broader than the current OpenAI-compatible
// endpoints Marifold supports. Keep this fallback list to models usable by Marifold chat.
export const GITHUB_COPILOT_CHAT_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  ...GITHUB_COPILOT_RESPONSES_MODELS,
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5-mini',
  'gpt-4.1',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-opus-4.6-fast',
  'claude-opus-4.5',
  'claude-haiku-4.5',
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'raptor-mini',
  'mai-code-1-flash',
];

const GITHUB_COPILOT_UNSUPPORTED_MODEL_IDS = new Set([
  'gpt-5.4-nano',
  'text-embedding-3-small',
  'text-embedding-3-large',
  'trajectory-compaction',
  'oswe-vscode-prime',
]);

export function isGitHubCopilotResponsesModelId(modelId: string): boolean {
  return GITHUB_COPILOT_RESPONSES_MODELS.includes(modelId);
}

export function isKnownGitHubCopilotUnsupportedModelId(modelId: string): boolean {
  if (modelId.startsWith('text-embedding-')) return true;
  return GITHUB_COPILOT_UNSUPPORTED_MODEL_IDS.has(modelId);
}

const REGISTRY: ProviderRegistryEntry[] = [
  {
    name: 'ollama',
    label: 'Ollama (local)',
    kind: 'local',
    type: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
    knownModels: null,
  },
  {
    name: 'llamacpp',
    label: 'llama.cpp (local)',
    kind: 'local',
    type: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:8080',
    knownModels: null,
  },
  {
    name: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'local',
    type: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:1234',
    knownModels: null,
  },
  {
    name: 'rapidmlx',
    label: 'Rapid-MLX (local)',
    kind: 'local',
    type: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:8000',
    knownModels: null,
  },
  {
    name: 'openai',
    label: 'OpenAI',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com',
    apiKeyEnv: 'OPENAI_API_KEY',
    knownModels: [
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
      'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
      'gpt-4o', 'gpt-4o-mini',
      'o4-mini', 'o3', 'o3-mini',
    ],
  },
  {
    name: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'api',
    type: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    knownModels: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
    ],
  },
  {
    name: 'gemini',
    label: 'Google Gemini',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    knownModels: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
    ],
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    knownModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    name: 'mistral',
    label: 'Mistral AI',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.mistral.ai',
    apiKeyEnv: 'MISTRAL_API_KEY',
    knownModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'],
  },
  {
    name: 'groq',
    label: 'Groq',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai',
    apiKeyEnv: 'GROQ_API_KEY',
    knownModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'qwen/qwen3-32b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ],
  },
  {
    name: 'perplexity',
    label: 'Perplexity',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.perplexity.ai',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
    knownModels: ['sonar-pro', 'sonar', 'sonar-reasoning'],
  },
  {
    name: 'cohere',
    label: 'Cohere',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.cohere.com/compatibility',
    apiKeyEnv: 'COHERE_API_KEY',
    knownModels: ['command-r-plus-08-2024', 'command-r-08-2024'],
  },
  {
    name: 'together',
    label: 'Together AI',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.together.xyz',
    apiKeyEnv: 'TOGETHER_API_KEY',
    knownModels: [],
  },
  {
    name: 'bailian',
    label: 'Alibaba Bailian (China)',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    apiKeyEnv: 'BAILIAN_API_KEY',
    knownModels: [
      'qwen3-max', 'qwen3-235b-a22b', 'qwen3-32b', 'qwen3-14b', 'qwen3-8b',
      'qwen3.5-plus', 'qwen3.5-flash',
      'qwq-plus',
    ],
  },
  {
    name: 'alibaba_cloud',
    label: 'Alibaba Cloud (international)',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode',
    apiKeyEnv: 'ALIBABA_CLOUD_API_KEY',
    knownModels: [
      'qwen3-max', 'qwen3-235b-a22b', 'qwen3-32b', 'qwen3-14b', 'qwen3-8b',
      'qwen3.5-plus', 'qwen3.5-flash',
      'qwq-plus',
    ],
  },
  {
    name: 'minimax',
    label: 'MiniMax',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.minimax.io',
    apiKeyEnv: 'MINIMAX_API_KEY',
    knownModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'],
  },
  {
    name: 'kimi',
    label: 'Kimi (Moonshot, China)',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.moonshot.cn',
    apiKeyEnv: 'KIMI_API_KEY',
    knownModels: ['kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
  },
  {
    name: 'openrouter',
    label: 'OpenRouter (gateway)',
    kind: 'api',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    knownModels: [],
  },
  {
    name: 'github_copilot',
    label: 'GitHub Copilot (OAuth)',
    kind: 'oauth',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.githubcopilot.com',
    apiKeyEnv: 'GITHUB_COPILOT_API_KEY',
    knownModels: GITHUB_COPILOT_CHAT_MODELS,
  },
  {
    name: 'chatgpt',
    label: 'ChatGPT (OpenAI OAuth)',
    kind: 'oauth',
    type: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com',
    apiKeyEnv: 'CHATGPT_API_KEY',
    knownModels: [
      'gpt-5.5',
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
      'gpt-5.2', 'gpt-5-mini', 'gpt-5-nano',
      'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
      'gpt-4o', 'gpt-4o-mini',
    ],
  },
  {
    name: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    kind: 'api',
    type: 'openai-compatible',
    knownModels: [],
  },
];

export function listProviderRegistry(): ProviderRegistryEntry[] {
  return [...REGISTRY];
}

export function getProviderRegistryEntry(name: string): ProviderRegistryEntry | undefined {
  return REGISTRY.find(provider => provider.name === name);
}

export function providerConfigFromRegistry(entry: ProviderRegistryEntry): Partial<MarifoldProviderConfig> {
  return {
    type: entry.type,
    ...(entry.defaultBaseUrl ? { baseUrl: entry.defaultBaseUrl } : {}),
    ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
  };
}
