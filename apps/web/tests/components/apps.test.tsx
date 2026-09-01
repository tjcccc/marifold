// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import type { SkillAppDefinition } from '../../src/api/types';
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

const skillTranslator: SkillAppDefinition = {
  schema: 'marifold.skillapp.v1',
  app: {
    name: 'translator',
    title: 'Marifold Translation',
    version: '1.0.0',
    description: 'Translate focused text with a dedicated model.',
  },
  states: [
    { name: 'source', initial: '' },
    { name: 'targetLanguage', initial: 'English' },
    { name: 'result', initial: '' },
  ],
  models: [{
    name: 'translationModel',
    provider: 'ollama',
    model: 'maternion/hy-mt2:1.8b',
    think: false,
  }],
  skills: [{ name: 'translate', result: { kind: 'text', trim: true } }],
  operations: [{
    name: 'translate',
    model: 'translationModel',
    skill: 'translate',
    parameters: { source_text: 'source', target_language: 'targetLanguage' },
    requiredInputs: ['source', 'targetLanguage'],
    output: 'result',
    execution: { memory: false, history: false, profileContext: false },
  }],
  triggers: [],
  layout: [
    {
      component: 'row',
      children: [{
        component: 'select',
        label: 'Translate to',
        bind: 'targetLanguage',
        options: [
          { label: 'English', value: 'English' },
          { label: '日本語', value: 'Japanese' },
        ],
        grow: true,
      }],
    },
    {
      component: 'row',
      responsive: 'stack',
      children: [
        { component: 'textarea', label: 'Input', bind: 'source', editable: true, grow: true, rows: 4 },
        { component: 'textarea', label: 'Result', bind: 'result', editable: false, copyable: true, grow: true, rows: 10, autoGrow: true },
      ],
    },
    {
      component: 'row',
      children: [{ component: 'button', label: 'Translate', trigger: 'translate', emphasis: 'primary', alignToField: true }],
    },
  ],
};

