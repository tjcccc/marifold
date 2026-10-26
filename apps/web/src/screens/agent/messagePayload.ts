import type { RunFileInput } from '../../api/types';
import type { PreparedAttachment } from '../../lib/attachments';
import { fileToBase64, inlineTextAttachments, modelPromptWithAttachments } from '../../lib/attachments';
import type { UserAttachment } from '../../state/thread';

export interface MessagePayload {
  images: Array<{ data: string; mediaType: string }>;
  files: RunFileInput[];
  /** What the model receives. */
  prompt: string;
  /** The saved user turn when it differs from the prompt (hidden file markers). */
  durableUserTurn?: string;
  /** What the message bubble shows for its attachments. */
  bubbleAttachments: UserAttachment[];
}

/** A message's attachments as a request carries them: chat images ride the
 * request natively and readable text is inlined for chat parity; every agent
 * upload is staged read-only for inspect_attachment. */
export async function messagePayload(
  pending: PreparedAttachment[],
  input: { text: string; mode: 'agent' | 'chat'; skillPrompt?: string; originalImages?: boolean },
): Promise<MessagePayload> {
  const imageAttachments = pending.filter(
    (item): item is Extract<PreparedAttachment, { kind: 'image' }> => item.kind === 'image',
  );
  const images = await Promise.all(imageAttachments.map(async item => (
    input.originalImages && item.originalFile
      ? { data: await fileToBase64(item.originalFile), mediaType: item.originalFile.type || item.mediaType }
      : { data: item.data, mediaType: item.mediaType }
  )));
  const textFiles = pending.filter(
    (item): item is Extract<PreparedAttachment, { kind: 'text' }> => item.kind === 'text',
  );
  const stagedAttachments = pending.filter(item => item.kind !== 'image');
  const files: RunFileInput[] = await Promise.all(stagedAttachments.map(async item => {
    if (item.kind === 'file') {
      return {
        name: item.name,
        mediaType: item.mediaType,
        data: await fileToBase64(item.originalFile),
      };
    }
    const source = item.originalFile ?? new Blob([item.content], { type: item.mediaType || 'text/plain' });
    return {
      name: item.name,
      mediaType: item.mediaType || source.type || 'text/plain',
      data: await fileToBase64(source),
      inspectionText: item.content,
    };
  }));
  // Chat has no local attachment tools, so readable files remain inline for
  // parity. Agent runs stage every file behind bounded attachment tools;
  // inlining the same document here would duplicate it in model context
  // and defeats lazy handling for large Office/text inputs.
  const prompt = modelPromptWithAttachments(input.skillPrompt ?? input.text, textFiles, input.mode);
  // Keep the existing durable hidden attachment markers for historical
  // edit/resend without putting them in the current Agent model request.
  const durableUserTurn = input.mode === 'agent' && input.skillPrompt === undefined && textFiles.length > 0
    ? inlineTextAttachments(input.text, textFiles)
    : undefined;
  const bubbleAttachments: UserAttachment[] = pending.map(item => {
    if (item.kind === 'image') {
      return { kind: 'image', name: item.name, previewUrl: `data:${item.mediaType};base64,${item.data}` };
    }
    if (item.kind === 'file') { return { kind: 'file', name: item.name }; }
    return {
      kind: 'text',
      name: item.name,
      content: item.content,
      ...(item.officeKind ? { officeKind: item.officeKind } : {}),
      ...(item.truncated ? { truncated: true } : {}),
    };
  });
  return { images, files, prompt, ...(durableUserTurn !== undefined ? { durableUserTurn } : {}), bubbleAttachments };
}
