// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_TEXT_FILE_BYTES,
  MAX_TOTAL_BYTES,
  capViolation,
  classifyFile,
  inlineTextAttachments,
  optimizeBrowserImage,
  type PreparedAttachment,
} from '../../src/lib/attachments';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('classifyFile', () => {
  it.each([
    ['photo.png', 'image/png', 100, 'image'],
    ['photo.jpg', 'image/jpeg', 100, 'image'],
    ['anim.gif', 'image/gif', 100, 'image'],
    ['pic.webp', 'image/webp', 100, 'image'],
    ['scan.tiff', 'image/tiff', 100, 'rejected'],
    ['notes.md', 'text/markdown', 100, 'text'],
    ['data.json', '', 100, 'text'], // extension carries it when MIME is empty
    ['script.ts', '', 100, 'text'],
    ['binary.bin', 'application/octet-stream', 100, 'rejected'],
    ['archive.zip', 'application/zip', 100, 'rejected'],
  ])('%s (%s) → %s', (name, type, size, expected) => {
    expect(classifyFile(name, type, size).kind).toBe(expected);
  });

  it('rejects oversized text files with the size limit in the reason', () => {
    const result = classifyFile('big.log', 'text/plain', MAX_TEXT_FILE_BYTES + 1);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reason).toContain('KB');
  });
});

describe('capViolation', () => {
  const image = (size = 1000): PreparedAttachment => ({ kind: 'image', name: 'a.png', size, data: '', mediaType: 'image/png' });

  it('caps the image count per message', () => {
    const existing = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, () => image());
    expect(capViolation(existing, 10, 'image')).toContain('images per message');
    expect(capViolation(existing, 10, 'text')).toBeUndefined();
  });

  it('caps the total payload size', () => {
    expect(capViolation([image(MAX_TOTAL_BYTES)], 1, 'text')).toContain('MB per message');
    expect(capViolation([image(1000)], 1000, 'image')).toBeUndefined();
  });
});

describe('inlineTextAttachments', () => {
  it('appends fenced blocks headed by the filename', () => {
    const prompt = inlineTextAttachments('Review this.', [{ name: 'notes.md', content: '# Hello' }]);
    expect(prompt).toBe('Review this.\n\nAttached file: notes.md\n```\n# Hello\n```');
  });

  it('stretches the fence past backtick runs inside the content', () => {
    const prompt = inlineTextAttachments('Check.', [{ name: 'doc.md', content: 'code:\n```js\nx\n```' }]);
    expect(prompt).toContain('````\ncode:');
    expect(prompt.endsWith('````')).toBe(true);
  });

  it('returns the prompt untouched without text files', () => {
    expect(inlineTextAttachments('Just this.', [])).toBe('Just this.');
  });
});

describe('optimizeBrowserImage', () => {
  it('resizes and re-encodes a large JPEG before base64 conversion', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3200, height: 1600, close })));
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback: (blob: Blob | null) => void, type: string) => {
        callback(new Blob([new Uint8Array(1200)], { type }));
      }),
    };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement);
    const source = new File([new Uint8Array(400 * 1024)], 'photo.jpg', { type: 'image/jpeg' });

    const result = await optimizeBrowserImage(source);

    expect(result).toMatchObject({ optimized: true, originalSize: source.size, size: 1200, mediaType: 'image/jpeg' });
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(800);
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('keeps PNG browser output lossless and preserves GIF/WebP originals', async () => {
    const createImageBitmap = vi.fn(async () => ({ width: 2000, height: 1000, close: vi.fn() }));
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((callback: (blob: Blob | null) => void, type: string) => {
        callback(new Blob([new Uint8Array(1000)], { type }));
      }),
    };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement);

    const png = await optimizeBrowserImage(new File([new Uint8Array(400 * 1024)], 'ui.png', { type: 'image/png' }));
    expect(png).toMatchObject({ optimized: true, mediaType: 'image/png' });

    const gif = await optimizeBrowserImage(new File([new Uint8Array(400 * 1024)], 'anim.gif', { type: 'image/gif' }));
    const webp = await optimizeBrowserImage(new File([new Uint8Array(400 * 1024)], 'anim.webp', { type: 'image/webp' }));
    expect(gif.optimized).toBe(false);
    expect(webp.optimized).toBe(false);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it('keeps the original when browser encoding is not smaller', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1000, height: 1000, close: vi.fn() })));
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((callback: (blob: Blob | null) => void, type: string) => {
        callback(new Blob([new Uint8Array(500 * 1024)], { type }));
      }),
    };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement);
    const source = new File([new Uint8Array(400 * 1024)], 'photo.jpg', { type: 'image/jpeg' });
    expect((await optimizeBrowserImage(source)).optimized).toBe(false);
  });
});
