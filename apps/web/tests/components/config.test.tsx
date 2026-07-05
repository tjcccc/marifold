// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryEntry, ProfileDetail } from '../../src/api/types';
import { ProfileSettingsPage } from '../../src/screens/config/ProfileSettingsPage';

afterEach(cleanup);

const detail: ProfileDetail = {
  name: 'writer',
  source: 'directory',
  settings: {
    memories: true,
    mode: 'agent',
    think: true,
    provider: 'ollama',
    model: 'gemma4:e4b',
    agent: { approval: { shell: 'deny' }, trustedFolders: ['/Users/me/blog'] },
  },
  files: {
    profile: { content: 'You are a writing assistant.' },
    rules: { content: 'Be concise.' },
    custom: { content: '' },
    profileToml: { content: 'mode = "agent"' },
  },
};

const memory: MemoryEntry = {
  id: 'mem_1',
  kind: 'preferences',
  text: 'Prefers en dashes over em dashes.',
  priority: 1,
  confidence: 0.9,
  stability: 'stable',
  status: 'active',
  source: 'chat',
  source_type: 'model',
  scope: 'profile',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  last_seen_at: '2026-07-01T00:00:00Z',
};

describe('ProfileSettingsPage', () => {
  it('renders identity, model, memory entries, and resolved permissions', () => {
    render(<ProfileSettingsPage detail={detail} memories={[memory]} />);
    expect(screen.getByText('writer')).toBeTruthy();
    expect(screen.getByText(/mode agent/)).toBeTruthy();
    expect(screen.getByText('ollama/gemma4:e4b')).toBeTruthy();
    expect(screen.getByText('Prefers en dashes over em dashes.')).toBeTruthy();

    // All five action kinds render; the profile's shell=deny override wins.
    for (const label of ['Read files', 'Write & edit files', 'Run shell commands', 'Search the web', 'Ask another profile']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    const shellRow = screen.getByText('Run shell commands').parentElement!;
    const selected = shellRow.querySelector('[class*="segmentSelected"]');
    expect(selected?.textContent).toBe('Deny');

    expect(screen.getByText('/Users/me/blog')).toBeTruthy();
  });
});
