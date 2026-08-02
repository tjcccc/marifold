// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionPopover } from '../../src/components/ConnectionPopover';
import { defaultConnectionStore } from '../../src/state/connection';

afterEach(cleanup);

describe('ConnectionPopover', () => {
  it('adds, validates, and connects to a named server', async () => {
    const onConnect = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <ConnectionPopover
        store={defaultConnectionStore()}
        onConnect={onConnect}
        onRemove={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Connection' }).getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('This server')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(screen.queryByRole('button', { name: 'Remove server' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: ' Mac mini ' } });
    fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'http://100.101.102.103:32140/' } });
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: ' remote-secret ' } });
    fireEvent.submit(screen.getByRole('dialog', { name: 'Connection' }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Mac mini',
      baseUrl: 'http://100.101.102.103:32140',
      token: 'remote-secret',
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the dialog open when validation or connection fails', async () => {
    const onConnect = vi.fn(async () => 'The service rejected this bearer token.');
    const onClose = vi.fn();
    render(
      <ConnectionPopover
        store={defaultConnectionStore()}
        onConnect={onConnect}
        onRemove={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Remote' } });
    fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'file:///tmp/service' } });
    fireEvent.submit(screen.getByRole('dialog', { name: 'Connection' }));
    expect(screen.getByText('Service URL must use HTTP or HTTPS.')).toBeTruthy();
    expect(onConnect).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'https://remote.example.test' } });
    fireEvent.submit(screen.getByRole('dialog', { name: 'Connection' }));
    expect(await screen.findByText('The service rejected this bearer token.')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes a saved server and closes with Escape', () => {
    const onRemove = vi.fn();
    const onClose = vi.fn();
    render(
      <ConnectionPopover
        store={{
          activeId: 'remote',
          servers: [
            { id: 'this-server', name: 'This server' },
            { id: 'remote', name: 'Mac mini', baseUrl: 'http://100.101.102.103:32140' },
          ],
        }}
        onConnect={async () => undefined}
        onRemove={onRemove}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove server' }));
    expect(onRemove).toHaveBeenCalledWith('remote');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
