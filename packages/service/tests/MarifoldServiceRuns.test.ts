import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarifoldConfig, resolveAgentConfig } from '@marifold/core';
import { createMarifoldService } from '../src';
import { cleanupTempDirs, fixtureLoadedConfig, tempDir } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupTempDirs();
});

// ── Harness ─────────────────────────────────────────────────────────────────

/** Fake the Ollama endpoint while passing every other URL (the test's own
 * calls to the Fastify server!) through to the real fetch. Miss the
 * passthrough and every request below deadlocks against the stub. */
function stubProvider(script: string[]): { captured: unknown[] } {
  const realFetch = globalThis.fetch;
  const captured: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('localhost:11434')) {
      const requestBody = init?.body ? JSON.parse(String(init.body)) : {};
      const index = captured.push(requestBody) - 1;
      const text = script[Math.min(index, script.length - 1)];
      return new Response(
        `${JSON.stringify({ message: { content: text }, done: true, done_reason: 'stop' })}\n`,
        {
          status: 200,
          headers: {
            'Content-Type': requestBody.stream === true
              ? 'application/x-ndjson'
              : 'application/json',
          },
        },
      );
    }
    return realFetch(input, init);
  }));
  return { captured };
}

async function startServer(
  overrides: Partial<MarifoldConfig> = {},
  options: { auth?: { token?: string } } = {},
): Promise<{ server: FastifyInstance; base: string }> {
  const loadedConfig = fixtureLoadedConfig(tempDir(), {
    // Control-block tool mode keeps the fake provider a plain text responder.
    agent: resolveAgentConfig({ toolMode: 'control-block' }),
    ...overrides,
  });
  const server = createMarifoldService({ loadedConfig, scheduler: false, ...options });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}` };
}

interface SseFrame {
  id?: number;
  event: string;
  data: Record<string, unknown>;
}

/** Parse an SSE body into frames, skipping heartbeats and retry hints. */
async function* sseFrames(response: Response): AsyncGenerator<SseFrame> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = parseSseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (frame) yield frame;
    }
  }
}

function parseSseBlock(block: string): SseFrame | undefined {
  let id: number | undefined;
  let event = '';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('id: ')) id = Number(line.slice(4));
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!event || !data) return undefined;
  return { id, event, data: JSON.parse(data) as Record<string, unknown> };
}

/** Pull frames until the predicate matches; the generator stays open so the
 * same stream can be pulled again after answering an approval. */
async function pullFrames(
  frames: AsyncGenerator<SseFrame>,
  predicate: (frame: SseFrame) => boolean,
): Promise<{ matched?: SseFrame; seen: SseFrame[] }> {
  const seen: SseFrame[] = [];
  while (true) {
    const result = await frames.next();
    if (result.done) return { seen };
    seen.push(result.value);
    if (predicate(result.value)) return { matched: result.value, seen };
  }
}

async function postJson(base: string, url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function toolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call name="${name}">${JSON.stringify(args)}</tool_call>`;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('MarifoldService /v1/runs', () => {
  it('resolves profile skill invocations directly instead of making the agent search for them', async () => {
    const root = tempDir();
    const profilesDir = path.join(root, 'profiles');
    const skillsDir = path.join(root, 'skills');
    const skillDir = path.join(profilesDir, 'prompt-maker', 'skills', 'make-prompt');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: make-prompt
description: Make a prompt.
mode: agent
variables:
  - name: text
    required: true
---
Transform {{text}} into the final prompt.
`);
    const { server, base } = await startServer({
      paths: {
        profilesDir,
        skillsDir,
        sessionsDb: path.join(root, 'sessions.db'),
        tasksDir: path.join(root, 'tasks'),
        schedulesDir: path.join(root, 'schedules'),
      },
    });
    try {
      const response = await postJson(base, '/v1/skills/resolve', {
        profile: 'prompt-maker',
        invocation: '$make-prompt "summer morning"',
      });
      expect(response.status).toBe(200);
      expect((await response.json()).invocation).toMatchObject({
        name: 'make-prompt',
        userTurn: '$make-prompt "summer morning"',
        prompt: 'summer morning',
        mode: 'agent',
        missing: [],
        usage: '$make-prompt <text>',
      });

      const missing = await postJson(base, '/v1/skills/resolve', {
        profile: 'prompt-maker',
        invocation: '$make-prompt',
      });
      expect((await missing.json()).invocation.missing).toEqual(['text']);

      const unknown = await postJson(base, '/v1/skills/resolve', {
        profile: 'prompt-maker',
        invocation: '$missing-skill x',
      });
      expect(unknown.status).toBe(404);
      expect((await unknown.json()).error.code).toBe('SKILL_NOT_FOUND');

      const unsafeProfile = await postJson(base, '/v1/skills/resolve', {
        profile: '../prompt-maker',
        invocation: '$make-prompt x',
      });
      expect(unsafeProfile.status).toBe(400);
      expect((await unsafeProfile.json()).error.code).toBe('PROFILE_INVALID');
    } finally {
      await server.close();
    }
  });

  it('runs an objective end-to-end over SSE and links the durable task', async () => {
    stubProvider(['All done, no tools needed.']);
    const { server, base } = await startServer();
    try {
      const created = await postJson(base, '/v1/runs', { objective: 'Say hi.', cwd: tempDir() });
      expect(created.status).toBe(201);
      const { run } = await created.json();
      expect(run.id).toMatch(/^run_/);

      const stream = await fetch(`${base}/v1/runs/${run.id}/events`);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const { seen } = await pullFrames(sseFrames(stream), () => false);

      expect(seen[0].event).toBe('status');
      expect(seen[0].id).toBe(1);
      expect(seen[0].data).toMatchObject({ type: 'status', status: 'running' });
      const done = seen[seen.length - 1];
      expect(done.event).toBe('done');
      expect(done.data).toMatchObject({ type: 'done', status: 'completed' });
      expect(seen.some(frame => frame.event === 'text')).toBe(true);

      const record = await (await fetch(`${base}/v1/runs/${run.id}`)).json();
      expect(record.run).toMatchObject({ status: 'completed', taskId: done.data.taskId });
      expect(record.run.eventCount).toBe(seen.length);

      const task = await fetch(`${base}/v1/tasks/${done.data.taskId}`);
      expect(task.status).toBe(200);
      expect((await task.json()).task.tags).toContain('service');
    } finally {
      await server.close();
    }
  });

  it('persists the original skill invocation instead of its model-facing objective', async () => {
    const { captured } = stubProvider(['Grok-style final prompt.']);
    const { server, base } = await startServer();
    try {
      const created = await postJson(base, '/v1/runs', {
        objective: 'summer morning',
        userTurn: '$make-grok-imagine-prompt "summer morning"',
        instructions: ['Return one concise Grok Imagine prompt.'],
        sessionId: 'direct-skill',
        lean: true,
        cwd: tempDir(),
      });
      expect(created.status).toBe(201);
      const { run } = await created.json();
      await pullFrames(
        sseFrames(await fetch(`${base}/v1/runs/${run.id}/events`)),
        frame => frame.event === 'done',
      );

      const detail = await (await fetch(`${base}/v1/sessions/direct-skill`)).json();
      expect(detail.session.turns.map((turn: { content: string }) => turn.content)).toEqual([
        '$make-grok-imagine-prompt "summer morning"',
        'Grok-style final prompt.',
      ]);
      expect(detail.session.turns[1].responseMetrics).toMatchObject({
        mode: 'agent',
        provider: 'ollama',
        model: 'gemma4:e4b',
        think: false,
        latencyMs: expect.any(Number),
      });
      expect(JSON.stringify(captured)).toContain('Return one concise Grok Imagine prompt.');
      expect(JSON.stringify(captured)).not.toContain('$make-grok-imagine-prompt');
    } finally {
      await server.close();
    }
  });

  it('preserves the original invocation for skills that declare chat mode', async () => {
    stubProvider(['Concise chat-mode prompt.']);
    const { server, base } = await startServer();
    try {
      const response = await postJson(base, '/v1/chat/stream', {
        prompt: 'summer morning',
        userTurn: '$make-short-prompt "summer morning"',
        instructions: ['Return one concise prompt.'],
        sessionId: 'direct-chat-skill',
        isolated: true,
        memories: false,
      });
      expect(response.status).toBe(200);
      await pullFrames(sseFrames(response), () => false);

      const detail = await (await fetch(`${base}/v1/sessions/direct-chat-skill`)).json();
      expect(detail.session.turns.map((turn: { content: string }) => turn.content)).toEqual([
        '$make-short-prompt "summer morning"',
        'Concise chat-mode prompt.',
      ]);
    } finally {
      await server.close();
    }
  });

  it('forwards image attachments on the objective to the model request', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=';
    const { captured } = stubProvider(['A tiny test image.']);
    const { server, base } = await startServer();
    try {
      const created = await postJson(base, '/v1/runs', {
        objective: 'What is in this image?',
        cwd: tempDir(),
        originalImages: true,
        images: [{ data: png, mediaType: 'image/png' }],
      });
      expect(created.status).toBe(201);
      const { run } = await created.json();
      await pullFrames(sseFrames(await fetch(`${base}/v1/runs/${run.id}/events`)), frame => frame.event === 'done');
      // The base64 payload must reach the provider request on the first turn.
      expect(JSON.stringify(captured)).toContain(png);

      const invalid = await postJson(base, '/v1/runs', { objective: 'x', images: [{}] });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.message).toContain('exactly one of data or url');
    } finally {
      await server.close();
    }
  });

  it('stages binary files read-only and tells the model their run input path', async () => {
    const { captured } = stubProvider(['I found the workbook.']);
    const { server, base } = await startServer();
    let runDir: string | undefined;
    try {
      const data = Buffer.from('test-workbook-bytes').toString('base64');
      const created = await postJson(base, '/v1/runs', {
        objective: 'Inspect the workbook.',
        cwd: tempDir(),
        files: [{
          name: '../budget.xlsx',
          mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data,
        }],
      });
      expect(created.status).toBe(201);
      const { run } = await created.json();
      runDir = path.join(os.homedir(), '.marifold', 'runs', run.id);
      await pullFrames(sseFrames(await fetch(`${base}/v1/runs/${run.id}/events`)), frame => frame.event === 'done');

      const staged = path.join(runDir, 'input', 'budget.xlsx');
      expect(fs.readFileSync(staged, 'utf8')).toBe('test-workbook-bytes');
      expect(fs.statSync(staged).mode & 0o222).toBe(0);
      expect(JSON.stringify(captured)).toContain(staged);

      const invalid = await postJson(base, '/v1/runs', {
        objective: 'x',
        files: [{ name: 'x.xlsx', mediaType: 'application/octet-stream', data: 'not base64!' }],
      });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.message).toContain('must be base64');
    } finally {
      if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
      await server.close();
    }
  });

  it('parks an ask-gated write until the approval POST, then executes it', async () => {
    const workspace = tempDir();
    const target = path.join(workspace, 'note.txt');
    stubProvider([
      toolCall('write_file', { path: target, content: 'approved content' }),
      'Wrote the note.',
    ]);
    const { server, base } = await startServer();
    try {
      const { run } = await (await postJson(base, '/v1/runs', { objective: 'Write a note.', cwd: workspace })).json();
      const frames = sseFrames(await fetch(`${base}/v1/runs/${run.id}/events`));
      const { matched } = await pullFrames(frames, frame => frame.event === 'approval_request');
      const request = (matched!.data as { request: { id: string; tool: string } }).request;
      expect(request.tool).toBe('write_file');
      expect(fs.existsSync(target)).toBe(false);

      const answered = await postJson(base, `/v1/runs/${run.id}/approvals/${request.id}`, { action: 'once' });
      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ ok: true, requestId: request.id, approved: true });

      const { seen } = await pullFrames(frames, frame => frame.event === 'done');
      expect(seen.some(f => f.event === 'approval_decision' && f.data.approved === true && f.data.source === 'user')).toBe(true);
      expect(seen[seen.length - 1].data).toMatchObject({ status: 'completed' });
      expect(fs.readFileSync(target, 'utf-8')).toBe('approved content');
    } finally {
      await server.close();
    }
  });

  it('deny surfaces a denied decision and an isError tool result', async () => {
    const workspace = tempDir();
    stubProvider([
      toolCall('write_file', { path: path.join(workspace, 'x.txt'), content: 'x' }),
      'Understood, stopping.',
    ]);
    const { server, base } = await startServer();
    try {
      const { run } = await (await postJson(base, '/v1/runs', { objective: 'Write.', cwd: workspace })).json();
      const frames = sseFrames(await fetch(`${base}/v1/runs/${run.id}/events`));
      const { matched } = await pullFrames(frames, frame => frame.event === 'approval_request');
      const requestId = (matched!.data as { request: { id: string } }).request.id;

      const answered = await postJson(base, `/v1/runs/${run.id}/approvals/${requestId}`, { action: 'deny' });
      expect((await answered.json()).approved).toBe(false);

      const { seen } = await pullFrames(frames, frame => frame.event === 'done');
      expect(seen.some(f => f.event === 'tool_result' && f.data.isError === true)).toBe(true);
      expect(fs.existsSync(path.join(workspace, 'x.txt'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('cancel while an approval is pending finishes the run as cancelled immediately', async () => {
    const workspace = tempDir();
    stubProvider([toolCall('write_file', { path: path.join(workspace, 'x.txt'), content: 'x' })]);
    const { server, base } = await startServer();
    try {
      const { run } = await (await postJson(base, '/v1/runs', { objective: 'Write.', cwd: workspace })).json();
      const frames = sseFrames(await fetch(`${base}/v1/runs/${run.id}/events`));
      await pullFrames(frames, frame => frame.event === 'approval_request');

      const cancelled = await postJson(base, `/v1/runs/${run.id}/cancel`, {});
      expect(cancelled.status).toBe(202);

      const { matched } = await pullFrames(frames, frame => frame.event === 'done');
      expect(matched!.data).toMatchObject({ status: 'cancelled' });
      const record = await (await fetch(`${base}/v1/runs/${run.id}`)).json();
      expect(record.run.status).toBe('cancelled');
    } finally {
      await server.close();
    }
  });

  it('steer lands on the next model turn and is echoed as a steering event', async () => {
    const workspace = tempDir();
    const { captured } = stubProvider([
      toolCall('write_file', { path: path.join(workspace, 'draft.txt'), content: 'v1' }),
      'Done, guidance applied.',
    ]);
    const { server, base } = await startServer();
    try {
      const { run } = await (await postJson(base, '/v1/runs', { objective: 'Draft it.', cwd: workspace })).json();
      const frames = sseFrames(await fetch(`${base}/v1/runs/${run.id}/events`));
      const { matched } = await pullFrames(frames, frame => frame.event === 'approval_request');
      const requestId = (matched!.data as { request: { id: string } }).request.id;

      // The pending approval is the deterministic pause: guidance queued now
      // must be drained before the next (second) model turn.
      const steered = await postJson(base, `/v1/runs/${run.id}/steer`, { text: 'prefer bullet points' });
      expect(steered.status).toBe(202);
      await postJson(base, `/v1/runs/${run.id}/approvals/${requestId}`, { action: 'once' });

      const { seen } = await pullFrames(frames, frame => frame.event === 'done');
      expect(seen.some(f => f.event === 'steering' && f.data.text === 'prefer bullet points')).toBe(true);
      expect(JSON.stringify(captured[1])).toContain('prefer bullet points');
    } finally {
      await server.close();
    }
  });

  it('replays events with Last-Event-ID and in full for late subscribers', async () => {
    stubProvider(['All done.']);
    const { server, base } = await startServer();
    try {
      const { run } = await (await postJson(base, '/v1/runs', { objective: 'Quick.', cwd: tempDir() })).json();
      const { seen: live } = await pullFrames(sseFrames(await fetch(`${base}/v1/runs/${run.id}/events`)), () => false);
      expect(live.length).toBeGreaterThan(1);

      const { seen: replay } = await pullFrames(sseFrames(await fetch(`${base}/v1/runs/${run.id}/events`)), () => false);
      expect(replay).toEqual(live);

      const resumed = await fetch(`${base}/v1/runs/${run.id}/events`, {
        headers: { 'Last-Event-ID': String(live[0].id) },
      });
      const { seen: tail } = await pullFrames(sseFrames(resumed), () => false);
      expect(tail).toEqual(live.slice(1));
    } finally {
      await server.close();
    }
  });

  it('enforces the active-run limit with 429', async () => {
    const workspace = tempDir();
    // Every run parks at an approval, so five stay active concurrently.
    stubProvider([toolCall('write_file', { path: path.join(workspace, 'x.txt'), content: 'x' })]);
    const { server, base } = await startServer();
    try {
      const runIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const created = await postJson(base, '/v1/runs', { objective: `Run ${i}.`, cwd: workspace });
        expect(created.status).toBe(201);
        runIds.push((await created.json()).run.id);
      }
      const overflow = await postJson(base, '/v1/runs', { objective: 'One too many.', cwd: workspace });
      expect(overflow.status).toBe(429);
      expect((await overflow.json()).error.code).toBe('RUN_LIMIT_EXCEEDED');

      for (const id of runIds) await postJson(base, `/v1/runs/${id}/cancel`, {});
    } finally {
      await server.close();
    }
  });

  it('returns typed 404s for unknown runs and validates bodies', async () => {
    stubProvider(['unused']);
    const { server, base } = await startServer();
    try {
      const missing = await fetch(`${base}/v1/runs/run_nope`);
      expect(missing.status).toBe(404);
      expect((await missing.json()).error.code).toBe('RUN_NOT_FOUND');

      const badBody = await postJson(base, '/v1/runs', { objective: '' });
      expect(badBody.status).toBe(400);

      const badAction = await postJson(base, '/v1/runs', { objective: 'ok', maxIterations: -2 });
      expect(badAction.status).toBe(400);

      const badEdit = await postJson(base, '/v1/runs', {
        objective: 'ok',
        sessionId: 'session_1',
        replaceUserTurnIndex: -1,
      });
      expect(badEdit.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('accepts ?access_token= on the events stream when auth is on', async () => {
    stubProvider(['All done.']);
    const { server, base } = await startServer({}, { auth: { token: 'sekret' } });
    try {
      const created = await postJson(base, '/v1/runs', { objective: 'Quick.', cwd: tempDir() }, {
        authorization: 'Bearer sekret',
      });
      expect(created.status).toBe(201);
      const { run } = await created.json();

      const noToken = await fetch(`${base}/v1/runs/${run.id}/events`);
      expect(noToken.status).toBe(401);

      const wrongToken = await fetch(`${base}/v1/runs/${run.id}/events?access_token=nope`);
      expect(wrongToken.status).toBe(401);

      const viaQuery = await fetch(`${base}/v1/runs/${run.id}/events?access_token=sekret`);
      expect(viaQuery.status).toBe(200);
      const { seen } = await pullFrames(sseFrames(viaQuery), () => false);
      expect(seen[seen.length - 1].event).toBe('done');
    } finally {
      await server.close();
    }
  });
});
