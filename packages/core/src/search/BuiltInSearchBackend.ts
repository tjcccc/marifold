import type { SearchBackend, SearchResultItem } from './SearchBackend';
import { normalizeSearchResults, parseBraveHtml, parseDuckDuckGoHtml } from './BuiltInSearchParser';
import { proxyDispatcher } from '../util/proxy';

const MAX_BYTES = 1_000_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 32;

/** Experimental, local extraction of public engine responses. No search API account. */
export class BuiltInSearchBackend implements SearchBackend {
  private readonly cache = new Map<string, { expires: number; results: SearchResultItem[] }>();
  private readonly dispatcher: ReturnType<typeof proxyDispatcher>;

  constructor(options: { proxy?: string } = {}) {
    this.dispatcher = proxyDispatcher(options.proxy);
  }

  async search(query: string, maxResults = 5, signal?: AbortSignal): Promise<SearchResultItem[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || normalizedQuery.length > 2048) throw new Error('Search query must contain 1–2048 characters.');
    if (!Number.isFinite(maxResults) || maxResults < 1) throw new Error('Search result limit must be positive.');
    const limit = Math.min(10, Math.floor(maxResults));
    signal?.throwIfAborted();
    const key = JSON.stringify([normalizedQuery, limit]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.results.map(item => ({ ...item }));
    this.cache.delete(key);
    const ddg = new URL('https://html.duckduckgo.com/html/');
    ddg.searchParams.set('q', normalizedQuery);
    ddg.searchParams.set('kl', /[㐀-鿿]/.test(normalizedQuery) ? 'cn-zh' : 'us-en');
    const brave = new URL('https://search.brave.com/search');
    brave.searchParams.set('q', normalizedQuery);
    brave.searchParams.set('source', 'web');
    const engines = [
      { name: 'DuckDuckGo HTML', url: ddg, parse: parseDuckDuckGoHtml },
      { name: 'Brave HTML', url: brave, parse: parseBraveHtml },
    ];
    const errors: string[] = [];
    for (const engine of engines) {
      try {
        const timeout = AbortSignal.timeout(5000);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const init: RequestInit & { dispatcher?: ReturnType<typeof proxyDispatcher> } = {
          signal: requestSignal,
          redirect: 'error',
          headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html', 'accept-language': 'en' },
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        };
        const response = await fetch(engine.url, init);
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const raw = engine.parse(await readBounded(response));
        const results = normalizeSearchResults(raw, limit);
        if (raw.length && !results.length) throw new Error('Search response contained no usable links.');
        // A valid empty response is authoritative for this attempt. Broadening
        // it on another engine can turn exact no-match queries into unrelated hits.
        if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expires: Date.now() + CACHE_TTL_MS, results });
        return results.map(item => ({ ...item }));
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${engine.name}: ${error instanceof Error ? error.message : 'request failed'}`);
      }
    }
    if (errors.length) throw new Error(`Built-in search unavailable (${errors.join('; ')}). Try again later or select another fallback provider.`);
    return [];
  }
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new Error('Search response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Search response exceeds 1 MB.');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
