/**
 * Attachment classification and prompt inlining. The rules are pure functions
 * over (name, mime type, size) so they unit-test without DOM File objects;
 * `prepareFiles` is the thin browser shim that reads the actual bytes.
 */

export const MAX_IMAGES_PER_MESSAGE = 4;
/** The service's 25 MiB body limit still has room for base64 expansion. */
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 256 * 1024;
export const MAX_OFFICE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_GENERIC_FILE_BYTES = 16 * 1024 * 1024;
export const IMAGE_OPTIMIZE_MIN_BYTES = 300 * 1024;
export const IMAGE_MAX_LONG_EDGE = 1600;
export const IMAGE_OUTPUT_QUALITY = 0.85;

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

export type OfficeFileKind = 'word' | 'spreadsheet' | 'presentation';

const OFFICE_EXTENSIONS: Record<string, OfficeFileKind> = {
  docx: 'word',
  xlsx: 'spreadsheet',
  pptx: 'presentation',
};

const OFFICE_MEDIA_TYPES: Record<string, OfficeFileKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation',
};

const LEGACY_OFFICE_EXTENSIONS: Record<string, string> = {
  doc: 'DOCX',
  xls: 'XLSX',
  ppt: 'PPTX',
};

export function officeKindForFile(name: string, mediaType = ''): OfficeFileKind | undefined {
  return OFFICE_EXTENSIONS[extension(name)] ?? OFFICE_MEDIA_TYPES[mediaType];
}

export type AttachmentClass =
  | { kind: 'image' }
  | { kind: 'text' }
  | { kind: 'office'; officeKind: OfficeFileKind }
  | { kind: 'file' }
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
  const suffix = extension(name);
  const officeKind = officeKindForFile(name, mediaType);
  if (officeKind) {
    if (size > MAX_OFFICE_FILE_BYTES) {
      return {
        kind: 'rejected',
        reason: `${name}: Office files up to ${MAX_OFFICE_FILE_BYTES / (1024 * 1024)} MiB can be read.`,
      };
    }
    return { kind: 'office', officeKind };
  }
  const modernFormat = LEGACY_OFFICE_EXTENSIONS[suffix];
  if (modernFormat) {
    return {
      kind: 'rejected',
      reason: `${name}: legacy Office files are not supported; save it as ${modernFormat} first.`,
    };
  }
  if (size > MAX_GENERIC_FILE_BYTES) {
    return {
      kind: 'rejected',
      reason: `${name}: files up to ${MAX_GENERIC_FILE_BYTES / (1024 * 1024)} MiB can be attached.`,
    };
  }
  return { kind: 'file' };
}

export type PreparedAttachment =
  | {
      kind: 'image';
      name: string;
      size: number;
      originalSize?: number;
      /** Kept as a Blob-backed File so /attach-original can bypass preprocessing
       * without retaining a second base64 copy in React state. */
      originalFile?: File;
      optimized?: boolean;
      data: string;
      mediaType: string;
    }
  | {
      kind: 'text';
      name: string;
      size: number;
      content: string;
      officeKind?: OfficeFileKind;
      truncated?: boolean;
      /** Original browser file retained only for the pending submission so an
       * agent run can stage the real upload read-only. */
      originalFile?: File;
      originalSize?: number;
      mediaType?: string;
    }
  | {
      kind: 'file';
      name: string;
      size: number;
      mediaType: string;
      /** Generic binary retained only for the pending agent run. */
      originalFile: File;
    };

/** Enforce the per-message caps over already-accepted attachments. Returns the
 * reason the next file must be refused, or undefined when it fits. */
