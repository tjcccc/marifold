import * as http from 'node:http';
import * as https from 'node:https';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';
import { ProxyAgent } from 'undici';
import { MarifoldError } from '../../errors/MarifoldError';

/** Validates a workspace connection's proxy: an `http://` or `https://` origin,
 * optionally with credentials. Returns it normalized. */
export function bridgeProxy(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new MarifoldError('WORKSPACE_INVALID', 'Proxy must be a URL such as http://127.0.0.1:7890.');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.pathname !== '/' || url.search || url.hash) {
    throw new MarifoldError('WORKSPACE_INVALID', 'Proxy must be an http:// or https:// address such as http://127.0.0.1:7890.');
  }
  return url.href.replace(/\/$/, '');
}
/** The proxy as shown in status output, without credentials. */
export function redactedProxy(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  return url.href.replace(/\/$/, '');
}
/** A fetch dispatcher for bridge HTTP calls. Unlike provider proxies there is no
 * `HTTPS_PROXY` fallback: a workspace connection without a proxy goes direct. */
export function bridgeDispatcher(proxy: string | undefined): ProxyAgent | undefined {
  return proxy ? new ProxyAgent(proxy) : undefined;
}

type ConnectionOptions = http.ClientRequestArgs & tls.ConnectionOptions;
type Callback = (error: Error | null, socket: Duplex) => void;

/** Opens the bridge WebSocket through the proxy's HTTP CONNECT tunnel, then
 * runs TLS to the bridge inside it, so the proxy sees only the bridge host. */
export function bridgeProxyAgent(proxy: string, secure: boolean): http.Agent {
  const proxyUrl = new URL(proxy);
  const authorization = proxyUrl.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`
    : undefined;
  const tunnel = (options: ConnectionOptions, callback: Callback) => {
    // Node's agent callback types the socket as always present; failures pass none.
    const fail = (error: Error) => callback(error, undefined as unknown as Duplex);
    const host = String(options.host ?? options.hostname ?? 'localhost').replace(/^\[(.*)\]$/, '$1');
    const port = Number(options.port ?? (secure ? 443 : 80));
    const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
    const request = (proxyUrl.protocol === 'https:' ? https : http).request({
      host: proxyUrl.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: target,
      headers: { host: target, ...(authorization ? { 'proxy-authorization': authorization } : {}) },
      agent: false,
      timeout: 10000,
    });
    const timeout = () => request.destroy(new Error('Proxy did not answer.'));
    request.once('connect', (response, socket) => {
      // The deadline covers only the CONNECT handshake, never the idle tunnel.
      request.off('timeout', timeout);
      socket.setTimeout(0);
      if (response.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy refused the bridge connection (HTTP ${response.statusCode}).`));
        return;
      }
      if (!secure) {
        callback(null, socket);
        return;
      }
      const servername = options.servername || (host.includes(':') || /^\d+(\.\d+){3}$/.test(host) ? undefined : host);
      callback(null, tls.connect({ ...options, socket, host, ...(servername ? { servername } : {}) }));
    });
    request.once('timeout', timeout);
    request.once('error', fail);
    request.end();
  };
  const Base = secure ? https.Agent : http.Agent;
  return new (class extends Base {
    override createConnection(options: http.ClientRequestArgs, callback?: Callback): undefined {
      tunnel(options as ConnectionOptions, callback ?? (() => undefined));
      return undefined;
    }
  })({ keepAlive: false });
}
