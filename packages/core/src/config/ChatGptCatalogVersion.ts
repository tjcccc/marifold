import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FALLBACK_VERSION = '0.154.0';
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

function versionParts(value: unknown): number[] | undefined {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) return undefined;
  return value.split('.').map(Number);
}

/** Read only protocol-version metadata; models and credentials remain API-owned. */
export async function chatGptCatalogVersion(): Promise<string> {
  const override = process.env.MARIFOLD_CHATGPT_CATALOG_CLIENT_VERSION;
  if (versionParts(override)) return override!;

  const cachePath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(cachePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return FALLBACK_VERSION;
    // Bound the read even if another process grows the cache after stat().
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size) return FALLBACK_VERSION;
    const cache: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!cache || typeof cache !== 'object' || !('client_version' in cache)) return FALLBACK_VERSION;
    const candidate = cache.client_version;
    const parts = versionParts(candidate);
    if (!parts) return FALLBACK_VERSION;
    const baseline = versionParts(FALLBACK_VERSION)!;
    for (let index = 0; index < parts.length; index++) {
      if (parts[index] > baseline[index]) return candidate as string;
      if (parts[index] < baseline[index]) return FALLBACK_VERSION;
    }
  } catch {
    // Codex is optional; missing, unreadable, or incompatible caches are harmless.
  } finally {
    await file?.close().catch(() => undefined);
  }
  return FALLBACK_VERSION;
}
