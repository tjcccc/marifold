import { expect, it, vi } from 'vitest';
import { resolvePromptImages } from '../src/core/promptHistory.js';

it('fails explicitly when a retained image is missing instead of sending only its placeholder', async () => {
  const runtime = { getSessionAttachment: vi.fn().mockResolvedValue(undefined) };
  await expect(resolvePromptImages(runtime, [{ sessionId: 'saved', userTurnIndex: 0, attachmentIndex: 0 }])).rejects.toThrow('saved image is no longer available');
});
