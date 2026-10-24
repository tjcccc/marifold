import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIdentity, publicIdentity, randomId } from '@marifold/workspace-protocol';
import { createBridge } from '../src';

async function listen(database: string) {
  const server = createBridge({ registrationToken: 't'.repeat(32), database });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { base, close };
}
const register = (base: string, body: unknown, token = 't'.repeat(32)) =>
  fetch(`${base}/v1/hosts`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

it('keeps health public and host registration authenticated and bounded', async () => {
  const { base, close } = await listen(':memory:');
  try {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      service: 'marifold-bridge',
      version: 1,
      deliveryReplay: 'on-reconnect',
    });
    expect((await fetch(`${base}/v1/hosts`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await register(base, {}, 'x'.repeat(32))).status).toBe(401);
    expect((await register(base, { padding: 'x'.repeat(20000) })).status).toBe(400);
    expect((await fetch(`${base}/v1/models`)).status).toBe(404);
    expect((await fetch(`${base}/api/bridge`)).status).toBe(404);
  } finally {
    await close();
  }
});

it('keeps host registrations across a restart and refuses a different host for the same workspace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'marifold-bridge-db-'));
  const database = join(directory, 'bridge.sqlite');
  const host = { workspaceId: randomId(), hostDeviceId: 'host', host: publicIdentity(await createIdentity()) };
  try {
    const first = await listen(database);
    expect((await register(first.base, host)).status).toBe(200);
    await first.close();
    const second = await listen(database);
    try {
      expect((await register(second.base, host)).status).toBe(200);
      const other = { ...host, host: publicIdentity(await createIdentity()) };
      expect((await register(second.base, other)).status).toBe(400);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
