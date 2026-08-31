// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfilePatchInput } from '../../src/api/profiles';
import type { MemoryEntry, ProfileDetail } from '../../src/api/types';
import type { Route } from '../../src/lib/route';
import { AddProviderSheet } from '../../src/components/AddProviderSheet';
import { CreateProfileSheet } from '../../src/components/CreateProfileSheet';
import { ProfileSettingsPage } from '../../src/screens/config/ProfileSettingsPage';
import type { ProfileSettingsPageProps } from '../../src/screens/config/ProfileSettingsPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const detail: ProfileDetail = {
  name: 'writer',
  displayName: 'Writing Partner',
  source: 'directory',
  settings: {
    displayName: 'Writing Partner',
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
    expect(screen.getByText('Writing Partner')).toBeTruthy();
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

  it('shows the stable profile name and saves or clears the display-name override', () => {
    const unnamedDetail: ProfileDetail = {
      ...detail,
      displayName: 'writer',
      settings: { ...detail.settings, displayName: undefined },
    };
    const handlers = renderPage({ detail: unnamedDetail });
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('writer');

    fireEvent.change(input, { target: { value: '  Editorial Guide  ' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Profile' })).getByRole('button', { name: 'Save' }));
    expect(handlers.onPatch).toHaveBeenCalledWith({ displayName: 'Editorial Guide' });

    cleanup();
    const clearPatch = vi.fn();
    render(
      <ProfileSettingsPage
        detail={detail}
        memories={[]}
        modelOptions={[]}
        onPatch={clearPatch}
        onSaveFile={() => {}}
        onAddTrustedFolder={() => {}}
        onRemoveTrustedFolder={() => {}}
        onMemoryAction={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Profile' })).getByRole('button', { name: 'Save' }));
    expect(clearPatch).toHaveBeenCalledWith({ displayName: null });
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

describe('CreateProfileSheet', () => {
  it('explains and enforces the profile-name character rules', () => {
    render(
      <CreateProfileSheet
        existingNames={[]}
        modelOptions={[]}
        busy={false}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Letters, numbers, underscores, and hyphens only. No spaces.')).toBeTruthy();
    const input = screen.getByLabelText('Profile name');
    expect(input.getAttribute('aria-describedby')).toBe('new-profile-name-rules');

    fireEvent.change(input, { target: { value: 'my profile' } });
    expect(screen.getByText('Letters, numbers, underscores, and hyphens only.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create profile' }) as HTMLButtonElement).disabled).toBe(true);
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
        onRemoveProvider={() => {}}
      />,
    );
    const proxyInput = screen.getByPlaceholderText(/blank = direct/) as HTMLInputElement;
    expect(proxyInput.value).toBe('http://127.0.0.1:7890');
    // Editing + Save must produce the providers.<name>.proxy wire key, trimmed.
    fireEvent.change(proxyInput, { target: { value: '  http://127.0.0.1:1080  ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onSaveField).toHaveBeenCalledWith('xai', 'proxy', 'http://127.0.0.1:1080');
  });

  it('exposes the model-aware native-search override for Bailian providers', async () => {
    const { ProvidersPage } = await import('../../src/screens/config/ProvidersPage');
    const onSaveField = vi.fn();
    render(
      <ProvidersPage
        selected="bailian"
        config={{
          default: { profile: 'default' },
          models: { options: ['bailian/qwen3.5-plus'] },
          providers: {
            bailian: { type: 'openai-compatible', nativeWebSearch: 'auto' },
          },
        } as never}
        status={[]}
        busy={false}
        onSaveField={onSaveField}
        onRefreshStatus={() => {}}
        onRemoveProvider={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Native web search'), { target: { value: 'chat' } });
    expect(onSaveField).toHaveBeenCalledWith('bailian', 'native_web_search', 'chat');
  });

  it('requires the provider name before removal', async () => {
    const { ProvidersPage } = await import('../../src/screens/config/ProvidersPage');
    const onRemoveProvider = vi.fn();
    render(
      <ProvidersPage
        selected="xai"
        config={{
          default: { profile: 'default', provider: 'ollama', model: 'gemma4:e4b' },
          models: { options: ['xai/grok-4.5'] },
          providers: {
            xai: { type: 'openai-compatible', hasApiKey: true, hasOauthToken: true },
          },
        } as never}
        status={[]}
        busy={false}
        onSaveField={() => {}}
        onRefreshStatus={() => {}}
        onRemoveProvider={onRemoveProvider}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove “xai”?' });
    const finalRemove = within(dialog).getByRole('button', { name: 'Remove provider' }) as HTMLButtonElement;
    expect(finalRemove.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Provider name confirmation'), {
      target: { value: 'xai' },
    });
    expect(finalRemove.disabled).toBe(false);
    fireEvent.click(finalRemove);
    expect(onRemoveProvider).toHaveBeenCalledOnce();
  });

  it('offers the host-local re-authentication command for OAuth providers', async () => {
    const { ProvidersPage } = await import('../../src/screens/config/ProvidersPage');
    render(
      <ProvidersPage
        selected="xai"
        config={{
          default: { profile: 'default', provider: 'ollama', model: 'gemma4:e4b' },
          models: { options: ['xai/grok-4.5'] },
          providers: {
            xai: { type: 'openai-compatible', hasApiKey: true, hasOauthToken: true },
          },
        } as never}
        status={[]}
        busy={false}
        onSaveField={() => {}}
        onRefreshStatus={() => {}}
        onRemoveProvider={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate…' }));
    const dialog = screen.getByRole('dialog', { name: 'Re-authenticate “xai”' });
    expect(within(dialog).getByText('marifold provider reauth xai')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Copy re-authentication command' })).toBeTruthy();
    expect(within(dialog).getByText(/saved model choices are preserved/)).toBeTruthy();
  });
});

describe('AddProviderSheet', () => {
  const catalog = [
    {
      name: 'ollama',
      label: 'Ollama (local)',
      kind: 'local' as const,
      type: 'ollama' as const,
      defaultBaseUrl: 'http://localhost:11434',
    },
    {
      name: 'openai',
      label: 'OpenAI',
      kind: 'api' as const,
      type: 'openai-compatible' as const,
      defaultBaseUrl: 'https://api.openai.com',
      apiKeyEnv: 'OPENAI_API_KEY',
    },
    {
      name: 'custom',
      label: 'Custom OpenAI-compatible endpoint',
      kind: 'api' as const,
      type: 'openai-compatible' as const,
    },
  ];

  it('selects from the CLI catalog, applies defaults, and submits only non-secret setup fields', () => {
    const onSubmit = vi.fn();
    render(
      <AddProviderSheet
        catalog={catalog}
        existingNames={['ollama']}
        busy={false}
        onSubmit={onSubmit}
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Add provider' });
    expect((within(dialog).getByText('Ollama (local)').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByText('OpenAI').closest('button')!);

    const serverUrl = within(dialog).getByLabelText('Server URL') as HTMLInputElement;
    const apiKeyEnv = within(dialog).getByLabelText('API key environment variable') as HTMLInputElement;
    expect(serverUrl.value).toBe('https://api.openai.com');
    expect(apiKeyEnv.value).toBe('OPENAI_API_KEY');
    fireEvent.change(within(dialog).getByLabelText(/Proxy/), { target: { value: '  http://127.0.0.1:7890  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add openai' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKeyEnv: 'OPENAI_API_KEY',
      proxy: 'http://127.0.0.1:7890',
    });
  });

  it('requires custom connection fields and closes with Escape', () => {
    const onClose = vi.fn();
    render(
      <AddProviderSheet
        catalog={catalog}
        existingNames={[]}
        busy={false}
        onSubmit={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('Custom OpenAI-compatible endpoint').closest('button')!);
    expect((screen.getByRole('button', { name: 'Add custom' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('A server URL is required.')).toBeTruthy();
    expect(screen.getByText('An environment-variable name is required.')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ConfigScreen provider creation', () => {
  it('places the add action in the Providers list header and opens the shared catalog', async () => {
    const { ConfigScreen } = await import('../../src/screens/config/ConfigScreen');
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/v1/profiles') return { profiles: [] };
      if (path === '/v1/config') {
        return {
          config: {
            default: { profile: 'default', provider: 'ollama', model: 'gemma4:e4b' },
            models: { options: ['ollama/gemma4:e4b'] },
            providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
          },
        };
      }
      if (path === '/v1/models') {
        return { default: { provider: 'ollama', model: 'gemma4:e4b' }, options: ['ollama/gemma4:e4b'] };
      }
      if (path === '/v1/providers/status') return { providers: [] };
      if (path === '/v1/providers/catalog') {
        return {
          providers: [{
            name: 'openai',
            label: 'OpenAI',
            kind: 'api',
            type: 'openai-compatible',
            defaultBaseUrl: 'https://api.openai.com',
            apiKeyEnv: 'OPENAI_API_KEY',
          }],
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const client = {
      baseUrl: '',
      request,
      stream: async () => { throw new Error('unused'); },
      blob: async () => undefined,
    };

    render(
      <ConfigScreen
        client={client as never}
        route={{ view: 'config', section: 'providers', item: 'ollama' }}
        navigate={() => {}}
        onUnauthorized={() => {}}
        theme="auto"
        onThemeChange={() => {}}
        onOpenConnection={() => {}}
        onOpenSettings={() => {}}
        connectionName="This server"
        onDone={() => {}}
        onOpenAgent={() => {}}
        onOpenApps={() => {}}
      />,
    );

    const add = await screen.findByRole('button', { name: 'Add provider' });
    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Add provider' });
    expect(within(dialog).getByText('OpenAI')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('GET', '/v1/providers/catalog');
  });
});

describe('ConfigScreen mobile navigation', () => {
  it('drills from Settings into list and detail levels with app-style back controls', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(max-width: 899px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const { ConfigScreen } = await import('../../src/screens/config/ConfigScreen');
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/v1/profiles') return { profiles: [] };
      if (path === '/v1/config') {
        return {
          config: {
            default: { profile: 'default', provider: 'ollama', model: 'gemma4:e4b' },
            models: { options: ['ollama/gemma4:e4b'] },
            providers: { ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
          },
        };
      }
      if (path === '/v1/models') {
        return { default: { provider: 'ollama', model: 'gemma4:e4b' }, options: ['ollama/gemma4:e4b'] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const client = {
      baseUrl: '',
      request,
      stream: async () => { throw new Error('unused'); },
      blob: async () => undefined,
    };

    function Harness() {
      const [route, setRoute] = useState<Extract<Route, { view: 'config' }>>({
        view: 'config',
        section: 'profiles',
      });
      return (
        <ConfigScreen
          client={client as never}
          route={route}
          navigate={next => {
            if (next.view === 'config') setRoute(next);
          }}
          onUnauthorized={() => {}}
          theme="auto"
          onThemeChange={() => {}}
          onOpenConnection={() => {}}
          onOpenSettings={() => {}}
          connectionName="This server"
          onDone={() => {}}
          onOpenAgent={() => {}}
          onOpenApps={() => {}}
        />
      );
    }

    render(<Harness />);
    const settings = await screen.findByRole('navigation', { name: 'Config sections' });
    fireEvent.click(within(settings).getByRole('button', { name: 'Profiles' }));
    expect(screen.getByRole('navigation', { name: 'Profiles' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent defaults' }));
    expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeTruthy();
    expect(screen.getByText('Agent defaults')).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText('Fallback provider'), { target: { value: 'firecrawl' } });
    expect(onSave).toHaveBeenCalledWith('provider', 'firecrawl');
    expect(screen.getByText(/configured/).textContent).not.toContain('test-secret');
  });

  it('offers Ollama Cloud as an explicit non-local fallback backend', async () => {
    const { WebSearchPage } = await import('../../src/screens/config/WebSearchPage');
    const onSave = vi.fn();
    render(
      <WebSearchPage
        search={{
          enabled: true,
          maxResults: 5,
          provider: 'ollama',
          apiKeyEnv: 'OLLAMA_API_KEY',
          hasApiKey: false,
        }}
        busy={false}
        onSave={onSave}
      />,
    );

    expect(screen.getByText(/queries leave this machine for ollama.com/i)).toBeTruthy();
    expect(screen.getByPlaceholderText('OLLAMA_API_KEY')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Fallback provider'), { target: { value: 'duckduckgo' } });
    expect(onSave).toHaveBeenCalledWith('provider', 'duckduckgo');
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
