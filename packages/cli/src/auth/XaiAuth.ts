import { createHash, randomBytes } from 'crypto';
import { createServer, Server } from 'http';
import { spawn } from 'child_process';
import { proxyDispatcher } from '@marifold/core';

export interface XaiAuthTokens {
  /** OAuth access token — used directly as the api.x.ai Bearer credential. */
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}

interface PkceCodes {
  codeVerifier: string;
  codeChallenge: string;
}

// xAI Grok SuperGrok / X Premium+ OAuth. api.x.ai is a plain OpenAI-compatible
// surface, so the access token is used as a normal Bearer credential — there is
// no account-id header (unlike the ChatGPT Codex backend). The client id is
// xAI's public desktop OAuth client used by the Grok CLI; it is not a secret.
const XAI_AUTH_ISSUER = 'https://auth.x.ai';
const XAI_OAUTH_AUTHORIZE_URL = `${XAI_AUTH_ISSUER}/oauth2/authorize`;
const XAI_OAUTH_TOKEN_URL = `${XAI_AUTH_ISSUER}/oauth2/token`;
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_OAUTH_PORT = 56121;
const XAI_CALLBACK_PATH = '/callback';

/** Reads a line the user pastes back (the code xAI displays, or the full
 * redirect URL). Returns undefined/empty to fall back to the loopback redirect. */
export type ReadPastedCode = (prompt: string) => Promise<string | undefined>;

export async function authorizeXaiWithBrowser(
  write: (text: string) => void = text => process.stdout.write(text),
  readPastedCode?: ReadPastedCode,
): Promise<XaiAuthTokens> {
  const pkce = generatePkce();
  const state = base64Url(randomBytes(32));
  const nonce = base64Url(randomBytes(16));
  const callback = await startCallbackServer(state);
  const authUrl = buildXaiAuthorizeUrl(callback.redirectUri, pkce, state, nonce);

  try {
    openBrowser(authUrl);
    write('Open this URL in your browser to sign in with your SuperGrok / X Premium+ account:\n');
    write(`${authUrl}\n`);

    // xAI often shows a "copy this code" page instead of redirecting back to the
    // loopback listener, so offer a paste path and keep the redirect as a
    // fallback (press Enter to wait). Whichever the user does, the code is
    // exchanged against the same redirect_uri it was issued for.
    let code: string;
    if (readPastedCode) {
      write("\nWhen approved, xAI shows a code to copy (or returns here automatically).\n");
      const pasted = await readPastedCode('Paste the code from your browser, or press Enter to wait for the redirect: ');
      const trimmed = (pasted ?? '').trim();
      if (trimmed) {
        code = extractPastedCode(trimmed, state);
      } else {
        write('Waiting for the browser redirect...\n');
        code = await callback.waitForCode();
      }
    } else {
      write('Waiting for the browser redirect...\n');
      code = await callback.waitForCode();
    }

    write('Exchanging the authorization code for tokens with xAI...\n');
    return await exchangeXaiCodeForTokens(code, callback.redirectUri, pkce);
  } finally {
    await callback.close();
  }
}

/**
 * Extract the authorization code from whatever the user pastes: the full
 * `http://127.0.0.1:56121/callback?code=…&state=…` redirect, a bare
 * `code=…&state=…` querystring, or just the code shown on xAI's page.
 */
export function extractPastedCode(input: string, expectedState: string): string {
  const value = input.trim();
  let code: string | undefined;
  let state: string | undefined;
  try {
    const url = new URL(value);
    code = url.searchParams.get('code') ?? undefined;
    state = url.searchParams.get('state') ?? undefined;
  } catch {
    if (value.includes('code=')) {
      const params = new URLSearchParams(value);
      code = params.get('code') ?? undefined;
      state = params.get('state') ?? undefined;
    } else {
      code = value; // bare code — xAI's paste page shows no state
    }
  }
  if (!code) throw new Error('Could not find an authorization code in the pasted value.');
  if (state && state !== expectedState) throw new Error('OAuth state mismatch in the pasted redirect.');
  return code;
}

