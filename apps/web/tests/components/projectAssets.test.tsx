// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import type { ListedProjectAsset } from '../../src/api/types';
import { ProjectAssets } from '../../src/screens/agent/ProjectAssets';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MB = 1024 * 1024;

function harness(assets: ListedProjectAsset[]) {
  const request = vi.fn(async (method: string, path: string, _body?: unknown) => {
    if (method === 'GET' && path === '/v1/projects/p1/assets') { return { assets, usage: { usedBytes: 34 * MB, limitBytes: 100 * MB } }; }
    if (method === 'GET' && path === '/v1/runs?sessionId=s1') {
      return {
        runs: [
          { id: 'run_2', profile: 'painter', artifacts: [{ id: 'a2', name: 'dashboard.html', mediaType: 'text/html', size: 42 * 1024 }] },
          { id: 'run_1', profile: 'dev_test', artifacts: [{ id: 'a1', name: 'sprites.xlsx', mediaType: 'application/octet-stream', size: 18 * 1024 }] },
        ],
      };
    }
    if (method === 'GET' && path === '/v1/execution-devices') {
      return {
        deviceId: 'dev_h',
        devices: [
          { id: 'dev_h', name: 'studio', host: true, online: true, executor: true, platform: 'darwin', architecture: 'arm64' },
          { id: 'dev_o', name: 'office', online: false, executor: true, platform: 'linux', architecture: 'arm64' },
        ],
      };
    }
    if (method === 'POST') { return { asset: {}, newVersion: true }; }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const client = { request, blob: vi.fn(), stream: vi.fn(), baseUrl: '' } as unknown as ApiClient;
  render(<ProjectAssets client={client} projectId="p1" sessionId="s1" responding={false} variant="column" onOpenSettings={() => {}} />);
  return request;
}

const sprites: ListedProjectAsset = {
  kind: 'stored', id: 'asset_1', name: 'sprites.xlsx', createdAt: '', updatedAt: '',
  version: 2, size: 18 * 1024, mediaType: 'application/octet-stream', sha256: '', savedBy: 'dev_test', runIds: ['run_1'],
};

describe('project assets panel', () => {
  it('marks outputs already in assets and adds the others from their run', async () => {
    const request = harness([sprites]);
    const outputs = await screen.findByRole('region', { name: 'Outputs' });
    await within(outputs).findByText('dashboard.html');
    expect(within(outputs).getByText('In assets ✓')).toBeTruthy();
    fireEvent.click(within(outputs).getByRole('button', { name: '+ Add to assets' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('POST', '/v1/projects/p1/assets/from-run', { runId: 'run_2', artifactId: 'a2' }));
    expect(screen.getByRole('region', { name: 'Assets' }).textContent).toContain('1 · 34 MB of 100 MB');
  });

  it('links a typed path on another device by its id', async () => {
    const request = harness([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an asset' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Link a file or folder/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Link a file or folder' });
    fireEvent.change(await within(sheet).findByRole('combobox'), { target: { value: 'dev_o' } });
    fireEvent.change(within(sheet).getByLabelText('Path on office'), { target: { value: '/Volumes/data' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('POST', '/v1/projects/p1/links', { target: '@dev_o/Volumes/data', name: 'data' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
