// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelegramChannelView } from '../../src/api/types';
import { TelegramPage } from '../../src/screens/config/TelegramPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TelegramPage', () => {
  it('shows poll health, allows an ignored sender, and saves a token without showing it', async () => {
    let view: TelegramChannelView = {
      configured: true,
      enabled: true,
      profile: 'messenger',
      allowlist: [],
      token: { source: 'config' },
      state: 'polling',
      bridge: {
        polling: true,
        busy: false,
        lastPollAt: '2026-10-28T08:00:00Z',
        pollError: { message: 'fetch failed (ETIMEDOUT)', since: '2026-10-28T08:01:00Z' },
        ignoredSenders: [{ id: 790880904, name: 'seesaw game', username: 'tjcccc', at: '2026-10-28T08:02:00Z' }],
      },
    };
    const request = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (path === '/v1/profiles') { return { profiles: [{ name: 'messenger' }, { name: 'default' }] }; }
      if (method === 'PATCH') {
        view = { ...view, ...(body?.allowlist ? { allowlist: body.allowlist as number[] } : {}) };
      }
      if (path === '/v1/channels/telegram/test') { return { ok: true, userId: body?.userId }; }
      return { telegram: view };
    });
    render(<TelegramPage client={{ request } as never} />);

    expect(await screen.findByText(/Can't reach Telegram since .*fetch failed \(ETIMEDOUT\)/)).toBeTruthy();
    expect(screen.getByText('seesaw game · @tjcccc')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByText('790880904')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('PATCH', '/v1/channels/telegram', { allowlist: [790880904] });
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();

    const tokenInput = screen.getByLabelText('Bot token') as HTMLInputElement;
    expect(tokenInput.value).toBe('');
    fireEvent.change(tokenInput, { target: { value: '123:abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('PATCH', '/v1/channels/telegram', { botToken: '123:abc' }));
    await vi.waitFor(() => expect(tokenInput.value).toBe(''));

    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }));
    expect(await screen.findByText('Test message sent to 790880904.')).toBeTruthy();
  });
});
