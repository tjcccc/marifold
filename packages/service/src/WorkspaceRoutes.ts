import { SSE_HEADERS, writeSse, startSseHeartbeat } from './Sse';
import type { SequencedEvent, RunRecord } from '@marifold/core';
import type { WorkspaceRequestContext } from './WorkspaceRequestContext';
import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WorkspaceManager, type RunRegistry, type WorkspaceOperationContext } from '@marifold/core';
import { objectBody, requiredString } from './Validation';

/** Only application resources can traverse the bridge. Device-local configuration
 * and workspace connection management are never forwarded to another workspace. */
export function workspaceApiPath(method: string, raw: string): boolean {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || raw.length > 2048 || /[\\\x00-\x1f#]/.test(raw))
    return false;
  const pathname = raw.split('?')[0];
  if (/%2f|%5c|%2e/i.test(pathname) || pathname.split('/').some((p) => p === '.' || p === '..')) return false;
  return (
    /^\/v1\/(status|changes|ask|config|providers|models|profiles|sessions|skills|apps|app-instances|runs|tasks|schedules|terminal)(?:\/[A-Za-z0-9_%.-]+)*$/.test(
      pathname,
    ) &&
    !pathname.endsWith('/events') &&
    !(pathname === '/v1/config' && !['GET', 'PATCH'].includes(method))
  );
}
export function registerWorkspaceRoutes(
  server: FastifyInstance,
  manager: WorkspaceManager,
  registry: RunRegistry,
  contextStore: WorkspaceRequestContext,
  executor: (operation: string, input: unknown, context: WorkspaceOperationContext) => Promise<unknown>,
  token?: string,
  cancelExecution?: (workspaceId: string) => void,
): void {
  const application = async (
    operation: string,
    input: unknown,
    context: WorkspaceOperationContext,
  ): Promise<unknown> => {
    const body = objectBody(input);
    if (operation === 'run.events') {
      const runId = requiredString(body.runId, 'runId');
      const run = registry.require(runId);
      const after =
        typeof body.after === 'number' && Number.isSafeInteger(body.after) && body.after >= 0 ? body.after : 0;
      const events: unknown[] = [];
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 1000);
      try {
        for await (const event of registry.events(runId, after, stop.signal)) {
          events.push(event);
          if (events.length >= 128) break;
        }
      } finally {
        clearTimeout(timer);
      }
      return { run, events };
    }
    if (operation === 'artifact.read') {
      const runId = requiredString(body.runId, 'runId');
      const artifactId = requiredString(body.artifactId, 'artifactId');
      const run = registry.require(runId);
      const origin = registry.artifactOrigin(runId, artifactId);
      const e = origin.run.execution;
      if (!run.artifacts?.some((a) => a.id === artifactId)) throw new Error('Artifact not found.');
      const offset = body.offset;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
        throw new Error('Invalid artifact offset.');
      if (e && e.executionDeviceId !== manager.store.get(e.workspaceId).hostDeviceId)
        return manager.execute(e.workspaceId, e.executionDeviceId, 'executor.artifact', {
          runId: origin.run.id,
          artifactId: origin.artifactId,
          offset,
        });
      const artifact = registry.requireArtifact(runId, artifactId);
      if (offset > artifact.size) throw new Error('Invalid artifact offset.');
      const fd = fs.openSync(artifact.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(Math.min(32768, artifact.size - offset));
        const n = fs.readSync(fd, bytes, 0, bytes.length, offset);
        return { data: bytes.subarray(0, n).toString('base64'), size: artifact.size };
      } finally {
        fs.closeSync(fd);
      }
    }
    if (operation !== 'api') throw new Error('Unsupported workspace operation.');
    const method = requiredString(body.method, 'method');
    const url = requiredString(body.path, 'path');
    if (!workspaceApiPath(method, url)) throw new Error('This operation is not available through a workspace bridge.');
    if (url === '/v1/config' && method === 'PATCH') {
      const patch = objectBody(body.body);
      const key = requiredString(patch.key, 'key');
      if (!/^(default\.|memory\.|agent\.|web_search\.(enabled|max_results|provider|api_key_env|scrape)$)/.test(key))
        throw new Error('This setting belongs to the host device and must be edited locally.');
    }
    const response = await contextStore.inject(context, (provenance) =>
      server.inject({
        method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url,
        headers: {
          ...provenance,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body.body !== undefined ? { payload: JSON.stringify(body.body) } : {}),
      }),
    );
    const contentType = response.headers['content-type'] as string | undefined;
    return {
      status: response.statusCode,
      contentType,
      disposition: response.headers['content-disposition'],
      body: response.rawPayload.toString('base64'),
    };
  };
  manager.start(application, executor);
  server.get('/v1/workspaces', async () => ({
    ok: true,
    workspaces: manager.list(),
    defaultId: manager.store.defaultId(),
  }));
  server.post('/v1/workspaces', async (request) => {
    const b = objectBody(request.body);
    return {
      ok: true,
      ...(await manager.create(
        requiredString(b.name, 'name'),
        requiredString(b.bridgeUrl, 'bridgeUrl'),
        requiredString(b.registrationToken, 'registrationToken'),
      )),
    };
  });
  server.post('/v1/workspaces/join', async (request) => {
    const b = objectBody(request.body);
    return {
      ok: true,
      workspace: await manager.add(
        requiredString(b.bridgeUrl, 'bridgeUrl'),
        requiredString(b.invitation, 'invitation'),
        b.executor === true,
      ),
    };
  });
  server.put('/v1/workspaces/default', async (request) => {
    const b = objectBody(request.body);
    manager.store.setDefault(requiredString(b.id, 'id'));
    return { ok: true, defaultId: manager.store.defaultId() };
  });
  server.put<{ Params: { id: string } }>('/v1/workspaces/:id/executor', async (request) => {
    const body = objectBody(request.body);
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
    const id = manager.store.get(request.params.id).id;
    if (!body.enabled) cancelExecution?.(id);
    await manager.setExecutor(id, body.enabled);
    return { ok: true, enabled: body.enabled };
  });
  server.delete<{ Params: { id: string } }>('/v1/workspaces/:id', async (request) => {
    const id = manager.store.get(request.params.id).id;
    cancelExecution?.(id);
    await manager.remove(id);
    return { ok: true };
  });
  server.post<{ Params: { id: string; operation: string } }>(
    '/v1/workspaces/:id/manage/:operation',
    async (request) => {
      if (!['rename', 'invite', 'devices', 'revoke'].includes(request.params.operation))
        throw new Error('Unknown workspace operation.');
      return {
        ok: true,
        ...((await manager.request(request.params.id, request.params.operation, request.body ?? {})) as object),
      };
    },
  );
  server.get<{ Params: { id: string; runId: string }; Querystring: { after?: string } }>(
    '/v1/workspaces/:id/run-events/:runId',
    async (request) => ({
      ok: true,
      ...((await manager.request(request.params.id, 'run.events', {
        runId: request.params.runId,
        after: Number(request.query.after ?? 0),
      })) as object),
    }),
  );
  server.get<{ Params: { id: string; runId: string }; Querystring: { after?: string } }>(
    '/v1/workspaces/:id/api/v1/runs/:runId/events',
    async (request, reply) => {
      let after = Number(request.headers['last-event-id'] ?? request.query.after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor.');
      const poll = () =>
        manager.request(request.params.id, 'run.events', { runId: request.params.runId, after }) as Promise<{
          run: RunRecord;
          events: SequencedEvent[];
        }>;
      let batch = await poll();
      let closed = false;
      reply.hijack();
      reply.raw.on('close', () => {
        closed = true;
      });
      reply.raw.writeHead(200, SSE_HEADERS);
      const stop = startSseHeartbeat(reply);
      try {
        while (!closed) {
          for (const { seq, event } of batch.events) {
            if (seq <= after) continue;
            writeSse(reply, event.type, event, seq);
            after = seq;
          }
          if (batch.run.finishedAt && after >= batch.run.eventCount) break;
          batch = await poll();
        }
      } catch {
        /* Closing preserves the client's last sequence for reconnect. */
      } finally {
        stop();
        if (!closed) reply.raw.end();
      }
    },
  );
  server.all<{ Params: { id: string; '*': string } }>('/v1/workspaces/:id/api/*', async (request, reply) => {
    const suffix = request.url.slice(request.url.indexOf('/api/') + 4);
    if (!workspaceApiPath(request.method, suffix)) throw new Error('Unsupported workspace application route.');
    const artifact = /^\/v1\/runs\/([^/]+)\/artifacts\/([^/?]+)$/.exec(suffix);
    if (request.method === 'GET' && artifact) {
      const response = (await manager.request(request.params.id, 'api', {
        method: 'GET',
        path: `/v1/runs/${artifact[1]}`,
      })) as { body: string };
      const run = JSON.parse(Buffer.from(response.body, 'base64').toString('utf8')).run;
      const item = run?.artifacts?.find((a: { id: string }) => a.id === artifact[2]);
      if (!item)
        return reply
          .code(404)
          .send({ ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.' } });
      reply
        .type(item.mediaType)
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`);
      return reply.send(
        Readable.from(
          (async function* () {
            for (let offset = 0; offset < item.size; ) {
              const chunk = (await manager.request(request.params.id, 'artifact.read', {
                runId: artifact[1],
                artifactId: artifact[2],
                offset,
              })) as { data: string };
              const bytes = Buffer.from(chunk.data, 'base64');
              if (!bytes.length) throw new Error('Artifact transfer ended early.');
              offset += bytes.length;
              yield bytes;
            }
          })(),
        ),
      );
    }
    const result = (await manager.request(
      request.params.id,
      'api',
      { method: request.method, path: suffix, ...(request.body !== undefined ? { body: request.body } : {}) },
      typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : undefined,
    )) as { status: number; contentType?: string; disposition?: string; body: string };
    reply.code(result.status);
    if (result.disposition) reply.header('content-disposition', result.disposition);
    if (result.contentType) reply.type(result.contentType);
    return reply.send(Buffer.from(result.body, 'base64'));
  });
  server.addHook('onClose', async () => manager.close());
}
