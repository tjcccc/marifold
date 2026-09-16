import { expect, it, vi } from 'vitest';
import { createApiClient } from '../../src/api/client';
import { artifactPreviewBlob } from '../../src/lib/artifactPreviewCache';

const artifact = { id: 'image', name: 'picture.png', size: 6_000_000, mediaType: 'image/png' };
const preview = () => new Blob(['preview'], { type: 'image/webp' });

it('reuses bytes across opens and deduplicates overlapping requests', async () => {
  const client = createApiClient();
  let finish!: (blob: Blob) => void;
  const fetch = vi.spyOn(client, 'blob').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = artifactPreviewBlob(client, 'run', artifact, 'viewer');
  const second = artifactPreviewBlob(client, 'run', artifact, 'viewer');
  expect(first).toBe(second);
  const bytes = preview(); finish(bytes);
  expect(await first).toBe(bytes);
  expect(await artifactPreviewBlob(client, 'run', artifact, 'viewer')).toBe(bytes);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/runs/run/artifacts/image/preview?variant=viewer');
});

it('separates connection identities, runs, variants and changed artifact metadata', async () => {
  const client = createApiClient({ workspaceId: 'home', token: 'first' });
  const fetch = vi.spyOn(client, 'blob').mockResolvedValue(preview());
  await artifactPreviewBlob(client, 'run', artifact, 'viewer');
  await artifactPreviewBlob(client, 'other-run', artifact, 'viewer');
  await artifactPreviewBlob(client, 'run', artifact, 'thumbnail');
  await artifactPreviewBlob(client, 'run', { ...artifact, size: 123 }, 'viewer');
  expect(fetch).toHaveBeenCalledTimes(4);
  const otherClient = createApiClient({ workspaceId: 'home', token: 'second' });
  const otherFetch = vi.spyOn(otherClient, 'blob').mockResolvedValue(preview());
  await artifactPreviewBlob(otherClient, 'run', artifact, 'viewer');
  expect(otherFetch).toHaveBeenCalledOnce();
});

it('allows retry after missing, failed or invalid responses and ignores known-unavailable entries', async () => {
  const client = createApiClient();
  const fetch = vi.spyOn(client, 'blob').mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Blob(['bad'], { type: 'text/html' }))
    .mockResolvedValue(preview());
  for (let attempt = 0; attempt < 3; attempt++) await expect(artifactPreviewBlob(client, 'run', artifact, 'viewer')).rejects.toThrow();
  await artifactPreviewBlob(client, 'run', artifact, 'viewer');
  await expect(artifactPreviewBlob(client, 'run', { ...artifact, available: false }, 'viewer')).rejects.toThrow('no longer available');
  await artifactPreviewBlob(client, 'run', artifact, 'viewer');
  expect(fetch).toHaveBeenCalledTimes(5);
});

it.each([7, 1_000_000])('evicts old entries to bound count and memory with %i-byte previews', async size => {
  const client = createApiClient();
  const fetch = vi.spyOn(client, 'blob').mockResolvedValue(new Blob([new Uint8Array(size)], { type: 'image/webp' }));
  const count = size === 7 ? 32 : 16;
  for (let index = 0; index < count; index++) await artifactPreviewBlob(client, `run-${index}`, artifact, 'viewer');
  // Refresh run-0, then ensure the oldest other entry is evicted.
  await artifactPreviewBlob(client, 'run-0', artifact, 'viewer');
  await artifactPreviewBlob(client, 'new-run', artifact, 'viewer');
  await artifactPreviewBlob(client, 'run-0', artifact, 'viewer');
  expect(fetch).toHaveBeenCalledTimes(count + 1);
  await artifactPreviewBlob(client, 'run-1', artifact, 'viewer');
  expect(fetch).toHaveBeenCalledTimes(count + 2);
});
