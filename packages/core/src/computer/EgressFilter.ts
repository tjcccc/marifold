import { BlockList, isIP } from 'node:net';
import { promises as dns } from 'node:dns';

// The agent computer's only way out. Keep this file free of other Marifold
// imports: it is copied into the computer image beside EgressProxy.

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** Names that reach the host, the container network, or a LAN without DNS. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|arpa|orb\.local)$/;

/** True for loopback, private, link-local, CGNAT, ULA, documentation, multicast
 * and reserved addresses, including IPv4 written inside IPv6. */
export function forbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) { return blocked.check(address, 'ipv4'); }
  if (family !== 6) { return true; }
  const embedded = embeddedIpv4(address);
  if (embedded) { return blocked.check(embedded, 'ipv4'); }
  return blocked.check(address, 'ipv6');
}

/** IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), and NAT64 (64:ff9b::) forms. */
function embeddedIpv4(address: string): string | undefined {
  const words = expandIpv6(address);
  if (!words) { return undefined; }
  const prefixZero = words.slice(0, 5).every(word => word === 0);
  const mapped = prefixZero && (words[5] === 0xffff || words[5] === 0);
  const nat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(word => word === 0);
  if (!mapped && !nat64) { return undefined; }
  return [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join('.');
}

function expandIpv6(address: string): number[] | undefined {
  let text = address.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1]!.split('.').map(Number);
    text = text.slice(0, -dotted[1]!.length) + `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const headWords = head ? head.split(':') : [];
  const tailWords = tail !== undefined && tail ? tail.split(':') : [];
  const fill = text.includes('::') ? 8 - headWords.length - tailWords.length : 0;
  const words = [...headWords, ...Array(fill).fill('0'), ...tailWords].map(word => parseInt(word, 16));
  return words.length === 8 && words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : undefined;
}

/** Normalize a requested host the way a client would connect to it: lowercase,
 * no brackets or trailing dot, and IPv4 in any numeric spelling as dotted quad. */
export function normalizeHost(host: string): string | undefined {
  const bare = host.trim().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!bare || bare.length > 253) { return undefined; }
  if (isIP(bare) === 6) { return bare.toLowerCase(); }
  try {
    return new URL(`http://${bare}/`).hostname.replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async host => (await dns.lookup(host, { all: true, verbatim: true })).map(entry => entry.address);

export type DestinationCheck =
  | { allowed: true; host: string; address?: string }
  | { allowed: false; reason: string };

/**
 * Decide whether the computer may reach `host`. With `resolveRequired` (direct
 * mode) the name must resolve and every address must be public; the caller then
 * connects to the returned address, never re-resolving. Without it (an upstream
 * proxy resolves) an unresolvable name passes, so the upstream's own DNS
 * remains the residual risk.
 */
export async function checkDestination(host: string, resolveRequired: boolean, lookup: Lookup = systemLookup): Promise<DestinationCheck> {
  const name = normalizeHost(host);
  if (!name) { return { allowed: false, reason: 'invalid host' }; }
  if (isIP(name)) {
    return forbiddenAddress(name) ? { allowed: false, reason: `${name} is a private or local address` } : { allowed: true, host: name, address: name };
  }
  if (!name.includes('.') || LOCAL_NAME.test(name)) { return { allowed: false, reason: `${name} is a local name` }; }
  let addresses: string[];
  try {
    addresses = await lookup(name);
  } catch {
    return resolveRequired ? { allowed: false, reason: `${name} does not resolve` } : { allowed: true, host: name };
  }
  if (addresses.length === 0) {
    return resolveRequired ? { allowed: false, reason: `${name} does not resolve` } : { allowed: true, host: name };
  }
  const local = addresses.find(forbiddenAddress);
  if (local) { return { allowed: false, reason: `${name} resolves to the private address ${local}` }; }
  const preferred = addresses.find(address => isIP(address) === 4) ?? addresses[0]!;
  return { allowed: true, host: name, address: preferred };
}
