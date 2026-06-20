import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigLoader,
  ConfigManager,
  createSearchBackend,
  DuckDuckGoBackend,
  FirecrawlBackend,
  resolveWebSearchConfig,
} from '../src';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-search-'));
  tempDirs.push(dir);
  return dir;
}

/** Minimal valid config; `extra` appends another TOML section. */
function writeConfig(dir: string, extra = ''): string {
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, `
[default]
provider = "ollama"
model = "gemma4:e4b"
profile = "default"

[models]
options = ["ollama/gemma4:e4b"]

[memory]
size_limit = 1000
context_limit = 120

[paths]
profiles_dir = "${dir}/profiles"
sessions_db = "${dir}/sessions.db"
tasks_dir = "${dir}/tasks"

[providers.ollama]
type = "ollama"
base_url = "http://localhost:11434"
${extra}`);
  return configPath;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('web_search config', () => {
  it('parses provider, api_key_env, and scrape from [web_search]', () => {
    const configPath = writeConfig(tempDir(), `
[web_search]
enabled = true
max_results = 8
provider = "firecrawl"
api_key_env = "FIRECRAWL_API_KEY"
scrape = true
`);
    const loaded = new ConfigLoader().load({ configPath });
    expect(loaded.config.webSearch).toMatchObject({
      enabled: true,
      maxResults: 8,
      provider: 'firecrawl',
      apiKeyEnv: 'FIRECRAWL_API_KEY',
      scrape: true,
    });
  });

  it('defaults provider to duckduckgo when [web_search] omits it', () => {
    const configPath = writeConfig(tempDir(), `
[web_search]
enabled = true
`);
    const loaded = new ConfigLoader().load({ configPath });
    expect(loaded.config.webSearch?.provider).toBe('duckduckgo');
  });

  it('rejects an unknown provider', () => {
    const configPath = writeConfig(tempDir(), `
[web_search]
provider = "bing"
`);
    expect(() => new ConfigLoader().load({ configPath })).toThrow(/duckduckgo.*firecrawl/);
  });

  it('round-trips updateWebSearch through ConfigManager', () => {
    const configPath = writeConfig(tempDir());
    const loaded = new ConfigLoader().load({ configPath });
    new ConfigManager(loaded).updateWebSearch({
      provider: 'firecrawl',
      enabled: true,
      apiKeyEnv: 'FIRECRAWL_API_KEY',
      scrape: true,
    });
    const reloaded = new ConfigLoader().load({ configPath });
    expect(reloaded.config.webSearch).toMatchObject({
      provider: 'firecrawl',
      enabled: true,
      apiKeyEnv: 'FIRECRAWL_API_KEY',
      scrape: true,
    });
  });
});

describe('createSearchBackend', () => {
  it('selects Firecrawl when provider is firecrawl, else DuckDuckGo', () => {
    expect(createSearchBackend(resolveWebSearchConfig({ provider: 'firecrawl' }))).toBeInstanceOf(FirecrawlBackend);
    expect(createSearchBackend(resolveWebSearchConfig({ provider: 'duckduckgo' }))).toBeInstanceOf(DuckDuckGoBackend);
    expect(createSearchBackend(resolveWebSearchConfig(undefined))).toBeInstanceOf(DuckDuckGoBackend);
  });
});

describe('FirecrawlBackend', () => {
  function stubFetch(body: unknown, status = 200): { calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }));
    return { calls };
  }

  it('posts to the search endpoint with the Bearer key and maps results', async () => {
    const { calls } = stubFetch({ data: { web: [{ title: 'Ink', url: 'https://ink.dev', description: 'TUI lib' }] } });
    const results = await new FirecrawlBackend({ apiKey: 'fc-key' }).search('ink react', 3);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.firecrawl.dev/v2/search');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer fc-key');
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toMatchObject({ query: 'ink react', limit: 3, sources: ['web'] });
    expect(sent.scrapeOptions).toBeUndefined();
    expect(results).toEqual([{ title: 'Ink', url: 'https://ink.dev', snippet: 'TUI lib' }]);
  });

  it('omits the auth header when keyless and requests markdown when scraping', async () => {
    const { calls } = stubFetch({ data: { web: [{ title: 'T', url: 'u', description: 'd', markdown: '# md' }] } });
    const results = await new FirecrawlBackend({ scrape: true }).search('q');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(calls[0].init.body as string).scrapeOptions).toEqual({ formats: ['markdown'] });
    // In scrape mode the markdown body becomes the snippet.
    expect(results[0].snippet).toBe('# md');
  });

  it('throws on a non-2xx response', async () => {
    stubFetch({ error: 'nope' }, 402);
    await expect(new FirecrawlBackend({ apiKey: 'k' }).search('q')).rejects.toThrow(/Firecrawl search failed: HTTP 402/);
  });
});
