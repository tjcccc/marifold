import { expect, it } from 'vitest';
import { createBridge, MemoryRelayStore } from '../src';
it('keeps health public and host registration authenticated on native and Vercel entry paths', async () => {
  const server = createBridge(new MemoryRelayStore(), 't'.repeat(32));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const route of ['/health', '/api/bridge'])
      expect((await (await fetch(base + route)).json()).service).toBe('marifold-bridge');
    for (const route of ['/v1/hosts', '/api/bridge'])
      expect((await fetch(base + route, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(base + '/v1/models')).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
