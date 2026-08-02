import * as crypto from 'crypto';
import * as path from 'path';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { MarifoldError, MarifoldServiceConfig } from '@marifold/core';

/** Effective security settings: explicit options win over the [service]
 * config section. An unresolved/empty token means auth is disabled (bare
 * loopback keeps working, the pre-auth default). */
export interface ServiceSecurityOptions {
  token?: string;
  corsOrigins: string[];
  /** Accept request Host values beyond loopback. Enabled only when the
   * service explicitly binds a non-loopback address with authentication. */
  allowRemoteHosts?: boolean;
}

export function resolveSecurityOptions(
  config: MarifoldServiceConfig | undefined,
  overrides: { token?: string; corsOrigins?: string[] } = {},
): ServiceSecurityOptions {
  const configured = config?.tokenEnv ? process.env[config.tokenEnv] : config?.token;
  const token = overrides.token ?? configured;
  return {
    ...(token ? { token } : {}),
    corsOrigins: overrides.corsOrigins ?? config?.corsOrigins ?? [],
  };
}

const CORS_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const CORS_HEADERS = 'authorization, content-type, last-event-id';
const CORS_MAX_AGE = '600';
/** Host values a default loopback-bound service legitimately sees. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
/** Native EventSource cannot set headers, so the runs event stream may carry
 * the token as ?access_token=. Fetch-based SSE with the header is preferred. */
const QUERY_TOKEN_PATHS = /^\/v1\/runs\/[^/]+\/events(\?|$)/;

/**
 * One onRequest hook enforcing, in order: the browser origin allowlist (with
 * preflight short-circuit), a bind-scope Host check, and optional bearer auth.
 * Runs before route matching, so unknown routes are protected too.
 */
export function registerSecurity(server: FastifyInstance, options: ServiceSecurityOptions): void {
  server.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== '' && !isSameAllowedOrigin(origin, request.headers.host, options)) {
      if (!options.corsOrigins.includes(origin)) throw MarifoldError.originForbidden(origin);
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      if (request.method === 'OPTIONS') {
        await reply
          .status(204)
          .header('Access-Control-Allow-Methods', CORS_METHODS)
          .header('Access-Control-Allow-Headers', CORS_HEADERS)
          .header('Access-Control-Max-Age', CORS_MAX_AGE)
          .send();
        return reply;
      }
    }

    const host = request.headers.host;
    if (typeof host === 'string' && host !== '' && !isAllowedHost(host, options)) {
      throw MarifoldError.originForbidden(host);
    }

    if (!options.token) return;
    // Only the stateful API is token-gated: the static Web UI shell (and
    // /health) must stay reachable — the shell carries no secrets, and every
    // data route is versioned under /v1. Gate on the NORMALIZED pathname (not
    // a raw-URL prefix) so variants like //v1/x or /v1/../v1/x can't slip past
    // the check regardless of how strictly the router matches them.
    if (!isApiPath(request.url)) return;
    const presented = extractToken(request);
    if (!presented || !timingSafeEqualString(presented, options.token)) {
      throw MarifoldError.unauthorized();
    }
  });
}

/** True when the request targets the token-gated /v1 API, judged on the
 * normalized decoded pathname. Undecodable or suspicious paths are treated as
 * API (gated) — fail closed. Note: deliberately NOT `new URL(url, base)` — a
 * raw path like `//v1/x` would parse as protocol-relative (host `v1`), hiding
 * the very prefix this check exists to see. */
function isApiPath(url: string): boolean {
  let pathname = url.split(/[?#]/, 1)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) return true;
  // posix.normalize resolves ./.. segments; a leading `//` is preserved by
  // POSIX rules, so collapse leading slashes explicitly.
  const normalized = path.posix.normalize(pathname).replace(/^\/+/, '/');
  return normalized === '/v1' || normalized.startsWith('/v1/');
}

/** The service-hosted app is same-origin whether it was reached through the
 * default loopback bind or an explicitly authenticated remote bind. */
function isSameAllowedOrigin(
  origin: string,
  host: string | undefined,
  options: ServiceSecurityOptions,
): boolean {
  if (!host || !isAllowedHost(host, options)) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function isAllowedHost(host: string, options: ServiceSecurityOptions): boolean {
  return options.allowRemoteHosts === true || LOOPBACK_HOST.test(host);
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return token;
  }
  if (request.method === 'GET' && QUERY_TOKEN_PATHS.test(request.url)) {
    const url = new URL(request.url, 'http://loopback');
    return url.searchParams.get('access_token') ?? undefined;
  }
  return undefined;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
