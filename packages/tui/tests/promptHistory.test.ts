import { expect, it, vi } from 'vitest';
import { validatePromptImageReferences, resolvePromptImages } from '../src/core/promptHistory.js';

it('fails explicitly when a retained image is missing instead of sending only its placeholder', async () => {
  const runtime = { getSessionAttachment: vi.fn().mockResolvedValue(undefined) };
  await expect(resolvePromptImages(runtime, [{ sessionId: 'saved', userTurnIndex: 0, attachmentIndex: 0 }])).rejects.toThrow('saved image is no longer available');
});

it('rejects image references without their own matching attachments', () => {
  expect(() => validatePromptImageReferences('inspect [image #1]', 0)).toThrow('without a matching attachment');
  expect(() => validatePromptImageReferences('inspect [image #2]', 1)).toThrow('without a matching attachment');
  expect(() => validatePromptImageReferences('inspect [image #0]', 1)).toThrow('without a matching attachment');
});

it('accepts references to attached images and ordinary prompts', () => {
  expect(() => validatePromptImageReferences('inspect [image #2] and [image #1]', 2)).not.toThrow();
  expect(() => validatePromptImageReferences('write a greeting', 0)).not.toThrow();
});

it('restores a local source path instead of materializing saved image bytes', async () => {
  const runtime = { getSessionAttachment: vi.fn().mockResolvedValue({ path: '/tmp/source.png', mediaType: 'image/png' }) };
  expect(await resolvePromptImages(runtime, [{ sessionId: 'saved', userTurnIndex: 2, attachmentIndex: 0 }])).toEqual([{ path: '/tmp/source.png', mediaType: 'image/png' }]);
});
