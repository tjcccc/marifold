import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarifoldService } from '../src';
import { cleanupTempDirs, fixtureLoadedConfig, tempDir } from './helpers';

afterEach(() => {
  cleanupTempDirs();
});

/** web/ inside a tracked parent, with a "secret" sibling a traversal would
 * try to reach — everything cleaned up together. */
function webDirFixture(): string {
  const parent = tempDir();
  const webDir = path.join(parent, 'web');
  fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>marifold</title>');
  fs.writeFileSync(path.join(webDir, 'assets', 'index-abc.js'), 'console.log("app");');
  fs.writeFileSync(path.join(parent, 'secret.txt'), 'nope');
  return webDir;
}

describe('MarifoldService static hosting', () => {
  it('serves the shell, hashed assets, and the SPA fallback', async () => {
    const server = createMarifoldService({
      loadedConfig: fixtureLoadedConfig(tempDir()),
      scheduler: false,
      web: { dir: webDirFixture() },
    });
    try {
      const shell = await server.inject({ method: 'GET', url: '/' });
      expect(shell.statusCode).toBe(200);
      expect(shell.headers['content-type']).toContain('text/html');
      expect(shell.headers['cache-control']).toBe('no-cache');
      expect(shell.payload).toContain('marifold');

      const asset = await server.inject({ method: 'GET', url: '/assets/index-abc.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('text/javascript');
      expect(asset.headers['cache-control']).toContain('immutable');

      // A clean extensionless UI route → the app shell; the browser router
      // reads the path after index.html loads.
      const deepLink = await server.inject({ method: 'GET', url: '/agent/default/session_1' });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.payload).toContain('marifold');

      // A missing asset with an extension is a real 404, not the shell.
      const missing = await server.inject({ method: 'GET', url: '/assets/gone.js' });
      expect(missing.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('rejects path traversal out of the web dir', async () => {
    const server = createMarifoldService({
      loadedConfig: fixtureLoadedConfig(tempDir()),
      scheduler: false,
      web: { dir: webDirFixture() },
    });
    try {
      for (const url of [
        '/../secret.txt',
        '/%2e%2e/secret.txt',
        '/assets/%2e%2e/%2e%2e/secret.txt',
      ]) {
        const response = await server.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(404);
        expect(response.payload, url).not.toContain('nope');
      }
    } finally {
      await server.close();
    }
  });

  it('keeps /v1 and /health JSON semantics intact', async () => {
    const server = createMarifoldService({
      loadedConfig: fixtureLoadedConfig(tempDir()),
      scheduler: false,
      web: { dir: webDirFixture() },
    });
    try {
      const unknownApi = await server.inject({ method: 'GET', url: '/v1/nope' });
      expect(unknownApi.statusCode).toBe(404);
      expect(unknownApi.json().error.code).toBe('NOT_FOUND');

      const health = await server.inject({ method: 'GET', url: '/health' });
      expect(health.json().ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('same-origin loopback POSTs pass the origin policy without an allowlist entry', async () => {
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: {
          host: '127.0.0.1:32140',
          origin: 'http://127.0.0.1:32140',
          'content-type': 'application/json',
        },
        payload: { objective: 'same-origin write' },
      });
      expect(response.statusCode).toBe(201);

      // A rebound Host makes the same header pair fail (origin ≠ loopback self).
      const rebound = await server.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: {
          host: '127.0.0.1:32140',
          origin: 'http://evil.example.com',
          'content-type': 'application/json',
        },
        payload: { objective: 'cross-site write' },
      });
      expect(rebound.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('scopes bearer auth to /v1: the shell stays reachable, the API does not', async () => {
    const server = createMarifoldService({
      loadedConfig: fixtureLoadedConfig(tempDir(), { service: { token: 'sekret', corsOrigins: [] } }),
      scheduler: false,
      web: { dir: webDirFixture() },
    });
    try {
      expect((await server.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/v1/status' })).statusCode).toBe(401);
      const withToken = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { authorization: 'Bearer sekret' },
      });
      expect(withToken.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('exposes the resolved [agent] section in the sanitized config', async () => {
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      const config = (await server.inject({ method: 'GET', url: '/v1/config' })).json().config;
      expect(config.agent.approval).toMatchObject({ read: 'allow', write: 'ask', shell: 'ask' });
      expect(config.agent.trustedFolders).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
