import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const LIFETIME_MS = 5 * 60 * 1000;
const MAX_TICKETS = 512;
const TICKET_PATH = /^\/v1\/downloads\/([a-f0-9]{48})$/;

/** Browser navigation cannot attach bearer headers. Each authenticated issue
 * grants a short-lived URL for exactly one published file and disposition. */
export class ArtifactTickets {
  private readonly entries = new Map<string, { expires: number; send: (reply: FastifyReply) => Promise<unknown> }>();

  issue(send: (reply: FastifyReply) => Promise<unknown>): { path: string; expiresAt: string } {
    for (const [key, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(key);
    while (this.entries.size >= MAX_TICKETS) this.entries.delete(this.entries.keys().next().value!);
    const key = randomBytes(24).toString('hex');
    const expires = Date.now() + LIFETIME_MS;
    this.entries.set(key, { expires, send });
    return { path: `/v1/downloads/${key}`, expiresAt: new Date(expires).toISOString() };
  }

  authorize = (request: FastifyRequest): boolean => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const key = TICKET_PATH.exec(request.url)?.[1];
    return Boolean(key && this.get(key));
  };

  register(server: FastifyInstance): void {
    server.get<{ Params: { ticket: string } }>('/v1/downloads/:ticket', async (request, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      const entry = this.get(request.params.ticket);
      if (!entry) return reply.code(410).send({ ok: false, error: { code: 'DOWNLOAD_EXPIRED', message: 'Download link expired. Click Download again to create a new link.' } });
      return entry.send(reply);
    });
    server.addHook('onClose', async () => { this.entries.clear(); });
  }

  private get(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expires > Date.now()) return entry;
    this.entries.delete(key);
    return undefined;
  }
}

export function artifactDisposition(name: string, inline = false): string {
  const basename = name.split('/').at(-1) || 'artifact';
  const fallback = basename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(basename)}`;
}

export function artifactHeaders(reply: FastifyReply, artifact: { name: string; mediaType: string; size: number }, inline = false): void {
  reply.type(artifact.mediaType).header('content-length', String(artifact.size))
    .header('content-disposition', artifactDisposition(artifact.name, inline))
    .header('x-content-type-options', 'nosniff').header('cache-control', 'no-store')
    .header('content-security-policy', "default-src 'none'; sandbox");
}
