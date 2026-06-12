import { JSONValue } from '@priest-ai/core';
import { formatSearchResults, SearchBackend } from '../../search/SearchBackend';
import { AgentTool, capToolOutput, requireStringInput, ToolExecutionContext, ToolExecutionResult } from '../ToolRegistry';

export class WebSearchTool implements AgentTool {
  readonly kind = 'network' as const;
  readonly definition = {
    name: 'web_search',
    description: 'Search the web and return titles, URLs, and snippets for the top results. Use for current events or facts you do not know.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  };

  constructor(
    private readonly backend: SearchBackend,
    private readonly maxResults = 5,
  ) {}

  summarizeCall(input: Record<string, JSONValue>): string {
    return `search the web for "${typeof input.query === 'string' ? input.query : '<missing query>'}"`;
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = requireStringInput(input, 'query', 'web_search');
    let results;
    try {
      results = await this.backend.search(query, this.maxResults);
    } catch (error) {
      return {
        content: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
        summary: `web search for "${query}" failed`,
        isError: true,
      };
    }
    return {
      content: capToolOutput(formatSearchResults(query, results), ctx.outputLimit),
      summary: `found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}"`,
    };
  }
}
