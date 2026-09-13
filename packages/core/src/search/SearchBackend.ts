export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Pluggable web search backend. Built-in direct search is the experimental
 * no-API-key default. Keep callers independent of engine-specific retrieval.
 */
export interface SearchBackend {
  search(query: string, maxResults?: number, signal?: AbortSignal): Promise<SearchResultItem[]>;
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
    + 'If needed, read a promising source or refine the query within the tool budget. '
    + 'If the results are insufficient or irrelevant, say what could not be confirmed.\n\n'
    + searchResults
  );
}
