import fastify from 'fastify';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactTickets, artifactHeaders } from '../src/ArtifactTickets';
import { registerSecurity } from '../src/Security';

const servers: ReturnType<typeof fastify>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await server.close(); });

function fixture() {
  const server = fastify(); servers.push(server);
  const tickets = new ArtifactTickets();
  registerSecurity(server, { token: 'service-secret', corsOrigins: [], access: 'loopback', boundHost: '127.0.0.1', authorizeArtifact: tickets.authorize });
  tickets.register(server);
  server.post('/v1/issue', async () => tickets.issue(async reply => {
    artifactHeaders(reply, { name: 'folder/报告.txt', mediaType: 'text/plain', size: 5 });
    return reply.send('hello');
  }));
  return { server, tickets };
}

it('requires authentication to issue, scopes navigation to a single file, and preserves origin and Host checks', async () => {
  const { server } = fixture();
  expect((await server.inject({ method: 'POST', url: '/v1/issue' })).statusCode).toBeGreaterThanOrEqual(400);
  const issued = await server.inject({ method: 'POST', url: '/v1/issue', headers: { authorization: 'Bearer service-secret' } });
  const { path } = issued.json();
  expect(path).toMatch(/^\/v1\/downloads\/[a-f0-9]{48}$/);
  expect(issued.body).not.toContain('service-secret');
  const downloaded = await server.inject(path);
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.body).toBe('hello');
  expect(downloaded.headers['content-length']).toBe('5');
  expect(downloaded.headers['content-disposition']).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt");
  expect(downloaded.headers['cache-control']).toBe('no-store');
  for (const request of [
    { method: 'GET' as const, url: path + '?path=/v1/config' },
    { method: 'GET' as const, url: path, headers: { origin: 'https://untrusted.example' } },
    { method: 'GET' as const, url: path, headers: { host: 'untrusted.example' } },
    { method: 'POST' as const, url: path },
    { method: 'GET' as const, url: path.replace(/.$/, path.endsWith('0') ? '1' : '0') },
  ]) expect((await server.inject(request)).statusCode).toBeGreaterThanOrEqual(400);
  expect((await server.inject({ method: 'HEAD', url: path })).statusCode).toBe(200);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
  expect((await server.inject({ url: path, headers: { authorization: 'Bearer service-secret' } })).statusCode).toBe(410);
});

it('streams headers and first bytes before the source has finished, and stops on browser cancellation', async () => {
  const { server, tickets } = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  let closed = false;
  const access = tickets.issue(async reply => {
    artifactHeaders(reply, { name: 'large.bin', mediaType: 'application/octet-stream', size: 200000 });
    const stream = Readable.from((async function* () {
      try { yield Buffer.alloc(100000, 1); await gate; yield Buffer.alloc(100000, 2); finished = true; }
      finally { closed = true; }
    })());
    return reply.send(stream);
  });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const abort = new AbortController();
  try {
    const response = await fetch(address + access.path, { signal: abort.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('200000');
    const first = await response.body!.getReader().read();
    expect(first.value!.byteLength).toBeGreaterThan(0);
    expect(finished).toBe(false);
    abort.abort();
    release();
    await expect.poll(() => closed).toBe(true);
  } finally { release(); abort.abort(); }
});
