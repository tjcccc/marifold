import { Readable } from 'node:stream';
import { ArtifactWebRtc, workspaceArtifactStream, type ArtifactChunk } from '@marifold/core';
import type { FastifyReply } from 'fastify';

/** Keep transport choice behind the ordinary authenticated browser download. */
export async function remoteArtifactDownload(
  reply: FastifyReply,
  transfers: ArtifactWebRtc | undefined,
  size: number,
  scope: string,
  request: (input: Record<string, unknown>) => Promise<unknown>,
): Promise<FastifyReply> {
  const abort = new AbortController();
  const closed = () => abort.abort();
  reply.raw.once('close', closed);
  let fallback = 'disabled';
  if (transfers?.enabled) {
    try {
      const stream = await transfers.receive(size, offer => request({ offer }), scope, abort.signal);
      if (abort.signal.aborted) { stream.destroy(); return reply; }
      reply.header('x-marifold-transfer', 'webrtc');
      return reply.send(stream);
    } catch {
      fallback = 'unavailable';
    }
  }
  if (abort.signal.aborted) return reply;
  reply.header('x-marifold-transfer', 'bridge').header('x-marifold-direct-fallback', fallback);
  return reply.send(Readable.from(workspaceArtifactStream(size, (offset, length) =>
    request({ offset, length }) as Promise<ArtifactChunk>)));
}
