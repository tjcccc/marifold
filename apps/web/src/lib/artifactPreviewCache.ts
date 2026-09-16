import type { ApiClient } from '../api/client';
import type { RunArtifact } from '../api/types';
import { artifactPath, ArtifactUnavailableError } from './runArtifacts';

type Variant = 'thumbnail' | 'viewer';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 32;
interface Cache {
  entries: Map<string, Blob>;
  pending: Map<string, Promise<Blob>>;
  bytes: number;
}
// Client identity includes the server, bearer token and paired workspace. Blobs
// have no object-URL lifetime; each mounted consumer owns and revokes its URL.
const caches = new WeakMap<ApiClient, Cache>();

export function artifactPreviewBlob(client: ApiClient, runId: string, artifact: RunArtifact, variant: Variant): Promise<Blob> {
  let cache = caches.get(client);
  if (!cache) {
    cache = { entries: new Map(), pending: new Map(), bytes: 0 };
    caches.set(client, cache);
  }
  const key = JSON.stringify([runId, artifact.id, artifact.size, artifact.mediaType, variant]);
  if (artifact.available === false) {
    const previous = cache.entries.get(key);
    if (previous) { cache.bytes -= previous.size; cache.entries.delete(key); }
    return Promise.reject(new ArtifactUnavailableError());
  }
  const hit = cache.entries.get(key);
  if (hit) {
    cache.entries.delete(key);
    cache.entries.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = cache.pending.get(key);
  if (pending) return pending;
  if (cache.pending.size >= MAX_ENTRIES) return Promise.reject(new Error('Image previews are busy. Try again.'));
  const state = cache;
  const request = client.blob(`${artifactPath(runId, artifact.id)}/preview${variant === 'viewer' ? '?variant=viewer' : ''}`)
    .then(blob => {
      if (!blob) throw new ArtifactUnavailableError();
      if (blob.type.split(';')[0] !== 'image/webp' || blob.size > 1_000_000 || blob.size === 0)
        throw new Error('Invalid image preview.');
      while (state.entries.size >= MAX_ENTRIES || state.bytes + blob.size > MAX_BYTES) {
        const oldest = state.entries.keys().next().value!;
        state.bytes -= state.entries.get(oldest)!.size;
        state.entries.delete(oldest);
      }
      state.entries.set(key, blob);
      state.bytes += blob.size;
      return blob;
    }).finally(() => { state.pending.delete(key); });
  state.pending.set(key, request);
  return request;
}
