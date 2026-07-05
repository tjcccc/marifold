// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfilePatchInput } from '../../src/api/profiles';
import type { MemoryEntry, ProfileDetail } from '../../src/api/types';
import { ProfileSettingsPage } from '../../src/screens/config/ProfileSettingsPage';
import type { ProfileSettingsPageProps } from '../../src/screens/config/ProfileSettingsPage';

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

function renderPage(overrides: Partial<ProfileSettingsPageProps> = {}) {
  const handlers = {
    onPatch: vi.fn<(patch: ProfilePatchInput) => void>(),
    onSaveFile: vi.fn(),
    onAddTrustedFolder: vi.fn(),
    onRemoveTrustedFolder: vi.fn(),
    onMemoryAction: vi.fn(),
  };
  render(
    <ProfileSettingsPage
      detail={detail}
      memories={[memory]}
      modelOptions={['ollama/gemma4:e4b', 'ollama/codellama']}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('ProfileSettingsPage', () => {
  it('renders identity, model, memory entries, and resolved permissions', () => {
    renderPage();
    expect(screen.getByText('writer')).toBeTruthy();
    expect(screen.getByText('Prefers en dashes over em dashes.')).toBeTruthy();

    // The model select shows the override.
    const select = screen.getByLabelText('Model override') as HTMLSelectElement;
    expect(select.value).toBe('ollama/gemma4:e4b');

    // All five action kinds render; the profile's shell=deny override wins
    // (the selected segment inside the shell row's segmented control).
    for (const label of ['Read files', 'Write & edit files', 'Run shell commands', 'Search the web', 'Ask another profile']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    const shellControl = screen.getByLabelText('Run shell commands approval');
    const selected = shellControl.querySelector('[aria-selected="true"]');
    expect(selected?.textContent).toBe('Deny');

    expect(screen.getByText('/Users/me/blog')).toBeTruthy();
  });

  it('clicking a permission segment patches the profile override', () => {
    const handlers = renderPage();
    const readControl = screen.getByLabelText('Read files approval');
    fireEvent.click(Array.from(readControl.querySelectorAll('button')).find(b => b.textContent === 'Deny')!);
    expect(handlers.onPatch).toHaveBeenCalledWith({ approval: { read: 'deny' } });
  });

  it('an overridden kind offers an inherit reset that patches null', () => {
    const handlers = renderPage();
    fireEvent.click(screen.getByText('overridden — inherit'));
    expect(handlers.onPatch).toHaveBeenCalledWith({ approval: { shell: null } });
  });

  it('toggling memories and picking Default model clear/set via onPatch', () => {
    const handlers = renderPage();
    const memoriesControl = screen.getByLabelText('Memories');
    fireEvent.click(Array.from(memoriesControl.querySelectorAll('button')).find(b => b.textContent === 'Off')!);
    expect(handlers.onPatch).toHaveBeenCalledWith({ memories: false });

    const select = screen.getByLabelText('Model override') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    expect(handlers.onPatch).toHaveBeenCalledWith({ provider: null, model: null });
  });

  it('file editor Save sends the edited content; Revert restores', () => {
    const handlers = renderPage();
    const textarea = screen.getByLabelText('RULES content') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Be VERY concise.' } });
    const editor = textarea.closest('details')!;
    fireEvent.click(Array.from(editor.querySelectorAll('button')).find(b => b.textContent === 'Save')!);
    expect(handlers.onSaveFile).toHaveBeenCalledWith('rules', 'Be VERY concise.');

    fireEvent.change(textarea, { target: { value: 'scratch' } });
    fireEvent.click(Array.from(editor.querySelectorAll('button')).find(b => b.textContent === 'Revert')!);
    expect((screen.getByLabelText('RULES content') as HTMLTextAreaElement).value).toBe('Be concise.');
  });

  it('memory Forget fires immediately; trusted-folder add and remove call handlers', () => {
    const handlers = renderPage();
    fireEvent.click(screen.getByText('Forget'));
    expect(handlers.onMemoryAction).toHaveBeenCalledWith('mem_1', 'forget');

    fireEvent.change(screen.getByLabelText('New trusted folder'), { target: { value: '/tmp/notes' } });
    fireEvent.click(screen.getByText('Add'));
    expect(handlers.onAddTrustedFolder).toHaveBeenCalledWith('/tmp/notes');

    fireEvent.click(screen.getByText('Remove'));
    expect(handlers.onRemoveTrustedFolder).toHaveBeenCalledWith('/Users/me/blog');
  });
});
