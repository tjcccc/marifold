import type { ImageInput, SessionDetail } from '@marifold/core';
import type { TuiRuntime } from './TuiRuntime.js';

export type PromptImage = string | ImageInput | { sessionId: string; userTurnIndex: number; attachmentIndex: number };
export type InputHistoryEntry = string | { text: string; images: PromptImage[] };

/** Reuse saved user turns; image bytes remain lazy until resubmission. */
export function sessionPromptHistory(session: SessionDetail): InputHistoryEntry[] {
  return session.turns.filter(turn => turn.role === 'user').map(turn => ({
    text: turn.content,
    images: (turn.attachments ?? []).map(image => image.ref
      ? { sessionId: session.id, ...image.ref }
      : { mediaType: image.mediaType, ...(image.data ? { data: image.data } : {}), ...(image.url ? { url: image.url } : {}) }),
  }));
}

export async function resolvePromptImages(runtime: Pick<TuiRuntime, 'getSessionAttachment'>, images: PromptImage[]): Promise<ImageInput[]> {
  return Promise.all(images.map(async image => {
    if (typeof image === 'string') return { path: image };
    if (!('sessionId' in image)) return image;
    const retained = await runtime.getSessionAttachment(image.sessionId, image.userTurnIndex, image.attachmentIndex);
    if (!retained?.data && !retained?.url && !retained?.path) throw new Error('A saved image is no longer available. Reattach it before resubmitting this prompt.');
    return retained;
  }));
}

/** Image numbers are local to one prompt, never identifiers for a session image. */
export function validatePromptImageReferences(text: string, imageCount: number): void {
  const references = Array.from(text.matchAll(/\[image #(\d+)\]/g), match => Number(match[1]));
  if (references.some(index => !Number.isSafeInteger(index) || index < 1 || index > imageCount)) {
    throw new Error('This prompt has an image reference without a matching attachment. Recall the original image-bearing prompt or reattach the intended image.');
  }
}
