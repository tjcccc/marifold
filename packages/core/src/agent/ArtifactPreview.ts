import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import sharp from 'sharp';
import type { ResolvedRunArtifact } from './RunArtifacts';

export function isPreviewableArtifact(mediaType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(mediaType);
}

export type ArtifactPreviewVariant = 'thumbnail' | 'viewer';
export const ARTIFACT_VIEWER_MAX_BYTES = 1_000_000;
const cache = new Map<string, Buffer>();
const pending = new Map<string, Promise<Buffer>>();
const CACHE_BYTES = 32 * 1024 * 1024;
let cachedBytes = 0;

export function artifactPreviewVariant(value: unknown): ArtifactPreviewVariant {
  if (value === undefined || value === 'thumbnail') return 'thumbnail';
  if (value === 'viewer') return 'viewer';
  throw new Error('Invalid image preview variant.');
}

async function encode(bytes: Buffer, variant: ArtifactPreviewVariant): Promise<Buffer> {
  const limit = variant === 'viewer' ? ARTIFACT_VIEWER_MAX_BYTES : 80_000;
  let edge = variant === 'viewer' ? 2048 : 480;
  while (edge >= 120) {
    for (const quality of [84, 72, 60]) {
      const result = await sharp(bytes, { limitInputPixels: 40_000_000, pages: 1 })
        .rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 2 }).toBuffer();
      if (result.length <= limit) return result;
    }
    edge = Math.floor(edge * 0.75);
  }
  throw new Error('Could not create a bounded image preview.');
}

/** Decode bounded raster inputs on their owning device, never relay the full
 * source just to render a transcript thumbnail. SVG/HTML remain downloads. */
export async function createArtifactPreview(artifact: ResolvedRunArtifact, variant: ArtifactPreviewVariant = 'thumbnail'): Promise<Buffer> {
  variant = artifactPreviewVariant(variant);
  if (!isPreviewableArtifact(artifact.mediaType)) throw new Error('This file has no image preview.');
  const file = await fs.open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Image is too large to preview.');
    const key = JSON.stringify([artifact.path, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, variant]);
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
    const existing = pending.get(key);
    if (existing) return await existing;
    if (pending.size >= 4) throw new Error('Image previews are busy. Try again.');
    const work = (async () => {
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error('Image changed while preparing its preview.');
        offset += read.bytesRead;
      }
      const raster = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        || (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
      if (!raster) throw new Error('This file is not a supported raster image.');
      const result = await encode(bytes, variant);
      const after = await file.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
        throw new Error('Image changed while preparing its preview.');
      while (cachedBytes + result.length > CACHE_BYTES || cache.size >= 256) {
        const oldest = cache.keys().next().value!;
        cachedBytes -= cache.get(oldest)!.length;
        cache.delete(oldest);
      }
      cache.set(key, result);
      cachedBytes += result.length;
      return result;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  } finally { await file.close(); }
}
