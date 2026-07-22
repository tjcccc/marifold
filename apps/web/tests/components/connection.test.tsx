// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionPopover } from '../../src/components/ConnectionPopover';

afterEach(cleanup);

describe('ConnectionPopover', () => {
  it('renders as a modal dialog and saves the normalized connection', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<ConnectionPopover settings={{}} onSave={onSave} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Connection' }).getAttribute('aria-modal')).toBe('true');
    fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'http://127.0.0.1:32140/' } });
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: ' local-secret ' } });
    fireEvent.submit(screen.getByRole('dialog', { name: 'Connection' }));

    expect(onSave).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:32140', token: 'local-secret' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes with Escape', () => {
    const onClose = vi.fn();
    render(<ConnectionPopover settings={{}} onSave={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
