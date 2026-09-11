import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { CipherSuite, Aes256Gcm, HkdfSha256, DhkemP256HkdfSha256 } from '@hpke/core';
import { headerBytes, parseHeader, MAX_FRAME_BYTES, MESSAGE_TTL_MS } from './types';
import type {
  EncryptedMessage,
  MessageHeader,
  Membership,
  PrivateIdentity,
  PublicIdentity,
  SignedMembership,
} from './types';

const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const encoder = new TextEncoder();
export function randomId(): string {
  return randomBytes(16).toString('hex');
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function publicIdentity(identity: PrivateIdentity): PublicIdentity {
  return { signingKey: identity.signingKey, encryptionKey: identity.encryptionKey };
}
export async function createIdentity(): Promise<PrivateIdentity> {
  const keys = generateKeyPairSync('ed25519');
  const encryption = await suite.kem.generateKeyPair();
  return {
    signingKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    signingPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    encryptionKey: await crypto.subtle.exportKey('jwk', encryption.publicKey),
    encryptionPrivateKey: await crypto.subtle.exportKey('jwk', encryption.privateKey),
  };
}
export function signText(identity: PrivateIdentity, text: string): string {
  return sign(
    null,
    Buffer.from(text),
    createPrivateKey({ key: Buffer.from(identity.signingPrivateKey, 'base64'), type: 'pkcs8', format: 'der' }),
  ).toString('base64');
}
export function verifyText(identity: PublicIdentity, text: string, signature: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(text),
      createPublicKey({ key: Buffer.from(identity.signingKey, 'base64'), type: 'spki', format: 'der' }),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}
export function issueMembership(host: PrivateIdentity, membership: Membership): SignedMembership {
  return { membership, signature: signText(host, JSON.stringify(membership)) };
}
export function validMembership(certificate: SignedMembership, host: PublicIdentity): boolean {
  return (
    certificate.membership.version === 1 &&
    certificate.membership.host.signingKey === host.signingKey &&
    verifyText(host, JSON.stringify(certificate.membership), certificate.signature)
  );
}
export async function encryptMessage(
  identity: PrivateIdentity,
  recipient: PublicIdentity,
  header: MessageHeader,
  value: unknown,
): Promise<EncryptedMessage> {
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.length > MAX_FRAME_BYTES / 2) throw new Error('Message exceeds frame limit; use bounded transfers.');
  const key = await suite.kem.importKey('jwk', recipient.encryptionKey, true);
  const context = await suite.createSenderContext({
    recipientPublicKey: key,
    info: encoder.encode('marifold.workspace.v1'),
  });
  const ciphertext = Buffer.from(await context.seal(plaintext, headerBytes(header))).toString('base64');
  const encapsulatedKey = Buffer.from(context.enc).toString('base64');
  return {
    header,
    encapsulatedKey,
    ciphertext,
    signature: signText(identity, JSON.stringify([header, encapsulatedKey, ciphertext])),
  };
}
export async function decryptMessage(
  identity: PrivateIdentity,
  sender: PublicIdentity,
  message: EncryptedMessage,
  expected: { workspaceId: string; recipient: string },
): Promise<unknown> {
  if (Buffer.byteLength(JSON.stringify(message)) > MAX_FRAME_BYTES) throw new Error('Frame too large.');
  const header = parseHeader(message.header);
  if (header.workspaceId !== expected.workspaceId || header.recipient !== expected.recipient)
    throw new Error('Message belongs to a different workspace or device.');
  if (header.expiresAt < Date.now() || header.expiresAt > Date.now() + MESSAGE_TTL_MS + 5000)
    throw new Error('Message expired or has an invalid lifetime.');
  if (
    !verifyText(
      sender,
      JSON.stringify([message.header, message.encapsulatedKey, message.ciphertext]),
      message.signature,
    )
  )
    throw new Error('Invalid message signature.');
  const key = await suite.kem.importKey('jwk', identity.encryptionPrivateKey, false);
  const context = await suite.createRecipientContext({
    recipientKey: key,
    enc: Buffer.from(message.encapsulatedKey, 'base64'),
    info: encoder.encode('marifold.workspace.v1'),
  });
  const plaintext = await context.open(Buffer.from(message.ciphertext, 'base64'), headerBytes(header));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
