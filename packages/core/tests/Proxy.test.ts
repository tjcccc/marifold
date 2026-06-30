import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
