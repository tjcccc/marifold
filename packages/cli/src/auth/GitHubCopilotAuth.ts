import { exchangeGitHubTokenForCopilotToken } from '@marifold/core';

export { exchangeGitHubTokenForCopilotToken };

const GITHUB_COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_COPILOT_SCOPE = 'read:user';

export function looksLikeCopilotIdeToken(token: string): boolean {
  return token.startsWith('tid=');
}

export async function authorizeGitHubCopilotWithDevice(
  write: (text: string) => void = text => process.stdout.write(text),
): Promise<{ apiKey: string; baseUrl: string; oauthToken: string; apiKeyExpiresAt?: number }> {
  const device = await startGitHubCopilotDeviceFlow();
  write('GitHub Copilot OAuth\n');
  write(`Open: ${device.verificationUri}\n`);
  write(`Enter code: ${device.userCode}\n`);
  write('Waiting for authorization...\n');

  const githubToken = await pollGitHubCopilotDeviceFlow(device.deviceCode, device.interval, device.expiresIn);
  const copilot = await exchangeGitHubTokenForCopilotToken(githubToken);
  return {
    apiKey: copilot.token,
    baseUrl: copilot.baseUrl,
    oauthToken: githubToken,
    apiKeyExpiresAt: copilot.expiresAt,
  };
}

async function startGitHubCopilotDeviceFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}> {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'marifold',
    },
    body: new URLSearchParams({
      client_id: GITHUB_COPILOT_CLIENT_ID,
      scope: GITHUB_COPILOT_SCOPE,
    }),
    signal: AbortSignal.timeout(10000),
  }).catch(error => {
    throw new Error(`Could not start GitHub device flow: ${stringifyError(error)}`);
  });

  if (!response.ok) throw new Error(`GitHub device flow failed: HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json() as Record<string, unknown>;
  const deviceCode = requiredString(data.device_code, 'device_code');
  const userCode = requiredString(data.user_code, 'user_code');
  const verificationUri = requiredString(data.verification_uri, 'verification_uri');

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: numberField(data.expires_in) ?? 900,
    interval: numberField(data.interval) ?? 5,
  };
}

async function pollGitHubCopilotDeviceFlow(deviceCode: string, interval: number, expiresIn: number): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = Math.max(interval, 1);

  while (Date.now() < deadline) {
    await delay(pollInterval * 1000);
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'marifold',
      },
      body: new URLSearchParams({
        client_id: GITHUB_COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal: AbortSignal.timeout(10000),
    }).catch(error => {
      throw new Error(`Could not poll GitHub device flow: ${stringifyError(error)}`);
    });

    if (!response.ok) throw new Error(`GitHub device polling failed: HTTP ${response.status}: ${await response.text()}`);
    const data = await response.json() as Record<string, unknown>;
    const token = stringField(data.access_token);
    if (token) return token;

    const error = stringField(data.error);
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      pollInterval += 5;
      continue;
    }
    if (error === 'expired_token') throw new Error('The device code expired. Start again.');
    if (error === 'access_denied') throw new Error('Authorization was denied.');
    throw new Error(stringField(data.error_description) ?? error ?? 'Authorization failed.');
  }

  throw new Error('The device code expired. Start again.');
}

function requiredString(value: unknown, label: string): string {
  const parsed = stringField(value);
  if (!parsed) throw new Error(`GitHub device flow response missing '${label}'.`);
  return parsed;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
