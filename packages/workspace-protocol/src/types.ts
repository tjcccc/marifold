export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 256 * 1024;
export const INVITATION_TTL_MS = 15 * 60_000;
export const MESSAGE_TTL_MS = 60_000;
export const RELAY_RETENTION_MS = 5 * 60_000;

export interface PublicIdentity {
  signingKey: string;
  encryptionKey: JsonWebKey;
}
export interface PrivateIdentity extends PublicIdentity {
  signingPrivateKey: string;
  encryptionPrivateKey: JsonWebKey;
}
export interface Membership {
  version: 1;
  workspaceId: string;
  deviceId: string;
  name: string;
  identity: PublicIdentity;
  host: PublicIdentity;
  issuedAt: number;
}
export interface SignedMembership {
  membership: Membership;
  signature: string;
}
export interface Invitation {
  version: 1;
  appVersion?: string;
  workspaceId: string;
  bridgeUrl: string;
  host: PublicIdentity;
  secret: string;
  expiresAt: number;
}
export interface WorkspaceDevice {
  id: string;
  name: string;
  /** Membership enrollment time in Unix milliseconds; absent on older hosts. */
  joinedAt?: number;
  platform: string;
  architecture: string;
  executor: boolean;
  online: boolean;
}
export interface WorkspaceSummary {
  executor?: boolean;
  id: string;
  name: string;
  role: 'host' | 'guest';
  bridgeUrl: string;
  deviceId: string;
  hostDeviceId: string;
  online: boolean;
  versionError?: string;
}
export interface WorkspaceExecutionContext {
  workspaceId: string;
  originDeviceId: string;
  executionDeviceId: string;
}
export interface MessageHeader {
  version: 1;
  workspaceId: string;
  sender: string;
  recipient: string;
  id: string;
  expiresAt: number;
}
export interface EncryptedMessage {
  header: MessageHeader;
  encapsulatedKey: string;
  ciphertext: string;
  signature: string;
}
export interface WorkspaceRequest {
  type: 'request';
  id: string;
  operation: string;
  input: unknown;
  appVersion?: string;
}
export interface WorkspaceResponse {
  type: 'response';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}
export interface WorkspaceEvent {
  type: 'event';
  topic: string;
  value: unknown;
}
export type WorkspaceMessage = WorkspaceRequest | WorkspaceResponse | WorkspaceEvent;

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid identifier.');
  return value;
}
export function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Invalid display name.');
  return value.trim();
}
export function bridgeOrigin(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Bridge URL must be an origin without credentials.');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Bridge requires HTTPS (HTTP is allowed only on loopback).');
  return url.origin;
}
export function parseHeader(value: unknown): MessageHeader {
  const h = record(value);
  if (h.version !== 1 || typeof h.expiresAt !== 'number' || !Number.isSafeInteger(h.expiresAt))
    throw new Error('Invalid message header.');
  return {
    version: 1,
    workspaceId: identifier(h.workspaceId),
    sender: identifier(h.sender),
    recipient: identifier(h.recipient),
    id: identifier(h.id),
    expiresAt: h.expiresAt,
  };
}
export function headerBytes(h: MessageHeader): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([h.version, h.workspaceId, h.sender, h.recipient, h.id, h.expiresAt]));
}
