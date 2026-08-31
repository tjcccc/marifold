import { MarifoldWebSearchConfig } from '../config/ConfigSchema';
import { DuckDuckGoBackend } from './DuckDuckGoBackend';
import { FirecrawlBackend } from './FirecrawlBackend';
import { OllamaSearchBackend } from './OllamaSearchBackend';
import { SearchBackend } from './SearchBackend';

/**
 * Select the active web-search backend from the resolved [web_search] config.
 *
 * Priority is a config-time selection of ONE backend (not a runtime retry
 * cascade):
 *   - `firecrawl` → FirecrawlBackend (BYOK; AI-ready scraped results)
 *   - `ollama`    → OllamaSearchBackend (BYOK; Ollama Cloud search)
 *   - else        → DuckDuckGoBackend (keyless best-effort floor)
 *
 * Provider-hosted model search resolves separately through the provider/model
 * capability matrix; Marifold skips registering this caller-executed tool
 * while that native path is active.
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
  if (config.provider === 'ollama') {
    return new OllamaSearchBackend({
      apiKey: config.apiKey,
      apiKeyEnv: config.apiKeyEnv,
      proxy: config.proxy,
      maxResults: config.maxResults,
    });
  }
  return new DuckDuckGoBackend({ proxy: config.proxy });
}
