import type { SudoChallenge, SudoResponse } from '../api/types';

/** Encrypt in the requesting browser before any HTTP request or state dispatch. */
export async function encryptSudoPassword(challenge: SudoChallenge, password: string): Promise<SudoResponse> {
  if (!globalThis.crypto?.subtle) { throw new Error('Secure password entry requires HTTPS or localhost.'); }
  const bytes = new TextEncoder().encode(password);
  try {
    if (!bytes.length || bytes.length > 128 || bytes.includes(0) || bytes.includes(10) || bytes.includes(13)) {
      throw new Error('Password must contain 1–128 UTF-8 bytes with no line breaks.');
    }
    if (challenge.expiresAt <= Date.now()) { throw new Error('This authorization expired.'); }
    const der = Uint8Array.from(atob(challenge.publicKey), char => char.charCodeAt(0));
    const key = await crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode(challenge.id) }, key, bytes);
    return { id: challenge.id, ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))) };
  } finally { bytes.fill(0); }
}
