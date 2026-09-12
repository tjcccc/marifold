const DOWNLOAD_CHUNK = 128 * 1024;

export function artifactReadLength(value: unknown): number {
  if (value === undefined) return 32 * 1024;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > DOWNLOAD_CHUNK)
    throw new Error('Invalid artifact read length.');
  return value;
}

export interface ArtifactChunk {
  data: string;
  size: number;
}

/** Ordered, bounded read-ahead; the first response also detects older 32 KiB readers. */
export async function* workspaceArtifactStream(
  size: number,
  read: (offset: number, length: number) => Promise<ArtifactChunk>,
): AsyncGenerator<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid artifact size.');
  if (size === 0) return;
  const decode = (chunk: ArtifactChunk, expected: number, initial = false): Buffer => {
    const bytes = Buffer.from(chunk.data, 'base64');
    if (chunk.size !== size || bytes.length === 0 || bytes.length > expected ||
      (!initial && bytes.length !== expected)) throw new Error('Artifact changed or transfer ended early.');
    return bytes;
  };
  const first = decode(await read(0, DOWNLOAD_CHUNK), Math.min(size, DOWNLOAD_CHUNK), true);
  yield first;
  const chunkSize = first.length;
  let offset = chunkSize;
  type Result = { bytes: Buffer; error?: never } | { bytes?: never; error: unknown };
  const pending: Array<Promise<Result>> = [];
  while (offset < size || pending.length) {
    while (offset < size && pending.length < 4) {
      const length = Math.min(chunkSize, size - offset);
      pending.push(read(offset, length)
        .then(chunk => ({ bytes: decode(chunk, length) }))
        .catch(error => ({ error })));
      offset += length;
    }
    const result = await pending.shift()!;
    if ('error' in result) throw result.error;
    yield result.bytes;
  }
}
