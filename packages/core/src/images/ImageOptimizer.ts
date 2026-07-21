import type { ImageInput } from '@priest-ai/core';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { MarifoldError } from '../errors/MarifoldError';

/** Keep these limits below the service's JSON body limit after base64 overhead. */
export const MAX_IMAGES_PER_REQUEST = 4;
export const MAX_TOTAL_SOURCE_IMAGE_BYTES = 16 * 1024 * 1024;
export const IMAGE_OPTIMIZE_MIN_BYTES = 300 * 1024;
export const IMAGE_MAX_LONG_EDGE = 1600;
export const IMAGE_JPEG_QUALITY = 85;
export const IMAGE_MAX_INPUT_PIXELS = 8192 * 8192;

const MEDIA_TYPE_BY_FORMAT: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface PreparedImageSummary {
  sourceBytes: number;
  sentBytes: number;
  optimized: boolean;
  sourceMediaType?: string;
  sentMediaType?: string;
}

export interface PreparedImages {
  images: ImageInput[];
  summaries: PreparedImageSummary[];
}

export interface PrepareImageOptions {
  /** Validate and preserve original encoded bytes for this request. */
  optimize?: boolean;
}

/**
 * Validate and reduce local/base64 images before Priest builds provider
 * payloads. URLs remain remote references and are deliberately not fetched.
 *
 * PNG and other lossless inputs stay lossless (WebP) so screenshots and text
 * remain crisp. JPEG uses high-quality 4:4:4 output; static WebP first tries a
 * lossless resized candidate. Animated images remain byte-for-byte unchanged.
 * An optimized candidate is accepted only when it is smaller than the source.
 */
