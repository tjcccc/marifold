import * as net from 'node:net';
import { checkDestination, type Lookup } from './EgressFilter';

// Runs inside the agent computer's egress container (copied with EgressFilter;
// no other Marifold imports). HTTP CONNECT and absolute-URI HTTP only.

const MAX_HEAD = 16 * 1024;

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
    const check = await checkDestination(request.host, !upstream, options.lookup);
    if (!check.allowed) {
      log(`DENY ${request.method} ${request.host}:${request.port} (${check.reason})`);
      return refuse(client, '403 Forbidden', `The agent computer cannot reach ${request.host}: ${check.reason}.`);
    }
    log(`ALLOW ${request.method} ${request.host}:${request.port}${upstream ? ' via upstream' : ` -> ${check.address}`}`);
    // Direct mode connects to the exact address that was checked. Upstream mode
    // opens its own CONNECT tunnel to the checked host, so later requests on a
    // kept-alive connection cannot reach a different, unchecked host.
    const target = upstream ? upstream : { host: check.address!, port: request.port };
    const remote = net.connect(target.port, target.host);
    remote.setTimeout(30_000, () => remote.destroy());
    remote.once('connect', async () => {
      remote.setTimeout(0);
      if (upstream) {
        const authority = `${check.host.includes(':') ? `[${check.host}]` : check.host}:${request.port}`;
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
