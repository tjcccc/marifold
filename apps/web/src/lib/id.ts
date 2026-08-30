/** Generate a UUID for browser-owned, non-secret identifiers. Plain HTTP LAN
 * origins may not expose randomUUID(), so retain a Web Crypto and legacy
 * fallback instead of making session creation depend on a secure context. */
export function createClientId(): string {
  const cryptoApi = globalThis.crypto;
  try {
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  } catch {
    // Continue when the browser exposes randomUUID but rejects this origin.
  }

  const bytes = new Uint8Array(16);
  try {
    if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
    else fillPseudoRandom(bytes);
  } catch {
    fillPseudoRandom(bytes);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fillPseudoRandom(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
}
