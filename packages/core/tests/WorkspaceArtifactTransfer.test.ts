import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { artifactReadLength, workspaceArtifactStream } from '../src/workspace/WorkspaceArtifactTransfer';

describe('workspace artifact downloads', () => {
  it.each([false, true])('preserves complete bytes and bounds read-ahead with legacy host=%s', async legacy => {
    const original = randomBytes(2 * 1024 * 1024 + 17);
    let active = 0;
    let peak = 0;
    let calls = 0;
    const chunks: Buffer[] = [];
    for await (const bytes of workspaceArtifactStream(original.length, async (offset, length) => {
      calls++;
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, offset % 3));
      active--;
      return {
        data: original.subarray(offset, offset + (legacy ? Math.min(length, 32768) : length)).toString('base64'),
        size: original.length,
      };
    })) chunks.push(bytes);
    expect(Buffer.concat(chunks)).toEqual(original);
    expect(peak).toBe(4);
    expect(calls).toBe(Math.ceil(original.length / (legacy ? 32768 : 131072)));
  });

  it('stops fetching after the consumer closes and handles pending failures', async () => {
    let calls = 0;
    const stream = workspaceArtifactStream(2 * 1024 * 1024, async offset => {
      calls++;
      if (offset > 131072) throw new Error('Disconnected');
      return { data: Buffer.alloc(131072).toString('base64'), size: 2 * 1024 * 1024 };
    });
    await stream.next();
    await stream.next();
    await stream.return();
    expect(calls).toBe(5);
  });

  it('rejects changed sizes, truncated chunks and invalid read lengths', async () => {
    const stream = workspaceArtifactStream(200000, async offset => ({
      data: Buffer.alloc(offset ? 1 : 131072).toString('base64'), size: 200000,
    }));
    await stream.next();
    await expect(stream.next()).rejects.toThrow('transfer ended early');
    await expect(workspaceArtifactStream(2, async () => ({ data: 'YQ==', size: 3 })).next())
      .rejects.toThrow('changed');
    expect(artifactReadLength(undefined)).toBe(32768);
    expect(artifactReadLength(131072)).toBe(131072);
    for (const length of [0, -1, 131073, 1.5, '100']) expect(() => artifactReadLength(length)).toThrow();
  });
});
