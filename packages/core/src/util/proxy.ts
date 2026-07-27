import { ProxyAgent } from 'undici';

/**
 * Build an undici proxy dispatcher from an explicit proxy URL or, when omitted,
 * the `HTTP(S)_PROXY` environment variables. Returns undefined when no proxy is
 * configured, so `fetch` goes direct.
 *
 * Node's built-in `fetch` ignores `HTTPS_PROXY` by default (unlike Python or
 * `NODE_USE_ENV_PROXY=1` at startup), so a request that must traverse a proxy
 * has to pass this as `fetch(url, { dispatcher: proxyDispatcher() })`. It proxies
 * every request sent through it — use it only for calls that should always go
 * via the proxy (e.g. an external OAuth/API host), not local traffic.
 *
 * Keep the `undici` dependency on the same dispatcher protocol as Node's
 * built-in fetch. Node 24 bundles undici 7; an undici 8 ProxyAgent passed to
 * Node 24's global fetch fails with `UND_ERR_INVALID_ARG`.
 */
export function proxyDispatcher(proxy?: string): ProxyAgent | undefined {
  // `||` (not `??`) so an empty-string env var counts as unset — some proxy
  // tools set the lowercase `https_proxy` and leave `HTTPS_PROXY=""`.
  const url = proxy
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  return url ? new ProxyAgent(url) : undefined;
}
