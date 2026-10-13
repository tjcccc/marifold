import { promises as dns } from 'node:dns';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { checkDestination, type Lookup } from './EgressFilter';

// Runs inside the agent computer's egress container (copied with EgressFilter;
// no other Marifold imports). HTTP CONNECT and absolute-URI HTTP only.

const MAX_HEAD = 16 * 1024;
/** DNS-over-HTTPS resolver used through the upstream proxy (its certificate covers the IP). */
const DOH = { address: '1.1.1.1', name: 'cloudflare-dns.com' };

export interface EgressProxyOptions {
  /** `host:port` of the user's own HTTP proxy; absent connects directly. */
  upstream?: string;
  lookup?: Lookup;
  log?: (line: string) => void;
}

interface ParsedRequest {
  method: string;
  host: string;
  port: number;
  /** Request head rewritten for a direct origin connection (plain HTTP only). */
  originHead?: Buffer;
}

export function parseProxyRequest(head: string): ParsedRequest | undefined {
  const [line, ...headers] = head.split('\r\n');
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line ?? '');
  if (!match) { return undefined; }
  const [, method, target] = match;
  if (method === 'CONNECT') {
    const authority = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(target!);
    return authority ? withPort({ method, host: authority[1]!, port: Number(authority[2]) }) : undefined;
  }
  let url: URL;
  try {
    url = new URL(target!);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || url.username || url.password) { return undefined; }
  const kept = headers.filter(header => header && !/^(proxy-[a-z-]+|connection|keep-alive):/i.test(header));
  const originHead = Buffer.from([`${method} ${url.pathname}${url.search} HTTP/1.1`, ...kept, 'Connection: close', '', ''].join('\r\n'));
  return withPort({ method: method!, host: url.hostname, port: Number(url.port || 80), originHead });
}

function withPort(request: ParsedRequest): ParsedRequest | undefined {
  return Number.isInteger(request.port) && request.port > 0 && request.port <= 65535 ? request : undefined;
}

