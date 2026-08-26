import type { JSONValue } from '@priest-ai/core';
import {
  AgentTool,
  requireStringInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRiskAssessment,
} from '../ToolRegistry';
import { AttachmentResource } from '../AttachmentResources';

/** Attachment-scoped, read-only inspection. The model supplies an opaque ID,
 * never a host path; the run workspace resolves that ID to the exact upload. */
export class InspectAttachmentTool implements AgentTool {
  readonly kind = 'read' as const;
  readonly definition = {
    name: 'inspect_attachment',
    description: [
      'Inspect one attachment uploaded for the current run by its attachment ID.',
      'Images become visible to the model; documents return metadata, their read-only run path, capabilities, and a small bounded preview when available.',
      'When to use: the objective or skill depends on an attached image, document, spreadsheet, audio file, or other upload.',
      'When NOT to use: arbitrary filesystem paths, bundled skill files, or information already present in the prompt.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        attachment_id: {
          type: 'string',
          description: 'Opaque ID from the current run attachment manifest, such as attachment-1.',
        },
      },
      required: ['attachment_id'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    return `inspect ${typeof input.attachment_id === 'string' ? input.attachment_id : '<missing attachment>'}`;
  }

  assessRisk(): ToolRiskAssessment {
    // The ID can resolve only inside the current run manifest. Uploading the
    // attachment is the user's explicit grant to inspect it; no host path can
    // be smuggled through this tool.
    return { escalate: false, trusted: true };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const id = requireStringInput(input, 'attachment_id', 'inspect_attachment');
    const attachment = ctx.workspace?.attachments.find(candidate => candidate.id === id);
    if (!attachment) {
      const available = ctx.workspace?.attachments.map(candidate => candidate.id).join(', ') || '(none)';
      return {
        content: `Attachment '${id}' is not available in this run. Available attachment IDs: ${available}.`,
        summary: `attachment ${id} not found`,
        isError: true,
      };
    }

    if (attachment.image) {
      return {
        content: `Attachment ${attachment.id} (${attachment.name}, ${attachment.mediaType}) is now visible as image input. Inspect the image itself before answering.`,
        images: [attachment.image],
        summary: `opened image ${attachment.name}`,
      };
    }

    const inspection = new AttachmentResource(attachment).inspect(ctx.outputLimit);
    return {
      content: inspection.content,
      summary: `inspected metadata for ${attachment.name}`,
    };
  }
}
