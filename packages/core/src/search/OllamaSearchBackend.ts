import { proxyDispatcher } from '../util/proxy';
import { SearchBackend, SearchResultItem } from './SearchBackend';

const OLLAMA_WEB_SEARCH_URL = 'https://ollama.com/api/web_search';
const DEFAULT_API_KEY_ENV = 'OLLAMA_API_KEY';
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;

export interface OllamaSearchBackendOptions {
  /** Ollama Cloud API key. When absent, reads `apiKeyEnv` or OLLAMA_API_KEY. */
  apiKey?: string;
  apiKeyEnv?: string;
  /** HTTP proxy, e.g. "http://127.0.0.1:7890". Falls back to the standard
   * HTTPS proxy environment variables. */
  proxy?: string;
  maxResults?: number;
}

interface OllamaWebSearchResult {
  title?: string;
  url?: string;
  content?: string;
}

/** Caller-executed Ollama Cloud search. This is deliberately a Marifold
 * fallback backend rather than a local-model capability: queries leave the
 * machine for ollama.com and require an account API key. */
export class OllamaSearchBackend implements SearchBackend {
  private readonly apiKey: string | undefined;
  private readonly apiKeyEnv: string;
  private readonly proxy: string | undefined;
  private readonly maxResults: number;

  constructor(options: OllamaSearchBackendOptions = {}) {
    this.apiKeyEnv = options.apiKeyEnv || DEFAULT_API_KEY_ENV;
    this.apiKey = options.apiKey ?? process.env[this.apiKeyEnv];
    this.proxy = options.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
    this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  }

  async search(query: string, maxResults = this.maxResults): Promise<SearchResultItem[]> {
    if (!this.apiKey) {
      throw new Error(`Ollama web search requires an API key in ${this.apiKeyEnv} or web_search.api_key.`);
    }
    const limit = Math.min(MAX_RESULTS, Math.max(1, maxResults));
    const init: Record<string, unknown> = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, max_results: limit }),
    };
    const dispatcher = proxyDispatcher(this.proxy);
    if (dispatcher) {
      init.dispatcher = dispatcher;
    }

    const response = await fetch(OLLAMA_WEB_SEARCH_URL, init as RequestInit);
    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`Ollama web search failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    const payload = await response.json() as { results?: OllamaWebSearchResult[] };
    return (payload.results ?? [])
      .slice(0, limit)
      .map(result => ({
        title: (result.title ?? '').trim(),
        url: result.url ?? '',
        snippet: (result.content ?? '').trim(),
      }));
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}
