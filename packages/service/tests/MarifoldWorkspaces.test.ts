import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentConfig } from '@marifold/core';
import { createBridge, MemoryRelayStore } from '../../../apps/bridge/src';
import { createMarifoldService } from '../src';
import { workspaceApiPath } from '../src/WorkspaceRoutes';
import { cleanupTempDirs, fixtureLoadedConfig, tempDir } from './helpers';

const servers: FastifyInstance[] = [];
const generatedRuns: string[] = [];
const bridges: ReturnType<typeof createBridge>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const b of bridges.splice(0)) {
    b.closeAllConnections();
    b.close();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of generatedRuns.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  cleanupTempDirs();
});
function service(dir: string, guest = false) {
  const config = fixtureLoadedConfig(dir, {
    agent: resolveAgentConfig({ toolMode: 'control-block' }),
    ...(guest
      ? {
          providers: {},
          models: { options: [] },
          default: { profile: 'default', provider: '', model: '', think: false },
        }
      : {}),
  });
  const server = createMarifoldService({ loadedConfig: config, scheduler: false });
  servers.push(server);
  return server;
}
async function bridge() {
  const b = createBridge(new MemoryRelayStore(), 'a'.repeat(32));
  bridges.push(b);
  await new Promise<void>((r) => b.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(b.address() as { port: number }).port}`;
}
async function post(s: FastifyInstance, url: string, payload: object) {
  const r = await s.inject({ method: 'POST', url, payload });
  if (r.statusCode >= 400) throw new Error(r.body);
  return r.json();
}
async function paired(executor = false) {
  const hostDir = tempDir();
  const guestDir = tempDir();
  const host = service(hostDir);
  const guest = service(guestDir, true);
  const url = await bridge();
  const created = await post(host, '/v1/workspaces', {
    name: 'Home',
    bridgeUrl: url,
    registrationToken: 'a'.repeat(32),
  });
  const joined = await post(guest, '/v1/workspaces/join', { bridgeUrl: url, invitation: created.invitation, executor });
  return {
    host,
    guest,
    hostDir,
    guestDir,
    url,
    id: joined.workspace.id,
    device: joined.workspace.deviceId,
    prefix: `/v1/workspaces/${joined.workspace.id}/api`,
  };
}
describe('device-hosted workspaces', () => {
  it('downloads a complete large host artifact while serving ordinary workspace reads', async () => {
    const p = await paired();
    const original = randomBytes(1024 * 1024 + 17);
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      if (!String(input).includes('localhost:11434')) return realFetch(input, init);
      const request = JSON.parse(String(init?.body));
      const context = request.messages.map((m: { content: string }) => m.content).join('\n');
      const output = /otherwise write generated deliverables to (.+?)\. Regular output files/.exec(context)?.[1];
      if (!output) throw new Error('No fixture output directory.');
      generatedRuns.push(path.dirname(output));
      fs.writeFileSync(path.join(output, 'transfer.bin'), original);
      return new Response(JSON.stringify({ message: { content: 'Fixture complete.' }, done: true, done_reason: 'stop' }), {
        headers: { 'content-type': 'application/json' },
      });
    }));
    const { run } = await post(p.guest, `${p.prefix}/v1/runs`, { objective: 'Create a fixture artifact.', sessionId: 'download-session' });
    let current = run;
    await expect.poll(async () => {
      current = (await p.host.inject(`/v1/runs/${run.id}`)).json().run;
      return current.status;
    }).toBe('completed');
    expect(current.artifacts).toHaveLength(1);
    const [download, profiles] = await Promise.all([
      p.guest.inject(`${p.prefix}/v1/runs/${run.id}/artifacts/${current.artifacts[0].id}`),
      p.guest.inject(`${p.prefix}/v1/profiles`),
    ]);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(original);
    expect(profiles.statusCode).toBe(200);
    await p.host.close();
    await p.guest.close();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 86400000);
    const host = service(p.hostDir);
    const guest = service(p.guestDir, true);
    expect((await host.inject('/v1/runs')).json().runs).toEqual([]);
    await expect.poll(async () => (await guest.inject(`${p.prefix}/v1/runs?sessionId=download-session`)).json().runs?.length).toBe(1);
    const restored = await guest.inject(`${p.prefix}/v1/runs/${run.id}/artifacts/${current.artifacts[0].id}`);
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.rawPayload).toEqual(original);
    expect(restored.headers['content-disposition']).toContain('transfer.bin');
    expect((await guest.inject(`${p.prefix}/v1/runs/${run.id}/artifacts`)).json().artifacts[0].available).toBe(true);
    fs.unlinkSync(path.join(generatedRuns[0], 'output', 'transfer.bin'));
    const unavailable = (await guest.inject(`${p.prefix}/v1/runs/${run.id}/artifacts`)).json().artifacts;
    expect(unavailable).toEqual([expect.objectContaining({ name: 'transfer.bin', available: false })]);
    expect((await guest.inject(`${p.prefix}/v1/runs?sessionId=download-session`)).json().runs[0].artifacts).toHaveLength(1);
    expect((await guest.inject(`${p.prefix}/v1/runs?sessionId=another-session`)).json().runs).toEqual([]);
  }, 20000);
  it('shares the host surface without credentials or nested workspace access', async () => {
    const p = await paired();
    const config = await p.guest.inject(`${p.prefix}/v1/config`);
    expect(config.statusCode).toBe(200);
    expect(config.body).not.toContain('test-secret-key');
    expect(config.json().config.models.options).toEqual(['ollama/gemma4:e4b']);
    expect((await p.guest.inject('/v1/config')).json().config.models.options).toEqual([]);
    const snapshot = await post(p.guest, `${p.prefix}/v1/terminal/snapshot`, {});
    expect(snapshot.result.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain('test-secret-key');
    const schedule = await post(p.guest, `${p.prefix}/v1/schedules`, {
      name: 'Personal check',
      objective: 'Check the workspace',
      cron: '0 9 * * *',
      enabled: false,
    });
    expect((await p.host.inject('/v1/schedules')).json().schedules[0].id).toBe(schedule.schedule.id);
    expect((await p.guest.inject('/v1/schedules')).json().schedules).toEqual([]);
    expect(
      (
        await p.guest.inject({
          method: 'PATCH',
          url: `${p.prefix}/v1/schedules/${schedule.schedule.id}`,
          payload: { name: 'Renamed check' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await p.guest.inject({ method: 'DELETE', url: `${p.prefix}/v1/schedules/${schedule.schedule.id}` })).json()
        .deleted,
    ).toBe(true);
    const rejected = await p.guest.inject(`${p.prefix}/v1/workspaces`);
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    await post(p.guest, `/v1/workspaces/${p.id}/manage/rename`, { name: 'Home renamed' });
    expect((await p.host.inject('/v1/workspaces')).json().workspaces[0].name).toBe('Home renamed');
    expect(workspaceApiPath('GET', '/v1/profiles/../workspaces')).toBe(false);
    expect(workspaceApiPath('GET', '/v1/profiles/%2e%2e/workspaces')).toBe(false);
    expect(workspaceApiPath('POST', '/v1/workspaces/other/api/v1/runs')).toBe(false);
  });
  it('delegates once within a workspace and exposes child approvals and artifacts on the parent', async () => {
    const p = await paired(true);
    let count = 0;
    const prompts: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        if (!String(input).includes('localhost:11434')) return realFetch(input, init);
        const request = JSON.parse(String(init?.body));
        const context = request.messages.map((m: { content: string }) => m.content).join('\n');
        prompts.push(context);
        const step = count++;
        let text = 'The device task is complete.';
        if (step === 0)
          text =
            '<tool_call name="delegate_device">{"device":"host","objective":"Create a small report file."}</tool_call>';
        if (step === 1) {
          const output = /otherwise write generated deliverables to (.+?)\. Regular output files/.exec(context)?.[1];
          if (!output) throw new Error('No output directory in child context.');
          generatedRuns.push(path.dirname(output));
          text = `<tool_call name="write_file">${JSON.stringify({ path: path.join(output, 'report.txt'), content: 'child artifact' })}</tool_call>`;
        }
        return new Response(JSON.stringify({ message: { content: text }, done: true, done_reason: 'stop' }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const { run } = await post(p.guest, `${p.prefix}/v1/runs`, { objective: 'Ask the host to create a report.' });
    const answered = new Set<string>();
    let current = run;
    for (let i = 0; i < 200; i++) {
      current = (await p.host.inject(`/v1/runs/${run.id}`)).json().run;
      for (const approval of current.pendingApprovals)
        if (!answered.has(approval.id)) {
          answered.add(approval.id);
          await post(p.guest, `${p.prefix}/v1/runs/${run.id}/approvals/${approval.id}`, { action: 'once' });
        }
      if (current.finishedAt) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(current.status).toBe('completed');
    expect(answered.size).toBe(2);
    expect(count).toBe(4);
    expect(prompts[1]).not.toContain('name="delegate_device"');
    expect(prompts[0]).toContain('workspaceName');
    expect(prompts[0]).toContain('hostDeviceId');
    expect(prompts[0]).toContain('use delegate_device if it differs from executionDeviceId');
    expect(prompts[0]).toContain('do not take a new screenshot');
    expect(current.artifacts).toHaveLength(1);
    expect(current.artifacts[0].source.runId).not.toBe(run.id);
    const download = await p.guest.inject(`${p.prefix}/v1/runs/${run.id}/artifacts/${current.artifacts[0].id}`);
    expect(download.statusCode, download.body).toBe(200);
    expect(download.body).toBe('child artifact');
    const replay = await p.guest.inject(`${p.prefix}/v1/runs/${run.id}/events`);
    expect(replay.body.match(/event: done/g)).toHaveLength(1);
  }, 20000);
  it('runs the host model on the guest executor with once-only approval and session ownership', async () => {
    const p = await paired(true);
    let count = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        if (!String(input).includes('localhost:11434')) return realFetch(input, init);
        const text =
          count++ === 0
            ? '<tool_call name="write_file">{"path":"result.txt","content":"guest output"}</tool_call>'
            : 'Saved on the selected device.';
        return new Response(JSON.stringify({ message: { content: text }, done: true, done_reason: 'stop' }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const cwd = path.join(p.guestDir, 'project');
    fs.mkdirSync(cwd);
    const payload = { objective: 'Write result.txt', cwd, sessionId: 'shared-session' };
    const start = await p.guest.inject({
      method: 'POST',
      url: `${p.prefix}/v1/runs`,
      payload,
      headers: { 'idempotency-key': 'stable-start' },
    });
    expect(start.statusCode, start.body).toBe(201);
    const run = start.json().run;
    expect(run.execution).toMatchObject({ workspaceId: p.id, originDeviceId: p.device, executionDeviceId: p.device });
    const duplicate = await p.guest.inject({
      method: 'POST',
      url: `${p.prefix}/v1/runs`,
      payload,
      headers: { 'idempotency-key': 'stable-start' },
    });
    expect(duplicate.json().run.id).toBe(run.id);
    let approval;
    for (let i = 0; i < 50; i++) {
      const current = (await p.host.inject(`/v1/runs/${run.id}`)).json().run;
      approval = current.pendingApprovals[0];
      if (approval) break;
      if (current.finishedAt) throw new Error(JSON.stringify(current));
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(approval).toBeDefined();
    expect(approval.persistable).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'result.txt'))).toBe(false);
    const conflict = await p.host.inject({ method: 'POST', url: '/v1/runs', payload });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.details.runId).toBe(run.id);
    const always = await p.guest.inject({
      method: 'POST',
      url: `${p.prefix}/v1/runs/${run.id}/approvals/${approval.id}`,
      payload: { action: 'always' },
    });
    expect(always.statusCode).toBe(400);
    await post(p.guest, `${p.prefix}/v1/runs/${run.id}/approvals/${approval.id}`, { action: 'once' });
    const events = await p.guest.inject(`${p.prefix}/v1/runs/${run.id}/events`);
    expect(events.body).toContain('event: done');
    expect((await p.host.inject(`/v1/runs/${run.id}`)).json().run.status).toBe('completed');
    expect(fs.existsSync(path.join(cwd, 'result.txt')), events.body).toBe(true);
    expect(fs.readFileSync(path.join(cwd, 'result.txt'), 'utf8')).toBe('guest output');
    expect(count).toBe(2);
    const fresh = await p.guest.inject({
      method: 'POST',
      url: `${p.prefix}/v1/runs`,
      headers: { 'idempotency-key': 'stable-start' },
      payload: { ...payload, objective: 'different' },
    });
    expect(fresh.statusCode).toBeGreaterThanOrEqual(400);
  }, 20000);
});
