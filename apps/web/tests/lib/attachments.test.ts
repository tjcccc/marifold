import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_TEXT_FILE_BYTES,
  MAX_TOTAL_BYTES,
  capViolation,
  classifyFile,
  inlineTextAttachments,
  type PreparedAttachment,
} from '../../src/lib/attachments';

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
