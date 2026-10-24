import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceManager } from '../../../packages/core/src/workspace/WorkspaceManager';

// Runs real paired devices against a separately started bridge, such as the
// Cloudflare Worker under `wrangler dev`:
//   MARIFOLD_TEST_BRIDGE_URL=http://127.0.0.1:8787 MARIFOLD_TEST_BRIDGE_TOKEN=... pnpm vitest run tests/LiveBridge.test.ts
// With MARIFOLD_TEST_BRIDGE_PROXY (e.g. http://127.0.0.1:7890) the devices reach a
// deployed bridge through that proxy, via the device proxy setting.
const target = process.env.MARIFOLD_TEST_BRIDGE_URL;
const token = process.env.MARIFOLD_TEST_BRIDGE_TOKEN ?? '';
const proxy = process.env.MARIFOLD_TEST_BRIDGE_PROXY;

it.skipIf(!target)('pairs, transfers, reconnects once and revokes through a running bridge', async () => {
  const upstream = new URL(proxy ?? target!);
  // A local front lets the test cut every device connection mid-request.
  const sockets = new Set<Socket>();
  const front = createServer((client) => {
    const server = connect(Number(upstream.port), upstream.hostname);
    for (const socket of [client, server]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
    }
    client.pipe(server).pipe(client);
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const frontUrl = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
  const url = proxy ? target! : frontUrl;
  const via = proxy ? frontUrl : undefined;
  const directory = mkdtempSync(join(tmpdir(), 'marifold-live-bridge-'));
  const host = new WorkspaceManager(join(directory, 'host.toml'));
  const guest = new WorkspaceManager(join(directory, 'guest.toml'));
  try {
    let effects = 0;
    let release!: () => void;
    host.start(async (operation, input) => {
      if (operation === 'effect') {
        effects++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return input;
    });
    guest.start(async () => null);
    const created = await host.create('Home', url, token, via);
    const joined = await guest.add(url, created.invitation, false, via);
    const large = { text: 'bounded transfer '.repeat(65536) };
    expect(await guest.request(joined.id, 'large', large)).toEqual(large);
    const pending = guest.request(joined.id, 'effect', { value: 'once' }, 'stable_effect');
    await expect.poll(() => effects).toBe(1);
    for (const socket of sockets) { socket.destroy(); }
    release();
    expect(await pending).toEqual({ value: 'once' });
    expect(effects).toBe(1);
    await expect.poll(() => guest.list()[0]?.online, { timeout: 20000 }).toBe(true);
    const refused: string[] = [];
    guest.onPairingRefused = (id) => refused.push(id);
    await host.request(joined.id, 'revoke', { deviceId: joined.deviceId });
    await expect.poll(() => refused, { timeout: 20000 }).toContain(joined.id);
    const rejoined = await guest.add(url, host.store.invite(joined.id), false, via);
    expect(await guest.request(rejoined.id, 'echo', { rejoined: true })).toEqual({ rejoined: true });
  } finally {
    host.close();
    guest.close();
    for (const socket of sockets) { socket.destroy(); }
    front.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
