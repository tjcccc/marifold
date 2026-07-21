import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_MAX_LONG_EDGE,
  MAX_IMAGES_PER_REQUEST,
  MAX_TOTAL_SOURCE_IMAGE_BYTES,
  prepareImageInputs,
} from '../src/images/ImageOptimizer';

describe('prepareImageInputs', () => {
  it('losslessly shrinks and resizes a large PNG', async () => {
    const source = await sharp({
      create: { width: 2400, height: 1200, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 0.7 } },
    }).png({ compressionLevel: 0 }).toBuffer();

    const result = await prepareImageInputs([{ data: source.toString('base64'), mediaType: 'image/png' }]);
    const output = Buffer.from(result.images[0].data!, 'base64');
    const metadata = await sharp(output).metadata();

    expect(result.summaries[0]).toMatchObject({ optimized: true, sourceMediaType: 'image/png', sentMediaType: 'image/webp' });
    expect(output.length).toBeLessThan(source.length);
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(IMAGE_MAX_LONG_EDGE);
    expect(metadata.format).toBe('webp');
    expect(metadata.hasAlpha).toBe(true);
  });

  it('preserves original bytes for a one-turn /attach-original request', async () => {
    const source = await sharp({
      create: { width: 1700, height: 100, channels: 3, background: '#be7138' },
    }).png({ compressionLevel: 0 }).toBuffer();

    const result = await prepareImageInputs(
      [{ data: source.toString('base64'), mediaType: 'image/jpeg' }],
      { optimize: false },
    );

    expect(Buffer.from(result.images[0].data!, 'base64')).toEqual(source);
    expect(result.images[0].mediaType).toBe('image/png');
    expect(result.summaries[0].optimized).toBe(false);
  });

  it('detects the real MIME type for TUI paths without rewriting small originals', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marifold-image-'));
    const file = path.join(dir, 'misnamed.jpg');
    try {
      await fs.writeFile(file, await sharp({
        create: { width: 20, height: 10, channels: 3, background: '#123456' },
      }).png().toBuffer());
      const result = await prepareImageInputs([{ path: file }]);
      expect(result.images).toEqual([{ path: file, mediaType: 'image/png' }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves URL references remote and untouched', async () => {
    const input = { url: 'https://example.com/image.png' };
    const result = await prepareImageInputs([input]);
    expect(result.images).toEqual([input]);
    expect(result.summaries[0]).toMatchObject({ sourceBytes: 0, sentBytes: 0, optimized: false });
  });

  it('rejects malformed base64, unsupported original formats, count overflow, and byte overflow', async () => {
    await expect(prepareImageInputs([{ data: 'not base64!!', mediaType: 'image/png' }])).rejects.toMatchObject({ code: 'IMAGE_INVALID' });

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(prepareImageInputs(
      [{ data: svg.toString('base64'), mediaType: 'image/svg+xml' }],
      { optimize: false },
    )).rejects.toMatchObject({ code: 'IMAGE_INVALID' });

    await expect(prepareImageInputs(Array.from(
      { length: MAX_IMAGES_PER_REQUEST + 1 },
      () => ({ url: 'https://example.com/a.png' }),
    ))).rejects.toMatchObject({ code: 'IMAGE_INVALID' });

    const tooLarge = Buffer.alloc(MAX_TOTAL_SOURCE_IMAGE_BYTES + 1).toString('base64');
    await expect(prepareImageInputs([{ data: tooLarge, mediaType: 'image/png' }])).rejects.toMatchObject({ code: 'IMAGE_INVALID' });
  });
});
