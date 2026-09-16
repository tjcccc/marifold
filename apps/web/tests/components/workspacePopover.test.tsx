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
