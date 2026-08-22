import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionResolver } from '@marifold/core';
import { createMarifoldService } from '../src';
import { cleanupTempDirs, fixtureLoadedConfig, ollamaStreamResponse, tempDir } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupTempDirs();
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

  it('GET /v1/skills lists available skills with usage for the composer', async () => {
    const dir = tempDir();
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'echo'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'echo', 'SKILL.md'),
      '---\nname: echo\ndescription: Echo text back.\nvariables:\n  - name: text\n    required: true\n---\n{{text}}\n',
    );
    const loaded = fixtureLoadedConfig(dir);
    loaded.config.paths.skillsDir = skillsDir;
    const server = createMarifoldService({ loadedConfig: loaded, scheduler: false });
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/skills' });
      expect(res.statusCode).toBe(200);
      const echo = res.json().skills.find((skill: { name: string }) => skill.name === 'echo');
      expect(echo).toMatchObject({ name: 'echo', description: 'Echo text back.', usage: '$echo <text>' });
    } finally {
      await server.close();
    }
  });

  it('lists and streams a global App actor without writing an Agent transcript', async () => {
    const dir = tempDir();
    const profileDir = path.join(dir, 'profiles', 'app_tester');
    const postmanDir = path.join(dir, 'profiles', 'postman');
    const appDir = path.join(dir, 'apps', 'translator');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'skills', 'translate'), { recursive: true });
    fs.mkdirSync(path.join(postmanDir, 'skills', 'translate'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'PROFILE TEXT THAT MUST BE OMITTED');
    fs.writeFileSync(
      path.join(profileDir, 'profile.toml'),
      'provider = "ollama"\nmodel = "gemma4:e4b"\nmode = "chat"\nmemories = false\nthink = false\n',
    );
    fs.writeFileSync(
      path.join(postmanDir, 'profile.toml'),
      'provider = "ollama"\nmodel = "gemma4:e4b"\nmode = "chat"\nmemories = false\nthink = false\n',
    );
    fs.writeFileSync(
      path.join(appDir, 'app.toml'),
      `${fs.readFileSync(path.resolve(process.cwd(), '../../examples/apps/translator/app.toml'), 'utf-8')}

[[actors]]
name = "secondary"
profile = "postman"

[[actions]]
name = "translate_secondary"
kind = "skill"
actor = "secondary"
skill = "translate"
arguments = { source_text = "{{source_text}}", target_language = "{{target_language}}" }
output = "translated_text"
`,
    );
    fs.copyFileSync(
      path.resolve(process.cwd(), '../../examples/profiles/app_tester/skills/translate/SKILL.md'),
      path.join(profileDir, 'skills', 'translate', 'SKILL.md'),
    );
    fs.writeFileSync(
      path.join(postmanDir, 'skills', 'translate', 'SKILL.md'),
      `---
name: translate
mode: chat
variables:
  - name: source_text
    required: true
  - name: target_language
    required: true
---
Secondary actor instruction: translate {{source_text}} into {{target_language}}.
`,
    );

    let providerBody: {
      messages?: Array<{ content?: string }>;
      think?: boolean;
    } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      const lines = [
        JSON.stringify({ message: { content: 'おはよう' }, done: false }),
        JSON.stringify({
          message: { content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 40,
          eval_count: 4,
        }),
      ].join('\n');
      return new Response(`${lines}\n`, {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }));

    const loaded = fixtureLoadedConfig(dir);
    loaded.config.paths.appsDir = path.join(dir, 'apps');
    const server = createMarifoldService({ loadedConfig: loaded, scheduler: false });
    try {
      const listed = await server.inject({
        method: 'GET',
        url: '/v1/apps',
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().apps[0]).toMatchObject({
        app: { name: 'translator', version: '1.0.0' },
        actors: [
          { name: 'translator', profile: 'app_tester' },
          { name: 'secondary', profile: 'postman' },
        ],
        execution: { think: false, memory: false, profileContext: false },
      });

      const streamed = await server.inject({
        method: 'POST',
        url: '/v1/apps/translator/actions/translate/stream',
        payload: {
          values: { source_text: 'Good morning', target_language: 'Japanese' },
        },
      });
      expect(streamed.statusCode).toBe(200);
      expect(streamed.body).toContain('data: {"text":"おはよう"}');
      expect(streamed.body).toContain('"totalTokens":44');

      const context = providerBody?.messages?.map(message => message.content ?? '').join('\n') ?? '';
      expect(context).toContain('Translate the following text into Japanese.');
      expect(context).toContain('Good morning');
      expect(context).not.toContain('PROFILE TEXT THAT MUST BE OMITTED');
      expect(context).not.toContain('bundled files');
      expect(context).not.toContain('vars.toml');
      expect(context).not.toContain('read_file');
      expect(providerBody?.think).toBe(false);

      const secondary = await server.inject({
        method: 'POST',
        url: '/v1/apps/translator/actions/translate_secondary/stream',
        payload: {
          values: { source_text: 'Good night', target_language: 'Japanese' },
        },
      });
      expect(secondary.statusCode).toBe(200);
      const secondaryContext = providerBody?.messages?.map(message => message.content ?? '').join('\n') ?? '';
      expect(secondaryContext).toContain('Secondary actor instruction');
      expect(secondaryContext).toContain('Good night');

      const sessions = await server.inject({
        method: 'GET',
        url: '/v1/sessions?profile=app_tester',
      });
      expect(sessions.json().sessions).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('POST /v1/profiles/:name/memories saves a memory (the /remember command)', async () => {
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/profiles/default/memories',
        payload: { text: 'Prefers en dashes over em dashes.' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().memories.some((memory: { text: string }) => memory.text.includes('en dashes'))).toBe(true);

      const empty = await server.inject({
        method: 'POST',
        url: '/v1/profiles/default/memories',
        payload: { text: '   ' },
      });
      expect(empty.statusCode).toBe(400);
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

  it('blocks session deletion until an active chat stream disconnects', async () => {
    const realFetch = globalThis.fetch;
    let providerSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('localhost:11434')) {
        providerSignal = init?.signal ?? undefined;
        return stallingOllamaResponse(providerSignal);
      }
      return realFetch(input, init);
    }));

    const dir = tempDir();
    const loaded = fixtureLoadedConfig(dir);
    const sessions = new SessionResolver(loaded.config.paths.sessionsDb);
    await sessions.appendExchange('session_chatting', 'default', 'Earlier question', 'Earlier answer');
    sessions.close();

    const server = createMarifoldService({ loadedConfig: loaded, scheduler: false });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (typeof address !== 'object' || address === null) throw new Error('service did not report a listen address');
      const base = `http://127.0.0.1:${address.port}`;

      const clientAbort = new AbortController();
      const response = await realFetch(`${base}/v1/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Keep chatting.',
          profile: 'default',
          sessionId: 'session_chatting',
          memories: false,
        }),
        signal: clientAbort.signal,
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: chunk');

      const blocked = await realFetch(`${base}/v1/sessions/session_chatting`, { method: 'DELETE' });
      expect(blocked.status).toBe(400);
      expect((await blocked.json()).error.code).toBe('AGENT_RUN_INVALID');

      clientAbort.abort();
      await vi.waitFor(() => {
        expect(providerSignal?.aborted).toBe(true);
      }, { timeout: 2000, interval: 10 });

      let deletedBody: { deleted?: boolean } | undefined;
      await vi.waitFor(async () => {
        const deleted = await realFetch(`${base}/v1/sessions/session_chatting`, { method: 'DELETE' });
        expect(deleted.status).toBe(200);
        deletedBody = await deleted.json() as { deleted?: boolean };
      }, { timeout: 2000, interval: 20 });
      expect(deletedBody?.deleted).toBe(true);
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

  it('streams provider failures as errors instead of blank completed replies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/stream',
        payload: { prompt: 'Hello', sessionId: 'failed-chat', memories: false },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('event: error');
      expect(response.body).toContain('"code":"PROVIDER_ERROR"');
      expect(response.body).toContain('HTTP 429');
      expect(response.body).not.toContain('event: chunk');

      const session = await server.inject({ method: 'GET', url: '/v1/sessions/failed-chat' });
      expect(session.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('streams safe Responses reasoning separately without exposing opaque continuation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const events = [
        { type: 'response.reasoning_summary_text.delta', delta: 'Checked safely.' },
        { type: 'response.output_text.delta', delta: 'Final answer.' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: {
              input_tokens: 120,
              output_tokens: 30,
              output_tokens_details: { reasoning_tokens: 20 },
            },
            output: [
              {
                type: 'reasoning',
                id: 'rs_1',
                summary: [{ type: 'summary_text', text: 'Checked safely.' }],
                encrypted_content: 'private-opaque-state',
              },
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'Final answer.' }],
              },
            ],
          },
        },
      ];
      return new Response(
        events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }));

    const dir = tempDir();
    const loaded = fixtureLoadedConfig(dir, {
      default: {
        provider: 'chatgpt',
        model: 'gpt-5-codex',
        profile: 'default',
        think: true,
      },
      models: { options: ['chatgpt/gpt-5-codex'] },
      providers: {
        chatgpt: {
          type: 'openai-compatible',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          apiKey: 'test-access-token',
        },
      },
    });
    const server = createMarifoldService({ loadedConfig: loaded, scheduler: false });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/stream',
        payload: { prompt: 'Answer safely.', sessionId: 'chat-metrics', memories: false },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body.indexOf('event: reasoning')).toBeLessThan(response.body.indexOf('event: chunk'));
      expect(response.body).toContain('data: {"text":"Checked safely."}');
      expect(response.body).toContain('data: {"text":"Final answer."}');
      expect(response.body).toContain('"usage":{"inputTokens":120,"outputTokens":30,"totalTokens":150,"reasoningTokens":20}');
      expect(response.body).toMatch(/"latencyMs":\d+/);
      expect(response.body).not.toContain('private-opaque-state');

      const session = await server.inject({ method: 'GET', url: '/v1/sessions/chat-metrics' });
      expect(session.statusCode).toBe(200);
      expect(session.json().session.turns[1]).toMatchObject({
        role: 'assistant',
        content: 'Final answer.',
        responseMetrics: {
          mode: 'chat',
          provider: 'chatgpt',
          model: 'gpt-5-codex',
          think: true,
          latencyMs: expect.any(Number),
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
            reasoningTokens: 20,
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it('truncates a session from an edited user turn', async () => {
    const dir = tempDir();
    const loaded = fixtureLoadedConfig(dir);
    const sessions = new SessionResolver(loaded.config.paths.sessionsDb);
    await sessions.appendExchange('session_edit', 'default', 'Conversation 1', 'Answer 1');
    await sessions.appendExchange('session_edit', 'default', 'Conversation 2', 'Answer 2');
    await sessions.appendExchange('session_edit', 'default', 'Conversation 3', 'Answer 3');
    sessions.close();

    const server = createMarifoldService({ loadedConfig: loaded, scheduler: false });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/sessions/session_edit/truncate',
        payload: { fromUserTurnIndex: 1 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ truncated: true, removedTurns: 4 });

      const detail = await server.inject({ method: 'GET', url: '/v1/sessions/session_edit' });
      expect(detail.json().session.turns.map((turn: { content: string }) => turn.content)).toEqual([
        'Conversation 1',
        'Answer 1',
      ]);

      const invalid = await server.inject({
        method: 'POST',
        url: '/v1/sessions/session_edit/truncate',
        payload: { fromUserTurnIndex: -1 },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('updates durable session display metadata without changing the transcript', async () => {
    const dir = tempDir();
    const loaded = fixtureLoadedConfig(dir);
    const sessions = new SessionResolver(loaded.config.paths.sessionsDb);
    await sessions.appendExchange('session_display', 'default', 'Original prompt', 'Original answer');
    sessions.close();

    const server = createMarifoldService({ loadedConfig: loaded, scheduler: false });
    try {
      const response = await server.inject({
        method: 'PATCH',
        url: '/v1/sessions/session_display',
        payload: { title: 'Renamed chat', pinned: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().session).toMatchObject({
        id: 'session_display',
        title: 'Renamed chat',
        pinned: true,
        preview: 'Original prompt',
      });

      const detail = await server.inject({ method: 'GET', url: '/v1/sessions/session_display' });
      expect(detail.json().session.turns.map((turn: { content: string }) => turn.content)).toEqual([
        'Original prompt',
        'Original answer',
      ]);

      const missing = await server.inject({
        method: 'PATCH',
        url: '/v1/sessions/session_missing',
        payload: { pinned: true },
      });
      expect(missing.statusCode).toBe(404);

      const invalid = await server.inject({
        method: 'PATCH',
        url: '/v1/sessions/session_display',
        payload: { title: '' },
      });
      expect(invalid.statusCode).toBe(400);

      const archived = await server.inject({
        method: 'PATCH',
        url: '/v1/sessions/session_display',
        payload: { archived: true },
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().session.archived).toBe(true);
      expect((await server.inject({ method: 'GET', url: '/v1/sessions?profile=default' })).json().sessions)
        .toEqual([]);
      expect((await server.inject({
        method: 'GET',
        url: '/v1/sessions?profile=default&archived=true&q=renamed',
      })).json().sessions).toMatchObject([{ id: 'session_display', archived: true }]);
    } finally {
      await server.close();
    }
  });

  it('refuses to delete a session while its run is active', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('localhost:11434')) return stallingOllamaResponse(init?.signal ?? undefined);
      return realFetch(input, init);
    }));
    const dir = tempDir();
    const loaded = fixtureLoadedConfig(dir);
    const sessions = new SessionResolver(loaded.config.paths.sessionsDb);
    await sessions.appendExchange('session_running', 'default', 'Earlier question', 'Earlier answer');
    sessions.close();
    const server = createMarifoldService({ loadedConfig: loaded, scheduler: false });
    try {
      const started = await server.inject({
        method: 'POST',
        url: '/v1/runs',
        payload: {
          objective: 'Keep working.',
          profile: 'default',
          sessionId: 'session_running',
        },
      });
      const runId = started.json().run.id as string;
      const blocked = await server.inject({ method: 'DELETE', url: '/v1/sessions/session_running' });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().error.code).toBe('AGENT_RUN_INVALID');

      await server.inject({ method: 'POST', url: `/v1/runs/${runId}/cancel`, payload: {} });
      await vi.waitFor(async () => {
        const listed = await server.inject({ method: 'GET', url: '/v1/runs' });
        expect(listed.json().runs.find((run: { id: string }) => run.id === runId)?.status).not.toBe('running');
      }, { timeout: 2000, interval: 20 });
      const deleted = await server.inject({ method: 'DELETE', url: '/v1/sessions/session_running' });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().deleted).toBe(true);
    } finally {
      await server.close();
    }
  });
});

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
