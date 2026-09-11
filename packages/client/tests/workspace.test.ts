import { afterEach, expect, it, vi } from 'vitest';
import { createApiClient, startupWorkspaces, followRunEvents } from '../src';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('scopes HTTP operations and keeps Skills on the host despite a selected executor', async () => {
  const fetch = vi.fn(async () => new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetch);
  const client = createApiClient({
    baseUrl: 'http://localhost:32140',
    workspaceId: 'home',
    executionDevice: () => 'guest',
  });
  await client.request('POST', '/v1/runs', { objective: 'Write a file.' });
  await client.request('POST', '/v1/runs', { objective: '$image draw a tree' });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://localhost:32140/v1/workspaces/home/api/v1/runs');
  expect(JSON.parse(String(init.body)).executionDeviceId).toBe('guest');
  expect((init.headers as Record<string, string>)['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty(
    'executionDeviceId',
  );
});
it('waits briefly for a preferred workspace and returns an explicit offline catalog', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ defaultId: 'home', workspaces: [{ id: 'home', online: false }] }))),
  );
  const pending = startupWorkspaces(createApiClient(), 600);
  await vi.advanceTimersByTimeAsync(601);
  expect((await pending).workspaces[0].online).toBe(false);
});
it('resumes an interrupted event stream without replaying a start request', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('id: 1\nevent: text\ndata: {"type":"text","text":"first"}\n\n'))
    .mockResolvedValueOnce(
      new Response(
        'id: 1\nevent: text\ndata: {"type":"text","text":"first"}\n\nid: 2\nevent: done\ndata: {"type":"done"}\n\n',
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const events: unknown[] = [];
  const pending = (async () => {
    for await (const event of followRunEvents(createApiClient(), 'run')) events.push(event);
  })();
  await vi.advanceTimersByTimeAsync(2000);
  await pending;
  expect(events).toEqual([{ type: 'text', text: 'first' }, { type: 'done' }]);
  expect(fetch.mock.calls).toHaveLength(2);
  expect(fetch.mock.calls[1][1].headers['Last-Event-ID'] ?? fetch.mock.calls[1][1].headers['last-event-id']).toBe('1');
  expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
});
