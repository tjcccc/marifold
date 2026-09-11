import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatGptCatalogVersion } from '../src/config/ChatGptCatalogVersion';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'marifold-catalog-'));
  vi.stubEnv('CODEX_HOME', directory);
  vi.stubEnv('MARIFOLD_CHATGPT_CATALOG_CLIENT_VERSION', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function cache(client_version: unknown): Promise<void> {
  await writeFile(join(directory, 'models_cache.json'), JSON.stringify({ client_version }));
}

describe('ChatGPT catalog protocol version', () => {
  it('works without a local Codex installation', async () => {
    expect(await chatGptCatalogVersion()).toBe('0.154.0');
  });
  it('adopts a newer installed Codex version', async () => {
    await cache('0.160.0');
    expect(await chatGptCatalogVersion()).toBe('0.160.0');
  });
  it('compares versions numerically and never downgrades the fallback', async () => {
    await cache('0.99.0');
    expect(await chatGptCatalogVersion()).toBe('0.154.0');
  });
  it('allows an explicit protocol override ahead of local discovery', async () => {
    await cache('0.160.0');
    vi.stubEnv('MARIFOLD_CHATGPT_CATALOG_CLIENT_VERSION', '0.155.0');
    expect(await chatGptCatalogVersion()).toBe('0.155.0');
  });
  it('ignores invalid override and cache values', async () => {
    vi.stubEnv('MARIFOLD_CHATGPT_CATALOG_CLIENT_VERSION', '0.160.0&extra=true');
    await cache('not-a-version');
    expect(await chatGptCatalogVersion()).toBe('0.154.0');
  });
  it('tolerates incomplete JSON and oversized caches', async () => {
    await writeFile(join(directory, 'models_cache.json'), '{');
    expect(await chatGptCatalogVersion()).toBe('0.154.0');
    await writeFile(join(directory, 'models_cache.json'), ' '.repeat(4 * 1024 * 1024 + 1));
    expect(await chatGptCatalogVersion()).toBe('0.154.0');
  });
});
