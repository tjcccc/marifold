// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ProfileSidebar } from '../../src/screens/agent/ProfileSidebar';

afterEach(cleanup);

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
  { name: 'Research Lab', source: 'directory' as const },
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
});
