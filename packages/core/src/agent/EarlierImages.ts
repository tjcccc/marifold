import type { ImageInput } from '@priest-ai/core';
import type { SessionTurnSummary } from '../config/ConfigSchema';
import { stageRunImages, type RunWorkspace, type StagedRunAttachment } from './RunWorkspace';

/** At most this many earlier session images are offered to one run. */
export const EARLIER_IMAGE_LIMIT = 4;

/** Where an earlier image lives in the session, with the turn it came with. */
export interface SessionImageRef {
  userTurnIndex: number;
  attachmentIndex: number;
  mediaType: string;
  turn: string;
}

/** How a run reaches its session's earlier images. */
export interface SessionImageAccess {
  list(sessionId: string, beforeUserTurnIndex?: number): SessionImageRef[];
  load(sessionId: string, userTurnIndex: number, attachmentIndex: number): ImageInput | undefined;
}

/** An image the user attached earlier in this session. The model sees only
 * its ID; the bytes are loaded and staged when the model inspects it. */
export interface EarlierRunImage {
  id: string;
  ref: SessionImageRef;
  load(): Promise<ImageInput | undefined>;
  staged?: StagedRunAttachment;
}

/** Images on user turns before `beforeUserTurnIndex` (all turns when absent), newest last. */
export function sessionImageRefs(turns: SessionTurnSummary[], beforeUserTurnIndex?: number): SessionImageRef[] {
  const refs: SessionImageRef[] = [];
  let userTurnIndex = -1;
  for (const turn of turns) {
    if (turn.role !== 'user') { continue; }
    userTurnIndex += 1;
    if (beforeUserTurnIndex !== undefined && userTurnIndex >= beforeUserTurnIndex) { break; }
    const preview = turn.content.replace(/\s+/g, ' ').trim().slice(0, 80);
    (turn.attachments ?? []).forEach((attachment, attachmentIndex) => {
      refs.push({ userTurnIndex, attachmentIndex, mediaType: attachment.mediaType, turn: preview });
    });
  }
  return refs;
}

/** Earlier-image access backed by a session store (the runtime's SessionResolver). */
export function sessionImageAccess(store: {
  get(sessionId: string): { turns: SessionTurnSummary[] } | undefined;
  getAttachment(sessionId: string, userTurnIndex: number, attachmentIndex: number): Parameters<typeof sessionImageInput>[0];
}): SessionImageAccess {
  return {
    list: (sessionId, beforeUserTurnIndex) => sessionImageRefs(store.get(sessionId)?.turns ?? [], beforeUserTurnIndex),
    load: (sessionId, userTurnIndex, attachmentIndex) => sessionImageInput(store.getAttachment(sessionId, userTurnIndex, attachmentIndex)),
  };
}

/** The session side table's image as run input: a local path, embedded bytes, or a URL. */
export function sessionImageInput(stored: { mediaType: string; data?: string; url?: string; path?: string } | undefined): ImageInput | undefined {
  if (!stored) { return undefined; }
  if (stored.path) { return { path: stored.path, mediaType: stored.mediaType }; }
  if (stored.data) { return { data: stored.data, mediaType: stored.mediaType }; }
  return stored.url ? { url: stored.url, mediaType: stored.mediaType } : undefined;
}

export function earlierImageContext(images: EarlierRunImage[] | undefined): string[] {
  if (!images?.length) { return []; }
  return [
    'Earlier images in this conversation (not loaded; inspect one by ID with inspect_attachment only when the user refers to it):',
    ...images.map(image => `- ${image.id}: ${image.ref.mediaType}, attached with "${image.ref.turn}"`),
  ];
}

/** Load and stage an earlier image once; later inspections reuse it. */
export async function openEarlierImage(workspace: RunWorkspace, image: EarlierRunImage): Promise<StagedRunAttachment | undefined> {
  if (image.staged) { return image.staged; }
  let input: ImageInput | undefined;
  try { input = await image.load(); } catch { return undefined; }
  if (!input) { return undefined; }
  try { image.staged = stageRunImages(workspace, [input])[0]; } catch { return undefined; }
  return image.staged;
}
