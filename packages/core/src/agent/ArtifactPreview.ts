import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import sharp from 'sharp';
import type { ResolvedRunArtifact } from './RunArtifacts';

export function isPreviewableArtifact(mediaType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(mediaType);
}

/** Decode bounded raster inputs on their owning device, never relay the full
 * source just to render a transcript thumbnail. SVG/HTML remain downloads. */
export async function createArtifactPreview(artifact: ResolvedRunArtifact): Promise<Buffer> {
  if (!isPreviewableArtifact(artifact.mediaType)) throw new Error('This file has no image preview.');
  const file = await fs.open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Image is too large to preview.');
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
    return await sharp(bytes, { limitInputPixels: 40_000_000, pages: 1 })
      .rotate().resize({ width: 960, height: 720, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 }).toBuffer();
  } finally { await file.close(); }
}
