import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridge, MemoryRelayStore } from '../../../apps/bridge/src';
import { WorkspaceManager } from '../src/workspace/WorkspaceManager';
import { BridgePeer } from '../src/workspace/bridge/BridgePeer';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function manager() {
  const dir = mkdtempSync(join(tmpdir(), 'marifold-bridge-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const m = new WorkspaceManager(join(dir, 'config.toml'));
  cleanup.push(() => m.close());
  return m;
}
describe('workspace bridge', () => {
  it('pairs, forwards only authenticated workspace operations, and deduplicates effects', async () => {
    const bridge = createBridge(new MemoryRelayStore(), 'a'.repeat(32));
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => {
      bridge.closeAllConnections();
      bridge.close();
    });
    const address = bridge.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const host = manager();
    let effects = 0;
    host.start(async (operation, input) => {
      expect(operation).toBe('test');
      effects++;
      return input;
    });
    const created = await host.create('Home', url, 'a'.repeat(32));
    const guest = manager();
    guest.start(async () => {
      throw new Error('Guest cannot host operations.');
    });
    const joined = await guest.add(url, created.invitation);
    expect(joined.online).toBe(true);
    expect(joined.name).toBe('Home');
    const id = 'request_1';
    expect(await guest.request(joined.id, 'test', { text: 'private' }, id)).toEqual({ text: 'private' });
    expect(await guest.request(joined.id, 'test', { text: 'private' }, id)).toEqual({ text: 'private' });
    expect(effects).toBe(1);
    await expect(guest.request(joined.id, 'test', { text: 'different' }, id)).rejects.toThrow('different input');
    expect(statSync(join(guest.store.directory, `${joined.id}.credentials.json`)).mode & 0o777).toBe(0o600);
    const third = manager();
    third.start(async () => null);
    await expect(third.add(url, created.invitation)).rejects.toThrow('invalid or expired');
    const request = vi.spyOn(BridgePeer.prototype, 'request').mockRejectedValueOnce(new Error('Workspace request timed out.'));
    try {
      await expect(guest.request(joined.id, 'api', { method: 'GET', path: '/v1/profiles' }))
        .rejects.toMatchObject({ code: 'WORKSPACE_TIMEOUT' });
      expect(request.mock.calls[0]?.[5]).toBe(60000);
      expect(guest.list()[0].online).toBe(true);
    } finally {
      request.mockRestore();
    }
  }, 20000);
  it('reconnects interrupted transfers without repeating effects and supports executor revocation', async () => {
    const bridge = createBridge(new MemoryRelayStore(), 'b'.repeat(32));
    const sockets = new Set<import('node:net').Socket>();
    bridge.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => {
      for (const socket of sockets) socket.destroy();
      bridge.close();
    });
    const url = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
    const host = manager();
    const guest = manager();
    let effects = 0;
    let release!: () => void;
    host.start(async (operation, input) => {
      if (operation === 'effect') {
        effects++;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return input;
    });
    let executions = 0;
    guest.start(
      async () => null,
      async () => {
        executions++;
        return { executed: true };
      },
    );
    const created = await host.create('Home', url, 'b'.repeat(32));
    const joined = await guest.add(url, created.invitation, true);
    const large = { text: 'bounded transfer '.repeat(65536) };
    expect(await guest.request(joined.id, 'large', large)).toEqual(large);
    const pending = guest.request(joined.id, 'effect', { value: 'once' }, 'stable_effect');
    await expect.poll(() => effects).toBe(1);
    for (const socket of sockets) socket.destroy();
    release();
    expect(await pending).toEqual({ value: 'once' });
    expect(effects).toBe(1);
    await expect.poll(() => guest.list()[0].online, { timeout: 10000 }).toBe(true);
    await guest.setExecutor(joined.id, false);
    await expect(host.execute(joined.id, joined.deviceId, 'executor.prepare', { runId: 'one' })).rejects.toThrow(
      'has not enabled',
    );
    expect(executions).toBe(0);
    await guest.setExecutor(joined.id, true);
    expect(await host.execute(joined.id, joined.deviceId, 'executor.prepare', { runId: 'two' })).toEqual({
      executed: true,
    });
    await host.request(joined.id, 'revoke', { deviceId: joined.deviceId });
    await expect.poll(() => guest.list()[0].online, { timeout: 20000 }).toBe(false);
    await expect(guest.request(joined.id, 'anything', {}, 'revoked_request')).rejects.toThrow();
  }, 25000);
});
