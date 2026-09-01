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
      const skills = res.json().skills as Array<{ name: string; description: string; usage: string }>;
      const echo = skills.find(skill => skill.name === 'echo');
      expect(echo).toMatchObject({ name: 'echo', description: 'Echo text back.', usage: '$echo <text>' });
      expect(skills.find(skill => skill.name === 'skill-installer')).toMatchObject({
        name: 'skill-installer',
        usage: '$skill-installer [command] [arguments]',
      });
      expect(skills.find(skill => skill.name === 'skill-creator')).toMatchObject({
        name: 'skill-creator',
        usage: '$skill-creator [request]',
      });
    } finally {
      await server.close();
    }
  });

  it('runs model-driven SkillApp state triggers and buttons without a profile', async () => {
    const dir = tempDir();
    const appDir = path.join(dir, 'apps', 'translator');
    fs.mkdirSync(path.join(appDir, 'skills', 'translate'), { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'skillapp.ts'),
      fs.readFileSync(
        path.resolve(process.cwd(), '../../examples/apps/translator/skillapp.ts'),
        'utf-8',
      ).replace('debounce: 1_000', 'debounce: 0'),
    );
    fs.copyFileSync(
      path.resolve(process.cwd(), '../../examples/apps/translator/skills/translate/SKILL.md'),
      path.join(appDir, 'skills', 'translate', 'SKILL.md'),
    );

    const providerBodies: Array<{ model?: string; messages?: Array<{ content?: string }>; think?: boolean }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        message: { content: '  Good morning  ' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 20,
        eval_count: 3,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const loaded = fixtureLoadedConfig(dir);
    loaded.config.paths.appsDir = path.join(dir, 'apps');
    const server = createMarifoldService({ loadedConfig: loaded, scheduler: false });
    try {
      const listed = await server.inject({ method: 'GET', url: '/v1/apps' });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().apps[0]).toMatchObject({
        schema: 'marifold.skillapp.v1',
        models: [{ provider: 'ollama', model: 'maternion/hy-mt2:1.8b' }],
        operations: [{ name: 'translate', requiredInputs: ['source', 'targetLanguage'], output: 'result' }],
      });

      const created = await server.inject({
        method: 'POST',
        url: '/v1/apps/translator/instances',
      });
      expect(created.statusCode).toBe(201);
      const instanceId = created.json().instance.id as string;

      const changed = await server.inject({
        method: 'PATCH',
        url: `/v1/app-instances/${instanceId}/state`,
        payload: { values: { source: '早上好', targetLanguage: 'English' } },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({
        status: 'completed',
        instance: { state: { source: '早上好', targetLanguage: 'English', result: 'Good morning' } },
        result: {
          status: 'ok',
          data: { text: 'Good morning' },
          meta: { engine: 'ollama', model: 'maternion/hy-mt2:1.8b' },
        },
      });

      const manual = await server.inject({
        method: 'POST',
        url: `/v1/app-instances/${instanceId}/operations/translate`,
      });
      expect(manual.statusCode).toBe(200);
      expect(manual.json()).toMatchObject({ status: 'completed', result: { status: 'ok' } });

      expect(providerBodies).toHaveLength(2);
      expect(providerBodies[0]).toMatchObject({ model: 'maternion/hy-mt2:1.8b', think: false });
      const context = providerBodies[0].messages?.map(message => message.content ?? '').join('\n') ?? '';
      expect(context).toContain('Translate the following text into English.');
      expect(context).toContain('早上好');
      expect(context).not.toContain('PROFILE TEXT');

      const emptied = await server.inject({
        method: 'PATCH',
        url: `/v1/app-instances/${instanceId}/state`,
        payload: { values: { source: '' } },
      });
      expect(emptied.json()).toMatchObject({
        status: 'idle',
        reason: 'missing_required_input',
        operation: 'translate',
        instance: {
          state: { source: '', result: 'Good morning' },
          staleOutputs: ['result'],
        },
      });
      expect(providerBodies).toHaveLength(2);

      const removed = await server.inject({
        method: 'DELETE',
        url: `/v1/app-instances/${instanceId}`,
      });
      expect(removed.json()).toMatchObject({ ok: true, deleted: true });
    } finally {
      await server.close();
    }
  });

  it('runs a profile SkillApp with profile docs and read-only bundled files', async () => {
    const dir = tempDir();
    const profileDir = path.join(dir, 'profiles', 'painter');
    const skillDir = path.join(profileDir, 'skills', 'make-prompt');
    const otherSkillDir = path.join(profileDir, 'skills', 'make-other-prompt');
    const appDir = path.join(dir, 'apps', 'painers-room');
    const sharedVars = path.join(dir, 'shared-vars.toml');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(otherSkillDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(sharedVars, 'woman = "reference subject"\n');
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Painter identity from PROFILE.md.\n');
    fs.writeFileSync(path.join(profileDir, 'RULES.md'), 'Painter rules from RULES.md.\n');
    fs.writeFileSync(path.join(profileDir, 'CUSTOM.md'), 'Painter custom context.\n');
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'mode = "agent"\nmemories = true\n');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: make-prompt\n---\nTurn the user idea into a production image prompt.\n',
    );
    fs.writeFileSync(path.join(skillDir, 'vars.toml'), 'look = "cinematic"\n');
    fs.writeFileSync(
      path.join(otherSkillDir, 'SKILL.md'),
      '---\nname: make-other-prompt\n---\nCreate the selected alternate prompt format.\n',
    );
    fs.writeFileSync(path.join(otherSkillDir, 'vars.toml'), 'look = "alternate"\n');
    fs.writeFileSync(path.join(appDir, 'skillapp.ts'), `
      import { App, AttachmentState, Attachments, Button, FileAccess, Row, Select, State, Textarea, TextResult, defineSkillApp, registerProfile, useProfileSkill } from '@marifold/core';
      const promptMakers = [
        { label: 'Prompt', value: 'make-prompt' },
        { label: 'Other', value: 'make-other-prompt' },
      ];
      const promptMaker = State('make-prompt');
      const idea = State('');
      const result = State('');
      const references = AttachmentState();
      const painter = registerProfile('painter', { memory: true, history: false });
      const makePrompt = useProfileSkill(painter, promptMaker, {
        skills: promptMakers,
        input: idea,
        attachments: references,
        stripSkillName: true,
        output: result,
        result: TextResult({ trim: true }),
      });
      export default defineSkillApp({
        app: { name: 'painers-room', title: "Painer's Room" },
        permissions: [FileAccess(${JSON.stringify(sharedVars)}, { access: 'read' })],
        ui: App([
          Row([Select('Prompt maker', promptMaker, { options: promptMakers })]),
          Row([Textarea('Idea', idea), Textarea('Prompt', result, { editable: false })]),
          Row([Attachments('Attachments', references)]),
          Row([Button('Make prompt', { trigger: makePrompt })]),
        ]),
      });
    `);

    const providerBodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        message: { content: '<memory_save>{"memories":[{"kind":"auto_short","text":"Should not save from an App."}]}</memory_save>  A cinematic lighthouse prompt.  ' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 30,
        eval_count: 6,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const loaded = fixtureLoadedConfig(dir);
    loaded.config.paths.appsDir = path.join(dir, 'apps');
    loaded.config.paths.profilesDir = path.join(dir, 'profiles');
    const server = createMarifoldService({ loadedConfig: loaded, scheduler: false });
    try {
      const remembered = await server.inject({
        method: 'POST',
        url: '/v1/profiles/painter/memories',
        payload: { text: 'The user prefers dramatic lighting.' },
      });
      expect(remembered.statusCode).toBe(200);

      const listed = await server.inject({ method: 'GET', url: '/v1/apps' });
      expect(listed.json().apps[0]).toMatchObject({
        schema: 'marifold.skillapp.v2',
        profiles: [{ profile: 'painter', memory: true, history: false }],
        operations: [{
          name: 'makePrompt',
          profile: 'painter',
          skillState: 'promptMaker',
          skillOptions: ['make-prompt', 'make-other-prompt'],
          input: 'idea',
          stripSkillName: true,
          requiredInputs: ['promptMaker', 'idea'],
          attachments: 'references',
        }],
      });
      expect(JSON.stringify(listed.json())).not.toContain(sharedVars);
      expect(listed.json().apps[0].permissions).toBeUndefined();

      const created = await server.inject({ method: 'POST', url: '/v1/apps/painers-room/instances' });
      const instanceId = created.json().instance.id as string;
      await server.inject({
        method: 'PATCH',
        url: `/v1/app-instances/${instanceId}/state`,
        payload: {
          values: {
            promptMaker: 'make-other-prompt',
            idea: '$make-prompt A lighthouse in a storm',
          },
        },
      });
      const attachmentData = Buffer.from('reference notes').toString('base64');
      const attached = await server.inject({
        method: 'PUT',
        url: `/v1/app-instances/${instanceId}/attachments/references`,
        payload: {
          attachments: [{
            kind: 'file',
            name: 'reference.txt',
            mediaType: 'text/plain',
            size: Buffer.byteLength('reference notes'),
            data: attachmentData,
            inspectionText: 'reference notes',
          }],
        },
      });
      expect(attached.statusCode).toBe(200);
      expect(attached.json().instance.attachments).toEqual({
        references: [{ kind: 'file', name: 'reference.txt', mediaType: 'text/plain', size: 15 }],
      });
      expect(JSON.stringify(attached.json())).not.toContain(attachmentData);
      const run = await server.inject({
        method: 'POST',
        url: `/v1/app-instances/${instanceId}/operations/makePrompt`,
      });
      expect(run.json()).toMatchObject({
        status: 'completed',
        instance: { state: { result: 'A cinematic lighthouse prompt.' } },
        result: {
          status: 'ok',
          meta: { engine: 'ollama', model: 'gemma4:e4b' },
        },
      });

      expect(providerBodies).toHaveLength(1);
      const context = JSON.stringify(providerBodies[0]);
      expect(context).toContain('Painter identity from PROFILE.md.');
      expect(context).toContain('Painter rules from RULES.md.');
      expect(context).toContain('Painter custom context.');
      expect(context).toContain('Create the selected alternate prompt format.');
      expect(context).not.toContain('Turn the user idea into a production image prompt.');
      expect(context).toContain('vars.toml');
      expect(context).toContain('A lighthouse in a storm');
      expect(context).not.toContain('$make-prompt A lighthouse in a storm');
      expect(context).toContain('The user prefers dramatic lighting.');
      expect(context).toContain('reference.txt');
      expect(context).toContain('inspect_attachment');

      const detached = await server.inject({
        method: 'PUT',
        url: `/v1/app-instances/${instanceId}/attachments/references`,
        payload: { attachments: [] },
      });
      expect(detached.json()).toMatchObject({
        status: 'idle',
        instance: {
          state: { result: 'A cinematic lighthouse prompt.' },
          staleOutputs: ['result'],
          attachments: { references: [] },
        },
      });

      const memories = await server.inject({ method: 'GET', url: '/v1/profiles/painter/memories' });
      expect(memories.json().memories).toHaveLength(1);
      expect(JSON.stringify(memories.json())).not.toContain('Should not save from an App.');
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
