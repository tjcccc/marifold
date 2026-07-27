import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { ProxyAgent } from 'undici';
import { proxyDispatcher } from '../src/util/proxy';

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of PROXY_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of PROXY_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('proxyDispatcher', () => {
  it('returns undefined when no proxy is configured', () => {
    expect(proxyDispatcher()).toBeUndefined();
  });

  it('builds a ProxyAgent from an explicit url', () => {
    expect(proxyDispatcher('http://127.0.0.1:7890')).toBeInstanceOf(ProxyAgent);
  });

  it('falls back to the HTTPS_PROXY env var', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    expect(proxyDispatcher()).toBeInstanceOf(ProxyAgent);
  });

  it('treats an empty-string proxy var as unset and falls through (the HTTPS_PROXY="" case)', () => {
    // Some proxy tools set lowercase https_proxy and leave HTTPS_PROXY="".
    process.env.HTTPS_PROXY = '';
    process.env.https_proxy = 'http://127.0.0.1:7890';
    expect(proxyDispatcher()).toBeInstanceOf(ProxyAgent);

    // All empty/absent -> no proxy.
    process.env.HTTPS_PROXY = '';
    delete process.env.https_proxy;
    expect(proxyDispatcher()).toBeUndefined();
  });

  it('returns a dispatcher compatible with Node global fetch', async () => {
    const target = createServer((_request, response) => response.end('ok'));
    const proxy = createServer();
    proxy.on('connect', (request, client, head) => {
      const [host, port] = (request.url ?? '').split(':');
      const upstream = connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
    });

    await listen(target);
    await listen(proxy);
    const targetAddress = target.address();
    const proxyAddress = proxy.address();
    if (!targetAddress || typeof targetAddress === 'string'
      || !proxyAddress || typeof proxyAddress === 'string') {
      throw new Error('Expected TCP test server addresses.');
    }

    const dispatcher = proxyDispatcher(`http://127.0.0.1:${proxyAddress.port}`);
    try {
      const response = await fetch(`http://127.0.0.1:${targetAddress.port}/health`, {
        dispatcher,
      } as RequestInit);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('ok');
    } finally {
      await dispatcher?.close();
      await Promise.all([close(proxy), close(target)]);
    }
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
