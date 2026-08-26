// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_OFFICE_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  MAX_TOTAL_BYTES,
  capViolation,
  classifyFile,
  inlineTextAttachments,
  modelPromptWithAttachments,
  optimizeBrowserImage,
  prepareFiles,
  splitInlineTextAttachments,
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
    ['brief.docx', '', 100, 'office'],
    ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 100, 'office'],
    ['deck.pptx', 'application/zip', 100, 'office'],
    ['legacy.doc', 'application/msword', 100, 'rejected'],
    ['binary.bin', 'application/octet-stream', 100, 'file'],
    ['archive.zip', 'application/zip', 100, 'file'],
    ['voice.mp3', 'audio/mpeg', 100, 'file'],
  ])('%s (%s) → %s', (name, type, size, expected) => {
    expect(classifyFile(name, type, size).kind).toBe(expected);
  });

  it('rejects oversized text files with the size limit in the reason', () => {
    const result = classifyFile('big.log', 'text/plain', MAX_TEXT_FILE_BYTES + 1);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reason).toContain('KB');
  });

  it('rejects Office files beyond the local extraction limit', () => {
    const result = classifyFile('huge.pptx', '', MAX_OFFICE_FILE_BYTES + 1);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reason).toContain('16 MiB');
  });

  it('accepts a generic binary for turn-local agent inspection', async () => {
    const file = new File(['audio-bytes'], 'voice.mp3', { type: 'audio/mpeg' });
    const result = await prepareFiles([file], []);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]).toMatchObject({
      kind: 'file',
      name: 'voice.mp3',
      size: file.size,
      mediaType: 'audio/mpeg',
      originalFile: file,
    });
  });
});

describe('Office attachment extraction', () => {
  it('extracts paragraphs from DOCX locally', async () => {
    const file = officeFile('brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', {
      'word/document.xml': `
        <w:document xmlns:w="urn:word">
          <w:body>
            <w:p><w:r><w:t>Project brief</w:t></w:r></w:p>
            <w:p><w:r><w:t>Owner</w:t></w:r><w:tab/><w:r><w:t>Alex</w:t></w:r></w:p>
          </w:body>
        </w:document>`,
    });

    const result = await prepareFiles([file], []);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]).toMatchObject({
      kind: 'text',
      name: 'brief.docx',
      officeKind: 'word',
      content: 'Project brief\nOwner\tAlex',
      originalFile: file,
      originalSize: file.size,
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('extracts ordered slide text from PPTX', async () => {
    const file = officeFile('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', {
      'ppt/slides/slide2.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Next steps</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Quarterly review</a:t></a:r></a:p></p:sld>',
    });

    const result = await prepareFiles([file], []);
    const attachment = result.accepted[0];

    expect(result.rejected).toEqual([]);
    expect(attachment).toMatchObject({ kind: 'text', officeKind: 'presentation' });
    if (attachment?.kind === 'text') {
      expect(attachment.content).toBe('Slide 1\nQuarterly review\n\nSlide 2\nNext steps');
    }
  });

  it('extracts named worksheet cells, shared strings, booleans, and formulas from XLSX', async () => {
    const file = officeFile('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', {
      'xl/workbook.xml': `
        <workbook xmlns:r="urn:relationships"><sheets>
          <sheet name="Budget" sheetId="1" r:id="rId1"/>
        </sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `
        <Relationships>
          <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
        </Relationships>`,
      'xl/sharedStrings.xml': `
        <sst><si><t>Item</t></si><si><r><t>Revenue</t></r></si><si><t>Widget</t></si></sst>`,
      'xl/worksheets/sheet1.xml': `
        <worksheet><sheetData><row>
          <c r="A1" t="s"><v>0</v></c>
          <c r="B1" t="s"><v>1</v></c>
          <c r="A2" t="s"><v>2</v></c>
          <c r="B2"><f>SUM(B3:B4)</f><v>120</v></c>
          <c r="C2" t="b"><v>1</v></c>
        </row></sheetData></worksheet>`,
    });

    const result = await prepareFiles([file], []);
    const attachment = result.accepted[0];

    expect(result.rejected).toEqual([]);
    expect(attachment).toMatchObject({ kind: 'text', officeKind: 'spreadsheet' });
    if (attachment?.kind === 'text') {
      expect(attachment.content).toContain('Sheet: Budget');
      expect(attachment.content).toContain('A1: Item');
      expect(attachment.content).toContain('B1: Revenue');
      expect(attachment.content).toContain('B2: =SUM(B3:B4) (value: 120)');
      expect(attachment.content).toContain('C2: TRUE');
    }
  });

  it('returns a useful rejection for malformed Office files', async () => {
    const file = new File(['not a ZIP'], 'broken.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const result = await prepareFiles([file], []);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]).toContain('could not extract Office text');
  });

  it('bounds large extracted Office text before it enters the prompt', async () => {
    const file = officeFile('long.docx', '', {
      'word/document.xml': `
        <w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>
          ${'界'.repeat(MAX_TEXT_FILE_BYTES)}
        </w:t></w:r></w:p></w:body></w:document>`,
    });
    const result = await prepareFiles([file], []);
    const attachment = result.accepted[0];

    expect(result.rejected).toEqual([]);
    expect(attachment).toMatchObject({ kind: 'text', officeKind: 'word', truncated: true });
    if (attachment?.kind === 'text') {
      expect(attachment.size).toBeLessThanOrEqual(MAX_TEXT_FILE_BYTES);
      expect(attachment.content).toContain('[Office extraction truncated');
    }
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

  it('keeps readable file contents out of Agent model prompts while Chat inlines them', () => {
    const files = [{ name: 'large.csv', content: 'name,total\nNorth,42' }];

    expect(modelPromptWithAttachments('Join these files.', files, 'agent')).toBe('Join these files.');
    expect(modelPromptWithAttachments('Join these files.', files, 'chat')).toContain('North,42');
  });

  it('round-trips multiple attachments without exposing their content in the display prompt', () => {
    const inlined = inlineTextAttachments('Review these.', [
      { name: 'notes.md', content: '# Notes\n```js\nx\n```' },
      { name: 'brief.docx', content: 'Project brief' },
    ]);
    expect(splitInlineTextAttachments(inlined)).toEqual({
      prompt: 'Review these.',
      files: [
        { name: 'notes.md', content: '# Notes\n```js\nx\n```' },
        { name: 'brief.docx', content: 'Project brief' },
      ],
    });
  });

  it('does not hide a malformed attachment-like suffix', () => {
    const value = 'Example\n\nAttached file: not-real.txt\n```\nmissing close';
    expect(splitInlineTextAttachments(value)).toEqual({ prompt: value, files: [] });
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

function officeFile(name: string, mediaType: string, entries: Record<string, string>): File {
  const archive = zipSync(Object.fromEntries(
    Object.entries(entries).map(([path, content]) => [path, strToU8(content)]),
  ));
  return new File([archive], name, { type: mediaType });
}
