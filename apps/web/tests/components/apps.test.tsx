// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, StreamInit } from '../../src/api/client';
import type { AppDefinition } from '../../src/api/types';
import { ResizableSidebar } from '../../src/components/ResizableSidebar';
import { AppsSidebar, AppsSidebarContent } from '../../src/screens/apps/AppsSidebar';
import { AppsScreen } from '../../src/screens/apps/AppsScreen';
import { useAppsCatalog } from '../../src/screens/apps/useAppsCatalog';
import { ProfileSidebarContent } from '../../src/screens/agent/ProfileSidebar';
import { WorkspaceSidebar } from '../../src/screens/agent/WorkspaceSidebar';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

const noop = () => {};

const translator: AppDefinition = {
  schema: 'marifold.app.v0',
  app: {
    name: 'translator',
    title: 'Marifold Translation',
    version: '1.0.0',
    description: 'Translate focused text.',
  },
  actors: [{
    name: 'translator',
    profile: 'app_tester',
  }],
  variables: [
    {
      name: 'source_text',
      type: 'string',
      role: 'input',
      label: 'Source text',
      required: true,
    },
    {
      name: 'target_language',
      type: 'enum',
      role: 'input',
      label: 'Translate to',
      default: 'English',
      options: ['English', 'Japanese'],
    },
    {
      name: 'translated_text',
      type: 'string',
      role: 'output',
      label: 'Translation',
    },
  ],
  layout: [
    {
      component: 'row',
      children: [
        { component: 'select', bind: 'target_language', showLabel: false, grow: true },
      ],
    },
    {
      component: 'row',
      responsive: 'stack',
      children: [
        { component: 'textarea', bind: 'source_text', grow: true },
        { component: 'preview', bind: 'translated_text', format: 'markdown', grow: true },
      ],
    },
    {
      component: 'row',
      children: [
        { component: 'spacer' },
        { component: 'button', action: 'translate', label: 'Translate' },
        { component: 'spacer' },
      ],
    },
  ],
  actions: [{
    name: 'translate',
    kind: 'skill',
    actor: 'translator',
    skill: 'translate',
    arguments: {
      source_text: '{{source_text}}',
      target_language: '{{target_language}}',
    },
    output: 'translated_text',
  }],
  execution: {
    think: false,
    memory: false,
    profileContext: false,
  },
  permissions: {
    providerCalls: true,
    files: 'none',
    shell: false,
    network: false,
    export: false,
  },
};

function AppsHarness({ client }: { client: ApiClient }) {
  const catalog = useAppsCatalog(client, noop);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <ResizableSidebar ariaLabel="Resize Apps sidebar">
        <AppsSidebar
          client={client}
          apps={catalog.apps}
          selected={catalog.selectedName}
          busy={busy}
          loading={catalog.loading}
          onSelect={catalog.select}
        />
      </ResizableSidebar>
      <AppsScreen
        client={client}
        onUnauthorized={noop}
        app={catalog.selected}
        loading={catalog.loading}
        loadError={catalog.error}
        onBusyChange={setBusy}
      />
    </div>
  );
}

describe('AppsScreen', () => {
  it('renders a normalized App and streams its output with metrics', async () => {
    const request = vi.fn(async () => ({ ok: true, apps: [translator] }));
    const stream = vi.fn(async (_path: string, _init?: StreamInit) => new Response([
      'event: chunk\ndata: {"text":"おはよう"}\n\n',
      'event: done\ndata: {"latencyMs":1800,"usage":{"totalTokens":44}}\n\n',
    ].join(''), { status: 200 }));
    const client: ApiClient = {
      baseUrl: '',
      request: request as ApiClient['request'],
      stream,
      blob: async () => undefined,
    };

    render(<AppsHarness client={client} />);
    expect(await screen.findByRole('heading', { name: 'Marifold Translation' })).toBeTruthy();
    expect(request).toHaveBeenCalledWith('GET', '/v1/apps');
    expect(screen.getByLabelText('Marifold')).toBeTruthy();
    const appSearch = screen.getByLabelText('Search apps') as HTMLInputElement;
    fireEvent.change(appSearch, { target: { value: 'missing app' } });
    expect(screen.getByText('No matching apps.')).toBeTruthy();
    fireEvent.keyDown(appSearch, { key: 'Escape' });
    expect(appSearch.value).toBe('');
    const separator = screen.getByRole('separator', { name: 'Resize Apps sidebar' });
    expect(separator.getAttribute('aria-valuenow')).toBe('256');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(localStorage.getItem('marifold.sidebarWidth')).toBe('264');
    expect(screen.getByText('Translate to').className).toContain('visuallyHidden');

    fireEvent.change(screen.getByLabelText('Source text'), { target: { value: 'Good morning' } });
    fireEvent.change(screen.getByLabelText('Translate to'), { target: { value: 'Japanese' } });
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }));

    expect(await screen.findByText('おはよう')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('1.8s · 44 tokens')).toBeTruthy());
    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0][0]).toBe('/v1/apps/translator/actions/translate/stream');
    expect(stream.mock.calls[0][1]?.body).toMatchObject({
      values: {
        source_text: 'Good morning',
        target_language: 'Japanese',
      },
    });
    expect(stream.mock.calls[0][1]?.body).not.toHaveProperty('profile');
    expect(stream.mock.calls[0][1]?.body).not.toHaveProperty('sessionId');
    expect(stream.mock.calls[0][1]?.body).not.toHaveProperty('prompt');
    expect(stream.mock.calls[0][1]?.body).not.toHaveProperty('execution');
  });

  it('swaps only the catalog body while keeping shared sidebar chrome mounted', () => {
    const client: ApiClient = {
      baseUrl: '',
      request: async () => {
        throw new Error('Unexpected request');
      },
      stream: async () => new Response(),
      blob: async () => undefined,
    };
    const footer = <button type="button">Connection</button>;
    const { rerender } = render(
      <WorkspaceSidebar ariaLabel="Profiles" footer={footer} showBrand>
        <ProfileSidebarContent
          client={client}
          profiles={[{ name: 'default', source: 'directory' }]}
          onSelect={noop}
        />
      </WorkspaceSidebar>,
    );
    const sidebar = screen.getByRole('navigation', { name: 'Profiles' });
    const brand = screen.getByLabelText('Marifold');
    const connection = screen.getByRole('button', { name: 'Connection' });

    rerender(
      <WorkspaceSidebar ariaLabel="Apps" footer={footer} showBrand>
        <AppsSidebarContent
          client={client}
          apps={[translator]}
          selected="translator"
          onSelect={noop}
        />
      </WorkspaceSidebar>,
    );

    expect(screen.getByRole('navigation', { name: 'Apps' })).toBe(sidebar);
    expect(screen.getByLabelText('Marifold')).toBe(brand);
    expect(screen.getByRole('button', { name: 'Connection' })).toBe(connection);
    expect(screen.getByLabelText('Search apps')).toBeTruthy();
  });
});
