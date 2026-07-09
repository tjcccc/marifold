import { describe, expect, it } from 'vitest';
import { buildXaiAuthorizeUrl, extractPastedCode } from '../src/auth/XaiAuth';

describe('extractPastedCode', () => {
  const state = 'expected-state';

  it('accepts a bare code (xAI paste page shows no state)', () => {
    expect(extractPastedCode('cCFAaSZx41ai4tRNKf', state)).toBe('cCFAaSZx41ai4tRNKf');
  });

  it('extracts the code from a full loopback redirect URL and checks state', () => {
    const url = `http://127.0.0.1:56121/callback?code=abc123&state=${state}`;
    expect(extractPastedCode(url, state)).toBe('abc123');
  });

  it('extracts the code from a bare query string', () => {
    expect(extractPastedCode(`code=xyz&state=${state}`, state)).toBe('xyz');
  });

  it('rejects a redirect whose state does not match', () => {
    const url = 'http://127.0.0.1:56121/callback?code=abc&state=other';
    expect(() => extractPastedCode(url, state)).toThrow(/state mismatch/);
  });

  it('trims surrounding whitespace from a pasted code', () => {
    expect(extractPastedCode('  code-with-spaces  ', state)).toBe('code-with-spaces');
  });
});

describe('buildXaiAuthorizeUrl', () => {
  it('builds an auth.x.ai authorize URL with PKCE and the xAI client', () => {
    const url = new URL(buildXaiAuthorizeUrl(
      'http://127.0.0.1:56121/callback',
      { codeVerifier: 'v', codeChallenge: 'challenge' },
      'the-state',
      'the-nonce',
    ));
    expect(url.origin + url.pathname).toBe('https://auth.x.ai/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('scope')).toContain('grok-cli:access');
  });
});
