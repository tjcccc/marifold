import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  digest,
  identifier,
  MAX_FRAME_BYTES,
  parseHeader,
  randomId,
  record,
  validMembership,
  verifyText,
} from '@marifold/workspace-protocol';
import type { PublicIdentity, SignedMembership } from '@marifold/workspace-protocol';
import type { RelayStore } from './Store';
export { MemoryRelayStore, RedisRelayStore } from './Store';

export function createBridge(store: RelayStore, registrationToken: string) {
  if (registrationToken.length < 32) throw new Error('Bridge registration token must contain at least 32 characters.');
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    // Accept the Vercel function entry as well as the original rewritten URL.
    const route = req.url === '/api/bridge' ? (req.method === 'POST' ? '/v1/hosts' : '/health') : req.url;
    if (req.method === 'GET' && route === '/health') {
      res.end(JSON.stringify({ service: 'marifold-bridge', version: 1, deliveryReplay: 'on-reconnect' }));
      return;
    }
    if (req.method !== 'POST' || route !== '/v1/hosts') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(registrationToken)))) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16384) throw new Error('Body too large.');
      }
      const b = record(JSON.parse(body));
      const host = record(b.host) as unknown as PublicIdentity;
      if (typeof host.signingKey !== 'string' || !host.encryptionKey) throw new Error('Invalid host identity.');
      await store.register({ workspaceId: identifier(b.workspaceId), hostDeviceId: identifier(b.hostDeviceId), host });
      res.end('{"ok":true}');
    } catch {
      res.writeHead(400);
      res.end('{"error":"Registration rejected."}');
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    if (wss.clients.size >= 128 || !['/v1/connect', '/api/bridge'].includes(request.url ?? '')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    const nonce = randomId();
    const generation = randomId();
    let auth:
      | {
          workspace: string;
          device: string;
          identity: PublicIdentity;
          certificate?: SignedMembership;
          hostDevice: string;
        }
      | undefined;
    let stop: (() => void) | undefined;
    let chain = Promise.resolve();
    let count = 0;
    let window = Date.now();
    let queued = 0;
    const timer = setTimeout(() => ws.close(1008, 'Authentication timeout'), 10000);
    ws.send(JSON.stringify({ type: 'challenge', nonce }));
    ws.on('message', (bytes) => {
      if (++queued > 128) {
        ws.close(1008, 'Pending frame limit');
        return;
      }
      chain = chain
        .then(async () => {
          if (Date.now() - window > 1000) {
            window = Date.now();
            count = 0;
          }
          if (++count > 512) throw new Error('Rate limit.');
          if (ws.readyState !== WebSocket.OPEN) return;
          const data = record(JSON.parse(bytes.toString()));
          if (!auth) {
            if (data.type !== 'auth') throw new Error('Authentication required.');
            const workspace = identifier(data.workspaceId);
            const device = identifier(data.deviceId);
            const host = await store.host(workspace);
            if (!host || (await store.revoked(workspace, device)))
              throw new Error('Unknown or revoked workspace membership.');
            const certificate = data.certificate as SignedMembership | undefined;
            let identity: PublicIdentity;
            if (certificate) {
              if (
                !validMembership(certificate, host.host) ||
                certificate.membership.workspaceId !== workspace ||
                certificate.membership.deviceId !== device
              )
                throw new Error('Invalid membership.');
              identity = certificate.membership.identity;
            } else {
              if (!device.startsWith('pending_')) throw new Error('Invalid pairing identity.');
              identity = data.identity as PublicIdentity;
            }
            if (!verifyText(identity, nonce, String(data.signature))) throw new Error('Invalid proof of possession.');
            auth = { workspace, device, identity, certificate, hostDevice: host.hostDeviceId };
            await store.connect(workspace, device, generation);
            stop = await store.receive(workspace, device, (id, packet) => {
              void Promise.all([store.current(workspace, device, generation), store.revoked(workspace, device)])
                .then(([current, revoked]) => {
                  if (!current || revoked) {
                    ws.close(1008, 'Membership or connection replaced');
                    return;
                  }
                  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_FRAME_BYTES * 8)
                    ws.send(JSON.stringify({ type: 'delivery', deliveryId: id, packet: JSON.parse(packet) }));
                  else ws.close(1013, 'Slow consumer');
                })
                .catch(() => ws.close(1011, 'Relay unavailable'));
            });
            if (ws.readyState !== WebSocket.OPEN) {
              stop();
              return;
            }
            clearTimeout(timer);
            ws.send(JSON.stringify({ type: 'ready', hostDeviceId: host.hostDeviceId, deliveryReplay: 'on-reconnect' }));
            return;
          }
          if (
            (await store.revoked(auth.workspace, auth.device)) ||
            !(await store.current(auth.workspace, auth.device, generation))
          )
            throw new Error('Membership or connection replaced.');
          if (data.type === 'ping') {
            await store.connect(auth.workspace, auth.device, generation);
            ws.send('{"type":"pong"}');
            return;
          }
          if (data.type === 'ack') {
            if (typeof data.deliveryId !== 'string' || data.deliveryId.length > 100)
              throw new Error('Invalid acknowledgment.');
            await store.ack(auth.workspace, auth.device, data.deliveryId);
            return;
          }
          if (data.type === 'revoke' && auth.device === auth.hostDevice) {
            await store.revoke(auth.workspace, identifier(data.deviceId));
            ws.send(JSON.stringify({ type: 'revoked', id: identifier(data.id) }));
            return;
          }
          if (data.type !== 'send') throw new Error('Unknown message.');
          const message = record(data.message);
          const h = parseHeader(message.header);
          if (
            h.workspaceId !== auth.workspace ||
            h.sender !== auth.device ||
            (auth.device !== auth.hostDevice && h.recipient !== auth.hostDevice)
          )
            throw new Error('Routing denied.');
          if (h.expiresAt < Date.now() || h.expiresAt > Date.now() + 65000) throw new Error('Message expired.');
          if (await store.revoked(auth.workspace, h.recipient)) return;
          await store.publish(
            auth.workspace,
            h.recipient,
            JSON.stringify({ message, identity: auth.identity, certificate: auth.certificate }),
          );
        })
        .catch(() => ws.close(1008, 'Bridge request rejected'))
        .finally(() => {
          queued--;
        });
    });
    ws.on('close', () => {
      clearTimeout(timer);
      stop?.();
    });
    ws.on('error', () => undefined);
  });
  server.on('close', () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    void store.close();
  });
  return server;
}