export function buildXaiAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string, nonce: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    plan: 'generic',
    referrer: 'hermes-agent',
  });
  return `${XAI_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeXaiCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<XaiAuthTokens> {
  const data = await postForm(XAI_OAUTH_TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: XAI_OAUTH_CLIENT_ID,
    code_verifier: pkce.codeVerifier,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
  }, 'xAI token exchange failed');

  const accessToken = stringField(data.access_token);
  const refreshToken = stringField(data.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new Error('xAI token exchange response did not include access and refresh tokens.');
  }

  const expiresIn = numberField(data.expires_in);
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn !== undefined ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
  };
}

async function postForm(url: string, data: Record<string, string>, label: string): Promise<Record<string, unknown>> {
  // Node's fetch ignores HTTPS_PROXY by default; honor it for this external call
  // (xAI's token endpoint) so the exchange works behind a proxy like the browser.
  const init: Record<string, unknown> = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(data),
    // Generous ceiling: the OAuth token endpoint can be slow through a proxy.
    signal: AbortSignal.timeout(60000),
  };
  const dispatcher = proxyDispatcher();
  if (dispatcher) init.dispatcher = dispatcher;
  const response = await fetch(url, init as RequestInit).catch(error => {
    throw new Error(`${label}: ${stringifyError(error)}`);
  });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as Record<string, unknown>;
}

async function startCallbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
  try {
    return await listenOnPort(XAI_OAUTH_PORT, expectedState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start local OAuth callback server on port ${XAI_OAUTH_PORT}: ${message}`);
  }
}

function listenOnPort(port: number, expectedState: string): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    let resolveCode: ((code: string) => void) | undefined;
    let rejectCode: ((error: Error) => void) | undefined;
    const codePromise = new Promise<string>((codeResolve, codeReject) => {
      resolveCode = codeResolve;
      rejectCode = codeReject;
    });

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://localhost:${port}`);
      if (requestUrl.pathname !== XAI_CALLBACK_PATH) {
        response.writeHead(404);
        response.end('Not Found');
        return;
      }

      const state = requestUrl.searchParams.get('state') ?? '';
      if (state !== expectedState) {
        respond(response, 'Sign-in failed: state mismatch.', 400);
        rejectCode?.(new Error('OAuth callback state mismatch.'));
        return;
      }

      const error = requestUrl.searchParams.get('error');
      if (error) {
        const description = requestUrl.searchParams.get('error_description') ?? error;
        respond(response, `Sign-in failed: ${description}`, 400);
        rejectCode?.(new Error(description));
        return;
      }

      const code = requestUrl.searchParams.get('code');
      if (!code) {
        respond(response, 'Sign-in failed: missing authorization code.', 400);
        rejectCode?.(new Error('OAuth callback did not include an authorization code.'));
        return;
      }

      respond(response, 'Sign-in complete. You can close this window and return to Marifold.');
      resolveCode?.(code);
    });

    server.once('error', error => reject(error));
    server.listen(port, '127.0.0.1', () => {
      resolve({
        redirectUri: `http://127.0.0.1:${port}${XAI_CALLBACK_PATH}`,
        waitForCode: () => withTimeout(codePromise, 300000, 'xAI sign-in timed out before the callback was received.'),
        close: () => closeServer(server),
      });
    });
  });
}

function respond(response: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body: string) => void }, message: string, status = 200): void {
  const escaped = message.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] ?? char));
  const body = `<!doctype html><html><head><title>marifold auth</title></head><body><p>${escaped}</p></body></html>`;
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
    // The browser keeps the success-page connection alive, which blocks
    // server.close() from ever completing; force lingering sockets closed so
    // the sign-in returns promptly instead of hanging after the token exchange.
    server.closeAllConnections();
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function generatePkce(): PkceCodes {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.unref();
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringifyError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // undici surfaces the real transport reason (ECONNREFUSED, ECONNRESET, TLS,
  // proxy errors) on `.cause`, not the bare "fetch failed" message — include it
  // so a failed sign-in is diagnosable (e.g. a missing HTTPS_PROXY in China).
  const cause = (error as { cause?: unknown }).cause;
  const causeText = cause instanceof Error
    ? ` (cause: ${(cause as { code?: string }).code ?? cause.message})`
    : cause && typeof cause === 'object' && 'code' in cause
      ? ` (cause: ${(cause as { code?: string }).code})`
      : '';
  return `${error.name}: ${error.message}${causeText}`;
}