function refuse(socket: net.Socket, status: string, reason: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(reason) + 1}\r\n\r\n${reason}\n`);
}

export function createEgressProxy(options: EgressProxyOptions = {}): net.Server {
  const log = options.log ?? (line => process.stdout.write(`${line}\n`));
  const upstream = options.upstream ? parseUpstream(options.upstream) : undefined;
  // Through an upstream, names are resolved over DNS-over-HTTPS through that
  // same upstream (local DNS may be poisoned where a proxy is needed), and the
  // tunnel is opened to the checked address, so the upstream never resolves a
  // name itself and DNS rebinding cannot steer it to a local address.
  const lookup = options.lookup ?? (upstream ? upstreamLookup(upstream) : undefined);
  return net.createServer((client) => {
    client.on('error', () => client.destroy());
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffered.length > MAX_HEAD) { refuse(client, '431 Request Header Fields Too Large', 'Request head too large.'); }
        return;
      }
      client.off('data', onData);
      client.pause();
      const head = buffered.subarray(0, end + 4);
      const rest = buffered.subarray(end + 4);
      void forward(client, head, rest).catch(() => client.destroy());
    };
    client.on('data', onData);
  });

  async function forward(client: net.Socket, head: Buffer, rest: Buffer): Promise<void> {
    const request = parseProxyRequest(head.toString('latin1'));
    if (!request) { return refuse(client, '400 Bad Request', 'Only HTTP CONNECT and http:// proxy requests are supported.'); }
    const check = await checkDestination(request.host, true, lookup);
    if (!check.allowed) {
      log(`DENY ${request.method} ${request.host}:${request.port} (${check.reason})`);
      return refuse(client, '403 Forbidden', `The agent computer cannot reach ${request.host}: ${check.reason}.`);
    }
    log(`ALLOW ${request.method} ${request.host}:${request.port} -> ${check.address}${upstream ? ' via upstream' : ''}`);
    // Both modes connect to the exact address that was checked. Upstream mode
    // opens its own CONNECT tunnel to it, so later requests on a kept-alive
    // connection cannot reach a different, unchecked host.
    const target = upstream ? upstream : { host: check.address!, port: request.port };
    const remote = net.connect(target.port, target.host);
    remote.setTimeout(30_000, () => remote.destroy());
    remote.once('connect', async () => {
      remote.setTimeout(0);
      if (upstream) {
        const authority = `${check.address!.includes(':') ? `[${check.address}]` : check.address}:${request.port}`;
        remote.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
        const status = await tunnelStatus(remote);
        if (status !== 200) { return refuse(client, '502 Bad Gateway', `The upstream proxy refused ${request.host} (${status ?? 'no answer'}).`); }
      }
      if (request.method === 'CONNECT') {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      } else {
        remote.write(request.originHead!);
      }
      if (rest.length > 0) { remote.write(rest); }
      client.pipe(remote);
      remote.pipe(client);
      client.resume();
    });
    remote.on('error', () => {
      if (!client.destroyed && client.bytesWritten === 0) { refuse(client, '502 Bad Gateway', `Could not connect to ${request.host}.`); } else { client.destroy(); }
    });
    client.on('close', () => remote.destroy());
    remote.on('close', () => client.destroy());
  }
}

/** Read the upstream's CONNECT reply head and return its status code. */
function tunnelStatus(socket: net.Socket): Promise<number | undefined> {
  return new Promise((resolve) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0 && head.length < MAX_HEAD) { return; }
      socket.off('data', onData);
      if (end >= 0 && head.length > end + 4) { socket.unshift(head.subarray(end + 4)); }
      resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'))?.[1]) || undefined);
    };
    socket.on('data', onData);
    socket.once('close', () => resolve(undefined));
  });
}

/** Open a CONNECT tunnel through the upstream to `host:port`. */
async function tunnel(upstream: { host: string; port: number }, host: string, port: number): Promise<net.Socket> {
  const socket = net.connect(upstream.port, upstream.host);
  socket.setTimeout(10_000, () => socket.destroy(new Error('upstream timeout')));
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  const status = await tunnelStatus(socket);
  if (status !== 200) {
    socket.destroy();
    throw new Error(`upstream refused the DNS tunnel (${status ?? 'no answer'})`);
  }
  socket.setTimeout(0);
  return socket;
}

/** One DNS-over-HTTPS JSON query through the upstream; returns addresses and the shortest TTL. */
async function dohQuery(upstream: { host: string; port: number }, name: string, type: 'A' | 'AAAA'): Promise<{ addresses: string[]; ttl: number }> {
  const raw = await tunnel(upstream, DOH.address, 443);
  const secure = tls.connect({ socket: raw, servername: DOH.name });
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: DOH.name, path: `/dns-query?name=${encodeURIComponent(name)}&type=${type}`, method: 'GET',
      headers: { accept: 'application/dns-json', connection: 'close' }, createConnection: () => secure, timeout: 10_000,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) { throw new Error(`DNS-over-HTTPS answered ${response.statusCode}`); }
          const answers = ((JSON.parse(body) as { Answer?: { type: number; data: string; TTL: number }[] }).Answer ?? [])
            .filter(answer => answer.type === (type === 'A' ? 1 : 28));
          resolve({ addresses: answers.map(answer => answer.data), ttl: Math.min(300, ...answers.map(answer => answer.TTL)) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('DNS-over-HTTPS timed out')));
    request.on('error', reject);
    request.end();
  });
}

/** Resolve through the upstream with a short cache; if DNS-over-HTTPS is
 * unreachable, fall back to local DNS. Either way the caller pins the address. */
function upstreamLookup(upstream: { host: string; port: number }): Lookup {
  const cache = new Map<string, { addresses: string[]; expires: number }>();
  return async (name) => {
    const cached = cache.get(name);
    if (cached && cached.expires > Date.now()) { return cached.addresses; }
    try {
      let answer = await dohQuery(upstream, name, 'A');
      if (answer.addresses.length === 0) { answer = await dohQuery(upstream, name, 'AAAA'); }
      cache.set(name, { addresses: answer.addresses, expires: Date.now() + Math.max(30, answer.ttl) * 1000 });
      return answer.addresses;
    } catch {
      return (await dns.lookup(name, { all: true, verbatim: true })).map(entry => entry.address);
    }
  };
}

function parseUpstream(value: string): { host: string; port: number } {
  const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`);
  if (url.protocol !== 'http:' || !url.port) { throw new Error('The upstream proxy must be http://host:port.'); }
  return { host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(url.port) };
}

if (require.main === module) {
  const port = Number(process.env.EGRESS_PORT ?? 8080);
  createEgressProxy({ upstream: process.env.EGRESS_UPSTREAM || undefined }).listen(port, '0.0.0.0', () => {
    process.stdout.write(`marifold egress proxy on :${port}${process.env.EGRESS_UPSTREAM ? ` via ${process.env.EGRESS_UPSTREAM}` : ''}\n`);
  });
}
