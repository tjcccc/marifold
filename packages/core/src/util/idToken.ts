/**
 * Read `chatgpt_account_id` from an OpenAI id_token's `https://api.openai.com/auth`
 * claim. Decodes the JWT payload locally (no signature check — we only read a
 * claim from a token we already obtained over TLS from our own exchange).
 * Returns undefined when the token is malformed or the claim is absent.
 *
 * Subscription (ChatGPT plan) accounts carry no platform organization, so this
 * account id — not a platform API key — is what authorizes Codex-backend calls
 * (sent as the `chatgpt-account-id` header alongside the OAuth access token).
 */
export function accountIdFromIdToken(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const auth = payload['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object') {
      const id = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof id === 'string' && id) return id;
    }
  } catch {
    // Malformed token — treat as no account id.
  }
  return undefined;
}
