// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ProfileSidebar } from '../../src/screens/agent/ProfileSidebar';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const client: ApiClient = {
  baseUrl: '',
  request: async () => {
    throw new Error('Unexpected request');
  },
  stream: async () => new Response(),
  blob: async () => undefined,
};

const profiles = [
  { name: 'default', source: 'directory' as const },
  {
    name: 'Research Lab',
    source: 'directory' as const,
    preview: 'The latest research response',
    updatedAt: '2026-07-24T08:00:00.000Z',
  },
  { name: 'travel-project', source: 'directory' as const },
];

describe('ProfileSidebar search', () => {
  it('filters profile names case-insensitively and reports no matches', () => {
    render(<ProfileSidebar client={client} profiles={profiles} onSelect={() => {}} />);
    const search = screen.getByLabelText('Search profiles');

    fireEvent.change(search, { target: { value: 'RESEARCH' } });
    expect(screen.getByRole('button', { name: /Research Lab/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /travel-project/ })).toBeNull();

    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No matching profiles.')).toBeTruthy();
  });

  it('moves into the result list with ArrowDown and clears with Escape', () => {
    const onSelect = vi.fn();
    render(<ProfileSidebar client={client} profiles={profiles} onSelect={onSelect} />);
    const search = screen.getByLabelText('Search profiles') as HTMLInputElement;

    fireEvent.change(search, { target: { value: 'travel' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const result = screen.getByRole('button', { name: /travel-project/ });
    expect(document.activeElement).toBe(result);
    fireEvent.click(result);
    expect(onSelect).toHaveBeenCalledWith('travel-project');

    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.value).toBe('');
    expect(screen.getByRole('button', { name: /default/ })).toBeTruthy();
  });

  it('shows recent response previews and exposes Pin and Config actions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-24T10:00:00.000Z'));
    const onSetPinned = vi.fn(async () => true);
    const onConfigure = vi.fn();
    render(
      <ProfileSidebar
        client={client}
        profiles={profiles}
        onSelect={() => {}}
        onSetPinned={onSetPinned}
        onConfigure={onConfigure}
      />,
    );
    expect(screen.getByText('The latest research response')).toBeTruthy();
    const activityTime = screen.getByText('2h ago');
    expect(activityTime.getAttribute('datetime')).toBe('2026-07-24T08:00:00.000Z');
    expect(screen.getAllByText('No recent response')).toHaveLength(2);

    fireEvent.click(screen.getByLabelText('Profile actions for Research Lab'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(onSetPinned).toHaveBeenCalledWith('Research Lab', true));

    fireEvent.click(screen.getByLabelText('Profile actions for Research Lab'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Config' }));
    expect(onConfigure).toHaveBeenCalledWith('Research Lab');
  });
});
