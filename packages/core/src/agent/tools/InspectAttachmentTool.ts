import * as fs from 'fs';
import * as path from 'path';
import type { JSONValue } from '@priest-ai/core';
import {
  AgentTool,
  capToolOutput,
  requireStringInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRiskAssessment,
} from '../ToolRegistry';
import { formatBytes } from './ReadFileTool';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini',
  '.csv', '.tsv', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.sh', '.zsh', '.bash', '.fish', '.sql', '.log', '.diff', '.patch',
]);

/** Attachment-scoped, read-only inspection. The model supplies an opaque ID,
 * never a host path; the run workspace resolves that ID to the exact upload. */
export class InspectAttachmentTool implements AgentTool {
  readonly kind = 'read' as const;
  readonly definition = {
    name: 'inspect_attachment',
    description: [
      'Inspect one attachment uploaded for the current run by its attachment ID.',
      'Images become visible to the model; text and pre-extracted documents return bounded readable text; other binaries return safe metadata and their read-only run path.',
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

    const text = attachment.inspectionText ?? readTextAttachment(attachment.path, attachment.name, attachment.mediaType);
    if (text !== undefined) {
      return {
        content: capToolOutput(text, ctx.outputLimit),
        summary: `inspected ${attachment.name}`,
      };
    }

    const location = attachment.path ? `\nRead-only run path: ${attachment.path}` : '';
    return {
      content: [
        `Attachment: ${attachment.name}`,
        `Media type: ${attachment.mediaType}`,
        `Size: ${formatBytes(attachment.size)}`,
        location,
        'No built-in readable preview is available for this format. Use a format-specific local tool against the run path if the task requires deeper inspection.',
      ].filter(Boolean).join('\n'),
      summary: `inspected metadata for ${attachment.name}`,
    };
  }
}

function readTextAttachment(filePath: string | undefined, name: string, mediaType: string): string | undefined {
  if (!filePath || (!mediaType.startsWith('text/') && !TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()))) {
    return undefined;
  }
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return `Could not read ${name}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
