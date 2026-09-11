import { afterEach, expect, it, vi } from 'vitest';
import { RemoteRuntime } from '../src/core/RemoteRuntime';
import { resolveAgentConfig } from '@marifold/core';
afterEach(() => vi.unstubAllGlobals());
it('uses the host snapshot and the workspace run contract without local model credentials', async () => {
  const calls: Array<{ path: string; body: any }> = [];
  const config = {
    default: { profile: 'host-profile', provider: 'host-provider', model: 'host-model', think: false },
    models: { options: ['host-provider/host-model'] },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body });
      if (path.endsWith('/terminal/snapshot'))
        return Response.json({
          result: [
            {
              summary: { name: 'host-profile' },
              detail: { name: 'host-profile' },
              settings: { profile: 'host-profile', provider: 'host-provider', model: 'host-model' },
              agent: resolveAgentConfig(),
              skills: { all: [], global: [], profile: [] },
            },
          ],
        });
      if (path.endsWith('/config')) return Response.json({ config });
      if (path.endsWith('/runs')) return Response.json({ run: { id: 'run' } });
      if (path.endsWith('/events'))
        return new Response(
          'id: 1\nevent: approval_request\ndata: {"type":"approval_request","request":{"id":"call","tool":"write_file","kind":"write","input":{},"summary":"write","escalated":true,"persistable":false}}\n\nid: 2\nevent: done\ndata: {"type":"done","taskId":"task","status":"completed"}\n\n',
        );
      return Response.json({ ok: true });
    }),
  );
  const runtime = new RemoteRuntime({ baseUrl: 'http://localhost:32140', workspaceId: 'home' });
  await runtime.refresh();
  expect(runtime.listProfiles()[0].name).toBe('host-profile');
  expect(runtime.resolveSettings({})).toMatchObject({ provider: 'host-provider', model: 'host-model' });
  const approval = vi.fn(async () => ({ approved: true }));
  const events = [];
  for await (const event of runtime
    .createAgentRunner()
    .run({ objective: 'work', profile: 'host-profile', approvalHandler: approval }))
    events.push(event);
  await vi.waitFor(() =>
    expect(calls.some((call) => call.path.endsWith('/approvals/call') && call.body.action === 'once')).toBe(true),
  );
  expect(approval).toHaveBeenCalledOnce();
  expect(events.at(-1)?.type).toBe('done');
  expect(calls.every((call) => call.path.startsWith('/v1/workspaces/home/api/'))).toBe(true);
  const abort = new AbortController();
  abort.abort();
  const count = calls.length;
  for await (const _ of runtime.createAgentRunner().run({ objective: 'cancelled', signal: abort.signal }))
    throw new Error('No cancelled run should start.');
  expect(calls).toHaveLength(count);
});
