import { fetchWithTransientRetry } from '../util/fetchRetry';
import { proxyDispatcher } from '../util/proxy';

const XAI_OAUTH_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const REFRESH_TIMEOUT_MS = 20_000;

export interface XaiRefreshedTokens {
  /** OAuth access token — used directly as the api.x.ai Bearer credential. */
  apiKey: string;
  /** Next refresh token. May rotate; persist it. */
  refreshToken: string;
  /** Unix seconds when the access credential expires, when reported. */
  expiresAt?: number;
}

/**
 * Refresh an expired xAI Grok OAuth credential from the stored refresh token.
 * SuperGrok / X Premium+ accounts use the access token directly as the
 * api.x.ai Bearer credential, so there is no id_token→API-key exchange.
 */
export async function refreshXaiAccessToken(refreshToken: string, proxy?: string): Promise<XaiRefreshedTokens> {
  const data = await postForm(XAI_OAUTH_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: XAI_OAUTH_CLIENT_ID,
  }, 'xAI token refresh failed', proxy);

  const accessToken = stringField(data.access_token);
  if (!accessToken) {
    throw new Error('xAI token refresh response did not include an access token.');
  }

  const expiresIn = numberField(data.expires_in);
  return {
    apiKey: accessToken,
    refreshToken: stringField(data.refresh_token) ?? refreshToken,
    expiresAt: expiresIn !== undefined ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
  };
}

async function postForm(url: string, body: Record<string, string>, label: string, proxy?: string): Promise<Record<string, unknown>> {
  const dispatcher = proxyDispatcher(proxy);
  try {
    const init: Record<string, unknown> = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    };
    if (dispatcher) init.dispatcher = dispatcher;
    let response: Response;
    try {
      response = await fetchWithTransientRetry(url, init as RequestInit);
    } catch (error) {
      if (!(error instanceof Error)) throw new Error(`${label}: ${String(error)}`);
      // undici puts the real transport reason on `.cause` (ECONNREFUSED, TLS,
      // proxy errors); surface it so a "fetch failed" is diagnosable.
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const causeText = cause ? ` (cause: ${cause.code ?? cause.message})` : '';
      throw new Error(`${label}: ${error.name}: ${error.message}${causeText}`);
    }
    return await parseResponse(response, label);
  } finally {
    await dispatcher?.close();
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
