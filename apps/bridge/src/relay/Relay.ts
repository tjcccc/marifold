import {
  identifier,
  MAX_FRAME_BYTES,
  parseHeader,
  randomId,
  record,
  RELAY_RETENTION_MS,
  validMembership,
  verifyText,
} from '@marifold/workspace-protocol';
import type { PublicIdentity, SignedMembership } from '@marifold/workspace-protocol';
import { INBOX_LIMIT } from './RelayStore';
import type { HostRegistration, InboxEntry, RelayStore } from './RelayStore';

export const MAX_SOCKETS = 128;
export const AUTH_TIMEOUT_MS = 10_000;
const FRAMES_PER_SECOND = 512;
/** How long a frame delivered to an online device waits for its ack in memory
 * before it is stored for replay. Most acks arrive well within it, so normal
 * traffic writes nothing; a pending timer also keeps a Durable Object awake. */
export const HOLD_MS = 5000;

export interface AuthState {
  workspace: string;
  device: string;
  identity: PublicIdentity;
  certificate?: SignedMembership;
  hostDevice: string;
}
/** Per-connection state. It must stay serializable: Cloudflare keeps it in the
 * socket attachment, so it survives the Durable Object hibernating. */
export interface ConnectionState {
  nonce: string;
  generation: string;
  openedAt: number;
  closed?: boolean;
  auth?: AuthState;
}
export interface RelayOptions {
  store: RelayStore;
  sockets: () => Iterable<RelaySocket>;
  now?: () => number;
  /** 0 stores every frame immediately. */
  holdMs?: number;
}
interface Held {
  workspace: string;
  device: string;
  packet: string;
  heldAt: number;
}
export interface RelaySocket {
  state: ConnectionState | undefined;
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Bytes queued for sending, when the runtime reports it. */
  readonly bufferedAmount?: number;
}

/**
 * The platform-neutral bridge relay. Adapters own the transport and hand it
 * sockets and frames; everything here is synchronous and keeps no state that
 * correctness depends on outside the store and the socket states, so a
 * Durable Object can be rebuilt between any two frames.
 */
