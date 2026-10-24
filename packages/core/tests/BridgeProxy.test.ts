import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createBridge } from '../../../apps/bridge/src';
import { WorkspaceManager } from '../src/workspace/WorkspaceManager';
import { bridgeProxy, bridgeProxyAgent } from '../src/workspace/bridge/BridgeProxy';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) { fn(); }
});
const port = (server: Server) => (server.address() as { port: number }).port;
async function listen<T extends Server>(server: T): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
/** A minimal CONNECT proxy that records each tunnel and its credentials. */
async function proxy() {
  const tunnels: Array<{ target: string; authorization?: string }> = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, client: Socket, head) => {
    tunnels.push({ target: String(req.url), authorization: req.headers['proxy-authorization'] });
    const [host, targetPort] = String(req.url).split(':');
    const upstream = connect(Number(targetPort), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    }
  });
  await listen(server);
  cleanup.push(() => {
    for (const socket of sockets) { socket.destroy(); }
    server.close();
  });
  return { url: `http://127.0.0.1:${port(server)}`, tunnels };
}

it('validates proxies and never accepts a path or another scheme', () => {
  expect(bridgeProxy(' http://127.0.0.1:7890/ ')).toBe('http://127.0.0.1:7890');
  expect(bridgeProxy('https://user:p%40ss@proxy.example:8443')).toBe('https://user:p%40ss@proxy.example:8443');
  for (const bad of ['socks5://127.0.0.1:7890', 'http://127.0.0.1:7890/path', '127.0.0.1:7890', 'http://h?x=1']) {
    expect(() => bridgeProxy(bad)).toThrow();
  }
});

it('registers, pairs and relays through each device’s proxy, and switches back to direct', async () => {
  const bridge = await listen(createBridge({ registrationToken: 'p'.repeat(32), database: ':memory:' }));
  cleanup.push(() => {
    bridge.closeAllConnections();
    bridge.close();
  });
  const url = `http://127.0.0.1:${port(bridge)}`;
  const hostProxy = await proxy();
  const guestProxy = await proxy();
  const dir = mkdtempSync(join(tmpdir(), 'marifold-proxy-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const host = new WorkspaceManager(join(dir, 'host.toml'));
  const guest = new WorkspaceManager(join(dir, 'guest.toml'));
  cleanup.push(() => {
    host.close();
    guest.close();
  });
  host.start(async (_operation, input) => input);
  guest.start(async () => null);
  const credentialed = hostProxy.url.replace('http://', 'http://me:secret@');
  const created = await host.create('Home', url, 'p'.repeat(32), credentialed);
  expect(created.workspace.proxy).toBe(hostProxy.url);
  const joined = await guest.add(url, created.invitation, false, guestProxy.url);
  expect(await guest.request(joined.id, 'echo', { via: 'proxy' })).toEqual({ via: 'proxy' });
  const target = `127.0.0.1:${port(bridge)}`;
  // Registration (fetch) and the WebSocket both tunnel; credentials reach only the proxy.
  expect(hostProxy.tunnels.length).toBeGreaterThanOrEqual(2);
  expect(hostProxy.tunnels.every((t) => t.target === target)).toBe(true);
  expect(hostProxy.tunnels.some((t) => t.authorization === `Basic ${Buffer.from('me:secret').toString('base64')}`)).toBe(true);
  expect(guestProxy.tunnels.length).toBeGreaterThanOrEqual(2);
  const viaProxy = guestProxy.tunnels.length;
  expect(guest.setProxy(joined.id, undefined).proxy).toBeUndefined();
  await expect.poll(() => guest.list()[0]?.online, { timeout: 10000 }).toBe(true);
  expect(await guest.request(joined.id, 'echo', { via: 'direct' })).toEqual({ via: 'direct' });
  expect(guestProxy.tunnels.length).toBe(viaProxy);
}, 30000);

it.skipIf(!hasOpenssl())('runs TLS to the bridge inside the tunnel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marifold-proxy-tls-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
  ], { stdio: 'ignore' });
  const cert = readFileSync(join(dir, 'cert.pem'));
  const server = await listen(createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert }));
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => ws.on('message', (data) => ws.send(`echo:${data}`)));
  cleanup.push(() => {
    wss.close();
    server.closeAllConnections();
    server.close();
  });
  const relay = await proxy();
  const ws = new WebSocket(`wss://localhost:${port(server)}/`, { agent: bridgeProxyAgent(relay.url, true), ca: cert });
  cleanup.push(() => ws.terminate());
  const reply = await new Promise<string>((resolve, reject) => {
    ws.once('open', () => ws.send('hello'));
    ws.once('message', (data) => resolve(String(data)));
    ws.once('error', reject);
  });
  expect(reply).toBe('echo:hello');
  expect(relay.tunnels).toEqual([{ target: `localhost:${port(server)}`, authorization: undefined }]);
});

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
