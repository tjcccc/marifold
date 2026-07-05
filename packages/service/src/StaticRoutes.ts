import * as fs from 'fs';
import * as path from 'path';
import { FastifyInstance, FastifyReply } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Host a built single-page Web UI from `webDir` (hand-rolled on purpose —
 * zero-plugin house style, and the SPA/JSON-404 coordination is easier owned
 * than configured):
 *
 * - `/v1/*` and `/health` fall through to the JSON 404 handler untouched.
 * - Real files stream with their content type; Vite's content-hashed
 *   `/assets/*` get immutable caching, everything else no-cache.
 * - Extensionless misses serve index.html (SPA fallback for hash/deep links).
 * - Paths resolving outside `webDir` are rejected (traversal guard).
 */
export function registerStaticRoutes(server: FastifyInstance, webDir: string): void {
  const root = path.resolve(webDir);

  server.get('/*', async (request, reply) => {
    const pathname = decodePathname(request.url);
    if (pathname === undefined) return notFound(reply);
    if (pathname === '/health' || pathname === '/v1' || pathname.startsWith('/v1/')) {
      return notFound(reply);
    }

    const resolved = path.resolve(root, `.${path.posix.normalize(pathname)}`);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return notFound(reply);

    const filePath = await resolveFile(resolved);
    if (filePath) return sendFile(reply, filePath, pathname);

    // SPA fallback: routes without an extension are app views.
    if (path.posix.extname(pathname) === '') {
      const index = await resolveFile(path.join(root, 'index.html'));
      if (index) return sendFile(reply, index, '/index.html');
    }
    return notFound(reply);
  });
}

function decodePathname(url: string): string | undefined {
  try {
    const pathname = new URL(url, 'http://loopback').pathname;
    const decoded = decodeURIComponent(pathname);
    // Encoded separators or null bytes have no legitimate use here.
    if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

async function resolveFile(candidate: string): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const index = path.join(candidate, 'index.html');
      const indexStat = await fs.promises.stat(index).catch(() => undefined);
      if (indexStat?.isFile()) return index;
    }
  } catch {
    // Missing — the caller decides between SPA fallback and 404.
  }
  return undefined;
}

function sendFile(reply: FastifyReply, filePath: string, pathname: string): FastifyReply {
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const immutable = pathname.startsWith('/assets/');
  return reply
    .header('content-type', type)
    .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    .send(fs.createReadStream(filePath));
}

function notFound(reply: FastifyReply): FastifyReply {
  reply.callNotFound();
  return reply;
}
