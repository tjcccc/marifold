import { digest } from '@marifold/workspace-protocol';
import type { Relay } from './Relay';

export const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 16384;
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function json(status: number, body: string): Response {
  return new Response(body, { status, headers: HEADERS });
}
export function healthResponse(): Response {
  return json(200, JSON.stringify({ service: 'marifold-bridge', version: 1, deliveryReplay: 'on-reconnect' }));
}
function sameSecret(a: string, b: string): boolean {
  // Comparing fixed-length digests keeps timing independent of the secret.
  const x = digest(a);
  const y = digest(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) { difference |= x.charCodeAt(i) ^ y.charCodeAt(i); }
  return difference === 0;
}
async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) { return ''; }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { break; }
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('Body too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The bridge's HTTP routes, on web-standard Request/Response. WebSocket
 * upgrades on `/v1/connect` belong to the adapter. */
export async function handleHttp(request: Request, relay: Relay, registrationToken: string | undefined): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/health') { return healthResponse(); }
  if (request.method !== 'POST' || pathname !== '/v1/hosts') { return json(404, '{}'); }
  if (!registrationToken || registrationToken.length < MIN_TOKEN_LENGTH) {
    return json(503, '{"error":"Bridge registration token is not configured."}');
  }
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!sameSecret(token, registrationToken)) { return json(401, '{}'); }
  try {
    relay.register(JSON.parse(await readBody(request)));
    return json(200, '{"ok":true}');
  } catch {
    return json(400, '{"error":"Registration rejected."}');
  }
}
