export interface OpenAICompatUrlOptions {
  providerName?: string;
}

export function openAIChatCompletionsUrl(baseUrl: string, options: OpenAICompatUrlOptions = {}): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith('/chat/completions')) return normalized;
  if (options.providerName === 'github_copilot') return `${normalized}/chat/completions`;
  if (isVersionRoot(normalized)) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

export function openAIResponsesUrl(baseUrl: string, options: OpenAICompatUrlOptions = {}): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith('/responses')) return normalized;
  if (options.providerName === 'github_copilot') return `${normalized}/responses`;
  // ChatGPT subscription hits the Codex backend root (…/backend-api/codex),
  // which serves /responses directly with no /v1 segment.
  if (options.providerName === 'chatgpt') return `${normalized}/responses`;
  if (isVersionRoot(normalized)) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
}

export function openAIModelsUrl(baseUrl: string, options: OpenAICompatUrlOptions = {}): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith('/models')) return normalized;
  if (options.providerName === 'github_copilot' || options.providerName === 'chatgpt') {
    return `${normalized}/models`;
  }
  if (isVersionRoot(normalized)) return `${normalized}/models`;
  return `${normalized}/v1/models`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isVersionRoot(baseUrl: string): boolean {
  return /\/v\d+(?:beta)?(?:\/openai)?$/i.test(baseUrl);
}
