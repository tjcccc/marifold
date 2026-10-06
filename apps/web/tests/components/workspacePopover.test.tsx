// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspacePopover } from '../../src/components/WorkspacePopover';
import { defaultConnectionStore } from '../../src/state/connection';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../src/api/client', () => ({ createApiClient: () => ({ request }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each([true, false])('labels devices and orders the host first (join dates: %s)', async (withDates) => {
  const devices = [
    { id: 'a', name: 'Alpha', host: false, joinedAt: withDates ? 200 : undefined },
    { id: 'z', name: 'Zulu', host: false, joinedAt: withDates ? 100 : undefined },
    { id: 'host', name: 'Home Mac', host: true },
    { id: 'c', name: 'Charlie', host: false },
    { id: 'b', name: 'bravo', host: false },
  ].map(d => ({ ...d, online: true, executor: true, platform: '', architecture: '' }));
  request.mockImplementation(async (_method, path) => path === '/v1/workspaces'
    ? { workspaces: [{ id: 'home', name: 'Home', role: 'host', online: true, deviceId: 'host' }], defaultId: 'local' }
    : { devices });
  render(<WorkspacePopover store={defaultConnectionStore()} onConnect={vi.fn()} onClose={vi.fn()}
    onRemove={vi.fn()} onExecutionDevice={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Home.*Hosted here.*Online/ }));
  const section = screen.getByRole('region', { name: 'Devices' });
  expect(within(section).getByRole('heading', { name: 'Devices' })).toBeTruthy();
  const rows = await within(section).findAllByRole('listitem');
  expect(rows.map(row => row.textContent?.split(' · ')[0]?.trim())).toEqual(
    withDates ? ['Home Mac (host)', 'Zulu', 'Alpha', 'bravo', 'Charlie']
      : ['Home Mac (host)', 'Alpha', 'bravo', 'Charlie', 'Zulu'],
  );
  expect(within(rows[0]!).queryByRole('button', { name: 'Revoke' })).toBeNull();
});

it('opens a fresh invitation form after revoking this device and rejoins the saved workspace', async () => {
  const workspace = { id: 'home', name: 'Home', role: 'guest', online: true, deviceId: 'fedora',
    bridgeUrl: 'https://bridge.example.com', executor: true };
  const devices = [{ id: 'host', name: 'Home Mac', host: true, online: true },
    { id: 'fedora', name: 'Fedora', host: false, online: true }];
  request.mockImplementation(async (_method, path) => {
    if (path === '/v1/workspaces') return { workspaces: [workspace], defaultId: 'home' };
    if (path.endsWith('/manage/devices')) return { devices };
    if (path.endsWith('/manage/revoke')) { workspace.online = false; return { revoked: true }; }
    if (path === '/v1/workspaces/join') { workspace.online = true; return { workspace }; }
    throw new Error(`Unexpected request: ${path}`);
  });
  const onRemove = vi.fn();
  render(<WorkspacePopover store={defaultConnectionStore()} onConnect={vi.fn()} onClose={vi.fn()}
    onRemove={onRemove} onExecutionDevice={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Home.*Paired.*Online/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
  const invitation = await screen.findByLabelText('Invitation');
  expect((screen.getByLabelText('Bridge URL') as HTMLInputElement).value).toBe(workspace.bridgeUrl);
  expect((invitation as HTMLInputElement).value).toBe('');
  expect(onRemove).toHaveBeenCalledWith('workspace-home');
  fireEvent.change(invitation, { target: { value: 'fresh-invitation' } });
  await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Join' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('POST', '/v1/workspaces/join', {
    bridgeUrl: workspace.bridgeUrl, invitation: 'fresh-invitation', executor: true,
  }));
  expect(await screen.findByRole('button', { name: /Home.*Paired.*Online/ })).toBeTruthy();
  expect(request.mock.calls.some(([method]) => method === 'DELETE')).toBe(false);
});

it('offers rejoining an unavailable guest workspace with its saved bridge URL', async () => {
  request.mockResolvedValue({ workspaces: [{ id: 'home', name: 'Home', role: 'guest', online: false,
    bridgeUrl: 'https://bridge.example.com' }], defaultId: 'home' });
  render(<WorkspacePopover store={defaultConnectionStore()} onConnect={vi.fn()} onClose={vi.fn()}
    onRemove={vi.fn()} onExecutionDevice={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Home.*Paired.*Offline/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Rejoin workspace' }));
  expect((screen.getByLabelText('Bridge URL') as HTMLInputElement).value).toBe('https://bridge.example.com');
  expect(screen.getByLabelText('Invitation')).toBeTruthy();
});
