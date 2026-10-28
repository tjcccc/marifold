import * as crypto from 'crypto';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';

/** What an artifact shows: a sandboxed page, or Markdown the app renders. */
export type ArtifactKind = 'html' | 'markdown';

/** One file of a bundle, by its `/`-separated path inside the bundle. */
export interface ArtifactBundleFile {
  path: string;
  data: Buffer;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_LENGTH = 10;
export const ARTIFACT_ID = /^[a-z2-7]{10}$/;
const MAX_DEPTH = 8;
const MAX_PATH = 400;

/** A short random id: 10 characters of lowercase base32 (50 bits). */
export function newArtifactId(): string {
  const bytes = crypto.randomBytes(ID_LENGTH);
  return Array.from(bytes, byte => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

/**
 * A bundle path made safe, or a refusal: relative, `/`-separated, no `..`, no
 * empty or dot-leading segments, no drive letters, control characters or
 * backslashes, at most 8 levels deep. Nothing outside the bundle can be named.
 */
export function bundlePath(value: string): string {
  const trimmed = value.trim();
  const invalid = (reason: string) => MarifoldError.artifactInvalid(`Artifact file "${value}" ${reason}.`);
  if (!trimmed || trimmed.length > MAX_PATH) { throw invalid('needs a path of 1 to 400 characters'); }
  if (/[\x00-\x1f\x7f\\]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('/')) {
    throw invalid('must be a relative path inside the artifact');
  }
  const segments = trimmed.split('/');
  if (segments.length > MAX_DEPTH) { throw invalid(`is more than ${MAX_DEPTH} folders deep`); }
  if (segments.some(segment => segment === '' || segment.startsWith('.'))) {
    throw invalid('has an empty, "." or ".." part, or a hidden name');
  }
  return segments.join('/');
}

/** The entry file and kind of a bundle: the given entry, else `index.html` /
 * `index.md`, else its only file. HTML entries make `html`, Markdown `markdown`. */
export function bundleEntry(files: readonly ArtifactBundleFile[], entry?: string): { entry: string; kind: ArtifactKind } {
  const paths = files.map(file => file.path);
  const chosen = entry !== undefined
    ? bundlePath(entry)
    : ['index.html', 'index.htm', 'index.md'].find(name => paths.includes(name)) ?? (paths.length === 1 ? paths[0] : undefined);
  if (!chosen) {
    throw MarifoldError.artifactInvalid('Name the entry file: the bundle has no index.html or index.md and more than one file.');
  }
  if (!paths.includes(chosen)) { throw MarifoldError.artifactInvalid(`The entry file "${chosen}" is not in the bundle.`); }
  const kind = entryKind(chosen);
  if (!kind) { throw MarifoldError.artifactInvalid(`The entry file "${chosen}" must be .html or .md.`); }
  return { entry: chosen, kind };
}

export function entryKind(entry: string): ArtifactKind | undefined {
  const ext = path.posix.extname(entry).toLowerCase();
  if (ext === '.html' || ext === '.htm') { return 'html'; }
  if (ext === '.md' || ext === '.markdown') { return 'markdown'; }
  return undefined;
}

const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

/** The type a bundle file is served with (always with `nosniff`). */
export function bundleMediaType(file: string): string {
  return MEDIA_TYPES[path.posix.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
