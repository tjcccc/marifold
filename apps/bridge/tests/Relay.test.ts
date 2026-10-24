import { expect, it } from 'vitest';
import { createIdentity, issueMembership, publicIdentity, signText } from '@marifold/workspace-protocol';
import type { PrivateIdentity, SignedMembership } from '@marifold/workspace-protocol';
import { openSqlite } from '../src/node/NodeBridge';
import { Relay } from '../src/relay/Relay';
import type { ConnectionState, RelaySocket } from '../src/relay/Relay';
import { INBOX_LIMIT, RelayStore } from '../src/relay/RelayStore';

// A socket whose state outlives any one Relay, like a hibernated Durable
// Object's attachment.
class FakeSocket implements RelaySocket {
  state: ConnectionState | undefined;
  sent: Array<Record<string, unknown>> = [];
  closedWith?: number;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code: number) {
    this.closedWith = code;
  }
  last(type: string) {
    return this.sent.filter((frame) => frame.type === type).at(-1);
  }
}
async function fixture(holdMs = 0) {
  const { sql } = openSqlite(':memory:');
  const sockets: FakeSocket[] = [];
  const store = new RelayStore(sql);
  const build = () => new Relay({ store, sockets: () => sockets, holdMs });
  const hostKey = await createIdentity();
  const guestKey = await createIdentity();
  const workspace = 'workspace';
  const relay = build();
  relay.register({ workspaceId: workspace, hostDeviceId: 'host', host: publicIdentity(hostKey) });
  const membership = (deviceId: string, identity: PrivateIdentity) =>
    issueMembership(hostKey, {
      version: 1,
      workspaceId: workspace,
      deviceId,
      name: deviceId,
      identity: publicIdentity(identity),
      host: publicIdentity(hostKey),
      issuedAt: Date.now(),
    });
  const certificates = { host: membership('host', hostKey), guest: membership('guest', guestKey) };
  const connect = (r: Relay, device: 'host' | 'guest') => {
    const socket = new FakeSocket();
    sockets.push(socket);
    r.open(socket);
    const nonce = String(socket.last('challenge')?.nonce);
    const certificate: SignedMembership = certificates[device];
    const key = device === 'host' ? hostKey : guestKey;
    r.message(socket, JSON.stringify({ type: 'auth', workspaceId: workspace, deviceId: device, certificate, signature: signText(key, nonce) }));
    return socket;
  };
  const send = (r: Relay, socket: FakeSocket, sender: string, recipient: string, body = 'ciphertext') =>
    r.message(socket, JSON.stringify({
      type: 'send',
      message: { header: { version: 1, workspaceId: workspace, sender, recipient, id: `m${Math.random()}`.replace('.', ''), expiresAt: Date.now() + 60000 }, body },
    }));
  return { build, connect, send, sockets, relay, store };
}

it('relays across a rebuilt relay and replays unacknowledged frames after reconnect', async () => {
  const { build, connect, send } = await fixture();
  let relay = build();
  const host = connect(relay, 'host');
  const guest = connect(relay, 'guest');
  expect(guest.last('ready')).toMatchObject({ hostDeviceId: 'host', deliveryReplay: 'on-reconnect' });
  // A Durable Object can be evicted between any two frames.
  relay = build();
  send(relay, guest, 'guest', 'host', 'first');
  relay = build();
  send(relay, guest, 'guest', 'host', 'second');
  const deliveries = host.sent.filter((frame) => frame.type === 'delivery');
  expect(deliveries.map((frame) => (frame.packet as { message: { body: string } }).message.body)).toEqual(['first', 'second']);
  relay.message(host, JSON.stringify({ type: 'ack', deliveryId: deliveries[0]!.deliveryId }));
  // The host reconnects before acknowledging the second frame.
  relay = build();
  const again = connect(relay, 'host');
  expect(host.closedWith).toBe(1008);
  const replay = again.sent.filter((frame) => frame.type === 'delivery');
  expect(replay.map((frame) => frame.deliveryId)).toEqual([deliveries[1]!.deliveryId]);
  expect(again.sent.findIndex((frame) => frame.type === 'ready')).toBeLessThan(again.sent.findIndex((frame) => frame.type === 'delivery'));
});

it('routes guests only to the host and closes revoked devices', async () => {
  const { connect, send, relay } = await fixture();
  const host = connect(relay, 'host');
  const guest = connect(relay, 'guest');
  send(relay, guest, 'guest', 'other');
  expect(guest.closedWith).toBe(1008);
  const rejoined = connect(relay, 'guest');
  relay.message(host, JSON.stringify({ type: 'revoke', deviceId: 'guest', id: 'r1' }));
  expect(host.last('revoked')).toEqual({ type: 'revoked', id: 'r1' });
  expect(rejoined.closedWith).toBe(1008);
  const refused = connect(relay, 'guest');
  expect(refused.closedWith).toBe(1008);
  expect(refused.last('ready')).toBeUndefined();
});

it('signals a full inbox as backpressure, not as a refused membership', async () => {
  const { connect, send, relay, sockets } = await fixture();
  const guest = connect(relay, 'guest');
  for (let i = 0; i < INBOX_LIMIT; i++) { send(relay, guest, 'guest', 'host'); }
  expect(guest.closedWith).toBeUndefined();
  send(relay, guest, 'guest', 'host');
  expect(guest.closedWith).toBe(1013);
  const host = connect(relay, 'host');
  expect(host.sent.filter((frame) => frame.type === 'delivery')).toHaveLength(INBOX_LIMIT);
  expect(sockets).toContain(host);
});

it('closes connections that do not authenticate in time', async () => {
  const { sql } = openSqlite(':memory:');
  let now = 1_000_000;
  const socket = new FakeSocket();
  const relay = new Relay({ store: new RelayStore(sql), sockets: () => [socket], now: () => now });
  relay.open(socket);
  expect(relay.sweep()).toBe(now + 10_000);
  now += 10_000;
  expect(relay.sweep()).toBeUndefined();
  expect(socket.closedWith).toBe(1008);
});

it('stores a frame delivered to an online device only when its ack is late or the device drops', async () => {
  const { connect, send, relay, store, sockets } = await fixture(50);
  const host = connect(relay, 'host');
  const guest = connect(relay, 'guest');
  send(relay, guest, 'guest', 'host', 'acked');
  relay.message(host, JSON.stringify({ type: 'ack', deliveryId: host.last('delivery')?.deliveryId }));
  send(relay, guest, 'guest', 'host', 'late');
  expect(store.count('workspace', 'host', Date.now())).toBe(0);
  await expect.poll(() => store.count('workspace', 'host', Date.now())).toBe(1);
  send(relay, guest, 'guest', 'host', 'dropped');
  sockets.splice(sockets.indexOf(host), 1);
  relay.closed(host);
  const again = connect(relay, 'host');
  const bodies = again.sent.filter((frame) => frame.type === 'delivery').map((frame) => (frame.packet as { message: { body: string } }).message.body);
  expect(bodies).toEqual(['late', 'dropped']);
  for (const frame of again.sent.filter((f) => f.type === 'delivery')) {
    relay.message(again, JSON.stringify({ type: 'ack', deliveryId: frame.deliveryId }));
  }
  expect(store.count('workspace', 'host', Date.now())).toBe(0);
  relay.close();
});
