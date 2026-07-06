/**
 * Attachment classification and prompt inlining. The rules are pure functions
 * over (name, mime type, size) so they unit-test without DOM File objects;
 * `prepareFiles` is the thin browser shim that reads the actual bytes.
 */

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 256 * 1024;

/** Image types core forwards to the model natively. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Extensions treated as inline-able text when the browser reports no useful
 * MIME type (it often doesn't for code files). */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'csv', 'tsv',
  'xml', 'html', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'zsh', 'bash', 'fish',
  'sql', 'log', 'env.example', 'gitignore', 'diff', 'patch',
]);

export type AttachmentClass =
  | { kind: 'image' }
  | { kind: 'text' }
  | { kind: 'rejected'; reason: string };

export function classifyFile(name: string, mediaType: string, size: number): AttachmentClass {
  if (IMAGE_MEDIA_TYPES.has(mediaType)) return { kind: 'image' };
  if (mediaType.startsWith('image/')) {
    return { kind: 'rejected', reason: `${name}: unsupported image type (${mediaType}); use PNG, JPEG, WebP, or GIF.` };
  }
  const isText = mediaType.startsWith('text/') || TEXT_EXTENSIONS.has(extension(name));
  if (isText) {
    if (size > MAX_TEXT_FILE_BYTES) {
      return { kind: 'rejected', reason: `${name}: text files up to ${MAX_TEXT_FILE_BYTES / 1024} KB can be inlined.` };
    }
    return { kind: 'text' };
  }
  return { kind: 'rejected', reason: `${name}: only images and text files can be attached.` };
}

export type PreparedAttachment =
  | { kind: 'image'; name: string; size: number; data: string; mediaType: string }
  | { kind: 'text'; name: string; size: number; content: string };

/** Enforce the per-message caps over already-accepted attachments. Returns the
 * reason the next file must be refused, or undefined when it fits. */
export function capViolation(existing: PreparedAttachment[], nextSize: number, nextKind: 'image' | 'text'): string | undefined {
  if (nextKind === 'image' && existing.filter(a => a.kind === 'image').length >= MAX_IMAGES_PER_MESSAGE) {
    return `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`;
  }
  const total = existing.reduce((sum, item) => sum + item.size, 0) + nextSize;
  if (total > MAX_TOTAL_BYTES) {
    return `Attachments are limited to ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB per message.`;
  }
  return undefined;
}

/** Append text attachments to the prompt as fenced blocks headed by the
 * filename. Fences stretch past any backtick run inside the content. */
export function inlineTextAttachments(prompt: string, files: Array<{ name: string; content: string }>): string {
  if (files.length === 0) return prompt;
  const blocks = files.map(file => {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(file.content) + 1));
    return `Attached file: ${file.name}\n${fence}\n${file.content}\n${fence}`;
  });
  return [prompt, ...blocks].join('\n\n');
}

export interface PrepareResult {
  accepted: PreparedAttachment[];
  rejected: string[];
}

/** Browser shim: classify, enforce caps, and read bytes (base64 for images,
 * text for inline files). `existing` participates in the cap math. */
export async function prepareFiles(files: Iterable<File>, existing: PreparedAttachment[]): Promise<PrepareResult> {
  const accepted: PreparedAttachment[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    const cls = classifyFile(file.name, file.type, file.size);
    if (cls.kind === 'rejected') {
      rejected.push(cls.reason);
      continue;
    }
    const violation = capViolation([...existing, ...accepted], file.size, cls.kind);
    if (violation) {
      rejected.push(`${file.name}: ${violation}`);
      continue;
    }
    if (cls.kind === 'image') {
      accepted.push({
        kind: 'image',
        name: file.name,
        size: file.size,
        data: await fileToBase64(file),
        mediaType: file.type,
      });
    } else {
      accepted.push({ kind: 'text', name: file.name, size: file.size, content: await file.text() });
    }
  }
  return { accepted, rejected };
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function longestBacktickRun(content: string): number {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
