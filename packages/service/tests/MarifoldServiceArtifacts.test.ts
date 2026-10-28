import * as path from 'path';
import type { FastifyRequest } from 'fastify';
import { ArtifactLibrary } from '@marifold/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarifoldService } from '../src';
import { ArtifactViews } from '../src/ArtifactViews';
import { cleanupTempDirs, fixtureLoadedConfig, tempDir } from './helpers';

// The artifact library routes and the sandboxed view tickets (docs/artifacts.md#viewer).

const TOKEN = 'sekret-token';
const auth = { authorization: `Bearer ${TOKEN}` };

afterEach(() => { cleanupTempDirs(); });

function setup() {
  const dir = tempDir();
  const loadedConfig = fixtureLoadedConfig(dir, { service: { token: TOKEN, corsOrigins: [] } });
  const server = createMarifoldService({ loadedConfig, scheduler: false });
  // A second connection seeds the library the service opened (WAL allows both).
  const seed = new ArtifactLibrary(path.join(dir, 'artifacts'));
  const page = seed.create({
    title: 'AI News',
    files: [
      { path: 'index.html', data: Buffer.from('<script type="module" src="app.js"></script>') },
      { path: 'app.js', data: Buffer.from('fetch("data.json")') },
      { path: 'data.json', data: Buffer.from('{}') },
    ],
  });
  return { server, seed, page };
}

describe('artifact routes', () => {
  it('lists, renames, files, deletes and restores artifacts, with folder counts', async () => {
    const { server, seed, page } = setup();
    try {
      const folder = (await server.inject({ method: 'POST', url: '/v1/artifact-folders', headers: auth, payload: { name: 'AI News' } })).json().folder;
      const moved = await server.inject({ method: 'PATCH', url: `/v1/artifacts/${page.id}`, headers: auth, payload: { title: 'Daily', folderId: folder.id } });
      expect(moved.json().artifact).toMatchObject({ title: 'Daily', folderId: folder.id });
      expect((await server.inject({ method: 'GET', url: `/v1/artifacts?folder=${folder.id}`, headers: auth })).json().artifacts).toHaveLength(1);

      expect((await server.inject({ method: 'DELETE', url: `/v1/artifacts/${page.id}`, headers: auth })).statusCode).toBe(200);
      const counts = (await server.inject({ method: 'GET', url: '/v1/artifact-folders', headers: auth })).json().counts;
      expect(counts).toEqual({ all: 0, unread: 0, unfiled: 0, deleted: 1 });
      expect((await server.inject({ method: 'POST', url: `/v1/artifacts/${page.id}/undelete`, headers: auth })).json().artifact.folderId).toBe(folder.id);

      expect((await server.inject({ method: 'POST', url: `/v1/artifacts/${page.id}/restore`, headers: auth, payload: { version: 9 } })).statusCode).toBe(400);
      expect((await server.inject({ method: 'GET', url: '/v1/artifacts/aaaaaaaaaa', headers: auth })).statusCode).toBe(404);
      expect((await server.inject({ method: 'DELETE', url: `/v1/artifacts/${page.id}?permanent=true`, headers: auth })).statusCode).toBe(200);
      expect(seed.get(page.id)).toBeUndefined();
    } finally {
      seed.close();
      await server.close();
    }
  });

  it('serves a view to a sandboxed frame (Origin: null, no token) under a CSP limited to the ticket', async () => {
    const { server, seed, page } = setup();
    try {
      const view = (await server.inject({ method: 'POST', url: `/v1/artifacts/${page.id}/view`, headers: auth, payload: {} })).json();
      expect(view).toMatchObject({ entry: 'index.html', kind: 'html', version: 1 });
      expect(seed.get(page.id)?.seen).toBe(true);

      const frame = { origin: 'null', host: '127.0.0.1:32140' };
      const entry = await server.inject({ method: 'GET', url: view.entryPath, headers: frame });
      expect(entry.statusCode).toBe(200);
      expect(entry.headers['access-control-allow-origin']).toBe('*');
      expect(entry.headers['x-frame-options']).toBeUndefined();
      const csp = String(entry.headers['content-security-policy']);
      expect(csp).toMatch(/^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
      expect(csp).not.toContain('allow-same-origin');
      expect(csp).toContain(`connect-src http://127.0.0.1:32140${view.path} data: blob:`);

      const data = await server.inject({ method: 'GET', url: `${view.path}data.json`, headers: frame });
      expect(data.statusCode).toBe(200);
      expect(data.headers['content-type']).toBe('application/json');
      expect((await server.inject({ method: 'GET', url: `${view.path}missing.js`, headers: frame })).statusCode).toBe(404);
      expect((await server.inject({ method: 'POST', url: view.entryPath, headers: frame })).statusCode).not.toBe(200);
    } finally {
      seed.close();
      await server.close();
    }
  });

  it('still refuses Origin: null, and missing tokens, everywhere else', async () => {
    const { server, seed, page } = setup();
    try {
      const view = (await server.inject({ method: 'POST', url: `/v1/artifacts/${page.id}/view`, headers: auth, payload: {} })).json();
      const frame = { origin: 'null', host: '127.0.0.1:32140' };
      expect((await server.inject({ method: 'GET', url: '/v1/artifacts', headers: { ...frame, ...auth } })).statusCode).toBe(403);
      expect((await server.inject({ method: 'GET', url: '/v1/sessions', headers: frame })).statusCode).toBe(403);
      // A path that only starts like a view, an unknown ticket, or a ticket path climbing out.
      expect((await server.inject({ method: 'GET', url: `/v1/artifact-views/${'0'.repeat(48)}/index.html`, headers: frame })).statusCode).toBe(403);
      expect((await server.inject({ method: 'GET', url: `${view.path}../../sessions`, headers: { host: frame.host } })).statusCode).toBe(401);
      expect((await server.inject({ method: 'GET', url: `${view.path}%2e%2e/%2e%2e/sessions`, headers: { host: frame.host } })).statusCode).toBe(401);
      expect((await server.inject({ method: 'GET', url: view.entryPath, headers: { ...frame, host: 'evil.example.com' } })).statusCode).toBe(403);
    } finally {
      seed.close();
      await server.close();
    }
  });
});

describe('ArtifactViews', () => {
  it('keeps a ticket alive while used, for 12 hours at most', () => {
    const library = { get: () => undefined, file: () => undefined } as unknown as ArtifactLibrary;
    let now = 0;
    const views = new ArtifactViews(library, () => now);
    const { path: prefix } = views.issue('aaaaaaaaaa', 1);
    const request = { method: 'GET', url: `${prefix}index.html` } as FastifyRequest;
    const minutes = (count: number) => count * 60 * 1000;
    for (let step = 0; step < 12; step++) {
      now += minutes(59);
      expect(views.authorize(request), `after ${now / minutes(1)} min`).toBe(true);
    }
    now += minutes(59);
    expect(views.authorize(request)).toBe(false);

    const idle = views.issue('aaaaaaaaaa', 1);
    now += minutes(61);
    expect(views.authorize({ method: 'GET', url: idle.path } as FastifyRequest)).toBe(false);
  });
});
