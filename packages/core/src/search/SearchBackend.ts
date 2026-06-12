export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Pluggable web search backend. DuckDuckGo scraping is the no-API-key
 * default, but it is brittle by nature — keep this interface narrow so
 * Brave/SearXNG/other backends can replace it without touching callers.
 */
export interface SearchBackend {
  search(query: string, maxResults?: number): Promise<SearchResultItem[]>;
}

/** Format results as the numbered text block priests injects (search.py). */
export function formatSearchResults(query: string, results: SearchResultItem[]): string {
  if (results.length === 0) {
    return `Web search for '${query}' returned no results.`;
  }
  const lines = [`## Web search results for: ${query}\n`];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. **${result.title}**\n   ${result.url}\n   ${result.snippet}\n`);
  });
  return lines.join('\n');
}

/** Wrap raw search results with turn-local instructions for the model. */
export function formatSearchContext(searchResults: string): string {
  return (
    '## Web search results\n\n'
    + "Use the following web search results to answer the user's current question. "
    + 'Do not request another web search for this turn. '
    + 'If the results are insufficient or irrelevant, say what could not be confirmed.\n\n'
    + searchResults
  );
}
