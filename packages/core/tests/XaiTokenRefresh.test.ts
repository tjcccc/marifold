import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshXaiAccessToken } from '../src/config/XaiTokenRefresh';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshXaiAccessToken', () => {
  it('posts the refresh grant and returns the new access token', async () => {
    let requestUrl: string | undefined;
    let requestBody: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = String(init?.body);
      return new Response(JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      }), { status: 200 });
    }));

    const before = Math.floor(Date.now() / 1000);
    const result = await refreshXaiAccessToken('old-refresh');

    expect(requestUrl).toBe('https://auth.x.ai/oauth2/token');
    const params = new URLSearchParams(requestBody);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('old-refresh');
    expect(params.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828');

    expect(result.apiKey).toBe('new-access');
    expect(result.refreshToken).toBe('rotated-refresh');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600);
  });

  it('keeps the existing refresh token when the response omits one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-access',
      expires_in: 3600,
    }), { status: 200 })));

    const result = await refreshXaiAccessToken('old-refresh');
    expect(result.refreshToken).toBe('old-refresh');
  });

  it('throws when the token response lacks an access token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    await expect(refreshXaiAccessToken('old-refresh')).rejects.toThrow(/did not include an access token/);
  });

  it('throws with the HTTP status on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(refreshXaiAccessToken('old-refresh')).rejects.toThrow(/HTTP 401/);
  });
});
