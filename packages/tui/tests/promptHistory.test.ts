import { expect, it, vi } from 'vitest';
import { validatePromptImageReferences, resolvePromptImages, referencedPromptImages } from '../src/core/promptHistory.js';

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

it('loads only the referenced image instead of failing on unused saved attachments', async () => {
  const images = [0, 1, 2].map(attachmentIndex => ({ sessionId: 'saved', userTurnIndex: 0, attachmentIndex }));
  const runtime = { getSessionAttachment: vi.fn(async (_id: string, _turn: number, index: number) => {
    if (index !== 2) { throw new Error('missing unused image'); }
    return { path: '/tmp/current.png' };
  }) };
  const selected = referencedPromptImages('describe [image #3]', images);
  expect(selected.text).toBe('describe [image #1]');
  expect(await resolvePromptImages(runtime, selected.images)).toEqual([{ path: '/tmp/current.png' }]);
  expect(runtime.getSessionAttachment).toHaveBeenCalledTimes(1);
  expect(runtime.getSessionAttachment).toHaveBeenCalledWith('saved', 0, 2);
});

it('preserves repeated references, original image order, and unlabeled legacy attachments', () => {
  const images = ['/tmp/first.png', '/tmp/missing.png', '/tmp/third.png'];
  expect(referencedPromptImages('[image #3] then [image #1] then [image #3]', images)).toEqual({
    text: '[image #2] then [image #1] then [image #2]', images: [images[0], images[2]],
  });
  expect(referencedPromptImages('describe', images)).toEqual({ text: 'describe', images });
  expect(() => referencedPromptImages('[image #4]', images)).toThrow('without a matching attachment');
});
