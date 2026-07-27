import { describe, expect, it } from 'vitest';
import { applyOAuthCredentials, providerHasUsableCredential } from '../src/input/ModelPicker';

describe('providerHasUsableCredential', () => {
  it('requires OAuth setup again when the saved access credential has expired', () => {
    const now = Math.floor(Date.now() / 1000);

    expect(providerHasUsableCredential({
      type: 'openai-compatible',
      apiKey: 'expired-access',
      oauthToken: 'invalid-refresh',
      apiKeyExpiresAt: now - 1,
    }, {})).toBe(false);

    expect(providerHasUsableCredential({
      type: 'openai-compatible',
      apiKey: 'fresh-access',
      oauthToken: 'refresh',
      apiKeyExpiresAt: now + 3600,
    }, {})).toBe(true);
  });

  it('replaces OAuth credentials without dropping provider transport settings', () => {
    const updated = applyOAuthCredentials(
      {
        type: 'openai-compatible',
        baseUrl: 'https://old.example/v1',
        apiKey: 'old-access',
        oauthToken: 'old-refresh',
        apiKeyExpiresAt: 10,
        accountId: 'old-account',
        proxy: 'http://127.0.0.1:7890',
      },
      {
        name: 'xai',
        label: 'xAI',
        kind: 'oauth',
        type: 'openai-compatible',
        defaultBaseUrl: 'https://api.x.ai/v1',
        knownModels: null,
      },
      {
        apiKey: 'new-access',
        oauthToken: 'new-refresh',
        apiKeyExpiresAt: 20,
        baseUrl: 'https://api.x.ai/v1',
      },
    );

    expect(updated).toMatchObject({
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'new-access',
      oauthToken: 'new-refresh',
      apiKeyExpiresAt: 20,
      proxy: 'http://127.0.0.1:7890',
    });
    expect(updated.accountId).toBeUndefined();
  });
});