export function capViolation(existing: PreparedAttachment[], nextSize: number, nextKind: 'image' | 'file' | 'text'): string | undefined {
  if (nextKind === 'image' && existing.filter(a => a.kind === 'image').length >= MAX_IMAGES_PER_MESSAGE) {
    return `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`;
  }
  const total = existing.reduce(
    (sum, item) => sum + (item.kind === 'file' ? item.size : (item.originalSize ?? item.size)),
    0,
  ) + nextSize;
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

export interface SplitInlineAttachments {
  prompt: string;
  files: Array<{ name: string; content: string }>;
}

/** Inverse of inlineTextAttachments for transcript display. The stretched
 * fence guarantees the closing marker cannot occur inside extracted content.
 * If the suffix is not entirely well-formed, leave the user text untouched. */
export function splitInlineTextAttachments(value: string): SplitInlineAttachments {
  const marker = '\n\nAttached file: ';
  const firstMarker = value.indexOf(marker);
  if (firstMarker === -1) return { prompt: value, files: [] };

  const files: Array<{ name: string; content: string }> = [];
  let cursor = firstMarker;
  while (cursor < value.length) {
    if (!value.startsWith(marker, cursor)) return { prompt: value, files: [] };
    const nameStart = cursor + marker.length;
    const nameEnd = value.indexOf('\n', nameStart);
    if (nameEnd === -1) return { prompt: value, files: [] };
    const name = value.slice(nameStart, nameEnd);
    const fenceEnd = value.indexOf('\n', nameEnd + 1);
    if (fenceEnd === -1) return { prompt: value, files: [] };
    const fence = value.slice(nameEnd + 1, fenceEnd);
    if (!/^`{3,}$/.test(fence)) return { prompt: value, files: [] };
    const closing = `\n${fence}`;
    const contentEnd = value.indexOf(closing, fenceEnd + 1);
    if (contentEnd === -1) return { prompt: value, files: [] };
    files.push({ name, content: value.slice(fenceEnd + 1, contentEnd) });
    cursor = contentEnd + closing.length;
    if (cursor === value.length) break;
  }
  return { prompt: value.slice(0, firstMarker), files };
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
    if (cls.kind === 'image') {
      if (file.size > MAX_TOTAL_BYTES) {
        rejected.push(`${file.name}: source images are limited to ${MAX_TOTAL_BYTES / (1024 * 1024)} MiB each.`);
        continue;
      }
      try {
        const image = await optimizeBrowserImage(file);
        const violation = capViolation([...existing, ...accepted], image.size, 'image');
        if (violation) {
          rejected.push(`${file.name}: ${violation}`);
          continue;
        }
        accepted.push({ kind: 'image', name: file.name, originalFile: file, ...image });
      } catch (error) {
        rejected.push(`${file.name}: could not decode or optimize image (${errorMessage(error)}).`);
      }
    } else if (cls.kind === 'text') {
      const violation = capViolation([...existing, ...accepted], file.size, 'file');
      if (violation) {
        rejected.push(`${file.name}: ${violation}`);
        continue;
      }
      accepted.push({
        kind: 'text',
        name: file.name,
        size: file.size,
        content: await file.text(),
        originalFile: file,
        mediaType: file.type || 'text/plain',
      });
    } else if (cls.kind === 'office') {
      try {
        const { extractOfficeText } = await import('./officeAttachments');
        const extracted = await extractOfficeText(file, cls.officeKind, MAX_TEXT_FILE_BYTES);
        const violation = capViolation([...existing, ...accepted], file.size, 'file');
        if (violation) {
          rejected.push(`${file.name}: ${violation}`);
          continue;
        }
        accepted.push({
          kind: 'text',
          name: file.name,
          size: extracted.size,
          content: extracted.content,
          officeKind: cls.officeKind,
          originalFile: file,
          originalSize: file.size,
          mediaType: file.type || officeMediaType(cls.officeKind),
          ...(extracted.truncated ? { truncated: true } : {}),
        });
      } catch (error) {
        rejected.push(`${file.name}: could not extract Office text (${errorMessage(error)}).`);
      }
    } else {
      const violation = capViolation([...existing, ...accepted], file.size, 'file');
      if (violation) {
        rejected.push(`${file.name}: ${violation}`);
        continue;
      }
      accepted.push({
        kind: 'file',
        name: file.name,
        size: file.size,
        mediaType: file.type || 'application/octet-stream',
        originalFile: file,
      });
    }
  }
  return { accepted, rejected };
}

function officeMediaType(kind: OfficeFileKind): string {
  if (kind === 'word') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (kind === 'spreadsheet') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
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

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface BrowserOptimizedImage {
  size: number;
  originalSize: number;
  optimized: boolean;
  data: string;
  mediaType: string;
}

/**
 * Reduce an image before it enters React state or the service JSON body.
 * PNG remains lossless for crisp UI text/transparency; JPEG uses a high-quality
 * encoder. GIF/WebP remain untouched so animation is never flattened.
 * Core repeats validation and optimization as the authoritative boundary.
 */
export async function optimizeBrowserImage(file: File): Promise<BrowserOptimizedImage> {
  if (
    file.size < IMAGE_OPTIMIZE_MIN_BYTES
    || file.type === 'image/gif'
    || file.type === 'image/webp'
    || typeof createImageBitmap !== 'function'
    || typeof document === 'undefined'
  ) {
    return originalBrowserImage(file);
  }

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, IMAGE_MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return originalBrowserImage(file);
    context.drawImage(bitmap, 0, 0, width, height);

    // Keep PNG lossless. JPEG uses a high-quality re-encode after resizing.
    // WebP is left to core because Canvas cannot reliably tell static and
    // animated WebP apart and must never flatten animation accidentally.
    const outputType = file.type === 'image/png' ? 'image/png' : file.type;
    const candidate = await canvasToBlob(canvas, outputType, IMAGE_OUTPUT_QUALITY);
    if (candidate.size >= file.size) return originalBrowserImage(file);
    return {
      size: candidate.size,
      originalSize: file.size,
      optimized: true,
      data: await fileToBase64(candidate),
      mediaType: candidate.type || outputType,
    };
  } finally {
    bitmap.close();
  }
}

async function originalBrowserImage(file: File): Promise<BrowserOptimizedImage> {
  return {
    size: file.size,
    originalSize: file.size,
    optimized: false,
    data: await fileToBase64(file),
    mediaType: file.type,
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error(`browser could not encode ${type}`));
    }, type, quality);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
