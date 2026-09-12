// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MarifoldApiError, type ApiClient } from '../../src/api/client';
import { useWorkspaceChangePublisher, useWorkspaceChanges } from '../../src/state/workspaceChanges';

afterEach(() => vi.useRealTimers());

it('reloads views after an interruption even when the host revision is unchanged', async () => {
  vi.useFakeTimers();
  const request = vi.fn()
    .mockResolvedValueOnce({ revision: 'same' })
    .mockRejectedValueOnce(new MarifoldApiError(503, { code: 'WORKSPACE_OFFLINE', message: 'offline' }))
    .mockResolvedValue({ revision: 'same' });
  const client = { baseUrl: '/workspace', request } as unknown as ApiClient;
  const available = vi.fn();
  const changed = vi.fn();
  const view = renderHook(() => {
    useWorkspaceChangePublisher(client, available);
    useWorkspaceChanges(client, changed);
  });
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(available).toHaveBeenLastCalledWith(false);
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(available).toHaveBeenLastCalledWith(true);
  expect(changed).toHaveBeenCalledOnce();
  view.unmount();
});

it('does not label a connected-host request timeout as offline', async () => {
  const client = {
    baseUrl: '/workspace',
    request: vi.fn().mockRejectedValue(new MarifoldApiError(504, { code: 'WORKSPACE_TIMEOUT', message: 'slow request' })),
  } as unknown as ApiClient;
  const available = vi.fn();
  const view = renderHook(() => useWorkspaceChangePublisher(client, available));
  await act(async () => {});
  expect(available).not.toHaveBeenCalledWith(false);
  view.unmount();
});
