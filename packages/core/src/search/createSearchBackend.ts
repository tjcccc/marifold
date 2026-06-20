import { MarifoldWebSearchConfig } from '../config/ConfigSchema';
import { DuckDuckGoBackend } from './DuckDuckGoBackend';
import { FirecrawlBackend } from './FirecrawlBackend';
import { SearchBackend } from './SearchBackend';

/**
 * Select the active web-search backend from the resolved [web_search] config.
 *
 * Priority is a config-time selection of ONE backend (not a runtime retry
 * cascade):
 *   - `firecrawl` → FirecrawlBackend (BYOK; AI-ready scraped results)
 *   - else        → DuckDuckGoBackend (keyless best-effort floor)
 *
 * Future tier-1 "native" model search (provider server-side web_search) resolves
 * in priest, not here — marifold would simply skip registering its own
 * web_search tool for such a profile. See docs/roadmap.
 */
export function createSearchBackend(config: MarifoldWebSearchConfig): SearchBackend {
  if (config.provider === 'firecrawl') {
    return new FirecrawlBackend({
      apiKey: config.apiKey,
      apiKeyEnv: config.apiKeyEnv,
      scrape: config.scrape,
      proxy: config.proxy,
      maxResults: config.maxResults,
    });
  }
  return new DuckDuckGoBackend({ proxy: config.proxy });
}
