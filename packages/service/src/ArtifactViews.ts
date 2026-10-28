import { randomBytes } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ArtifactLibrary, bundleMediaType } from '@marifold/core';

const IDLE_MS = 60 * 60 * 1000;
const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;
const MAX_VIEWS = 512;
const VIEW_PREFIX = '/v1/artifact-views/';
const VIEW_PATH = /^\/v1\/artifact-views\/([a-f0-9]{48})\//;
/** Host header values that can go into a CSP source unescaped. */
const SAFE_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

const VIEW_EXPIRED = { ok: false, error: { code: 'VIEW_EXPIRED', message: 'This artifact view expired. Open the artifact again.' } };

/** Fetches a file of a view issued on another device, by its path under that
 * device's ticket. */
export type RemoteViewFetch = (file: string) => Promise<{ status: number; body: Buffer }>;

type View = ({ artifactId: string; version: number } | { remote: RemoteViewFetch; entry: string }) & {
  expires: number;
  ends: number;
};

/**
 * View tickets for library artifacts (docs/artifacts.md#viewer): a ticket
 * serves one version's files under `/v1/artifact-views/<ticket>/`, to a
 * sandboxed frame whose origin is opaque (`Origin: null`). Use keeps a ticket
 * alive (1 h idle, 12 h at most) so an open page never has to reload. These
 * paths alone skip the origin allowlist and bearer token; the private-network
 * and Host checks still apply. Every file is served under a CSP that sandboxes
 * it without `allow-same-origin` and limits every fetch to the ticket's prefix.
 */
export class ArtifactViews {
  private readonly views = new Map<string, View>();

  constructor(private readonly library: ArtifactLibrary, private readonly now: () => number = Date.now) {}

  issue(artifactId: string, version: number): { path: string; expiresAt: string } {
    return this.add({ artifactId, version });
  }

  /** A local ticket for a view the workspace host issued: this device serves
   * the files under its own origin and policy, fetching them through the bridge. */
  issueRemote(entry: string, remote: RemoteViewFetch): { path: string; expiresAt: string } {
    return this.add({ remote, entry });
  }

  private add(target: { artifactId: string; version: number } | { remote: RemoteViewFetch; entry: string }): { path: string; expiresAt: string } {
    const now = this.now();
    for (const [key, view] of this.views) { if (view.expires <= now) { this.views.delete(key); } }
    while (this.views.size >= MAX_VIEWS) { this.views.delete(this.views.keys().next().value!); }
    const key = randomBytes(24).toString('hex');
    const view: View = { ...target, expires: now + IDLE_MS, ends: now + MAX_LIFETIME_MS };
    this.views.set(key, view);
    return { path: `${VIEW_PREFIX}${key}/`, expiresAt: new Date(view.expires).toISOString() };
  }

  /** The security hook's exception: a GET of a live ticket's normalized path. */
  authorize = (request: FastifyRequest): boolean => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { return false; }
    const pathname = viewPathname(request.url);
    const key = pathname ? VIEW_PATH.exec(pathname)?.[1] : undefined;
    return Boolean(key && this.get(key));
  };

  register(server: FastifyInstance): void {
    server.get<{ Params: { ticket: string; '*': string } }>(`${VIEW_PREFIX}:ticket/*`, async (request, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
        .header('x-content-type-options', 'nosniff').header('access-control-allow-origin', '*');
      const view = this.get(request.params.ticket);
      const host = request.headers.host;
      if (!view || typeof host !== 'string' || !SAFE_HOST.test(host)) {
        return reply.code(410).send(VIEW_EXPIRED);
      }
      const bundle = `${request.protocol}://${host}${VIEW_PREFIX}${request.params.ticket}/`;
      const wanted = request.params['*'];
      if ('remote' in view) {
        const name = wanted || view.entry;
        let fetched: { status: number; body: Buffer };
        try {
          fetched = await view.remote(name);
        } catch {
          return reply.code(502).send({ ok: false, error: { code: 'WORKSPACE_UNAVAILABLE', message: 'The workspace host is unreachable. Try again when it is back.' } });
        }
        const { status, body } = fetched;
        if (status === 410) { return reply.code(410).send(VIEW_EXPIRED); }
        if (status !== 200) { return reply.code(status === 404 ? 404 : 502).send({ ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: `Could not load ${name} from the workspace host.` } }); }
        // The type comes from this device's own table, never the host's header.
        return reply.type(bundleMediaType(name)).header('content-security-policy', viewPolicy(bundle)).send(body);
      }
      const name = wanted || this.library.get(view.artifactId)?.versions.find(entry => entry.version === view.version)?.entry || '';
      const file = this.library.file(view.artifactId, view.version, name);
      if (!file) { return reply.code(404).send({ ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: `No file ${name} in this artifact.` } }); }
      reply.type(file.mediaType).header('content-length', String(file.size)).header('content-security-policy', viewPolicy(bundle));
      return reply.send(fs.createReadStream(file.absolutePath));
    });
    server.addHook('onClose', async () => { this.views.clear(); });
  }

  private get(key: string): View | undefined {
    const view = this.views.get(key);
    const now = this.now();
    if (!view || view.expires <= now) {
      this.views.delete(key);
      return undefined;
    }
    view.expires = Math.min(now + IDLE_MS, view.ends);
    return view;
  }
}

/** Sandboxed with scripts and popups, never same-origin; every source is the
 * ticket's own prefix, inline code, or data/blob URLs. No CDN, no remote image. */
export function viewPolicy(bundle: string): string {
  const own = `${bundle} 'unsafe-inline' data: blob:`;
  return [
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    "default-src 'none'",
    `script-src ${own}`,
    `style-src ${own}`,
    `img-src ${own}`,
    `font-src ${own}`,
    `media-src ${own}`,
    `connect-src ${bundle} data: blob:`,
    `worker-src ${bundle} blob:`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** The decoded pathname when it is already normalized (no `.`/`..` segments,
 * doubled or back slashes); anything else is not a view path. */
function viewPathname(url: string): string | undefined {
  let pathname = url.split(/[?#]/, 1)[0]!;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes('\0') || pathname.includes('\\') || !pathname.startsWith(VIEW_PREFIX)) { return undefined; }
  return path.posix.normalize(pathname) === pathname ? pathname : undefined;
}
