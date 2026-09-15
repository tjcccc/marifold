// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { downloadRunArtifact } from '../../src/lib/runArtifacts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('keeps download bytes alive until the browser has had time to consume them, then releases them', async () => {
  vi.useFakeTimers();
  const blob = new Blob(['screenshot'], { type: 'image/png' });
  const client = { blob: vi.fn(async () => blob) } as unknown as ApiClient;
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:screenshot');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.isConnected).toBe(true);
    expect(this.download).toBe('home-desktop.png');
    expect(this.href).toBe('blob:screenshot');
  });

  await downloadRunArtifact(client, 'host-run', { id: 'image', name: 'home-desktop.png', mediaType: 'image/png', size: blob.size });
  expect(click).toHaveBeenCalledOnce();
  expect(document.querySelector('a[download]')).toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(revoke).not.toHaveBeenCalled();
  await vi.runOnlyPendingTimersAsync();
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:screenshot');
});
