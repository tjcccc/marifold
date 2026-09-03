import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../src/api/client';
import {
  deleteMemory,
  deleteProfile,
  putProfileFile,
  removeTrustedFolder,
  setProfilePinned,
  updateProfile,
} from '../../src/api/profiles';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('profile write api', () => {
  it('updateProfile PATCHes the dotted route with the patch body', async () => {
    const mock = stubFetch({ ok: true, profile: { name: 'writer' } });
    const client = createApiClient({ baseUrl: 'http://x.test' });
    const profile = await updateProfile(client, 'writer', {
      displayName: 'Writing Partner',
      mode: 'chat',
      approval: { shell: null },
    });
    expect(profile).toMatchObject({ name: 'writer' });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/v1/profiles/writer');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      displayName: 'Writing Partner',
      mode: 'chat',
      approval: { shell: null },
    });
  });

  it('putProfileFile PUTs the content; removeTrustedFolder DELETEs with a body', async () => {
    const mock = stubFetch({ ok: true, profile: { name: 'writer' } });
    const client = createApiClient({ baseUrl: 'http://x.test' });

    await putProfileFile(client, 'writer', 'instructions', '# Instructions');
    let [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/v1/profiles/writer/files/instructions');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ content: '# Instructions' });

    await removeTrustedFolder(client, 'writer', '/tmp/blog');
    [url, init] = mock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://x.test/v1/profiles/writer/trusted-folders');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({ folder: '/tmp/blog' });
  });

  it('deleteMemory targets the entry id with the mode query', async () => {
    const mock = stubFetch({ ok: true, memories: [] });
    const client = createApiClient({ baseUrl: 'http://x.test' });
    const memories = await deleteMemory(client, 'writer', 'mem-1', 'delete');
    expect(memories).toEqual([]);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/v1/profiles/writer/memories/mem-1?mode=delete');
    expect(init.method).toBe('DELETE');
  });

  it('updates profile pin state and removes a profile', async () => {
    const mock = stubFetch({
      ok: true,
      profiles: [{ name: 'writer', source: 'directory', pinned: true }],
    });
    const client = createApiClient({ baseUrl: 'http://x.test' });

    await expect(setProfilePinned(client, 'writer', true)).resolves.toMatchObject([
      { name: 'writer', pinned: true },
    ]);
    let [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x.test/v1/profiles/writer/display');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ pinned: true });

    await deleteProfile(client, 'writer');
    [url, init] = mock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://x.test/v1/profiles/writer');
    expect(init.method).toBe('DELETE');
  });
});
