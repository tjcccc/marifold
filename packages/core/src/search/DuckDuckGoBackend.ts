import { SafeSearchType, search as ddgSearch } from 'duck-duck-scrape';
import { SearchBackend, SearchResultItem } from './SearchBackend';

const CJK_RE = /[㐀-鿿]/;
const DEFAULT_MAX_RESULTS = 5;

export interface DuckDuckGoBackendOptions {
  /** HTTP proxy, e.g. "http://127.0.0.1:7890". Falls back to
   * HTTPS_PROXY/https_proxy environment variables. */
  proxy?: string;
}

/**
 * DuckDuckGo backend via the duck-duck-scrape package (no API key). Region
 * follows priests' convention: cn-zh for CJK queries, us-en otherwise.
 * Scraping can break when DuckDuckGo changes markup or flags a network —
 * errors surface as thrown exceptions for the caller to report.
 */
export class DuckDuckGoBackend implements SearchBackend {
  private readonly proxy: string | undefined;

  constructor(options: DuckDuckGoBackendOptions = {}) {
    this.proxy = options.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
  }

  async search(query: string, maxResults = DEFAULT_MAX_RESULTS): Promise<SearchResultItem[]> {
    const region = CJK_RE.test(query) ? 'cn-zh' : 'us-en';
    const response = await ddgSearch(query, {
      safeSearch: SafeSearchType.MODERATE,
      region,
    }, this.proxy ? { proxy: this.proxy } : undefined);
    return (response.results ?? [])
      .slice(0, Math.max(1, maxResults))
      .map(result => ({
        title: stripHtml(result.title ?? ''),
        url: result.url ?? '',
        snippet: stripHtml(result.description ?? ''),
      }));
  }
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim();
}