export class Relay {
  // Rate windows are advisory and may reset when a Durable Object is rebuilt.
  private rates = new Map<string, { window: number; count: number }>();
  private held = new Map<string, Held>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  readonly store: RelayStore;
  private readonly sockets: () => Iterable<RelaySocket>;
  private readonly now: () => number;
  private readonly holdMs: number;
  constructor(options: RelayOptions) {
    this.store = options.store;
    this.sockets = options.sockets;
    // Read the clock on each call rather than capturing `Date.now` once.
    this.now = options.now ?? (() => Date.now());
    this.holdMs = options.holdMs ?? HOLD_MS;
  }
  full(): boolean {
    let count = 0;
    for (const _ of this.sockets()) { count++; }
    return count >= MAX_SOCKETS;
  }
  open(socket: RelaySocket): void {
    const state: ConnectionState = { nonce: randomId(), generation: randomId(), openedAt: this.now() };
    socket.state = state;
    socket.send(JSON.stringify({ type: 'challenge', nonce: state.nonce }));
  }
  register(value: unknown): void {
    const b = record(value);
    const host = record(b.host) as unknown as PublicIdentity;
    if (typeof host.signingKey !== 'string' || !host.encryptionKey) { throw new Error('Invalid host identity.'); }
    const registration: HostRegistration = {
      workspaceId: identifier(b.workspaceId),
      hostDeviceId: identifier(b.hostDeviceId),
      host,
    };
    this.store.register(registration);
  }
  message(socket: RelaySocket, data: unknown): void {
    const state = socket.state;
    if (!state || state.closed) { return; }
    try {
      if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES || Buffer.byteLength(data) > MAX_FRAME_BYTES) {
        throw new Error('Invalid frame.');
      }
      const now = this.now();
      const rate = this.rates.get(state.generation) ?? { window: now, count: 0 };
      if (now - rate.window > 1000) {
        rate.window = now;
        rate.count = 0;
      }
      if (++rate.count > FRAMES_PER_SECOND) { throw new Error('Rate limit.'); }
      this.rates.set(state.generation, rate);
      const frame = record(JSON.parse(data));
      if (!state.auth) { this.authenticate(socket, state, frame); }
      else { this.handle(socket, state.auth, frame); }
    } catch {
      this.closeSocket(socket, 1008, 'Bridge request rejected');
    }
  }
  closed(socket: RelaySocket): void {
    const state = socket.state;
    if (!state) { return; }
    this.rates.delete(state.generation);
    const auth = state.auth;
    if (!auth) { return; }
    // A replaced connection's frames were already handed to its successor.
    for (const other of this.connections(auth.workspace, auth.device)) {
      if (other.state?.generation !== state.generation) { return; }
    }
    this.persist((held) => held.workspace === auth.workspace && held.device === auth.device);
  }
  /** Stores every held frame and stops the flush timer, e.g. before the process exits. */
  close(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.persist(() => true);
  }
  /** Closes connections that never authenticated and drops expired frames.
   * Returns when it next needs to run, if any connection is still pending. */
  sweep(): number | undefined {
    const now = this.now();
    let next: number | undefined;
    for (const socket of this.sockets()) {
      const state = socket.state;
      if (!state || state.auth || state.closed) { continue; }
      const deadline = state.openedAt + AUTH_TIMEOUT_MS;
      if (deadline <= now) { this.closeSocket(socket, 1008, 'Authentication timeout'); }
      else { next = Math.min(next ?? deadline, deadline); }
    }
    this.store.purge(now);
    return next;
  }
  private authenticate(socket: RelaySocket, state: ConnectionState, data: Record<string, unknown>): void {
    if (data.type !== 'auth') { throw new Error('Authentication required.'); }
    const workspace = identifier(data.workspaceId);
    const device = identifier(data.deviceId);
    const host = this.store.host(workspace);
    if (!host || this.store.revoked(workspace, device)) { throw new Error('Unknown or revoked workspace membership.'); }
    const certificate = data.certificate as SignedMembership | undefined;
    let identity: PublicIdentity;
    if (certificate) {
      if (
        !validMembership(certificate, host.host) ||
        certificate.membership.workspaceId !== workspace ||
        certificate.membership.deviceId !== device
      ) {
        throw new Error('Invalid membership.');
      }
      identity = certificate.membership.identity;
    } else {
      if (!device.startsWith('pending_')) { throw new Error('Invalid pairing identity.'); }
      identity = data.identity as PublicIdentity;
    }
    if (!verifyText(identity, state.nonce, String(data.signature))) { throw new Error('Invalid proof of possession.'); }
    // One connection per device: a newer one replaces the older.
    for (const other of this.connections(workspace, device)) {
      this.closeSocket(other, 1008, 'Membership or connection replaced');
    }
    socket.state = { ...state, auth: { workspace, device, identity, certificate, hostDevice: host.hostDeviceId } };
    socket.send(JSON.stringify({ type: 'ready', hostDeviceId: host.hostDeviceId, deliveryReplay: 'on-reconnect' }));
    // Frames stay stored until acknowledged, so a reconnect replays whatever
    // the previous connection did not confirm.
    this.persist((held) => held.workspace === workspace && held.device === device);
    for (const entry of this.store.pending(workspace, device, this.now())) { this.deliver(socket, entry); }
  }
  private handle(socket: RelaySocket, auth: AuthState, data: Record<string, unknown>): void {
    if (data.type === 'ping') {
      socket.send('{"type":"pong"}');
      return;
    }
    if (data.type === 'ack') {
      if (typeof data.deliveryId !== 'string' || data.deliveryId.length > 100) { throw new Error('Invalid acknowledgment.'); }
      const held = this.held.get(data.deliveryId);
      if (held?.workspace === auth.workspace && held.device === auth.device) { this.held.delete(data.deliveryId); }
      else { this.store.ack(auth.workspace, auth.device, data.deliveryId); }
      return;
    }
    if (data.type === 'revoke' && auth.device === auth.hostDevice) {
      const device = identifier(data.deviceId);
      const id = identifier(data.id);
      this.store.revoke(auth.workspace, device);
      // Confirm first: a host leaving its own workspace revokes this very connection.
      socket.send(JSON.stringify({ type: 'revoked', id }));
      for (const other of this.connections(auth.workspace, device)) { this.closeSocket(other, 1008, 'Membership revoked'); }
      return;
    }
    if (data.type !== 'send') { throw new Error('Unknown message.'); }
    const message = record(data.message);
    const h = parseHeader(message.header);
    if (
      h.workspaceId !== auth.workspace ||
      h.sender !== auth.device ||
      (auth.device !== auth.hostDevice && h.recipient !== auth.hostDevice)
    ) {
      throw new Error('Routing denied.');
    }
    const now = this.now();
    if (h.expiresAt < now || h.expiresAt > now + 65000) { throw new Error('Message expired.'); }
    if (this.store.revoked(auth.workspace, h.recipient)) { return; }
    if (this.inboxSize(auth.workspace, h.recipient, now) >= INBOX_LIMIT) {
      // Backpressure, not a refusal: 1008 would read as a revoked membership.
      this.closeSocket(socket, 1013, 'Recipient inbox is full');
      return;
    }
    const entry: InboxEntry = {
      id: randomId().slice(0, 16),
      packet: JSON.stringify({ message, identity: auth.identity, certificate: auth.certificate }),
    };
    const recipients = [...this.connections(auth.workspace, h.recipient)];
    if (recipients.length && this.holdMs > 0) {
      this.held.set(entry.id, { workspace: auth.workspace, device: h.recipient, packet: entry.packet, heldAt: now });
      this.scheduleFlush();
    } else {
      this.store.insert(entry.id, auth.workspace, h.recipient, entry.packet, now + RELAY_RETENTION_MS);
    }
    for (const recipient of recipients) { this.deliver(recipient, entry); }
  }
  private inboxSize(workspace: string, device: string, now: number): number {
    let size = this.store.count(workspace, device, now);
    for (const held of this.held.values()) { if (held.workspace === workspace && held.device === device) { size++; } }
    return size;
  }
  private persist(match: (held: Held) => boolean): void {
    for (const [id, held] of this.held) {
      if (!match(held)) { continue; }
      this.held.delete(id);
      this.store.insert(id, held.workspace, held.device, held.packet, held.heldAt + RELAY_RETENTION_MS);
    }
  }
  private scheduleFlush(): void {
    if (this.flushTimer) { return; }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const due = this.now() - this.holdMs;
      this.persist((held) => held.heldAt <= due);
      if (this.held.size) { this.scheduleFlush(); }
    }, this.holdMs);
    // Node: held frames must not keep a stopping process alive.
    (this.flushTimer as { unref?: () => void }).unref?.();
  }
  private deliver(socket: RelaySocket, entry: InboxEntry): void {
    if ((socket.bufferedAmount ?? 0) > MAX_FRAME_BYTES * 8) {
      this.closeSocket(socket, 1013, 'Slow consumer');
      return;
    }
    // The stored packet is already JSON; splice it in instead of re-encoding.
    socket.send(`{"type":"delivery","deliveryId":${JSON.stringify(entry.id)},"packet":${entry.packet}}`);
  }
  private *connections(workspace: string, device: string): Generator<RelaySocket> {
    for (const socket of this.sockets()) {
      const auth = socket.state?.auth;
      if (!socket.state?.closed && auth?.workspace === workspace && auth.device === device) { yield socket; }
    }
  }
  private closeSocket(socket: RelaySocket, code: number, reason: string): void {
    const state = socket.state;
    if (!state || state.closed) { return; }
    socket.state = { ...state, closed: true };
    this.rates.delete(state.generation);
    socket.close(code, reason);
  }
}
