import { SearchBackend, SearchResultItem } from './SearchBackend';
import { proxyDispatcher } from '../util/proxy';

const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';
const DEFAULT_MAX_RESULTS = 5;

export interface FirecrawlBackendOptions {
  /** API key (BYOK). When absent, falls back to the env var named by
   * `apiKeyEnv`, then to keyless requests (rate-limited by Firecrawl). */
  apiKey?: string;
  apiKeyEnv?: string;
  /** Scrape each result into LLM-ready markdown. Firecrawl charges more for
   * this; off by default. */
  scrape?: boolean;
  /** HTTP proxy, e.g. "http://127.0.0.1:7890". Falls back to
   * HTTPS_PROXY/https_proxy. Applied best-effort via undici when available. */
  proxy?: string;
  maxResults?: number;
}

interface FirecrawlResult {
  url?: string;
  title?: string;
  description?: string;
  markdown?: string;
}

/**
 * Firecrawl search backend (https://firecrawl.dev). Searches the web and, when
 * `scrape` is set, returns each result as clean LLM-ready markdown. Works
 * keyless with provider rate limits; a key (BYOK) lifts them.
 */
export class FirecrawlBackend implements SearchBackend {
  private readonly apiKey: string | undefined;
  private readonly scrape: boolean;
  private readonly proxy: string | undefined;
  private readonly maxResults: number;

  constructor(options: FirecrawlBackendOptions = {}) {
    this.apiKey = options.apiKey
      ?? (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined);
    this.scrape = options.scrape ?? false;
    this.proxy = options.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
    this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  }

  async search(query: string, maxResults = this.maxResults): Promise<SearchResultItem[]> {
    const limit = Math.max(1, maxResults);
    const body: Record<string, unknown> = {
      query,
      limit,
      sources: ['web'],
      ...(this.scrape ? { scrapeOptions: { formats: ['markdown'] } } : {}),
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const init: Record<string, unknown> = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
    const dispatcher = proxyDispatcher(this.proxy);
    if (dispatcher) init.dispatcher = dispatcher;

    const response = await fetch(FIRECRAWL_SEARCH_URL, init as RequestInit);
    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`Firecrawl search failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    const payload = await response.json() as { data?: FirecrawlResult[] | { web?: FirecrawlResult[] } };
    return extractResults(payload.data)
      .slice(0, limit)
      .map(result => ({
        title: (result.title ?? '').trim(),
        url: result.url ?? '',
        // In scrape mode the markdown body is the LLM-ready value-add; fall back
        // to the description snippet otherwise.
        snippet: ((this.scrape ? result.markdown : undefined) ?? result.description ?? '').trim(),
      }));
  }
}

/** Firecrawl v2 groups results under `data.web`; v1 returned a flat `data[]`.
 * Accept either so the backend survives an API version bump. */
function extractResults(data: FirecrawlResult[] | { web?: FirecrawlResult[] } | undefined): FirecrawlResult[] {
  if (Array.isArray(data)) return data;
  return data?.web ?? [];
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}

