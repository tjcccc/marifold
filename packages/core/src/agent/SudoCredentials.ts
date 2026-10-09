import { constants, createHash, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomUUID, type KeyObject } from 'node:crypto';
import * as os from 'node:os';

export interface SudoChallenge {
  id: string;
  publicKey: string;
  expiresAt: number;
  device: string;
  account: string;
}
export interface SudoResponse { id: string; ciphertext: string }

export function parseSudoResponse(value: unknown): SudoResponse {
  const v = value as Partial<SudoResponse> | undefined;
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => k !== 'id' && k !== 'ciphertext') ||
      typeof v.id !== 'string' || !/^[a-f0-9-]{36}$/.test(v.id) ||
      typeof v.ciphertext !== 'string' || !/^[A-Za-z0-9+/]{342}==$/.test(v.ciphertext)) {
    throw new Error('Invalid encrypted sudo authorization.');
  }
  return { id: v.id, ciphertext: v.ciphertext };
}

export function encryptSudoPassword(challenge: SudoChallenge, password: string): SudoResponse {
  const bytes = Buffer.from(password, 'utf8');
  try {
    validateSudoPassword(bytes);
    if (challenge.expiresAt <= Date.now()) { throw new Error('Sudo authorization expired.'); }
    return { id: challenge.id, ciphertext: publicEncrypt({
      key: createPublicKey({ key: Buffer.from(challenge.publicKey, 'base64'), format: 'der', type: 'spki' }),
      padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(challenge.id),
    }, bytes).toString('base64') };
  } finally { bytes.fill(0); }
}

export function validateSudoPassword(password: Buffer): void {
  if (!password.length || password.length > 128 || password.includes(0) || password.includes(10) || password.includes(13)) {
    throw new Error('Password must contain 1–128 UTF-8 bytes and no NUL or line breaks.');
  }
}

/** Only the execution device holds these ephemeral private keys. No secrets or
 * private keys are written to journals, job files, events, or model inputs. */
export class SudoCredentials {
  private entries = new Map<string, { key: KeyObject; hash: string; expiresAt: number; timer: NodeJS.Timeout }>();
  create(command: string): SudoChallenge {
    if (this.entries.size >= 128) { throw new Error('Too many pending sudo authorizations.'); }
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const id = randomUUID();
    const expiresAt = Date.now() + 5 * 60_000;
    const timer = setTimeout(() => this.entries.delete(id), 5 * 60_000);
    timer.unref();
    this.entries.set(id, { key: privateKey, hash: this.hash(command), expiresAt, timer });
    return { id, expiresAt, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      device: os.hostname(), account: os.userInfo().username };
  }
  consume(command: string, response: SudoResponse): Buffer {
    const input = parseSudoResponse(response);
    const entry = this.entries.get(input.id);
    this.entries.delete(input.id);
    if (entry) { clearTimeout(entry.timer); }
    if (!entry || entry.expiresAt <= Date.now() || entry.hash !== this.hash(command)) { throw new Error('Sudo authorization expired, was consumed, or belongs to another command.'); }
    let password: Buffer;
    try {
      password = privateDecrypt({ key: entry.key, padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256', oaepLabel: Buffer.from(input.id) }, Buffer.from(input.ciphertext, 'base64'));
    } catch { throw new Error('Could not decrypt sudo authorization on this device.'); }
    try { validateSudoPassword(password); } catch (error) { password.fill(0); throw error; }
    return password;
  }
  private hash(command: string): string { return createHash('sha256').update(command).digest('hex'); }
}
