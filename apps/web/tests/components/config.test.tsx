// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfilePatchInput } from '../../src/api/profiles';
import type { MemoryEntry, ProfileDetail } from '../../src/api/types';
import { ProfileSettingsPage } from '../../src/screens/config/ProfileSettingsPage';
import type { ProfileSettingsPageProps } from '../../src/screens/config/ProfileSettingsPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it('requires the profile name in a second confirmation dialog before removal', () => {
    const onDelete = vi.fn();
    const { unmount } = render(
      <ProfileSettingsPage
        detail={detail}
        memories={[]}
        modelOptions={[]}
        onPatch={() => {}}
        onSaveFile={() => {}}
        onAddTrustedFolder={() => {}}
        onRemoveTrustedFolder={() => {}}
        onMemoryAction={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove profile' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove “writer”?' });
    const finalRemove = within(dialog).getByRole('button', { name: 'Remove profile' }) as HTMLButtonElement;
    expect(finalRemove.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Profile name confirmation'), {
      target: { value: 'writer' },
    });
    expect(finalRemove.disabled).toBe(false);
    fireEvent.click(finalRemove);
    expect(onDelete).toHaveBeenCalled();
    unmount();

    render(
      <ProfileSettingsPage
        detail={detail}
        memories={[]}
        modelOptions={[]}
        onPatch={() => {}}
        onSaveFile={() => {}}
        onAddTrustedFolder={() => {}}
        onRemoveTrustedFolder={() => {}}
        onMemoryAction={() => {}}
        onDelete={() => {}}
        deleteDisabledReason="Choose another default profile first."
      />,
    );
    expect((screen.getByRole('button', { name: 'Remove profile' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose another default profile first.')).toBeTruthy();
  });
});

describe('ModelsPage', () => {
  it('lists options with the default tag and dispatches remove/add/default', async () => {
    const { ModelsPage } = await import('../../src/screens/config/ModelsPage');
    const onRemove = vi.fn(async () => {});
    const onSetDefault = vi.fn(async () => {});
    const client = {
      baseUrl: '',
      request: async () => ({ provider: 'ollama', reachable: true, models: ['gemma4:e4b'], message: '' }),
      stream: async () => { throw new Error('unused'); },
      blob: async () => undefined,
    };
    render(
      <ModelsPage
        client={client as never}
        models={{ default: { provider: 'ollama', model: 'gemma4:e4b' }, options: ['ollama/gemma4:e4b', 'chatgpt/gpt-5.4-mini'] }}
        providers={['ollama', 'chatgpt']}
        busy={false}
        onSetDefault={onSetDefault}
        onRemove={onRemove}
        onAdd={async () => {}}
      />,
    );
    expect(screen.getByText('default')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove chatgpt/gpt-5.4-mini'));
    expect(onRemove).toHaveBeenCalledWith('chatgpt', 'gpt-5.4-mini');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'chatgpt/gpt-5.4-mini' } });
    expect(onSetDefault).toHaveBeenCalledWith('chatgpt', 'gpt-5.4-mini');
  });
});

describe('ProvidersPage', () => {
  it('shows a per-provider proxy and saves it as the providers.<name>.proxy key', async () => {
    const { ProvidersPage } = await import('../../src/screens/config/ProvidersPage');
    const onSaveField = vi.fn();
    const config = {
      default: { profile: 'default' },
      models: { options: [] },
      providers: {
        xai: { type: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', proxy: 'http://127.0.0.1:7890' },
      },
    };
    render(
      <ProvidersPage
        selected="xai"
        config={config as never}
        status={[]}
        busy={false}
        onSaveField={onSaveField}
        onRefreshStatus={() => {}}
        onAddProvider={async () => {}}
      />,
    );
    const proxyInput = screen.getByPlaceholderText(/blank = direct/) as HTMLInputElement;
    expect(proxyInput.value).toBe('http://127.0.0.1:7890');
    // Editing + Save must produce the providers.<name>.proxy wire key, trimmed.
    fireEvent.change(proxyInput, { target: { value: '  http://127.0.0.1:1080  ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onSaveField).toHaveBeenCalledWith('xai', 'proxy', 'http://127.0.0.1:1080');
  });
});

describe('Global settings pages', () => {
  it('updates agent approval defaults and execution mode', async () => {
    const { AgentDefaultsPage } = await import('../../src/screens/config/AgentDefaultsPage');
    const onSave = vi.fn();
    render(
      <AgentDefaultsPage
        agent={{
          approval: { read: 'allow', write: 'ask', shell: 'ask', network: 'ask', delegate: 'allow' },
          trustedFolders: [],
          maxIterations: 20,
          toolOutputLimit: 100000,
          toolMode: 'auto',
        }}
        busy={false}
        onSave={onSave}
      />,
    );
    const readApproval = screen.getByLabelText('Read files approval');
    fireEvent.click([...readApproval.querySelectorAll('button')].find(button => button.textContent === 'Deny')!);
    expect(onSave).toHaveBeenCalledWith('approval.read', 'deny');
    fireEvent.change(screen.getByLabelText('Tool-call mode'), { target: { value: 'native' } });
    expect(onSave).toHaveBeenCalledWith('tool_mode', 'native');
  });

  it('updates web-search provider and keeps inline keys secret-only', async () => {
    const { WebSearchPage } = await import('../../src/screens/config/WebSearchPage');
    const onSave = vi.fn();
    render(
      <WebSearchPage
        search={{
          enabled: false,
          maxResults: 5,
          provider: 'duckduckgo',
          hasApiKey: true,
        }}
        busy={false}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'firecrawl' } });
    expect(onSave).toHaveBeenCalledWith('provider', 'firecrawl');
    expect(screen.getByText(/configured/).textContent).not.toContain('test-secret');
  });
});

describe('ServicePage', () => {
  it('shows the sanitized service view and saves edited fields', async () => {
    const { ServicePage } = await import('../../src/screens/config/ServicePage');
    const onSave = vi.fn();
    render(
      <ServicePage
        service={{ webDir: '/srv/web', corsOrigins: ['http://localhost:5173'], hasToken: true }}
        busy={false}
        onSave={onSave}
      />,
    );
    expect(screen.getByText('configured')).toBeTruthy();
    const webDir = screen.getByPlaceholderText('/path/to/apps/web/dist') as HTMLInputElement;
    expect(webDir.value).toBe('/srv/web');
    fireEvent.change(webDir, { target: { value: '/srv/web2' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith('web_dir', '/srv/web2');
  });
});
