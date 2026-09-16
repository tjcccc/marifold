// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createApiClient } from '../../src/api/client';
import { artifactAccessUrl, downloadRunArtifact } from '../../src/lib/runArtifacts';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('hands a guest-local HTTP URL to the browser without fetching file bytes or exposing the bearer token', async () => {
  const path = '/v1/downloads/' + 'a'.repeat(48);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ path })));
  vi.stubGlobal('fetch', fetch);
  const client = createApiClient({ baseUrl: 'http://localhost:32140', workspaceId: 'home', token: 'private-bearer' });
  const create = vi.spyOn(URL, 'createObjectURL');
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.isConnected).toBe(true);
    expect(this.download).toBe('home-desktop.png');
    expect(this.href).toBe('http://localhost:32140' + path);
    expect(this.href).not.toContain('private-bearer');
  });
  await downloadRunArtifact(client, 'host-run', { id: 'image', name: 'home-desktop.png', mediaType: 'image/png', size: 6000000 });
  expect(fetch).toHaveBeenCalledExactlyOnceWith('http://localhost:32140/v1/workspaces/home/api/v1/runs/host-run/artifacts/image/access', expect.objectContaining({
    method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer private-bearer' }), body: JSON.stringify({ purpose: 'download' }),
  }));
  expect(click).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  expect(document.querySelector('a[download]')).toBeNull();
});

it.each(['https://attacker.example/file', '//attacker.example/file', '/v1/config'])('rejects an unexpected access URL %s', async path => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ path }))));
  await expect(artifactAccessUrl(createApiClient(), 'run', { id: 'file', name: 'file.txt', mediaType: 'text/plain', size: 1 }, 'download')).rejects.toThrow('Invalid file download URL');
});
