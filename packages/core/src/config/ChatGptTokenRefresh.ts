import { proxyDispatcher } from '../util/proxy';
import { accountIdFromIdToken } from '../util/idToken';

const CHATGPT_AUTH_ISSUER = 'https://auth.openai.com';
const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_TIMEOUT_MS = 20_000;

export interface ChatGptRefreshedTokens {
  /** OAuth access token — used directly as the Codex-backend bearer credential. */
  apiKey: string;
  /** Next refresh token. May rotate; persist it. */
  refreshToken: string;
  /** ChatGPT account id from the refreshed id_token, when present. */
  accountId?: string;
  /** Unix seconds when the access credential expires, when reported. */
  expiresAt?: number;
}

/**
 * Refresh an expired ChatGPT OAuth credential from the stored refresh token.
 * Subscription (ChatGPT plan) accounts use the access token directly against
 * the Codex backend, so no id_token→API-key exchange happens; the account id is
 * re-derived from the refreshed id_token for the `chatgpt-account-id` header.
 */
export async function refreshChatGptAccessToken(refreshToken: string): Promise<ChatGptRefreshedTokens> {
  const data = await postJson(`${CHATGPT_AUTH_ISSUER}/oauth/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CHATGPT_OAUTH_CLIENT_ID,
  }, 'ChatGPT token refresh failed');

  const accessToken = stringField(data.access_token);
  if (!accessToken) {
    throw new Error('ChatGPT token refresh response did not include an access token.');
  }

  const idToken = stringField(data.id_token);
  const expiresIn = numberField(data.expires_in);

  return {
    apiKey: accessToken,
    refreshToken: stringField(data.refresh_token) ?? refreshToken,
    accountId: idToken ? accountIdFromIdToken(idToken) : undefined,
    expiresAt: expiresIn !== undefined ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
  };
}

async function postJson(url: string, body: Record<string, string>, label: string): Promise<Record<string, unknown>> {
  return parseResponse(await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  }, label), label);
}

async function doFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  const dispatcher = proxyDispatcher();
  try {
    return await fetch(url, dispatcher ? { ...init, dispatcher } as RequestInit : init);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}

async function parseResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }
  return await response.json() as Record<string, unknown>;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
