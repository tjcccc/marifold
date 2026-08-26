import { isIP } from 'net';
import { networkInterfaces } from 'os';

export interface ServiceNetworkAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

export type ServiceNetworkInterfaces = Record<string, readonly ServiceNetworkAddress[] | undefined>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackServiceHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(stripIpv6Brackets(host));
}

/** Convert a socket bind address into URLs a person can actually open. A
 * wildcard bind is replaced with the current machine's permitted interface
 * addresses; public addresses are omitted because the service rejects them. */
export function serviceEntryUrls(
  boundAddress: string,
  bindHost?: string,
  interfaces: ServiceNetworkInterfaces = networkInterfaces(),
): string[] {
  let parsed: URL;
  try {
    parsed = new URL(boundAddress);
  } catch {
    return [boundAddress];
  }

  const host = stripIpv6Brackets(bindHost ?? parsed.hostname);
  const family = host === '0.0.0.0' ? 'IPv4' : host === '::' ? 'IPv6' : undefined;
  if (!family) return [boundAddress];

  const loopback = family === 'IPv4' ? '127.0.0.1' : '::1';
  const discovered = Object.values(interfaces)
    .flatMap(entries => entries ?? [])
    .filter(entry => !entry.internal)
    .filter(entry => normalizeFamily(entry.family) === family)
    .map(entry => entry.address)
    .filter(isPermittedEntryAddress);
  const hosts = [...new Set([loopback, ...discovered])]
    .sort((left, right) => addressPriority(left) - addressPriority(right) || left.localeCompare(right));
  return hosts.map(candidate => formatEntryUrl(parsed, candidate));
}

export function formatServiceAvailability(urls: readonly string[]): string {
  if (urls.length === 1) return `Marifold service available at ${urls[0]}`;
  return ['Marifold service available at:', ...urls.map(url => `  ${url}`)].join('\n');
}

export function serviceBindUrl(boundAddress: string, bindHost: string): string {
  try {
    return formatEntryUrl(new URL(boundAddress), stripIpv6Brackets(bindHost));
  } catch {
    return boundAddress;
  }
}

function normalizeFamily(family: string | number): 'IPv4' | 'IPv6' | undefined {
  if (family === 'IPv4' || family === 4) return 'IPv4';
  if (family === 'IPv6' || family === 6) return 'IPv6';
  return undefined;
}

function addressPriority(address: string): number {
  const normalized = address.toLowerCase();
  if (normalized === '127.0.0.1' || normalized === '::1') return 0;
  if (normalized.startsWith('100.')) return 2;
  if (normalized.startsWith('169.254.') || normalized.startsWith('fe80:')) return 3;
  return 1;
}

function formatEntryUrl(bound: URL, host: string): string {
  const address = host.split('%', 1)[0];
  const zone = host.includes('%') ? host.slice(host.indexOf('%') + 1) : undefined;
  const formattedHost = isIP(address) === 6
    ? `[${address}${zone ? `%25${zone}` : ''}]`
    : host;
  return `${bound.protocol}//${formattedHost}${bound.port ? `:${bound.port}` : ''}`;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Keep advertised wildcard URLs aligned with the service's private-peer
 * boundary. This deliberately accepts only the ranges that Security.ts does. */
function isPermittedEntryAddress(rawAddress: string): boolean {
  const address = rawAddress.split('%', 1)[0];
  if (isIP(address) === 4) {
    const bytes = address.split('.').map(part => Number(part));
    return bytes[0] === 10
      || bytes[0] === 127
      || (bytes[0] === 169 && bytes[1] === 254)
      || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31)
      || (bytes[0] === 192 && bytes[1] === 168)
      || (bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127);
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || /^f[cd][0-9a-f]{2}:/.test(normalized)
    || /^fe[89ab][0-9a-f]:/.test(normalized);
}