function AppsHarness({ client }: { client: ApiClient }) {
  const [selected, setSelected] = useState<string>();
  const catalog = useAppsCatalog(client, noop, selected);
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
          onSelect={setSelected}
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
  it('runs a SkillApp, preserves stale output, and keeps metrics in Activity', async () => {
    let state = { source: '', targetLanguage: 'English', result: '' };
    let staleOutputs: string[] | undefined;
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/v1/apps') return { ok: true, apps: [skillTranslator] };
      if (method === 'POST' && path === '/v1/apps/translator/instances') {
        return { ok: true, instance: { id: 'app_test', appName: 'translator', state } };
      }
      if (method === 'PATCH' && path === '/v1/app-instances/app_test/state') {
        state = { ...state, ...((body as { values: Partial<typeof state> }).values) };
        staleOutputs = state.result ? ['result'] : undefined;
        if (!state.source.trim()) {
          return {
            ok: true,
            status: 'idle',
            reason: 'missing_required_input',
            operation: 'translate',
            instance: { id: 'app_test', appName: 'translator', state, staleOutputs },
          };
        }
        return { ok: true, status: 'idle', instance: { id: 'app_test', appName: 'translator', state, staleOutputs } };
      }
      if (method === 'POST' && path === '/v1/app-instances/app_test/operations/translate') {
        if (state.source === 'Bad') {
          return {
            ok: true,
            status: 'completed',
            operation: 'translate',
            instance: { id: 'app_test', appName: 'translator', state, staleOutputs },
            result: {
              status: 'error',
              error: { code: 'PROVIDER_ERROR', message: 'Model unavailable.' },
            },
          };
        }
        state = { ...state, result: 'おはよう' };
        staleOutputs = undefined;
        return {
          ok: true,
          status: 'completed',
          operation: 'translate',
          instance: { id: 'app_test', appName: 'translator', state },
          result: {
            status: 'ok',
            data: { text: 'おはよう' },
            meta: { engine: 'ollama', model: 'maternion/hy-mt2:1.8b', durationMs: 830, usage: { totalTokens: 12 } },
          },
        };
      }
      if (method === 'DELETE' && path === '/v1/app-instances/app_test') return { ok: true, deleted: true };
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const client: ApiClient = {
      baseUrl: '',
      request: request as ApiClient['request'],
      stream: async () => new Response(),
      blob: async () => undefined,
    };

    render(<AppsHarness client={client} />);
    expect(await screen.findByRole('heading', { name: 'Marifold Translation' })).toBeTruthy();
    await waitFor(() => expect(request).toHaveBeenCalledWith('POST', '/v1/apps/translator/instances'));
    expect(screen.getByText('v1.0.0')).toBeTruthy();
    const translateButton = screen.getByRole('button', { name: 'Translate' });
    expect(translateButton.hasAttribute('disabled')).toBe(true);
    expect(translateButton.parentElement?.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect((screen.getByRole('option', { name: '日本語' }) as HTMLOptionElement).value).toBe('Japanese');
    const source = screen.getByLabelText('Input');
    const result = screen.getAllByRole('textbox')[1] as HTMLTextAreaElement;
    expect(source.getAttribute('rows')).toBe('4');
    expect(result.getAttribute('rows')).toBe('10');
    expect(result.hasAttribute('readonly')).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    Object.defineProperty(result, 'scrollHeight', { configurable: true, value: 500 });

    fireEvent.change(source, { target: { value: 'Good morning' } });
    await waitFor(() => expect(request).toHaveBeenCalledWith(
      'PATCH',
      '/v1/app-instances/app_test/state',
      { values: { source: 'Good morning' } },
    ));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Translate' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }));

    await waitFor(() => expect(result.value).toBe('おはよう'));
    expect(screen.queryByRole('status', { name: 'Based on previous inputs' })).toBeNull();
    expect(result.style.height).toBe('502px');
    expect(screen.queryByText('0.8s · 12 tokens')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Activity/ }));
    expect(screen.getByRole('region', { name: 'App activity' })).toBeTruthy();
    expect(screen.getByText('Translate completed')).toBeTruthy();
    expect(screen.getByText('0.8s · 12 tokens')).toBeTruthy();
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/v1/app-instances/app_test/operations/translate',
    );

    fireEvent.change(source, { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('status', { name: 'Based on previous inputs' })).toBeTruthy());
    expect(result.value).toBe('おはよう');
    expect(screen.getByRole('button', { name: 'Translate' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/missing required Skill values/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.change(source, { target: { value: 'Bad' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Translate' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Translate' }));
    expect(await screen.findByText('Model unavailable.')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Based on previous inputs' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'App activity' })).toBeTruthy();
  });

  it('adds, previews, and removes files through an attachment drop zone', async () => {
    const app: SkillAppDefinition = {
      ...skillTranslator,
      attachmentStates: [{ name: 'references' }],
      operations: skillTranslator.operations.map(operation => ({ ...operation, attachments: 'references' })),
      layout: [
        ...skillTranslator.layout.slice(0, 2),
        { component: 'row', children: [{ component: 'attachments', label: 'Attachments', bind: 'references' }] },
        ...skillTranslator.layout.slice(2),
      ],
    };
    let attachmentPayload: unknown;
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path === '/v1/apps/translator/instances') {
        return {
          ok: true,
          instance: {
            id: 'app_attachments',
            appName: 'translator',
            state: { source: 'Reference this', targetLanguage: 'English', result: 'Existing prompt' },
            attachments: { references: [] },
          },
        };
      }
      if (method === 'PUT' && path === '/v1/app-instances/app_attachments/attachments/references') {
        attachmentPayload = body;
        const inputs = (body as { attachments: Array<{ kind: string; name: string; mediaType: string; size: number }> }).attachments;
        return {
          ok: true,
          status: 'idle',
          instance: {
            id: 'app_attachments',
            appName: 'translator',
            state: { source: 'Reference this', targetLanguage: 'English', result: 'Existing prompt' },
            staleOutputs: ['result'],
            attachments: {
              references: inputs.map(({ kind, name, mediaType, size }) => ({ kind, name, mediaType, size })),
            },
          },
        };
      }
      if (method === 'DELETE' && path === '/v1/app-instances/app_attachments') {
        return { ok: true, deleted: true };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const client: ApiClient = {
      baseUrl: '',
      request: request as ApiClient['request'],
      stream: async () => new Response(),
      blob: async () => undefined,
    };
    render(<AppsScreen client={client} onUnauthorized={noop} app={app} />);
    const input = await screen.findByLabelText('Attachments') as HTMLInputElement;
    const image = new File(['image-bytes'], 'very-long-reference-image-name.png', { type: 'image/png' });
    const notes = new File(['notes'], 'notes.bin', { type: 'application/octet-stream' });
    fireEvent.drop(input.parentElement!, {
      dataTransfer: { types: ['Files'], files: [image, notes], dropEffect: 'none' },
    });

    expect(await screen.findByText('very-long-reference-image-name.png')).toBeTruthy();
    expect(screen.getByText('notes.bin')).toBeTruthy();
    expect(screen.getByDisplayValue('Existing prompt')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Based on previous inputs' })).toBeTruthy();
    expect(input.parentElement?.querySelector('img')).toBeTruthy();
    await waitFor(() => expect(request).toHaveBeenCalledWith(
      'PUT',
      '/v1/app-instances/app_attachments/attachments/references',
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ kind: 'image', name: 'very-long-reference-image-name.png' }),
          expect.objectContaining({ kind: 'file', name: 'notes.bin' }),
        ],
      }),
    ));
    expect(JSON.stringify(attachmentPayload)).toContain('aW1hZ2UtYnl0ZXM=');

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.bin' }));
    await waitFor(() => expect(screen.queryByText('notes.bin')).toBeNull());
    expect(screen.getByDisplayValue('Existing prompt')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Based on previous inputs' })).toBeTruthy();
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(
      'PUT',
      '/v1/app-instances/app_attachments/attachments/references',
      expect.objectContaining({
        attachments: [expect.objectContaining({ name: 'very-long-reference-image-name.png' })],
      }),
    ));
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
          profiles={[{ name: 'default', displayName: 'default', source: 'directory' }]}
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
          apps={[skillTranslator]}
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
