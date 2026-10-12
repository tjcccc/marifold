import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridge, MemoryRelayStore } from '../../../apps/bridge/src';
import { WorkspaceManager } from '../src/workspace/WorkspaceManager';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) { fn(); }
});
function manager() {
  const dir = mkdtempSync(join(tmpdir(), 'marifold-access-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const m = new WorkspaceManager(join(dir, 'config.toml'));
  cleanup.push(() => m.close());
  return m;
}

describe('executor-only members', () => {
  it('only answer execution requests; full members keep their access', async () => {
    const bridge = createBridge(new MemoryRelayStore(), 'e'.repeat(32));
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => {
      bridge.closeAllConnections();
      bridge.close();
    });
    const url = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
    const host = manager();
    let effects = 0;
    host.start(async () => {
      effects++;
      return { ok: true };
    });
    const created = await host.create('Home', url, 'e'.repeat(32));

    const full = manager();
    full.start(async () => null);
    const fullJoined = await full.add(url, created.invitation);
    expect(fullJoined.access).toBeUndefined();
    expect(await full.request(fullJoined.id, 'test', {})).toEqual({ ok: true });

    const { invitation } = await host.request(created.workspace.id, 'invite', { access: 'executor' }) as { invitation: string };
    await expect(host.request(created.workspace.id, 'invite', { access: 'admin' })).rejects.toThrow('Invalid invitation access');
    const agent = manager();
    agent.start(async () => null, async operation => `ran ${operation}`);
    const joined = await agent.add(url, invitation);
    expect(joined).toMatchObject({ online: true, access: 'executor', executor: true });
    expect(host.devices(created.workspace.id).find(d => d.id === joined.deviceId)?.access).toBe('executor');

    effects = 0;
    for (const [operation, input] of [
      ['devices', {}], ['run.events', { runId: 'r' }], ['artifact.read', { runId: 'r', artifactId: 'a' }],
      ['api', { method: 'GET', path: '/v1/sessions' }], ['api', { method: 'POST', path: '/v1/runs', body: {} }],
      ['invite', {}], ['rename', { name: 'Mine' }], ['revoke', { deviceId: fullJoined.deviceId }], ['test', {}],
    ] as const) {
      await expect(agent.request(joined.id, operation, input), operation).rejects.toThrow('executor only');
    }
    expect(effects).toBe(0);
    expect(host.list()[0]?.name).toBe('Home');
    expect(host.devices(created.workspace.id).some(d => d.id === fullJoined.deviceId)).toBe(true);

    // The host still runs work on it.
    expect(await host.execute(created.workspace.id, joined.deviceId, 'executor.lease', {})).toBe('ran executor.lease');
  }, 20000);
});
