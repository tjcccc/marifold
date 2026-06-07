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
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()) });
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
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()) });
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

  it('routes ask through the core runtime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ollamaStreamResponse(['service ', 'response'])));
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()) });
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

function ollamaStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: chunk } })}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}
