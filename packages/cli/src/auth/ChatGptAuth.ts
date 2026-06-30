import { createHash, randomBytes } from 'crypto';
import { createServer, Server } from 'http';
import { spawn } from 'child_process';
import { accountIdFromIdToken, proxyDispatcher } from '@marifold/core';

export interface ChatGptAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** ChatGPT account id from the id_token, sent as the `chatgpt-account-id`
   * header on Codex-backend requests. */
  accountId?: string;
  idToken?: string;
  expiresAt?: number;
}

interface PkceCodes {
  codeVerifier: string;
  codeChallenge: string;
}

const CHATGPT_AUTH_ISSUER = 'https://auth.openai.com';
const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const CHATGPT_OAUTH_PORTS = [1455, 1457];
const CHATGPT_CALLBACK_PATH = '/auth/callback';

export async function authorizeChatGptWithBrowser(
  write: (text: string) => void = text => process.stdout.write(text),
): Promise<ChatGptAuthTokens> {
  const pkce = generatePkce();
  const state = base64Url(randomBytes(32));
  const callback = await startCallbackServer(state);
  const authUrl = buildChatGptAuthorizeUrl(callback.redirectUri, pkce, state);

  try {
    openBrowser(authUrl);
    write('Open this URL in your browser to sign in with ChatGPT:\n');
    write(`${authUrl}\n`);
    write('Waiting for the browser redirect...\n');
    const code = await callback.waitForCode();
    write('Received the authorization code — exchanging tokens with OpenAI...\n');
    return await exchangeChatGptCodeForTokens(code, callback.redirectUri, pkce);
  } finally {
    await callback.close();
  }
}

export function buildChatGptAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CHATGPT_OAUTH_SCOPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'marifold_cli',
  });
  return `${CHATGPT_AUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeChatGptCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<ChatGptAuthTokens> {
  const data = await postForm(`${CHATGPT_AUTH_ISSUER}/oauth/token`, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    code_verifier: pkce.codeVerifier,
  }, 'ChatGPT token exchange failed');

  const accessToken = stringField(data.access_token);
  const refreshToken = stringField(data.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new Error('ChatGPT token exchange response did not include access and refresh tokens.');
  }

  const idToken = stringField(data.id_token);
  const expiresIn = numberField(data.expires_in);

  return {
    accessToken,
    refreshToken,
    // Subscription (ChatGPT plan) accounts have no platform organization, so we
    // use the access token directly against the Codex backend rather than
    // exchanging the id_token for a platform API key. The account id from the
    // id_token is required as the `chatgpt-account-id` request header.
    accountId: idToken ? accountIdFromIdToken(idToken) : undefined,
    idToken,
    expiresAt: expiresIn !== undefined ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
  };
}

async function postForm(url: string, data: Record<string, string>, label: string): Promise<Record<string, unknown>> {
  // Node's fetch ignores HTTPS_PROXY by default; honor it for this external call
  // (OpenAI's token endpoint) so the exchange works behind a proxy like the browser.
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
  let lastError: Error | undefined;
  for (const port of CHATGPT_OAUTH_PORTS) {
    try {
      return await listenOnPort(port, expectedState);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(`Could not start local OAuth callback server on ports 1455 or 1457${lastError ? `: ${lastError.message}` : ''}`);
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
      if (requestUrl.pathname !== CHATGPT_CALLBACK_PATH) {
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
        redirectUri: `http://localhost:${port}${CHATGPT_CALLBACK_PATH}`,
        waitForCode: () => withTimeout(codePromise, 300000, 'ChatGPT sign-in timed out before the callback was received.'),
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
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
