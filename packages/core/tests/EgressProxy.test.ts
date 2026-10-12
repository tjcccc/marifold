import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDestination, forbiddenAddress } from '../src/computer/EgressFilter';
import { createEgressProxy, parseProxyRequest } from '../src/computer/EgressProxy';

const servers: net.Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) { server.close(); } });
function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}
const publicLookup = async (host: string) => (host === 'rebind.example' ? ['93.184.216.34', '192.168.50.23'] : ['93.184.216.34']);

describe('egress filter', () => {
  it('refuses local and private addresses in every spelling', async () => {
    for (const host of [
      '192.168.50.23', '3232248343', '0300.0250.062.027', '0xc0a83217', '127.0.0.1', '127.1', '0.250.250.254', '10.1.2.3',
      '172.20.0.1', '100.100.1.1', '169.254.169.254', '[::1]', '::ffff:192.168.50.23', '[::ffff:c0a8:3217]', '64:ff9b::c0a8:3217',
      'fd07:b51a:cc66:f0::fe', 'fe80::1', 'localhost', 'LOCALHOST.', 'api.localhost', 'host.docker.internal', 'host.orb.internal',
      'printer.local', 'router.lan', 'intranet', 'rebind.example',
    ]) {
      expect((await checkDestination(host, true, publicLookup)).allowed, host).toBe(false);
    }
  });

  it('allows public addresses and names, connecting to the checked address', async () => {
    expect(await checkDestination('mirrors.aliyun.com.', true, publicLookup)).toEqual({ allowed: true, host: 'mirrors.aliyun.com', address: '93.184.216.34' });
    expect(await checkDestination('223.5.5.5', true, publicLookup)).toMatchObject({ allowed: true, address: '223.5.5.5' });
    expect(forbiddenAddress('2606:4700::1111')).toBe(false);
    // Through an upstream, a name local DNS cannot resolve is left to the upstream.
    const failing = async () => { throw new Error('ENOTFOUND'); };
    expect((await checkDestination('blocked-here.example', false, failing)).allowed).toBe(true);
    expect((await checkDestination('blocked-here.example', true, failing)).allowed).toBe(false);
  });

  it('parses only CONNECT and http:// proxy requests', () => {
    expect(parseProxyRequest('CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org:443\r\n\r\n')).toMatchObject({ method: 'CONNECT', host: 'pypi.org', port: 443 });
    expect(parseProxyRequest('GET http://example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\n\r\n')?.originHead?.toString())
      .toBe('GET /a?b=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
    for (const bad of ['GET /relative HTTP/1.1', 'GET https://example.com/ HTTP/1.1', 'GET http://u:p@example.com/ HTTP/1.1', 'CONNECT example.com:0 HTTP/1.1']) {
      expect(parseProxyRequest(`${bad}\r\n\r\n`), bad).toBeUndefined();
    }
  });
});

describe('egress proxy through an upstream', () => {
  it('tunnels allowed hosts and never forwards refused ones', async () => {
    const seen: string[] = [];
    const upstream = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        seen.push(chunk.toString('latin1').split('\r\n')[0]!);
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        socket.on('data', data => socket.write(`echo:${data.toString('latin1').split('\r\n')[0]}`));
      });
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await listen(createEgressProxy({ upstream: `127.0.0.1:${upstreamPort}`, lookup: publicLookup, log: () => undefined }));
    const ask = (head: string) => new Promise<string>((resolve) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(head));
      let text = '';
      socket.on('data', (data) => {
        text += data.toString('latin1');
        if (text.includes('echo:') || text.startsWith('HTTP/1.1 403')) { socket.destroy(); resolve(text); }
      });
      socket.on('close', () => resolve(text));
    });

    expect(await ask('GET http://192.168.50.23:32140/v1/sessions HTTP/1.1\r\nHost: x\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/);
    expect(await ask('CONNECT host.docker.internal:7890 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/);
    expect(seen).toEqual([]);
    // Plain HTTP goes through a CONNECT tunnel to the checked host, in origin form.
    expect(await ask('GET http://mirrors.example/ubuntu/ HTTP/1.1\r\nHost: mirrors.example\r\n\r\n')).toContain('echo:GET /ubuntu/ HTTP/1.1');
    expect(seen).toEqual(['CONNECT mirrors.example:80 HTTP/1.1']);
  });
});
