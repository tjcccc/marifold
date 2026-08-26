import * as fs from 'fs';
import * as path from 'path';
import type { StagedRunAttachment } from './RunWorkspace';

export const ATTACHMENT_PREVIEW_CHARS = 8_000;
export const DEFAULT_ATTACHMENT_READ_CHARS = 8_000;
export const MAX_ATTACHMENT_READ_CHARS = 20_000;
export const DEFAULT_ATTACHMENT_SEARCH_RESULTS = 8;
export const MAX_ATTACHMENT_SEARCH_RESULTS = 20;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini',
  '.csv', '.tsv', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.sh', '.zsh', '.bash', '.fish', '.sql', '.log', '.diff', '.patch',
]);

const FORMAT_LABELS = new Map<string, string>([
  ['.xlsx', 'Excel workbook'],
  ['.xlsm', 'macro-enabled Excel workbook'],
  ['.xls', 'legacy Excel workbook'],
  ['.docx', 'Word document'],
  ['.doc', 'legacy Word document'],
  ['.odt', 'OpenDocument text'],
  ['.pptx', 'PowerPoint presentation'],
  ['.ppt', 'legacy PowerPoint presentation'],
  ['.odp', 'OpenDocument presentation'],
  ['.pdf', 'PDF document'],
  ['.epub', 'EPUB ebook'],
  ['.mobi', 'Mobipocket ebook'],
  ['.azw', 'Kindle ebook'],
  ['.azw3', 'Kindle ebook'],
  ['.zip', 'ZIP archive'],
  ['.tar', 'TAR archive'],
  ['.gz', 'gzip archive'],
  ['.7z', '7-Zip archive'],
]);

export interface AttachmentInspection {
  content: string;
  hasReadableText: boolean;
}

export interface AttachmentReadResult {
  content: string;
  start: number;
  end: number;
  total: number;
  unit: 'characters';
}

export interface AttachmentSearchMatch {
  line: number;
  text: string;
}

export interface AttachmentSearchResult {
  matches: AttachmentSearchMatch[];
  truncated: boolean;
}

/**
 * Format-neutral attachment facade. Original files remain authoritative and
 * local; model-visible content is always a bounded derived view.
 */
export class AttachmentResource {
  constructor(readonly attachment: StagedRunAttachment) {}

  inspect(maxPreviewChars = ATTACHMENT_PREVIEW_CHARS): AttachmentInspection {
    const source = this.readableText();
    const pathLine = this.attachment.path
      ? `Read-only run path: ${this.attachment.path}`
      : 'Read-only run path: unavailable';
    const header = [
      `Attachment: ${this.attachment.name}`,
      `Format: ${formatLabel(this.attachment)}`,
      `Media type: ${this.attachment.mediaType}`,
      `Size: ${formatBytes(this.attachment.size)}`,
      pathLine,
    ];

    if (source === undefined) {
      return {
        hasReadableText: false,
        content: [
          ...header,
          'Readable view: unavailable for this format.',
          'For a complete-file task, use a format-specific local tool against the read-only run path and write deliverables to $MARIFOLD_OUTPUT_DIR.',
        ].join('\n'),
      };
    }

    const previewLimit = Math.max(1, Math.min(maxPreviewChars, ATTACHMENT_PREVIEW_CHARS));
    const preview = source.slice(0, previewLimit);
    const remainder = source.length - preview.length;
    return {
      hasReadableText: true,
      content: [
        ...header,
        `Readable view: ${source.length.toLocaleString('en-US')} characters.`,
        'Use read_attachment for bounded ranges and search_attachment to find relevant passages.',
        'For joins, conversions, edits, or other complete-file operations, process the read-only path locally instead of reading the whole document into model context.',
        '',
        'Preview:',
        preview || '(empty)',
        ...(remainder > 0 ? [`[preview bounded — ${remainder.toLocaleString('en-US')} characters not shown]`] : []),
      ].join('\n'),
    };
  }

  read(start: number, maxChars: number): AttachmentReadResult | undefined {
    const source = this.readableText();
    if (source === undefined) return undefined;
    const safeStart = Math.min(Math.max(0, start), source.length);
    const safeLimit = Math.max(1, Math.min(maxChars, MAX_ATTACHMENT_READ_CHARS));
    const content = source.slice(safeStart, safeStart + safeLimit);
    return {
      content,
      start: safeStart,
      end: safeStart + content.length,
      total: source.length,
      unit: 'characters',
    };
  }

  search(query: string, maxResults: number): AttachmentSearchResult | undefined {
    const source = this.readableText();
    if (source === undefined) return undefined;
    const needle = query.toLocaleLowerCase();
    const limit = Math.max(1, Math.min(maxResults, MAX_ATTACHMENT_SEARCH_RESULTS));
    const matches: AttachmentSearchMatch[] = [];
    let totalMatches = 0;
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (!line.toLocaleLowerCase().includes(needle)) continue;
      totalMatches += 1;
      if (matches.length < limit) {
        matches.push({ line: index + 1, text: line.slice(0, 1_000) });
      }
    }
    return { matches, truncated: totalMatches > matches.length };
  }

  private readableText(): string | undefined {
    if (this.attachment.inspectionText !== undefined) return this.attachment.inspectionText;
    if (!this.attachment.path || !isTextAttachment(this.attachment)) return undefined;
    try {
      return fs.readFileSync(this.attachment.path, 'utf8');
    } catch {
      return undefined;
    }
  }
}

export function isTextAttachment(attachment: Pick<StagedRunAttachment, 'name' | 'mediaType'>): boolean {
  return attachment.mediaType.startsWith('text/')
    || TEXT_EXTENSIONS.has(path.extname(attachment.name).toLowerCase());
}

export function formatAttachmentSearch(result: AttachmentSearchResult, query: string): string {
  if (result.matches.length === 0) return `No matches for ${JSON.stringify(query)}.`;
  return [
    ...result.matches.map(match => `Line ${match.line}: ${match.text}`),
    ...(result.truncated ? ['[additional matches omitted; narrow the query to inspect them]'] : []),
  ].join('\n');
}

function formatLabel(attachment: StagedRunAttachment): string {
  if (attachment.image) return 'image';
  const extension = path.extname(attachment.name).toLowerCase();
  return FORMAT_LABELS.get(extension) ?? (isTextAttachment(attachment) ? 'text document' : 'binary file');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
