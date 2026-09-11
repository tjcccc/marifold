import WebSocket from 'ws';
import { ChunkTransfers } from './ChunkTransfers';
import {
  decryptMessage,
  digest,
  encryptMessage,
  MESSAGE_TTL_MS,
  publicIdentity,
  randomId,
  record,
  signText,
  validMembership,
} from '@marifold/workspace-protocol';
import type {
  EncryptedMessage,
  PrivateIdentity,
  PublicIdentity,
  SignedMembership,
  WorkspaceMessage,
  WorkspaceRequest,
  WorkspaceResponse,
} from '@marifold/workspace-protocol';

export interface PeerOptions {
  bridgeUrl: string;
  workspaceId: string;
  deviceId: string;
  hostDeviceId?: string;
  identity: PrivateIdentity;
  host: PublicIdentity;
  certificate?: SignedMembership;
  accept?: (certificate: SignedMembership) => boolean;
  onRequest: (
    request: WorkspaceRequest,
    sender: { id: string; identity: PublicIdentity; certificate?: SignedMembership },
  ) => Promise<unknown>;
  onStatus?: (online: boolean) => void;
}
interface Pending {
  request: WorkspaceRequest;
  recipient: string;
  identity: PublicIdentity;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class BridgePeer {
  private socket?: WebSocket;
  private stopped = false;
  private connected = false;
  private retry?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private retryMs = 1000;
  private pending = new Map<string, Pending>();
  private controls = new Map<string, { resolve: () => void; reject: () => void }>();
  private seen = new Map<string, number>();
  private transfers = new ChunkTransfers();
  private inflight = new Map<string, { hash: string; job: Promise<unknown> }>();
  private lastPong = Date.now();
  private hostDeviceId?: string;
  constructor(private readonly options: PeerOptions) {
    this.hostDeviceId = options.hostDeviceId;
  }
  get online(): boolean {
    return this.connected;
  }
  get hostId(): string {
    if (!this.hostDeviceId) throw new Error('Bridge is not connected.');
    return this.hostDeviceId;
  }
  start(): void {
    this.stopped = false;
    this.connect();
  }
  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.socket?.close();
    this.connected = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Workspace connection closed.'));
    }
    this.pending.clear();
    this.transfers.reset();
    for (const control of this.controls.values()) control.reject();
    this.controls.clear();
  }
  async ready(timeoutMs = 10000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!this.connected && !this.stopped && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    if (!this.connected) throw new Error('Workspace bridge is unavailable.');
  }
  request(
    operation: string,
    input: unknown,
    recipient = this.hostId,
    identity = this.options.host,
    id = randomId(),
    timeoutMs = 120000,
  ): Promise<unknown> {
    if (this.pending.has(id)) return Promise.reject(new Error('Request is already awaiting a response.'));
    if (!this.connected) return Promise.reject(new Error('Workspace is offline.'));
    if (this.pending.size >= 32) return Promise.reject(new Error('Too many pending workspace operations.'));
    if (Buffer.byteLength(JSON.stringify(input ?? null)) > 29 * 1024 * 1024)
      return Promise.reject(new Error('Workspace request exceeds the transfer limit.'));
    return new Promise((resolve, reject) => {
      const request: WorkspaceRequest = { type: 'request', id, operation, input };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error('Workspace request timed out. Its outcome may be unknown; it was not repeated under a new ID.'),
        );
      }, timeoutMs);
      this.pending.set(id, { request, recipient, identity, resolve, reject, timer });
      void this.transmit(recipient, identity, request).catch(() => {
        /* reconnect resends with the same operation id */
      });
    });
  }
  revoke(deviceId: string): Promise<void> {
    if (!this.connected)
      return Promise.reject(new Error('Bridge unavailable; revocation will be sent after reconnect.'));
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(new Error('Bridge revocation was not acknowledged.'));
      }, 5000);
      this.controls.set(id, {
        resolve: () => {
          clearTimeout(timer);
          this.controls.delete(id);
          resolve();
        },
        reject: () => {
          clearTimeout(timer);
          reject(new Error('Bridge disconnected.'));
        },
      });
      this.socket!.send(JSON.stringify({ type: 'revoke', deviceId, id }));
    });
  }
  private connect(): void {
    if (this.stopped) return;
    const url = new URL('/v1/connect', this.options.bridgeUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { maxPayload: 512 * 1024, perMessageDeflate: false });
    this.socket = socket;
    socket.on('message', (bytes) => {
      try {
        void this.receive(JSON.parse(bytes.toString())).catch(() => {
          /* invalid peer frames never reach dispatch */
        });
      } catch {
        socket.close(1008, 'Invalid frame');
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.transfers.reset();
      this.options.onStatus?.(false);
      clearInterval(this.ping);
      if (!this.stopped) {
        this.retry = setTimeout(() => this.connect(), this.retryMs + Math.random() * 500);
        this.retryMs = Math.min(this.retryMs * 2, 15000);
      }
    });
  }
  private async receive(value: unknown): Promise<void> {
    const frame = record(value);
    if (frame.type === 'challenge') {
      this.socket?.send(
        JSON.stringify({
          type: 'auth',
          workspaceId: this.options.workspaceId,
          deviceId: this.options.deviceId,
          certificate: this.options.certificate,
          identity: publicIdentity(this.options.identity),
          signature: signText(this.options.identity, String(frame.nonce)),
        }),
      );
      return;
    }
    if (frame.type === 'ready') {
      this.hostDeviceId = String(frame.hostDeviceId);
      if (this.options.hostDeviceId && this.hostDeviceId !== this.options.hostDeviceId) {
        this.close();
        throw new Error('Host identity changed.');
      }
      this.lastPong = Date.now();
      this.connected = true;
      this.retryMs = 1000;
      this.options.onStatus?.(true);
      this.ping = setInterval(() => {
        if (Date.now() - this.lastPong > 45000) {
          this.socket?.terminate();
          return;
        }
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send('{"type":"ping"}');
      }, 15000);
      for (const p of this.pending.values())
        void this.transmit(p.recipient, p.identity, p.request).catch(() => undefined);
      return;
    }
    if (frame.type === 'revoked') {
      this.controls.get(String(frame.id))?.resolve();
      return;
    }
    if (frame.type === 'pong') {
      this.lastPong = Date.now();
      return;
    }
    if (frame.type !== 'delivery') return;
    // Acknowledging transport receipt does not assert successful execution. The
    // sender retains stable request IDs until it receives an application reply.
    this.socket?.send(JSON.stringify({ type: 'ack', deliveryId: frame.deliveryId }));
    const packet = record(frame.packet);
    const message = packet.message as EncryptedMessage;
    const sender = message.header.sender;
    const certificate = packet.certificate as SignedMembership | undefined;
    let identity: PublicIdentity;
    if (sender === this.hostDeviceId) identity = this.options.host;
    else if (certificate) {
      if (
        !validMembership(certificate, this.options.host) ||
        certificate.membership.workspaceId !== this.options.workspaceId ||
        certificate.membership.deviceId !== sender ||
        this.options.accept?.(certificate) === false
      )
        throw new Error('Invalid or revoked sender.');
      identity = certificate.membership.identity;
    } else {
      if (this.options.deviceId !== this.hostDeviceId || !sender.startsWith('pending_'))
        throw new Error('Unpaired sender.');
      identity = packet.identity as PublicIdentity;
    }
    const decoded = record(
      await decryptMessage(this.options.identity, identity, message, {
        workspaceId: this.options.workspaceId,
        recipient: this.options.deviceId,
      }),
    );
    if (
      !certificate &&
      sender !== this.hostDeviceId &&
      (decoded.type !== 'request' || decoded.operation !== 'join' || JSON.stringify(decoded).length > 4096)
    )
      throw new Error('Invalid pairing message.');
    for (const [id, expiry] of this.seen) if (expiry < Date.now()) this.seen.delete(id);
    if (this.seen.has(message.header.id)) return;
    this.seen.set(message.header.id, message.header.expiresAt);

    if (decoded.type === 'chunk_ack') {
      this.transfers.acknowledge(sender, decoded);
      return;
    }
    if (decoded.type === 'chunk') {
      const { ack, text } = this.transfers.receive(sender, decoded);
      await this.send(sender, identity, ack);
      if (text !== undefined) await this.dispatch(record(JSON.parse(text)), sender, identity, certificate);
      return;
    }
    await this.dispatch(decoded, sender, identity, certificate);
  }
  private async dispatch(
    data: Record<string, unknown>,
    sender: string,
    identity: PublicIdentity,
    certificate?: SignedMembership,
  ): Promise<void> {
    if (data.type === 'response') {
      const pending = this.pending.get(String(data.id));
      if (!pending || pending.recipient !== sender) return;
      this.pending.delete(String(data.id));
      clearTimeout(pending.timer);
      if (data.ok === true) pending.resolve(data.value);
      else pending.reject(new Error(typeof data.error === 'string' ? data.error : 'Workspace operation failed.'));
      return;
    }
    if (data.type !== 'request' || typeof data.id !== 'string' || typeof data.operation !== 'string') return;
    if (!certificate && sender !== this.hostDeviceId && data.operation !== 'join') throw new Error('Pairing required.');
    const request = data as unknown as WorkspaceRequest;
    const key = `${sender}:${request.id}`;
    const hash = digest(JSON.stringify(request));
    let entry = this.inflight.get(key);
    if (entry && entry.hash !== hash) throw new Error('Request ID was reused with different input.');
    if (!entry) {
      if (this.inflight.size >= 64) throw new Error('Too many in-flight requests.');
      const job = this.options.onRequest(request, { id: sender, identity, certificate });
      entry = { hash, job };
      this.inflight.set(key, entry);
      void job.finally(() => this.inflight.delete(key)).catch(() => undefined);
    }
    let response: WorkspaceResponse;
    try {
      response = { type: 'response', id: request.id, ok: true, value: await entry.job };
    } catch (error) {
      response = {
        type: 'response',
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Workspace operation failed.',
      };
    }
    await this.transmit(sender, identity, response);
  }
  private async transmit(recipient: string, identity: PublicIdentity, value: WorkspaceMessage): Promise<void> {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) < 64000) {
      await this.send(recipient, identity, value);
      return;
    }
    await this.transfers.transmit(recipient, text, chunk => this.send(recipient, identity, chunk));
  }
  private async send(recipient: string, identity: PublicIdentity, value: unknown): Promise<void> {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Workspace disconnected.');
    const socket = this.socket;
    const message = await encryptMessage(
      this.options.identity,
      identity,
      {
        version: 1,
        workspaceId: this.options.workspaceId,
        sender: this.options.deviceId,
        recipient,
        id: randomId(),
        expiresAt: Date.now() + MESSAGE_TTL_MS,
      },
      value,
    );
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('Workspace disconnected.');
    socket.send(JSON.stringify({ type: 'send', message }));
  }
}
