import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { createMarifoldService } from '../src';
import { requestEnvironment } from '../src/RequestEnvironment';
import { WorkspaceRequestContext } from '../src/WorkspaceRequestContext';
import { cleanupTempDirs, fixtureLoadedConfig, tempDir } from './helpers';

afterEach(() => { vi.unstubAllGlobals(); cleanupTempDirs(); });

it('derives origin from the direct peer and authenticated bridge provenance instead of request JSON', async () => {
  const request = (ip: string) => ({ ip, body: { environment: { interface: 'web', timezone: 'UTC', request: 'local' } }, headers: { 'x-forwarded-for': '127.0.0.1' } }) as unknown as FastifyRequest;
  expect(requestEnvironment(request('192.0.2.10')).request).toBe('remote');
  expect(requestEnvironment(request('127.0.0.1')).request).toBe('local');
  expect(requestEnvironment(request('::ffff:127.0.0.1')).request).toBe('local');
  const bridge = new WorkspaceRequestContext();
  await bridge.inject({ workspaceId: 'home', senderDeviceId: 'guest', hostDeviceId: 'host' }, async headers => {
    expect(requestEnvironment(request('127.0.0.1'), bridge.resolve(headers)).request).toBe('remote');
  });
  await bridge.inject({ workspaceId: 'home', senderDeviceId: 'host', hostDeviceId: 'host', remoteRequest: true }, async headers => {
    expect(requestEnvironment(request('127.0.0.1'), bridge.resolve(headers)).request).toBe('remote');
  });
  expect(() => bridge.resolve({ 'x-marifold-workspace-context': 'forged' })).toThrow();
});

it.each(['/v1/ask', '/v1/chat/stream'])('keeps the environment in instruction context and out of persisted chat at %s', async url => {
  const captured: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    const request = JSON.parse(String(init?.body)); captured.push(request);
    return new Response(JSON.stringify({ message: { content: 'Hello.' }, done: true, done_reason: 'stop' }) + '\n', {
      headers: { 'content-type': request.stream ? 'application/x-ndjson' : 'application/json' },
    });
  }));
  const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
  try {
    const response = await server.inject({ method: 'POST', url, remoteAddress: '192.0.2.10', payload: {
      prompt: 'My exact question.', sessionId: 'environment-chat', environment: { interface: 'web', timezone: 'Asia/Shanghai', request: 'local', time: 'fake' },
    } });
    expect(response.statusCode, response.body).toBe(200);
    const messages = captured[0].messages;
    expect(messages.find(message => message.role === 'user')?.content).toBe('My exact question.');
    const context = messages.filter(message => message.role !== 'user').map(message => message.content).join('\n');
    expect(context).toContain('interface: web');
    expect(context).toContain('timezone: Asia/Shanghai');
    expect(context).toContain('request: remote');
    expect(context).not.toContain('time: fake');
    const session = await server.inject('/v1/sessions/environment-chat');
    expect(session.statusCode).toBe(200);
    expect(session.body).not.toContain('<environment>');
    const invalid = await server.inject({ method: 'POST', url, payload: { prompt: 'Hello', environment: { interface: 'invented' } } });
    expect(invalid.statusCode).toBe(400);
  } finally { await server.close(); }
});
