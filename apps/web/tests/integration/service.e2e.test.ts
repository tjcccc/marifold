import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentConfig, type LoadedMarifoldConfig } from '@marifold/core';
import { createMarifoldService } from '@marifold/service';
import { streamChat } from '../../src/api/chat';
import { createApiClient } from '../../src/api/client';
import { putProfileFile, updateProfile } from '../../src/api/profiles';
import { answerApproval, followRun, startRun } from '../../src/api/runs';
import type { AgentEvent } from '../../src/api/types';

/**
 * The one place the web client's fetch/SSE code meets real Fastify framing:
 * a real service on a random port, driven end-to-end by the real ApiClient.
 * Only the model endpoint is faked (passthrough stub: every non-Ollama URL —
 * including this test's own requests to the service — uses the real fetch).
 */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-web-e2e-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureLoadedConfig(dir: string): LoadedMarifoldConfig {
  return {
    config: {
      default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', think: false },
      models: { options: ['ollama/gemma4:e4b'] },
      memory: { sizeLimit: 50000, contextLimit: 2400 },
      paths: {
        profilesDir: path.join(dir, 'profiles'),
        sessionsDb: path.join(dir, 'sessions.db'),
        tasksDir: path.join(dir, 'tasks'),
        schedulesDir: path.join(dir, 'schedules'),
      },
      providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
      agent: resolveAgentConfig({ toolMode: 'control-block' }),
    },
    configPath: path.join(dir, 'config.toml'),
    foundConfig: true,
  };
}

/** Fake the Ollama endpoint; pass everything else through to the real fetch. */
function stubProvider(script: Array<string | string[]>): void {
  const realFetch = globalThis.fetch;
  let call = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('localhost:11434')) return realFetch(input, init);
    const entry = script[Math.min(call, script.length - 1)];
    call += 1;
    if (Array.isArray(entry)) {
      // Streaming NDJSON (the chat path): one line per chunk, then done.
      const lines = [
        ...entry.map(text => JSON.stringify({ message: { content: text }, done: false })),
        JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }),
      ].join('\n');
      return new Response(`${lines}\n`, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    return new Response(
      JSON.stringify({ message: { content: entry }, done: true, done_reason: 'stop' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }));
}

async function startServer(): Promise<{ server: ReturnType<typeof createMarifoldService>; base: string }> {
  const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe('web client ↔ real service', () => {
  it('streams a chat turn chunk by chunk through the real SSE framing', async () => {
    stubProvider([['Hello ', 'from ', 'marifold']]);
    const { server, base } = await startServer();
    try {
      const client = createApiClient({ baseUrl: base });
      const chunks: string[] = [];
      let done = false;
      for await (const event of streamChat(client, { prompt: 'Hi', memories: false })) {
        if (event.type === 'chunk') chunks.push(event.text);
        if (event.type === 'done') done = true;
        expect(event.type).not.toBe('error');
      }
      expect(chunks.join('')).toBe('Hello from marifold');
      expect(done).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('drives a run end-to-end: follow, approve once, file written, done', async () => {
    const workspace = tempDir();
    const target = path.join(workspace, 'note.txt');
    stubProvider([
      `<tool_call name="write_file">${JSON.stringify({ path: target, content: 'approved' })}</tool_call>`,
      'Wrote it.',
    ]);
    const { server, base } = await startServer();
    try {
      const client = createApiClient({ baseUrl: base });
      const run = await startRun(client, { objective: 'Write the note.', cwd: workspace });

      const events: Array<{ seq: number; event: AgentEvent }> = [];
      for await (const entry of followRun(client, run.id)) {
        events.push(entry);
        if (entry.event.type === 'approval_request') {
          const result = await answerApproval(client, run.id, entry.event.request.id, 'once');
          expect(result.approved).toBe(true);
        }
      }

      const last = events.at(-1)!.event;
      expect(last).toMatchObject({ type: 'done', status: 'completed' });
      expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1)); // gapless
      expect(fs.readFileSync(target, 'utf-8')).toBe('approved');

      // Resume from the middle: only later sequences replay.
      const midpoint = Math.floor(events.length / 2);
      const tail: number[] = [];
      for await (const entry of followRun(client, run.id, { afterSeq: midpoint })) {
        tail.push(entry.seq);
      }
      expect(tail).toEqual(events.slice(midpoint).map(e => e.seq));
    } finally {
      await server.close();
    }
  });

  it('edits a profile through the real PATCH route (settings + file, on disk)', async () => {
    const dir = tempDir();
    const loadedConfig = fixtureLoadedConfig(dir);
    const profileDir = path.join(dir, 'profiles', 'writer');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), '# writer');
    fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'memories = true\n');

    const server = createMarifoldService({ loadedConfig, scheduler: false });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    try {
      const client = createApiClient({ baseUrl: base });
      const patched = await updateProfile(client, 'writer', {
        mode: 'chat',
        memories: false,
        approval: { shell: 'deny' },
      });
      expect(patched.settings).toMatchObject({ mode: 'chat', memories: false });
      expect(patched.settings.agent?.approval?.shell).toBe('deny');

      const withRules = await putProfileFile(client, 'writer', 'rules', '# Web-edited rules');
      expect(withRules.files.rules.content).toBe('# Web-edited rules');
      // The writes are on disk, not just in the response.
      expect(fs.readFileSync(path.join(profileDir, 'RULES.md'), 'utf-8')).toBe('# Web-edited rules');
      expect(fs.readFileSync(path.join(profileDir, 'profile.toml'), 'utf-8')).toContain('mode = "chat"');
    } finally {
      await server.close();
    }
  });
});
