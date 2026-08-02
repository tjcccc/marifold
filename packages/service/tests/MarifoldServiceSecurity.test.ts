import { afterEach, describe, expect, it } from 'vitest';
import { createMarifoldService, startMarifoldService } from '../src';
import { cleanupTempDirs, fixtureLoadedConfig, tempDir } from './helpers';

afterEach(() => {
  cleanupTempDirs();
});

describe('MarifoldService security', () => {
  it('requires bearer authentication before enabling a non-loopback bind', () => {
    expect(() => createMarifoldService({
      loadedConfig: fixtureLoadedConfig(tempDir()),
      host: '0.0.0.0',
      scheduler: false,
    })).toThrow(/non-loopback service host requires bearer authentication/i);
  });

  it('listens on the wildcard host when bearer authentication is configured', async () => {
    const result = await startMarifoldService({
      loadedConfig: fixtureLoadedConfig(tempDir(), {
        service: { token: 'sekret-token', corsOrigins: [] },
      }),
      host: '0.0.0.0',
      port: 0,
      scheduler: false,
    });
    try {
      expect(result.host).toBe('0.0.0.0');
      const address = result.server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected an IP socket address.');
      const health = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await result.server.close();
    }
  });

  it('requires the configured bearer token everywhere except /health', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir(), {
      service: { token: 'sekret-token', corsOrigins: [] },
    });
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const bare = await server.inject({ method: 'GET', url: '/v1/status' });
      expect(bare.statusCode).toBe(401);
      expect(bare.json().error.code).toBe('UNAUTHORIZED');

      const wrong = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { authorization: 'Bearer nope' },
      });
      expect(wrong.statusCode).toBe(401);

      const good = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { authorization: 'Bearer sekret-token' },
      });
      expect(good.statusCode).toBe(200);

      const health = await server.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);

      // Unknown routes are protected too (auth runs before route matching).
      const unknown = await server.inject({ method: 'GET', url: '/v1/nope' });
      expect(unknown.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('gates path variants of /v1 on the normalized pathname (fail closed)', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir(), {
      service: { token: 'sekret-token', corsOrigins: [] },
    });
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      // Each of these previously missed the raw-URL prefix check and fell
      // through unauthenticated (to a 404); they must now demand the token.
      for (const url of ['//v1/config', '/v1?x=1', '/v1/../v1/config', '/%761/config']) {
        const response = await server.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(401);
      }

      // Normalization must not gate the public shell paths.
      const health = await server.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('prefers the explicit auth option over the config token', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir(), {
      service: { token: 'config-token', corsOrigins: [] },
    });
    const server = createMarifoldService({ loadedConfig, scheduler: false, auth: { token: 'flag-token' } });
    try {
      const viaConfig = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { authorization: 'Bearer config-token' },
      });
      expect(viaConfig.statusCode).toBe(401);

      const viaFlag = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { authorization: 'Bearer flag-token' },
      });
      expect(viaFlag.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('reports an environment-resolved bearer token in the sanitized config view', async () => {
    const envName = 'MARIFOLD_TEST_SERVICE_TOKEN';
    process.env[envName] = 'env-token';
    const loadedConfig = fixtureLoadedConfig(tempDir(), {
      service: { tokenEnv: envName, corsOrigins: [] },
    });
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/config',
        headers: { authorization: 'Bearer env-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().config.service).toMatchObject({
        tokenEnv: envName,
        hasToken: true,
      });
      expect(JSON.stringify(response.json())).not.toContain('env-token');
    } finally {
      delete process.env[envName];
      await server.close();
    }
  });

  it('applies the CORS origin allowlist with a preflight short-circuit', async () => {
    const loadedConfig = fixtureLoadedConfig(tempDir(), {
      service: { corsOrigins: ['http://localhost:5173'] },
    });
    const server = createMarifoldService({ loadedConfig, scheduler: false });
    try {
      const preflight = await server.inject({
        method: 'OPTIONS',
        url: '/v1/tasks',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(preflight.headers['access-control-allow-methods']).toContain('POST');
      expect(preflight.headers['access-control-allow-headers']).toContain('last-event-id');

      const allowed = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { origin: 'http://localhost:5173' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

      const denied = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { origin: 'https://evil.example.com' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('ORIGIN_FORBIDDEN');

      // Non-browser clients (no Origin header) are unaffected.
      const curlStyle = await server.inject({ method: 'GET', url: '/v1/status' });
      expect(curlStyle.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('rejects cross-origin browsers entirely when no origins are allowed', async () => {
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      const denied = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { origin: 'http://localhost:5173' },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const server = createMarifoldService({ loadedConfig: fixtureLoadedConfig(tempDir()), scheduler: false });
    try {
      const rebound = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { host: 'evil.example.com' },
      });
      expect(rebound.statusCode).toBe(403);
      expect(rebound.json().error.code).toBe('ORIGIN_FORBIDDEN');

      const loopback = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { host: '127.0.0.1:32140' },
      });
      expect(loopback.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('accepts authenticated same-origin requests through a remote bind', async () => {
    const server = createMarifoldService({
      loadedConfig: fixtureLoadedConfig(tempDir(), {
        service: { token: 'sekret-token', corsOrigins: [] },
      }),
      host: '0.0.0.0',
      scheduler: false,
    });
    try {
      const unauthenticated = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { host: '100.101.102.103:32140' },
      });
      expect(unauthenticated.statusCode).toBe(401);

      const sameOrigin = await server.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: {
          host: '100.101.102.103:32140',
          origin: 'http://100.101.102.103:32140',
          authorization: 'Bearer sekret-token',
          'content-type': 'application/json',
        },
        payload: { objective: 'remote same-origin write' },
      });
      expect(sameOrigin.statusCode).toBe(201);

      const crossOrigin = await server.inject({
        method: 'GET',
        url: '/v1/status',
        headers: {
          host: '100.101.102.103:32140',
          origin: 'https://evil.example.com',
          authorization: 'Bearer sekret-token',
        },
      });
      expect(crossOrigin.statusCode).toBe(403);
      expect(crossOrigin.json().error.code).toBe('ORIGIN_FORBIDDEN');
    } finally {
      await server.close();
    }
  });
});
