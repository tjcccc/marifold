import { createServer as createHttpServer } from 'node:http';
import { createBridge } from '../src';
import { WorkspaceManager } from '../../../packages/core/src/workspace/WorkspaceManager';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIdentity, publicIdentity, randomId } from '@marifold/workspace-protocol';
import { RedisRelayStore } from '../src/Store';

it.skipIf(!process.env.MARIFOLD_TEST_REDIS_BIN)(
  'coordinates separate relay instances with durable inbox replay and generation fencing',
  async () => {
    const reserve = createServer();
    await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((r) => reserve.close(() => r()));
    const directory = mkdtempSync(join(tmpdir(), 'marifold-redis-test-'));
    const redis = spawn(
      process.env.MARIFOLD_TEST_REDIS_BIN!,
      ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', directory],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let a: RedisRelayStore | undefined;
    let b: RedisRelayStore | undefined;
    const stops: Array<() => void> = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Disposable Redis did not start.')), 5000);
        redis.stdout.on('data', (bytes) => {
          if (bytes.toString().includes('Ready to accept connections')) {
            clearTimeout(timer);
            resolve();
          }
        });
        redis.once('error', reject);
        redis.once('exit', (code) => {
          clearTimeout(timer);
          if (code) reject(new Error('Disposable Redis exited.'));
        });
      });
      a = new RedisRelayStore(`redis://127.0.0.1:${port}`);
      b = new RedisRelayStore(`redis://127.0.0.1:${port}`);
      const workspaceId = randomId();
      const host = { workspaceId, hostDeviceId: 'host', host: publicIdentity(await createIdentity()) };
      await a.register(host);
      expect(await b.host(workspaceId)).toEqual(host);
      await a.connect(workspaceId, 'guest', 'first');
      expect(await b.current(workspaceId, 'guest', 'first')).toBe(true);
      await b.connect(workspaceId, 'guest', 'second');
      expect(await a.current(workspaceId, 'guest', 'first')).toBe(false);
      await a.publish(workspaceId, 'guest', 'encrypted-before-subscribe');
      const received: Array<{ id: string; packet: string }> = [];
      stops.push(
        await b.receive(workspaceId, 'guest', (id, packet) => {
          received.push({ id, packet });
        }),
      );
      expect(received[0].packet).toBe('encrypted-before-subscribe');
      await b.ack(workspaceId, 'guest', received[0].id);
      received.length = 0;
      await a.publish(workspaceId, 'guest', 'encrypted-live');
      for (let i = 0; i < 100 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(received.some((r) => r.packet === 'encrypted-live')).toBe(true);
      await b.revoke(workspaceId, 'guest');
      expect(await a.revoked(workspaceId, 'guest')).toBe(true);
      expect(await a.revoked('other-workspace', 'guest')).toBe(false);

      // A disposable router models serverless upgrades landing on different
      // function instances at one public origin, including after reconnect.
      const relays = [createBridge(a, 'r'.repeat(32)), createBridge(b, 'r'.repeat(32))];
      const sockets = new Set<import('node:net').Socket>();
      let upgrades = 0;
      let rotating = false;
      const front = createHttpServer((request, response) => relays[0].emit('request', request, response));
      front.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      front.on('upgrade', (request, socket, head) => {
        const instance = rotating || upgrades++ === 0 ? 0 : 1;
        relays[instance].emit('upgrade', request, socket, head);
      });
      await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
      const hostDevice = new WorkspaceManager(join(directory, 'host.toml'));
      const guestDevice = new WorkspaceManager(join(directory, 'guest.toml'));
      let effects = 0;
      let release!: () => void;
      try {
        hostDevice.start(async (operation, value) => {
          if (operation === 'slow') {
            effects++;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return value;
        });
        guestDevice.start(async () => null);
        const created = await hostDevice.create('Home', url, 'r'.repeat(32));
        const joined = await guestDevice.add(url, created.invitation);
        const payload = { bytes: 'encrypted chunk '.repeat(20000) };
        expect(await guestDevice.request(joined.id, 'echo', payload)).toEqual(payload);
        const pending = guestDevice.request(joined.id, 'slow', { written: true }, 'stable_mutation');
        await expect.poll(() => effects).toBe(1);
        rotating = true;
        for (const socket of sockets) socket.destroy();
        release();
        expect(await pending).toEqual({ written: true });
        expect(effects).toBe(1);
        expect(upgrades).toBeGreaterThanOrEqual(3);
      } finally {
        hostDevice.close();
        guestDevice.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => front.close(() => resolve()));
        for (const relay of relays) relay.emit('close');
      }
    } finally {
      for (const stop of stops) stop();
      await a?.close();
      await b?.close();
      redis.kill('SIGTERM');
      await new Promise<void>((r) => {
        if (redis.exitCode !== null) r();
        else redis.once('exit', () => r());
      });
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);
