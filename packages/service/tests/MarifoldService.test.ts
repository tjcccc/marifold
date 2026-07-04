import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadedMarifoldConfig, MarifoldConfig } from '@marifold/core';
import { createMarifoldService } from '../src';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-service-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MarifoldService', () => {
  it('exposes health and sanitized config without secrets', async () => {
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      const health = await server.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        ok: true,
        service: 'marifold',
        apiVersion: 'v1',
      });

      const config = await server.inject({ method: 'GET', url: '/v1/config' });
      expect(config.statusCode).toBe(200);
      const body = config.json();
      expect(body.config.providers.ollama).toMatchObject({
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        hasApiKey: true,
      });
      expect(JSON.stringify(body)).not.toContain('test-secret-key');
    } finally {
      await server.close();
    }
  });

  it('creates and updates task state through the API', async () => {
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/tasks',
        payload: {
          objective: 'Implement the service foundation.',
          plan: [
            { id: 'task_state', text: 'Add task state', status: 'completed' },
            { id: 'api', text: 'Expose service routes', status: 'in_progress' },
          ],
          nextAction: 'Add route tests.',
        },
      });

      expect(created.statusCode).toBe(201);
      const taskId = created.json().task.id as string;
      expect(taskId).toMatch(/^task_/);

      const event = await server.inject({
        method: 'POST',
        url: `/v1/tasks/${taskId}/events`,
        payload: {
          kind: 'decision',
          message: 'Keep task state separate from durable profile memory.',
        },
      });
      expect(event.statusCode).toBe(200);
      expect(event.json().task.events[0]).toMatchObject({
        kind: 'decision',
        message: 'Keep task state separate from durable profile memory.',
      });

      const patched = await server.inject({
        method: 'PATCH',
        url: `/v1/tasks/${taskId}`,
        payload: {
          status: 'completed',
          summary: 'Task API is usable.',
          plan: [
            { id: 'task_state', text: 'Add task state', status: 'completed' },
            { id: 'api', text: 'Expose service routes', status: 'completed' },
          ],
        },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().task.completedAt).toBeDefined();

      const listed = await server.inject({ method: 'GET', url: '/v1/tasks?status=completed' });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().tasks).toMatchObject([
        {
          id: taskId,
          status: 'completed',
          planCounts: { completed: 2 },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('exposes schedules read-only', async () => {
    const dir = tempDir();
    const loadedConfig = fixtureLoadedConfig(dir);
    fs.mkdirSync(path.join(dir, 'schedules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'schedules', 'sched_test1.json'), JSON.stringify({
      schema: 'marifold.schedule.v1',
      id: 'sched_test1',
      name: 'Daily digest',
      objective: 'Summarize the news.',
      cron: '0 9 * * *',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const listed = await server.inject({ method: 'GET', url: '/v1/schedules' });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().schedules).toMatchObject([{ id: 'sched_test1', name: 'Daily digest' }]);

      const single = await server.inject({ method: 'GET', url: '/v1/schedules/sched_test1' });
      expect(single.statusCode).toBe(200);
      expect(single.json().schedule.cron).toBe('0 9 * * *');

      const missing = await server.inject({ method: 'GET', url: '/v1/schedules/sched_nope' });
      expect(missing.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('aborts the in-flight provider stream when a chat-stream client disconnects', async () => {
    const realFetch = globalThis.fetch;
    let providerSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('localhost:11434')) {
        providerSignal = init?.signal ?? undefined;
        return stallingOllamaResponse(providerSignal);
      }
      return realFetch(input, init);
    }));

    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (typeof address !== 'object' || address === null) throw new Error('service did not report a listen address');
      const base = `http://127.0.0.1:${address.port}`;

      const clientAbort = new AbortController();
      const response = await realFetch(`${base}/v1/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hello', memories: false }),
        signal: clientAbort.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: chunk');

      expect(providerSignal?.aborted).toBe(false);
      clientAbort.abort();

      await vi.waitFor(() => {
        expect(providerSignal?.aborted).toBe(true);
      }, { timeout: 2000, interval: 10 });
    } finally {
      await server.close();
    }
  });

  it('routes ask through the core runtime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ollamaStreamResponse(['service ', 'response'])));
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/ask',
        payload: {
          prompt: 'Hello from service',
          memories: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().response).toMatchObject({
        ok: true,
        text: 'service response',
      });
    } finally {
      await server.close();
    }
  });
});

function fixtureLoadedConfig(dir: string): LoadedMarifoldConfig {
  const config: MarifoldConfig = {
    default: {
      provider: 'ollama',
      model: 'gemma4:e4b',
      profile: 'default',
      think: false,
    },
    models: {
      options: ['ollama/gemma4:e4b'],
    },
    memory: {
      sizeLimit: 50000,
      contextLimit: 2400,
    },
    paths: {
      profilesDir: path.join(dir, 'profiles'),
      sessionsDb: path.join(dir, 'sessions.db'),
      tasksDir: path.join(dir, 'tasks'),
      schedulesDir: path.join(dir, 'schedules'),
    },
    providers: {
      ollama: {
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        apiKey: 'test-secret-key',
      },
    },
  };
  return {
    config,
    configPath: path.join(dir, 'config.toml'),
    foundConfig: true,
  };
}

// Mimics real fetch semantics for a streaming Ollama chat response: one NDJSON
// chunk arrives, then the stream stalls until the request's AbortSignal fires,
// which rejects the pending read exactly the way undici does on abort.
function stallingOllamaResponse(signal: AbortSignal | undefined): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: 'hello' }, done: false })}\n`));
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('This operation was aborted', 'AbortError'));
        } catch {
          // stream already closed
        }
      }, { once: true });
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

// /v1/ask uses the SDK's non-streaming complete() since @priest-ai/core 2.4,
// so the fake returns one Ollama JSON object rather than NDJSON chunks.
function ollamaStreamResponse(chunks: string[]): Response {
  const body = JSON.stringify({
    message: { content: chunks.join('') },
    done: true,
    done_reason: 'stop',
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
