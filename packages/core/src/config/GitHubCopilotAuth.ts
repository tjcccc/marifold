export interface GitHubCopilotToken {
  token: string;
  baseUrl: string;
  expiresAt?: number;
}

const DEFAULT_COPILOT_BASE_URL = 'https://api.githubcopilot.com';

export async function exchangeGitHubTokenForCopilotToken(githubToken: string): Promise<GitHubCopilotToken> {
  const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Accept: 'application/json',
      Authorization: `token ${githubToken}`,
      'Editor-Version': 'marifold/0',
      'User-Agent': 'marifold',
    },
    signal: AbortSignal.timeout(10000),
  }).catch(error => {
    throw new Error(`Could not exchange GitHub token for Copilot token: ${stringifyError(error)}`);
  });

  if (!response.ok) {
    throw new Error(`GitHub Copilot token exchange failed: HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as {
    token?: unknown;
    copilot_token?: unknown;
    endpoints?: { api?: unknown };
    expires_at?: unknown;
  };
  const token = stringField(data.token) ?? stringField(data.copilot_token);
  if (!token) throw new Error('GitHub Copilot token exchange did not return a token.');

  return {
    token,
    baseUrl: copilotApiBaseUrl(data),
    expiresAt: typeof data.expires_at === 'number' ? data.expires_at : undefined,
  };
}

function copilotApiBaseUrl(data: { endpoints?: { api?: unknown } }): string {
  const api = data.endpoints?.api;
  return typeof api === 'string' && api ? api.replace(/\/+$/, '') : DEFAULT_COPILOT_BASE_URL;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
