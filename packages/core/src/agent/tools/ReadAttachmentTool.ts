import type { JSONValue } from '@priest-ai/core';
import {
  AttachmentResource,
  DEFAULT_ATTACHMENT_READ_CHARS,
  MAX_ATTACHMENT_READ_CHARS,
} from '../AttachmentResources';
import {
  AgentTool,
  requireStringInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRiskAssessment,
} from '../ToolRegistry';

export class ReadAttachmentTool implements AgentTool {
  readonly kind = 'read' as const;
  readonly definition = {
    name: 'read_attachment',
    description: [
      'Read one bounded range from the derived readable view of an uploaded attachment.',
      'When to use: inspect a relevant section after inspect_attachment identified the document structure or search_attachment found a location.',
      'When NOT to use: load an entire large document, transform a complete file, or access an arbitrary filesystem path. Complete-file operations should use local tools against the read-only run path.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string', description: 'Opaque attachment ID from the current run manifest.' },
        start: { type: 'integer', minimum: 0, description: 'Zero-based character offset in the readable view. Defaults to 0.' },
        max_chars: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_ATTACHMENT_READ_CHARS,
          description: `Maximum characters to return. Defaults to ${DEFAULT_ATTACHMENT_READ_CHARS}.`,
        },
      },
      required: ['attachment_id'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    const id = typeof input.attachment_id === 'string' ? input.attachment_id : '<missing attachment>';
    const start = integerInput(input.start, 0);
    return `read ${id} from character ${start}`;
  }

  assessRisk(): ToolRiskAssessment {
    return { escalate: false, trusted: true };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const id = requireStringInput(input, 'attachment_id', 'read_attachment');
    const attachment = ctx.workspace?.attachments.find(candidate => candidate.id === id);
    if (!attachment) return missingAttachment(id, ctx);
    const start = integerInput(input.start, 0);
    const maxChars = integerInput(input.max_chars, DEFAULT_ATTACHMENT_READ_CHARS);
    if (start < 0 || maxChars < 1 || maxChars > MAX_ATTACHMENT_READ_CHARS) {
      return {
        content: `read_attachment requires start >= 0 and max_chars between 1 and ${MAX_ATTACHMENT_READ_CHARS}.`,
        summary: `invalid read range for ${attachment.name}`,
        isError: true,
      };
    }
    const result = new AttachmentResource(attachment).read(start, maxChars);
    if (!result) {
      return {
        content: `No built-in readable view is available for ${attachment.name}. Use a format-specific local tool against ${attachment.path ?? 'its staged run path'}.`,
        summary: `no readable view for ${attachment.name}`,
        isError: true,
      };
    }
    return {
      content: [
        `Attachment: ${attachment.name}`,
        `Characters ${result.start}-${result.end} of ${result.total}`,
        '',
        result.content || '(empty range)',
        ...(result.end < result.total ? [`[more available; continue with start=${result.end}]`] : []),
      ].join('\n'),
      summary: `read characters ${result.start}-${result.end} from ${attachment.name}`,
    };
  }
}

function integerInput(value: JSONValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function missingAttachment(id: string, ctx: ToolExecutionContext): ToolExecutionResult {
  const available = ctx.workspace?.attachments.map(candidate => candidate.id).join(', ') || '(none)';
  return {
    content: `Attachment '${id}' is not available in this run. Available attachment IDs: ${available}.`,
    summary: `attachment ${id} not found`,
    isError: true,
  };
}
