import { MarifoldError } from '../errors/MarifoldError';
import * as os from 'node:os';
import {
  bridgeOrigin,
  createIdentity,
  identifier,
  publicIdentity,
  randomId,
  record,
  validMembership,
} from '@marifold/workspace-protocol';
import type {
  Invitation,
  SignedMembership,
  WorkspaceSummary,
  WorkspaceRequest,
  PublicIdentity,
} from '@marifold/workspace-protocol';
import { WorkspaceStore, WorkspaceConnection } from './WorkspaceStore';
import { BridgePeer } from './bridge/BridgePeer';

export interface WorkspaceOperationContext {
  workspaceId: string;
  senderDeviceId: string;
  hostDeviceId: string;
}
export class WorkspaceManager {
  readonly store: WorkspaceStore;
  private peers = new Map<string, BridgePeer>();
  private hostStatus = new Map<string, boolean>();
  private presence = new Map<string, { seen: number; platform: string; architecture: string; executor: boolean }>();
  onMembershipRemoved?: (workspaceId: string, deviceId?: string) => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private remoteHandler?: (operation: string, input: unknown, context: WorkspaceOperationContext) => Promise<unknown>;
  private executorHandler?: (operation: string, input: unknown, context: WorkspaceOperationContext) => Promise<unknown>;
  constructor(configPath: string) {
    this.store = new WorkspaceStore(configPath);
  }
  start(handler: NonNullable<WorkspaceManager['remoteHandler']>, executor?: WorkspaceManager['executorHandler']): void {
    this.remoteHandler = handler;
    this.executorHandler = executor;
    this.store.interruptRequests();
    for (const c of this.store.list()) this.connect(c);
    this.heartbeat = setInterval(() => {
      for (const c of this.store.list()) if (c.role === 'guest') void this.checkHost(c);
    }, 15000);
  }
  close(): void {
    clearInterval(this.heartbeat);
    for (const peer of this.peers.values()) peer.close();
    this.store.close();
  }
  list(): WorkspaceSummary[] {
    return this.store
      .list()
      .map(({ id, name, role, bridgeUrl, deviceId, hostDeviceId, executor }) => ({
        id,
        name,
        role,
        bridgeUrl,
        deviceId,
        hostDeviceId,
        executor,
        online: role === 'host' ? Boolean(this.peers.get(id)?.online) : this.hostStatus.get(id) === true,
      }));
  }
  async create(
    name: string,
    url: string,
    registrationToken: string,
  ): Promise<{ workspace: WorkspaceSummary; invitation: string }> {
    const c = await this.store.create(name, url, os.hostname());
    try {
      const response = await fetch(`${c.bridgeUrl}/v1/hosts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${registrationToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: c.id, hostDeviceId: c.hostDeviceId, host: c.host }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Bridge registration failed (HTTP ${response.status}).`);
      const peer = this.connect(c);
      await peer.ready();
      return { workspace: this.list().find((w) => w.id === c.id)!, invitation: this.store.invite(c.id) };
    } catch (error) {
      this.peers.get(c.id)?.close();
      this.peers.delete(c.id);
      this.store.remove(c.id);
      throw error;
    }
  }
  async add(url: string, token: string, executor = false): Promise<WorkspaceSummary> {
    if (token.length > 16384) throw new Error('Invalid invitation.');
    const invitation = record(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))) as unknown as Invitation;
    if (
      invitation.version !== 1 ||
      invitation.expiresAt < Date.now() ||
      bridgeOrigin(url) !== invitation.bridgeUrl ||
      typeof invitation.secret !== 'string'
    )
      throw new Error('Invitation expired or belongs to a different bridge.');
    const workspaceId = identifier(invitation.workspaceId);
    if (this.store.list().some((c) => c.id === workspaceId)) throw new Error('Workspace already connected.');
    const identity = await createIdentity();
    const pendingId = `pending_${randomId()}`;
    const temporary = new BridgePeer({
      bridgeUrl: invitation.bridgeUrl,
      workspaceId,
      deviceId: pendingId,
      identity,
      host: invitation.host,
      onRequest: async () => {
        throw new Error('Pairing is not an execution connection.');
      },
    });
    temporary.start();
    try {
      await temporary.ready();
      const reply = record(await temporary.request('join', { secret: invitation.secret, name: os.hostname() }));
      const certificate = reply.certificate as SignedMembership;
      if (
        !validMembership(certificate, invitation.host) ||
        certificate.membership.workspaceId !== workspaceId ||
        JSON.stringify(certificate.membership.identity) !== JSON.stringify(publicIdentity(identity))
      )
        throw new Error('Host returned invalid membership.');
      const c: WorkspaceConnection = {
        id: workspaceId,
        name: String(reply.name),
        role: 'guest',
        bridgeUrl: invitation.bridgeUrl,
        hostDeviceId: temporary.hostId,
        deviceId: certificate.membership.deviceId,
        identity,
        host: invitation.host,
        certificate,
        executor,
      };
      this.store.save(c);
      const peer = this.connect(c);
      await peer.ready();
      await this.checkHost(c);
      return this.list().find((w) => w.id === c.id)!;
    } finally {
      temporary.close();
    }
  }
  devices(id: string) {
    const c = this.store.get(id);
    return this.store
      .devices(c.id)
      .filter((d) => !d.revoked)
      .map((d) => {
        const m = d.certificate.membership;
        const host = m.deviceId === c.hostDeviceId;
        const p = this.presence.get(`${c.id}:${m.deviceId}`);
        return {
          id: m.deviceId,
          name: m.name,
          joinedAt: m.issuedAt,
          host,
          platform: host ? os.platform() : (p?.platform ?? ''),
          architecture: host ? os.arch() : (p?.architecture ?? ''),
          executor: host || p?.executor === true,
          online: host || Boolean(p && Date.now() - p.seen < 35000),
        };
      });
  }
  async request(id: string, operation: string, input: unknown, requestId = randomId()): Promise<unknown> {
    const c = this.store.get(id);
    if (c.role === 'host')
      return this.dispatch(
        c,
        { type: 'request', operation, input, id: requestId },
        { id: c.deviceId, identity: c.host, certificate: c.certificate },
      );
    const peer = this.peers.get(c.id);
    if (!peer?.online || this.hostStatus.get(c.id) !== true)
      throw new MarifoldError('WORKSPACE_OFFLINE', 'Workspace host is offline.');
    const read =
      ['devices', 'run.events', 'artifact.read'].includes(operation) ||
      (operation === 'api' && record(input).method === 'GET');
    let result: unknown;
    try {
      result = await peer.request(operation, input, c.hostDeviceId, c.host, requestId, read ? 60000 : 120000);
    } catch (error) {
      if (
        !peer.online ||
        this.hostStatus.get(c.id) !== true
      )
        throw new MarifoldError('WORKSPACE_OFFLINE', 'Workspace host is unavailable.');
      if (read && error instanceof Error && error.message.includes('timed out'))
        throw new MarifoldError('WORKSPACE_TIMEOUT', 'Workspace request timed out while the bridge remained connected.');
      throw error;
    }
    if (operation === 'rename' && typeof record(result).name === 'string')
      this.store.rename(c.id, String(record(result).name));
    return result;
  }
  async execute(
    id: string,
    device: string,
    operation: string,
    input: unknown,
    requestId = randomId(),
  ): Promise<unknown> {
    const c = this.store.get(id);
    if (c.role !== 'host') throw new Error('Only the workspace host coordinates execution.');
    const member = this.store.devices(c.id).find((d) => d.certificate.membership.deviceId === device && !d.revoked);
    if (!member) throw new Error('Execution device is not a workspace member.');
    const peer = this.peers.get(c.id);
    if (!peer?.online) throw new MarifoldError('WORKSPACE_OFFLINE', 'Execution device is unavailable.');
    return peer.request(
      operation,
      input,
      device,
      member.certificate.membership.identity,
      requestId,
      120000,
    );
  }
  async remove(id: string): Promise<void> {
    const c = this.store.get(id);
    this.onMembershipRemoved?.(c.id);
    if (c.role === 'host') {
      const peer = this.peers.get(c.id);
      if (peer?.online) {
        for (const d of this.store.devices(c.id))
          if (d.certificate.membership.deviceId !== c.deviceId) await peer.revoke(d.certificate.membership.deviceId);
        await peer.revoke(c.deviceId);
      }
    } else if (this.peers.get(c.id)?.online) {
      // Leaving locally must remain available even when the host disappears.
      try {
        await this.peers.get(c.id)!.request('leave', {}, c.hostDeviceId, c.host, randomId(), 3000);
      } catch {
        /* Host can revoke an offline former device separately. */
      }
    }
    this.peers.get(c.id)?.close();
    this.peers.delete(c.id);
    this.hostStatus.delete(c.id);
    this.store.remove(c.id);
  }
  async setExecutor(id: string, enabled: boolean): Promise<void> {
    const connection = this.store.get(id);
    if (connection.role !== 'guest') throw new Error('The workspace host always executes its local tools.');
    this.store.save({ ...connection, executor: enabled });
    await this.checkHost(this.store.get(connection.id));
  }
  private connect(c: WorkspaceConnection): BridgePeer {
    this.peers.get(c.id)?.close();
    const peer = new BridgePeer({
      bridgeUrl: c.bridgeUrl,
      workspaceId: c.id,
      deviceId: c.deviceId,
      hostDeviceId: c.hostDeviceId,
      identity: c.identity,
      host: c.host,
      certificate: c.certificate,
      accept: (certificate) =>
        c.role !== 'host' ||
        this.store.devices(c.id).some((d) => !d.revoked && d.certificate.signature === certificate.signature),
      onRequest: (request, sender) => this.dispatch(c, request, sender),
      onStatus: (online) => {
        if (!online) this.hostStatus.set(c.id, false);
        else if (c.role === 'host') {
          for (const d of this.store.devices(c.id))
            if (d.revoked)
              void this.peers
                .get(c.id)
                ?.revoke(d.certificate.membership.deviceId)
                .catch(() => undefined);
        } else if (c.role === 'guest')
          queueMicrotask(() => {
            void this.checkHost(c);
          });
      },
    });
    this.peers.set(c.id, peer);
    peer.start();
    return peer;
  }
  private async checkHost(c: WorkspaceConnection): Promise<void> {
    try {
      const peer = this.peers.get(c.id);
      if (!peer?.online) throw new Error('offline');
      const status = record(
        await peer.request(
          'status',
          { platform: os.platform(), architecture: os.arch(), executor: this.store.get(c.id).executor },
          c.hostDeviceId,
          c.host,
          randomId(),
          10000,
        ),
      );
      if (typeof status.name === 'string' && status.name !== c.name) this.store.rename(c.id, status.name);
      this.hostStatus.set(c.id, true);
    } catch {
      this.hostStatus.set(c.id, false);
    }
  }
  private async dispatch(
    c: WorkspaceConnection,
    request: WorkspaceRequest,
    sender: { id: string; identity: PublicIdentity; certificate?: SignedMembership },
  ): Promise<unknown> {
    const context = { workspaceId: c.id, senderDeviceId: sender.id, hostDeviceId: c.hostDeviceId };
    if (c.role === 'guest') {
      if (sender.id !== c.hostDeviceId || !this.store.get(c.id).executor || !request.operation.startsWith('executor.'))
        throw new Error('This device has not enabled this execution capability.');
      if (!this.executorHandler) throw new Error('Executor unavailable.');
      if (
        ['executor.lease', 'executor.assess', 'executor.artifact', 'executor.artifacts', 'executor.cancel'].includes(
          request.operation,
        )
      )
        return this.executorHandler(request.operation, request.input, context);
      return this.store.once(c.id, sender.id, request.id, request, () =>
        this.executorHandler!(request.operation, request.input, context),
      );
    }
    if (request.operation === 'status') {
      const info = record(request.input);
      this.presence.set(`${c.id}:${sender.id}`, {
        seen: Date.now(),
        platform: String(info.platform ?? ''),
        architecture: String(info.architecture ?? ''),
        executor: info.executor === true,
      });
      return { name: this.store.get(c.id).name, hostDeviceId: c.hostDeviceId };
    }
    if (sender.certificate && ['run.events', 'artifact.read'].includes(request.operation))
      return this.remoteHandler!(request.operation, request.input, context);
    if (
      sender.certificate &&
      request.operation === 'api' &&
      (record(request.input).method === 'GET' || record(request.input).path === '/v1/terminal/snapshot')
    )
      return this.remoteHandler!(request.operation, request.input, context);
    if (sender.certificate && request.operation === 'devices') return { devices: this.devices(c.id) };
    return this.store.once(
      c.id,
      sender.id,
      request.id,
      request,
      async () => {
        const input = record(request.input);
        if (request.operation === 'join') {
          if (sender.certificate || typeof input.secret !== 'string') throw new Error('Invalid pairing request.');
          return {
            name: this.store.get(c.id).name,
            certificate: this.store.enroll(c.id, input.secret, randomId(), String(input.name), sender.identity),
          };
        }
        if (!sender.certificate) throw new Error('Workspace membership required.');
        if (request.operation === 'invite') return { invitation: this.store.invite(c.id) };
        if (request.operation === 'rename') {
          this.store.rename(c.id, String(input.name));
          return { name: this.store.get(c.id).name };
        }
        if (request.operation === 'devices') return { devices: this.devices(c.id) };
        if (request.operation === 'revoke' || request.operation === 'leave') {
          const deviceId = request.operation === 'leave' ? sender.id : identifier(input.deviceId);
          this.store.revoke(c.id, deviceId);
          this.onMembershipRemoved?.(c.id, deviceId);
          // The host's authoritative membership check takes effect immediately.
          // Allow the departing device's final response to enter the relay first.
          if (deviceId === sender.id)
            setTimeout(() => {
              void this.peers
                .get(c.id)
                ?.revoke(deviceId)
                .catch(() => undefined);
            }, 1000).unref();
          else await this.peers.get(c.id)?.revoke(deviceId);
          return { revoked: true };
        }
        if (!this.remoteHandler) throw new Error('Workspace operation unavailable.');
        return this.remoteHandler(request.operation, request.input, context);
      },
      () => {
        if (request.operation === 'join') this.store.validateInvitation(c.id, record(request.input).secret);
      },
    );
  }
}
