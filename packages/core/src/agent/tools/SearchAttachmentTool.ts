import type { JSONValue } from '@priest-ai/core';
import {
  AttachmentResource,
  DEFAULT_ATTACHMENT_SEARCH_RESULTS,
  formatAttachmentSearch,
  MAX_ATTACHMENT_SEARCH_RESULTS,
} from '../AttachmentResources';
import {
  AgentTool,
  requireStringInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRiskAssessment,
} from '../ToolRegistry';

export class SearchAttachmentTool implements AgentTool {
  readonly kind = 'read' as const;
  readonly definition = {
    name: 'search_attachment',
    description: [
      'Search the derived readable view of one uploaded attachment and return bounded line matches.',
      'When to use: locate a heading, identifier, name, table label, or passage without loading the complete document into model context.',
      'When NOT to use: transform a file, search an arbitrary filesystem path, or repeatedly enumerate an entire document. Use a local format-specific tool for complete-file processing.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string', description: 'Opaque attachment ID from the current run manifest.' },
        query: { type: 'string', description: 'Case-insensitive literal text to find.' },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_ATTACHMENT_SEARCH_RESULTS,
          description: `Maximum matches to return. Defaults to ${DEFAULT_ATTACHMENT_SEARCH_RESULTS}.`,
        },
      },
      required: ['attachment_id', 'query'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    const id = typeof input.attachment_id === 'string' ? input.attachment_id : '<missing attachment>';
    const query = typeof input.query === 'string' ? input.query : '<missing query>';
    return `search ${id} for ${JSON.stringify(query)}`;
  }

  assessRisk(): ToolRiskAssessment {
    return { escalate: false, trusted: true };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const id = requireStringInput(input, 'attachment_id', 'search_attachment');
    const query = requireStringInput(input, 'query', 'search_attachment');
    const attachment = ctx.workspace?.attachments.find(candidate => candidate.id === id);
    if (!attachment) {
      const available = ctx.workspace?.attachments.map(candidate => candidate.id).join(', ') || '(none)';
      return {
        content: `Attachment '${id}' is not available in this run. Available attachment IDs: ${available}.`,
        summary: `attachment ${id} not found`,
        isError: true,
      };
    }
    const maxResults = integerInput(input.max_results, DEFAULT_ATTACHMENT_SEARCH_RESULTS);
    if (maxResults < 1 || maxResults > MAX_ATTACHMENT_SEARCH_RESULTS) {
      return {
        content: `search_attachment requires max_results between 1 and ${MAX_ATTACHMENT_SEARCH_RESULTS}.`,
        summary: `invalid search limit for ${attachment.name}`,
        isError: true,
      };
    }
    const result = new AttachmentResource(attachment).search(query, maxResults);
    if (!result) {
      return {
        content: `No built-in searchable view is available for ${attachment.name}. Use a format-specific local tool against ${attachment.path ?? 'its staged run path'}.`,
        summary: `no searchable view for ${attachment.name}`,
        isError: true,
      };
    }
    return {
      content: formatAttachmentSearch(result, query),
      summary: `found ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} in ${attachment.name}`,
    };
  }
}

function integerInput(value: JSONValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}
