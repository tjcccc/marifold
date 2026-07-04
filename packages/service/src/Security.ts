import * as crypto from 'crypto';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { MarifoldError, MarifoldServiceConfig } from '@marifold/core';

/** Effective security settings: explicit options win over the [service]
 * config section. An unresolved/empty token means auth is disabled (bare
 * loopback keeps working, the pre-auth default). */
export interface ServiceSecurityOptions {
  token?: string;
  corsOrigins: string[];
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
/** Host values a loopback-bound service legitimately sees. Anything else is a
 * DNS-rebinding attempt (a hostile page resolving its domain to 127.0.0.1). */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
/** Native EventSource cannot set headers, so the runs event stream may carry
 * the token as ?access_token=. Fetch-based SSE with the header is preferred. */
const QUERY_TOKEN_PATHS = /^\/v1\/runs\/[^/]+\/events(\?|$)/;

/**
 * One onRequest hook enforcing, in order: the browser origin allowlist (with
 * preflight short-circuit), a loopback Host check, and optional bearer auth.
 * Runs before route matching, so unknown routes are protected too.
 */
export function registerSecurity(server: FastifyInstance, options: ServiceSecurityOptions): void {
  server.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
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
    if (typeof host === 'string' && host !== '' && !LOOPBACK_HOST.test(host)) {
      throw MarifoldError.originForbidden(host);
    }

    if (!options.token) return;
    if (request.url === '/health' || request.url.startsWith('/health?')) return;
    const presented = extractToken(request);
    if (!presented || !timingSafeEqualString(presented, options.token)) {
      throw MarifoldError.unauthorized();
    }
  });
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
