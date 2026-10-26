import type { ApiClient } from '../../api/client';
import { sessionAttachmentPath } from '../../api/sessions';
import type { SessionDetail, SessionImageAttachment } from '../../api/types';
import type { PreparedAttachment } from '../../lib/attachments';
import { officeKindForFile, splitInlineTextAttachments } from '../../lib/attachments';
import type { ThreadAction, UserAttachment } from '../../state/thread';

// Conversions between a session's stored attachments and the composer's
// prepared attachments, for loading a transcript and resending an edited turn.

/** A loaded session's turns as the thread shows them: replies with their
 * metrics and speaker, user turns with their images and inlined files. */
export function threadTurns(sessionId: string, turns: SessionDetail['turns']): Extract<ThreadAction, { type: 'session_loaded' }>['turns'] {
  return turns.map(turn => {
    if (turn.role === 'assistant') {
      return {
        role: turn.role,
        content: turn.content,
        ...(turn.responseMetrics ? {
          responseMeta: {
            mode: turn.responseMetrics.mode,
            startedAt: turn.responseMetrics.startedAt,
            finishedAt: turn.responseMetrics.finishedAt,
            latencyMs: turn.responseMetrics.latencyMs,
            usage: turn.responseMetrics.usage,
          },
        } : {}),
        ...(turn.speaker ? { speaker: turn.speaker } : {}),
      };
    }
    const restored = splitInlineTextAttachments(turn.content);
    const attachments: UserAttachment[] = [
      ...toUserAttachments(sessionId, turn.attachments ?? []),
      ...restored.files.map(file => {
        const officeKind = officeKindForFile(file.name);
        return {
          kind: 'text' as const,
          name: file.name,
          content: file.content,
          ...(officeKind ? { officeKind } : {}),
          ...(file.content.includes('[Office extraction truncated to fit the attachment text limit.]')
            ? { truncated: true }
            : {}),
        };
      }),
    ];
    return {
      role: turn.role,
      content: restored.prompt,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  });
}

export function toUserAttachments(sessionId: string, attachments: SessionImageAttachment[]): UserAttachment[] {
  return attachments.flatMap((attachment, index) => {
    const previewUrl = attachment.data
      ? `data:${attachment.mediaType};base64,${attachment.data}`
      : attachment.url;
    const sourcePath = attachment.ref
      ? sessionAttachmentPath(sessionId, attachment.ref.userTurnIndex, attachment.ref.attachmentIndex)
      : undefined;
    return previewUrl || sourcePath
      ? [{
          kind: 'image' as const,
          name: `Image ${index + 1}`,
          ...(previewUrl ? { previewUrl } : {}),
          ...(sourcePath ? { sourcePath } : {}),
        }]
      : [];
  });
}

export async function preparedAttachmentsFromUser(
  items: UserAttachment[] | undefined,
  client: ApiClient,
): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  for (const attachment of items ?? []) {
    // Generic binaries are intentionally scoped to their original agent run;
    // historical resend cannot recover bytes that were never persisted.
    if (attachment.kind === 'file') { continue; }
    if (attachment.kind === 'text') {
      if (attachment.content === undefined) { continue; }
      prepared.push({
        kind: 'text',
        name: attachment.name,
        size: new TextEncoder().encode(attachment.content).length,
        content: attachment.content,
        ...(attachment.officeKind ? { officeKind: attachment.officeKind } : {}),
        ...(attachment.truncated ? { truncated: true } : {}),
      });
      continue;
    }
    let parsed = attachment.previewUrl ? parseImageDataUrl(attachment.previewUrl) : undefined;
    if (!parsed && attachment.sourcePath) {
      const blob = await client.blob(attachment.sourcePath);
      if (blob) { parsed = { mediaType: blob.type || 'image/jpeg', data: await blobToBase64(blob) }; }
    }
    if (!parsed) { continue; }
    const size = base64ByteLength(parsed.data);
    prepared.push({
      kind: 'image' as const,
      name: attachment.name,
      size,
      originalSize: size,
      optimized: false,
      data: parsed.data,
      mediaType: parsed.mediaType,
    });
  }
  return prepared;
}

function parseImageDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
