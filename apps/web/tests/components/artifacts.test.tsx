// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { Markdown } from '../../src/components/Markdown';
import { RunArtifacts } from '../../src/screens/agent/RunArtifacts';
import { ArtifactsScreen } from '../../src/screens/artifacts/ArtifactsScreen';
import { bundleImageUrl } from '../../src/screens/artifacts/ArtifactViewer';

// The Artifacts view (docs/artifacts.md#web-ui) and the viewer's sandboxing.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TICKET = `/v1/artifact-views/${'a'.repeat(48)}/`;
const summary = { id: 'k3m7q2x9ab', title: 'AI News', kind: 'html', currentVersion: 1, seen: false, createdAt: '2026-10-28T08:00:00Z', updatedAt: '2026-10-28T08:00:00Z' };
const detail = { ...summary, entry: 'index.html', files: [], versions: [{ version: 1, entry: 'index.html', fileCount: 1, size: 10, createdAt: '2026-10-28T08:00:00Z' }] };

function setup() {
  const request = vi.fn(async (method: string, path: string) => {
    if (method === 'GET' && path.startsWith('/v1/artifacts?')) { return { artifacts: [summary] }; }
    if (method === 'GET') { return { artifact: detail }; }
    if (path.endsWith('/view')) { return { path: TICKET, entryPath: `${TICKET}index.html`, entry: 'index.html', kind: 'html', version: 1 }; }
    return { ok: true };
  });
  const client = { request, blob: vi.fn(), stream: vi.fn(), baseUrl: '', serverUrl: 'http://127.0.0.1:32140' } as unknown as ApiClient;
  const library = { folders: [], refresh: vi.fn(async () => {}) };
  const onOpen = vi.fn();
  const view = render(<ArtifactsScreen client={client} library={library} folder="all" mobile={false} onOpen={onOpen} onOpenSession={() => {}} />);
  return { request, client, library, onOpen, view };
}

describe('Artifacts view', () => {
  it('lists the library and opens an artifact in a sandboxed frame without same-origin', async () => {
    const { request, client, library, onOpen, view } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /AI News/ }));
    expect(onOpen).toHaveBeenCalledWith('k3m7q2x9ab');

    view.rerender(<ArtifactsScreen client={client} library={library} folder="all" artifactId="k3m7q2x9ab" mobile={false} onOpen={onOpen} onOpenSession={() => {}} />);
    const frame = await waitFor(() => {
      const found = view.container.querySelector('iframe');
      if (!found) { throw new Error('no frame yet'); }
      return found;
    });
    expect(frame.getAttribute('src')).toBe(`http://127.0.0.1:32140${TICKET}index.html`);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('DELETE', '/v1/artifacts/k3m7q2x9ab'));
  });

  it('resolves Markdown images inside the bundle only; chat replies never load them', () => {
    const client = { serverUrl: 'http://host' } as unknown as ApiClient;
    const view = { path: TICKET, entry: 'docs/report.md' };
    expect(bundleImageUrl(client, view, 'img/chart.png')).toBe(`http://host${TICKET}docs/img/chart.png`);
    expect(bundleImageUrl(client, view, '../../../../v1/sessions')).toBe(`http://host${TICKET}v1/sessions`);
    for (const outside of ['https://example.com/x.png', '//example.com/x.png', '/v1/sessions', 'data:image/png;base64,AA']) {
      expect(bundleImageUrl(client, view, outside), outside).toBeUndefined();
    }

    const { container, rerender } = render(<Markdown source="See ![chart](img/chart.png)" resolveImage={src => `http://host/${src}`} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://host/img/chart.png');
    rerender(<Markdown source="See ![chart](img/chart.png)" />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('offers Save as artifact only for an output that is not an artifact yet', () => {
    const client = { request: vi.fn(async () => ({ artifacts: [page] })), blob: vi.fn(), stream: vi.fn(), baseUrl: '' } as unknown as ApiClient;
    const page = { id: 'b'.repeat(24), name: 'index.html', mediaType: 'text/html', size: 10 };
    const props = { client, runId: 'run_1', artifacts: [page], onOpenArtifact: () => {}, onSavedArtifact: () => {} };
    const { rerender } = render(<RunArtifacts {...props} saved={[]} />);
    expect(screen.getByRole('button', { name: 'Save as artifact' })).toBeTruthy();
    rerender(<RunArtifacts {...props} saved={[{ id: 'k3m7q2x9ab', title: 'index', kind: 'html', version: 1, sourceOutput: page.id }]} />);
    expect(screen.queryByRole('button', { name: 'Save as artifact' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Saved as artifact' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
