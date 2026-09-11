import Redis from 'ioredis';
import { randomId, RELAY_RETENTION_MS } from '@marifold/workspace-protocol';
import type { PublicIdentity } from '@marifold/workspace-protocol';
export interface HostRegistration {
  workspaceId: string;
  hostDeviceId: string;
  host: PublicIdentity;
}
export interface RelayStore {
  host(id: string): Promise<HostRegistration | undefined>;
  register(host: HostRegistration): Promise<void>;
  revoked(workspace: string, device: string): Promise<boolean>;
  revoke(workspace: string, device: string): Promise<void>;
  connect(workspace: string, device: string, generation: string): Promise<void>;
  current(workspace: string, device: string, generation: string): Promise<boolean>;
  publish(workspace: string, device: string, packet: string): Promise<void>;
  receive(workspace: string, device: string, deliver: (id: string, packet: string) => void): Promise<() => void>;
  ack(workspace: string, device: string, id: string): Promise<void>;
  close(): Promise<void>;
}
export class MemoryRelayStore implements RelayStore {
  private hosts = new Map<string, HostRegistration>();
  private revocations = new Set<string>();
  private generations = new Map<string, string>();
  private messages = new Map<string, Map<string, { text: string; expires: number }>>();
  private listeners = new Map<string, Set<(id: string, packet: string) => void>>();
  async host(id: string) {
    return this.hosts.get(id);
  }
  async register(host: HostRegistration) {
    const old = this.hosts.get(host.workspaceId);
    if (old && JSON.stringify(old) !== JSON.stringify(host)) throw new Error('Workspace already registered.');
    this.hosts.set(host.workspaceId, host);
  }
  async revoked(w: string, d: string) {
    return this.revocations.has(`${w}:${d}`);
  }
  async revoke(w: string, d: string) {
    this.revocations.add(`${w}:${d}`);
  }
  async connect(w: string, d: string, g: string) {
    this.generations.set(`${w}:${d}`, g);
  }
  async current(w: string, d: string, g: string) {
    return this.generations.get(`${w}:${d}`) === g;
  }
  async publish(w: string, d: string, packet: string) {
    const key = `${w}:${d}`;
    const queue = this.messages.get(key) ?? new Map();
    for (const [id, m] of queue) if (m.expires < Date.now()) queue.delete(id);
    if (queue.size >= 128) throw new Error('Recipient inbox is full.');
    const id = randomId();
    queue.set(id, { text: packet, expires: Date.now() + RELAY_RETENTION_MS });
    this.messages.set(key, queue);
    for (const listener of this.listeners.get(key) ?? []) listener(id, packet);
  }
  async receive(w: string, d: string, deliver: (id: string, packet: string) => void) {
    const key = `${w}:${d}`;
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(deliver);
    this.listeners.set(key, listeners);
    for (const [id, m] of this.messages.get(key) ?? []) if (m.expires > Date.now()) deliver(id, m.text);
    return () => {
      listeners.delete(deliver);
    };
  }
  async ack(w: string, d: string, id: string) {
    this.messages.get(`${w}:${d}`)?.delete(id);
  }
  async close() {
    this.listeners.clear();
  }
}
export class RedisRelayStore implements RelayStore {
  private redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true });
    this.redis.on('error', () => undefined);
  }
  private key(w: string, d = '') {
    return `marifold:v1:${w}:${d}`;
  }
  async host(id: string) {
    const data = await this.redis.get(this.key(id, 'host'));
    return data ? (JSON.parse(data) as HostRegistration) : undefined;
  }
  async register(host: HostRegistration) {
    const key = this.key(host.workspaceId, 'host');
    const text = JSON.stringify(host);
    const accepted = await this.redis.set(key, text, 'NX');
    if (!accepted && (await this.redis.get(key)) !== text) throw new Error('Workspace already registered.');
  }
  async revoked(w: string, d: string) {
    return Boolean(await this.redis.sismember(this.key(w, 'revoked'), d));
  }
  async revoke(w: string, d: string) {
    await this.redis.sadd(this.key(w, 'revoked'), d);
  }
  async connect(w: string, d: string, g: string) {
    await this.redis.set(this.key(w, `${d}:connection`), g, 'PX', RELAY_RETENTION_MS);
  }
  async current(w: string, d: string, g: string) {
    return (await this.redis.get(this.key(w, `${d}:connection`))) === g;
  }
  async publish(w: string, d: string, packet: string) {
    const key = this.key(w, `${d}:inbox`);
    const result = await this.redis.eval(
      `redis.call('XTRIM',KEYS[1],'MINID',ARGV[3]); if redis.call('XLEN',KEYS[1])>=128 then return 0 end redis.call('XADD',KEYS[1],'*','packet',ARGV[1]); redis.call('PEXPIRE',KEYS[1],ARGV[2]); redis.call('PUBLISH',KEYS[1],'new'); return 1`,
      1,
      key,
      packet,
      RELAY_RETENTION_MS,
      `${Date.now() - RELAY_RETENTION_MS}-0`,
    );
    if (!result) throw new Error('Recipient inbox is full.');
  }
  async receive(w: string, d: string, deliver: (id: string, packet: string) => void) {
    const key = this.key(w, `${d}:inbox`);
    const subscriber = this.redis.duplicate();
    let closed = false;
    let reading = false;
    let again = false;
    const read = async () => {
      if (closed) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          const rows = await this.redis.xrange(key, `${Date.now() - RELAY_RETENTION_MS}-0`, '+', 'COUNT', 128);
          for (const [id, fields] of rows) if (!closed) deliver(id, fields[1]);
        } while (again && !closed);
      } finally {
        reading = false;
      }
    };
    subscriber.on('error', () => undefined);
    subscriber.on('message', () => {
      void read().catch(() => undefined);
    });
    try {
      await subscriber.subscribe(key);
      await read();
    } catch (error) {
      closed = true;
      subscriber.disconnect();
      throw error;
    }
    return () => {
      closed = true;
      subscriber.disconnect();
    };
  }
  async ack(w: string, d: string, id: string) {
    await this.redis.xdel(this.key(w, `${d}:inbox`), id);
  }
  async close() {
    this.redis.disconnect();
  }
}
