const CHATGPT_AUTH_ISSUER = 'https://auth.openai.com';
const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_TIMEOUT_MS = 20_000;

export interface ChatGptRefreshedTokens {
  /** API credential to use for requests (exchanged API key, or the access token). */
  apiKey: string;
  /** Next refresh token. May rotate; persist it. */
  refreshToken: string;
  /** Unix seconds when the access credential expires, when reported. */
  expiresAt?: number;
}

/**
 * Refresh an expired ChatGPT OAuth credential from the stored refresh token,
 * mirroring priests' refresh_chatgpt_access_token. When the response carries
 * an id_token, it is exchanged for an OpenAI API key (same flow as the
 * interactive sign-in); otherwise the access token is used directly.
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
  const apiKey = idToken ? await exchangeIdTokenForApiKey(idToken) : undefined;
  const expiresIn = numberField(data.expires_in);

  return {
    apiKey: apiKey ?? accessToken,
    refreshToken: stringField(data.refresh_token) ?? refreshToken,
    expiresAt: expiresIn !== undefined ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
  };
}

async function exchangeIdTokenForApiKey(idToken: string): Promise<string | undefined> {
  try {
    const data = await postForm(`${CHATGPT_AUTH_ISSUER}/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      requested_token: 'openai-api-key',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    }, 'ChatGPT API key exchange failed');
    return stringField(data.access_token);
  } catch {
    // The refreshed access token still works for chat; fall back to it.
    return undefined;
  }
}

async function postJson(url: string, body: Record<string, string>, label: string): Promise<Record<string, unknown>> {
  return parseResponse(await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  }, label), label);
}

async function postForm(url: string, body: Record<string, string>, label: string): Promise<Record<string, unknown>> {
  return parseResponse(await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  }, label), label);
}

async function doFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, init);
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
