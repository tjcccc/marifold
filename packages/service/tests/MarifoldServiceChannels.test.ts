import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarifoldService } from '../src';
import { workspaceApiPath } from '../src/WorkspaceRoutes';
import { cleanupTempDirs, fixtureLoadedConfig, tempDir } from './helpers';

const TOKEN_A = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupTempDirs();
});

/** Fake Bot API: long polls wait until aborted, sendMessage records the call
 * (or fails with `sendError`). */
function stubTelegram(sendError?: string) {
  const polls: Array<{ token: string; aborted: boolean }> = [];
  const sent: Array<{ token: string; chatId: number }> = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: { body?: string; signal?: AbortSignal }) => {
    const [, token, method] = /\/bot([^/]+)\/(\w+)$/.exec(String(url)) ?? [];
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (method === 'getUpdates') {
      const poll = { token, aborted: false };
      polls.push(poll);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          poll.aborted = true;
          reject(new Error('aborted'));
        });
      });
    }
    if (method === 'sendMessage') {
      if (sendError) { return reply({ ok: false, description: sendError }); }
      sent.push({ token, chatId: JSON.parse(String(init?.body)).chat_id });
      return reply({ ok: true, result: { message_id: 1 } });
    }
    return reply({ ok: true, result: { username: 'test_bot' } });
  });
  return { polls, sent };
}

function scaffoldProfile(profilesDir: string, name: string): void {
  fs.mkdirSync(path.join(profilesDir, name), { recursive: true });
  fs.writeFileSync(path.join(profilesDir, name, 'profile.toml'), '');
}

describe('Telegram channel routes', () => {
  it('saves a write-only token, applies allowlist edits live, and restarts only for a new token', async () => {
    const telegram = stubTelegram();
    const dir = tempDir();
    const loadedConfig = fixtureLoadedConfig(dir);
    scaffoldProfile(loadedConfig.config.paths.profilesDir, 'default');
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const initial = await server.inject({ method: 'GET', url: '/v1/channels/telegram' });
      expect(initial.json().telegram).toMatchObject({ configured: false, state: 'not-configured', token: { source: 'missing' } });

      const bad = await server.inject({ method: 'PATCH', url: '/v1/channels/telegram', payload: { botToken: 'not-a-token-xyz' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('not-a-token-xyz');

      const saved = await server.inject({ method: 'PATCH', url: '/v1/channels/telegram', payload: { botToken: TOKEN_A, allowlist: [42] } });
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain(TOKEN_A);
      expect(saved.json().telegram).toMatchObject({ configured: true, state: 'polling', token: { source: 'config' }, allowlist: [42] });
      expect(fs.readFileSync(loadedConfig.configPath, 'utf8')).toContain(TOKEN_A);
      await vi.waitFor(() => expect(telegram.polls).toHaveLength(1));

      // Allowlist, profile and proxy apply in place: the same poll keeps running.
      await server.inject({ method: 'PATCH', url: '/v1/channels/telegram', payload: { allowlist: [42, 7], proxy: 'http://127.0.0.1:7890' } });
      expect(telegram.polls).toHaveLength(1);
      expect(telegram.polls[0].aborted).toBe(false);

      await server.inject({ method: 'PATCH', url: '/v1/channels/telegram', payload: { botToken: TOKEN_B } });
      await vi.waitFor(() => expect(telegram.polls[telegram.polls.length - 1]?.token).toBe(TOKEN_B));
      expect(telegram.polls[0].aborted).toBe(true);

      const view = await server.inject({ method: 'GET', url: '/v1/channels/telegram' });
      expect(view.body).not.toContain(TOKEN_A);
      expect(view.body).not.toContain(TOKEN_B);
      expect(view.json().telegram).toMatchObject({ allowlist: [42, 7], proxy: 'http://127.0.0.1:7890' });

      const unknownProfile = await server.inject({ method: 'PATCH', url: '/v1/channels/telegram', payload: { profile: 'nobody' } });
      expect(unknownProfile.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('sends a test message to an allowlisted user and explains "chat not found"', async () => {
    const dir = tempDir();
    const telegram = stubTelegram();
    const loadedConfig = fixtureLoadedConfig(dir, {
      channels: { telegram: { botToken: TOKEN_A, allowlist: [42], profile: 'default', defaultMode: 'agent' } },
    });
    let server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const ok = await server.inject({ method: 'POST', url: '/v1/channels/telegram/test', payload: {} });
      expect(ok.json()).toEqual({ ok: true, userId: 42 });
      expect(telegram.sent).toEqual([{ token: TOKEN_A, chatId: 42 }]);
      const outsider = await server.inject({ method: 'POST', url: '/v1/channels/telegram/test', payload: { userId: 99 } });
      expect(outsider.statusCode).toBe(400);
    } finally {
      await server.close();
    }

    stubTelegram('Bad Request: chat not found');
    server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const refused = await server.inject({ method: 'POST', url: '/v1/channels/telegram/test', payload: {} });
      expect(refused.statusCode).toBe(502);
      expect(refused.json().error.message).toMatch(/send \/start/);
      expect(refused.body).not.toContain(TOKEN_A);
    } finally {
      await server.close();
    }
  });

  it('never forwards channel routes across a workspace', () => {
    expect(workspaceApiPath('GET', '/v1/channels/telegram')).toBe(false);
    expect(workspaceApiPath('PATCH', '/v1/channels/telegram')).toBe(false);
  });
});
