import { describe, expect, it } from 'vitest';
import { accountIdFromIdToken } from '../src/util/idToken';

/** Build a JWT-shaped string (header.payload.signature) with the given payload.
 * Signature is irrelevant — accountIdFromIdToken never verifies it. */
function jwt(payload: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'RS256' })}.${seg(payload)}.sig`;
}

describe('accountIdFromIdToken', () => {
  it('reads chatgpt_account_id from the OpenAI auth claim', () => {
    const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_abc123', chatgpt_plan_type: 'plus' } });
    expect(accountIdFromIdToken(token)).toBe('acct_abc123');
  });

  it('returns undefined when the account id is absent (e.g. org-less claim)', () => {
    expect(accountIdFromIdToken(jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }))).toBeUndefined();
    expect(accountIdFromIdToken(jwt({ email: 'a@b.c' }))).toBeUndefined();
  });

  it('returns undefined for a malformed token', () => {
    expect(accountIdFromIdToken('not-a-jwt')).toBeUndefined();
    expect(accountIdFromIdToken('a.b')).toBeUndefined();
    expect(accountIdFromIdToken('a.!!!notbase64json!!!.c')).toBeUndefined();
  });
});