export async function prepareImageInputs(
  inputs?: ImageInput[],
  options: PrepareImageOptions = {},
): Promise<PreparedImages> {
  if (!inputs || inputs.length === 0) return { images: [], summaries: [] };
  if (inputs.length > MAX_IMAGES_PER_REQUEST) {
    throw MarifoldError.imageInvalid(`Up to ${MAX_IMAGES_PER_REQUEST} images may be attached to one request.`);
  }

  const images: ImageInput[] = [];
  const summaries: PreparedImageSummary[] = [];
  let totalSourceBytes = 0;

  for (const [index, input] of inputs.entries()) {
    const sourceCount = [input.path, input.url, input.data].filter(value => typeof value === 'string' && value.length > 0).length;
    if (sourceCount !== 1) {
      throw MarifoldError.imageInvalid(`Image #${index + 1} must set exactly one of path, data, or url.`);
    }
    if (input.url) {
      let protocol: string;
      try {
        protocol = new URL(input.url).protocol;
      } catch {
        throw MarifoldError.imageInvalid(`Image #${index + 1} has an invalid URL.`);
      }
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw MarifoldError.imageInvalid(`Image #${index + 1} URL must use http or https.`);
      }
      images.push(input);
      summaries.push({ sourceBytes: 0, sentBytes: 0, optimized: false });
      continue;
    }

    const source = await readImageBytes(input, index, MAX_TOTAL_SOURCE_IMAGE_BYTES - totalSourceBytes);
    totalSourceBytes += source.length;
    if (totalSourceBytes > MAX_TOTAL_SOURCE_IMAGE_BYTES) {
      throw MarifoldError.imageInvalid(
        `Local and embedded images are limited to ${MAX_TOTAL_SOURCE_IMAGE_BYTES / (1024 * 1024)} MiB per request before optimization.`,
      );
    }

    const image = sharp(source, {
      limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
      sequentialRead: true,
    });
    let metadata;
    try {
      metadata = await image.metadata();
    } catch (error) {
      throw MarifoldError.imageInvalid(`Could not decode image #${index + 1}: ${errorMessage(error)}`);
    }

    const sourceMediaType = metadata.format ? MEDIA_TYPE_BY_FORMAT[metadata.format] : undefined;
    const mustConvert = sourceMediaType === undefined;
    const tooLarge = Math.max(metadata.width ?? 0, metadata.height ?? 0) > IMAGE_MAX_LONG_EDGE;
    const animated = (metadata.pages ?? 1) > 1;
    if (options.optimize === false && mustConvert) {
      throw MarifoldError.imageInvalid(
        `Image #${index + 1} uses an unsupported original format; use JPEG, PNG, WebP, or GIF, or omit /attach-original so Marifold can convert it.`,
      );
    }
    const largeEncoding = source.length >= IMAGE_OPTIMIZE_MIN_BYTES && metadata.format !== 'webp';
    const shouldOptimize = options.optimize !== false
      && !animated
      && (mustConvert || tooLarge || largeEncoding);

    if (!shouldOptimize) {
      const mediaType = sourceMediaType ?? input.mediaType;
      images.push(input.path ? { path: input.path, ...(mediaType ? { mediaType } : {}) } : {
        data: source.toString('base64'),
        ...(mediaType ? { mediaType } : {}),
      });
      summaries.push({
        sourceBytes: source.length,
        sentBytes: source.length,
        optimized: false,
        sourceMediaType,
        sentMediaType: mediaType,
      });
      continue;
    }

    let candidate: Buffer;
    let sentMediaType: string;
    try {
      const pipeline = sharp(source, {
        limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
        sequentialRead: true,
      })
        .autoOrient()
        .resize(IMAGE_MAX_LONG_EDGE, IMAGE_MAX_LONG_EDGE, {
          fit: 'inside',
          withoutEnlargement: true,
        });

      // Lossless inputs remain lossless to protect screenshots, diagrams,
      // transparency, and small text. JPEG/WebP sources are already lossy, so
      // a high-quality re-encode is appropriate after resize/metadata removal.
      if (metadata.format === 'jpeg') {
        candidate = await pipeline.jpeg({
          quality: IMAGE_JPEG_QUALITY,
          chromaSubsampling: '4:4:4',
          mozjpeg: true,
        }).toBuffer();
        sentMediaType = 'image/jpeg';
      } else if (metadata.format === 'webp') {
        const lossless = await pipeline.clone().webp({ lossless: true, effort: 4 }).toBuffer();
        candidate = lossless.length < source.length
          ? lossless
          : await pipeline.webp({ quality: IMAGE_JPEG_QUALITY, smartSubsample: true }).toBuffer();
        sentMediaType = 'image/webp';
      } else {
        candidate = await pipeline.webp({ lossless: true, effort: 4 }).toBuffer();
        sentMediaType = 'image/webp';
      }
    } catch (error) {
      throw MarifoldError.imageInvalid(`Could not optimize image #${index + 1}: ${errorMessage(error)}`);
    }

    if (candidate.length >= source.length && !mustConvert) {
      const mediaType = sourceMediaType ?? input.mediaType;
      images.push(input.path ? { path: input.path, ...(mediaType ? { mediaType } : {}) } : {
        data: source.toString('base64'),
        ...(mediaType ? { mediaType } : {}),
      });
      summaries.push({
        sourceBytes: source.length,
        sentBytes: source.length,
        optimized: false,
        sourceMediaType,
        sentMediaType: mediaType,
      });
      continue;
    }

    images.push({ data: candidate.toString('base64'), mediaType: sentMediaType });
    summaries.push({
      sourceBytes: source.length,
      sentBytes: candidate.length,
      optimized: true,
      sourceMediaType,
      sentMediaType,
    });
  }

  return { images, summaries };
}

async function readImageBytes(input: ImageInput, index: number, remainingBytes: number): Promise<Buffer> {
  if (input.path) {
    try {
      const stat = await fs.stat(input.path);
      if (!stat.isFile()) throw new Error('path is not a regular file');
      if (stat.size > remainingBytes) throw sourceLimitError();
      return await fs.readFile(input.path);
    } catch (error) {
      if (error instanceof MarifoldError) throw error;
      throw MarifoldError.imageInvalid(`Could not read image #${index + 1} at ${input.path}: ${errorMessage(error)}`);
    }
  }
  if (input.data) {
    const data = input.data.trim();
    // Reject oversized base64 before allocating the decoded Buffer.
    if (data.length > Math.ceil(remainingBytes / 3) * 4 + 4) throw sourceLimitError();
    if (!isBase64(data)) {
      throw MarifoldError.imageInvalid(`Image #${index + 1} does not contain valid base64 data.`);
    }
    return Buffer.from(data, 'base64');
  }
  throw MarifoldError.imageInvalid(`Image #${index + 1} must set exactly one of path, data, or url.`);
}

function sourceLimitError(): MarifoldError {
  return MarifoldError.imageInvalid(
    `Local and embedded images are limited to ${MAX_TOTAL_SOURCE_IMAGE_BYTES / (1024 * 1024)} MiB per request before optimization.`,
  );
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  const contentEnd = value.length - padding;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const content = index < contentEnd;
    const validContent = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if ((content && !validContent) || (!content && code !== 61)) return false;
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
