import * as crypto from 'crypto';
import { isIP } from 'net';
import * as path from 'path';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { MarifoldError, MarifoldServiceConfig } from '@marifold/core';

/** Effective security settings: explicit options win over the [service]
 * config section. An unresolved/empty token means auth is disabled (bare
 * loopback keeps working, the pre-auth default). */
export interface ResolvedServiceSecurityOptions {
  token?: string;
  corsOrigins: string[];
}

export interface ServiceSecurityOptions extends ResolvedServiceSecurityOptions {
  /** Network reachability policy. The actual listen address remains a separate
   * transport choice; private mode filters every request by its socket peer. */
  access: 'loopback' | 'private' | 'public';
  /** Explicit listen host, used as an allowed Host value in private mode. */
  boundHost: string;
}

export function resolveSecurityOptions(
  config: MarifoldServiceConfig | undefined,
  overrides: { token?: string; corsOrigins?: string[] } = {},
): ResolvedServiceSecurityOptions {
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
    if (options.access === 'private' && !isPrivateNetworkAddress(request.ip)) {
      throw MarifoldError.networkForbidden(request.ip);
    }

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
  if (options.access === 'public') return true;
  if (options.access === 'loopback') return LOOPBACK_HOST.test(host);
  if (options.token) return true;

  const hostname = hostnameFromHeader(host);
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  return normalized === options.boundHost.toLowerCase()
    || isPrivateNetworkAddress(normalized)
    || !normalized.includes('.')
    || normalized.endsWith('.local')
    || normalized.endsWith('.ts.net');
}

function hostnameFromHeader(host: string): string | undefined {
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  } catch {
    return undefined;
  }
}

/** True for directly connected client ranges intended by private access:
 * loopback, RFC 1918 LANs, IPv4/IPv6 link-local, IPv6 ULA, and the shared
 * 100.64/10 range used by Tailscale. X-Forwarded-For is intentionally ignored;
 * Fastify's direct socket peer is the security boundary. */
function isPrivateNetworkAddress(address: string): boolean {
  const bytes = parseIpAddress(address);
  if (!bytes) return false;
  if (bytes.length === 4) return isPrivateIpv4(bytes);

  const mapped = bytes.slice(0, 10).every(byte => byte === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
  if (mapped) return isPrivateIpv4(bytes.slice(12));

  const loopback = bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1;
  const uniqueLocal = (bytes[0] & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
  return loopback || uniqueLocal || linkLocal;
}

function isPrivateIpv4(bytes: number[]): boolean {
  return bytes[0] === 10
    || bytes[0] === 127
    || (bytes[0] === 169 && bytes[1] === 254)
    || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31)
    || (bytes[0] === 192 && bytes[1] === 168)
    || (bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127);
}

function parseIpAddress(rawAddress: string): number[] | undefined {
  const address = rawAddress.split('%', 1)[0];
  const version = isIP(address);
  if (version === 4) return address.split('.').map(part => Number(part));
  if (version !== 6) return undefined;

  let ipv6 = address.toLowerCase();
  if (ipv6.includes('.')) {
    const lastColon = ipv6.lastIndexOf(':');
    const ipv4 = parseIpAddress(ipv6.slice(lastColon + 1));
    if (!ipv4 || ipv4.length !== 4) return undefined;
    ipv6 = `${ipv6.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = ipv6.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const words = [...left, ...Array(missing).fill('0'), ...right].map(word => Number.parseInt(word, 16));
  if (words.length !== 8 || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return undefined;
  }
  return words.flatMap(word => [word >> 8, word & 0xff]);
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
